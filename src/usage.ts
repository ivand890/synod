import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { CodexAppServerClient } from "./app-server.js";
import type { AppServerDiagnostics } from "./app-server.js";
import type { Warning } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { validateOrchestrationReadOnly } from "./orchestration.js";
import type { GitCheckpoint, OrchestrationEvent } from "./orchestration.js";
import { isRecord, parseJson } from "./validation.js";

const ALL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

const INTERACTIVE_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];

const TOKEN_FIELDS = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
  total_tokens: "totalTokens"
} as const;

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadRecord {
  id: string;
  parentThreadId: string | null;
  path?: string;
  cwd?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UsageModelRow extends TokenUsage {
  model: string;
  threads: number;
}

export interface UsageAttributionRow extends TokenUsage {
  threadId: string;
  parentThreadId: string | null;
  model: string;
  role: string;
  source: string;
}

export interface UsageRoleRow extends TokenUsage {
  role: string;
  threads: number;
}

export interface RolloutIdentity {
  bytes: number;
  sha256: string;
  lastObservedAt?: string;
}

export interface UsageThreadRow extends TokenUsage {
  threadId: string;
  parentThreadId: string | null;
  role: string;
  source: string;
  models: number;
  rollout: RolloutIdentity;
  activity: {
    turnsStarted: number;
    turnsCompleted: number;
    turnsAborted: number;
    compactions: number;
  };
  currentContext?: {
    observedAt: string;
    inputTokens: number;
    modelContextWindow: number;
  };
}

export type UsageBoundary = {
  kind: "event" | "checkpoint" | "task";
  timestamp: string;
  event: { sequence: number; id: string; hash: string; type: string };
  checkpoint?: {
    fingerprint: string;
    snapshotHash?: string;
    capturedAt: string;
  };
  taskId?: string;
};

export interface UsageInterval {
  inclusion: "(start,end]";
  start: UsageBoundary;
  end: UsageBoundary | { kind: "capture"; timestamp: string };
  complete: boolean;
}

export interface UsageCompleteness {
  status: "complete" | "incomplete";
  reasons: string[];
}

export interface UsageReport {
  session: {
    threadId: string;
    cwd?: string | undefined;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  capturedAt: string;
  models: UsageModelRow[];
  roles: UsageRoleRow[];
  threads: UsageThreadRow[];
  attribution: UsageAttributionRow[];
  total: TokenUsage & { threads: number };
  completeness: UsageCompleteness;
  interval?: UsageInterval;
  warnings: Warning[];
  diagnostics: AppServerDiagnostics | Record<string, unknown>;
}

export interface UsageIntervalOptions {
  sinceEvent?: string;
  sinceCheckpoint?: boolean;
  taskId?: string;
  untilEvent?: string;
}

export interface UsageClient {
  start(): Promise<void>;
  close(): Promise<unknown>;
  request?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  probeCapabilities?(): Promise<unknown>;
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
  getWarnings?(): Warning[];
}

function requestClient(
  client: UsageClient,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!client.request) {
    throw new SynodError(ERROR_CODES.APP_SERVER_PROTOCOL_ERROR, "Codex App Server client does not support requests.", {
      details: { method }
    });
  }
  return client.request(method, params);
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.parentThreadId === null || typeof value.parentThreadId === "string")
    && (value.path === undefined || typeof value.path === "string")
    && (value.cwd === undefined || typeof value.cwd === "string");
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  for (const field of Object.values(TOKEN_FIELDS)) target[field] += usage[field];
}

function normalizeUsage(raw: Record<string, unknown> = {}): TokenUsage {
  const usage = emptyUsage();
  for (const [source, target] of Object.entries(TOKEN_FIELDS)) {
    const value = Number(raw[source]);
    usage[target] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return usage;
}

function usageDelta(current: TokenUsage, previous: TokenUsage): { usage: TokenUsage; reset: boolean } {
  const reset = Object.values(TOKEN_FIELDS).some(field => current[field] < previous[field]);
  const delta = emptyUsage();
  for (const field of Object.values(TOKEN_FIELDS)) {
    delta[field] = reset ? current[field] : Math.max(0, current[field] - previous[field]);
  }
  return { usage: delta, reset };
}

function reroutedModel(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.type === "model_rerouted") {
    if (typeof payload.to_model === "string") return payload.to_model;
    if (typeof payload.toModel === "string") return payload.toModel;
  }
  if (payload.type === "model/rerouted") {
    if (typeof payload.toModel === "string") return payload.toModel;
    if (typeof payload.to_model === "string") return payload.to_model;
  }
  return undefined;
}

