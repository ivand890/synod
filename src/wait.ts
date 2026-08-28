import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "./app-server.js";
import type { AppServerDiagnostics, AppServerEvent } from "./app-server.js";
import type { BudgetThresholdStatus } from "./budgets.js";
import { resolveCodexRuntime } from "./codex-runtime.js";
import { WARNING_CODES, warning } from "./contracts.js";
import type { Warning, WarningCode } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { isLegacyHostOwnerThread, isPathLikeLegacyOwnerThread, isValidCodexThreadId } from "./leases.js";
import { validateOrchestrationReadOnly } from "./orchestration.js";
import { errorMessage, isRecord } from "./validation.js";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> };

export interface ObservedThreadStatus {
  threadId: string;
  status: ThreadStatus;
}

export interface ThreadStatusAdapter {
  start(): Promise<void>;
  capabilities(): { notification: boolean; cursor: boolean };
  read(threadIds: string[]): Promise<{ statuses: ObservedThreadStatus[]; cursor?: string }>;
  subscribe?(listener: (event: unknown) => void, onFailure: (error: unknown) => void): () => void;
  waitForCursorChange?(cursor: string, threadIds: string[], signal?: AbortSignal): Promise<{
    statuses: ObservedThreadStatus[];
    cursor: string;
  }>;
  close(): Promise<unknown>;
  getWarnings?(): Warning[];
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
}

export interface HostWaitRequest {
  threadIds: string[];
  /** Opaque host handles are kept separate from Codex thread IDs. */
  hostWaitHandles?: string[];
  /** Compatibility alias accepted by host integrations. */
  hostHandles?: string[];
  cwd?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}

/** The evidence-based cause for an incomplete or lost runtime observation. */
export const WAIT_LOSS_CAUSES = Object.freeze([
  "endpoint-expired",
  "endpoint-unreachable",
  "endpoint-owner-exited",
  "child-terminated",
  "wait-timeout",
  "authority-lost"
] as const);

export type WaitLossCause = typeof WAIT_LOSS_CAUSES[number];

export interface WaitLossEvidence {
  cause: WaitLossCause;
  authority: "appServer" | "host";
  threadId?: string;
  directEvidence: boolean;
}

export interface HostWaitResult {
  statuses: ObservedThreadStatus[];
  mode?: Exclude<WaitMode, "handoff">;
  wakeCount?: number;
  fallbackPollCount?: number;
  lossCause?: WaitLossCause;
  warnings?: Warning[];
  diagnostics?: Record<string, unknown>;
}

const WARNING_CODE_SET = new Set<string>(Object.values(WARNING_CODES));

function normalizeWarnings(value: unknown): Warning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.code !== "string" || !WARNING_CODE_SET.has(item.code)
      || typeof item.message !== "string") return [];
    return [{
      code: item.code as WarningCode,
      message: item.message,
      ...(Object.hasOwn(item, "details") ? { details: item.details } : {})
    }];
  });
}

const WAIT_LOSS_CAUSE_SET: ReadonlySet<string> = new Set(WAIT_LOSS_CAUSES);

function parseWaitLossCause(value: unknown): WaitLossCause | undefined {
  return typeof value === "string" && WAIT_LOSS_CAUSE_SET.has(value)
    ? value as WaitLossCause
    : undefined;
}

function parseWaitLossEvidence(value: unknown): WaitLossEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const cause = parseWaitLossCause(value.cause)
    || parseWaitLossCause(value.lossCause)
    || parseWaitLossCause(value.waitLossCause);
  if (!cause) return undefined;
  const authority = value.authority === "host" ? "host" : "appServer";
  const threadId = typeof value.threadId === "string" && value.threadId.trim()
    ? value.threadId.trim()
    : undefined;
  return {
    cause,
    authority,
    ...(threadId ? { threadId } : {}),
    directEvidence: value.directEvidence === true
  };
}

function waitLossEvidence(value: unknown): WaitLossEvidence | undefined {
  if (!isRecord(value)) return undefined;
  return parseWaitLossEvidence(value.waitLoss)
    || parseWaitLossEvidence(value.lossEvidence)
    || waitLossEvidence(value.appServer)
    || parseWaitLossEvidence(value);
}

function directChildTermination(
  statuses: ObservedThreadStatus[],
  evidence: WaitLossEvidence | undefined
): boolean {
  if (!evidence || evidence.cause !== "child-terminated" || !evidence.directEvidence || !evidence.threadId) {
    return false;
  }
  return statuses.some(item => item.threadId === evidence.threadId && item.status.type === "systemError");
}

function sanitizeStatuses(
  statuses: ObservedThreadStatus[],
  evidence: WaitLossEvidence | undefined
): ObservedThreadStatus[] {
  return statuses.map(item => {
    if (item.status.type !== "systemError") return item;
    return directChildTermination([item], evidence)
      ? item
      : { threadId: item.threadId, status: { type: "notLoaded" as const } };
  });
}

function reportDiagnostics(
  lossCause: WaitLossCause | undefined,
  evidence: WaitLossEvidence | undefined
): Record<string, unknown> {
  return {
    ...(lossCause ? { lossCause, waitLossCause: lossCause } : {}),
    ...(evidence ? { waitLoss: evidence } : {})
  };
}

