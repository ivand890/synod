import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readlink, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "./errors.js";
import {
  applyTransaction,
  contentHash,
  inspectPath,
  normalizeText,
  type PathInspection,
  pathType,
  resolveProjectPath,
  type TransactionOperation,
  type TransactionHooks,
  unsafeAncestor
} from "./filesystem.js";
import { packageName, packageVersion } from "./package.js";
import { generatedConfigMarker, removeAgentsBlocks } from "./templates.js";
import { errorCode, errorMessage, isRecord, parseJson } from "./validation.js";
import {
  CHECKPOINT_SNAPSHOT_PATH,
  addCommittedCheckpointChanges,
  compareCheckpointPaths,
  createCheckpointSnapshot,
  explainCheckpointDelta,
  formatCheckpointDelta,
  serializeCheckpointSnapshot,
  stableCheckpointStringify,
  validateCheckpointSnapshot
} from "./checkpoint.js";
import type {
  CheckpointDelta,
  CommittedCheckpointChange,
  CheckpointEntry,
  CheckpointIndexEntry,
  CheckpointSnapshot,
  CheckpointSnapshotReference
} from "./checkpoint.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_LEASE_TTL_SECONDS,
  LEASE_BASELINES_PATH,
  MAX_LEASE_TTL_SECONDS,
  MIN_LEASE_TTL_SECONDS,
  createLeaseBaselinesLedger,
  isCorrectionPolicy,
  isEndedTaskLease,
  isLeaseBaselineReference,
  isTaskLease,
  isTaskProposalReference,
  leaseBaselinesReference,
  leaseScopeCoversPath,
  leaseScopesOverlap,
  normalizeLeaseScopes,
  parseLeaseDuration,
  retainLeaseBaselinesLedger,
  serializeLeaseBaselinesLedger,
  validateLeaseBaselinesLedger,
  type CorrectionPolicy,
  type EndedTaskLease,
  type LeaseBaseline,
  type LeaseBaselinesLedger,
  type LeaseBaselineReference,
  type TaskLease,
  type TaskProposalReference
} from "./leases.js";

export const LEGACY_ORCHESTRATION_SCHEMA_VERSION = 1;
export const ORCHESTRATION_SCHEMA_VERSION = 2;
export const ORCHESTRATION_STATE_PATH = ".synod/state.json";
export const ORCHESTRATION_EVENTS_PATH = ".synod/events.jsonl";
export const ORCHESTRATION_STATUS_PATH = "docs/synod/STATUS.md";
const ORCHESTRATION_LOCK_PATH = ".synod/orchestration.lock";
const ORCHESTRATION_PENDING_PATH = ".synod/pending-mutation.json";

export const TASK_STATES = Object.freeze([
  "PLANNED",
  "READY",
  "ACTIVE",
  "REVIEW",
  "ACCEPTED",
  "VERIFIED",
  "DONE",
  "BLOCKED",
  "SUPERSEDED"
] as const);

export type TaskState = typeof TASK_STATES[number];
export type EvidenceKind = "delivery" | "correction" | "acceptance" | "verification";

export interface GitCheckpoint {
  capturedAt: string;
  available: boolean;
  branch: string | null;
  head: string | null;
  worktree: {
    clean: boolean;
    entries: number;
    fingerprint: string;
    snapshot?: CheckpointSnapshotReference;
  };
}

export interface CheckpointDriftReason {
  field: string;
  expected: unknown;
  actual: unknown;
  expectedEntries?: number;
  actualEntries?: number;
}

export interface CheckpointDrift {
  detected: boolean;
  reasons: CheckpointDriftReason[];
}

export interface TaskEvidence {
  id: string;
  kind: EvidenceKind;
  revision: number;
  reference: string;
  actor: string;
  recordedAt: string;
  checkpoint: {
    branch: string | null;
    head: string | null;
    worktreeFingerprint: string;
  };
}

export interface TaskRecoveryRecord {
  status: "PENDING" | "RESUMED" | "REASSIGNED" | "SUPERSEDED";
  endedLease: EndedTaskLease;
  detectedAt: string;
  reason: string;
  proposal?: TaskProposalReference;
  decision?: {
    action: "resume" | "reassign" | "supersede";
    actor: string;
    recordedAt: string;
    priorOwnerThread: string;
    priorGeneration: number;
    newOwnerThread?: string;
    newGeneration?: number;
    reason: string;
  };
}

export interface OrchestrationTask {
  id: string;
  objective: string;
  dependsOn: string[];
  state: TaskState;
  revision: number;
  executor: string;
  correctionRound: number;
  correctionPolicy: CorrectionPolicy;
  leaseGeneration: number;
  lease?: TaskLease;
  proposal?: TaskProposalReference;
  acceptance: {
    criteria: string[];
    status: "pending" | "accepted";
    revision: number | null;
    evidenceIds: string[];
  };
  verification: {
    commands: string[];
    status: "pending" | "passed";
    revision: number | null;
    evidenceIds: string[];
  };
  evidence: TaskEvidence[];
  createdAt: string;
  updatedAt: string;
  blocker?: string;
  blockedFrom?: TaskState;
  supersededReason?: string;
  recovery?: TaskRecoveryRecord;
  recoveryHistory?: TaskRecoveryRecord[];
  split?: {
    replacements: string[];
    actor: string;
    reason: string;
    evidence: string[];
    recordedAt: string;
  };
  splitFrom?: string;
  preLease?: true;
}

export interface OrchestrationLastEvent {
  sequence: number;
  id: string;
  hash: string;
}

export interface OrchestrationStateCore {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  checkpoint: GitCheckpoint;
  leaseBaselines: LeaseBaselineReference;
  taskOrder: string[];
  tasks: Record<string, OrchestrationTask>;
  evidenceCounter: number;
}

export interface OrchestrationState extends OrchestrationStateCore {
  lastEvent: OrchestrationLastEvent;
}

export interface OrchestrationEvent {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  sequence: number;
  id: string;
  timestamp: string;
  type: string;
  actor: string;
  taskId?: string;
  fromState?: TaskState;
  toState?: TaskState;
  revision?: number;
  checkpoint: GitCheckpoint;
  payload: Record<string, unknown>;
  previousHash: string | null;
  state: OrchestrationStateCore;
  eventHash: string;
}

type LegacyOrchestrationTask = Omit<
  OrchestrationTask,
  "correctionPolicy" | "leaseGeneration" | "lease" | "proposal" | "recovery" | "recoveryHistory" | "split" | "splitFrom" | "preLease"
>;

interface LegacyOrchestrationStateCore {
  schemaVersion: typeof LEGACY_ORCHESTRATION_SCHEMA_VERSION;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  checkpoint: GitCheckpoint;
  taskOrder: string[];
  tasks: Record<string, LegacyOrchestrationTask>;
  evidenceCounter: number;
}

interface LegacyOrchestrationState extends LegacyOrchestrationStateCore {
  lastEvent: OrchestrationLastEvent;
}

interface LegacyOrchestrationEvent {
  schemaVersion: typeof LEGACY_ORCHESTRATION_SCHEMA_VERSION;
  sequence: number;
  id: string;
  timestamp: string;
  type: string;
  actor: string;
  taskId?: string;
  fromState?: TaskState;
  toState?: TaskState;
  revision?: number;
  checkpoint: GitCheckpoint;
  payload: Record<string, unknown>;
  previousHash: string | null;
  state: LegacyOrchestrationStateCore;
  eventHash: string;
}

type Clock = () => Date | string | number;
type GitRunner = (directory: string, args: string[]) => Promise<string>;

export interface OrchestrationDependencies extends TransactionHooks, Record<string, unknown> {
  clock?: Clock;
  gitRunner?: GitRunner;
  checkpointOverlay?: Map<string, string>;
}

interface EventMetadata {
  actor: string;
  taskId?: string;
  fromState?: TaskState;
  toState?: TaskState;
  revision?: number;
  checkpoint?: GitCheckpoint;
  payload?: Record<string, unknown>;
}

interface MutationContext {
  timestamp: string;
  checkpoint: GitCheckpoint;
  snapshot: CheckpointSnapshot;
  acknowledgedSnapshot?: CheckpointSnapshot;
  leaseBaselines: LeaseBaselinesLedger;
  nextSequence: number;
}

interface MutationResult<Result extends Record<string, unknown>> {
  updateCheckpoint?: boolean;
  leaseBaselines?: LeaseBaselinesLedger;
  metadata?: Partial<EventMetadata>;
  result: Result;
}

interface CheckpointPathRecord {
  type: "file" | "symlink" | "directory" | "other" | "ignored" | "missing";
  contentHash?: string;
  gitHead?: string;
  worktreeFingerprint?: string;
  binary?: boolean;
}

interface RawIndexEntry {
  mode: string;
  objectId: string;
  stage: number;
}

export interface OrchestrationStatusResult {
  targetDirectory: string;
  healthy: boolean;
  stateSchemaVersion: number;
  templateVersion: string;
  updatedAt: string;
  lastEvent: OrchestrationLastEvent;
  eventCount: number;
  checkpoint: GitCheckpoint;
  currentCheckpoint: GitCheckpoint;
  drift: CheckpointDrift;
  taskCounts: Record<TaskState, number>;
  tasks: OrchestrationTask[];
  leaseExpiryCandidates: Array<{
    taskId: string;
    leaseId: string;
    generation: number;
    heartbeatAt: string;
    expiresAt: string;
  }>;
  markdownView: string;
  delta?: CheckpointDelta;
}

export interface ValidatedCheckpointSource {
  targetDirectory: string;
  state: OrchestrationState;
  events: OrchestrationEvent[];
  snapshot: CheckpointSnapshot;
  current: { checkpoint: GitCheckpoint; snapshot: CheckpointSnapshot };
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["DONE", "SUPERSEDED"]);
const TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = Object.freeze({
  PLANNED: new Set<TaskState>(["READY", "BLOCKED", "SUPERSEDED"]),
  READY: new Set<TaskState>(["ACTIVE", "BLOCKED", "SUPERSEDED"]),
  ACTIVE: new Set<TaskState>(["REVIEW", "BLOCKED", "SUPERSEDED"]),
  REVIEW: new Set<TaskState>(["ACTIVE", "ACCEPTED", "BLOCKED", "SUPERSEDED"]),
  ACCEPTED: new Set<TaskState>(["ACTIVE", "VERIFIED", "BLOCKED", "SUPERSEDED"]),
  VERIFIED: new Set<TaskState>(["ACTIVE", "DONE", "BLOCKED", "SUPERSEDED"]),
  BLOCKED: new Set<TaskState>(["PLANNED", "READY", "ACTIVE", "REVIEW", "ACCEPTED", "VERIFIED", "SUPERSEDED"]),
  DONE: new Set<TaskState>(),
  SUPERSEDED: new Set<TaskState>()
});

export function legalTaskTransitions(
  task: OrchestrationTask,
  tasks: Readonly<Record<string, OrchestrationTask>>
): TaskState[] {
  if (task.recovery?.status === "PENDING") return [];
  let allowed = [...TRANSITIONS[task.state]];
  if (task.state === "BLOCKED") {
    allowed = allowed.filter(target => target === "SUPERSEDED" || target === task.blockedFrom);
  }
  if (task.dependsOn.some(dependency => tasks[dependency]?.state !== "DONE")) {
    allowed = allowed.filter(target => target !== "READY");
  }
  if (task.correctionPolicy.used >= task.correctionPolicy.limit
    && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)) {
    allowed = allowed.filter(target => target !== "ACTIVE");
  }
  return allowed;
}

const execFileAsync = promisify(execFile);

function nowIso(clock: Clock = () => new Date()): string {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("Synod clock returned an invalid date.");
  return date.toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Bytes(value: NodeJS.ArrayBufferView): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stateCore(state: OrchestrationState): OrchestrationStateCore {
  const { lastEvent: _lastEvent, ...core } = state;
  return core;
}

function isIgnoredCheckpointPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith(".synod/")
    || normalized === ORCHESTRATION_STATUS_PATH
    || normalized.startsWith(".codex/agents/synod-")
    || normalized.startsWith(".agents/skills/synod-advisor/");
}

function isFilteredCheckpointPath(relativePath: string): boolean {
  return ["AGENTS.md", ".codex/config.toml"].includes(relativePath.replaceAll("\\", "/"));
}

function checkpointContent(relativePath: string, content: string): Buffer | undefined | null {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized === "AGENTS.md") {
    const userContent = normalizeText(removeAgentsBlocks(String(content)))
      .replace(/\n+$/u, "");
    return userContent.length === 0 ? undefined : Buffer.from(`${userContent}\n`, "utf8");
  }
  if (normalized === ".codex/config.toml") {
    const text = String(content);
    return text.startsWith(generatedConfigMarker) ? undefined : Buffer.from(text, "utf8");
  }
  return null;
}

function checkpointSignature(inspected: { type?: string; contentHash?: string }): string {
  return `${inspected.type || ""}:${inspected.contentHash || ""}`;
}

async function defaultGitRunner(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", [
    "-C", directory,
    "-c", "core.fsmonitor=false",
    "-c", "status.renames=true",
    "-c", "diff.renames=true",
    ...args
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  return String(result.stdout);
}

async function optionalGit(gitRunner: GitRunner, directory: string, args: string[]): Promise<string | null> {
  try {
    return (await gitRunner(directory, args)).trim();
  } catch {
    return null;
  }
}

async function checkpointPath(directory: string, relativePath: string, gitRunner: GitRunner): Promise<CheckpointPathRecord> {
  const absolutePath = path.resolve(directory, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return { type: "symlink", contentHash: sha256Bytes(await readlink(absolutePath, { encoding: "buffer" })) };
    }
    if (stats.isDirectory()) {
      const nested = await captureGitCheckpoint(absolutePath, { gitRunner });
      return {
        type: "directory",
        ...(nested.head ? { gitHead: nested.head } : {}),
        ...(nested.available ? { worktreeFingerprint: nested.worktree.fingerprint } : {})
      };
    }
    if (!stats.isFile()) return { type: "other" };
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    const handle = await open(absolutePath, flags);
    try {
      if (!(await handle.stat()).isFile()) return { type: "other" };
      const content = await handle.readFile();
      const filtered = checkpointContent(relativePath, content.toString("utf8"));
      if (filtered === undefined) return { type: "ignored" };
      const material = filtered === null ? content : filtered;
      return {
        type: "file",
        contentHash: sha256Bytes(material),
        binary: filtered === null && (
          content.includes(0)
          || !Buffer.from(content.toString("utf8"), "utf8").equals(content)
        )
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { type: "missing" };
    throw error;
  }
}

function indexRecords(indexOutput: string): Map<string, RawIndexEntry[]> {
  const records = new Map<string, RawIndexEntry[]>();
  for (const field of indexOutput.split("\0")) {
    if (!field) continue;
    const separator = field.indexOf("\t");
    if (separator < 0) continue;
    const [mode, objectId, stage] = field.slice(0, separator).split(" ");
    const relativePath = field.slice(separator + 1);
    if (!mode || !objectId || stage === undefined) continue;
    const entries = records.get(relativePath) || [];
    entries.push({ mode, objectId, stage: Number(stage) });
    records.set(relativePath, entries);
  }
  return records;
}

function committedChangeKind(status: string): CommittedCheckpointChange["kind"] {
  const code = status[0];
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "T") return "type-changed";
  return "unmerged";
}

function parseCommittedChanges(output: string): CommittedCheckpointChange[] {
  const fields = output.split("\0");
  const changes: CommittedCheckpointChange[] = [];
  for (let cursor = 0; cursor < fields.length;) {
    const status = fields[cursor++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const sourcePath = fields[cursor++];
      const relativePath = fields[cursor++];
      if (sourcePath && relativePath && !isIgnoredCheckpointPath(relativePath)) {
        changes.push({ path: relativePath, sourcePath, kind: committedChangeKind(status) });
      }
    } else {
      const relativePath = fields[cursor++];
      if (relativePath && !isIgnoredCheckpointPath(relativePath)) {
        changes.push({ path: relativePath, kind: committedChangeKind(status) });
      }
    }
  }
  return changes;
}

function binaryPathsFromNumstat(output: string): Set<string> {
  const fields = output.split("\0");
  const binary = new Set<string>();
  for (let cursor = 0; cursor < fields.length;) {
    const header = fields[cursor++];
    if (!header) continue;
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : header.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = header.slice(0, firstTab);
    const deleted = header.slice(firstTab + 1, secondTab);
    let relativePath = header.slice(secondTab + 1);
    if (!relativePath) {
      cursor += 1;
      relativePath = fields[cursor++] || "";
    }
    if (relativePath && added === "-" && deleted === "-") binary.add(relativePath);
  }
  return binary;
}

async function checkpointCommitContent(
  directory: string,
  head: string | null,
  relativePath: string,
  gitRunner: GitRunner
): Promise<Buffer | undefined> {
  if (!head) return undefined;
  try {
    const content = await gitRunner(directory, ["cat-file", "blob", `${head}:${relativePath}`]);
    const filtered = checkpointContent(relativePath, content);
    return filtered === null ? Buffer.from(content, "utf8") : filtered;
  } catch {
    return undefined;
  }
}

async function filterCommittedCheckpointChanges(
  directory: string,
  changes: CommittedCheckpointChange[],
  beforeHead: string | null,
  afterHead: string | null,
  gitRunner: GitRunner
): Promise<CommittedCheckpointChange[]> {
  const included = await Promise.all(changes.map(async change => {
    const beforePath = change.sourcePath || change.path;
    if (!isFilteredCheckpointPath(beforePath) && !isFilteredCheckpointPath(change.path)) return change;
    const [before, after] = await Promise.all([
      checkpointCommitContent(directory, beforeHead, beforePath, gitRunner),
      checkpointCommitContent(directory, afterHead, change.path, gitRunner)
    ]);
    if (before === undefined && after === undefined) return undefined;
    if (before && after && before.equals(after)) return undefined;
    return change;
  }));
  return included.filter((change): change is CommittedCheckpointChange => Boolean(change));
}

async function checkpointIndexEntries(
  directory: string,
  relativePath: string,
  entries: RawIndexEntry[] | undefined,
  gitRunner: GitRunner
): Promise<CheckpointIndexEntry[] | undefined> {
  if (!entries) return undefined;
  if (!isFilteredCheckpointPath(relativePath)) return entries;
  return Promise.all(entries.map(async entry => {
    const content = await gitRunner(directory, ["cat-file", "blob", entry.objectId]);
    const filtered = checkpointContent(relativePath, content);
    return {
      mode: entry.mode,
      stage: entry.stage,
      type: filtered === undefined ? "ignored" : "file",
      ...(filtered === undefined ? {} : { contentHash: sha256Bytes(filtered ?? Buffer.from(content, "utf8")) })
    };
  }));
}