export async function readRolloutUsage(
  rolloutPath: string,
  { openStream = createReadStream }: {
    openStream?: (path: string) => NodeJS.ReadableStream;
  } = {}
): Promise<Map<string, TokenUsage>> {
  const timeline = await readRolloutTimeline(rolloutPath, { openStream });
  const byModel = new Map<string, TokenUsage>();
  for (const observation of timeline.tokens) {
    if (isZeroUsage(observation.usage)) continue;
    const usage = byModel.get(observation.model) || emptyUsage();
    addUsage(usage, observation.usage);
    byModel.set(observation.model, usage);
  }
  return byModel;
}

export interface RolloutTokenObservation {
  observedAt?: string;
  observedAtMs?: number;
  model: string;
  epoch: number;
  reset: boolean;
  usage: TokenUsage;
}

export type RolloutActivityKind = "turn-started" | "turn-completed" | "turn-aborted" | "compaction";

export interface RolloutActivityObservation {
  observedAt?: string;
  observedAtMs?: number;
  kind: RolloutActivityKind;
}

export type RolloutIssueKind =
  | "malformed-record"
  | "invalid-token-record"
  | "missing-timestamp"
  | "timestamp-regression";

export interface RolloutIssue {
  kind: RolloutIssueKind;
  bytes: number;
  observedAtMs?: number;
}

export interface RolloutTimeline {
  source: string;
  role: string;
  metadata?: {
    source: string;
    role: string;
    observedAt?: string;
    observedAtMs?: number;
  };
  tokens: RolloutTokenObservation[];
  identity: RolloutIdentity;
  markers: Array<RolloutIdentity & { observedAt: string; observedAtMs: number }>;
  activity: UsageThreadRow["activity"];
  activities: RolloutActivityObservation[];
  contexts: NonNullable<UsageThreadRow["currentContext"]>[];
  currentContext?: UsageThreadRow["currentContext"];
  issues: RolloutIssue[];
  malformedRecords: number;
  invalidTokenRecords: number;
  missingTimestamps: number;
  timestampRegressions: number;
}

function isZeroUsage(usage: TokenUsage): boolean {
  return Object.values(TOKEN_FIELDS).every(field => usage[field] === 0);
}

function validUsageCounters(raw: Record<string, unknown>): boolean {
  return Object.keys(TOKEN_FIELDS).every(field => {
    const value = raw[field];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });
}

function timestamp(value: unknown): { iso: string; milliseconds: number } | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { iso: new Date(milliseconds).toISOString(), milliseconds } : undefined;
}

function sessionSourceAndRole(payload: Record<string, unknown>): { source?: string; role?: string } {
  const directRole = typeof payload.agent_role === "string" ? payload.agent_role : undefined;
  if (typeof payload.source === "string") {
    return { source: payload.source, ...(directRole ? { role: directRole } : {}) };
  }
  if (!isRecord(payload.source)) return directRole ? { role: directRole } : {};
  const subagent = isRecord(payload.source.subagent) ? payload.source.subagent : undefined;
  const spawn = isRecord(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
  const role = typeof spawn?.agent_role === "string" ? spawn.agent_role : directRole;
  return { source: subagent ? "subagent" : "unknown", ...(role ? { role } : {}) };
}

function rawChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new SynodError(ERROR_CODES.ROLLOUT_INVALID, "Codex rollout stream yielded a non-byte chunk.");
}

function compacted(event: Record<string, unknown>, payload: Record<string, unknown> | undefined): boolean {
  return event.type === "compacted" || (event.type === "event_msg" && payload?.type === "context_compacted");
}

function activityKind(
  event: Record<string, unknown>,
  payload: Record<string, unknown> | undefined
): RolloutActivityKind | undefined {
  if (event.type === "turn_aborted") return "turn-aborted";
  if (event.type !== "event_msg") return undefined;
  if (payload?.type === "task_started") return "turn-started";
  if (payload?.type === "task_complete") return "turn-completed";
  return undefined;
}

function incrementActivity(activity: UsageThreadRow["activity"], kind: RolloutActivityKind): void {
  if (kind === "turn-started") activity.turnsStarted += 1;
  else if (kind === "turn-completed") activity.turnsCompleted += 1;
  else if (kind === "turn-aborted") activity.turnsAborted += 1;
  else activity.compactions += 1;
}