/** Optional host-owned status observation surface used by an injected adapter. */
export interface HostWaitAdapter {
  start?(): Promise<void>;
  capabilities?(): { notification: boolean; cursor: boolean };
  read?(threadIds: string[]): Promise<{ statuses: ObservedThreadStatus[]; cursor?: string }>;
  subscribe?(listener: (event: unknown) => void, onFailure: (error: unknown) => void): () => void;
  waitForCursorChange?(cursor: string, threadIds: string[], signal?: AbortSignal): Promise<{
    statuses: ObservedThreadStatus[];
    cursor: string;
  }>;
  wait?(request: HostWaitRequest): Promise<HostWaitResult>;
  observe?(request: HostWaitRequest): Promise<HostWaitResult>;
  close?(): Promise<unknown>;
  getWarnings?(): Warning[];
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
}

export interface WaitForThreadsOptions {
  threadIds: string[];
  hostWaitHandles?: string[];
  hostHandles?: string[];
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/** The owner whose observation makes a wait result authoritative. */
export type WaitAuthority = "host" | "appServer" | "canonical";

export type WaitObservationAuthority = WaitAuthority | "unknown";

/** The bounded transport used to observe (or hand off) a wait. */
export type WaitMode = "notification" | "cursor" | "poll" | "handoff";

/**
 * A bounded wait can classify a terminal runtime observation without making
 * canonical lease state changes. The lease-recovery command remains a
 * supervisor decision, so this is evidence only.
 */
export type WaitChildLoss = "child-dead-lease-live" | "wait-never-woke";

export interface WaitReport {
  /** Transport mode; this is deliberately separate from waitAuthority. */
  mode: WaitMode;
  waitAuthority: WaitObservationAuthority;
  threadIds: string[];
  wakeCount: number;
  fallbackPollCount: number;
  elapsedMs: number;
  timedOut: boolean;
  aborted: boolean;
  incomplete: boolean;
  approvalNeeded: boolean;
  userInputNeeded: boolean;
  /** Positive host handoff contract. The legacy fallback fields below are aliases. */
  hostWaitRequired: boolean;
  hostWaitThreadIds: string[];
  /** Positive host-owned handoff identities; never sent to thread/read. */
  hostWaitHandles?: string[];
  hostFallbackRequired: boolean;
  hostFallbackThreadIds: string[];
  statuses: ObservedThreadStatus[];
  childLoss?: WaitChildLoss;
  lossCause?: WaitLossCause;
  warnings: Warning[];
  diagnostics: AppServerDiagnostics | Record<string, unknown>;
}

export interface WaitClient {
  start(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<unknown>;
  probeCapabilities?(): Promise<unknown>;
  subscribeEvents?(listener: (event: AppServerEvent) => void): () => void;
  supportsThreadStatusNotifications?(): boolean;
  getWarnings?(): Warning[];
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
}

export interface WaitRuntime {
  surface?: string;
  executable: string;
  executableSource?: string;
  resolved: boolean;
}

export interface WaitTaskSelection {
  taskId: string;
  state: string;
  revision: number;
  leaseId: string;
  generation: number;
  ownerThread: string;
  waitAuthority?: "host" | "appServer";
  hostHandle?: string;
  threadId?: string;
  expectedHeartbeatAt: string;
  budget?: {
    policyRevision: number;
    thresholdStatus: BudgetThresholdStatus;
    decisionRequired: boolean;
  };
}

export interface WaitSelection {
  /** Task selectors are resolved from canonical state before runtime observation. */
  waitAuthority?: "canonical";
  requestedTaskIds: string[];
  requestedThreadIds: string[];
  tasks: WaitTaskSelection[];
  threadIds: string[];
  hostWaitHandles?: string[];
}

export interface WaitSelectionOptions {
  directory?: string;
  taskIds?: string[];
  threadIds?: string[];
}

export interface WaitSelectionDependencies {
  canonicalReader?: (directory: string) => Promise<{
    state: { tasks: Record<string, WaitSelectableTask | undefined> };
  }>;
  clock?: () => number;
}

interface WaitSelectableTask {
  state: string;
  revision: number;
  lease?: {
    id: string;
    generation: number;
    ownerThread: string;
    status: string;
    expiresAt: string;
    heartbeatAt?: string;
    waitAuthority?: "host" | "appServer";
    hostHandle?: string;
    threadId?: string;
  };
  leaseReservation?: { id: string; generation: number };
  recovery?: {
    status: string;
    endedLease: { id: string; generation: number };
  };
  budget?: {
    policy: { revision: number };
    thresholdStatus: BudgetThresholdStatus;
  };
}

export interface WaitDependencies {
  adapterFactory?: () => ThreadStatusAdapter;
  hostAdapter?: HostWaitAdapter;
  hostAdapterFactory?: () => HostWaitAdapter;
  clientFactory?: (options?: { cwd?: string; codexBin?: string }) => WaitClient;
  runtimeResolver?: () => WaitRuntime;
  clock?: () => number;
  cleanupTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);

export function parseThreadStatus(value: unknown): ThreadStatus | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "notLoaded" || value.type === "idle" || value.type === "systemError") {
    return { type: value.type };
  }
  if (value.type !== "active" || !Array.isArray(value.activeFlags)
    || !value.activeFlags.every(flag => typeof flag === "string" && ACTIVE_FLAGS.has(flag))) return undefined;
  const activeFlags = [...new Set(value.activeFlags)] as Array<"waitingOnApproval" | "waitingOnUserInput">;
  return { type: "active", activeFlags };
}

function parseObservedStatus(value: unknown): ObservedThreadStatus | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string" || !value.threadId) return undefined;
  const status = parseThreadStatus(value.status);
  return status ? { threadId: value.threadId, status } : undefined;
}