async function worktreeRecords(
  directory: string,
  porcelain: string,
  indexOutput: string,
  overlay: Map<string, string>,
  binaryPaths: Set<string>,
  gitRunner: GitRunner
): Promise<CheckpointEntry[]> {
  const stagedIndex = indexRecords(indexOutput);
  const fields = porcelain.split("\0");
  const records: CheckpointEntry[] = [];
  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    const field = fields[cursor];
    if (!field) continue;
    const status = field.slice(0, 2);
    const relativePath = field.slice(3);
    let sourcePath;
    if (status.includes("R") || status.includes("C")) sourcePath = fields[++cursor] || undefined;
    if (isIgnoredCheckpointPath(relativePath) && (!sourcePath || isIgnoredCheckpointPath(sourcePath))) continue;

    const inspected: CheckpointPathRecord = isIgnoredCheckpointPath(relativePath)
      ? { type: "ignored" }
      : await checkpointPath(directory, relativePath, gitRunner);
    const index = await checkpointIndexEntries(directory, relativePath, stagedIndex.get(relativePath), gitRunner);
    let normalizedStatus = status;
    if (isFilteredCheckpointPath(relativePath)) {
      if (inspected.type === "ignored" && (!index || index.every(entry => entry.type === "ignored"))) continue;
      const onlyIndexEntry = index?.[0];
      const stageZero = index?.length === 1 && onlyIndexEntry?.stage === 0 ? onlyIndexEntry : undefined;
      if (status !== "??" && stageZero) {
        const worktreeMatchesIndex = checkpointSignature(inspected) === checkpointSignature(stageZero);
        normalizedStatus = `${status[0]}${worktreeMatchesIndex ? " " : status[1] === " " ? "M" : status[1]}`;
        if (normalizedStatus === "  ") continue;
      }
    }
    records.push({
      status: normalizedStatus,
      path: relativePath,
      ...(sourcePath ? { sourcePath } : {}),
      type: inspected.type,
      ...(inspected.contentHash ? { contentHash: inspected.contentHash } : {}),
      ...(inspected.gitHead ? { gitHead: inspected.gitHead } : {}),
      ...(inspected.worktreeFingerprint ? { worktreeFingerprint: inspected.worktreeFingerprint } : {}),
      ...(inspected.binary || binaryPaths.has(relativePath) ? { binary: true } : {}),
      ...(index ? { index } : {})
    });
  }
  const recordedPaths = new Set(records.map(record => record.path));
  for (const [relativePath, content] of overlay) {
    if (isIgnoredCheckpointPath(relativePath) || recordedPaths.has(relativePath)) continue;
    if (await pathType(path.resolve(directory, relativePath)) !== "missing") continue;
    const filtered = checkpointContent(relativePath, content);
    if (filtered === undefined) continue;
    records.push({
      status: "??",
      path: relativePath,
      type: "file",
      contentHash: sha256Bytes(filtered === null ? Buffer.from(content, "utf8") : filtered)
    });
  }
  return records.sort((left, right) => compareCheckpointPaths(
    `${left.path}\0${left.sourcePath || ""}`,
    `${right.path}\0${right.sourcePath || ""}`
  ));
}

export async function captureGitCheckpointSnapshot(directory: string, {
  clock,
  gitRunner = defaultGitRunner,
  checkpointOverlay = new Map()
}: OrchestrationDependencies = {}): Promise<{ checkpoint: GitCheckpoint; snapshot: CheckpointSnapshot }> {
  const capturedAt = nowIso(clock);
  const inside = await optionalGit(gitRunner, directory, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    const snapshot = validateCheckpointSnapshot(createCheckpointSnapshot({
      capturedAt,
      available: false,
      branch: null,
      head: null,
      worktreeFingerprint: sha256("[]"),
      entries: []
    }));
    return {
      checkpoint: {
        capturedAt,
        available: false,
        branch: null,
        head: null,
        worktree: {
          clean: true,
          entries: 0,
          fingerprint: snapshot.worktreeFingerprint,
          snapshot: { path: CHECKPOINT_SNAPSHOT_PATH, contentHash: snapshot.contentHash }
        }
      },
      snapshot
    };
  }

  const [head, branch, porcelain, index, stagedNumstat, unstagedNumstat] = await Promise.all([
    optionalGit(gitRunner, directory, ["rev-parse", "HEAD"]),
    optionalGit(gitRunner, directory, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitRunner(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    gitRunner(directory, ["ls-files", "--stage", "-z", "--", "."]),
    gitRunner(directory, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--cached", "--", "."]),
    gitRunner(directory, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", "."])
  ]);
  const binaryPaths = new Set([
    ...binaryPathsFromNumstat(stagedNumstat),
    ...binaryPathsFromNumstat(unstagedNumstat)
  ]);
  const records = await worktreeRecords(directory, porcelain, index, checkpointOverlay, binaryPaths, gitRunner);
  const fingerprint = sha256(stableStringify(records));
  const snapshot = validateCheckpointSnapshot(createCheckpointSnapshot({
    capturedAt,
    available: true,
    branch,
    head,
    worktreeFingerprint: fingerprint,
    entries: records
  }));
  return {
    checkpoint: {
      capturedAt,
      available: true,
      branch,
      head,
      worktree: {
        clean: records.length === 0,
        entries: records.length,
        fingerprint,
        snapshot: { path: CHECKPOINT_SNAPSHOT_PATH, contentHash: snapshot.contentHash }
      }
    },
    snapshot
  };
}

export async function captureGitCheckpoint(
  directory: string,
  dependencies: OrchestrationDependencies = {}
): Promise<GitCheckpoint> {
  return (await captureGitCheckpointSnapshot(directory, dependencies)).checkpoint;
}

export function checkpointDrift(expected: GitCheckpoint, actual: GitCheckpoint): CheckpointDrift {
  const reasons: CheckpointDriftReason[] = [];
  if (expected.available !== actual.available) {
    reasons.push({ field: "git.available", expected: expected.available, actual: actual.available });
  }
  if (expected.branch !== actual.branch) {
    reasons.push({ field: "git.branch", expected: expected.branch, actual: actual.branch });
  }
  if (expected.head !== actual.head) {
    reasons.push({ field: "git.head", expected: expected.head, actual: actual.head });
  }
  if (expected.worktree.fingerprint !== actual.worktree.fingerprint) {
    reasons.push({
      field: "git.worktree",
      expected: expected.worktree.fingerprint,
      actual: actual.worktree.fingerprint,
      expectedEntries: expected.worktree.entries,
      actualEntries: actual.worktree.entries
    });
  }
  return { detected: reasons.length > 0, reasons };
}

function eventHash(event: object): string {
  const unsigned = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
  return sha256(stableStringify(unsigned));
}

function buildEvent(
  previousState: OrchestrationState | undefined,
  nextCore: OrchestrationStateCore,
  type: string,
  metadata: EventMetadata
): { event: OrchestrationEvent; state: OrchestrationState } {
  const sequence = (previousState?.lastEvent.sequence || 0) + 1;
  const unsignedEvent: Omit<OrchestrationEvent, "eventHash"> = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence,
    id: randomUUID(),
    timestamp: nextCore.updatedAt,
    type,
    actor: metadata.actor,
    ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
    ...(metadata.fromState ? { fromState: metadata.fromState } : {}),
    ...(metadata.toState ? { toState: metadata.toState } : {}),
    ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}),
    checkpoint: metadata.checkpoint || nextCore.checkpoint,
    payload: metadata.payload || {},
    previousHash: previousState?.lastEvent.hash || null,
    state: nextCore
  };
  const event: OrchestrationEvent = {
    ...unsignedEvent,
    eventHash: eventHash(unsignedEvent)
  };
  const state: OrchestrationState = {
    ...nextCore,
    lastEvent: { sequence, id: event.id, hash: event.eventHash }
  };
  return { event, state };
}

function initialState(
  checkpoint: GitCheckpoint,
  timestamp: string,
  leaseBaselines: LeaseBaselineReference
): OrchestrationStateCore {
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoint,
    leaseBaselines,
    taskOrder: [],
    tasks: {},
    evidenceCounter: 0
  };
}

function taskList(state: OrchestrationState | OrchestrationStateCore): OrchestrationTask[] {
  return state.taskOrder.map(id => {
    const task = state.tasks[id];
    if (!task) invalidState(`Task ${id} is missing from the canonical task map.`, { taskId: id });
    return task;
  });
}

function markdownCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ");
}

function checkpointLabel(checkpoint: GitCheckpoint): string {
  if (!checkpoint.available) return "Git unavailable";
  return `${checkpoint.branch || "detached"} @ ${checkpoint.head || "unborn"}; ${checkpoint.worktree.clean ? "clean" : `${checkpoint.worktree.entries} changed path(s)`}`;
}

export function renderStatusMarkdown(
  state: OrchestrationState,
  drift: CheckpointDrift = { detected: false, reasons: [] }
): string {
  const synodCommand = `pnpm dlx ${packageName}@${packageVersion}`;
  const lines = [
    "# Synod Status",
    "",
    "> Generated from `.synod/state.json`. Do not edit this file directly.",
    "",
    `Updated: ${state.updatedAt}`,
    `Last event: ${state.lastEvent.sequence} (${state.lastEvent.hash})`,
    `Checkpoint: ${checkpointLabel(state.checkpoint)}`,
    `Live drift: ${drift.detected ? "DETECTED" : `run ${synodCommand} status to compare the recorded checkpoint with the current worktree`}`,
    "",
    "## Tasks",
    "",
    "| ID | State | Revision | Executor | Correction round | Acceptance | Verification | Objective |",
    "|---|---|---:|---|---:|---|---|---|"
  ];
  for (const task of taskList(state)) {
    lines.push(`| ${markdownCell(task.id)} | ${task.state} | ${task.revision} | ${markdownCell(task.executor)} | ${task.correctionRound} | ${task.acceptance.status}${task.acceptance.revision === null ? "" : ` @ r${task.acceptance.revision}`} | ${task.verification.status}${task.verification.revision === null ? "" : ` @ r${task.verification.revision}`} | ${markdownCell(task.objective)} |`);
  }
  if (state.taskOrder.length === 0) lines.push("| — | — | — | — | — | — | — | No tasks recorded. |");

  lines.push("", "## Task contracts", "");
  if (state.taskOrder.length === 0) {
    lines.push("No task contracts recorded.");
  } else {
    for (const task of taskList(state)) {
      lines.push(
        `### ${markdownCell(task.id)} — ${markdownCell(task.objective)}`,
        "",
        `- Executor: ${markdownCell(task.executor)}`,
        `- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.map(markdownCell).join(", ") : "—"}`,
        `- Revision: ${task.revision}`,
        `- Correction round: ${task.correctionRound}`,
        `- Correction policy: ${task.correctionPolicy.used}/${task.correctionPolicy.limit} used; ${task.correctionPolicy.overrides.length} override(s)`,
        `- Writer lease: ${task.lease ? `${task.lease.id} generation ${task.lease.generation}; owner ${markdownCell(task.lease.ownerThread)}; expires ${task.lease.expiresAt}` : task.preLease ? "migration required before further progress" : "—"}`,
        `- Sealed proposal: ${task.proposal ? `${task.proposal.bundleId}; lease ${task.proposal.leaseId} generation ${task.proposal.generation}; revision ${task.proposal.revision}; ${task.proposal.path}` : "—"}`,
        `- Proposal-owned paths: ${task.proposal && task.proposal.ownedPaths.length > 0 ? task.proposal.ownedPaths.map(markdownCell).join(", ") : "—"}`,
        `- Excluded foreign paths: ${task.proposal && task.proposal.excludedForeignPaths.length > 0 ? task.proposal.excludedForeignPaths.map(markdownCell).join(", ") : "—"}`,
        `- Abandoned-owner recovery: ${task.recovery ? `${task.recovery.status}; prior owner ${markdownCell(task.recovery.endedLease.ownerThread)} generation ${task.recovery.endedLease.generation}; proposal ${task.recovery.proposal?.bundleId || "not sealed"}; decisions ${task.recovery.status === "PENDING" ? "resume, reassign, supersede" : task.recovery.decision?.action}; prior recoveries ${task.recoveryHistory?.length || 0}` : "—"}`,
        `- Split: ${task.split ? `${task.split.replacements.map(markdownCell).join(", ")}; ${markdownCell(task.split.reason)}` : task.splitFrom ? `replacement for ${markdownCell(task.splitFrom)}` : "—"}`,
        "- Acceptance criteria:"
      );
      for (const criterion of task.acceptance.criteria) lines.push(`  - ${markdownCell(criterion)}`);
      lines.push("- Verification commands:");
      for (const command of task.verification.commands) lines.push(`  - ${markdownCell(command)}`);
      lines.push("");
    }
  }

  lines.push("", "## Evidence", "");
  const evidence = taskList(state).flatMap(task => task.evidence.map(item => ({ taskId: task.id, ...item })));
  if (evidence.length === 0) {
    lines.push("No evidence recorded.");
  } else {
    lines.push("| ID | Task | Kind | Revision | Git HEAD | Worktree | Reference |", "|---|---|---|---:|---|---|---|");
    for (const item of evidence) {
      lines.push(`| ${item.id} | ${item.taskId} | ${item.kind} | ${item.revision} | ${markdownCell(item.checkpoint.head)} | ${item.checkpoint.worktreeFingerprint} | ${markdownCell(item.reference)} |`);
    }
  }
  if (drift.detected) {
    lines.push("", "## Detected drift", "");
    for (const reason of drift.reasons) lines.push(`- ${reason.field}: expected \`${reason.expected}\`, actual \`${reason.actual}\`.`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function createInitialOrchestrationFiles(
  targetDirectory: string,
  dependencies: OrchestrationDependencies = {}
): Promise<Map<string, string>> {
  const timestamp = nowIso(dependencies.clock);
  const { checkpoint, snapshot } = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
  const leaseBaselines = createLeaseBaselinesLedger();
  const core = initialState(checkpoint, timestamp, leaseBaselinesReference(leaseBaselines));
  const { event, state } = buildEvent(undefined, core, "project.initialized", {
    actor: "synod",
    payload: { templateVersion: packageVersion }
  });
  return new Map([
    [ORCHESTRATION_STATE_PATH, serializeJson(state)],
    [ORCHESTRATION_EVENTS_PATH, `${JSON.stringify(event)}\n`],
    [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(state)],
    [CHECKPOINT_SNAPSHOT_PATH, serializeCheckpointSnapshot(snapshot)],
    [LEASE_BASELINES_PATH, serializeLeaseBaselinesLedger(leaseBaselines)]
  ]);
}

export type OrchestrationSchemaMigration =
  | { status: "current" }
  | { status: "migrated"; files: Map<string, string> };

export async function createOrchestrationSchemaMigrationFiles(
  targetDirectory: string,
  dependencies: OrchestrationDependencies = {}
): Promise<OrchestrationSchemaMigration> {
  let rawState: unknown;
  try {
    rawState = parseJson(await readRecord(targetDirectory, ORCHESTRATION_STATE_PATH));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, `Could not parse ${ORCHESTRATION_STATE_PATH}: ${errorMessage(error)}`, { cause: error });
  }
  if (isRecord(rawState) && rawState.schemaVersion === ORCHESTRATION_SCHEMA_VERSION) {
    validateOrchestrationState(rawState);
    return { status: "current" };
  }
  if (!isLegacyOrchestrationStateShape(rawState)) {
    invalidState("Legacy Synod state is not a valid schema-1 orchestration record.");
  }

  const rawEvents = await readRecord(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  let parsedEvents: unknown[];
  try {
    parsedEvents = rawEvents.split(/\r?\n/).filter(Boolean).map(line => parseJson(line));
  } catch (error) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, `Could not parse ${ORCHESTRATION_EVENTS_PATH}: ${errorMessage(error)}`, { cause: error });
  }
  const events = validateEventLog(parsedEvents);
  const last = events.at(-1);
  const rawLast = parsedEvents.at(-1);
  if (!last || !isLegacyOrchestrationEvent(rawLast)) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Schema-1 migration requires a legacy-only event log.");
  }
  const expectedLegacyState: LegacyOrchestrationState = {
    ...rawLast.state,
    lastEvent: { sequence: rawLast.sequence, id: rawLast.id, hash: rawLast.eventHash }
  };
  if (stableStringify(rawState) !== stableStringify(expectedLegacyState)) {
    throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Legacy canonical state does not match its last append-only event.", {
      details: { stateSequence: rawState.lastEvent.sequence, eventSequence: rawLast.sequence }
    });
  }

  const leaseBaselines = createLeaseBaselinesLedger();
  const checkpointSnapshot = await readCheckpointSnapshot(targetDirectory, rawState.checkpoint);
  const timestamp = nowIso(dependencies.clock);
  const nextCore = migrateLegacyStateCore(rawState, leaseBaselinesReference(leaseBaselines), timestamp);
  const unsignedEvent: Omit<OrchestrationEvent, "eventHash"> = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence: last.sequence + 1,
    id: randomUUID(),
    timestamp,
    type: "orchestration.migrated",
    actor: "synod",
    checkpoint: nextCore.checkpoint,
    payload: {
      fromSchemaVersion: LEGACY_ORCHESTRATION_SCHEMA_VERSION,
      toSchemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      preservedEventCount: events.length,
      preLeaseTasks: nextCore.taskOrder.filter(id => nextCore.tasks[id]?.preLease)
    },
    previousHash: last.eventHash,
    state: nextCore
  };
  const event: OrchestrationEvent = { ...unsignedEvent, eventHash: eventHash(unsignedEvent) };
  const state = validateOrchestrationState({
    ...nextCore,
    lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
  });
  validateEventLog([...parsedEvents, event]);
  const separator = rawEvents.endsWith("\n") ? "" : "\n";
  return {
    status: "migrated",
    files: new Map([
      [ORCHESTRATION_STATE_PATH, serializeJson(state)],
      [ORCHESTRATION_EVENTS_PATH, `${rawEvents}${separator}${JSON.stringify(event)}\n`],
      [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(state)],
      [LEASE_BASELINES_PATH, serializeLeaseBaselinesLedger(leaseBaselines)],
      ...(checkpointSnapshot ? [[CHECKPOINT_SNAPSHOT_PATH, serializeCheckpointSnapshot(checkpointSnapshot)] as const] : [])
    ])
  };
}

export type CheckpointSnapshotAdoption =
  | { status: "current" }
  | { status: "unavailable" }
  | { status: "adopted"; files: Map<string, string> };