export async function readRolloutTimeline(
  rolloutPath: string,
  { openStream = createReadStream }: { openStream?: (path: string) => NodeJS.ReadableStream } = {}
): Promise<RolloutTimeline> {
  const tokens: RolloutTokenObservation[] = [];
  const markers: RolloutTimeline["markers"] = [];
  const activity = { turnsStarted: 0, turnsCompleted: 0, turnsAborted: 0, compactions: 0 };
  const activities: RolloutActivityObservation[] = [];
  const issues: RolloutIssue[] = [];
  const hasher = createHash("sha256");
  let bytes = 0;
  let buffer = Buffer.alloc(0);
  let activeModel = "unknown";
  let previous = emptyUsage();
  let epoch = 0;
  let source = "unknown";
  let role = "unknown";
  let metadata: RolloutTimeline["metadata"];
  let malformedRecords = 0;
  let invalidTokenRecords = 0;
  let missingTimestamps = 0;
  let timestampRegressions = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let lastObservedAt: string | undefined;
  let currentContext: UsageThreadRow["currentContext"] | undefined;
  const contexts: NonNullable<UsageThreadRow["currentContext"]>[] = [];
  let compactionPending = false;

  const processRecord = (recordBytes: Buffer, contentBytes: Buffer): void => {
    hasher.update(recordBytes);
    bytes += recordBytes.byteLength;
    const content = contentBytes.toString("utf8").replace(/\r$/, "");
    if (!content) return;
    let event: unknown;
    try {
      event = parseJson(content);
    } catch {
      malformedRecords += 1;
      issues.push({ kind: "malformed-record", bytes });
      return;
    }
    if (!isRecord(event)) {
      malformedRecords += 1;
      issues.push({ kind: "malformed-record", bytes });
      return;
    }
    const observed = timestamp(event.timestamp);
    if (observed) {
      if (observed.milliseconds < previousTimestamp) {
        timestampRegressions += 1;
        issues.push({ kind: "timestamp-regression", bytes, observedAtMs: observed.milliseconds });
      }
      previousTimestamp = Math.max(previousTimestamp, observed.milliseconds);
      lastObservedAt = observed.iso;
      markers.push({
        bytes,
        sha256: `sha256:${hasher.copy().digest("hex")}`,
        lastObservedAt: observed.iso,
        observedAt: observed.iso,
        observedAtMs: observed.milliseconds
      });
    } else {
      missingTimestamps += 1;
      issues.push({ kind: "missing-timestamp", bytes });
    }

    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (event.type === "session_meta" && payload && !metadata) {
      const parsedMetadata = sessionSourceAndRole(payload);
      if (parsedMetadata.source) source = parsedMetadata.source;
      if (parsedMetadata.role) role = parsedMetadata.role;
      metadata = {
        source,
        role,
        ...(observed ? { observedAt: observed.iso, observedAtMs: observed.milliseconds } : {})
      };
    }
    if (event.type === "turn_context" && typeof payload?.model === "string") activeModel = payload.model;
    const reroute = reroutedModel(payload);
    if (reroute) activeModel = reroute;

    const normalizedActivity = activityKind(event, payload);
    if (normalizedActivity) {
      incrementActivity(activity, normalizedActivity);
      activities.push({
        kind: normalizedActivity,
        ...(observed ? { observedAt: observed.iso, observedAtMs: observed.milliseconds } : {})
      });
    }
    if (compacted(event, payload)) {
      const explicit = event.type === "event_msg";
      if (!compactionPending) {
        incrementActivity(activity, "compaction");
        activities.push({
          kind: "compaction",
          ...(observed ? { observedAt: observed.iso, observedAtMs: observed.milliseconds } : {})
        });
      }
      compactionPending = !explicit;
    } else if (event.type !== "turn_context") compactionPending = false;

    if (event.type !== "event_msg" || payload?.type !== "token_count") return;
    const info = isRecord(payload.info) ? payload.info : undefined;
    const raw = isRecord(info?.total_token_usage) ? info.total_token_usage : undefined;
    if (!raw) {
      invalidTokenRecords += 1;
      issues.push({
        kind: "invalid-token-record",
        bytes,
        ...(observed ? { observedAtMs: observed.milliseconds } : {})
      });
      return;
    }
    if (!validUsageCounters(raw)) {
      invalidTokenRecords += 1;
      issues.push({
        kind: "invalid-token-record",
        bytes,
        ...(observed ? { observedAtMs: observed.milliseconds } : {})
      });
    }
    const current = normalizeUsage(raw);
    const delta = usageDelta(current, previous);
    previous = current;
    if (delta.reset) epoch += 1;
    tokens.push({
      ...(observed ? { observedAt: observed.iso, observedAtMs: observed.milliseconds } : {}),
      model: activeModel,
      epoch,
      reset: delta.reset,
      usage: delta.usage
    });

    const last = isRecord(info?.last_token_usage) ? info.last_token_usage : undefined;
    const modelContextWindow = Number(info?.model_context_window);
    if (observed && last && typeof last.input_tokens === "number"
      && Number.isFinite(last.input_tokens) && last.input_tokens >= 0
      && Number.isFinite(modelContextWindow) && modelContextWindow > 0) {
      currentContext = {
        observedAt: observed.iso,
        inputTokens: last.input_tokens,
        modelContextWindow
      };
      contexts.push(currentContext);
    }
  };

  const input = openStream(rolloutPath) as NodeJS.ReadableStream & AsyncIterable<unknown>;
  for await (const value of input) {
    buffer = Buffer.concat([buffer, rawChunk(value)]);
    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      const record = buffer.subarray(0, newline + 1);
      processRecord(record, buffer.subarray(0, newline));
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(0x0a);
    }
  }
  if (buffer.byteLength > 0) processRecord(buffer, buffer);

  return {
    source,
    role,
    ...(metadata ? { metadata } : {}),
    tokens,
    identity: {
      bytes,
      sha256: `sha256:${hasher.digest("hex")}`,
      ...(lastObservedAt ? { lastObservedAt } : {})
    },
    markers,
    activity,
    activities,
    contexts,
    ...(currentContext ? { currentContext } : {}),
    issues,
    malformedRecords,
    invalidTokenRecords,
    missingTimestamps,
    timestampRegressions
  };
}