function statusFromReadResponse(value: unknown, expectedThreadId: string): ObservedThreadStatus {
  const thread = isRecord(value) && isRecord(value.thread) ? value.thread : undefined;
  const parsed = thread ? parseObservedStatus({ threadId: thread.id, status: thread.status }) : undefined;
  if (!parsed || parsed.threadId !== expectedThreadId) {
    throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Codex App Server returned an invalid thread/read status.", {
      details: { capability: "thread/read", threadId: expectedThreadId }
    });
  }
  return parsed;
}

export function appServerThreadStatusAdapter(client: WaitClient): ThreadStatusAdapter {
  return {
    async start() {
      await client.start();
    },
    capabilities() {
      return {
        notification: Boolean(client.subscribeEvents && client.supportsThreadStatusNotifications?.()),
        cursor: false
      };
    },
    async read(threadIds) {
      const statuses = await Promise.all(threadIds.map(async threadId =>
        statusFromReadResponse(await client.request("thread/read", { threadId, includeTurns: false }), threadId)
      ));
      return { statuses };
    },
    subscribe(listener, onFailure) {
      if (!client.subscribeEvents) return () => {};
      return client.subscribeEvents(event => {
        if (event.type === "failure") onFailure(event.error);
        else if (event.method === "thread/status/changed") listener(event.params);
      });
    },
    close: () => client.close(),
    getWarnings: () => normalizeWarnings(client.getWarnings?.()),
    getDiagnostics: () => client.getDiagnostics?.() || {}
  };
}

function completion(statuses: ObservedThreadStatus[]): {
  done: boolean;
  approvalNeeded: boolean;
  userInputNeeded: boolean;
  incomplete: boolean;
} {
  const approvalNeeded = statuses.some(item => item.status.type === "active"
    && item.status.activeFlags.includes("waitingOnApproval"));
  const userInputNeeded = statuses.some(item => item.status.type === "active"
    && item.status.activeFlags.includes("waitingOnUserInput"));
  const terminal = statuses.every(item =>
    item.status.type === "notLoaded" || item.status.type === "idle" || item.status.type === "systemError"
  );
  const systemError = statuses.some(item => item.status.type === "systemError");
  const notLoaded = statuses.some(item => item.status.type === "notLoaded");
  const attentionNeeded = approvalNeeded || userInputNeeded;
  return {
    done: attentionNeeded || terminal,
    approvalNeeded,
    userInputNeeded,
    incomplete: attentionNeeded || systemError || notLoaded || !terminal
  };
}

function childLossForStatuses(
  statuses: ObservedThreadStatus[],
  evidence?: WaitLossEvidence
): WaitChildLoss | undefined {
  return directChildTermination(statuses, evidence)
    ? "child-dead-lease-live"
    : undefined;
}

export async function resolveWaitSelection({
  directory = ".",
  taskIds = [],
  threadIds = []
}: WaitSelectionOptions = {}, {
  canonicalReader = async selectedDirectory => validateOrchestrationReadOnly({ directory: selectedDirectory }),
  clock = () => Date.now()
}: WaitSelectionDependencies = {}): Promise<WaitSelection> {
  const requestedTaskIds = [...new Set(taskIds.map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  const requestedThreadIds = [...new Set(threadIds.map(value => String(value).trim()).filter(Boolean))];
  if (requestedTaskIds.length === 0 && requestedThreadIds.length === 0) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait requires at least one canonical task or explicit thread.");
  }

  const tasks: WaitTaskSelection[] = [];
  if (requestedTaskIds.length > 0) {
    const canonical = await canonicalReader(directory);
    for (const taskId of requestedTaskIds) {
      const task = canonical.state.tasks[taskId];
      if (!task) {
        throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
      }
      if (task.recovery?.status === "PENDING") {
        throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} has a pending abandoned-owner recovery and cannot be waited on by task.`, {
          details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
        });
      }
      if (task.leaseReservation) {
        throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} has not bound its writer reservation to an owner thread.`, {
          details: { taskId, leaseId: task.leaseReservation.id, generation: task.leaseReservation.generation }
        });
      }
      const lease = task.lease;
      if (!lease || lease.status !== "ACTIVE" || task.state !== "ACTIVE") {
        throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} has no active bound writer lease to wait for.`, {
          details: { taskId, state: task.state, hasLease: Boolean(lease) }
        });
      }
      if (Date.parse(lease.expiresAt) <= clock()) {
        throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} bound writer lease has expired.`, {
          details: { taskId, leaseId: lease.id, generation: lease.generation, expiresAt: lease.expiresAt }
        });
      }
      const legacyHostHandle = lease.waitAuthority === undefined && isLegacyHostOwnerThread(lease.ownerThread)
        ? lease.ownerThread
        : undefined;
      const effectiveWaitAuthority = lease.waitAuthority || (legacyHostHandle ? "host" : undefined);
      const effectiveHostHandle = lease.hostHandle || legacyHostHandle;
      if (effectiveWaitAuthority === "appServer" && !isValidCodexThreadId(lease.threadId)) {
        throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `Task ${taskId} App Server lease is missing its exact threadId.`, {
          details: { taskId, threadId: lease.threadId ?? null }
        });
      }
      if (effectiveWaitAuthority === "host" && !effectiveHostHandle) {
        throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `Task ${taskId} host lease is missing its opaque hostHandle.`, {
          details: { taskId, hostHandle: effectiveHostHandle ?? null }
        });
      }
      tasks.push({
        taskId,
        state: task.state,
        revision: task.revision,
        leaseId: lease.id,
        generation: lease.generation,
        ownerThread: lease.ownerThread,
        ...(effectiveWaitAuthority === undefined ? {} : { waitAuthority: effectiveWaitAuthority }),
        ...(effectiveHostHandle === undefined ? {} : { hostHandle: effectiveHostHandle }),
        ...(lease.threadId === undefined ? {} : { threadId: lease.threadId }),
        expectedHeartbeatAt: lease.heartbeatAt || lease.expiresAt,
        ...(task.budget ? {
          budget: {
            policyRevision: task.budget.policy.revision,
            thresholdStatus: task.budget.thresholdStatus,
            decisionRequired: task.budget.thresholdStatus === "decision-required"
          }
        } : {})
      });
    }
  }
  const hostWaitHandles = tasks
    .filter(task => task.waitAuthority === "host" && task.hostHandle)
    .map(task => task.hostHandle!);
  const runtimeThreadIds = tasks
    .filter(task => task.waitAuthority !== "host")
    .map(task => task.threadId || task.ownerThread);
  return {
    ...(requestedTaskIds.length > 0 ? { waitAuthority: "canonical" as const } : {}),
    requestedTaskIds,
    requestedThreadIds,
    tasks,
    threadIds: [...new Set([...runtimeThreadIds, ...requestedThreadIds])],
    ...(hostWaitHandles.length > 0 ? { hostWaitHandles: [...new Set(hostWaitHandles)] } : {})
  };
}