export async function createCheckpointSnapshotAdoptionFiles(
  targetDirectory: string,
  dependencies: OrchestrationDependencies = {}
): Promise<CheckpointSnapshotAdoption> {
  const { state } = await validateCanonicalOrchestrationReadOnly(targetDirectory);
  if (state.checkpoint.worktree.snapshot) return { status: "current" };
  const captured = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
  if (checkpointDrift(state.checkpoint, captured.checkpoint).detected) return { status: "unavailable" };
  const nextCore: OrchestrationStateCore = {
    ...stateCore(state),
    updatedAt: captured.checkpoint.capturedAt,
    checkpoint: captured.checkpoint
  };
  const { event, state: nextState } = buildEvent(state, nextCore, "checkpoint.snapshot-adopted", {
    actor: "synod",
    checkpoint: captured.checkpoint,
    payload: { source: "legacy-checkpoint" }
  });
  const existingEvents = await readRecord(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  return {
    status: "adopted",
    files: new Map([
      [ORCHESTRATION_STATE_PATH, serializeJson(nextState)],
      [ORCHESTRATION_EVENTS_PATH, `${existingEvents}${existingEvents.endsWith("\n") ? "" : "\n"}${JSON.stringify(event)}\n`],
      [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(nextState)],
      [CHECKPOINT_SNAPSHOT_PATH, serializeCheckpointSnapshot(captured.snapshot)]
    ])
  };
}

export async function createOrchestrationStatusProjectionFile(targetDirectory: string): Promise<string> {
  const { state } = await validateCanonicalOrchestrationReadOnly(targetDirectory);
  return renderStatusMarkdown(state);
}

function invalidState(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, message, { details });
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && TASK_STATES.some(state => state === value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isCheckpointSnapshotReference(value: unknown): value is CheckpointSnapshotReference {
  return isRecord(value)
    && value.path === CHECKPOINT_SNAPSHOT_PATH
    && typeof value.contentHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(value.contentHash);
}

function isGitCheckpoint(value: unknown): value is GitCheckpoint {
  return isRecord(value)
    && typeof value.capturedAt === "string"
    && typeof value.available === "boolean"
    && isNullableString(value.branch)
    && isNullableString(value.head)
    && isRecord(value.worktree)
    && typeof value.worktree.clean === "boolean"
    && isNonNegativeInteger(value.worktree.entries)
    && typeof value.worktree.fingerprint === "string"
    && (value.worktree.snapshot === undefined || isCheckpointSnapshotReference(value.worktree.snapshot));
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === "delivery" || value === "correction" || value === "acceptance" || value === "verification";
}

function isTaskEvidence(value: unknown): value is TaskEvidence {
  return isRecord(value)
    && typeof value.id === "string"
    && isEvidenceKind(value.kind)
    && isNonNegativeInteger(value.revision)
    && typeof value.reference === "string"
    && value.reference.length > 0
    && typeof value.actor === "string"
    && typeof value.recordedAt === "string"
    && isRecord(value.checkpoint)
    && isNullableString(value.checkpoint.branch)
    && isNullableString(value.checkpoint.head)
    && typeof value.checkpoint.worktreeFingerprint === "string";
}

function isTaskRecovery(value: unknown): value is TaskRecoveryRecord {
  if (!isRecord(value) || !isEndedTaskLease(value.endedLease)) return false;
  const detectedAt = typeof value.detectedAt === "string" ? Date.parse(value.detectedAt) : Number.NaN;
  const validDecision = value.decision === undefined || (isRecord(value.decision)
    && ["resume", "reassign", "supersede"].includes(String(value.decision.action))
    && typeof value.decision.actor === "string"
    && value.decision.actor.length > 0
    && typeof value.decision.recordedAt === "string"
    && Number.isFinite(Date.parse(value.decision.recordedAt))
    && typeof value.decision.priorOwnerThread === "string"
    && value.decision.priorOwnerThread.length > 0
    && isNonNegativeInteger(value.decision.priorGeneration)
    && value.decision.priorGeneration > 0
    && (value.decision.newOwnerThread === undefined || (typeof value.decision.newOwnerThread === "string" && value.decision.newOwnerThread.length > 0))
    && (value.decision.newGeneration === undefined || isNonNegativeInteger(value.decision.newGeneration))
    && typeof value.decision.reason === "string"
    && value.decision.reason.length > 0);
  return ["PENDING", "RESUMED", "REASSIGNED", "SUPERSEDED"].includes(String(value.status))
    && typeof value.detectedAt === "string"
    && Number.isFinite(detectedAt)
    && detectedAt >= Date.parse(value.endedLease.heartbeatAt)
    && ["EXPIRED", "REVOKED"].includes(value.endedLease.status)
    && typeof value.reason === "string"
    && value.reason.length > 0
    && (value.proposal === undefined || isTaskProposalReference(value.proposal))
    && validDecision;
}

function isTaskSplit(value: unknown): value is NonNullable<OrchestrationTask["split"]> {
  return isRecord(value)
    && isStringArray(value.replacements)
    && value.replacements.length >= 2
    && new Set(value.replacements).size === value.replacements.length
    && typeof value.actor === "string"
    && typeof value.reason === "string"
    && isStringArray(value.evidence)
    && value.evidence.length > 0
    && typeof value.recordedAt === "string";
}

function isOrchestrationTask(value: unknown): value is OrchestrationTask {
  if (!isRecord(value) || !isRecord(value.acceptance) || !isRecord(value.verification)) return false;
  return typeof value.id === "string"
    && typeof value.objective === "string"
    && value.objective.length > 0
    && isStringArray(value.dependsOn)
    && isTaskState(value.state)
    && isNonNegativeInteger(value.revision)
    && typeof value.executor === "string"
    && value.executor.length > 0
    && isNonNegativeInteger(value.correctionRound)
    && isCorrectionPolicy(value.correctionPolicy)
    && value.correctionPolicy.used === value.correctionRound
    && isNonNegativeInteger(value.leaseGeneration)
    && (value.lease === undefined || isTaskLease(value.lease))
    && (value.proposal === undefined || isTaskProposalReference(value.proposal))
    && (value.recovery === undefined || isTaskRecovery(value.recovery))
    && (value.recoveryHistory === undefined || (Array.isArray(value.recoveryHistory)
      && value.recoveryHistory.every(item => isTaskRecovery(item) && item.status !== "PENDING")))
    && (value.split === undefined || isTaskSplit(value.split))
    && (value.splitFrom === undefined || typeof value.splitFrom === "string")
    && isStringArray(value.acceptance.criteria)
    && value.acceptance.criteria.length > 0
    && value.acceptance.criteria.every(item => item.length > 0)
    && (value.acceptance.status === "pending" || value.acceptance.status === "accepted")
    && (value.acceptance.revision === null || isNonNegativeInteger(value.acceptance.revision))
    && isStringArray(value.acceptance.evidenceIds)
    && isStringArray(value.verification.commands)
    && value.verification.commands.length > 0
    && value.verification.commands.every(item => item.length > 0)
    && (value.verification.status === "pending" || value.verification.status === "passed")
    && (value.verification.revision === null || isNonNegativeInteger(value.verification.revision))
    && isStringArray(value.verification.evidenceIds)
    && Array.isArray(value.evidence)
    && value.evidence.every(isTaskEvidence)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && (value.blocker === undefined || typeof value.blocker === "string")
    && (value.blockedFrom === undefined || isTaskState(value.blockedFrom))
    && (value.supersededReason === undefined || typeof value.supersededReason === "string")
    && (value.preLease === undefined || value.preLease === true);
}

function isLegacyOrchestrationTask(value: unknown): value is LegacyOrchestrationTask {
  if (!isRecord(value) || !isNonNegativeInteger(value.correctionRound)) return false;
  return value.correctionPolicy === undefined
    && value.leaseGeneration === undefined
    && value.lease === undefined
    && value.proposal === undefined
    && value.recovery === undefined
    && value.recoveryHistory === undefined
    && value.split === undefined
    && value.splitFrom === undefined
    && value.preLease === undefined
    && isOrchestrationTask({
      ...value,
      correctionPolicy: correctionPolicyForRound(value.correctionRound),
      leaseGeneration: 0
    });
}

function isLegacyOrchestrationStateCoreShape(value: unknown): value is LegacyOrchestrationStateCore {
  return isRecord(value)
    && value.schemaVersion === LEGACY_ORCHESTRATION_SCHEMA_VERSION
    && typeof value.templateVersion === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isGitCheckpoint(value.checkpoint)
    && isStringArray(value.taskOrder)
    && isRecord(value.tasks)
    && new Set(value.taskOrder).size === value.taskOrder.length
    && Object.keys(value.tasks).length === value.taskOrder.length
    && value.taskOrder.every(id => Object.hasOwn(value.tasks as object, id))
    && Object.values(value.tasks).every(isLegacyOrchestrationTask)
    && isNonNegativeInteger(value.evidenceCounter);
}

function isLegacyOrchestrationStateShape(value: unknown): value is LegacyOrchestrationState {
  return isLegacyOrchestrationStateCoreShape(value)
    && isRecord(value)
    && isRecord(value.lastEvent)
    && isNonNegativeInteger(value.lastEvent.sequence)
    && typeof value.lastEvent.id === "string"
    && typeof value.lastEvent.hash === "string";
}

function leaseMigrationState(state: TaskState | undefined): boolean {
  return state !== undefined && ["ACTIVE", "REVIEW", "ACCEPTED", "VERIFIED"].includes(state);
}

function legacyTaskRequiresLeaseMigration(task: LegacyOrchestrationTask): boolean {
  return leaseMigrationState(task.state)
    || (task.state === "BLOCKED" && leaseMigrationState(task.blockedFrom));
}

function correctionPolicyForRound(correctionRound: number): CorrectionPolicy {
  return { limit: Math.max(2, correctionRound), used: correctionRound, overrides: [] };
}

function migrateLegacyTask(task: LegacyOrchestrationTask): OrchestrationTask {
  return {
    ...task,
    correctionPolicy: correctionPolicyForRound(task.correctionRound),
    leaseGeneration: 0,
    ...(legacyTaskRequiresLeaseMigration(task) ? { preLease: true as const } : {})
  };
}

function migrateLegacyStateCore(
  state: LegacyOrchestrationStateCore,
  leaseBaselines: LeaseBaselineReference,
  timestamp = state.updatedAt
): OrchestrationStateCore {
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    createdAt: state.createdAt,
    updatedAt: timestamp,
    checkpoint: state.checkpoint,
    leaseBaselines,
    taskOrder: [...state.taskOrder],
    tasks: Object.fromEntries(state.taskOrder.map(id => [id, migrateLegacyTask(state.tasks[id]!)])),
    evidenceCounter: state.evidenceCounter
  };
}

function isOrchestrationStateCoreShape(value: unknown): value is OrchestrationStateCore {
  return isRecord(value)
    && value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION
    && typeof value.templateVersion === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isGitCheckpoint(value.checkpoint)
    && isLeaseBaselineReference(value.leaseBaselines)
    && isStringArray(value.taskOrder)
    && isRecord(value.tasks)
    && Object.values(value.tasks).every(isOrchestrationTask)
    && isNonNegativeInteger(value.evidenceCounter);
}

function isOrchestrationStateShape(value: unknown): value is OrchestrationState {
  return isOrchestrationStateCoreShape(value)
    && isRecord(value)
    && isRecord(value.lastEvent)
    && isNonNegativeInteger(value.lastEvent.sequence)
    && typeof value.lastEvent.id === "string"
    && typeof value.lastEvent.hash === "string";
}

function validateEvidence(item: TaskEvidence, task: OrchestrationTask): void {
  if (item.revision > task.revision) {
    invalidState(`Task ${task.id} contains invalid evidence.`, { taskId: task.id, evidenceId: item.id });
  }
}

export function validateOrchestrationState(value: unknown): OrchestrationState {
  if (!isRecord(value)) invalidState("Synod state must be a JSON object.");
  if (value.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
    invalidState(`Unsupported orchestration state schema: ${value.schemaVersion}`, { supported: ORCHESTRATION_SCHEMA_VERSION });
  }
  if (!isOrchestrationStateShape(value)) invalidState("Synod state is missing required canonical fields.");
  const state = value;

  if (new Set(state.taskOrder).size !== state.taskOrder.length || Object.keys(state.tasks).length !== state.taskOrder.length) {
    invalidState("Task order and task map do not describe the same unique tasks.");
  }
  const allEvidenceIds = new Set<string>();
  let maximumEvidenceCounter = 0;
  for (const id of state.taskOrder) {
    const task = state.tasks[id];
    if (!task || task.id !== id || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(id)) {
      invalidState(`Task ${id} is invalid.`, { taskId: id });
    }
    if (task.state === "BLOCKED" && !isTaskState(task.blockedFrom)) {
      invalidState(`Blocked task ${id} is missing its prior state.`, { taskId: id });
    }
    if (task.lease && (
      task.lease.generation !== task.leaseGeneration
      || task.lease.taskId !== task.id
      || task.lease.taskRevision !== task.revision
      || task.lease.executor !== task.executor
    )) {
      invalidState(`Task ${id} lease does not match its canonical task generation, revision, or executor.`, { taskId: id });
    }
    if (task.proposal && (
      task.proposal.revision !== task.revision
      || task.proposal.baseRevision + 1 !== task.revision
      || task.proposal.path !== `.synod/proposals/${task.proposal.leaseId}/${task.proposal.generation}`
    )) {
      invalidState(`Task ${id} proposal does not match its canonical revision or lease identity.`, { taskId: id });
    }
    if (task.proposal && ["PLANNED", "READY", "ACTIVE"].includes(task.state)) {
      invalidState(`Task ${id} cannot retain a sealed proposal while it is ${task.state}.`, { taskId: id, state: task.state });
    }
    if (task.recovery) {
      if (task.recovery.endedLease.taskId !== task.id || task.recovery.endedLease.taskRevision > task.revision) {
        invalidState(`Task ${id} recovery lease does not match its task revision.`, { taskId: id });
      }
      if (task.recovery.proposal && (
        task.recovery.proposal.leaseId !== task.recovery.endedLease.id
        || task.recovery.proposal.generation !== task.recovery.endedLease.generation
        || task.recovery.proposal.baseRevision !== task.recovery.endedLease.taskRevision
      )) invalidState(`Task ${id} recovery proposal does not match its ended lease.`, { taskId: id });
      if (task.recovery.status === "PENDING" && task.recovery.decision) {
        invalidState(`Task ${id} pending recovery cannot contain a decision.`, { taskId: id });
      }
      if (task.recovery.status === "PENDING" && (task.recovery.proposal || task.lease)) {
        invalidState(`Task ${id} pending recovery cannot contain a proposal or active lease.`, { taskId: id });
      }
      if (task.recovery.status !== "PENDING" && (!task.recovery.decision || !task.recovery.proposal)) {
        invalidState(`Task ${id} completed recovery is missing its decision.`, { taskId: id });
      }
      const decision = task.recovery.decision;
      const expectedAction = task.recovery.status === "RESUMED"
        ? "resume"
        : task.recovery.status === "REASSIGNED"
          ? "reassign"
          : task.recovery.status === "SUPERSEDED"
            ? "supersede"
            : undefined;
      if (decision && (
        decision.action !== expectedAction
        || decision.priorOwnerThread !== task.recovery.endedLease.ownerThread
        || decision.priorGeneration !== task.recovery.endedLease.generation
        || Date.parse(decision.recordedAt) < Date.parse(task.recovery.detectedAt)
        || ((decision.action === "resume" || decision.action === "reassign") && (
          !decision.newOwnerThread
          || !decision.newGeneration
          || decision.newGeneration <= decision.priorGeneration
          || (decision.action === "resume" && decision.newOwnerThread !== decision.priorOwnerThread)
          || (decision.action === "reassign" && decision.newOwnerThread === decision.priorOwnerThread)
        ))
        || (decision.action === "supersede" && (decision.newOwnerThread !== undefined || decision.newGeneration !== undefined))
      )) invalidState(`Task ${id} recovery decision does not match its status or ended lease.`, { taskId: id });
      if (task.recovery.status === "SUPERSEDED" && task.state !== "SUPERSEDED") {
        invalidState(`Task ${id} superseded recovery must leave the task superseded.`, { taskId: id, state: task.state });
      }
    }
    const recoveryRecords = [...(task.recoveryHistory || []), ...(task.recovery ? [task.recovery] : [])];
    const recoveryGenerations = recoveryRecords.map(item => item.endedLease.generation);
    if (new Set(recoveryGenerations).size !== recoveryGenerations.length || recoveryGenerations.some((generation, index) =>
      index > 0 && generation <= recoveryGenerations[index - 1]!
    )) invalidState(`Task ${id} recovery history is not strictly generation ordered.`, { taskId: id });
    const maximumRecoveryGeneration = Math.max(0, ...recoveryRecords.flatMap(record => [
      record.endedLease.generation,
      ...(record.decision?.newGeneration ? [record.decision.newGeneration] : [])
    ]));
    if (maximumRecoveryGeneration > task.leaseGeneration) {
      invalidState(`Task ${id} recovery generation exceeds its task-local lease generation.`, { taskId: id });
    }
    for (const record of recoveryRecords) {
      if (record.endedLease.taskId !== task.id || record.endedLease.taskRevision > task.revision
        || (record.proposal && (record.proposal.leaseId !== record.endedLease.id
          || record.proposal.generation !== record.endedLease.generation
          || record.proposal.baseRevision !== record.endedLease.taskRevision))) {
        invalidState(`Task ${id} recovery history contains a mismatched lease or proposal.`, { taskId: id });
      }
    }
    if (task.state === "ACTIVE" && !task.lease && !task.preLease) {
      invalidState(`Active task ${id} is missing its durable writer lease.`, { taskId: id });
    }
    if (task.preLease && !leaseMigrationState(task.state) && !(task.state === "BLOCKED" && leaseMigrationState(task.blockedFrom))) {
      invalidState(`Task ${id} has an invalid pre-lease migration marker.`, { taskId: id, state: task.state });
    }
    if (task.lease && !["READY", "ACTIVE", "REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state) && !(task.state === "BLOCKED" && leaseMigrationState(task.blockedFrom))) {
      invalidState(`Task ${id} holds a writer lease in an ineligible state.`, { taskId: id, state: task.state });
    }
    for (const dependency of task.dependsOn) {
      if (!state.tasks[dependency] || dependency === id) invalidState(`Task ${id} has an invalid dependency.`, { taskId: id, dependency });
    }
    if (task.split) {
      if (task.state !== "SUPERSEDED" || task.split.replacements.some(replacement =>
        !state.tasks[replacement] || state.tasks[replacement]?.splitFrom !== id
      )) invalidState(`Task ${id} split replacement links are invalid.`, { taskId: id });
    }
    if (task.splitFrom && (!state.tasks[task.splitFrom]?.split?.replacements.includes(id))) {
      invalidState(`Task ${id} split origin link is invalid.`, { taskId: id, splitFrom: task.splitFrom });
    }
    for (const item of task.evidence) validateEvidence(item, task);
    const evidenceById = new Map(task.evidence.map(item => [item.id, item]));
    if (evidenceById.size !== task.evidence.length) invalidState(`Task ${id} contains duplicate evidence IDs.`, { taskId: id });
    for (const evidenceId of evidenceById.keys()) {
      if (allEvidenceIds.has(evidenceId) || !/^E-\d{6}$/.test(evidenceId)) {
        invalidState(`Task ${id} contains an invalid or globally duplicate evidence ID.`, { taskId: id, evidenceId });
      }
      allEvidenceIds.add(evidenceId);
      maximumEvidenceCounter = Math.max(maximumEvidenceCounter, Number(evidenceId.slice(2)));
    }
    if (task.acceptance.status === "pending" && (task.acceptance.revision !== null || task.acceptance.evidenceIds.length > 0)) {
      invalidState(`Task ${id} has evidence on pending acceptance.`, { taskId: id });
    }
    if (task.acceptance.status === "accepted" && task.acceptance.revision !== task.revision) {
      invalidState(`Task ${id} acceptance is not tied to its exact revision.`, { taskId: id });
    }
    if (task.acceptance.status === "accepted" && (
      task.acceptance.evidenceIds.length === 0
      || task.acceptance.evidenceIds.some(evidenceId => {
        const item = evidenceById.get(evidenceId);
        return !item || item.kind !== "acceptance" || item.revision !== task.revision;
      })
    )) invalidState(`Task ${id} acceptance evidence is invalid.`, { taskId: id });
    if (task.verification.status === "passed" && task.verification.revision !== task.revision) {
      invalidState(`Task ${id} verification is not tied to its exact revision.`, { taskId: id });
    }
    if (task.verification.status === "pending" && (task.verification.revision !== null || task.verification.evidenceIds.length > 0)) {
      invalidState(`Task ${id} has evidence on pending verification.`, { taskId: id });
    }
    if (task.verification.status === "passed" && (
      task.verification.evidenceIds.length === 0
      || task.verification.evidenceIds.some(evidenceId => {
        const item = evidenceById.get(evidenceId);
        return !item || item.kind !== "verification" || item.revision !== task.revision;
      })
    )) invalidState(`Task ${id} verification evidence is invalid.`, { taskId: id });
    if (["ACCEPTED", "VERIFIED", "DONE"].includes(task.state) && task.acceptance.status !== "accepted") {
      invalidState(`Task ${id} state requires exact-revision acceptance.`, { taskId: id });
    }
    if (["VERIFIED", "DONE"].includes(task.state) && task.verification.status !== "passed") {
      invalidState(`Task ${id} state requires exact-revision verification.`, { taskId: id });
    }
    if (["REVIEW", "ACCEPTED", "VERIFIED", "DONE"].includes(task.state) && !task.evidence.some(item => item.kind === "delivery" && item.revision === task.revision)) {
      invalidState(`Task ${id} state requires delivery evidence for its exact revision.`, { taskId: id });
    }
  }
  if (maximumEvidenceCounter !== state.evidenceCounter) {
    invalidState("Evidence counter does not match canonical evidence IDs.", {
      expected: maximumEvidenceCounter,
      actual: state.evidenceCounter
    });
  }
  return state;
}

function isOrchestrationEvent(value: unknown): value is OrchestrationEvent {
  return isRecord(value)
    && value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION
    && isNonNegativeInteger(value.sequence)
    && typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.type === "string"
    && typeof value.actor === "string"
    && (value.taskId === undefined || typeof value.taskId === "string")
    && (value.fromState === undefined || isTaskState(value.fromState))
    && (value.toState === undefined || isTaskState(value.toState))
    && (value.revision === undefined || isNonNegativeInteger(value.revision))
    && isGitCheckpoint(value.checkpoint)
    && isRecord(value.payload)
    && isNullableString(value.previousHash)
    && isOrchestrationStateCoreShape(value.state)
    && typeof value.eventHash === "string";
}

function isLegacyOrchestrationEvent(value: unknown): value is LegacyOrchestrationEvent {
  return isRecord(value)
    && value.schemaVersion === LEGACY_ORCHESTRATION_SCHEMA_VERSION
    && isNonNegativeInteger(value.sequence)
    && typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.type === "string"
    && typeof value.actor === "string"
    && (value.taskId === undefined || typeof value.taskId === "string")
    && (value.fromState === undefined || isTaskState(value.fromState))
    && (value.toState === undefined || isTaskState(value.toState))
    && (value.revision === undefined || isNonNegativeInteger(value.revision))
    && isGitCheckpoint(value.checkpoint)
    && isRecord(value.payload)
    && isNullableString(value.previousHash)
    && isLegacyOrchestrationStateCoreShape(value.state)
    && typeof value.eventHash === "string";
}

function validateEventLog(events: unknown[]): OrchestrationEvent[] {
  let previousHash = null;
  let legacySeen = false;
  let migrationSeen = false;
  let schemaTwoStarted = false;
  const emptyLeaseBaselines = leaseBaselinesReference(createLeaseBaselinesLedger());
  const validated: OrchestrationEvent[] = [];
  for (const [index, event] of events.entries()) {
    const legacy = isLegacyOrchestrationEvent(event);
    const current = isOrchestrationEvent(event);
    if (
      (!legacy && !current) || event.sequence !== index + 1
      || event.previousHash !== previousHash || event.eventHash !== eventHash(event)
      || (legacy && schemaTwoStarted)
      || (current && legacySeen && !schemaTwoStarted && event.type !== "orchestration.migrated")
      || (current && event.type === "orchestration.migrated" && (!legacySeen || migrationSeen || schemaTwoStarted))
    ) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log failed sequence or hash-chain validation.", {
        details: { sequence: isRecord(event) ? event.sequence : undefined, expectedSequence: index + 1 }
      });
    }
    if (current) {
      if (event.type === "orchestration.migrated") migrationSeen = true;
      schemaTwoStarted = true;
      validateOrchestrationState({
        ...event.state,
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    } else {
      legacySeen = true;
      validateOrchestrationState({
        ...migrateLegacyStateCore(event.state, emptyLeaseBaselines),
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    }
    previousHash = event.eventHash;
    validated.push(event as unknown as OrchestrationEvent);
  }
  if (events.length === 0) throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is empty.");
  return validated;
}

async function readRecordBytes(targetDirectory: string, relativePath: string): Promise<Buffer> {
  const absolutePath = resolveProjectPath(targetDirectory, relativePath);
  const unsafe = await unsafeAncestor(targetDirectory, absolutePath);
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to read orchestration state through unsafe path: ${unsafe}`, {
      details: { path: relativePath, unsafeAncestor: unsafe }
    });
  }
  if (await pathType(absolutePath) !== "file") {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, `Missing Synod orchestration record: ${relativePath}`, {
      details: { path: relativePath }
    });
  }
  return readFile(absolutePath);
}

async function readRecord(targetDirectory: string, relativePath: string): Promise<string> {
  return (await readRecordBytes(targetDirectory, relativePath)).toString("utf8");
}

async function readCheckpointSnapshot(
  targetDirectory: string,
  checkpoint: GitCheckpoint
): Promise<CheckpointSnapshot | undefined> {
  const reference = checkpoint.worktree.snapshot;
  if (!reference) return undefined;
  let snapshot: CheckpointSnapshot;
  try {
    snapshot = validateCheckpointSnapshot(parseJson(await readRecord(targetDirectory, reference.path)));
  } catch (error) {
    if (error instanceof SynodError && error.code !== ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED) throw error;
    throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, `Could not read ${reference.path}: ${errorMessage(error)}`, {
      cause: error,
      details: { path: reference.path }
    });
  }
  if (
    snapshot.contentHash !== reference.contentHash
    || snapshot.available !== checkpoint.available
    || snapshot.branch !== checkpoint.branch
    || snapshot.head !== checkpoint.head
    || snapshot.worktreeFingerprint !== checkpoint.worktree.fingerprint
  ) {
    throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "The checkpoint snapshot does not match canonical state.", {
      details: {
        path: reference.path,
        expectedHash: reference.contentHash,
        actualHash: snapshot.contentHash
      }
    });
  }
  return snapshot;
}

async function readLeaseBaselines(
  targetDirectory: string,
  reference: LeaseBaselineReference,
  state: OrchestrationState
): Promise<LeaseBaselinesLedger> {
  let content: string;
  let ledger: LeaseBaselinesLedger;
  try {
    content = await readRecord(targetDirectory, reference.path);
    ledger = validateLeaseBaselinesLedger(parseJson(content));
  } catch (error) {
    if (error instanceof SynodError && error.code === ERROR_CODES.LEASE_BASELINE_INVALID) throw error;
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Could not read ${reference.path}: ${errorMessage(error)}`, {
      cause: error,
      details: { path: reference.path }
    });
  }
  if (contentHash(content) !== reference.contentHash) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline ledger does not match canonical state.", {
      details: { path: reference.path, expectedHash: reference.contentHash, actualHash: contentHash(content) }
    });
  }
  const byIdentity = new Map(ledger.baselines.map(item => [`${item.leaseId}:${item.generation}`, item]));
  for (const task of taskList(state)) {
    const identities = [
      ...(task.lease ? [{
        id: task.lease.id,
        generation: task.lease.generation,
        taskRevision: task.revision,
        reference: task.lease.baseline
      }] : []),
      ...(proposalReservesPaths(task) && task.proposal ? [{
        id: task.proposal.leaseId,
        generation: task.proposal.generation,
        taskRevision: task.proposal.baseRevision,
        reference: undefined
      }] : []),
      ...(task.recovery?.status === "PENDING" ? [{
        id: task.recovery.endedLease.id,
        generation: task.recovery.endedLease.generation,
        taskRevision: task.recovery.endedLease.taskRevision,
        reference: task.recovery.endedLease.baseline
      }] : [])
    ];
    for (const identity of identities) {
      const baseline = byIdentity.get(`${identity.id}:${identity.generation}`);
      if (!baseline || baseline.taskId !== task.id || baseline.taskRevision !== identity.taskRevision) {
        throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Task ${task.id} lease baseline is missing or mismatched.`, {
          details: { taskId: task.id, leaseId: identity.id, generation: identity.generation }
        });
      }
      if (!identity.reference) continue;
      if (
        identity.reference.snapshotContentHash !== baseline.snapshot.contentHash
        || identity.reference.branch !== baseline.snapshot.branch
        || identity.reference.head !== baseline.snapshot.head
        || identity.reference.worktreeFingerprint !== baseline.snapshot.worktreeFingerprint
      ) {
        throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Task ${task.id} lease baseline identity is mismatched.`, {
          details: { taskId: task.id, leaseId: identity.id, generation: identity.generation }
        });
      }
    }
  }
  return ledger;
}