async function listPages(client: UsageClient, params: Record<string, unknown>): Promise<ThreadRecord[]> {
  const threads: ThreadRecord[] = [];
  let cursor: string | undefined;
  do {
    const response: unknown = await requestClient(client, "thread/list", { ...params, cursor, limit: 100 });
    if (
      !isRecord(response)
      || !Array.isArray(response.data)
      || !response.data.every(isThreadRecord)
      || (response.nextCursor !== undefined && response.nextCursor !== null && typeof response.nextCursor !== "string")
    ) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server returned an invalid thread/list response.",
        { details: { capability: "thread/list" } }
      );
    }
    threads.push(...response.data);
    cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0
      ? response.nextCursor
      : undefined;
  } while (cursor);
  return threads;
}

async function findLatestRoot(client: UsageClient, cwd: string): Promise<ThreadRecord | undefined> {
  const query = {
    cwd,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: INTERACTIVE_SOURCE_KINDS
  };
  const [active, archived] = await Promise.all([
    listPages(client, { ...query, archived: false }),
    listPages(client, { ...query, archived: true })
  ]);
  const roots = new Map<string, ThreadRecord>();
  for (const thread of [...active, ...archived]) {
    if (thread.parentThreadId !== null) continue;
    const prior = roots.get(thread.id);
    if (prior && (prior.parentThreadId !== thread.parentThreadId || prior.path !== thread.path)) {
      throw new SynodError(ERROR_CODES.ROLLOUT_INVALID, `Codex returned conflicting identities for thread ${thread.id}.`, {
        details: { threadId: thread.id }
      });
    }
    roots.set(thread.id, thread);
  }

  return [...roots.values()].sort((left, right) => {
    const updated = comparableTime(right.updatedAt) - comparableTime(left.updatedAt);
    if (updated !== 0) return updated;
    const created = comparableTime(right.createdAt) - comparableTime(left.createdAt);
    if (created !== 0) return created;
    return String(left.id).localeCompare(String(right.id));
  })[0];
}

function comparableTime(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function findRoot(client: UsageClient, threadId: string): Promise<ThreadRecord> {
  let response: unknown = await requestClient(client, "thread/read", { threadId, includeTurns: false });
  if (!isRecord(response) || !isThreadRecord(response.thread)) {
    throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Codex App Server returned an invalid thread/read response.");
  }
  let thread = response.thread;
  const visited = new Set<string>();

  while (thread.parentThreadId) {
    if (visited.has(thread.id)) {
      throw new SynodError(ERROR_CODES.SESSION_CYCLE, `Cycle detected in Codex thread tree at ${thread.id}.`, {
        details: { threadId: thread.id }
      });
    }
    visited.add(thread.id);
    response = await requestClient(client, "thread/read", {
      threadId: thread.parentThreadId,
      includeTurns: false
    });
    if (!isRecord(response) || !isThreadRecord(response.thread)) {
      throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Codex App Server returned an invalid thread/read response.");
    }
    thread = response.thread;
  }

  return thread;
}

async function findDescendants(client: UsageClient, root: ThreadRecord): Promise<ThreadRecord[]> {
  const threads = [root];
  const queue = [root.id];
  const seen = new Set(queue);
  const byId = new Map([[root.id, root]]);

  while (queue.length > 0) {
    const parentThreadId = queue.shift();
    const childQuery = {
      parentThreadId,
      sourceKinds: ALL_SOURCE_KINDS,
      sortKey: "created_at",
      sortDirection: "asc"
    };
    const [activeChildren, archivedChildren] = await Promise.all([
      listPages(client, { ...childQuery, archived: false }),
      listPages(client, { ...childQuery, archived: true })
    ]);
    const children = [...activeChildren, ...archivedChildren];

    for (const child of children) {
      if (seen.has(child.id)) {
        const prior = byId.get(child.id)!;
        if (prior.parentThreadId !== child.parentThreadId || prior.path !== child.path) {
          throw new SynodError(ERROR_CODES.ROLLOUT_INVALID, `Codex returned conflicting identities for thread ${child.id}.`, {
            details: { threadId: child.id }
          });
        }
        continue;
      }
      seen.add(child.id);
      byId.set(child.id, child);
      threads.push(child);
      queue.push(child.id);
    }
  }

  return threads;
}

function eventIdentity(event: OrchestrationEvent): UsageBoundary["event"] {
  return {
    sequence: event.sequence,
    id: event.id,
    hash: event.eventHash,
    type: event.type
  };
}

function eventTime(event: OrchestrationEvent): string {
  const value = timestamp(event.timestamp);
  if (!value) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, `Canonical event ${event.sequence} has an invalid timestamp.`, {
      details: { sequence: event.sequence, timestamp: event.timestamp }
    });
  }
  return value.iso;
}

