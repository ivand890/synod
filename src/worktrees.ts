import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { explainCheckpointDelta, stableCheckpointStringify } from "./checkpoint.js";
import { applyTransaction, inspectPath, pathType, resolveProjectPath, unsafeAncestor } from "./filesystem.js";
import { leaseScopeCoversPath, type LeaseBaselinesLedger, type TaskLease } from "./leases.js";
import { captureGitCheckpointSnapshot, withOrchestrationSnapshot } from "./orchestration.js";
import type { OrchestrationState } from "./orchestration.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { errorMessage, isRecord, parseJson } from "./validation.js";
import { exportSnapshotRecoveryBundle, verifyRecoveryBundle } from "./recovery.js";
import type { RecoveryProposalIdentity } from "./recovery.js";
import { restoreRecoveryBundleOverlayUnderLock } from "./restore.js";
import type { RestoreDependencies } from "./restore.js";

export const TASK_WORKTREES_PATH = ".synod/task-worktrees.json";
export const TASK_WORKTREES_SCHEMA_VERSION = 1;
const MAX_WORKTREE_RECORDS = 128;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface FilesystemIdentity {
  device: string;
  inode: string;
}

export interface TaskWorktreeRecord {
  id: string;
  taskId: string;
  leaseId: string;
  generation: number;
  taskRevision: number;
  ownerThread: string;
  controlRoot: string;
  controlIdentity: FilesystemIdentity;
  gitCommonDirectory: string;
  gitCommonIdentity: FilesystemIdentity;
  worktreePath: string;
  worktreeIdentity?: FilesystemIdentity;
  gitDirectory?: string;
  gitDirectoryIdentity?: FilesystemIdentity;
  registrationsAtIntent: string[];
  sourceBranch: string | null;
  baseHead: string;
  createdAt: string;
  creation: {
    status: "INTENT" | "COMPLETE";
    intentAt: string;
    completedAt?: string;
  };
  lastCapturedFingerprint?: string;
  proposal?: {
    status: "INTENT" | "SEALED";
    path: string;
    intentAt: string;
    bundleId?: string;
    fingerprint?: string;
    sealedAt?: string;
  };
  integration: {
    status: "PENDING" | "INTENT" | "COMPLETE";
    intentAt?: string;
    completedAt?: string;
    fingerprint?: string;
    overallFingerprint?: string;
  };
  cleanup: {
    status: "ACTIVE" | "INTENT" | "COMPLETE";
    intentAt?: string;
    completedAt?: string;
    registrationsAtIntent?: string[];
  };
  updatedAt: string;
}

export interface TaskWorktreeEvent {
  sequence: number;
  id: string;
  timestamp: string;
  type:
    | "worktree.create.intent"
    | "worktree.create.completed"
    | "worktree.proposal.intent"
    | "worktree.proposal.sealed"
    | "worktree.integration.intent"
    | "worktree.integration.completed"
    | "worktree.cleanup.intent"
    | "worktree.cleanup.completed";
  taskId: string;
  worktreeId: string;
  payload: Record<string, unknown>;
  previousHash: string | null;
  eventHash: string;
}

export interface TaskWorktreeRegistry {
  schemaVersion: typeof TASK_WORKTREES_SCHEMA_VERSION;
  records: TaskWorktreeRecord[];
  events: TaskWorktreeEvent[];
}

export type WorktreeReconciliation = "complete" | "absent_resumable" | "manual_reconciliation";

export interface TaskWorktreeStatus {
  record: TaskWorktreeRecord;
  reconciliation: WorktreeReconciliation;
  reasons: string[];
}

export interface CreateTaskWorktreeOptions {
  directory?: string;
  taskId?: string;
  destination?: string;
  leaseId?: string;
  generation?: number;
  revision?: number;
  expectedHeartbeatAt?: string;
  ownerThread?: string;
}

export interface FencedTaskWorktreeOptions extends Omit<CreateTaskWorktreeOptions, "destination"> {}

export interface CleanupTaskWorktreeOptions {
  directory?: string;
  taskId?: string;
}

export interface TaskWorktreeDependencies {
  gitRunner?: (directory: string, args: string[]) => Promise<Buffer>;
  clock?: () => Date;
  restoreHook?: RestoreDependencies["restoreHook"];
  worktreeHook?: (stage:
    | "after-intent"
    | "after-add"
    | "before-complete"
    | "after-proposal-intent"
    | "before-proposal-rename"
    | "after-proposal-publish"
    | "after-integration-intent"
    | "after-integration-restore"
    | "before-integration-complete"
    | "after-cleanup-intent"
    | "after-cleanup-remove"
  ) => void | Promise<void>;
}

interface GitWorktreeEntry {
  path: string;
  head: string;
  detached: boolean;
  branch?: string;
  prunable?: string;
}

function invalid(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.WORKTREE_INVALID, message, { details });
}

function conflict(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.WORKTREE_CONFLICT, message, { details });
}