async function readOrchestrationRaw(
  targetDirectory: string
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[]; leaseBaselines: LeaseBaselinesLedger; snapshot?: CheckpointSnapshot }> {
  let state: OrchestrationState;
  try {
    state = validateOrchestrationState(parseJson(await readRecord(targetDirectory, ORCHESTRATION_STATE_PATH)));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, `Could not parse ${ORCHESTRATION_STATE_PATH}: ${errorMessage(error)}`, { cause: error });
  }

  const rawEvents = await readRecord(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  const lines = rawEvents.split(/\r?\n/).filter(Boolean);
  let events: OrchestrationEvent[];
  try {
    events = validateEventLog(lines.map(line => parseJson(line)));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, `Could not parse ${ORCHESTRATION_EVENTS_PATH}: ${errorMessage(error)}`, { cause: error });
  }
  const last = events.at(-1);
  if (!last) throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is empty.");
  const expectedState = {
    ...last.state,
    lastEvent: { sequence: last.sequence, id: last.id, hash: last.eventHash }
  };
  if (stableStringify(state) !== stableStringify(expectedState)) {
    throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Canonical state does not match the last append-only event.", {
      details: { stateSequence: state.lastEvent.sequence, eventSequence: last.sequence }
    });
  }
  const snapshot = await readCheckpointSnapshot(targetDirectory, state.checkpoint);
  const leaseBaselines = await readLeaseBaselines(targetDirectory, state.leaseBaselines, state);
  return { state, events, leaseBaselines, ...(snapshot ? { snapshot } : {}) };
}

export async function readOrchestration(
  targetDirectory: string
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[]; leaseBaselines: LeaseBaselinesLedger; snapshot?: CheckpointSnapshot }> {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    return await readOrchestrationRaw(targetDirectory);
  } finally {
    await release();
  }
}

export async function withOrchestrationSnapshot<Result>(
  targetDirectory: string,
  action: (snapshot: {
    state: OrchestrationState;
    events: OrchestrationEvent[];
    leaseBaselines: LeaseBaselinesLedger;
    checkpoint?: CheckpointSnapshot;
  }) => Promise<Result>
): Promise<Result> {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    return await action(await readOrchestrationRaw(targetDirectory));
  } finally {
    await release();
  }
}

interface LockOwner {
  pid: number;
  token: string | null;
}

function parseLockOwner(content: string): LockOwner | undefined {
  try {
    const parsed = parseJson(content);
    if (
      isRecord(parsed)
      && Number.isSafeInteger(parsed.pid)
      && typeof parsed.pid === "number"
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {}
  const legacyPid = Number(content.trim());
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
    return { pid: legacyPid, token: null };
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function inspectLock(lockPath: string): Promise<PathInspection> {
  try {
    return await inspectPath(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { type: "missing" };
    throw error;
  }
}

async function reclaimStaleLock(
  targetDirectory: string,
  lockPath: string,
  existing: Extract<PathInspection, { type: "file" }>
): Promise<boolean> {
  const claimId = sha256Bytes(Buffer.from(existing.content, "utf8")).slice("sha256:".length);
  const claimPath = resolveProjectPath(
    targetDirectory,
    `.synod/orchestration-reclaim-${claimId}.lock`
  );
  let claimed = false;
  try {
    await link(lockPath, claimPath);
    claimed = true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (errorCode(error) === "EEXIST") {
      try {
        const [lockStats, claimStats] = await Promise.all([
          lstat(lockPath, { bigint: true }),
          lstat(claimPath, { bigint: true })
        ]);
        claimed = lockStats.dev === claimStats.dev && lockStats.ino === claimStats.ino;
      } catch (inspectionError) {
        if (errorCode(inspectionError) === "ENOENT") return false;
        throw inspectionError;
      }
      if (!claimed) return false;
    } else {
      throw error;
    }
  }

  try {
    const [claim, current] = await Promise.all([
      inspectLock(claimPath),
      inspectLock(lockPath)
    ]);
    if (
      claim.type !== "file"
      || claim.content !== existing.content
      || current.type !== "file"
      || current.content !== existing.content
    ) return false;
    try {
      await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return true;
  } finally {
    if (claimed) {
      // Orphan claims are harmless and reconciled by the inode check on reuse.
      await unlink(claimPath).catch(() => {});
    }
  }
}

async function acquireLock(targetDirectory: string): Promise<() => Promise<void>> {
  const lockPath = resolveProjectPath(targetDirectory, ORCHESTRATION_LOCK_PATH);
  const unsafe = await unsafeAncestor(targetDirectory, lockPath);
  if (unsafe) throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to lock orchestration through unsafe path: ${unsafe}`);
  const token = randomUUID();
  const lockContent = serializeJson({ pid: process.pid, token, createdAt: nowIso() });
  const candidatePath = resolveProjectPath(targetDirectory, `.synod/orchestration-candidate-${token}.lock`);
  let candidateHandle;
  try {
    candidateHandle = await open(candidatePath, "wx", 0o600);
    await candidateHandle.writeFile(lockContent, "utf8");
    await candidateHandle.sync();
    await candidateHandle.close();
    candidateHandle = undefined;
  } catch (error) {
    await candidateHandle?.close().catch(() => {});
    if (errorCode(error) === "ENOENT") {
      throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration is not initialized in this project.");
    }
    throw error;
  }

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(candidatePath, lockPath);
        return async () => {
          const current = await inspectLock(lockPath);
          if (current.type === "missing") return;
          if (current.type === "file" && current.content === lockContent) await unlink(lockPath);
        };
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration is not initialized in this project.");
        }
        if (errorCode(error) !== "EEXIST") throw error;

        const existing = await inspectLock(lockPath);
        if (existing.type === "missing") continue;
        if (existing.type !== "file") {
          throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Synod orchestration lock is not a regular file.", {
            details: { path: ORCHESTRATION_LOCK_PATH, type: existing.type }
          });
        }
        const owner = parseLockOwner(existing.content);
        if (!owner || processIsAlive(owner.pid)) {
          throw new SynodError(ERROR_CODES.ORCHESTRATION_LOCKED, "Another Synod orchestration mutation holds the project lock.", {
            details: { path: ORCHESTRATION_LOCK_PATH, ...(owner ? { pid: owner.pid } : {}) }
          });
        }

        await reclaimStaleLock(targetDirectory, lockPath, existing);
      }
    }
  } finally {
    // An orphaned candidate is unpublished and cannot block another owner.
    await unlink(candidatePath).catch(() => {});
  }

  throw new SynodError(ERROR_CODES.ORCHESTRATION_LOCKED, "Could not safely acquire the Synod orchestration lock after stale-lock recovery.", {
    details: { path: ORCHESTRATION_LOCK_PATH }
  });
}

export async function withOrchestrationLock<Result>(
  targetDirectory: string,
  action: () => Promise<Result>
): Promise<Result> {
  const release = await acquireLock(targetDirectory);
  let actionFailed = false;
  try {
    return await action();
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    if (actionFailed) await release().catch(() => {});
    else await release();
  }
}

async function appendEvent(targetDirectory: string, event: OrchestrationEvent): Promise<void> {
  const eventPath = resolveProjectPath(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  const unsafe = await unsafeAncestor(targetDirectory, eventPath);
  if (unsafe) throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to append through unsafe path: ${unsafe}`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(eventPath, flags);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is not a regular file.");
    }
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface PendingMutation {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  event: OrchestrationEvent;
  state: OrchestrationState;
  status: string;
  expectedStateHash: string;
  expectedStatusHash: string;
  checkpointSnapshot?: CheckpointSnapshot;
  expectedCheckpointSnapshot?: { type: "missing" } | { type: "file"; hash: string };
  leaseBaselines?: LeaseBaselinesLedger;
  expectedLeaseBaselines?: { type: "file"; hash: string };
}

function isExpectedCheckpointSnapshot(value: unknown): value is PendingMutation["expectedCheckpointSnapshot"] {
  return isRecord(value)
    && (value.type === "missing" || (value.type === "file" && typeof value.hash === "string" && /^sha256:[0-9a-f]{64}$/.test(value.hash)));
}

function isValidCheckpointSnapshot(value: unknown): value is CheckpointSnapshot {
  try {
    validateCheckpointSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

function isValidLeaseBaselinesLedger(value: unknown): value is LeaseBaselinesLedger {
  try {
    validateLeaseBaselinesLedger(value);
    return true;
  } catch {
    return false;
  }
}

function isPendingMutation(value: unknown): value is PendingMutation {
  return isRecord(value)
    && value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION
    && isOrchestrationEvent(value.event)
    && isOrchestrationStateShape(value.state)
    && typeof value.status === "string"
    && typeof value.expectedStateHash === "string"
    && typeof value.expectedStatusHash === "string"
    && (
      (value.checkpointSnapshot === undefined && value.expectedCheckpointSnapshot === undefined)
      || (isValidCheckpointSnapshot(value.checkpointSnapshot) && isExpectedCheckpointSnapshot(value.expectedCheckpointSnapshot))
    )
    && (
      (value.leaseBaselines === undefined && value.expectedLeaseBaselines === undefined)
      || (
        isValidLeaseBaselinesLedger(value.leaseBaselines)
        && isRecord(value.expectedLeaseBaselines)
        && value.expectedLeaseBaselines.type === "file"
        && typeof value.expectedLeaseBaselines.hash === "string"
      )
    );
}

async function readPendingMutation(
  targetDirectory: string
): Promise<{ inspected: Extract<PathInspection, { type: "file" }>; pending: PendingMutation } | undefined> {
  const inspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  if (inspected.type === "missing") return undefined;
  if (inspected.type !== "file") {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration mutation is not a regular file.");
  }
  let pending: unknown;
  try {
    pending = parseJson(inspected.content);
  } catch (error) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, `Could not parse ${ORCHESTRATION_PENDING_PATH}: ${errorMessage(error)}`, { cause: error });
  }
  if (
    !isPendingMutation(pending)
    || pending.event.eventHash !== eventHash(pending.event)
  ) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration mutation is invalid.");
  }
  const expectedState = {
    ...pending.event.state,
    lastEvent: {
      sequence: pending.event.sequence,
      id: pending.event.id,
      hash: pending.event.eventHash
    }
  };
  if (stableStringify(pending.state) !== stableStringify(expectedState)) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration state does not match its event.");
  }
  if (
    pending.checkpointSnapshot
    && pending.state.checkpoint.worktree.snapshot?.contentHash !== pending.checkpointSnapshot.contentHash
  ) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending checkpoint snapshot does not match its canonical state reference.");
  }
  if (
    pending.leaseBaselines
    && pending.state.leaseBaselines.contentHash !== leaseBaselinesReference(pending.leaseBaselines).contentHash
  ) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending lease baselines do not match their canonical state reference.");
  }
  return { inspected, pending };
}

async function recoverPendingMutation(targetDirectory: string): Promise<boolean> {
  const record = await readPendingMutation(targetDirectory);
  if (!record) return false;
  const { pending } = record;
  const rawEventBytes = await readRecordBytes(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  const finalNewline = rawEventBytes.lastIndexOf(0x0a);
  const completePrefixBytes = finalNewline < 0 ? Buffer.alloc(0) : rawEventBytes.subarray(0, finalNewline + 1);
  const partialSuffix = rawEventBytes.subarray(finalNewline + 1);
  const completePrefix = completePrefixBytes.toString("utf8");
  let events: OrchestrationEvent[];
  try {
    events = validateEventLog(completePrefix.split(/\r?\n/).filter(Boolean).map(line => parseJson(line)));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, `Could not parse ${ORCHESTRATION_EVENTS_PATH}: ${errorMessage(error)}`, { cause: error });
  }
  const last = events.at(-1);
  if (!last) throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is empty.");
  const pendingLine = JSON.stringify(pending.event);
  const pendingLineBytes = Buffer.from(pendingLine, "utf8");
  if (
    partialSuffix.length > 0
    && (
      partialSuffix.length > pendingLineBytes.length
      || !pendingLineBytes.subarray(0, partialSuffix.length).equals(partialSuffix)
    )
  ) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "The partial event-log suffix does not match the pending mutation.", {
      details: { eventSequence: last.sequence, pendingSequence: pending.event.sequence }
    });
  }
  if (last.eventHash !== pending.event.eventHash) {
    if (
      last.eventHash !== pending.event.previousHash
      || pending.event.sequence !== last.sequence + 1
    ) {
      throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Pending mutation does not continue the append-only event log.", {
        details: { eventSequence: last.sequence, pendingSequence: pending.event.sequence }
      });
    }
    validateEventLog([...events, pending.event]);
    if (partialSuffix.length > 0) {
      // The valid prefix is immutable; only the uncommitted partial append is replaced.
      const eventInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_EVENTS_PATH));
      const currentEventBytes = await readRecordBytes(targetDirectory, ORCHESTRATION_EVENTS_PATH);
      if (eventInspected.type !== "file" || !currentEventBytes.equals(rawEventBytes)) {
        throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, "Event log changed while repairing a pending append.");
      }
      await applyTransaction(targetDirectory, [{
        action: "write",
        path: ORCHESTRATION_EVENTS_PATH,
        content: Buffer.concat([completePrefixBytes, pendingLineBytes, Buffer.from("\n")]),
        expected: { type: "file", hash: eventInspected.hash }
      }]);
    } else {
      await appendEvent(targetDirectory, pending.event);
    }
  } else if (partialSuffix.length > 0) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Unexpected bytes follow the committed pending event.");
  }

  const stateInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATE_PATH));
  const statusInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATUS_PATH));
  if (stateInspected.type !== "file" || statusInspected.type !== "file") {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration state or its Markdown view is missing.");
  }
  const snapshotInspected = pending.checkpointSnapshot
    ? await inspectPath(resolveProjectPath(targetDirectory, CHECKPOINT_SNAPSHOT_PATH))
    : undefined;
  if (snapshotInspected && snapshotInspected.type !== "missing" && snapshotInspected.type !== "file") {
    throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "Canonical checkpoint snapshot is not a regular file.", {
      details: { path: CHECKPOINT_SNAPSHOT_PATH, type: snapshotInspected.type }
    });
  }
  const leaseBaselinesInspected = pending.leaseBaselines
    ? await inspectPath(resolveProjectPath(targetDirectory, LEASE_BASELINES_PATH))
    : undefined;
  if (leaseBaselinesInspected && leaseBaselinesInspected.type !== "file") {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Canonical lease baseline ledger is not a regular file.", {
      details: { path: LEASE_BASELINES_PATH, type: leaseBaselinesInspected.type }
    });
  }
  const nextStateContent = serializeJson(pending.state);
  const nextStateHash = contentHash(nextStateContent);
  const nextStatusHash = contentHash(pending.status);
  const nextSnapshotContent = pending.checkpointSnapshot
    ? serializeCheckpointSnapshot(pending.checkpointSnapshot)
    : undefined;
  const nextSnapshotHash = nextSnapshotContent ? contentHash(nextSnapshotContent) : undefined;
  const snapshotAlreadyCommitted = snapshotInspected?.type === "file" && snapshotInspected.hash === nextSnapshotHash;
  const nextLeaseBaselinesContent = pending.leaseBaselines
    ? serializeLeaseBaselinesLedger(pending.leaseBaselines)
    : undefined;
  const nextLeaseBaselinesHash = nextLeaseBaselinesContent ? contentHash(nextLeaseBaselinesContent) : undefined;
  const leaseBaselinesAlreadyCommitted = leaseBaselinesInspected?.type === "file"
    && leaseBaselinesInspected.hash === nextLeaseBaselinesHash;
  if (
    stateInspected.hash !== nextStateHash
    || statusInspected.hash !== nextStatusHash
    || (snapshotInspected && !snapshotAlreadyCommitted)
    || (leaseBaselinesInspected && !leaseBaselinesAlreadyCommitted)
  ) {
    const expectedSnapshot = pending.expectedCheckpointSnapshot;
    const snapshotCanRecover = !snapshotInspected || !expectedSnapshot || snapshotAlreadyCommitted
      || (expectedSnapshot.type === "missing" && snapshotInspected.type === "missing")
      || (expectedSnapshot.type === "file" && snapshotInspected.type === "file" && snapshotInspected.hash === expectedSnapshot.hash);
    const leaseBaselinesCanRecover = !leaseBaselinesInspected
      || leaseBaselinesAlreadyCommitted
      || leaseBaselinesInspected.hash === pending.expectedLeaseBaselines?.hash;
    if (
      ![pending.expectedStateHash, nextStateHash].includes(stateInspected.hash)
      || ![pending.expectedStatusHash, nextStatusHash].includes(statusInspected.hash)
      || !snapshotCanRecover
      || !leaseBaselinesCanRecover
    ) {
      throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, "Canonical orchestration files changed while recovering a pending mutation.", {
        details: {
          state: { expected: pending.expectedStateHash, actual: stateInspected.hash },
          status: { expected: pending.expectedStatusHash, actual: statusInspected.hash },
          ...(snapshotInspected ? {
            checkpointSnapshot: {
              expected: expectedSnapshot,
              actual: snapshotInspected.type === "file" ? { type: "file", hash: snapshotInspected.hash } : { type: snapshotInspected.type }
            }
          } : {}),
          ...(leaseBaselinesInspected ? {
            leaseBaselines: {
              expected: pending.expectedLeaseBaselines,
              actual: { type: leaseBaselinesInspected.type, hash: leaseBaselinesInspected.hash }
            }
          } : {})
        }
      });
    }
    const operations: TransactionOperation[] = [
      {
        action: "write",
        path: ORCHESTRATION_STATE_PATH,
        content: nextStateContent,
        expected: { type: "file", hash: stateInspected.hash }
      },
      {
        action: "write",
        path: ORCHESTRATION_STATUS_PATH,
        content: pending.status,
        expected: { type: "file", hash: statusInspected.hash }
      }
    ];
    if (snapshotInspected && nextSnapshotContent && !snapshotAlreadyCommitted) {
      operations.push({
        action: "write",
        path: CHECKPOINT_SNAPSHOT_PATH,
        content: nextSnapshotContent,
        expected: snapshotInspected.type === "file"
          ? { type: "file", hash: snapshotInspected.hash }
          : { type: "missing" }
      });
    }
    if (leaseBaselinesInspected && nextLeaseBaselinesContent && !leaseBaselinesAlreadyCommitted) {
      operations.push({
        action: "write",
        path: LEASE_BASELINES_PATH,
        content: nextLeaseBaselinesContent,
        expected: { type: "file", hash: leaseBaselinesInspected.hash }
      });
    }
    await applyTransaction(targetDirectory, operations);
  }
  await unlink(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  return true;
}