function projectStatuses(ids: string[], byId: Map<string, ThreadStatus>): ObservedThreadStatus[] {
  return ids.map(threadId => ({ threadId, status: byId.get(threadId) || { type: "notLoaded" as const } }));
}

function boundedOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ outcome: "success"; value: T } | { outcome: "timeout" } | { outcome: "abort" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: { outcome: "success"; value: T } | { outcome: "timeout" } | { outcome: "abort" }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(result);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(error);
    };
    const aborted = () => finish({ outcome: "abort" });
    if (signal?.aborted) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish({ outcome: "timeout" }), Math.max(0, timeoutMs));
    try {
      operation().then(value => finish({ outcome: "success", value }), failed);
    } catch (error) {
      failed(error);
    }
  });
}

function waitForSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  install: (wake: () => void, fail: (error: unknown) => void) => () => void
): Promise<"wake" | "timeout" | "abort"> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let installing = true;
    let pendingOutcome: "wake" | "timeout" | "abort" | undefined;
    let pendingError: unknown;
    let hasPendingError = false;
    let timer: NodeJS.Timeout | undefined;
    let uninstall = () => {};
    const finish = (result: "wake" | "timeout" | "abort") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      uninstall();
      signal?.removeEventListener("abort", aborted);
      resolve(result);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      uninstall();
      signal?.removeEventListener("abort", aborted);
      reject(error);
    };
    const aborted = () => finish("abort");
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (signal?.aborted) pendingOutcome = "abort";
    else signal?.addEventListener("abort", aborted, { once: true });
    uninstall = install(
      () => { if (installing) pendingOutcome = "wake"; else finish("wake"); },
      error => {
        if (installing) {
          pendingError = error;
          hasPendingError = true;
        } else failed(error);
      }
    );
    installing = false;
    if (hasPendingError) failed(pendingError);
    else if (pendingOutcome) finish(pendingOutcome);
  });
}

function waitForCursorSignal(
  adapter: ThreadStatusAdapter,
  cursor: string,
  threadIds: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<
  | { outcome: "change"; snapshot: { statuses: ObservedThreadStatus[]; cursor: string } }
  | { outcome: "timeout" }
  | { outcome: "abort" }
> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result:
      | { outcome: "change"; snapshot: { statuses: ObservedThreadStatus[]; cursor: string } }
      | { outcome: "timeout" }
      | { outcome: "abort" }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(result);
    };
    const aborted = () => {
      controller.abort();
      finish({ outcome: "abort" });
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish({ outcome: "timeout" });
    }, timeoutMs);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    if (settled) return;
    try {
      adapter.waitForCursorChange!(cursor, threadIds, controller.signal).then(
        value => finish({ outcome: "change", snapshot: value }),
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          reject(error);
        }
      );
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(error);
    }
  });
}

function hostHandoffReport(
  threadIds: string[],
  runtime: WaitRuntime,
  startedAt: number,
  now: () => number,
  signal?: AbortSignal,
  hostWaitHandles: string[] = []
): WaitReport {
  const aborted = Boolean(signal?.aborted);
  const handles = aborted ? [] : [...new Set(hostWaitHandles)];
  // `hostWaitThreadIds` is retained only for callers that supplied legacy
  // thread IDs. Structured host handles never get copied into this alias.
  const hostWaitThreadIds = aborted || handles.length > 0 ? [] : [...threadIds];
  const statuses = threadIds.map(threadId => ({
    threadId,
    // Desktop host state is intentionally not observed by this CLI. Keep the
    // status incomplete rather than manufacturing an idle/completed result.
    status: { type: "notLoaded" as const }
  }));
  return {
    mode: "handoff",
    waitAuthority: "host",
    threadIds: [...threadIds],
    wakeCount: 0,
    fallbackPollCount: 0,
    elapsedMs: Math.max(0, now() - startedAt),
    timedOut: false,
    aborted,
    incomplete: true,
    approvalNeeded: false,
    userInputNeeded: false,
    hostWaitRequired: hostWaitThreadIds.length > 0 || handles.length > 0,
    hostWaitThreadIds,
    hostWaitHandles: handles,
    // Preserve the 0.9.x compatibility aliases while making the positive
    // handoff vocabulary authoritative for new callers.
    hostFallbackRequired: hostWaitThreadIds.length > 0 || handles.length > 0,
    hostFallbackThreadIds: [...hostWaitThreadIds],
    statuses,
    warnings: [],
    diagnostics: {
      runtime: { ...runtime },
      surface: runtime.surface,
      executable: runtime.executable,
      executableSource: runtime.executableSource,
      codexSurface: runtime.surface,
      codexExecutable: runtime.executable,
      codexExecutableSource: runtime.executableSource,
      waitAuthority: "host",
      observation: "host-handoff",
      hostWaitRequired: hostWaitThreadIds.length > 0 || handles.length > 0,
      hostWaitThreadIds: [...hostWaitThreadIds],
      hostWaitHandles: handles
    }
  };
}