function reconciliationRequired(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.WORKTREE_RECONCILIATION_REQUIRED, message, { details });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isIdentity(value: unknown): value is FilesystemIdentity {
  return isRecord(value)
    && typeof value.device === "string"
    && /^\d+$/.test(value.device)
    && typeof value.inode === "string"
    && /^\d+$/.test(value.inode);
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function eventCore(event: Omit<TaskWorktreeEvent, "eventHash">): string {
  return stableCheckpointStringify(event);
}

function hashEvent(event: Omit<TaskWorktreeEvent, "eventHash">): string {
  return `sha256:${createHash("sha256").update(eventCore(event), "utf8").digest("hex")}`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validateRecord(value: unknown): TaskWorktreeRecord {
  if (!isRecord(value)
    || !isUuid(value.id)
    || typeof value.taskId !== "string" || !value.taskId
    || !isUuid(value.leaseId)
    || !Number.isSafeInteger(value.generation) || Number(value.generation) <= 0
    || !Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 0
    || typeof value.ownerThread !== "string" || !value.ownerThread
    || typeof value.controlRoot !== "string" || !path.isAbsolute(value.controlRoot)
    || !isIdentity(value.controlIdentity)
    || typeof value.gitCommonDirectory !== "string" || !path.isAbsolute(value.gitCommonDirectory)
    || !isIdentity(value.gitCommonIdentity)
    || typeof value.worktreePath !== "string" || !path.isAbsolute(value.worktreePath)
    || (value.worktreeIdentity !== undefined && !isIdentity(value.worktreeIdentity))
    || (value.gitDirectory !== undefined && (typeof value.gitDirectory !== "string" || !path.isAbsolute(value.gitDirectory)))
    || (value.gitDirectoryIdentity !== undefined && !isIdentity(value.gitDirectoryIdentity))
    || !Array.isArray(value.registrationsAtIntent)
    || value.registrationsAtIntent.some(item => typeof item !== "string" || !path.isAbsolute(item))
    || new Set(value.registrationsAtIntent).size !== value.registrationsAtIntent.length
    || (value.sourceBranch !== null && typeof value.sourceBranch !== "string")
    || typeof value.baseHead !== "string" || !/^[0-9a-f]{40,64}$/.test(value.baseHead)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || !isRecord(value.creation)
    || !["INTENT", "COMPLETE"].includes(String(value.creation.status))
    || !validTimestamp(value.creation.intentAt)
    || (value.creation.completedAt !== undefined && !validTimestamp(value.creation.completedAt))
    || (value.lastCapturedFingerprint !== undefined && !isHash(value.lastCapturedFingerprint))
    || !isRecord(value.integration)
    || !["PENDING", "INTENT", "COMPLETE"].includes(String(value.integration.status))
    || (value.integration.intentAt !== undefined && !validTimestamp(value.integration.intentAt))
    || (value.integration.completedAt !== undefined && !validTimestamp(value.integration.completedAt))
    || (value.integration.fingerprint !== undefined && !isHash(value.integration.fingerprint))
    || (value.integration.overallFingerprint !== undefined && !isHash(value.integration.overallFingerprint))
    || !isRecord(value.cleanup)
    || !["ACTIVE", "INTENT", "COMPLETE"].includes(String(value.cleanup.status))
    || (value.cleanup.intentAt !== undefined && !validTimestamp(value.cleanup.intentAt))
    || (value.cleanup.completedAt !== undefined && !validTimestamp(value.cleanup.completedAt))
    || (value.cleanup.registrationsAtIntent !== undefined
      && (!Array.isArray(value.cleanup.registrationsAtIntent)
        || value.cleanup.registrationsAtIntent.some(item => typeof item !== "string" || !path.isAbsolute(item))
        || new Set(value.cleanup.registrationsAtIntent).size !== value.cleanup.registrationsAtIntent.length))) {
    invalid("Task worktree registry contains an invalid record.");
  }
  if (value.creation.status === "COMPLETE"
    && (!value.worktreeIdentity || !value.gitDirectory || !value.gitDirectoryIdentity
      || !value.creation.completedAt || !value.lastCapturedFingerprint)) {
    invalid("A completed task worktree record is missing its verified identity.");
  }
  if (value.proposal !== undefined && (!isRecord(value.proposal)
    || !["INTENT", "SEALED"].includes(String(value.proposal.status))
    || value.proposal.path !== `.synod/worktree-proposals/${value.id}`
    || !validTimestamp(value.proposal.intentAt)
    || (value.proposal.bundleId !== undefined && !isHash(value.proposal.bundleId))
    || (value.proposal.fingerprint !== undefined && !isHash(value.proposal.fingerprint))
    || (value.proposal.sealedAt !== undefined && !validTimestamp(value.proposal.sealedAt)))) {
    invalid("Task worktree registry contains an invalid proposal reference.");
  }
  if (value.proposal?.status === "SEALED"
    && (!value.proposal.bundleId || !value.proposal.fingerprint || !value.proposal.sealedAt)) {
    invalid("A sealed task worktree proposal is missing its verified identity.");
  }
  if (value.integration.status === "INTENT" && !value.integration.intentAt) {
    invalid("A task worktree integration intent is missing its timestamp.");
  }
  if (value.integration.status === "COMPLETE"
    && (!value.integration.intentAt || !value.integration.completedAt
      || !value.integration.fingerprint || !value.integration.overallFingerprint)) {
    invalid("A completed task worktree integration is missing its verified identity.");
  }
  if (value.cleanup.status === "INTENT"
    && (!value.cleanup.intentAt || !value.cleanup.registrationsAtIntent)) {
    invalid("A task worktree cleanup intent is incomplete.");
  }
  if (value.cleanup.status === "COMPLETE"
    && (!value.cleanup.intentAt || !value.cleanup.completedAt || !value.cleanup.registrationsAtIntent)) {
    invalid("A completed task worktree cleanup is incomplete.");
  }
  return value as unknown as TaskWorktreeRecord;
}

const WORKTREE_EVENT_TYPES: TaskWorktreeEvent["type"][] = [
  "worktree.create.intent",
  "worktree.create.completed",
  "worktree.proposal.intent",
  "worktree.proposal.sealed",
  "worktree.integration.intent",
  "worktree.integration.completed",
  "worktree.cleanup.intent",
  "worktree.cleanup.completed"
];

function validEventTransition(
  type: TaskWorktreeEvent["type"],
  prior: TaskWorktreeRecord | undefined,
  current: TaskWorktreeRecord
): boolean {
  if (type === "worktree.create.intent") return !prior && current.creation.status === "INTENT";
  if (!prior || prior.id !== current.id) return false;
  if (type === "worktree.create.completed") {
    return prior.creation.status === "INTENT" && current.creation.status === "COMPLETE";
  }
  if (type === "worktree.proposal.intent") {
    return prior.creation.status === "COMPLETE" && !prior.proposal && current.proposal?.status === "INTENT";
  }
  if (type === "worktree.proposal.sealed") {
    return prior.proposal?.status === "INTENT" && current.proposal?.status === "SEALED";
  }
  if (type === "worktree.integration.intent") {
    return prior.proposal?.status === "SEALED"
      && prior.integration.status === "PENDING"
      && current.integration.status === "INTENT";
  }
  if (type === "worktree.integration.completed") {
    return prior.integration.status === "INTENT" && current.integration.status === "COMPLETE";
  }
  if (type === "worktree.cleanup.intent") {
    return prior.creation.status === "COMPLETE"
      && prior.cleanup.status === "ACTIVE"
      && current.cleanup.status === "INTENT";
  }
  return prior.cleanup.status === "INTENT" && current.cleanup.status === "COMPLETE";
}

export function validateTaskWorktreeRegistry(value: unknown): TaskWorktreeRegistry {
  if (!isRecord(value)
    || value.schemaVersion !== TASK_WORKTREES_SCHEMA_VERSION
    || !Array.isArray(value.records)
    || value.records.length > MAX_WORKTREE_RECORDS
    || !Array.isArray(value.events)
    || value.events.length > MAX_WORKTREE_RECORDS * 8) {
    invalid("Task worktree registry is invalid or unsupported.");
  }
  const records = value.records.map(validateRecord);
  if (new Set(records.map(item => item.id)).size !== records.length) invalid("Task worktree record IDs must be unique.");
  if (new Set(records.filter(item => item.cleanup.status !== "COMPLETE").map(item => item.worktreePath)).size
    !== records.filter(item => item.cleanup.status !== "COMPLETE").length) {
    invalid("Active task worktree paths must be unique.");
  }
  const events: TaskWorktreeEvent[] = [];
  const eventRecords = new Map<string, TaskWorktreeRecord>();
  let prior: string | null = null;
  for (const [index, raw] of value.events.entries()) {
    if (!isRecord(raw)
      || raw.sequence !== index + 1
      || !isUuid(raw.id)
      || !validTimestamp(raw.timestamp)
      || !WORKTREE_EVENT_TYPES.includes(raw.type as TaskWorktreeEvent["type"])
      || typeof raw.taskId !== "string" || !raw.taskId
      || !isUuid(raw.worktreeId)
      || !isRecord(raw.payload)
      || raw.previousHash !== prior
      || !isHash(raw.eventHash)) invalid("Task worktree event chain is invalid.");
    const event = raw as unknown as TaskWorktreeEvent;
    const { eventHash: _eventHash, ...core } = event;
    if (hashEvent(core) !== event.eventHash) invalid("Task worktree event hash is invalid.");
    const eventRecord = validateRecord(event.payload.record);
    if (eventRecord.id !== event.worktreeId || eventRecord.taskId !== event.taskId) {
      invalid("Task worktree event record identity is inconsistent.");
    }
    const priorRecord = eventRecords.get(event.worktreeId);
    if (!validEventTransition(event.type, priorRecord, eventRecord)) invalid("Task worktree event transition is inconsistent.");
    eventRecords.set(event.worktreeId, eventRecord);
    prior = event.eventHash;
    events.push(event);
  }
  if (eventRecords.size !== records.length) invalid("Task worktree records and events do not match.");
  for (const record of records) {
    const eventRecord = eventRecords.get(record.id);
    if (!eventRecord || stableCheckpointStringify(eventRecord) !== stableCheckpointStringify(record)) {
      invalid("Task worktree record does not match its latest event snapshot.");
    }
  }
  return { schemaVersion: TASK_WORKTREES_SCHEMA_VERSION, records, events };
}

function emptyRegistry(): TaskWorktreeRegistry {
  return { schemaVersion: TASK_WORKTREES_SCHEMA_VERSION, records: [], events: [] };
}

export function createTaskWorktreeRegistry(): TaskWorktreeRegistry {
  return emptyRegistry();
}

export function serializeTaskWorktreeRegistry(value: TaskWorktreeRegistry): string {
  return `${JSON.stringify(validateTaskWorktreeRegistry(value), null, 2)}\n`;
}

async function defaultGitRunner(directory: string, args: string[]): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", directory, ...args], {
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new SynodError(ERROR_CODES.WORKTREE_GIT_FAILED, `Git ${args[0] || "command"} failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`, {
          cause: error,
          details: { directory, args }
        }));
      } else resolve(Buffer.from(stdout));
    });
  });
}