async function commitMutation<Result extends Record<string, unknown>>(
  targetDirectory: string,
  type: string,
  metadata: EventMetadata,
  reducer: (state: OrchestrationState, context: MutationContext) => MutationResult<Result> | Promise<MutationResult<Result>>,
  dependencies: OrchestrationDependencies = {}
): Promise<{ state: OrchestrationState; event: OrchestrationEvent } & Result> {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    const {
      state: current,
      leaseBaselines: currentLeaseBaselines,
      snapshot: acknowledgedSnapshot
    } = await readOrchestrationRaw(targetDirectory);
    const timestamp = nowIso(dependencies.clock);
    const captured = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
    const checkpoint = captured.checkpoint;
    const draft = structuredClone(current);
    const reducerResult = await reducer(draft, {
      timestamp,
      checkpoint,
      snapshot: captured.snapshot,
      ...(acknowledgedSnapshot ? { acknowledgedSnapshot } : {}),
      leaseBaselines: currentLeaseBaselines,
      nextSequence: current.lastEvent.sequence + 1
    }) || {};
    draft.updatedAt = timestamp;
    if (reducerResult.updateCheckpoint) draft.checkpoint = checkpoint;
    if (reducerResult.leaseBaselines) {
      draft.leaseBaselines = leaseBaselinesReference(reducerResult.leaseBaselines);
    }
    validateOrchestrationState(draft);

    const eventMetadata: EventMetadata = {
      ...metadata,
      ...reducerResult.metadata,
      actor: reducerResult.metadata?.actor ?? metadata.actor,
      checkpoint: reducerResult.updateCheckpoint ? checkpoint : {
        ...checkpoint,
        worktree: {
          clean: checkpoint.worktree.clean,
          entries: checkpoint.worktree.entries,
          fingerprint: checkpoint.worktree.fingerprint
        }
      }
    };
    const { event, state } = buildEvent(current, stateCore(draft), type, eventMetadata);
    const stateInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATE_PATH));
    const statusInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATUS_PATH));
    if (stateInspected.type !== "file" || statusInspected.type !== "file") {
      throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration state or its Markdown view is missing.");
    }

    const nextStateContent = serializeJson(state);
    const nextStatusContent = renderStatusMarkdown(state);
    const snapshotInspected = reducerResult.updateCheckpoint
      ? await inspectPath(resolveProjectPath(targetDirectory, CHECKPOINT_SNAPSHOT_PATH))
      : undefined;
    if (snapshotInspected && snapshotInspected.type !== "missing" && snapshotInspected.type !== "file") {
      throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "Canonical checkpoint snapshot is not a regular file.", {
        details: { path: CHECKPOINT_SNAPSHOT_PATH, type: snapshotInspected.type }
      });
    }
    const leaseBaselinesInspected = reducerResult.leaseBaselines
      ? await inspectPath(resolveProjectPath(targetDirectory, LEASE_BASELINES_PATH))
      : undefined;
    if (leaseBaselinesInspected && leaseBaselinesInspected.type !== "file") {
      throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Canonical lease baseline ledger is not a regular file.", {
        details: { path: LEASE_BASELINES_PATH, type: leaseBaselinesInspected.type }
      });
    }
    const pending = {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      event,
      state,
      status: nextStatusContent,
      expectedStateHash: stateInspected.hash,
      expectedStatusHash: statusInspected.hash,
      ...(reducerResult.updateCheckpoint && snapshotInspected ? {
        checkpointSnapshot: captured.snapshot,
        expectedCheckpointSnapshot: snapshotInspected.type === "file"
          ? { type: "file" as const, hash: snapshotInspected.hash }
          : { type: "missing" as const }
      } : {}),
      ...(reducerResult.leaseBaselines && leaseBaselinesInspected ? {
        leaseBaselines: reducerResult.leaseBaselines,
        expectedLeaseBaselines: { type: "file" as const, hash: leaseBaselinesInspected.hash }
      } : {})
    };
    await applyTransaction(targetDirectory, [{
      action: "write",
      path: ORCHESTRATION_PENDING_PATH,
      content: serializeJson(pending),
      expected: { type: "missing" }
    }], dependencies);
    try {
      await appendEvent(targetDirectory, event);
      const operations: TransactionOperation[] = [
        {
          action: "write",
          path: ORCHESTRATION_STATE_PATH,
          content: nextStateContent,
          expected: { type: "file", hash: stateInspected.hash }
        },
        {
          action: "write",
          path: ORCHESTRATION_STATUS_PATH,
          content: nextStatusContent,
          expected: { type: "file", hash: statusInspected.hash }
        }
      ];
      if (reducerResult.updateCheckpoint && snapshotInspected) {
        operations.push({
          action: "write",
          path: CHECKPOINT_SNAPSHOT_PATH,
          content: serializeCheckpointSnapshot(captured.snapshot),
          expected: snapshotInspected.type === "file"
            ? { type: "file", hash: snapshotInspected.hash }
            : { type: "missing" }
        });
      }
      if (reducerResult.leaseBaselines && leaseBaselinesInspected) {
        operations.push({
          action: "write",
          path: LEASE_BASELINES_PATH,
          content: serializeLeaseBaselinesLedger(reducerResult.leaseBaselines),
          expected: { type: "file", hash: leaseBaselinesInspected.hash }
        });
      }
      await applyTransaction(targetDirectory, operations, dependencies);
      await unlink(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
    } catch (error) {
      try {
        await recoverPendingMutation(targetDirectory);
      } catch (recoveryError) {
        throw new SynodError(ERROR_CODES.TRANSACTION_FAILED, "Synod left a recoverable pending orchestration mutation after a commit failure.", {
          cause: error,
          details: { originalError: errorMessage(error), recoveryError: errorMessage(recoveryError) }
        });
      }
    }
    return Object.assign({ state, event }, reducerResult.result);
  } finally {
    await release();
  }
}

function normalizedList(values: unknown[] | undefined, label: string): string[] {
  const result = [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
  if (result.length === 0) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, `A task requires at least one ${label}.`, { details: { field: label } });
  }
  return result;
}

export interface AddTaskOptions {
  directory?: string;
  id?: string;
  objective?: string | undefined;
  executor?: string | undefined;
  acceptance?: unknown[];
  verification?: unknown[];
  dependsOn?: unknown[];
  correctionLimit?: number;
  actor?: string;
}

export async function addTask({
  directory = ".",
  id,
  objective,
  executor,
  acceptance = [],
  verification = [],
  dependsOn = [],
  correctionLimit = 2,
  actor = "supervisor"
}: AddTaskOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const taskObjective = String(objective || "").trim();
  const taskExecutor = String(executor || "").trim();
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(taskId) || !taskObjective || !taskExecutor
    || !Number.isSafeInteger(correctionLimit) || correctionLimit < 0) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, "Task ID, objective, and executor are required.", {
      details: { id: taskId, objective: taskObjective, executor: taskExecutor }
    });
  }
  const criteria = normalizedList(acceptance, "acceptance criterion");
  const commands = normalizedList(verification, "verification command");
  const dependenciesList = [...new Set(dependsOn.map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  const targetDirectory = path.resolve(directory);

  return commitMutation(targetDirectory, "task.created", { actor, taskId }, (state, context) => {
    if (state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_EXISTS, `Task ${taskId} already exists.`, { details: { taskId } });
    for (const dependency of dependenciesList) {
      if (!state.tasks[dependency] || dependency === taskId) {
        throw new SynodError(ERROR_CODES.TASK_INVALID, `Task ${taskId} has an unknown or self dependency: ${dependency}`, {
          details: { taskId, dependency }
        });
      }
    }
    const task: OrchestrationTask = {
      id: taskId,
      objective: taskObjective,
      dependsOn: dependenciesList,
      state: "PLANNED",
      revision: 0,
      executor: taskExecutor,
      correctionRound: 0,
      correctionPolicy: { limit: correctionLimit, used: 0, overrides: [] },
      leaseGeneration: 0,
      acceptance: { criteria, status: "pending", revision: null, evidenceIds: [] },
      verification: { commands, status: "pending", revision: null, evidenceIds: [] },
      evidence: [],
      createdAt: context.timestamp,
      updatedAt: context.timestamp
    };
    state.tasks[taskId] = task;
    state.taskOrder.push(taskId);
    return {
      metadata: { revision: 0, toState: "PLANNED", payload: { task } },
      result: { task }
    };
  }, dependencies);
}

export interface OverrideCorrectionOptions {
  directory?: string;
  id?: string;
  additionalRounds?: number;
  approver?: string;
  reference?: string;
  reason?: string;
  evidence?: unknown[];
  actor?: string;
}

export async function overrideCorrectionPolicy({
  directory = ".",
  id,
  additionalRounds,
  approver,
  reference,
  reason,
  evidence = [],
  actor = "supervisor"
}: OverrideCorrectionOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const added = Number(additionalRounds);
  const approval = String(approver || "").trim();
  const approvalReference = String(reference || "").trim();
  const explanation = String(reason || "").trim();
  const evidenceReferences = [...new Set(evidence.map(value => String(value).trim()).filter(Boolean))];
  if (!Number.isSafeInteger(added) || added <= 0 || !approval || !approvalReference || !explanation || evidenceReferences.length === 0) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, "Correction override requires positive additional rounds, approver, reference, reason, and evidence.");
  }
  return commitMutation(path.resolve(directory), "task.correction-overridden", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (TERMINAL_STATES.has(task.state) || task.correctionPolicy.used < task.correctionPolicy.limit) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} is not eligible for an exhausted-policy override.`, {
        details: { taskId, state: task.state, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    task.correctionPolicy.limit += added;
    task.correctionPolicy.overrides.push({
      added,
      actor,
      approver: approval,
      reference: approvalReference,
      reason: explanation,
      recordedAt: context.timestamp,
      evidence: evidenceReferences
    });
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        revision: task.revision,
        payload: { added, approver: approval, reference: approvalReference, reason: explanation, evidence: evidenceReferences }
      },
      result: { task, override: task.correctionPolicy.overrides.at(-1)! }
    };
  }, dependencies);
}

export interface SplitTaskOptions {
  directory?: string;
  id?: string;
  replacements?: unknown[];
  reason?: string;
  evidence?: unknown[];
  actor?: string;
}

export async function splitTask({
  directory = ".",
  id,
  replacements = [],
  reason,
  evidence = [],
  actor = "supervisor"
}: SplitTaskOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const replacementIds = [...new Set(replacements.map(taskIdValue).filter(Boolean))];
  const explanation = String(reason || "").trim();
  const evidenceReferences = [...new Set(evidence.map(value => String(value).trim()).filter(Boolean))];
  if (replacementIds.length < 2 || !explanation || evidenceReferences.length === 0 || replacementIds.includes(taskId)) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, "Task split requires at least two distinct replacements, a reason, and evidence.");
  }
  return commitMutation(path.resolve(directory), "task.split", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (task.correctionPolicy.used < task.correctionPolicy.limit || TERMINAL_STATES.has(task.state) || task.lease) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} is not eligible for an exhausted-policy split.`, {
        details: { taskId, state: task.state, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    if (task.recovery?.status === "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} requires an explicit abandoned-owner recovery decision before it can split.`, {
        details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
      });
    }
    for (const replacementId of replacementIds) {
      const replacement = state.tasks[replacementId];
      if (!replacement || replacement.state !== "PLANNED" || replacement.splitFrom) {
        throw new SynodError(ERROR_CODES.TASK_INVALID, `Split replacement ${replacementId} must be an unlinked PLANNED task.`, {
          details: { taskId, replacementId, state: replacement?.state }
        });
      }
    }
    const inheritedDependencies = task.dependsOn.filter(dependency => !replacementIds.includes(dependency));
    const replacementDependencies = new Map<string, string[]>(replacementIds.map(replacementId => [
      replacementId,
      [...new Set([...state.tasks[replacementId]!.dependsOn, ...inheritedDependencies])]
    ]));
    const dependentIds = state.taskOrder.filter(id => id !== taskId && state.tasks[id]?.dependsOn.includes(taskId));
    const rewrittenDependencies = new Map<string, string[]>(dependentIds.map(dependentId => {
      const dependencies = (replacementDependencies.get(dependentId) || state.tasks[dependentId]!.dependsOn)
        .flatMap(dependency => dependency === taskId ? replacementIds : [dependency]);
      return [dependentId, [...new Set(dependencies)]];
    }));
    const dependencyMap = new Map(state.taskOrder.map(id => [
      id,
      rewrittenDependencies.get(id) || replacementDependencies.get(id) || state.tasks[id]!.dependsOn
    ]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      if ((dependencyMap.get(id) || []).some(hasCycle)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if (state.taskOrder.some(hasCycle)) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, `Splitting task ${taskId} would create a dependency cycle.`, {
        details: { taskId, replacements: replacementIds, dependents: dependentIds }
      });
    }
    const fromState = task.state;
    task.state = "SUPERSEDED";
    task.supersededReason = explanation;
    task.split = { replacements: replacementIds, actor, reason: explanation, evidence: evidenceReferences, recordedAt: context.timestamp };
    task.updatedAt = context.timestamp;
    delete task.blocker;
    delete task.blockedFrom;
    for (const replacementId of replacementIds) {
      const replacement = state.tasks[replacementId]!;
      replacement.dependsOn = rewrittenDependencies.get(replacementId) || replacementDependencies.get(replacementId)!;
      replacement.splitFrom = taskId;
      replacement.updatedAt = context.timestamp;
    }
    for (const [dependentId, dependencies] of rewrittenDependencies) {
      const dependent = state.tasks[dependentId]!;
      dependent.dependsOn = dependencies;
      dependent.updatedAt = context.timestamp;
    }
    return {
      metadata: {
        fromState,
        toState: "SUPERSEDED",
        revision: task.revision,
        payload: {
          replacements: replacementIds,
          replacementDependencies: replacementIds.map(replacementId => ({
            id: replacementId,
            dependsOn: state.tasks[replacementId]!.dependsOn
          })),
          dependents: dependentIds.map(dependentId => ({ id: dependentId, dependsOn: state.tasks[dependentId]!.dependsOn })),
          reason: explanation,
          evidence: evidenceReferences
        }
      },
      result: { task, replacements: replacementIds.map(replacementId => state.tasks[replacementId]!) }
    };
  }, dependencies);
}