function selectedEvent(events: OrchestrationEvent[], selector: string): OrchestrationEvent {
  const bySequence = /^[1-9]\d*$/.test(selector) ? Number(selector) : undefined;
  const matches = events.filter(event => bySequence === undefined ? event.id === selector : event.sequence === bySequence);
  if (matches.length !== 1) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, `Canonical event selector did not resolve exactly once: ${selector}.`, {
      details: { selector, matches: matches.length }
    });
  }
  return matches[0]!;
}

function sameCheckpoint(left: GitCheckpoint, right: GitCheckpoint): boolean {
  return left.capturedAt === right.capturedAt
    && left.branch === right.branch
    && left.head === right.head
    && left.worktree.fingerprint === right.worktree.fingerprint
    && left.worktree.snapshot?.contentHash === right.worktree.snapshot?.contentHash;
}

function checkpointBoundary(event: OrchestrationEvent, checkpoint: GitCheckpoint): UsageBoundary {
  const captured = timestamp(checkpoint.capturedAt);
  if (!captured) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "The acknowledged checkpoint has an invalid capture timestamp.", {
      details: { capturedAt: checkpoint.capturedAt }
    });
  }
  return {
    kind: "checkpoint",
    timestamp: captured.iso,
    event: eventIdentity(event),
    checkpoint: {
      fingerprint: checkpoint.worktree.fingerprint,
      ...(checkpoint.worktree.snapshot ? { snapshotHash: checkpoint.worktree.snapshot.contentHash } : {}),
      capturedAt: checkpoint.capturedAt
    }
  };
}

function terminalTaskEvent(events: OrchestrationEvent[], taskId: string, startSequence: number): OrchestrationEvent | undefined {
  return events.find(event => {
    if (event.sequence < startSequence) return false;
    const task = event.state.tasks[taskId];
    return task?.state === "DONE" || task?.state === "SUPERSEDED";
  });
}

export async function resolveUsageInterval(
  directory: string,
  options: UsageIntervalOptions,
  capturedAt: string
): Promise<UsageInterval | undefined> {
  const selectors = [options.sinceEvent !== undefined, options.sinceCheckpoint === true, options.taskId !== undefined]
    .filter(Boolean).length;
  if (selectors === 0) {
    if (options.untilEvent) {
      throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "--until-event requires one usage start selector.");
    }
    return undefined;
  }
  if (selectors !== 1) {
    throw new SynodError(
      ERROR_CODES.USAGE_INTERVAL_INVALID,
      "Usage accepts exactly one of --since-event, --since-checkpoint, or --task."
    );
  }

  const canonical = await validateOrchestrationReadOnly({ directory });
  const events = canonical.events;
  let start: UsageBoundary;
  let defaultEnd: OrchestrationEvent | undefined;

  if (options.sinceEvent) {
    const event = selectedEvent(events, options.sinceEvent);
    start = { kind: "event", timestamp: eventTime(event), event: eventIdentity(event) };
  } else if (options.sinceCheckpoint) {
    const event = events.find(item => sameCheckpoint(item.checkpoint, canonical.state.checkpoint));
    if (!event) {
      throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "The acknowledged checkpoint has no canonical introduction event.", {
        details: { fingerprint: canonical.state.checkpoint.worktree.fingerprint }
      });
    }
    start = checkpointBoundary(event, canonical.state.checkpoint);
  } else {
    const taskId = options.taskId!;
    if (!Object.hasOwn(canonical.state.tasks, taskId)) {
      throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task not found: ${taskId}.`, { details: { taskId } });
    }
    const event = events.find(item => item.taskId === taskId || Object.hasOwn(item.state.tasks, taskId));
    if (!event) {
      throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, `Task ${taskId} has no canonical introduction event.`, {
        details: { taskId }
      });
    }
    start = { kind: "task", timestamp: eventTime(event), event: eventIdentity(event), taskId };
    defaultEnd = terminalTaskEvent(events, taskId, event.sequence);
  }

  const endEvent = options.untilEvent ? selectedEvent(events, options.untilEvent) : defaultEnd;
  const end: UsageInterval["end"] = endEvent
    ? { kind: "event", timestamp: eventTime(endEvent), event: eventIdentity(endEvent) }
    : { kind: "capture", timestamp: capturedAt };
  const startMs = Date.parse(start.timestamp);
  const endMs = Date.parse(end.timestamp);
  if (!Number.isFinite(endMs) || endMs <= startMs
    || (endEvent && endEvent.sequence <= start.event.sequence)) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage interval end must be unambiguously after its start.", {
      details: { start, end }
    });
  }
  return { inclusion: "(start,end]", start, end, complete: end.kind === "event" };
}

function exactThreadCreation(thread: ThreadRecord): number | undefined {
  if (thread.createdAt === undefined || thread.createdAt === null) return undefined;
  const value = comparableTime(thread.createdAt);
  return Number.isFinite(value) ? value : undefined;
}

function threadsForInterval(threads: ThreadRecord[], rootId: string, interval: UsageInterval | undefined): ThreadRecord[] {
  if (!interval) return threads;
  const endMs = Date.parse(interval.end.timestamp);
  const root = threads.find(thread => thread.id === rootId);
  const rootCreatedAt = root ? exactThreadCreation(root) : undefined;
  if (rootCreatedAt !== undefined && rootCreatedAt > endMs) {
    throw new SynodError(
      ERROR_CODES.USAGE_INTERVAL_INVALID,
      `Root thread ${rootId} was created after the closed usage interval ended.`,
      { details: { threadId: rootId, createdAt: root?.createdAt, intervalEnd: interval.end.timestamp } }
    );
  }
  return threads.filter(thread => {
    const createdAt = exactThreadCreation(thread);
    if (createdAt === undefined) {
      if (thread.id === rootId) return true;
      if (!interval.complete) return true;
      throw new SynodError(
        ERROR_CODES.USAGE_INTERVAL_INVALID,
        `Thread ${thread.id} has no creation time for a closed usage interval.`,
        { details: { threadId: thread.id } }
      );
    }
    return createdAt <= endMs;
  });
}

function timelineIdentityAt(timeline: RolloutTimeline, endMs: number | undefined): RolloutIdentity {
  if (endMs === undefined) return timeline.identity;
  let selected: RolloutTimeline["markers"][number] | undefined;
  for (const marker of timeline.markers) {
    if (marker.observedAtMs <= endMs) selected = marker;
  }
  return selected
    ? { bytes: selected.bytes, sha256: selected.sha256, lastObservedAt: selected.observedAt }
    : { bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}` };
}