async function optionalGit(gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>, directory: string, args: string[]) {
  try {
    return (await gitRunner(directory, args)).toString("utf8").trim();
  } catch {
    return null;
  }
}

function parseWorktreeList(output: Buffer): GitWorktreeEntry[] {
  const records = output.toString("utf8").split("\0\0").filter(Boolean);
  return records.map(record => {
    const fields = record.split("\0");
    const values = new Map<string, string>();
    for (const field of fields) {
      const space = field.indexOf(" ");
      values.set(space === -1 ? field : field.slice(0, space), space === -1 ? "" : field.slice(space + 1));
    }
    const worktreePath = values.get("worktree");
    const head = values.get("HEAD");
    if (!worktreePath || !head) invalid("Git returned an invalid porcelain worktree record.");
    return {
      path: path.resolve(worktreePath),
      head,
      detached: values.has("detached"),
      ...(values.has("branch") ? { branch: values.get("branch")! } : {}),
      ...(values.has("prunable") ? { prunable: values.get("prunable")! } : {})
    };
  });
}

async function identity(candidate: string): Promise<FilesystemIdentity> {
  const stats = await lstat(candidate, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) conflict("Worktree identity target must be a real directory.", { path: candidate });
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function inspectControl(directory: string, gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>) {
  const controlRoot = await realpath(path.resolve(directory));
  const topLevel = await realpath((await gitRunner(controlRoot, ["rev-parse", "--show-toplevel"])).toString("utf8").trim());
  if (topLevel !== controlRoot) conflict("Worktree commands must target the canonical control checkout root.", {
    expected: topLevel,
    actual: controlRoot
  });
  const commonRaw = (await gitRunner(controlRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString("utf8").trim();
  const gitCommonDirectory = await realpath(path.resolve(controlRoot, commonRaw));
  const head = (await gitRunner(controlRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const sourceBranch = await optionalGit(gitRunner, controlRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    controlRoot,
    controlIdentity: await identity(controlRoot),
    gitCommonDirectory,
    gitCommonIdentity: await identity(gitCommonDirectory),
    head,
    sourceBranch
  };
}

async function assertControlUnchanged(
  expected: Awaited<ReturnType<typeof inspectControl>>,
  gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>
) {
  const current = await inspectControl(expected.controlRoot, gitRunner);
  if (current.controlRoot !== expected.controlRoot
    || current.gitCommonDirectory !== expected.gitCommonDirectory
    || !sameIdentity(current.controlIdentity, expected.controlIdentity)
    || !sameIdentity(current.gitCommonIdentity, expected.gitCommonIdentity)
    || current.head !== expected.head
    || current.sourceBranch !== expected.sourceBranch) {
    conflict("Control checkout identity, HEAD, or branch changed during worktree creation.", {
      expected: {
        controlRoot: expected.controlRoot,
        gitCommonDirectory: expected.gitCommonDirectory,
        head: expected.head,
        sourceBranch: expected.sourceBranch
      },
      actual: {
        controlRoot: current.controlRoot,
        gitCommonDirectory: current.gitCommonDirectory,
        head: current.head,
        sourceBranch: current.sourceBranch
      }
    });
  }
}

async function readRegistry(controlRoot: string): Promise<{
  registry: TaskWorktreeRegistry;
  expected: { type: "missing" } | { type: "file"; hash: string };
}> {
  const registryPath = resolveProjectPath(controlRoot, TASK_WORKTREES_PATH);
  const inspected = await inspectPath(registryPath);
  if (inspected.type === "missing") return { registry: emptyRegistry(), expected: { type: "missing" } };
  if (inspected.type !== "file") conflict("Task worktree registry is not a regular file.", { path: TASK_WORKTREES_PATH });
  let parsed: unknown;
  try {
    parsed = parseJson(inspected.content);
  } catch (error) {
    invalid(`Task worktree registry is not valid JSON: ${errorMessage(error)}`);
  }
  return { registry: validateTaskWorktreeRegistry(parsed), expected: { type: "file", hash: inspected.hash } };
}

export async function validateTaskWorktreeArtifacts({
  directory = ".",
  required = true
}: { directory?: string; required?: boolean } = {}): Promise<{
  path: typeof TASK_WORKTREES_PATH;
  schemaVersion: typeof TASK_WORKTREES_SCHEMA_VERSION;
  records: number;
  events: number;
  sealedProposals: number;
}> {
  const controlRoot = await realpath(path.resolve(directory));
  const loaded = await readRegistry(controlRoot);
  if (loaded.expected.type === "missing" && required) {
    invalid(`Task worktree registry is missing: ${TASK_WORKTREES_PATH}`);
  }
  let sealedProposals = 0;
  for (const record of loaded.registry.records) {
    if (record.integration.status === "COMPLETE"
      && record.integration.fingerprint !== record.proposal?.fingerprint) {
      invalid("Completed task worktree integration does not match its sealed proposal.", { recordId: record.id });
    }
    if (record.proposal?.status !== "SEALED") continue;
    const verified = await verifyRecoveryBundle({
      bundle: resolveProjectPath(controlRoot, record.proposal.path)
    });
    const proposal = verified.manifest.proposal;
    if (verified.bundleId !== record.proposal.bundleId
      || verified.manifest.source.head !== record.baseHead
      || verified.manifest.source.branch !== null
      || verified.manifest.checkpoint.fingerprint !== record.proposal.fingerprint
      || !proposal
      || proposal.taskId !== record.taskId
      || proposal.leaseId !== record.leaseId
      || proposal.generation !== record.generation
      || proposal.baseRevision !== record.taskRevision
      || proposal.revision !== record.taskRevision + 1) {
      invalid("Task worktree proposal artifact does not match its registry record.", { recordId: record.id });
    }
    sealedProposals += 1;
  }
  return {
    path: TASK_WORKTREES_PATH,
    schemaVersion: TASK_WORKTREES_SCHEMA_VERSION,
    records: loaded.registry.records.length,
    events: loaded.registry.events.length,
    sealedProposals
  };
}

async function writeRegistry(
  controlRoot: string,
  registry: TaskWorktreeRegistry,
  expected: { type: "missing" } | { type: "file"; hash: string }
) {
  validateTaskWorktreeRegistry(registry);
  await applyTransaction(controlRoot, [{
    action: "write",
    path: TASK_WORKTREES_PATH,
    content: `${JSON.stringify(registry, null, 2)}\n`,
    expected
  }]);
}

function appendEvent(
  registry: TaskWorktreeRegistry,
  record: TaskWorktreeRecord,
  type: TaskWorktreeEvent["type"],
  timestamp: string,
  payload: Record<string, unknown>
) {
  const prior = registry.events.at(-1)?.eventHash || null;
  const core: Omit<TaskWorktreeEvent, "eventHash"> = {
    sequence: registry.events.length + 1,
    id: randomUUID(),
    timestamp,
    type,
    taskId: record.taskId,
    worktreeId: record.id,
    payload: { ...payload, record: structuredClone(record) },
    previousHash: prior
  };
  registry.events.push({ ...core, eventHash: hashEvent(core) });
}

function rechainEvents(events: TaskWorktreeEvent[]): TaskWorktreeEvent[] {
  let previousHash: string | null = null;
  return events.map((event, index) => {
    const { eventHash: _eventHash, ...priorCore } = event;
    const core: Omit<TaskWorktreeEvent, "eventHash"> = {
      ...priorCore,
      sequence: index + 1,
      previousHash
    };
    const rechained = { ...core, eventHash: hashEvent(core) };
    previousHash = rechained.eventHash;
    return rechained;
  });
}

function makeRoomForWorktreeRecord(registry: TaskWorktreeRegistry) {
  while (registry.records.length >= MAX_WORKTREE_RECORDS) {
    const completed = registry.records.findIndex(record => record.cleanup.status === "COMPLETE");
    if (completed === -1) {
      conflict("Task worktree registry is full of active records; clean a worktree before creating another.", {
        limit: MAX_WORKTREE_RECORDS
      });
    }
    const [removed] = registry.records.splice(completed, 1);
    registry.events = rechainEvents(registry.events.filter(event => event.worktreeId !== removed!.id));
  }
}

function assertLease(
  taskId: string,
  lease: TaskLease | undefined,
  options: FencedTaskWorktreeOptions,
  now: Date
): TaskLease {
  if (!lease) conflict(`Task ${taskId} has no active writer lease.`, { taskId });
  if (lease.id !== options.leaseId
    || lease.generation !== options.generation
    || lease.taskRevision !== options.revision
    || lease.heartbeatAt !== options.expectedHeartbeatAt
    || lease.ownerThread !== String(options.ownerThread || "").trim()) {
    conflict(`Task ${taskId} worktree lease fence is stale.`, {
      expected: {
        leaseId: lease.id,
        generation: lease.generation,
        revision: lease.taskRevision,
        expectedHeartbeatAt: lease.heartbeatAt,
        ownerThread: lease.ownerThread
      }
    });
  }
  if (Date.parse(lease.expiresAt) <= now.getTime()) conflict(`Task ${taskId} writer lease has expired.`, { expiresAt: lease.expiresAt });
  if (!lease.baseline.head) conflict(`Task ${taskId} writer lease has no exact Git base.`);
  return lease;
}

async function canonicalDestination(control: Awaited<ReturnType<typeof inspectControl>>, destination: string) {
  const requested = path.resolve(control.controlRoot, destination);
  const parent = await realpath(path.dirname(requested));
  const canonical = path.join(parent, path.basename(requested));
  if (within(control.controlRoot, canonical) || within(control.gitCommonDirectory, canonical)) {
    conflict("Task worktree destination must be outside the control checkout and Git common directory.", {
      destination: canonical
    });
  }
  return canonical;
}

async function inspectRegisteredWorktree(
  control: Awaited<ReturnType<typeof inspectControl>>,
  record: TaskWorktreeRecord,
  gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>,
  { requireControlBase = true }: { requireControlBase?: boolean } = {}
): Promise<TaskWorktreeStatus> {
  const reasons: string[] = [];
  if (requireControlBase && control.head !== record.baseHead) reasons.push("control HEAD moved from the recorded base");
  if (requireControlBase && control.sourceBranch !== record.sourceBranch) reasons.push("control branch changed from the recorded source");
  const entries = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
  const listed = entries.find(item => item.path === record.worktreePath);
  const destinationType = await pathType(record.worktreePath);
  if (!listed && destinationType === "missing") {
    const currentRegistrations = entries.map(item => item.path).sort();
    const intentRegistrations = [...(record.cleanup.status === "INTENT" && record.cleanup.registrationsAtIntent
      ? record.cleanup.registrationsAtIntent
      : record.registrationsAtIntent)].sort();
    if (currentRegistrations.length === intentRegistrations.length
      && currentRegistrations.every((item, index) => item === intentRegistrations[index])) {
      return { record, reconciliation: "absent_resumable", reasons: ["path and Git registration are absent"] };
    }
    reasons.push("Git worktree registrations changed after the creation intent");
  }
  if (!listed) reasons.push("destination is not registered by Git");
  if (destinationType !== "directory") reasons.push(`destination path is ${destinationType}`);
  if (listed) {
    if (listed.head !== record.baseHead) reasons.push("registered HEAD differs from the recorded base");
    if (!listed.detached || listed.branch) reasons.push("registered worktree is not detached");
    if (listed.prunable) reasons.push("registered worktree is prunable");
  }
  if (listed && destinationType === "directory") {
    try {
      const [root, common, gitDirectory, head, branch, currentIdentity] = await Promise.all([
        realpath((await gitRunner(record.worktreePath, ["rev-parse", "--show-toplevel"])).toString("utf8").trim()),
        realpath((await gitRunner(record.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString("utf8").trim()),
        realpath((await gitRunner(record.worktreePath, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).toString("utf8").trim()),
        gitRunner(record.worktreePath, ["rev-parse", "HEAD"]).then(value => value.toString("utf8").trim()),
        optionalGit(gitRunner, record.worktreePath, ["symbolic-ref", "--short", "-q", "HEAD"]),
        identity(record.worktreePath)
      ]);
      if (root !== record.worktreePath) reasons.push("worktree root identity changed");
      if (common !== record.gitCommonDirectory) reasons.push("Git common directory changed");
      if (record.gitDirectory && gitDirectory !== record.gitDirectory) reasons.push("Git administrative directory changed");
      if (record.gitDirectoryIdentity
        && !sameIdentity(record.gitDirectoryIdentity, await identity(gitDirectory))) reasons.push("Git administrative identity changed");
      if (head !== record.baseHead) reasons.push("live HEAD moved from the recorded base");
      if (branch !== null) reasons.push("live worktree is attached to a branch");
      if (record.worktreeIdentity && !sameIdentity(record.worktreeIdentity, currentIdentity)) reasons.push("filesystem identity changed");
      if (record.creation.status === "INTENT"
        && (await gitRunner(record.worktreePath, [
          "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"
        ])).length > 0) {
        reasons.push("interrupted creation worktree is not clean");
      }
    } catch (error) {
      reasons.push(`worktree inspection failed: ${errorMessage(error)}`);
    }
  }
  return {
    record,
    reconciliation: reasons.length === 0 ? "complete" : "manual_reconciliation",
    reasons
  };
}

async function completeRecord(
  control: Awaited<ReturnType<typeof inspectControl>>,
  recordId: string,
  lease: TaskLease,
  now: () => Date,
  gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>,
  hook?: TaskWorktreeDependencies["worktreeHook"]
): Promise<TaskWorktreeRecord> {
  const loaded = await readRegistry(control.controlRoot);
  const record = loaded.registry.records.find(item => item.id === recordId);
  if (!record) invalid("Task worktree intent disappeared before completion.");
  const status = await inspectRegisteredWorktree(control, record, gitRunner);
  if (status.reconciliation !== "complete") {
    reconciliationRequired("Task worktree creation requires manual reconciliation.", {
      recordId,
      reasons: status.reasons
    });
  }
  await hook?.("before-complete");
  await assertControlUnchanged(control, gitRunner);
  const finalStatus = await inspectRegisteredWorktree(control, record, gitRunner);
  if (finalStatus.reconciliation !== "complete") {
    reconciliationRequired("Task worktree changed at the creation completion boundary.", {
      recordId,
      reasons: finalStatus.reasons
    });
  }
  const snapshot = await captureGitCheckpointSnapshot(record.worktreePath);
  if (!snapshot.checkpoint.available || snapshot.checkpoint.head !== record.baseHead || !snapshot.checkpoint.worktree.clean) {
    reconciliationRequired("Created task worktree does not match its exact clean base.", {
      expectedHead: record.baseHead,
      actualHead: snapshot.checkpoint.head,
      clean: snapshot.checkpoint.worktree.clean
    });
  }
  record.worktreeIdentity = await identity(record.worktreePath);
  record.gitDirectory = await realpath((await gitRunner(record.worktreePath, [
    "rev-parse", "--path-format=absolute", "--absolute-git-dir"
  ])).toString("utf8").trim());
  record.gitDirectoryIdentity = await identity(record.gitDirectory);
  const completedAt = now();
  if (Date.parse(lease.expiresAt) <= completedAt.getTime()) {
    conflict(`Task ${record.taskId} writer lease expired before worktree creation completed.`, {
      expiresAt: lease.expiresAt
    });
  }
  const timestamp = completedAt.toISOString();
  record.creation = { ...record.creation, status: "COMPLETE", completedAt: timestamp };
  record.lastCapturedFingerprint = snapshot.checkpoint.worktree.fingerprint;
  record.updatedAt = timestamp;
  appendEvent(loaded.registry, record, "worktree.create.completed", timestamp, {
    path: record.worktreePath,
    baseHead: record.baseHead,
    fingerprint: record.lastCapturedFingerprint
  });
  await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
  return structuredClone(record);
}

async function addDetachedWorktree(
  control: Awaited<ReturnType<typeof inspectControl>>,
  record: TaskWorktreeRecord,
  gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>,
  hook?: TaskWorktreeDependencies["worktreeHook"]
) {
  await assertControlUnchanged(control, gitRunner);
  if (await pathType(record.worktreePath) !== "missing") {
    reconciliationRequired("Task worktree destination exists but is not a verified registered worktree.", {
      destination: record.worktreePath
    });
  }
  const listed = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
  if (listed.some(item => item.path === record.worktreePath)) {
    reconciliationRequired("Task worktree destination has a foreign Git registration.", { destination: record.worktreePath });
  }
  const containing = listed.find(item => within(item.path, record.worktreePath));
  if (containing) {
    reconciliationRequired("Task worktree destination became nested in a registered Git worktree.", {
      destination: record.worktreePath,
      registeredWorktree: containing.path
    });
  }
  await gitRunner(control.controlRoot, ["worktree", "add", "--detach", record.worktreePath, record.baseHead]);
  await assertControlUnchanged(control, gitRunner);
  await hook?.("after-add");
}

export async function createTaskWorktree(
  options: CreateTaskWorktreeOptions = {},
  dependencies: TaskWorktreeDependencies = {}
): Promise<TaskWorktreeStatus> {
  const taskId = String(options.taskId || "").trim();
  const destination = String(options.destination || "").trim();
  if (!taskId || !destination) invalid("Task worktree creation requires a task ID and explicit destination.");
  const gitRunner = dependencies.gitRunner || defaultGitRunner;
  const now = dependencies.clock || (() => new Date());
  const control = await inspectControl(path.resolve(options.directory || "."), gitRunner);
  const worktreePath = await canonicalDestination(control, destination);

  return await withOrchestrationSnapshot(control.controlRoot, async orchestration => {
    await assertControlUnchanged(control, gitRunner);
    const task = orchestration.state.tasks[taskId];
    if (!task) conflict(`Task ${taskId} does not exist.`, { taskId });
    const lease = assertLease(taskId, task.lease, options, now());
    if (control.head !== lease.baseline.head) {
      conflict("Control checkout HEAD moved from the lease base.", {
        expected: lease.baseline.head,
        actual: control.head
      });
    }

    const loaded = await readRegistry(control.controlRoot);
    for (const item of loaded.registry.records) {
      if (item.controlRoot !== control.controlRoot
        || item.gitCommonDirectory !== control.gitCommonDirectory
        || !sameIdentity(item.controlIdentity, control.controlIdentity)
        || !sameIdentity(item.gitCommonIdentity, control.gitCommonIdentity)) {
        conflict("Task worktree registry belongs to a different control checkout identity.", { recordId: item.id });
      }
    }
    const existing = loaded.registry.records.find(item => item.taskId === taskId && item.cleanup.status !== "COMPLETE");
    if (existing) {
      if (existing.leaseId !== lease.id || existing.generation !== lease.generation
        || existing.taskRevision !== lease.taskRevision || existing.worktreePath !== worktreePath) {
        conflict("Task already has a different active worktree registration.", { recordId: existing.id });
      }
      const status = await inspectRegisteredWorktree(control, existing, gitRunner);
      if (existing.creation.status === "COMPLETE") {
        if (status.reconciliation !== "complete") reconciliationRequired("Registered task worktree identity changed.", status);
        const inspectedAt = now();
        if (Date.parse(lease.expiresAt) <= inspectedAt.getTime()) {
          conflict(`Task ${taskId} writer lease expired while revalidating its task worktree.`, {
            expiresAt: lease.expiresAt
          });
        }
        return status;
      }
      if (status.reconciliation === "manual_reconciliation") reconciliationRequired("Interrupted creation requires manual reconciliation.", status);
      if (status.reconciliation === "absent_resumable") await addDetachedWorktree(control, existing, gitRunner, dependencies.worktreeHook);
      const record = await completeRecord(control, existing.id, lease, now, gitRunner, dependencies.worktreeHook);
      return { record, reconciliation: "complete", reasons: ["interrupted creation reconciled"] };
    }
    if (loaded.registry.records.some(item => item.cleanup.status !== "COMPLETE" && item.worktreePath === worktreePath)) {
      conflict("Task worktree destination is already registered.", { destination: worktreePath });
    }
    if (await pathType(worktreePath) !== "missing") conflict("Task worktree destination already exists.", { destination: worktreePath });
    const listed = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
    if (listed.some(item => item.path === worktreePath)) conflict("Task worktree destination has a foreign Git registration.", { destination: worktreePath });
    const containing = listed.find(item => within(item.path, worktreePath));
    if (containing) {
      conflict("Task worktree destination must not be nested in a registered Git worktree.", {
        destination: worktreePath,
        registeredWorktree: containing.path
      });
    }

    const timestamp = now().toISOString();
    const record: TaskWorktreeRecord = {
      id: randomUUID(),
      taskId,
      leaseId: lease.id,
      generation: lease.generation,
      taskRevision: lease.taskRevision,
      ownerThread: lease.ownerThread,
      controlRoot: control.controlRoot,
      controlIdentity: control.controlIdentity,
      gitCommonDirectory: control.gitCommonDirectory,
      gitCommonIdentity: control.gitCommonIdentity,
      worktreePath,
      registrationsAtIntent: listed.map(item => item.path),
      sourceBranch: control.sourceBranch,
      baseHead: lease.baseline.head!,
      createdAt: timestamp,
      creation: { status: "INTENT", intentAt: timestamp },
      integration: { status: "PENDING" },
      cleanup: { status: "ACTIVE" },
      updatedAt: timestamp
    };
    makeRoomForWorktreeRecord(loaded.registry);
    loaded.registry.records.push(record);
    appendEvent(loaded.registry, record, "worktree.create.intent", timestamp, {
      path: worktreePath,
      baseHead: record.baseHead,
      sourceBranch: record.sourceBranch
    });
    await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
    await dependencies.worktreeHook?.("after-intent");
    await addDetachedWorktree(control, record, gitRunner, dependencies.worktreeHook);
    const completed = await completeRecord(control, record.id, lease, now, gitRunner, dependencies.worktreeHook);
    return { record: completed, reconciliation: "complete", reasons: [] };
  });
}

function verifyRecordControl(
  record: TaskWorktreeRecord,
  control: Awaited<ReturnType<typeof inspectControl>>
) {
  if (record.controlRoot !== control.controlRoot
    || record.gitCommonDirectory !== control.gitCommonDirectory
    || !sameIdentity(record.controlIdentity, control.controlIdentity)
    || !sameIdentity(record.gitCommonIdentity, control.gitCommonIdentity)) {
    reconciliationRequired("Task worktree registry control identity changed.", { recordId: record.id });
  }
}

function assertRecordLease(record: TaskWorktreeRecord, lease: TaskLease) {
  if (record.leaseId !== lease.id
    || record.generation !== lease.generation
    || record.taskRevision !== lease.taskRevision
    || record.ownerThread !== lease.ownerThread) {
    conflict("Task worktree registration does not match the active lease generation.", { recordId: record.id });
  }
}

function exactStringArray(left: string[], right: string[]): boolean {
  const first = [...left].sort();
  const second = [...right].sort();
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

function proposalIdentityFor(
  taskId: string,
  lease: TaskLease,
  ownedPaths: string[],
  leaseBaselines: LeaseBaselinesLedger
): RecoveryProposalIdentity {
  const baseline = leaseBaselines.baselines.find(item =>
    item.taskId === taskId
    && item.leaseId === lease.id
    && item.generation === lease.generation
    && item.taskRevision === lease.taskRevision
  );
  if (!baseline) conflict("Task worktree lease baseline is missing or mismatched.", { taskId, leaseId: lease.id });
  return {
    taskId,
    leaseId: lease.id,
    generation: lease.generation,
    baseRevision: lease.taskRevision,
    revision: lease.taskRevision + 1,
    scopes: lease.scopes,
    ownedPaths,
    baseline: {
      snapshotHash: baseline.snapshot.contentHash,
      worktreeFingerprint: baseline.snapshot.worktreeFingerprint
    }
  };
}

async function ensureProposalDestination(controlRoot: string, recordId: string): Promise<{ relative: string; absolute: string }> {
  const relative = `.synod/worktree-proposals/${recordId}`;
  const absolute = resolveProjectPath(controlRoot, relative);
  const parent = path.dirname(absolute);
  const unsafeBefore = await unsafeAncestor(controlRoot, parent);
  if (unsafeBefore) conflict("Task worktree proposal path has an unsafe ancestor.", { unsafeAncestor: unsafeBefore });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const unsafeAfter = await unsafeAncestor(controlRoot, parent);
  if (unsafeAfter || await realpath(parent) !== parent) {
    conflict("Task worktree proposal parent is not a canonical real directory.", { path: parent });
  }
  return { relative, absolute };
}

export async function sealTaskWorktreeProposal(
  options: FencedTaskWorktreeOptions = {},
  dependencies: TaskWorktreeDependencies = {}
): Promise<TaskWorktreeRecord> {
  const taskId = String(options.taskId || "").trim();
  if (!taskId) invalid("Task worktree proposal sealing requires a task ID.");
  const gitRunner = dependencies.gitRunner || defaultGitRunner;
  const now = dependencies.clock || (() => new Date());
  const control = await inspectControl(path.resolve(options.directory || "."), gitRunner);
  return await withOrchestrationSnapshot(control.controlRoot, async orchestration => {
    await assertControlUnchanged(control, gitRunner);
    const task = orchestration.state.tasks[taskId];
    if (!task) conflict(`Task ${taskId} does not exist.`, { taskId });
    if (task.state !== "ACTIVE") conflict(`Task ${taskId} must be ACTIVE before sealing a worktree proposal.`, { state: task.state });
    const lease = assertLease(taskId, task.lease, options, now());
    const loaded = await readRegistry(control.controlRoot);
    const record = [...loaded.registry.records].reverse().find(item => item.taskId === taskId && item.cleanup.status !== "COMPLETE");
    if (!record) conflict(`Task ${taskId} has no active worktree registration.`, { taskId });
    verifyRecordControl(record, control);
    assertRecordLease(record, lease);
    if (record.creation.status !== "COMPLETE") conflict("Task worktree creation is not complete.", { recordId: record.id });
    const physical = await inspectRegisteredWorktree(control, record, gitRunner);
    if (physical.reconciliation !== "complete") reconciliationRequired("Task worktree identity changed before proposal sealing.", physical);

    const captured = await captureGitCheckpointSnapshot(record.worktreePath);
    if (!captured.checkpoint.available || captured.checkpoint.head !== record.baseHead || captured.snapshot.entries.length === 0) {
      conflict("Task worktree proposal requires changed material at the recorded base.", {
        expectedHead: record.baseHead,
        actualHead: captured.checkpoint.head
      });
    }
    const ownedPaths = [...new Set(captured.snapshot.entries.flatMap(item => [
      item.path,
      ...(item.sourcePath ? [item.sourcePath] : [])
    ]))].sort();
    for (const candidate of ownedPaths) {
      if (!lease.scopes.some(scope => scope.access === "write" && leaseScopeCoversPath(scope, candidate))) {
        conflict("Task worktree proposal contains material outside its writer lease.", { path: candidate });
      }
    }
    const proposalIdentity = proposalIdentityFor(taskId, lease, ownedPaths, orchestration.leaseBaselines);
    const destination = await ensureProposalDestination(control.controlRoot, record.id);
    if (record.proposal?.status === "SEALED") {
      const verified = await verifyRecoveryBundle({ bundle: destination.absolute });
      if (verified.bundleId !== record.proposal.bundleId
        || verified.manifest.checkpoint.fingerprint !== record.proposal.fingerprint
        || captured.checkpoint.worktree.fingerprint !== record.proposal.fingerprint) {
        reconciliationRequired("Sealed task worktree proposal no longer matches its source or registry.", { recordId: record.id });
      }
      return structuredClone(record);
    }

    if (!record.proposal) {
      const timestamp = now().toISOString();
      record.proposal = { status: "INTENT", path: destination.relative, intentAt: timestamp };
      record.updatedAt = timestamp;
      appendEvent(loaded.registry, record, "worktree.proposal.intent", timestamp, {
        path: destination.relative,
        ownedPaths
      });
      await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
      await dependencies.worktreeHook?.("after-proposal-intent");
    }

    let verified;
    if (await pathType(destination.absolute) === "missing") {
      const temporaryDestination = `${destination.absolute}.staging-${randomUUID()}`;
      await exportSnapshotRecoveryBundle({
        directory: record.worktreePath,
        destination: temporaryDestination,
        snapshot: captured.snapshot,
        source: { branch: null, head: record.baseHead },
        event: { sequence: orchestration.state.lastEvent.sequence, hash: orchestration.state.lastEvent.hash },
        proposal: proposalIdentity,
        guardCheckpoint: captured.checkpoint,
        includeUntracked: true
      });
      await dependencies.worktreeHook?.("before-proposal-rename");
      if (await pathType(destination.absolute) !== "missing") {
        reconciliationRequired("Task worktree proposal destination changed before atomic publication.", { recordId: record.id });
      }
      await rename(temporaryDestination, destination.absolute);
      verified = await verifyRecoveryBundle({ bundle: destination.absolute });
    } else {
      verified = await verifyRecoveryBundle({ bundle: destination.absolute });
    }
    await dependencies.worktreeHook?.("after-proposal-publish");
    const boundary = await captureGitCheckpointSnapshot(record.worktreePath);
    if (boundary.checkpoint.head !== record.baseHead
      || boundary.checkpoint.worktree.fingerprint !== captured.checkpoint.worktree.fingerprint
      || stableCheckpointStringify(boundary.snapshot.entries) !== stableCheckpointStringify(captured.snapshot.entries)
      || verified.bundleId !== verified.manifest.bundleId
      || verified.manifest.source.head !== record.baseHead
      || verified.manifest.source.branch !== null
      || verified.manifest.checkpoint.fingerprint !== captured.checkpoint.worktree.fingerprint
      || stableCheckpointStringify(verified.manifest.proposal) !== stableCheckpointStringify(proposalIdentity)) {
      reconciliationRequired("Published task worktree proposal does not match its exact source snapshot.", { recordId: record.id });
    }
    const sealedAt = now();
    if (Date.parse(lease.expiresAt) <= sealedAt.getTime()) {
      conflict(`Task ${taskId} writer lease expired before proposal sealing completed.`, { expiresAt: lease.expiresAt });
    }
    const refreshed = await readRegistry(control.controlRoot);
    const refreshedRecord = refreshed.registry.records.find(item => item.id === record.id);
    if (!refreshedRecord || refreshedRecord.proposal?.status !== "INTENT") invalid("Task worktree proposal intent disappeared.");
    const timestamp = sealedAt.toISOString();
    refreshedRecord.proposal = {
      ...refreshedRecord.proposal,
      status: "SEALED",
      bundleId: verified.bundleId,
      fingerprint: verified.manifest.checkpoint.fingerprint,
      sealedAt: timestamp
    };
    refreshedRecord.lastCapturedFingerprint = boundary.checkpoint.worktree.fingerprint;
    refreshedRecord.updatedAt = timestamp;
    appendEvent(refreshed.registry, refreshedRecord, "worktree.proposal.sealed", timestamp, {
      path: destination.relative,
      bundleId: verified.bundleId,
      fingerprint: verified.manifest.checkpoint.fingerprint
    });
    await writeRegistry(control.controlRoot, refreshed.registry, refreshed.expected);
    return structuredClone(refreshedRecord);
  });
}

function validateIntegrationAttribution(
  state: OrchestrationState,
  leaseBaselines: LeaseBaselinesLedger,
  record: TaskWorktreeRecord,
  current: Awaited<ReturnType<typeof captureGitCheckpointSnapshot>>,
  proposalOwnedPaths: string[],
  allowAppliedProposal: boolean
) {
  const baseline = leaseBaselines.baselines.find(item =>
    item.taskId === record.taskId && item.leaseId === record.leaseId && item.generation === record.generation
  );
  if (!baseline) conflict("Task worktree integration baseline is missing.", { recordId: record.id });
  if (current.checkpoint.head !== record.baseHead) {
    conflict("Control checkout HEAD does not match the task worktree base.", {
      expected: record.baseHead,
      actual: current.checkpoint.head
    });
  }
  const proposalPaths = new Set(proposalOwnedPaths);
  const otherWriteScopes = Object.values(state.tasks).flatMap(task =>
    task.id !== record.taskId && task.lease ? task.lease.scopes.filter(scope => scope.access === "write") : []
  );
  const otherProposalPaths = new Set(Object.values(state.tasks).flatMap(task =>
    task.id !== record.taskId && task.proposal ? task.proposal.ownedPaths : []
  ));
  const delta = explainCheckpointDelta(baseline.snapshot, current.snapshot);
  for (const item of delta.paths) {
    const paths = [item.path, ...(item.sourcePath ? [item.sourcePath] : [])];
    const touchesProposal = paths.some(candidate => proposalPaths.has(candidate));
    if (touchesProposal) {
      if (allowAppliedProposal && paths.every(candidate => proposalPaths.has(candidate))) continue;
      conflict("Control checkout already contains drift in task proposal paths.", { paths });
    }
    const attributed = paths.every(candidate =>
      otherWriteScopes.some(scope => leaseScopeCoversPath(scope, candidate))
      || otherProposalPaths.has(candidate)
    );
    if (!attributed) conflict("Control checkout contains unowned drift outside the task proposal.", { paths });
  }
}

function unrelatedProposalEntries(
  current: Awaited<ReturnType<typeof captureGitCheckpointSnapshot>>,
  ownedPaths: string[]
) {
  const owned = new Set(ownedPaths);
  return current.snapshot.entries.filter(item => {
    const paths = [item.path, ...(item.sourcePath ? [item.sourcePath] : [])];
    const touches = paths.filter(candidate => owned.has(candidate));
    if (touches.length > 0 && touches.length !== paths.length) {
      conflict("A control-checkout rename crosses the task proposal boundary.", { paths });
    }
    return touches.length === 0;
  });
}

export async function integrateTaskWorktreeProposal(
  options: FencedTaskWorktreeOptions = {},
  dependencies: TaskWorktreeDependencies = {}
): Promise<TaskWorktreeRecord> {
  const taskId = String(options.taskId || "").trim();
  if (!taskId) invalid("Task worktree integration requires a task ID.");
  const gitRunner = dependencies.gitRunner || defaultGitRunner;
  const now = dependencies.clock || (() => new Date());
  const control = await inspectControl(path.resolve(options.directory || "."), gitRunner);
  return await withOrchestrationSnapshot(control.controlRoot, async orchestration => {
    await assertControlUnchanged(control, gitRunner);
    const task = orchestration.state.tasks[taskId];
    if (!task) conflict(`Task ${taskId} does not exist.`, { taskId });
    if (task.state !== "ACTIVE") conflict(`Task ${taskId} must be ACTIVE before integrating a worktree proposal.`, { state: task.state });
    const lease = assertLease(taskId, task.lease, options, now());
    const loaded = await readRegistry(control.controlRoot);
    const record = [...loaded.registry.records].reverse().find(item => item.taskId === taskId && item.cleanup.status !== "COMPLETE");
    if (!record) conflict(`Task ${taskId} has no active worktree registration.`, { taskId });
    verifyRecordControl(record, control);
    assertRecordLease(record, lease);
    if (record.proposal?.status !== "SEALED" || !record.proposal.bundleId || !record.proposal.fingerprint) {
      conflict("Task worktree integration requires a sealed proposal.", { recordId: record.id });
    }
    const bundle = resolveProjectPath(control.controlRoot, record.proposal.path);
    const verified = await verifyRecoveryBundle({ bundle });
    if (verified.bundleId !== record.proposal.bundleId
      || verified.manifest.checkpoint.fingerprint !== record.proposal.fingerprint
      || verified.manifest.source.head !== record.baseHead
      || !verified.manifest.proposal
      || verified.manifest.proposal.taskId !== record.taskId
      || verified.manifest.proposal.leaseId !== record.leaseId
      || verified.manifest.proposal.generation !== record.generation) {
      reconciliationRequired("Task worktree proposal registry and bundle identities differ.", { recordId: record.id });
    }
    const source = await captureGitCheckpointSnapshot(record.worktreePath);
    if (source.checkpoint.head !== record.baseHead
      || source.checkpoint.worktree.fingerprint !== record.proposal.fingerprint) {
      reconciliationRequired("Task worktree changed after its proposal was sealed.", { recordId: record.id });
    }
    if (record.integration.status === "COMPLETE") {
      const completedControl = await captureGitCheckpointSnapshot(control.controlRoot);
      if (record.integration.fingerprint !== record.proposal.fingerprint
        || completedControl.checkpoint.head !== record.baseHead
        || completedControl.checkpoint.branch !== record.sourceBranch
        || completedControl.checkpoint.worktree.fingerprint !== record.integration.overallFingerprint) {
        reconciliationRequired("Completed task worktree integration no longer matches its sealed proposal or control checkout.", {
          recordId: record.id,
          expectedHead: record.baseHead,
          actualHead: completedControl.checkpoint.head,
          expectedFingerprint: record.integration.overallFingerprint,
          actualFingerprint: completedControl.checkpoint.worktree.fingerprint
        });
      }
      const inspectedAt = now();
      if (Date.parse(lease.expiresAt) <= inspectedAt.getTime()) {
        conflict(`Task ${taskId} writer lease expired while revalidating its integrated proposal.`, {
          expiresAt: lease.expiresAt
        });
      }
      return structuredClone(record);
    }
    const initialControl = await captureGitCheckpointSnapshot(control.controlRoot);
    validateIntegrationAttribution(
      orchestration.state,
      orchestration.leaseBaselines,
      record,
      initialControl,
      verified.manifest.proposal.ownedPaths,
      record.integration.status === "INTENT"
    );
    if (record.integration.status === "PENDING") {
      const timestamp = now().toISOString();
      record.integration = { status: "INTENT", intentAt: timestamp };
      record.updatedAt = timestamp;
      appendEvent(loaded.registry, record, "worktree.integration.intent", timestamp, {
        bundleId: verified.bundleId,
        ownedPaths: verified.manifest.proposal.ownedPaths
      });
      await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
      await dependencies.worktreeHook?.("after-integration-intent");
    }
    const restored = await restoreRecoveryBundleOverlayUnderLock({
      bundle,
      directory: control.controlRoot,
      expectedUnrelatedEntries: unrelatedProposalEntries(initialControl, verified.manifest.proposal.ownedPaths)
    }, { ...(dependencies.restoreHook ? { restoreHook: dependencies.restoreHook } : {}) });
    await dependencies.worktreeHook?.("after-integration-restore");
    const boundaryControl = await captureGitCheckpointSnapshot(control.controlRoot);
    validateIntegrationAttribution(
      orchestration.state,
      orchestration.leaseBaselines,
      record,
      boundaryControl,
      verified.manifest.proposal.ownedPaths,
      true
    );
    const boundaryRestore = await restoreRecoveryBundleOverlayUnderLock({
      bundle,
      directory: control.controlRoot,
      expectedUnrelatedEntries: unrelatedProposalEntries(boundaryControl, verified.manifest.proposal.ownedPaths)
    }, { ...(dependencies.restoreHook ? { restoreHook: dependencies.restoreHook } : {}) });
    await assertControlUnchanged(control, gitRunner);
    await dependencies.worktreeHook?.("before-integration-complete");
    const completionBoundary = await captureGitCheckpointSnapshot(control.controlRoot);
    if (completionBoundary.checkpoint.head !== record.baseHead
      || completionBoundary.checkpoint.branch !== control.sourceBranch
      || completionBoundary.checkpoint.worktree.fingerprint !== boundaryRestore.overallFingerprint) {
      reconciliationRequired("Control checkout changed at the proposal integration completion boundary.", {
        expectedHead: record.baseHead,
        actualHead: completionBoundary.checkpoint.head,
        expectedBranch: control.sourceBranch,
        actualBranch: completionBoundary.checkpoint.branch,
        expectedFingerprint: boundaryRestore.overallFingerprint,
        actualFingerprint: completionBoundary.checkpoint.worktree.fingerprint
      });
    }
    const integratedAt = now();
    if (Date.parse(lease.expiresAt) <= integratedAt.getTime()) {
      conflict(`Task ${taskId} writer lease expired before proposal integration completed.`, { expiresAt: lease.expiresAt });
    }
    const refreshed = await readRegistry(control.controlRoot);
    const refreshedRecord = refreshed.registry.records.find(item => item.id === record.id);
    if (!refreshedRecord || refreshedRecord.integration.status !== "INTENT") invalid("Task worktree integration intent disappeared.");
    const timestamp = integratedAt.toISOString();
    refreshedRecord.integration = {
      ...refreshedRecord.integration,
      status: "COMPLETE",
      completedAt: timestamp,
      fingerprint: boundaryRestore.fingerprint,
      overallFingerprint: boundaryRestore.overallFingerprint
    };
    refreshedRecord.updatedAt = timestamp;
    appendEvent(refreshed.registry, refreshedRecord, "worktree.integration.completed", timestamp, {
      bundleId: verified.bundleId,
      fingerprint: boundaryRestore.fingerprint,
      overallFingerprint: boundaryRestore.overallFingerprint,
      recoveredInterruptedRestore: restored.recoveredInterruptedRestore || boundaryRestore.recoveredInterruptedRestore
    });
    await writeRegistry(control.controlRoot, refreshed.registry, refreshed.expected);
    return structuredClone(refreshedRecord);
  });
}

export async function cleanupTaskWorktree(
  { directory = ".", taskId }: CleanupTaskWorktreeOptions = {},
  dependencies: TaskWorktreeDependencies = {}
): Promise<TaskWorktreeRecord> {
  const id = String(taskId || "").trim();
  if (!id) invalid("Task worktree cleanup requires a task ID.");
  const gitRunner = dependencies.gitRunner || defaultGitRunner;
  const now = dependencies.clock || (() => new Date());
  const control = await inspectControl(path.resolve(directory), gitRunner);
  return await withOrchestrationSnapshot(control.controlRoot, async () => {
    const loaded = await readRegistry(control.controlRoot);
    const record = [...loaded.registry.records].reverse().find(item => item.taskId === id && item.cleanup.status !== "COMPLETE");
    if (!record) conflict(`Task ${id} has no active worktree registration.`, { taskId: id });
    verifyRecordControl(record, control);
    if (record.creation.status !== "COMPLETE") conflict("Task worktree creation must be reconciled before cleanup.", { recordId: record.id });

    if (record.cleanup.status === "ACTIVE") {
      const physical = await inspectRegisteredWorktree(control, record, gitRunner, { requireControlBase: false });
      if (physical.reconciliation === "manual_reconciliation") {
        reconciliationRequired("Task worktree identity changed before cleanup.", physical);
      }
      if (physical.reconciliation === "complete"
        && (await gitRunner(record.worktreePath, [
          "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"
        ])).length > 0) {
        conflict("Task worktree cleanup refuses dirty or untracked material.", { recordId: record.id });
      }
      const registrations = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
      const expected = registrations.filter(item => item.path !== record.worktreePath).map(item => item.path);
      const timestamp = now().toISOString();
      record.cleanup = { status: "INTENT", intentAt: timestamp, registrationsAtIntent: expected };
      record.updatedAt = timestamp;
      appendEvent(loaded.registry, record, "worktree.cleanup.intent", timestamp, { expectedRegistrations: expected });
      await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
      await dependencies.worktreeHook?.("after-cleanup-intent");
    }

    const refreshed = await readRegistry(control.controlRoot);
    const refreshedRecord = refreshed.registry.records.find(item => item.id === record.id);
    if (!refreshedRecord || refreshedRecord.cleanup.status !== "INTENT"
      || !refreshedRecord.cleanup.registrationsAtIntent) invalid("Task worktree cleanup intent disappeared.");
    const currentEntries = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
    const listed = currentEntries.find(item => item.path === refreshedRecord.worktreePath);
    if (listed) {
      const physical = await inspectRegisteredWorktree(control, refreshedRecord, gitRunner, { requireControlBase: false });
      if (physical.reconciliation !== "complete") reconciliationRequired("Task worktree cleanup requires manual reconciliation.", physical);
      if ((await gitRunner(refreshedRecord.worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"
      ])).length > 0) {
        conflict("Task worktree cleanup refuses dirty or untracked material.", { recordId: refreshedRecord.id });
      }
      const others = currentEntries.filter(item => item.path !== refreshedRecord.worktreePath).map(item => item.path);
      if (!exactStringArray(others, refreshedRecord.cleanup.registrationsAtIntent)) {
        reconciliationRequired("Git worktree registrations changed after cleanup intent.", { recordId: refreshedRecord.id });
      }
      const cleanupControl = await inspectControl(control.controlRoot, gitRunner);
      await gitRunner(control.controlRoot, ["worktree", "remove", refreshedRecord.worktreePath]);
      await assertControlUnchanged(cleanupControl, gitRunner);
      await dependencies.worktreeHook?.("after-cleanup-remove");
    }
    const finalEntries = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
    if (await pathType(refreshedRecord.worktreePath) !== "missing"
      || finalEntries.some(item => item.path === refreshedRecord.worktreePath)
      || !exactStringArray(finalEntries.map(item => item.path), refreshedRecord.cleanup.registrationsAtIntent)
      || (refreshedRecord.gitDirectory && await pathType(refreshedRecord.gitDirectory) !== "missing")) {
      reconciliationRequired("Task worktree cleanup did not reach a verified absent state.", { recordId: refreshedRecord.id });
    }
    const completed = await readRegistry(control.controlRoot);
    const completedRecord = completed.registry.records.find(item => item.id === record.id);
    if (!completedRecord || completedRecord.cleanup.status !== "INTENT") invalid("Task worktree cleanup intent disappeared before completion.");
    const timestamp = now().toISOString();
    completedRecord.cleanup = { ...completedRecord.cleanup, status: "COMPLETE", completedAt: timestamp };
    completedRecord.updatedAt = timestamp;
    appendEvent(completed.registry, completedRecord, "worktree.cleanup.completed", timestamp, {
      path: completedRecord.worktreePath
    });
    await writeRegistry(control.controlRoot, completed.registry, completed.expected);
    return structuredClone(completedRecord);
  });
}

export async function taskWorktreeStatus(
  { directory = ".", taskId }: { directory?: string; taskId?: string } = {},
  dependencies: TaskWorktreeDependencies = {}
): Promise<TaskWorktreeStatus> {
  const id = String(taskId || "").trim();
  if (!id) invalid("Task worktree status requires a task ID.");
  const gitRunner = dependencies.gitRunner || defaultGitRunner;
  const control = await inspectControl(path.resolve(directory), gitRunner);
  return await withOrchestrationSnapshot(control.controlRoot, async () => {
    const loaded = await readRegistry(control.controlRoot);
    const record = [...loaded.registry.records].reverse().find(item => item.taskId === id && item.cleanup.status !== "COMPLETE");
    if (!record) conflict(`Task ${id} has no active worktree registration.`, { taskId: id });
    if (record.controlRoot !== control.controlRoot
      || record.gitCommonDirectory !== control.gitCommonDirectory
      || !sameIdentity(record.controlIdentity, control.controlIdentity)
      || !sameIdentity(record.gitCommonIdentity, control.gitCommonIdentity)) {
      reconciliationRequired("Task worktree registry control identity changed.", { recordId: record.id });
    }
    return await inspectRegisteredWorktree(control, record, gitRunner);
  });
}