function taskIdValue(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function leaseDeadline(timestamp: string, ttlSeconds: number): string {
  return new Date(Date.parse(timestamp) + ttlSeconds * 1_000).toISOString();
}

function retainedLeaseBaselines(
  state: OrchestrationState,
  leaseBaselines: LeaseBaselinesLedger
): LeaseBaselinesLedger | undefined {
  const retained = retainLeaseBaselinesLedger(
    leaseBaselines,
    taskList(state).flatMap(task => [
      ...(task.lease ? [task.lease] : []),
      ...(proposalReservesPaths(task) && task.proposal
        ? [{ id: task.proposal.leaseId, generation: task.proposal.generation }]
        : []),
      ...(task.recovery?.status === "PENDING"
        ? [{ id: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }]
        : [])
    ])
  );
  return retained.baselines.length === leaseBaselines.baselines.length ? undefined : retained;
}

async function validateLeaseScopeFilesystemPaths(targetDirectory: string, scopes: TaskLease["scopes"]): Promise<void> {
  for (const scope of scopes) {
    const absolutePath = resolveProjectPath(targetDirectory, scope.path);
    const unsafe = await unsafeAncestor(targetDirectory, absolutePath);
    const type = await pathType(absolutePath);
    const invalidTarget = scope.kind === "tree"
      ? type !== "missing" && type !== "directory"
      : type === "directory" || type === "other" || type === "symlink";
    if (unsafe || invalidTarget) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease scope has an unsafe ancestor or incompatible target: ${scope.path}`, {
        details: { path: scope.path, kind: scope.kind, ...(unsafe ? { unsafeAncestor: unsafe } : { type }) }
      });
    }
  }
}

function leaseBaselineFor(
  task: OrchestrationTask,
  lease: Pick<TaskLease, "id" | "generation" | "taskRevision">,
  leaseBaselines: LeaseBaselinesLedger
): LeaseBaseline {
  const baseline = leaseBaselines.baselines.find(item =>
    item.leaseId === lease.id && item.generation === lease.generation
  );
  if (!baseline || baseline.taskId !== task.id || baseline.taskRevision !== lease.taskRevision) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Task ${task.id} lease baseline is missing or mismatched.`, {
      details: { taskId: task.id, leaseId: lease.id, generation: lease.generation }
    });
  }
  return baseline;
}

interface ClassifiedLeaseDelta {
  owned: CheckpointDelta["paths"];
  foreign: CheckpointDelta["paths"];
  readDrift: CheckpointDelta["paths"];
  unowned: CheckpointDelta["paths"];
}

function deltaPaths(item: CheckpointDelta["paths"][number]): string[] {
  return [item.path, ...(item.sourcePath ? [item.sourcePath] : [])];
}

function scopesCoverPaths(scopes: TaskLease["scopes"], access: "read" | "write", paths: string[]): boolean {
  return paths.every(candidate => scopes.some(scope => scope.access === access && leaseScopeCoversPath(scope, candidate)));
}

function proposalReservesPaths(task: OrchestrationTask): boolean {
  if (!task.proposal) return false;
  if (["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)) return true;
  return task.state === "BLOCKED"
    && task.blockedFrom !== undefined
    && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.blockedFrom);
}

function proposalIsForeignToLease(
  task: OrchestrationTask,
  baselineLastEventSequence: number
): boolean {
  if (!task.proposal) return false;
  if (proposalReservesPaths(task)) return true;
  return ["DONE", "SUPERSEDED"].includes(task.state)
    && task.proposal.sealedAfterEvent.sequence >= baselineLastEventSequence;
}

function classifyLeaseDelta(
  state: OrchestrationState,
  task: OrchestrationTask,
  lease: Pick<TaskLease, "id" | "generation" | "scopes">,
  baselineLastEventSequence: number,
  baseline: CheckpointSnapshot,
  current: CheckpointSnapshot
): ClassifiedLeaseDelta {
  const classified: ClassifiedLeaseDelta = { owned: [], foreign: [], readDrift: [], unowned: [] };
  const delta = explainCheckpointDelta(baseline, current);
  if (baseline.available !== current.available || baseline.branch !== current.branch || baseline.head !== current.head) {
    classified.unowned.push({
      path: ".git",
      untracked: false,
      binary: false,
      resolved: false
    });
  }
  const foreignScopes = taskList(state).flatMap(other =>
    other.id !== task.id && other.lease
      ? other.lease.scopes.filter(scope => scope.access === "write")
      : []
  );
  const sealedForeignPaths = new Set(taskList(state).flatMap(other =>
    other.id !== task.id && proposalIsForeignToLease(other, baselineLastEventSequence) && other.proposal
      ? other.proposal.ownedPaths.map(candidate => candidate.normalize("NFC").toLowerCase())
      : []
  ));
  for (const item of delta.paths) {
    const affected = deltaPaths(item);
    const owned = scopesCoverPaths(lease.scopes, "write", affected);
    const sealedConflict = owned && affected.some(candidate =>
      sealedForeignPaths.has(candidate.normalize("NFC").toLowerCase())
    );
    if (owned && !sealedConflict) classified.owned.push(item);
    else if (affected.some(candidate => lease.scopes.some(scope =>
      scope.access === "read" && leaseScopeCoversPath(scope, candidate)
    ))) classified.readDrift.push(item);
    else if (affected.every(candidate =>
      foreignScopes.some(scope => leaseScopeCoversPath(scope, candidate))
      || sealedForeignPaths.has(candidate.normalize("NFC").toLowerCase())
    )) classified.foreign.push(item);
    else classified.unowned.push(item);
  }
  return classified;
}

function proposalSnapshot(
  current: CheckpointSnapshot,
  owned: ClassifiedLeaseDelta["owned"],
  capturedAt: string
): CheckpointSnapshot {
  const ownedDestinations = new Set(owned.map(item => item.path));
  const entries = current.entries.filter(entry => ownedDestinations.has(entry.path));
  return validateCheckpointSnapshot(createCheckpointSnapshot({
    capturedAt,
    available: current.available,
    branch: current.branch,
    head: current.head,
    worktreeFingerprint: sha256(stableCheckpointStringify(entries)),
    entries
  }));
}

function snapshotFingerprintForPaths(snapshot: CheckpointSnapshot, paths: readonly string[]): string {
  const selected = new Set(paths);
  return sha256(stableCheckpointStringify(snapshot.entries.filter(entry => selected.has(entry.path))));
}

function rejectUnacceptableLeaseDrift(task: OrchestrationTask, classified: ClassifiedLeaseDelta): void {
  if (classified.readDrift.length === 0 && classified.unowned.length === 0) return;
  throw new SynodError(ERROR_CODES.LEASE_SCOPE_DRIFT, `Task ${task.id} contains changed paths outside its writer lease.`, {
    details: {
      taskId: task.id,
      readDrift: classified.readDrift.map(item => ({ path: item.path, ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) })),
      unowned: classified.unowned.map(item => ({ path: item.path, ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) })),
      foreign: classified.foreign.map(item => ({ path: item.path, ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) }))
    }
  });
}

async function ensureProposalParent(targetDirectory: string, proposalPath: string): Promise<string> {
  const destination = resolveProjectPath(targetDirectory, proposalPath);
  const parent = path.dirname(destination);
  const unsafeBefore = await unsafeAncestor(targetDirectory, parent);
  if (unsafeBefore) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "Proposal path traverses an unsafe ancestor.", {
      details: { path: proposalPath, unsafeAncestor: unsafeBefore }
    });
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const unsafeAfter = await unsafeAncestor(targetDirectory, parent);
  if (unsafeAfter || await pathType(parent) !== "directory") {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "Proposal parent is not a safe directory.", {
      details: { path: proposalPath, ...(unsafeAfter ? { unsafeAncestor: unsafeAfter } : {}) }
    });
  }
  return destination;
}

async function sealTaskProposal(
  targetDirectory: string,
  state: OrchestrationState,
  task: OrchestrationTask,
  lease: TaskLease | EndedTaskLease,
  revision: number,
  context: MutationContext,
  dependencies: OrchestrationDependencies
): Promise<{ proposal: TaskProposalReference; foreign: ClassifiedLeaseDelta["foreign"] }> {
  await validateLeaseScopeFilesystemPaths(targetDirectory, lease.scopes);
  const baseline = leaseBaselineFor(task, lease, context.leaseBaselines);
  const classified = classifyLeaseDelta(
    state,
    task,
    lease,
    lease.baseline.lastEvent.sequence,
    baseline.snapshot,
    context.snapshot
  );
  rejectUnacceptableLeaseDrift(task, classified);
  const snapshot = proposalSnapshot(context.snapshot, classified.owned, baseline.capturedAt);
  const ownedPaths = [...new Set(classified.owned.flatMap(deltaPaths))].sort(compareCheckpointPaths);
  const proposalPath = `.synod/proposals/${lease.id}/${lease.generation}`;
  const destination = await ensureProposalParent(targetDirectory, proposalPath);
  const recovery = await import("./recovery.js");
  const proposalIdentity: import("./recovery.js").RecoveryProposalIdentity = {
    taskId: task.id,
    leaseId: lease.id,
    generation: lease.generation,
    baseRevision: task.revision,
    revision,
    scopes: lease.scopes,
    ownedPaths,
    baseline: {
      snapshotHash: baseline.snapshot.contentHash,
      worktreeFingerprint: baseline.snapshot.worktreeFingerprint
    }
  };
  let verified: Awaited<ReturnType<typeof recovery.verifyRecoveryBundle>>;
  if (await pathType(destination) === "missing") {
    verified = await recovery.exportSnapshotRecoveryBundle({
      directory: targetDirectory,
      destination,
      snapshot,
      source: { branch: context.checkpoint.branch, head: context.checkpoint.head },
      event: { sequence: state.lastEvent.sequence, hash: state.lastEvent.hash },
      proposal: proposalIdentity,
      guardCheckpoint: context.checkpoint,
      includeUntracked: true,
      allowInsideSource: true
    }, dependencies);
  } else {
    try {
      verified = await recovery.verifyRecoveryBundle({ bundle: destination });
    } catch (error) {
      throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "Existing immutable proposal material is invalid and was preserved.", {
        cause: error,
        details: { taskId: task.id, path: proposalPath }
      });
    }
  }
  const manifest = verified.manifest;
  if (
    manifest.checkpoint.fingerprint !== snapshot.worktreeFingerprint
    || manifest.checkpoint.snapshotHash !== snapshot.contentHash
    || manifest.source.branch !== context.checkpoint.branch
    || manifest.source.head !== context.checkpoint.head
    || manifest.event.sequence !== state.lastEvent.sequence
    || manifest.event.hash !== state.lastEvent.hash
    || stableStringify(manifest.proposal) !== stableStringify(proposalIdentity)
  ) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "Existing immutable proposal material does not match this delivery attempt.", {
      details: { taskId: task.id, path: proposalPath, bundleId: verified.bundleId }
    });
  }
  return {
    proposal: {
      path: proposalPath,
      bundleId: verified.bundleId,
      leaseId: lease.id,
      generation: lease.generation,
      baseRevision: task.revision,
      revision,
      scopes: lease.scopes,
      ownedPaths,
      excludedForeignPaths: [...new Set(classified.foreign.flatMap(deltaPaths))].sort(compareCheckpointPaths),
      fingerprint: snapshot.worktreeFingerprint,
      snapshotHash: snapshot.contentHash,
      sealedWorktreeFingerprint: context.snapshot.worktreeFingerprint,
      sealedAt: context.timestamp,
      leaseBaselineEvent: lease.baseline.lastEvent,
      sealedAfterEvent: state.lastEvent,
      status: "SEALED"
    },
    foreign: classified.foreign
  };
}

async function verifyTaskProposalForAcceptance(
  targetDirectory: string,
  state: OrchestrationState,
  task: OrchestrationTask,
  context: MutationContext
): Promise<ClassifiedLeaseDelta["foreign"]> {
  const proposal = task.proposal;
  if (!proposal || proposal.revision !== task.revision) {
    throw new SynodError(ERROR_CODES.PROPOSAL_REQUIRED, `Task ${task.id} requires a sealed proposal for revision ${task.revision}.`, {
      details: { taskId: task.id, revision: task.revision }
    });
  }
  if (task.leaseGeneration !== proposal.generation) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} proposal generation is obsolete.`, {
      details: { taskId: task.id, expectedGeneration: task.leaseGeneration, proposalGeneration: proposal.generation }
    });
  }
  const baseline = leaseBaselineFor(task, {
    id: proposal.leaseId,
    generation: proposal.generation,
    taskRevision: proposal.baseRevision
  }, context.leaseBaselines);
  const classified = classifyLeaseDelta(state, task, {
    id: proposal.leaseId,
    generation: proposal.generation,
    scopes: proposal.scopes
  }, proposal.leaseBaselineEvent.sequence, baseline.snapshot, context.snapshot);
  rejectUnacceptableLeaseDrift(task, classified);
  const ownedPaths = [...new Set(classified.owned.flatMap(deltaPaths))].sort(compareCheckpointPaths);
  const snapshot = proposalSnapshot(context.snapshot, classified.owned, baseline.capturedAt);
  if (
    stableStringify(ownedPaths) !== stableStringify(proposal.ownedPaths)
    || snapshot.worktreeFingerprint !== proposal.fingerprint
    || snapshot.contentHash !== proposal.snapshotHash
  ) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} owned material changed after proposal sealing.`, {
      details: {
        taskId: task.id,
        expectedOwnedPaths: proposal.ownedPaths,
        actualOwnedPaths: ownedPaths,
        expectedFingerprint: proposal.fingerprint,
        actualFingerprint: snapshot.worktreeFingerprint,
        expectedSnapshotHash: proposal.snapshotHash,
        actualSnapshotHash: snapshot.contentHash
      }
    });
  }
  const recovery = await import("./recovery.js");
  let verified: Awaited<ReturnType<typeof recovery.verifyRecoveryBundle>>;
  try {
    verified = await recovery.verifyRecoveryBundle({ bundle: resolveProjectPath(targetDirectory, proposal.path) });
  } catch (error) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} sealed proposal failed verification.`, {
      cause: error,
      details: { taskId: task.id, path: proposal.path }
    });
  }
  if (
    verified.bundleId !== proposal.bundleId
    || verified.manifest.checkpoint.fingerprint !== proposal.fingerprint
    || verified.manifest.checkpoint.snapshotHash !== proposal.snapshotHash
    || stableStringify(verified.manifest.proposal) !== stableStringify({
      taskId: task.id,
      leaseId: proposal.leaseId,
      generation: proposal.generation,
      baseRevision: proposal.baseRevision,
      revision: proposal.revision,
      scopes: proposal.scopes,
      ownedPaths: proposal.ownedPaths,
      baseline: {
        snapshotHash: baseline.snapshot.contentHash,
        worktreeFingerprint: baseline.snapshot.worktreeFingerprint
      }
    })
  ) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} sealed proposal identity does not match canonical state.`, {
      details: { taskId: task.id, path: proposal.path, expectedBundleId: proposal.bundleId, actualBundleId: verified.bundleId }
    });
  }
  return classified.foreign;
}

function requireLeaseIdentity(
  task: OrchestrationTask,
  {
    leaseId,
    generation,
    revision,
    expectedHeartbeatAt,
    ownerThread
  }: {
    leaseId?: unknown;
    generation?: unknown;
    revision?: unknown;
    expectedHeartbeatAt?: unknown;
    ownerThread?: unknown;
  },
  { requireOwner = true }: { requireOwner?: boolean } = {}
): TaskLease {
  const lease = task.lease;
  if (!lease) {
    throw new SynodError(ERROR_CODES.LEASE_NOT_FOUND, `Task ${task.id} has no active writer lease.`, {
      details: { taskId: task.id }
    });
  }
  if (String(leaseId || "") !== lease.id || generation !== lease.generation) {
    throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${task.id} lease generation is stale.`, {
      details: {
        taskId: task.id,
        expected: { leaseId: lease.id, generation: lease.generation },
        actual: { leaseId, generation }
      }
    });
  }
  if (revision !== task.revision || revision !== lease.taskRevision) {
    throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${task.id} lease revision is stale.`, {
      details: { taskId: task.id, expectedRevision: task.revision, actualRevision: revision }
    });
  }
  if (String(expectedHeartbeatAt || "") !== lease.heartbeatAt) {
    throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${task.id} lease heartbeat fence is stale.`, {
      details: { taskId: task.id, expectedHeartbeatAt: lease.heartbeatAt, actualHeartbeatAt: expectedHeartbeatAt }
    });
  }
  if (requireOwner && String(ownerThread || "").trim() !== lease.ownerThread) {
    throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${task.id} lease owner does not match.`, {
      details: { taskId: task.id, expectedOwnerThread: lease.ownerThread, actualOwnerThread: ownerThread }
    });
  }
  return lease;
}

export interface AcquireLeaseOptions {
  directory?: string;
  id?: string;
  ownerThread?: string;
  read?: unknown[];
  write?: unknown[];
  readTree?: unknown[];
  writeTree?: unknown[];
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  actor?: string;
}