function selectedTokens(timeline: RolloutTimeline, interval: UsageInterval | undefined): RolloutTokenObservation[] {
  if (!interval) return timeline.tokens;
  const endMs = Date.parse(interval.end.timestamp);
  const prefix = timelineIdentityAt(timeline, endMs);
  const issues = timeline.issues.filter(issue => issue.bytes <= prefix.bytes);
  if ((prefix.bytes === 0 && timeline.identity.bytes > 0 && timeline.markers.length === 0) || issues.length > 0) {
    const counts = {
      malformedRecords: issues.filter(issue => issue.kind === "malformed-record").length,
      invalidTokenRecords: issues.filter(issue => issue.kind === "invalid-token-record").length,
      missingTimestamps: issues.filter(issue => issue.kind === "missing-timestamp").length,
      timestampRegressions: issues.filter(issue => issue.kind === "timestamp-regression").length
    };
    throw new SynodError(ERROR_CODES.ROLLOUT_INVALID, "An exact usage interval requires a complete, ordered rollout timeline.", {
      details: {
        ...counts,
        prefixBytes: prefix.bytes,
        rolloutBytes: timeline.identity.bytes
      }
    });
  }
  const startMs = Date.parse(interval.start.timestamp);
  return timeline.tokens.filter(item => item.observedAtMs !== undefined
    && item.observedAtMs > startMs && item.observedAtMs <= endMs);
}

function selectedActivity(
  timeline: RolloutTimeline,
  interval: UsageInterval | undefined
): UsageThreadRow["activity"] {
  if (!interval) return timeline.activity;
  const startMs = Date.parse(interval.start.timestamp);
  const endMs = Date.parse(interval.end.timestamp);
  const activity = { turnsStarted: 0, turnsCompleted: 0, turnsAborted: 0, compactions: 0 };
  for (const item of timeline.activities) {
    if (item.observedAtMs === undefined || item.observedAtMs <= startMs || item.observedAtMs > endMs) continue;
    incrementActivity(activity, item.kind);
  }
  return activity;
}

function timelineAttribution(
  timeline: RolloutTimeline,
  interval: UsageInterval | undefined
): { source: string; role: string } {
  if (!interval) return { source: timeline.source, role: timeline.role };
  const endMs = Date.parse(interval.end.timestamp);
  if (!timeline.metadata || timeline.metadata.observedAtMs === undefined
    || timeline.metadata.observedAtMs > endMs) {
    return { source: "unknown", role: "unknown" };
  }
  return { source: timeline.metadata.source, role: timeline.metadata.role };
}

function usageKey(...values: string[]): string {
  return values.join("\u0000");
}