function normalizeHostWaitResult(value: unknown, threadIds: string[]): HostWaitResult {
  const candidate = isRecord(value) ? value : {};
  const statuses = Array.isArray(candidate.statuses)
    ? candidate.statuses.map(parseObservedStatus).filter((item): item is ObservedThreadStatus => Boolean(item))
    : [];
  const byId = new Map(statuses.map(item => [item.threadId, item.status]));
  const evidence = waitLossEvidence(candidate);
  return {
    statuses: threadIds.length > 0 ? projectStatuses(threadIds, byId) : statuses,
    ...(candidate.mode === "notification" || candidate.mode === "cursor" || candidate.mode === "poll"
      ? { mode: candidate.mode }
      : {}),
    ...(typeof candidate.wakeCount === "number" && Number.isSafeInteger(candidate.wakeCount) && candidate.wakeCount >= 0
      ? { wakeCount: candidate.wakeCount }
      : {}),
    ...(typeof candidate.fallbackPollCount === "number"
      && Number.isSafeInteger(candidate.fallbackPollCount)
      && candidate.fallbackPollCount >= 0
      ? { fallbackPollCount: candidate.fallbackPollCount }
      : {}),
    ...(evidence ? { lossCause: evidence.cause } : {}),
    ...(Array.isArray(candidate.warnings) ? { warnings: normalizeWarnings(candidate.warnings) } : {}),
    ...(isRecord(candidate.diagnostics) ? { diagnostics: candidate.diagnostics } : {})
  };
}

async function waitThroughHost(
  options: WaitForThreadsOptions,
  host: HostWaitAdapter,
  cleanupTimeoutMs: number,
  now: () => number
): Promise<WaitReport> {
  const ids = [...new Set(options.threadIds.map(value => String(value).trim()).filter(Boolean))];
  const handles = [...new Set([...(options.hostWaitHandles || []), ...(options.hostHandles || [])]
    .map(value => String(value).trim()).filter(Boolean))];
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timedOut = false;
  let aborted = false;
  let report: WaitReport | undefined;
  let failure: ReturnType<typeof asSynodError> | undefined;
  const cleanupWarnings: Warning[] = [];
  try {
    if (host.start) {
      const remaining = deadline - now();
      if (remaining <= 0) timedOut = true;
      else {
        const startOutcome = await boundedOperation(
          () => host.start!.call(host),
          remaining,
          options.signal
        );
        if (startOutcome.outcome === "timeout") timedOut = true;
        else if (startOutcome.outcome === "abort") aborted = true;
      }
    }
    if (!timedOut && !aborted) {
      const observe = host.wait
        ? (request: HostWaitRequest) => host.wait!.call(host, request)
        : host.observe
          ? (request: HostWaitRequest) => host.observe!.call(host, request)
          : undefined;
      if (observe) {
        const remaining = deadline - now();
        if (remaining <= 0) timedOut = true;
        else {
          const outcome = await boundedOperation(
            () => observe({
              threadIds: ids,
              ...(handles.length > 0 ? { hostWaitHandles: handles } : {}),
              ...(options.cwd ? { cwd: options.cwd } : {}),
              timeoutMs: remaining,
              pollIntervalMs,
              ...(options.signal ? { signal: options.signal } : {})
            }),
            remaining,
            options.signal
          );
          if (outcome.outcome === "timeout") timedOut = true;
          else if (outcome.outcome === "abort") aborted = true;
          else {
            const snapshot = normalizeHostWaitResult(outcome.value, ids);
            const evidence = waitLossEvidence({
              ...(isRecord(snapshot.diagnostics) ? snapshot.diagnostics : {}),
              ...(snapshot.lossCause ? { lossCause: snapshot.lossCause } : {})
            });
            const statuses = sanitizeStatuses(snapshot.statuses, evidence);
            const final = completion(statuses);
            const childLoss = childLossForStatuses(statuses, evidence);
            const lossCause = evidence?.cause;
            report = {
              mode: snapshot.mode || "poll",
              waitAuthority: "host",
              threadIds: ids,
              wakeCount: snapshot.wakeCount || 0,
              fallbackPollCount: snapshot.fallbackPollCount || 0,
              elapsedMs: Math.max(0, now() - startedAt),
              timedOut: false,
              aborted: false,
              incomplete: final.incomplete,
              approvalNeeded: final.approvalNeeded,
              userInputNeeded: final.userInputNeeded,
              hostWaitRequired: false,
              hostWaitThreadIds: [],
              hostWaitHandles: handles,
              hostFallbackRequired: false,
              hostFallbackThreadIds: [],
              statuses,
              ...(childLoss ? { childLoss } : {}),
              ...(lossCause ? { lossCause } : {}),
              warnings: snapshot.warnings || [],
              diagnostics: {
                ...(snapshot.diagnostics || {}),
                ...(childLoss ? { childLoss } : {}),
                ...reportDiagnostics(lossCause, evidence),
                waitAuthority: "host",
                observation: "host-adapter"
              }
            };
          }
        }
      } else if (!host.read) {
        throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "The injected host adapter has no wait, observe, or read method.");
      }
    }
    if (!report) {
      const statuses = ids.map(threadId => ({ threadId, status: { type: "notLoaded" as const } }));
      report = {
        mode: "poll",
        waitAuthority: "host",
        threadIds: ids,
        wakeCount: 0,
        fallbackPollCount: 0,
        elapsedMs: Math.max(0, now() - startedAt),
        timedOut,
        aborted,
        incomplete: true,
        approvalNeeded: false,
        userInputNeeded: false,
        hostWaitRequired: false,
        hostWaitThreadIds: [],
        hostWaitHandles: handles,
        hostFallbackRequired: false,
        hostFallbackThreadIds: [],
        statuses,
        ...(timedOut ? { lossCause: "wait-timeout" as const } : {}),
        warnings: [],
        diagnostics: {
          waitAuthority: "host",
          observation: "host-adapter",
          hostWaitHandles: handles,
          ...(timedOut ? reportDiagnostics("wait-timeout", undefined) : {})
        }
      };
    }
  } catch (error) {
    failure = asSynodError(error);
  } finally {
    if (host.close) {
      try {
        const closeOutcome = await boundedOperation(() => host.close!.call(host), cleanupTimeoutMs);
        if (closeOutcome.outcome === "timeout") {
          cleanupWarnings.push(warning(
            WARNING_CODES.WAIT_CLEANUP_FAILED,
            `Host wait cleanup did not finish within ${cleanupTimeoutMs}ms.`,
            { cleanupTimeoutMs }
          ));
        }
      } catch (error) {
        cleanupWarnings.push(warning(WARNING_CODES.WAIT_CLEANUP_FAILED, `Host wait cleanup failed: ${errorMessage(error)}`));
      }
    }
  }
  const warnings = [...normalizeWarnings(host.getWarnings ? host.getWarnings.call(host) : []), ...cleanupWarnings];
  const diagnostics = host.getDiagnostics ? host.getDiagnostics.call(host) : {};
  if (failure) {
    failure.warnings = warnings;
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return {
    ...report!,
    warnings: [...report!.warnings, ...warnings],
    diagnostics: { ...report!.diagnostics, ...diagnostics }
  };
}