export async function acquireTaskLease({
  directory = ".",
  id,
  ownerThread,
  read = [],
  write = [],
  readTree = [],
  writeTree = [],
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  actor = "supervisor"
}: AcquireLeaseOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const owner = String(ownerThread || "").trim();
  const ttl = parseLeaseDuration(ttlSeconds, "ttlSeconds");
  const heartbeat = parseLeaseDuration(heartbeatIntervalSeconds, "heartbeatIntervalSeconds");
  if (!owner) throw new SynodError(ERROR_CODES.LEASE_INVALID, "A writer lease requires --owner-thread.");
  if (ttl < MIN_LEASE_TTL_SECONDS || ttl > MAX_LEASE_TTL_SECONDS || heartbeat >= ttl) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease heartbeat/expiry policy is outside the supported bounds.", {
      details: {
        ttlSeconds: ttl,
        heartbeatIntervalSeconds: heartbeat,
        minimumTtlSeconds: MIN_LEASE_TTL_SECONDS,
        maximumTtlSeconds: MAX_LEASE_TTL_SECONDS
      }
    });
  }
  const scopes = normalizeLeaseScopes({ read, write, readTree, writeTree });
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "lease.acquired", { actor, taskId }, async (state, context) => {
    if (!context.snapshot.available || !context.snapshot.head) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "A writer lease requires an exact Git HEAD and worktree snapshot.", {
        details: { taskId, branch: context.snapshot.branch, head: context.snapshot.head }
      });
    }
    await validateLeaseScopeFilesystemPaths(targetDirectory, scopes);
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const eligible = task.state === "READY"
      || (task.state === "ACTIVE" && task.preLease)
      || ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)
      || (task.state === "BLOCKED" && (
        task.blockedFrom === "ACTIVE"
        || (task.preLease && leaseMigrationState(task.blockedFrom))
      ));
    if (!eligible) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Task ${taskId} cannot acquire a writer lease from ${task.state}.`, {
        details: { taskId, state: task.state }
      });
    }
    if (task.recovery?.status === "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Task ${taskId} requires an explicit abandoned-owner recovery decision.`, {
        details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
      });
    }
    const correctionSource = task.state === "BLOCKED" ? task.blockedFrom : task.state;
    if (correctionSource && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(correctionSource)
      && task.correctionPolicy.used >= task.correctionPolicy.limit) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} has exhausted its correction allowance.`, {
        details: { taskId, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    if (task.lease) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} already has an active writer lease.`, {
        details: { taskId, leaseId: task.lease.id, generation: task.lease.generation }
      });
    }
    for (const other of taskList(state)) {
      const leaseCollisions = other.lease
        ? scopes.filter(scope => other.lease?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const recoveryCollisions = other.id !== taskId && other.recovery?.status === "PENDING"
        ? scopes.filter(scope => other.recovery?.endedLease.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const proposalCollisions = other.id !== taskId && proposalReservesPaths(other) && other.proposal
        ? scopes.filter(scope => scope.access === "write" && other.proposal?.ownedPaths.some(candidate =>
          leaseScopeCoversPath(scope, candidate)
        ))
        : [];
      const collisions = [...leaseCollisions, ...recoveryCollisions, ...proposalCollisions];
      if (collisions.length > 0) {
        throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} write scope overlaps task ${other.id}.`, {
          details: { taskId, conflictingTaskId: other.id, paths: collisions.map(scope => scope.path) }
        });
      }
    }
    if (!context.acknowledgedSnapshot) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "A writer lease requires an acknowledged checkpoint snapshot.", {
        details: { taskId }
      });
    }
    const attributableTerminalPaths = new Set(taskList(state).flatMap(other => {
      if (!other.proposal || (!TERMINAL_STATES.has(other.state) && other.id !== taskId)) return [];
      return snapshotFingerprintForPaths(context.snapshot, other.proposal.ownedPaths) === other.proposal.fingerprint
        ? other.proposal.ownedPaths.map(candidate => candidate.normalize("NFC").toLowerCase())
        : [];
    }));
    const preexistingDrift = explainCheckpointDelta(context.acknowledgedSnapshot, context.snapshot).paths.filter(item => {
      if (!item.staged && !item.unstaged && !item.untracked) return false;
      const affected = deltaPaths(item);
      const touchesWriterScope = affected.some(candidate => scopes.some(scope =>
        scope.access === "write" && leaseScopeCoversPath(scope, candidate)
      ));
      return touchesWriterScope && !affected.every(candidate =>
        attributableTerminalPaths.has(candidate.normalize("NFC").toLowerCase())
      );
    });
    if (preexistingDrift.length > 0) {
      throw new SynodError(ERROR_CODES.LEASE_SCOPE_DRIFT, `Task ${taskId} writer scope contains pre-existing unowned drift.`, {
        details: {
          taskId,
          paths: preexistingDrift.map(item => ({ path: item.path, ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) }))
        }
      });
    }
    task.leaseGeneration += 1;
    const lease: TaskLease = {
      id: randomUUID(),
      generation: task.leaseGeneration,
      taskId,
      taskRevision: task.revision,
      ownerThread: owner,
      executor: task.executor,
      scopes,
      acquiredAt: context.timestamp,
      heartbeatAt: context.timestamp,
      expiresAt: leaseDeadline(context.timestamp, ttl),
      heartbeatIntervalSeconds: heartbeat,
      ttlSeconds: ttl,
      baseline: {
        path: LEASE_BASELINES_PATH,
        snapshotContentHash: context.snapshot.contentHash,
        branch: context.snapshot.branch,
        head: context.snapshot.head,
        worktreeFingerprint: context.snapshot.worktreeFingerprint,
        lastEvent: state.lastEvent
      },
      status: "ACTIVE"
    };
    task.lease = lease;
    delete task.preLease;
    task.updatedAt = context.timestamp;
    const baseline: LeaseBaseline = {
      leaseId: lease.id,
      generation: lease.generation,
      taskId,
      taskRevision: task.revision,
      capturedAt: context.snapshot.capturedAt,
      snapshot: context.snapshot
    };
    const leaseBaselines = retainLeaseBaselinesLedger(validateLeaseBaselinesLedger({
      ...context.leaseBaselines,
      baselines: [...context.leaseBaselines.baselines, baseline]
    }), taskList(state).flatMap(currentTask => [
      ...(currentTask.lease ? [currentTask.lease] : []),
      ...(currentTask.proposal ? [{ id: currentTask.proposal.leaseId, generation: currentTask.proposal.generation }] : []),
      ...(currentTask.recovery?.status === "PENDING"
        ? [{ id: currentTask.recovery.endedLease.id, generation: currentTask.recovery.endedLease.generation }]
        : [])
    ]));
    return {
      leaseBaselines,
      metadata: {
        revision: task.revision,
        payload: { lease, baselineHash: context.snapshot.contentHash }
      },
      result: { task, lease }
    };
  }, dependencies);
}

export interface LeaseIdentityOptions {
  directory?: string;
  id?: string;
  leaseId?: string;
  generation?: number;
  revision?: number;
  expectedHeartbeatAt?: string;
  ownerThread?: string;
  actor?: string;
  reason?: string;
}

export async function heartbeatTaskLease({
  directory = ".",
  id,
  leaseId,
  generation,
  revision,
  expectedHeartbeatAt,
  ownerThread,
  actor = "supervisor"
}: LeaseIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  return commitMutation(path.resolve(directory), "lease.heartbeat", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const lease = requireLeaseIdentity(task, { leaseId, generation, revision, expectedHeartbeatAt, ownerThread });
    if (Date.parse(context.timestamp) >= Date.parse(lease.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, "The writer lease has expired and cannot be renewed by its former owner.", {
        details: { taskId, expiresAt: lease.expiresAt, observedAt: context.timestamp }
      });
    }
    if (Date.parse(context.timestamp) < Date.parse(lease.heartbeatAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, "Lease clock moved behind the last canonical heartbeat.", {
        details: { taskId, heartbeatAt: lease.heartbeatAt, observedAt: context.timestamp }
      });
    }
    lease.heartbeatAt = context.timestamp;
    lease.expiresAt = leaseDeadline(context.timestamp, lease.ttlSeconds);
    task.updatedAt = context.timestamp;
    return {
      metadata: { revision: task.revision, payload: { leaseId: lease.id, generation: lease.generation, expiresAt: lease.expiresAt } },
      result: { task, lease }
    };
  }, dependencies);
}

export async function releaseTaskLease({
  directory = ".",
  id,
  leaseId,
  generation,
  revision,
  expectedHeartbeatAt,
  ownerThread,
  actor = "supervisor"
}: LeaseIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  return commitMutation(path.resolve(directory), "lease.released", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const lease = requireLeaseIdentity(task, { leaseId, generation, revision, expectedHeartbeatAt, ownerThread });
    if (Date.parse(context.timestamp) >= Date.parse(lease.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, "The writer lease has expired and must be ended by the supervisor.", {
        details: { taskId, expiresAt: lease.expiresAt, observedAt: context.timestamp }
      });
    }
    if (task.state === "ACTIVE" || (task.state === "BLOCKED" && task.blockedFrom === "ACTIVE")) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "An executing task lease can be released only by delivery, revocation, or expiry.", {
        details: { taskId, state: task.state }
      });
    }
    delete task.lease;
    task.updatedAt = context.timestamp;
    const leaseBaselines = retainedLeaseBaselines(state, context.leaseBaselines);
    const endedLease: EndedTaskLease = { ...lease, status: "RELEASED" };
    return {
      ...(leaseBaselines ? { leaseBaselines } : {}),
      metadata: { revision: task.revision, payload: { leaseId: lease.id, generation: lease.generation } },
      result: { task, lease: endedLease }
    };
  }, dependencies);
}

async function endTaskLease(
  action: "expire" | "revoke",
  { directory = ".", id, leaseId, generation, revision, expectedHeartbeatAt, actor = "supervisor", reason }: LeaseIdentityOptions = {},
  dependencies: OrchestrationDependencies = {}
) {
  const taskId = taskIdValue(id);
  const explanation = String(reason || "").trim();
  if (!explanation) throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires --reason.`);
  return commitMutation(path.resolve(directory), `lease.${action === "expire" ? "expired" : "revoked"}`, { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const lease = requireLeaseIdentity(task, { leaseId, generation, revision, expectedHeartbeatAt }, { requireOwner: false });
    if (action === "expire" && Date.parse(context.timestamp) < Date.parse(lease.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_NOT_EXPIRED, `Task ${taskId} lease has not reached its expiry deadline.`, {
        details: { taskId, expiresAt: lease.expiresAt, observedAt: context.timestamp }
      });
    }
    const fromState = task.state;
    delete task.lease;
    if (task.state === "ACTIVE") {
      task.state = "BLOCKED";
      task.blockedFrom = "ACTIVE";
      task.blocker = `Writer lease ${action}d: ${explanation}`;
    }
    task.updatedAt = context.timestamp;
    const endedLease: EndedTaskLease = {
      ...lease,
      status: action === "expire" ? "EXPIRED" : "REVOKED"
    };
    if (task.recovery) {
      if (task.recovery.status === "PENDING") {
        throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} already has a pending recovery decision.`, { details: { taskId } });
      }
      task.recoveryHistory = [...(task.recoveryHistory || []), task.recovery];
    }
    task.recovery = {
      status: "PENDING",
      endedLease,
      detectedAt: context.timestamp,
      reason: explanation
    };
    const leaseBaselines = retainedLeaseBaselines(state, context.leaseBaselines);
    return {
      ...(leaseBaselines ? { leaseBaselines } : {}),
      metadata: {
        fromState,
        toState: task.state,
        revision: task.revision,
        payload: { leaseId: lease.id, generation: lease.generation, reason: explanation }
      },
      result: { task, lease: endedLease }
    };
  }, dependencies);
}

export function expireTaskLease(options: LeaseIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  return endTaskLease("expire", options, dependencies);
}

export function revokeTaskLease(options: LeaseIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  return endTaskLease("revoke", options, dependencies);
}

export interface RecoverTaskLeaseOptions extends LeaseIdentityOptions {
  decision?: "resume" | "reassign" | "supersede" | string;
}

export async function recoverTaskLease({
  directory = ".",
  id,
  leaseId,
  generation,
  revision,
  expectedHeartbeatAt,
  ownerThread,
  actor = "supervisor",
  reason,
  decision
}: RecoverTaskLeaseOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const action = String(decision || "").trim().toLowerCase();
  const explanation = String(reason || "").trim();
  if (!(["resume", "reassign", "supersede"] as string[]).includes(action)) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease recovery requires --decision resume, reassign, or supersede.");
  }
  if (!explanation) throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease recovery requires --reason.");
  const requestedOwner = String(ownerThread || "").trim();
  const targetDirectory = path.resolve(directory);
  const recoveryEventType = action === "resume" ? "lease.resumed" : action === "reassign" ? "lease.reassigned" : "lease.superseded";
  const attemptRecovery = () => commitMutation(targetDirectory, recoveryEventType, { actor, taskId }, async (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const fromState = task.state;
    const recovery = task.recovery;
    if (!recovery || recovery.status !== "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} has no pending abandoned-owner recovery.`, {
        details: { taskId, status: recovery?.status }
      });
    }
    const ended = recovery.endedLease;
    if (Date.parse(context.timestamp) < Date.parse(recovery.detectedAt)
      || Date.parse(context.timestamp) < Date.parse(ended.heartbeatAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, "Recovery clock moved behind the ended lease decision.", {
        details: { taskId, detectedAt: recovery.detectedAt, heartbeatAt: ended.heartbeatAt, observedAt: context.timestamp }
      });
    }
    if (
      ended.id !== leaseId
      || ended.generation !== generation
      || ended.taskRevision !== revision
      || ended.heartbeatAt !== expectedHeartbeatAt
    ) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} recovery fence is stale.`, {
        details: {
          taskId,
          expected: { leaseId: ended.id, generation: ended.generation, revision: ended.taskRevision, heartbeatAt: ended.heartbeatAt },
          actual: { leaseId, generation, revision, heartbeatAt: expectedHeartbeatAt }
        }
      });
    }
    const nextOwner = action === "resume" ? ended.ownerThread : requestedOwner;
    if (action === "resume" && requestedOwner && requestedOwner !== ended.ownerThread) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "Resume must retain the abandoned lease owner thread.", {
        details: { taskId, expectedOwnerThread: ended.ownerThread, actualOwnerThread: requestedOwner }
      });
    }
    if (action === "reassign" && (!nextOwner || nextOwner === ended.ownerThread)) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "Reassignment requires a different --owner-thread.", {
        details: { taskId, priorOwnerThread: ended.ownerThread }
      });
    }
    for (const other of taskList(state)) {
      if (other.id === taskId) continue;
      const leaseCollisions = other.lease
        ? ended.scopes.filter(scope => other.lease?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const recoveryCollisions = other.recovery?.status === "PENDING"
        ? ended.scopes.filter(scope => other.recovery?.endedLease.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const proposalCollisions = proposalReservesPaths(other) && other.proposal
        ? ended.scopes.filter(scope => scope.access === "write" && other.proposal?.ownedPaths.some(candidate =>
          leaseScopeCoversPath(scope, candidate)
        ))
        : [];
      const collisions = [...leaseCollisions, ...recoveryCollisions, ...proposalCollisions];
      if (collisions.length > 0) {
        throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} recovery scope overlaps task ${other.id}.`, {
          details: { taskId, conflictingTaskId: other.id, paths: [...new Set(collisions.map(scope => scope.path))] }
        });
      }
    }
    const sealed = await sealTaskProposal(targetDirectory, state, task, ended, task.revision + 1, context, dependencies);
    recovery.proposal = sealed.proposal;

    let nextLease: TaskLease | undefined;
    let leaseBaselines = context.leaseBaselines;
    if (action === "resume" || action === "reassign") {
      task.leaseGeneration += 1;
      nextLease = {
        id: randomUUID(),
        generation: task.leaseGeneration,
        taskId,
        taskRevision: task.revision,
        ownerThread: nextOwner,
        executor: task.executor,
        scopes: ended.scopes,
        acquiredAt: context.timestamp,
        heartbeatAt: context.timestamp,
        expiresAt: leaseDeadline(context.timestamp, ended.ttlSeconds),
        heartbeatIntervalSeconds: ended.heartbeatIntervalSeconds,
        ttlSeconds: ended.ttlSeconds,
        baseline: {
          path: LEASE_BASELINES_PATH,
          snapshotContentHash: context.snapshot.contentHash,
          branch: context.snapshot.branch,
          head: context.snapshot.head,
          worktreeFingerprint: context.snapshot.worktreeFingerprint,
          lastEvent: state.lastEvent
        },
        status: "ACTIVE"
      };
      task.lease = nextLease;
      leaseBaselines = validateLeaseBaselinesLedger({
        ...context.leaseBaselines,
        baselines: [...context.leaseBaselines.baselines, {
          leaseId: nextLease.id,
          generation: nextLease.generation,
          taskId,
          taskRevision: task.revision,
          capturedAt: context.snapshot.capturedAt,
          snapshot: context.snapshot
        }]
      });
    } else {
      task.state = "SUPERSEDED";
      task.supersededReason = explanation;
      delete task.blocker;
      delete task.blockedFrom;
    }
    recovery.status = action === "resume" ? "RESUMED" : action === "reassign" ? "REASSIGNED" : "SUPERSEDED";
    recovery.decision = {
      action: action as "resume" | "reassign" | "supersede",
      actor,
      recordedAt: context.timestamp,
      priorOwnerThread: ended.ownerThread,
      priorGeneration: ended.generation,
      ...(nextLease ? { newOwnerThread: nextLease.ownerThread, newGeneration: nextLease.generation } : {}),
      reason: explanation
    };
    task.updatedAt = context.timestamp;
    const retained = retainedLeaseBaselines(state, leaseBaselines) || leaseBaselines;
    return {
      leaseBaselines: retained,
      metadata: {
        fromState,
        toState: task.state,
        revision: task.revision,
        payload: {
          decision: action,
          priorOwnerThread: ended.ownerThread,
          priorGeneration: ended.generation,
          proposal: { path: sealed.proposal.path, bundleId: sealed.proposal.bundleId },
          foreignPaths: sealed.foreign.map(item => item.path),
          ...(nextLease ? { newOwnerThread: nextLease.ownerThread, newGeneration: nextLease.generation } : {}),
          reason: explanation
        }
      },
      result: { task, recovery, ...(nextLease ? { lease: nextLease } : { lease: ended }) }
    };
  }, dependencies);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return await attemptRecovery();
    } catch (error) {
      if (!(error instanceof SynodError) || error.code !== ERROR_CODES.ORCHESTRATION_LOCKED) throw error;
      await delay(10);
    }
  }
  throw new SynodError(ERROR_CODES.ORCHESTRATION_LOCKED, `Timed out waiting to recover task ${taskId}.`, { details: { taskId } });
}

function requireRevision(task: OrchestrationTask, targetState: TaskState, revision: unknown): asserts revision is number {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new SynodError(ERROR_CODES.REVISION_MISMATCH, "Every transition requires an integer --revision.", {
      details: { taskId: task.id, actual: revision }
    });
  }
  const expected = task.state === "ACTIVE" && targetState === "REVIEW" ? task.revision + 1 : task.revision;
  if (revision !== expected) {
    throw new SynodError(ERROR_CODES.REVISION_MISMATCH, `Task ${task.id} transition requires revision ${expected}, received ${revision}.`, {
      details: { taskId: task.id, expected, actual: revision, current: task.revision, targetState }
    });
  }
}

function requireEvidence(task: OrchestrationTask, targetState: TaskState, evidence: unknown[]): string[] {
  const required = (task.state === "ACTIVE" && targetState === "REVIEW")
    || (task.state === "REVIEW" && targetState === "ACCEPTED")
    || (task.state === "ACCEPTED" && targetState === "VERIFIED")
    || (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state));
  const values = [...new Set((evidence || []).map(value => String(value).trim()).filter(Boolean))];
  if (required && values.length === 0) {
    throw new SynodError(ERROR_CODES.EVIDENCE_REQUIRED, `Transitioning task ${task.id} to ${targetState} requires evidence.`, {
      details: { taskId: task.id, targetState, revision: targetState === "REVIEW" ? task.revision + 1 : task.revision }
    });
  }
  return values;
}

