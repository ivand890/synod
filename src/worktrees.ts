import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { stableCheckpointStringify } from "./checkpoint.js";
import { applyTransaction, inspectPath, pathType, resolveProjectPath } from "./filesystem.js";
import { type TaskLease } from "./leases.js";
import { captureGitCheckpointSnapshot, withOrchestrationSnapshot } from "./orchestration.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { errorMessage, isRecord, parseJson } from "./validation.js";

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
    bundleId: string;
    path: string;
  };
  integration: {
    status: "PENDING" | "COMPLETE";
    completedAt?: string;
    fingerprint?: string;
  };
  cleanup: {
    status: "ACTIVE" | "INTENT" | "COMPLETE";
    intentAt?: string;
    completedAt?: string;
  };
  updatedAt: string;
}

export interface TaskWorktreeEvent {
  sequence: number;
  id: string;
  timestamp: string;
  type: "worktree.create.intent" | "worktree.create.completed";
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

export interface TaskWorktreeDependencies {
  gitRunner?: (directory: string, args: string[]) => Promise<Buffer>;
  clock?: () => Date;
  worktreeHook?: (stage: "after-intent" | "after-add" | "before-complete") => void | Promise<void>;
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
    || !["PENDING", "COMPLETE"].includes(String(value.integration.status))
    || (value.integration.completedAt !== undefined && !validTimestamp(value.integration.completedAt))
    || (value.integration.fingerprint !== undefined && !isHash(value.integration.fingerprint))
    || !isRecord(value.cleanup)
    || !["ACTIVE", "INTENT", "COMPLETE"].includes(String(value.cleanup.status))
    || (value.cleanup.intentAt !== undefined && !validTimestamp(value.cleanup.intentAt))
    || (value.cleanup.completedAt !== undefined && !validTimestamp(value.cleanup.completedAt))) {
    invalid("Task worktree registry contains an invalid record.");
  }
  if (value.creation.status === "COMPLETE"
    && (!value.worktreeIdentity || !value.gitDirectory || !value.gitDirectoryIdentity
      || !value.creation.completedAt || !value.lastCapturedFingerprint)) {
    invalid("A completed task worktree record is missing its verified identity.");
  }
  if (value.proposal !== undefined && (!isRecord(value.proposal)
    || !isHash(value.proposal.bundleId) || typeof value.proposal.path !== "string" || !value.proposal.path)) {
    invalid("Task worktree registry contains an invalid proposal reference.");
  }
  return value as unknown as TaskWorktreeRecord;
}

export function validateTaskWorktreeRegistry(value: unknown): TaskWorktreeRegistry {
  if (!isRecord(value)
    || value.schemaVersion !== TASK_WORKTREES_SCHEMA_VERSION
    || !Array.isArray(value.records)
    || value.records.length > MAX_WORKTREE_RECORDS
    || !Array.isArray(value.events)
    || value.events.length > MAX_WORKTREE_RECORDS * 2) {
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
      || !["worktree.create.intent", "worktree.create.completed"].includes(String(raw.type))
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
    if (event.type === "worktree.create.intent") {
      if (priorRecord || eventRecord.creation.status !== "INTENT") {
        invalid("Task worktree creation intent is inconsistent.");
      }
    } else if (!priorRecord || priorRecord.creation.status !== "INTENT" || eventRecord.creation.status !== "COMPLETE") {
      invalid("Task worktree creation completion is inconsistent.");
    }
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

function assertLease(
  taskId: string,
  lease: TaskLease | undefined,
  options: CreateTaskWorktreeOptions,
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
  gitRunner: NonNullable<TaskWorktreeDependencies["gitRunner"]>
): Promise<TaskWorktreeStatus> {
  const reasons: string[] = [];
  if (control.head !== record.baseHead) reasons.push("control HEAD moved from the recorded base");
  if (control.sourceBranch !== record.sourceBranch) reasons.push("control branch changed from the recorded source");
  const entries = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
  const listed = entries.find(item => item.path === record.worktreePath);
  const destinationType = await pathType(record.worktreePath);
  if (!listed && destinationType === "missing") {
    const currentRegistrations = entries.map(item => item.path).sort();
    const intentRegistrations = [...record.registrationsAtIntent].sort();
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
        && (await gitRunner(record.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0) {
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
  now: string,
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
  record.creation = { ...record.creation, status: "COMPLETE", completedAt: now };
  record.lastCapturedFingerprint = snapshot.checkpoint.worktree.fingerprint;
  record.updatedAt = now;
  appendEvent(loaded.registry, record, "worktree.create.completed", now, {
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
        return status;
      }
      if (status.reconciliation === "manual_reconciliation") reconciliationRequired("Interrupted creation requires manual reconciliation.", status);
      if (status.reconciliation === "absent_resumable") await addDetachedWorktree(control, existing, gitRunner, dependencies.worktreeHook);
      const record = await completeRecord(control, existing.id, now().toISOString(), gitRunner, dependencies.worktreeHook);
      return { record, reconciliation: "complete", reasons: ["interrupted creation reconciled"] };
    }
    if (loaded.registry.records.some(item => item.cleanup.status !== "COMPLETE" && item.worktreePath === worktreePath)) {
      conflict("Task worktree destination is already registered.", { destination: worktreePath });
    }
    if (await pathType(worktreePath) !== "missing") conflict("Task worktree destination already exists.", { destination: worktreePath });
    const listed = parseWorktreeList(await gitRunner(control.controlRoot, ["worktree", "list", "--porcelain", "-z"]));
    if (listed.some(item => item.path === worktreePath)) conflict("Task worktree destination has a foreign Git registration.", { destination: worktreePath });

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
    loaded.registry.records.push(record);
    appendEvent(loaded.registry, record, "worktree.create.intent", timestamp, {
      path: worktreePath,
      baseHead: record.baseHead,
      sourceBranch: record.sourceBranch
    });
    await writeRegistry(control.controlRoot, loaded.registry, loaded.expected);
    await dependencies.worktreeHook?.("after-intent");
    await addDetachedWorktree(control, record, gitRunner, dependencies.worktreeHook);
    const completed = await completeRecord(control, record.id, now().toISOString(), gitRunner, dependencies.worktreeHook);
    return { record: completed, reconciliation: "complete", reasons: [] };
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
