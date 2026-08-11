import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "./app-server.js";
import type { AppServerDiagnostics, AppServerEvent } from "./app-server.js";
import { WARNING_CODES, warning } from "./contracts.js";
import type { Warning } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
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

export interface WaitForThreadsOptions {
  threadIds: string[];
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitReport {
  mode: "notification" | "cursor" | "poll";
  threadIds: string[];
  wakeCount: number;
  fallbackPollCount: number;
  elapsedMs: number;
  timedOut: boolean;
  aborted: boolean;
  incomplete: boolean;
  approvalNeeded: boolean;
  userInputNeeded: boolean;
  statuses: ObservedThreadStatus[];
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

export interface WaitDependencies {
  adapterFactory?: () => ThreadStatusAdapter;
  clientFactory?: (options?: { cwd?: string }) => WaitClient;
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
    getWarnings: () => client.getWarnings?.() || [],
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
  const attentionNeeded = approvalNeeded || userInputNeeded;
  return {
    done: attentionNeeded || terminal,
    approvalNeeded,
    userInputNeeded,
    incomplete: attentionNeeded || systemError || !terminal
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

export async function waitForThreads({
  threadIds,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  signal
}: WaitForThreadsOptions, dependencies: WaitDependencies = {}): Promise<WaitReport> {
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const ids = [...new Set(threadIds.map(value => String(value).trim()).filter(Boolean))];
  if (ids.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > MAX_POLL_INTERVAL_MS
    || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait requires thread IDs, a positive timeout, and a poll interval of at most 5000ms.");
  }
  const adapter = dependencies.adapterFactory?.()
    || appServerThreadStatusAdapter(
      dependencies.clientFactory?.(cwd ? { cwd } : undefined)
      || new CodexAppServerClient(cwd ? { cwd } : {})
    );
  const now = dependencies.clock || (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
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
            for (const item of snapshot.statuses) byId.set(item.threadId, item.status);
            fallbackPollCount += 1;
          }
        }
      }
    }

    const statuses = projectStatuses(ids, byId);
    const final = completion(statuses);
    report = {
      mode,
      threadIds: ids,
      wakeCount,
      fallbackPollCount,
      elapsedMs: Math.max(0, now() - startedAt),
      timedOut,
      aborted,
      incomplete: timedOut || aborted || final.incomplete,
      approvalNeeded: final.approvalNeeded,
      userInputNeeded: final.userInputNeeded,
      statuses,
      warnings: [],
      diagnostics: {}
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
  const warnings = [...(adapter.getWarnings?.() || []), ...cleanupWarnings];
  const diagnostics = adapter.getDiagnostics?.() || {};
  if (failure) {
    failure.warnings = warnings;
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return {
    ...report!,
    warnings,
    diagnostics
  };
}

export function formatWaitReport(report: WaitReport): string {
  const lines = [
    `Synod wait: ${report.incomplete ? "attention required" : "complete"}`,
    `Mode: ${report.mode}; wakes ${report.wakeCount}; fallback polls ${report.fallbackPollCount}; elapsed ${report.elapsedMs}ms`,
    `Timed out: ${report.timedOut ? "yes" : "no"}; aborted: ${report.aborted ? "yes" : "no"}; approval needed: ${report.approvalNeeded ? "yes" : "no"}; user input needed: ${report.userInputNeeded ? "yes" : "no"}`
  ];
  for (const item of report.statuses) {
    const flags = item.status.type === "active" && item.status.activeFlags.length > 0
      ? ` (${item.status.activeFlags.join(", ")})`
      : "";
    lines.push(`${item.threadId}: ${item.status.type}${flags}`);
  }
  return lines.join("\n");
}