export async function waitForThreads({
  threadIds,
  hostWaitHandles,
  hostHandles,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal
}: WaitForThreadsOptions, dependencies: WaitDependencies = {}): Promise<WaitReport> {
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const requestedIds = [...new Set(threadIds.map(value => String(value).trim()).filter(Boolean))];
  // A pre-authority lease may contain a collaboration path such as
  // `/root/worker`. Treat that legacy value as an opaque host handle at the
  // boundary, so no adapter/client can accidentally send it to thread/read.
  const legacyHostIds = requestedIds.filter(isPathLikeLegacyOwnerThread);
  const ids = requestedIds.filter((value): boolean => !isPathLikeLegacyOwnerThread(value));
  const handles = [...new Set([...(hostWaitHandles || []), ...(hostHandles || []), ...legacyHostIds]
    .map(value => String(value).trim()).filter(Boolean))];
  if ((ids.length === 0 && handles.length === 0) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_POLL_INTERVAL_MS
    || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait requires thread IDs or host handles, a positive timeout, and a poll interval of at most 5000ms.");
  }
  const now = dependencies.clock || (() => Date.now());
  const startedAt = now();
  const host = dependencies.hostAdapterFactory?.() || dependencies.hostAdapter;
  if (host && (host.wait || host.observe)) {
    return waitThroughHost({ threadIds: ids, ...(handles.length > 0 ? { hostWaitHandles: handles } : {}), ...(cwd ? { cwd } : {}), timeoutMs, pollIntervalMs, ...(signal ? { signal } : {}) }, host, cleanupTimeoutMs, now);
  }
  // Host handles are not Codex thread IDs. If the host cannot perform the
  // direct wait, hand them back without constructing an App Server or calling
  // thread/read with an opaque handle.
  if (ids.length === 0 && handles.length > 0 && !host?.wait && !host?.observe) {
    const runtime = (dependencies.runtimeResolver || resolveCodexRuntime)();
    return hostHandoffReport(ids, runtime, startedAt, now, signal, handles);
  }
  let hostAuthority = false;
  let adapter = dependencies.adapterFactory?.();
  if (!adapter && host?.read) {
    hostAuthority = true;
    adapter = {
      start: host.start
        ? () => host.start!.call(host)
        : async () => {},
      capabilities: host.capabilities
        ? () => host.capabilities!.call(host)
        : () => ({ notification: false, cursor: false }),
      read: threadIds => host.read!.call(host, threadIds),
      ...(host.subscribe
        ? { subscribe: (listener: (event: unknown) => void, onFailure: (error: unknown) => void) => host.subscribe!.call(host, listener, onFailure) }
        : {}),
      ...(host.waitForCursorChange
        ? { waitForCursorChange: (cursor: string, threadIds: string[], cursorSignal?: AbortSignal) => host.waitForCursorChange!.call(host, cursor, threadIds, cursorSignal) }
        : {}),
      close: host.close
        ? () => host.close!.call(host)
        : async () => {},
      ...(host.getWarnings ? { getWarnings: () => normalizeWarnings(host.getWarnings!.call(host)) } : {}),
      ...(host.getDiagnostics ? { getDiagnostics: () => host.getDiagnostics!.call(host) } : {})
    };
  }
  if (!adapter) {
    const runtime = (dependencies.runtimeResolver || resolveCodexRuntime)();
    // Desktop owns the live thread host. Resolve this boundary before any
    // child App Server/client is constructed; the CLI cannot invoke the host
    // primitive, so it returns an explicit incomplete handoff instead.
    if (runtime.surface === "desktop") {
      return hostHandoffReport(ids, runtime, startedAt, now, signal, handles);
    }
    const clientOptions = { ...(cwd ? { cwd } : {}), codexBin: runtime.executable };
    adapter = appServerThreadStatusAdapter(
      dependencies.clientFactory?.(clientOptions)
      || new CodexAppServerClient(clientOptions)
    );
  }
  const deadline = startedAt + timeoutMs;
  const waitAuthority: WaitAuthority = hostAuthority ? "host" : "appServer";
  let mode: WaitReport["mode"] = "poll";
  let wakeCount = 0;
  let fallbackPollCount = 0;
  let timedOut = false;
  let aborted = false;
  let unsubscribe = () => {};
  let notificationFailure: unknown;
  const notificationQueue: ObservedThreadStatus[] = [];
  let notificationWake: (() => void) | undefined;
  const byId = new Map<string, ThreadStatus>();
  let report: WaitReport | undefined;
  let failure: ReturnType<typeof asSynodError> | undefined;
  const cleanupWarnings: Warning[] = [];
  let hasObservedSnapshot = false;

  try {
    const startOutcome = await boundedOperation(() => adapter.start(), deadline - now(), signal);
    if (startOutcome.outcome === "timeout") timedOut = true;
    else if (startOutcome.outcome === "abort") aborted = true;
    else {
      const capabilities = adapter.capabilities();
      if (capabilities.notification && adapter.subscribe) mode = "notification";
      else if (capabilities.cursor && adapter.waitForCursorChange) mode = "cursor";

      if (mode === "notification") {
        unsubscribe = adapter.subscribe!(value => {
          const parsed = parseObservedStatus(value);
          if (!parsed || !ids.includes(parsed.threadId)) return;
          notificationQueue.push(parsed);
          notificationWake?.();
        }, error => {
          notificationFailure = error;
          notificationWake?.();
        });
      }

      let snapshot: { statuses: ObservedThreadStatus[]; cursor?: string } | undefined;
      while (!timedOut && !aborted) {
        const readOutcome = await boundedOperation(() => adapter.read(ids), deadline - now(), signal);
        if (readOutcome.outcome === "timeout") { timedOut = true; break; }
        if (readOutcome.outcome === "abort") { aborted = true; break; }
        snapshot = readOutcome.value;
        hasObservedSnapshot = true;
        for (const item of snapshot.statuses) byId.set(item.threadId, item.status);
        if (notificationFailure) throw notificationFailure;
        if (mode !== "notification" || notificationQueue.length === 0) break;

        // A notification observed while thread/read is in flight has ambiguous
        // ordering relative to the response. Count it, then reconcile with a
        // fresh bounded read instead of letting either value win by timing.
        wakeCount += notificationQueue.length;
        notificationQueue.length = 0;
      }

      if (snapshot && !timedOut && !aborted) {
        while (true) {
          const statuses = projectStatuses(ids, byId);
          if (completion(statuses).done) break;
          const remaining = deadline - now();
          if (remaining <= 0) { timedOut = true; break; }
          if (signal?.aborted) { aborted = true; break; }

          if (mode === "notification") {
            if (notificationQueue.length === 0 && !notificationFailure) {
              const outcome = await waitForSignal(remaining, signal, (wake, fail) => {
                notificationWake = wake;
                if (notificationFailure) fail(notificationFailure);
                return () => { notificationWake = undefined; };
              });
              if (outcome === "timeout") { timedOut = true; break; }
              if (outcome === "abort") { aborted = true; break; }
            }
            if (notificationFailure) throw notificationFailure;
            while (notificationQueue.length > 0) {
              const item = notificationQueue.shift()!;
              byId.set(item.threadId, item.status);
              wakeCount += 1;
            }
          } else if (mode === "cursor") {
            const cursor = snapshot.cursor;
            if (!cursor) throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Cursor wait mode requires an opaque status cursor.");
            const outcome = await waitForCursorSignal(adapter, cursor, ids, remaining, signal);
            if (outcome.outcome === "timeout") { timedOut = true; break; }
            if (outcome.outcome === "abort") { aborted = true; break; }
            snapshot = outcome.snapshot;
            hasObservedSnapshot = true;
            for (const item of snapshot.statuses) byId.set(item.threadId, item.status);
            wakeCount += 1;
          } else {
            try {
              await delay(Math.min(pollIntervalMs, remaining), undefined, signal ? { signal } : undefined);
            } catch (error) {
              if (signal?.aborted) { aborted = true; break; }
              throw error;
            }
            const pollOutcome = await boundedOperation(() => adapter.read(ids), deadline - now(), signal);
            if (pollOutcome.outcome === "timeout") { timedOut = true; break; }
            if (pollOutcome.outcome === "abort") { aborted = true; break; }
            snapshot = pollOutcome.value;
            hasObservedSnapshot = true;
            for (const item of snapshot.statuses) byId.set(item.threadId, item.status);
            fallbackPollCount += 1;
          }
        }
      }
    }

    const rawStatuses = projectStatuses(ids, byId);
    const observationDiagnostics = adapter.getDiagnostics?.() || {};
    const evidence = waitLossEvidence(observationDiagnostics);
    const statuses = sanitizeStatuses(rawStatuses, evidence);
    const final = completion(statuses);
    const childLoss = childLossForStatuses(statuses, evidence);
    const lossCause = evidence?.cause
      || (timedOut ? "wait-timeout" as const : rawStatuses.some(item => item.status.type === "systemError") ? "authority-lost" as const : undefined);
    const endpointLoss = evidence?.cause === "endpoint-expired"
      || evidence?.cause === "endpoint-unreachable"
      || evidence?.cause === "endpoint-owner-exited"
      || evidence?.cause === "authority-lost";
    const authorityLost = !hostAuthority && (
      (endpointLoss && statuses.every(item => item.status.type === "notLoaded"))
      || (!evidence && rawStatuses.some(item => item.status.type === "systemError"))
      || (timedOut && !hasObservedSnapshot)
    );
    const observedAuthority: WaitObservationAuthority = authorityLost ? "unknown" : waitAuthority;
    const hostWaitThreadIds = !hostAuthority && hasObservedSnapshot && !aborted
      ? statuses.filter(item => item.status.type === "notLoaded").map(item => item.threadId)
      : [];
    report = {
      mode,
      waitAuthority: observedAuthority,
      threadIds: ids,
      wakeCount,
      fallbackPollCount,
      elapsedMs: Math.max(0, now() - startedAt),
      timedOut,
      aborted,
      incomplete: timedOut || aborted || final.incomplete || handles.length > 0,
      approvalNeeded: final.approvalNeeded,
      userInputNeeded: final.userInputNeeded,
      hostWaitRequired: hostWaitThreadIds.length > 0 || handles.length > 0,
      hostWaitThreadIds,
      hostWaitHandles: handles,
      hostFallbackRequired: hostWaitThreadIds.length > 0 || handles.length > 0,
      hostFallbackThreadIds: [...hostWaitThreadIds],
      statuses,
      ...(childLoss ? { childLoss } : {}),
      ...(lossCause ? { lossCause } : {}),
      warnings: [],
      diagnostics: {
        ...(childLoss ? { childLoss } : {}),
        ...reportDiagnostics(lossCause, evidence),
        ...(observedAuthority !== waitAuthority ? { waitAuthority: observedAuthority } : {}),
        ...(handles.length > 0 ? {
          hostWaitRequired: true,
          hostWaitHandles: handles
        } : {})
      }
    };
  } catch (error) {
    failure = asSynodError(error);
  } finally {
    try {
      unsubscribe();
    } catch (error) {
      const cleanupFailure = new SynodError(
        ERROR_CODES.WAIT_CLEANUP_FAILED,
        `Wait listener cleanup failed: ${errorMessage(error)}`,
        { cause: error }
      );
      cleanupWarnings.push(warning(WARNING_CODES.WAIT_CLEANUP_FAILED, cleanupFailure.message));
      failure ||= cleanupFailure;
    }
    try {
      const closeOutcome = await boundedOperation(() => adapter.close(), cleanupTimeoutMs);
      if (closeOutcome.outcome === "timeout") {
        const cleanupFailure = new SynodError(
          ERROR_CODES.WAIT_CLEANUP_FAILED,
          `Wait cleanup did not finish within ${cleanupTimeoutMs}ms.`,
          { details: { cleanupTimeoutMs } }
        );
        cleanupWarnings.push(warning(
          WARNING_CODES.WAIT_CLEANUP_FAILED,
          cleanupFailure.message,
          cleanupFailure.details
        ));
        failure ||= cleanupFailure;
      }
    } catch (error) {
      const cleanupFailure = new SynodError(
        ERROR_CODES.WAIT_CLEANUP_FAILED,
        `Wait cleanup failed: ${errorMessage(error)}`,
        { cause: error }
      );
      cleanupWarnings.push(warning(WARNING_CODES.WAIT_CLEANUP_FAILED, cleanupFailure.message));
      failure ||= cleanupFailure;
    }
  }
  const warnings = [...normalizeWarnings(adapter.getWarnings?.()), ...cleanupWarnings];
  const diagnostics = adapter.getDiagnostics?.() || {};
  if (failure) {
    failure.warnings = warnings;
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return {
    ...report!,
    warnings,
    diagnostics: { ...report!.diagnostics, ...diagnostics }
  };
}

export function formatWaitReport(report: WaitReport, selection?: WaitSelection): string {
  const lines: string[] = [];
  for (const task of selection?.tasks || []) {
    lines.push(`${task.taskId}: ${task.state} r${task.revision}; lease ${task.leaseId} g${task.generation}; owner ${task.ownerThread}`);
  }
  if (selection?.waitAuthority === "canonical") {
    lines.push("Selection authority: canonical (task state; runtime completion is not implied)");
  }
  lines.push(
    `Synod wait: ${report.incomplete ? "attention required" : "complete"}`,
    `Authority: ${report.waitAuthority}; Mode: ${report.mode}; wakes ${report.wakeCount}; fallback polls ${report.fallbackPollCount}; elapsed ${report.elapsedMs}ms`,
    `Timed out: ${report.timedOut ? "yes" : "no"}; aborted: ${report.aborted ? "yes" : "no"}; approval needed: ${report.approvalNeeded ? "yes" : "no"}; user input needed: ${report.userInputNeeded ? "yes" : "no"}`
  );
  if (report.hostWaitRequired) {
    const handles = report.hostWaitHandles || [];
    lines.push(`Host wait required: ${[...report.hostWaitThreadIds, ...handles].join(", ")}`);
  }
  if (report.childLoss) lines.push(`Child loss: ${report.childLoss}`);
  for (const item of report.statuses) {
    const flags = item.status.type === "active" && item.status.activeFlags.length > 0
      ? ` (${item.status.activeFlags.join(", ")})`
      : "";
    lines.push(`${item.threadId}: ${item.status.type}${flags}`);
  }
  return lines.join("\n");
}
