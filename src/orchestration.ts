import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, readlink, unlink } from "node:fs/promises";
import path from "node:path";
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
  type TransactionHooks,
  unsafeAncestor
} from "./filesystem.js";
import { packageName, packageVersion } from "./package.js";
import { generatedConfigMarker, removeAgentsBlocks } from "./templates.js";
import { errorCode, errorMessage, isRecord, parseJson } from "./validation.js";

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const ORCHESTRATION_STATE_PATH = ".synod/state.json";
export const ORCHESTRATION_EVENTS_PATH = ".synod/events.jsonl";
export const ORCHESTRATION_STATUS_PATH = "docs/synod/STATUS.md";
const ORCHESTRATION_LOCK_PATH = ".synod/orchestration.lock";
const ORCHESTRATION_PENDING_PATH = ".synod/pending-mutation.json";

export const TASK_STATES = [
  "PLANNED",
  "READY",
  "ACTIVE",
  "REVIEW",
  "ACCEPTED",
  "VERIFIED",
  "DONE",
  "BLOCKED",
  "SUPERSEDED"
] as const;

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

export interface OrchestrationTask {
  id: string;
  objective: string;
  dependsOn: string[];
  state: TaskState;
  revision: number;
  executor: string;
  correctionRound: number;
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
  nextSequence: number;
}

interface MutationResult<Result extends Record<string, unknown>> {
  updateCheckpoint?: boolean;
  metadata?: Partial<EventMetadata>;
  result: Result;
}

interface CheckpointPathRecord {
  type: "file" | "symlink" | "directory" | "other" | "ignored" | "missing";
  contentHash?: string;
  gitHead?: string;
  worktreeFingerprint?: string;
}

interface RawIndexEntry {
  mode: string;
  objectId: string;
  stage: number;
}

interface CheckpointIndexEntry {
  mode: string;
  stage: number;
  objectId?: string;
  type?: "file" | "ignored";
  contentHash?: string;
}

interface WorktreeRecord extends CheckpointPathRecord {
  status: string;
  path: string;
  sourcePath?: string;
  index?: CheckpointIndexEntry[];
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
  markdownView: string;
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
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
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
      return { type: "file", contentHash: sha256Bytes(filtered === null ? content : filtered) };
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
  gitRunner: GitRunner
): Promise<WorktreeRecord[]> {
  const stagedIndex = indexRecords(indexOutput);
  const fields = porcelain.split("\0");
  const records: WorktreeRecord[] = [];
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
  return records.sort((left, right) => `${left.path}\0${left.sourcePath || ""}`.localeCompare(`${right.path}\0${right.sourcePath || ""}`));
}