function sortedAttribution(rows: UsageAttributionRow[]): UsageAttributionRow[] {
  return rows.sort((left, right) => right.totalTokens - left.totalTokens
    || left.threadId.localeCompare(right.threadId)
    || left.model.localeCompare(right.model)
    || left.role.localeCompare(right.role));
}

export async function collectUsage({
  cwd = process.cwd(),
  threadId,
  sinceEvent,
  sinceCheckpoint,
  taskId,
  untilEvent,
  clientFactory = () => new CodexAppServerClient(),
  clock = () => new Date()
}: {
  cwd?: string;
  threadId?: string;
  sinceEvent?: string;
  sinceCheckpoint?: boolean;
  taskId?: string;
  untilEvent?: string;
  clientFactory?: () => UsageClient;
  clock?: () => Date | string | number;
} = {}): Promise<UsageReport> {
  const client = clientFactory();
  let report: Omit<UsageReport, "warnings" | "diagnostics"> | undefined;
  let failure: SynodError | undefined;
  try {
    const captureValue = new Date(clock());
    if (!Number.isFinite(captureValue.getTime())) {
      throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage capture clock returned an invalid timestamp.");
    }
    const captureTime = captureValue.toISOString();
    const resolvedCwd = path.resolve(cwd);
    const interval = await resolveUsageInterval(resolvedCwd, {
      ...(sinceEvent !== undefined ? { sinceEvent } : {}),
      ...(sinceCheckpoint === true ? { sinceCheckpoint } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(untilEvent !== undefined ? { untilEvent } : {})
    }, captureTime);
    await client.start();
    if (typeof client.probeCapabilities === "function") await client.probeCapabilities();
    const root = threadId
      ? await findRoot(client, threadId)
      : await findLatestRoot(client, resolvedCwd);

    if (!root) {
      throw new SynodError(
        ERROR_CODES.SESSION_NOT_FOUND,
        `No Codex session found for ${resolvedCwd}. Use --session <thread-id> to select one.`,
        { details: { cwd: resolvedCwd } }
      );
    }

    const discoveredThreads = await findDescendants(client, root);
    const selectedThreads = threadsForInterval(discoveredThreads, root.id, interval);
    const modelAggregate = new Map<string, TokenUsage & { model: string; threads: Set<string> }>();
    const roleAggregate = new Map<string, TokenUsage & { role: string; threads: Set<string> }>();
    const attributionAggregate = new Map<string, UsageAttributionRow>();
    const threadRows: UsageThreadRow[] = [];
    const completenessReasons = new Set<string>();
    if (!interval?.complete) completenessReasons.add(interval ? "open-canonical-interval" : "session-snapshot");

    for (const thread of selectedThreads) {
      if (!thread.path) {
        throw new SynodError(
          ERROR_CODES.ROLLOUT_PATH_MISSING,
          `Codex did not expose a rollout path for thread ${thread.id}.`,
          { details: { threadId: thread.id } }
        );
      }

      const timeline = await readRolloutTimeline(thread.path);
      if (!interval) {
        if (timeline.malformedRecords > 0) completenessReasons.add("malformed-rollout-records");
        if (timeline.invalidTokenRecords > 0) completenessReasons.add("invalid-token-records");
        if (timeline.missingTimestamps > 0) completenessReasons.add("missing-record-timestamps");
        if (timeline.timestampRegressions > 0) completenessReasons.add("timestamp-regression");
      }
      const observations = selectedTokens(timeline, interval);
      const metadata = timelineAttribution(timeline, interval);
      const role = thread.id === root.id ? "supervisor" : metadata.role;
      const source = metadata.source;
      const threadUsage = emptyUsage();
      const activeModels = new Set<string>();
      for (const observation of observations) {
        if (isZeroUsage(observation.usage)) continue;
        activeModels.add(observation.model);
        addUsage(threadUsage, observation.usage);
        const modelRow = modelAggregate.get(observation.model)
          || { model: observation.model, threads: new Set<string>(), ...emptyUsage() };
        modelRow.threads.add(thread.id);
        addUsage(modelRow, observation.usage);
        modelAggregate.set(observation.model, modelRow);

        const roleRow = roleAggregate.get(role) || { role, threads: new Set<string>(), ...emptyUsage() };
        roleRow.threads.add(thread.id);
        addUsage(roleRow, observation.usage);
        roleAggregate.set(role, roleRow);

        const key = usageKey(thread.id, observation.model, role, source);
        const attribution = attributionAggregate.get(key) || {
          threadId: thread.id,
          parentThreadId: thread.parentThreadId,
          model: observation.model,
          role,
          source,
          ...emptyUsage()
        };
        addUsage(attribution, observation.usage);
        attributionAggregate.set(key, attribution);
      }
      const intervalEndMs = interval ? Date.parse(interval.end.timestamp) : undefined;
      const selectedContext = [...timeline.contexts].reverse().find(item => {
        const observedAt = Date.parse(item.observedAt);
        return interval
          ? observedAt > Date.parse(interval.start.timestamp) && observedAt <= Date.parse(interval.end.timestamp)
          : true;
      });
      threadRows.push({
        threadId: thread.id,
        parentThreadId: thread.parentThreadId,
        role,
        source,
        models: activeModels.size,
        rollout: timelineIdentityAt(timeline, intervalEndMs),
        activity: selectedActivity(timeline, interval),
        ...(selectedContext ? { currentContext: selectedContext } : {}),
        ...threadUsage
      });
    }

    const models = [...modelAggregate.values()]
      .map(row => ({ ...row, threads: row.threads.size }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
    const roles = [...roleAggregate.values()]
      .map(row => ({ ...row, threads: row.threads.size }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.role.localeCompare(right.role));
    const attribution = sortedAttribution([...attributionAggregate.values()]);
    threadRows.sort((left, right) => right.totalTokens - left.totalTokens || left.threadId.localeCompare(right.threadId));
    const total = { threads: selectedThreads.length, ...emptyUsage() };
    for (const row of models) addUsage(total, row);

    const reportCapturedAt = interval?.complete ? interval.end.timestamp : captureTime;
    report = {
      session: {
        threadId: root.id,
        cwd: root.cwd,
        createdAt: root.createdAt,
        ...(interval?.complete ? {} : { updatedAt: root.updatedAt })
      },
      capturedAt: reportCapturedAt,
      models,
      roles,
      threads: threadRows,
      attribution,
      total,
      completeness: {
        status: completenessReasons.size === 0 ? "complete" : "incomplete",
        reasons: [...completenessReasons].sort()
      },
      ...(interval ? { interval } : {})
    };
  } catch (error) {
    failure = asSynodError(error);
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (!failure) failure = asSynodError(error);
    }
  }

  const diagnostics = typeof client.getDiagnostics === "function" ? client.getDiagnostics() : {};
  const warnings = typeof client.getWarnings === "function" ? client.getWarnings() : [];
  if (failure) {
    failure.diagnostics = diagnostics;
    failure.warnings = warnings;
    throw failure;
  }

  if (!report) throw new SynodError(ERROR_CODES.INTERNAL, "Usage collection completed without a report.");
  return { ...report, warnings, diagnostics };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBoundary(boundary: UsageInterval["start"] | UsageInterval["end"]): string {
  if (boundary.kind === "capture") return `capture@${boundary.timestamp}`;
  return `${boundary.kind}#${boundary.event.sequence}:${boundary.event.id}@${boundary.timestamp}`;
}

export function formatUsageReport(report: UsageReport): string {
  const rows = report.models.map(row => [
    row.model,
    String(row.threads),
    formatNumber(row.inputTokens),
    formatNumber(row.cachedInputTokens),
    formatNumber(row.outputTokens),
    formatNumber(row.reasoningOutputTokens),
    formatNumber(row.totalTokens)
  ]);
  rows.push([
    "TOTAL",
    String(report.total.threads),
    formatNumber(report.total.inputTokens),
    formatNumber(report.total.cachedInputTokens),
    formatNumber(report.total.outputTokens),
    formatNumber(report.total.reasoningOutputTokens),
    formatNumber(report.total.totalTokens)
  ]);

  const headers = ["Model", "Threads", "Input", "Cached", "Output", "Reasoning", "Total"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0))
  );
  const render = (row: string[]) => row.map((cell, index) => {
    const width = widths[index] ?? cell.length;
    return index < 2 ? cell.padEnd(width) : cell.padStart(width);
  }
  ).join("  ");

  const interval = report.interval
    ? `${report.interval.inclusion} ${formatBoundary(report.interval.start)} -> ${formatBoundary(report.interval.end)}`
    : "whole-session persisted snapshot";
  const completeness = report.completeness.reasons.length > 0
    ? `${report.completeness.status} (${report.completeness.reasons.join(", ")})`
    : report.completeness.status;
  const threadRows = report.threads.map(thread => {
    const parent = thread.parentThreadId || "-";
    return `- ${thread.threadId} parent=${parent} role=${thread.role} source=${thread.source} models=${thread.models}`
      + ` total=${formatNumber(thread.totalTokens)} rollout=${thread.rollout.sha256} bytes=${thread.rollout.bytes}`;
  });

  return [
    `Session: ${report.session.threadId}`,
    `Directory: ${report.session.cwd}`,
    `Captured: ${report.capturedAt}`,
    `Interval: ${interval}`,
    `Completeness: ${completeness}`,
    "",
    render(headers),
    widths.map(width => "-".repeat(width)).join("  "),
    ...rows.map(render),
    "",
    "Thread attribution:",
    ...threadRows,
    "",
    "Cached tokens are included in Input; reasoning tokens are included in Output."
  ].join("\n");
}