function evidenceKind(fromState: TaskState, targetState: TaskState): EvidenceKind | undefined {
  if (fromState === "ACTIVE" && targetState === "REVIEW") return "delivery";
  if (fromState === "REVIEW" && targetState === "ACCEPTED") return "acceptance";
  if (fromState === "ACCEPTED" && targetState === "VERIFIED") return "verification";
  if (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) return "correction";
  return undefined;
}

function recordEvidence(
  state: OrchestrationState,
  task: OrchestrationTask,
  kind: EvidenceKind,
  revision: number,
  references: string[],
  actor: string,
  context: MutationContext
): TaskEvidence[] {
  const created: TaskEvidence[] = [];
  for (const reference of references) {
    state.evidenceCounter += 1;
    const item = {
      id: `E-${String(state.evidenceCounter).padStart(6, "0")}`,
      kind,
      revision,
      reference,
      actor,
      recordedAt: context.timestamp,
      checkpoint: {
        branch: context.checkpoint.branch,
        head: context.checkpoint.head,
        worktreeFingerprint: context.checkpoint.worktree.fingerprint
      }
    };
    task.evidence.push(item);
    created.push(item);
  }
  return created;
}

function resetAcceptanceAndVerification(task: OrchestrationTask): void {
  task.acceptance = { ...task.acceptance, status: "pending", revision: null, evidenceIds: [] };
  task.verification = { ...task.verification, status: "pending", revision: null, evidenceIds: [] };
}

export interface TransitionTaskOptions {
  directory?: string;
  id?: string;
  to?: string;
  revision?: number | undefined;
  evidence?: unknown[];
  actor?: string;
  reason?: string | undefined;
}

export async function transitionTask({
  directory = ".",
  id,
  to,
  revision,
  evidence = [],
  actor = "supervisor",
  reason
}: TransitionTaskOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const targetStateValue = String(to || "").trim().toUpperCase();
  if (!isTaskState(targetStateValue)) {
    throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Unknown task state: ${targetStateValue}`, {
      details: { taskId, targetState: targetStateValue, allowedStates: TASK_STATES }
    });
  }
  const targetState = targetStateValue;
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "task.transitioned", { actor, taskId }, async (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (task.recovery?.status === "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} requires an explicit abandoned-owner recovery decision before any transition.`, {
        details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
      });
    }
    if (!TRANSITIONS[task.state].has(targetState)) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} cannot transition from ${task.state} to ${targetState}.`, {
        details: { taskId, fromState: task.state, targetState, allowed: [...TRANSITIONS[task.state]] }
      });
    }
    if (targetState === "ACTIVE"
      && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)
      && task.correctionPolicy.used >= task.correctionPolicy.limit) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} has exhausted its correction allowance.`, {
        details: { taskId, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    if (task.state === "BLOCKED" && targetState !== "SUPERSEDED" && targetState !== task.blockedFrom) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Blocked task ${taskId} must resume ${task.blockedFrom}, not ${targetState}.`, {
        details: { taskId, blockedFrom: task.blockedFrom, targetState }
      });
    }
    if (task.preLease && !["BLOCKED", "SUPERSEDED"].includes(targetState)) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} was migrated from schema 1 and must acquire a writer lease before further progress.`, {
        details: { taskId, state: task.state, targetState }
      });
    }
    requireRevision(task, targetState, revision);
    const references = requireEvidence(task, targetState, evidence);
    if (["BLOCKED", "SUPERSEDED"].includes(targetState) && !String(reason || "").trim()) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `${targetState} requires --reason.`, {
        details: { taskId, targetState }
      });
    }
    if (targetState === "READY") {
      const incomplete = task.dependsOn.filter(dependency => state.tasks[dependency]?.state !== "DONE");
      if (incomplete.length > 0) {
        throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} has incomplete dependencies.`, {
          details: { taskId, incomplete }
        });
      }
    }
    if (targetState === "ACTIVE" && !task.lease) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} requires an active writer lease before execution.`, {
        details: { taskId, revision: task.revision }
      });
    }
    if (
      task.lease
      && (targetState === "ACTIVE" || (task.state === "ACTIVE" && targetState === "REVIEW"))
      && Date.parse(context.timestamp) >= Date.parse(task.lease.expiresAt)
    ) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} writer lease has expired.`, {
        details: { taskId, leaseId: task.lease.id, generation: task.lease.generation, expiresAt: task.lease.expiresAt }
      });
    }
    if (["ACCEPTED", "VERIFIED", "DONE"].includes(targetState) && task.lease) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} must release its reserved writer lease before ${targetState}.`, {
        details: { taskId, leaseId: task.lease.id, generation: task.lease.generation }
      });
    }

    const fromState = task.state;
    const deliveredLease = fromState === "ACTIVE" && targetState === "REVIEW" ? task.lease : undefined;
    const releasedLease = deliveredLease
      || (targetState === "BLOCKED" && fromState !== "ACTIVE" ? task.lease : undefined);
    if (fromState === "ACTIVE" && targetState === "REVIEW" && !deliveredLease) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} cannot deliver without its active writer lease.`, {
        details: { taskId, revision }
      });
    }
    const sealed = deliveredLease
      ? await sealTaskProposal(targetDirectory, state, task, deliveredLease, revision, context, dependencies)
      : undefined;
    const acceptanceForeign = fromState === "REVIEW" && targetState === "ACCEPTED"
      ? await verifyTaskProposalForAcceptance(targetDirectory, state, task, context)
      : [];
    if (sealed) task.proposal = sealed.proposal;
    if (fromState === "ACTIVE" && targetState === "REVIEW") task.revision = revision;
    const kind = evidenceKind(fromState, targetState);
    const createdEvidence = kind
      ? recordEvidence(state, task, kind, revision, references, actor, context)
      : [];

    if (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) {
      task.correctionRound += 1;
      task.correctionPolicy.used += 1;
      resetAcceptanceAndVerification(task);
      delete task.proposal;
    }
    if (fromState === "REVIEW" && targetState === "ACCEPTED") {
      task.acceptance = {
        ...task.acceptance,
        status: "accepted",
        revision,
        evidenceIds: createdEvidence.map(item => item.id)
      };
      task.verification = { ...task.verification, status: "pending", revision: null, evidenceIds: [] };
    }
    if (fromState === "ACCEPTED" && targetState === "VERIFIED") {
      if (task.acceptance.status !== "accepted" || task.acceptance.revision !== revision) {
        throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} has no acceptance for revision ${revision}.`, {
          details: { taskId, revision }
        });
      }
      task.verification = {
        ...task.verification,
        status: "passed",
        revision,
        evidenceIds: createdEvidence.map(item => item.id)
      };
    }
    if (targetState === "DONE" && (
      task.acceptance.status !== "accepted" || task.acceptance.revision !== revision
      || task.verification.status !== "passed" || task.verification.revision !== revision
    )) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} cannot finish without acceptance and verification for revision ${revision}.`, {
        details: { taskId, revision }
      });
    }

    task.state = targetState;
    if (releasedLease || targetState === "SUPERSEDED") delete task.lease;
    task.updatedAt = context.timestamp;
    if (targetState === "BLOCKED") {
      task.blocker = String(reason).trim();
      task.blockedFrom = fromState;
    } else {
      delete task.blocker;
      delete task.blockedFrom;
    }
    if (targetState === "SUPERSEDED") task.supersededReason = String(reason).trim();

    const leaseBaselines = releasedLease || targetState === "DONE" || targetState === "SUPERSEDED"
      ? retainedLeaseBaselines(state, context.leaseBaselines)
      : undefined;
    return {
      ...(leaseBaselines ? { leaseBaselines } : {}),
      metadata: {
        fromState,
        toState: targetState,
        revision: task.revision,
        payload: {
          correctionRound: task.correctionRound,
          evidenceIds: createdEvidence.map(item => item.id),
          ...(sealed ? {
            proposal: {
              path: sealed.proposal.path,
              bundleId: sealed.proposal.bundleId,
              leaseId: sealed.proposal.leaseId,
              generation: sealed.proposal.generation,
              fingerprint: sealed.proposal.fingerprint
            },
            foreignPaths: sealed.foreign.map(item => item.path)
          } : {}),
          ...(acceptanceForeign.length > 0 ? { foreignPaths: acceptanceForeign.map(item => item.path) } : {}),
          ...(releasedLease ? { releasedLease: { id: releasedLease.id, generation: releasedLease.generation } } : {}),
          ...(reason ? { reason: String(reason).trim() } : {})
        }
      },
      result: { task, evidence: createdEvidence }
    };
  }, dependencies);
}

export async function recordCheckpoint(
  { directory = ".", actor = "supervisor", message }: { directory?: string; actor?: string; message?: string } = {},
  dependencies: OrchestrationDependencies = {}
) {
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "checkpoint.recorded", { actor }, (_state, context) => ({
    updateCheckpoint: true,
    metadata: { payload: { ...(message ? { message: String(message).trim() } : {}) } },
    result: { checkpoint: context.checkpoint }
  }), dependencies);
}

export async function orchestrationStatus(
  { directory = ".", explain = false, readOnly = false }: { directory?: string; explain?: boolean; readOnly?: boolean } = {},
  dependencies: OrchestrationDependencies = {}
): Promise<OrchestrationStatusResult> {
  const targetDirectory = path.resolve(directory);
  const release = await acquireLock(targetDirectory);
  let state: OrchestrationState;
  let events: OrchestrationEvent[];
  let markdown: string;
  let currentCheckpoint: GitCheckpoint;
  let delta: CheckpointDelta | undefined;
  try {
    if (readOnly) {
      const pending = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
      if (pending.type !== "missing") {
        throw new SynodError(
          ERROR_CODES.ORCHESTRATION_STATE_INVALID,
          "Pending orchestration recovery is required; refusing to mutate records during read-only validation.",
          { details: { path: ORCHESTRATION_PENDING_PATH, type: pending.type } }
        );
      }
    } else await recoverPendingMutation(targetDirectory);
    const canonical = await readOrchestrationRaw(targetDirectory);
    ({ state, events } = canonical);
    markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
    const current = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
    currentCheckpoint = current.checkpoint;
    if (explain) {
      if (!canonical.snapshot) {
        throw new SynodError(
          ERROR_CODES.CHECKPOINT_SNAPSHOT_UNAVAILABLE,
          "This historical checkpoint has no normalized snapshot. Record a new checkpoint before requesting a path delta.",
          { details: { checkpoint: state.checkpoint } }
        );
      }
      delta = explainCheckpointDelta(canonical.snapshot, current.snapshot);
      if (state.checkpoint.head !== currentCheckpoint.head && (state.checkpoint.head || currentCheckpoint.head)) {
        const gitRunner = dependencies.gitRunner || defaultGitRunner;
        try {
          if (state.checkpoint.head) {
            await gitRunner(targetDirectory, ["cat-file", "-e", `${state.checkpoint.head}^{commit}`]);
          }
          const committedArgs = state.checkpoint.head && currentCheckpoint.head
            ? [state.checkpoint.head, currentCheckpoint.head, "--", "."]
            : ["--root", "--no-commit-id", "-r", currentCheckpoint.head || state.checkpoint.head || "", "--", "."];
          const command = state.checkpoint.head && currentCheckpoint.head ? "diff" : "diff-tree";
          const [committed, committedNumstat] = await Promise.all([
            gitRunner(targetDirectory, [
              command,
              "--no-ext-diff",
              "--no-textconv",
              "--name-status",
              "-z",
              "-M",
              ...committedArgs
            ]),
            gitRunner(targetDirectory, [
              command,
              "--no-ext-diff",
              "--no-textconv",
              "--numstat",
              "-z",
              "-M",
              ...committedArgs
            ])
          ]);
          const committedBinary = binaryPathsFromNumstat(committedNumstat);
          const reverseRoot = Boolean(state.checkpoint.head && !currentCheckpoint.head);
          const committedChanges = await filterCommittedCheckpointChanges(
            targetDirectory,
            parseCommittedChanges(committed),
            state.checkpoint.head,
            currentCheckpoint.head,
            gitRunner
          );
          delta = addCommittedCheckpointChanges(delta, committedChanges.map(change => ({
            ...change,
            ...(reverseRoot ? { kind: "deleted" as const } : {}),
            ...(committedBinary.has(change.path) ? { binary: true } : {})
          })));
        } catch (error) {
          throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "The checkpoint Git base is unavailable for path-level comparison.", {
            cause: error,
            details: { head: state.checkpoint.head }
          });
        }
      }
    }
  } finally {
    await release();
  }
  const expectedMarkdown = renderStatusMarkdown(state);
  if (contentHash(markdown) !== contentHash(expectedMarkdown)) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Generated Markdown status does not match canonical orchestration state.", {
      details: {
        path: ORCHESTRATION_STATUS_PATH,
        expectedHash: contentHash(expectedMarkdown),
        actualHash: contentHash(markdown)
      }
    });
  }
  const drift = checkpointDrift(state.checkpoint, currentCheckpoint);
  const counts: Record<TaskState, number> = {
    PLANNED: 0,
    READY: 0,
    ACTIVE: 0,
    REVIEW: 0,
    ACCEPTED: 0,
    VERIFIED: 0,
    DONE: 0,
    BLOCKED: 0,
    SUPERSEDED: 0
  };
  for (const task of taskList(state)) counts[task.state] += 1;
  const leaseExpiryCandidates = taskList(state).flatMap(task => task.lease && Date.parse(currentCheckpoint.capturedAt) >= Date.parse(task.lease.expiresAt)
    ? [{
        taskId: task.id,
        leaseId: task.lease.id,
        generation: task.lease.generation,
        heartbeatAt: task.lease.heartbeatAt,
        expiresAt: task.lease.expiresAt
      }]
    : []);
  return {
    targetDirectory,
    healthy: !drift.detected,
    stateSchemaVersion: state.schemaVersion,
    templateVersion: state.templateVersion,
    updatedAt: state.updatedAt,
    lastEvent: state.lastEvent,
    eventCount: events.length,
    checkpoint: state.checkpoint,
    currentCheckpoint,
    drift,
    taskCounts: counts,
    tasks: taskList(state),
    leaseExpiryCandidates,
    markdownView: ORCHESTRATION_STATUS_PATH,
    ...(delta ? { delta } : {})
  };
}

export async function validateOrchestrationReadOnly(
  { directory = "." }: { directory?: string } = {}
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[]; snapshot?: CheckpointSnapshot }> {
  const targetDirectory = path.resolve(directory);
  const canonical = await validateCanonicalOrchestrationReadOnly(targetDirectory);
  const markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
  const expectedMarkdown = renderStatusMarkdown(canonical.state);
  if (contentHash(markdown) !== contentHash(expectedMarkdown)) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Generated Markdown status does not match canonical orchestration state.", {
      details: {
        path: ORCHESTRATION_STATUS_PATH,
        expectedHash: contentHash(expectedMarkdown),
        actualHash: contentHash(markdown)
      }
    });
  }
  return canonical;
}

async function validateCanonicalOrchestrationReadOnly(
  targetDirectory: string
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[]; snapshot?: CheckpointSnapshot }> {
  const pending = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  if (pending.type !== "missing") {
    throw new SynodError(
      ERROR_CODES.ORCHESTRATION_STATE_INVALID,
      "Pending orchestration recovery is required; refusing to mutate records during read-only validation.",
      { details: { path: ORCHESTRATION_PENDING_PATH, type: pending.type } }
    );
  }
  const { state, events, snapshot } = await readOrchestrationRaw(targetDirectory);
  return { state, events, ...(snapshot ? { snapshot } : {}) };
}

export async function withValidatedCheckpointSource<Result>(
  { directory = "." }: { directory?: string } = {},
  dependencies: OrchestrationDependencies,
  action: (source: ValidatedCheckpointSource) => Promise<Result>
): Promise<Result> {
  const targetDirectory = path.resolve(directory);
  const release = await acquireLock(targetDirectory);
  try {
    const pending = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
    if (pending.type !== "missing") {
      throw new SynodError(
        ERROR_CODES.ORCHESTRATION_STATE_INVALID,
        "Pending orchestration recovery is required; refusing to mutate records during read-only validation.",
        { details: { path: ORCHESTRATION_PENDING_PATH, type: pending.type } }
      );
    }
    const canonical = await readOrchestrationRaw(targetDirectory);
    const markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
    const expectedMarkdown = renderStatusMarkdown(canonical.state);
    if (contentHash(markdown) !== contentHash(expectedMarkdown)) {
      throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Generated Markdown status does not match canonical orchestration state.", {
        details: {
          path: ORCHESTRATION_STATUS_PATH,
          expectedHash: contentHash(expectedMarkdown),
          actualHash: contentHash(markdown)
        }
      });
    }
    if (!canonical.snapshot) {
      throw new SynodError(
        ERROR_CODES.CHECKPOINT_SNAPSHOT_UNAVAILABLE,
        "This historical checkpoint has no normalized snapshot. Record a new checkpoint before exporting recovery material.",
        { details: { checkpoint: canonical.state.checkpoint } }
      );
    }
    const current = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
    const drift = checkpointDrift(canonical.state.checkpoint, current.checkpoint);
    if (drift.detected) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_DRIFT, "The live checkout no longer matches the acknowledged checkpoint.", {
        details: { drift }
      });
    }
    return await action({
      targetDirectory,
      state: canonical.state,
      events: canonical.events,
      snapshot: canonical.snapshot,
      current
    });
  } finally {
    await release();
  }
}

export function formatOrchestrationStatus(result: OrchestrationStatusResult): string {
  const lines = [`Synod orchestration: ${result.healthy ? "in sync" : "checkpoint drift detected"}`];
  lines.push(`State schema: ${result.stateSchemaVersion}; events: ${result.eventCount}`);
  lines.push(`Checkpoint: ${checkpointLabel(result.checkpoint)}`);
  lines.push(`Current: ${checkpointLabel(result.currentCheckpoint)}`);
  for (const task of result.tasks) {
    const lease = task.lease
      ? `lease ${task.lease.id} g${task.lease.generation} owner ${task.lease.ownerThread} expires ${task.lease.expiresAt}`
      : task.preLease ? "lease migration required" : "no writer lease";
    const recovery = task.recovery
      ? `; recovery ${task.recovery.status} prior ${task.recovery.endedLease.ownerThread} g${task.recovery.endedLease.generation} proposal ${task.recovery.proposal?.bundleId || "unsealed"}`
      : "";
    lines.push(`${task.id.padEnd(12)} ${task.state.padEnd(10)} r${task.revision} corrections ${task.correctionPolicy.used}/${task.correctionPolicy.limit} executor ${task.executor}; acceptance ${task.acceptance.status}; verification ${task.verification.status}; ${lease}${recovery}`);
  }
  for (const candidate of result.leaseExpiryCandidates) {
    lines.push(`Expiry candidate: ${candidate.taskId} lease ${candidate.leaseId} g${candidate.generation}; heartbeat ${candidate.heartbeatAt}; expired ${candidate.expiresAt}`);
  }
  if (result.tasks.length === 0) lines.push("No tasks recorded.");
  for (const reason of result.drift.reasons) lines.push(`Drift ${reason.field}: expected ${reason.expected}, actual ${reason.actual}`);
  if (result.delta) lines.push(...formatCheckpointDelta(result.delta));
  return lines.join("\n");
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