export async function captureGitCheckpoint(directory: string, {
  clock,
  gitRunner = defaultGitRunner,
  checkpointOverlay = new Map()
}: OrchestrationDependencies = {}): Promise<GitCheckpoint> {
  const capturedAt = nowIso(clock);
  const inside = await optionalGit(gitRunner, directory, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    return {
      capturedAt,
      available: false,
      branch: null,
      head: null,
      worktree: { clean: true, entries: 0, fingerprint: sha256("[]") }
    };
  }

  const [head, branch, porcelain, index] = await Promise.all([
    optionalGit(gitRunner, directory, ["rev-parse", "HEAD"]),
    optionalGit(gitRunner, directory, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitRunner(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    gitRunner(directory, ["ls-files", "--stage", "-z", "--", "."])
  ]);
  const records = await worktreeRecords(directory, porcelain, index, checkpointOverlay, gitRunner);
  return {
    capturedAt,
    available: true,
    branch,
    head,
    worktree: {
      clean: records.length === 0,
      entries: records.length,
      fingerprint: sha256(stableStringify(records))
    }
  };
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

function initialState(checkpoint: GitCheckpoint, timestamp: string): OrchestrationStateCore {
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoint,
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
  const checkpoint = await captureGitCheckpoint(targetDirectory, dependencies);
  const core = initialState(checkpoint, timestamp);
  const { event, state } = buildEvent(undefined, core, "project.initialized", {
    actor: "synod",
    payload: { templateVersion: packageVersion }
  });
  return new Map([
    [ORCHESTRATION_STATE_PATH, serializeJson(state)],
    [ORCHESTRATION_EVENTS_PATH, `${JSON.stringify(event)}\n`],
    [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(state)]
  ]);
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

function isGitCheckpoint(value: unknown): value is GitCheckpoint {
  return isRecord(value)
    && typeof value.capturedAt === "string"
    && typeof value.available === "boolean"
    && isNullableString(value.branch)
    && isNullableString(value.head)
    && isRecord(value.worktree)
    && typeof value.worktree.clean === "boolean"
    && isNonNegativeInteger(value.worktree.entries)
    && typeof value.worktree.fingerprint === "string";
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
    && (value.supersededReason === undefined || typeof value.supersededReason === "string");
}

function isOrchestrationStateCoreShape(value: unknown): value is OrchestrationStateCore {
  return isRecord(value)
    && value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION
    && typeof value.templateVersion === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isGitCheckpoint(value.checkpoint)
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
    for (const dependency of task.dependsOn) {
      if (!state.tasks[dependency] || dependency === id) invalidState(`Task ${id} has an invalid dependency.`, { taskId: id, dependency });
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

function validateEventLog(events: unknown[]): OrchestrationEvent[] {
  let previousHash = null;
  const validated: OrchestrationEvent[] = [];
  for (const [index, event] of events.entries()) {
    if (
      !isOrchestrationEvent(event) || event.sequence !== index + 1
      || event.previousHash !== previousHash || event.eventHash !== eventHash(event)
    ) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log failed sequence or hash-chain validation.", {
        details: { sequence: isRecord(event) ? event.sequence : undefined, expectedSequence: index + 1 }
      });
    }
    validateOrchestrationState({
      ...event.state,
      lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
    });
    previousHash = event.eventHash;
    validated.push(event);
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

async function readOrchestrationRaw(
  targetDirectory: string
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[] }> {
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
  return { state, events };
}

export async function readOrchestration(
  targetDirectory: string
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[] }> {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    return await readOrchestrationRaw(targetDirectory);
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
}

function isPendingMutation(value: unknown): value is PendingMutation {
  return isRecord(value)
    && value.schemaVersion === ORCHESTRATION_SCHEMA_VERSION
    && isOrchestrationEvent(value.event)
    && isOrchestrationStateShape(value.state)
    && typeof value.status === "string"
    && typeof value.expectedStateHash === "string"
    && typeof value.expectedStatusHash === "string";
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
  const nextStateContent = serializeJson(pending.state);
  const nextStateHash = contentHash(nextStateContent);
  const nextStatusHash = contentHash(pending.status);
  if (stateInspected.hash !== nextStateHash || statusInspected.hash !== nextStatusHash) {
    if (
      ![pending.expectedStateHash, nextStateHash].includes(stateInspected.hash)
      || ![pending.expectedStatusHash, nextStatusHash].includes(statusInspected.hash)
    ) {
      throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, "Canonical orchestration files changed while recovering a pending mutation.", {
        details: {
          state: { expected: pending.expectedStateHash, actual: stateInspected.hash },
          status: { expected: pending.expectedStatusHash, actual: statusInspected.hash }
        }
      });
    }
    await applyTransaction(targetDirectory, [
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
    ]);
  }
  await unlink(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  return true;
}

async function commitMutation<Result extends Record<string, unknown>>(
  targetDirectory: string,
  type: string,
  metadata: EventMetadata,
  reducer: (state: OrchestrationState, context: MutationContext) => MutationResult<Result>,
  dependencies: OrchestrationDependencies = {}
): Promise<{ state: OrchestrationState; event: OrchestrationEvent } & Result> {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    const { state: current } = await readOrchestrationRaw(targetDirectory);
    const timestamp = nowIso(dependencies.clock);
    const checkpoint = await captureGitCheckpoint(targetDirectory, dependencies);
    const draft = structuredClone(current);
    const reducerResult = reducer(draft, {
      timestamp,
      checkpoint,
      nextSequence: current.lastEvent.sequence + 1
    }) || {};
    draft.updatedAt = timestamp;
    if (reducerResult.updateCheckpoint) draft.checkpoint = checkpoint;
    validateOrchestrationState(draft);

    const eventMetadata: EventMetadata = {
      ...metadata,
      ...reducerResult.metadata,
      actor: reducerResult.metadata?.actor ?? metadata.actor,
      checkpoint
    };
    const { event, state } = buildEvent(current, stateCore(draft), type, eventMetadata);
    const stateInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATE_PATH));
    const statusInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATUS_PATH));
    if (stateInspected.type !== "file" || statusInspected.type !== "file") {
      throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration state or its Markdown view is missing.");
    }

    const nextStateContent = serializeJson(state);
    const nextStatusContent = renderStatusMarkdown(state);
    const pending = {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      event,
      state,
      status: nextStatusContent,
      expectedStateHash: stateInspected.hash,
      expectedStatusHash: statusInspected.hash
    };
    await applyTransaction(targetDirectory, [{
      action: "write",
      path: ORCHESTRATION_PENDING_PATH,
      content: serializeJson(pending),
      expected: { type: "missing" }
    }], dependencies);
    try {
      await appendEvent(targetDirectory, event);
      await applyTransaction(targetDirectory, [
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
      ], dependencies);
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
  actor = "supervisor"
}: AddTaskOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const taskObjective = String(objective || "").trim();
  const taskExecutor = String(executor || "").trim();
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(taskId) || !taskObjective || !taskExecutor) {
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
  return commitMutation(targetDirectory, "task.transitioned", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (!TRANSITIONS[task.state].has(targetState)) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} cannot transition from ${task.state} to ${targetState}.`, {
        details: { taskId, fromState: task.state, targetState, allowed: [...TRANSITIONS[task.state]] }
      });
    }
    if (task.state === "BLOCKED" && targetState !== "SUPERSEDED" && targetState !== task.blockedFrom) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Blocked task ${taskId} must resume ${task.blockedFrom}, not ${targetState}.`, {
        details: { taskId, blockedFrom: task.blockedFrom, targetState }
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

    const fromState = task.state;
    if (fromState === "ACTIVE" && targetState === "REVIEW") task.revision = revision;
    const kind = evidenceKind(fromState, targetState);
    const createdEvidence = kind
      ? recordEvidence(state, task, kind, revision, references, actor, context)
      : [];

    if (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) {
      task.correctionRound += 1;
      resetAcceptanceAndVerification(task);
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
    task.updatedAt = context.timestamp;
    if (targetState === "BLOCKED") {
      task.blocker = String(reason).trim();
      task.blockedFrom = fromState;
    } else {
      delete task.blocker;
      delete task.blockedFrom;
    }
    if (targetState === "SUPERSEDED") task.supersededReason = String(reason).trim();

    return {
      metadata: {
        fromState,
        toState: targetState,
        revision: task.revision,
        payload: {
          correctionRound: task.correctionRound,
          evidenceIds: createdEvidence.map(item => item.id),
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
  { directory = "." }: { directory?: string } = {},
  dependencies: OrchestrationDependencies = {}
): Promise<OrchestrationStatusResult> {
  const targetDirectory = path.resolve(directory);
  const release = await acquireLock(targetDirectory);
  let state: OrchestrationState;
  let events: OrchestrationEvent[];
  let markdown: string;
  let currentCheckpoint: GitCheckpoint;
  try {
    await recoverPendingMutation(targetDirectory);
    ({ state, events } = await readOrchestrationRaw(targetDirectory));
    markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
    currentCheckpoint = await captureGitCheckpoint(targetDirectory, dependencies);
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
    markdownView: ORCHESTRATION_STATUS_PATH
  };
}

export async function validateOrchestrationReadOnly(
  { directory = "." }: { directory?: string } = {}
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[] }> {
  const targetDirectory = path.resolve(directory);
  const pending = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  if (pending.type !== "missing") {
    throw new SynodError(
      ERROR_CODES.ORCHESTRATION_STATE_INVALID,
      "Pending orchestration recovery is required; refusing to mutate records during read-only validation.",
      { details: { path: ORCHESTRATION_PENDING_PATH, type: pending.type } }
    );
  }
  const { state, events } = await readOrchestrationRaw(targetDirectory);
  const markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
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
  return { state, events };
}

export function formatOrchestrationStatus(result: OrchestrationStatusResult): string {
  const lines = [`Synod orchestration: ${result.healthy ? "in sync" : "checkpoint drift detected"}`];
  lines.push(`State schema: ${result.stateSchemaVersion}; events: ${result.eventCount}`);
  lines.push(`Checkpoint: ${checkpointLabel(result.checkpoint)}`);
  lines.push(`Current: ${checkpointLabel(result.currentCheckpoint)}`);
  for (const task of result.tasks) {
    lines.push(`${task.id.padEnd(12)} ${task.state.padEnd(10)} r${task.revision} correction ${task.correctionRound} executor ${task.executor}; acceptance ${task.acceptance.status}; verification ${task.verification.status}`);
  }
  if (result.tasks.length === 0) lines.push("No tasks recorded.");
  for (const reason of result.drift.reasons) lines.push(`Drift ${reason.field}: expected ${reason.expected}, actual ${reason.actual}`);
  return lines.join("\n");
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
