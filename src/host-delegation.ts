import { setInterval, clearInterval } from "node:timers";
import { ERROR_CODES, SynodError, asSynodError, withErrorDetails } from "./errors.js";
import {
  bindTaskLease,
  cancelTaskLeaseReservation,
  expireTaskLeaseReservation,
  heartbeatTaskLease,
  reserveTaskLease,
  type LeaseIdentityOptions,
  type LeaseReservationIdentityOptions,
  type ReserveLeaseOptions
} from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import type { LeaseScope, TaskLease, TaskLeaseReservation } from "./leases.js";
import {
  waitForThreads,
  type HostWaitAdapter,
  type WaitDependencies,
  type WaitForThreadsOptions,
  type WaitReport
} from "./wait.js";
import { isRecord } from "./validation.js";

/** The opaque identity returned by the host. Synod never derives or rewrites it. */
export type HostOwnerIdentifier = string;

export interface HostDelegationReservationFence {
  reservationToken: string;
  leaseId: string;
  generation: number;
  revision: number;
  expectedReservedAt: string;
  baselineHash: string;
}

export interface HostDelegationReadOnlyContract {
  taskId: string;
  taskRevision: number;
  scopes: ReadonlyArray<LeaseScope>;
  writeAuthorized: false;
  instruction: "analysis may begin; writes, worktrees, and implementation commands wait for bind authorization";
}

export interface HostDelegationSpawnRequest {
  taskId: string;
  directory: string;
  reservation: TaskLeaseReservation;
  reservationFence: HostDelegationReservationFence;
  writeAuthorized: false;
  readOnlyContract: HostDelegationReadOnlyContract;
  /** Alias retained for adapters that call this handoff the initial contract. */
  initialContract: HostDelegationReadOnlyContract;
  /** Short alias for hosts that use a generic contract field. */
  contract: HostDelegationReadOnlyContract;
}

export type HostDelegationSpawnResult =
  | HostOwnerIdentifier
  | {
      ownerThread?: HostOwnerIdentifier;
      ownerId?: HostOwnerIdentifier;
      owner?: HostOwnerIdentifier;
      threadId?: HostOwnerIdentifier;
      [key: string]: unknown;
    };

export interface HostDelegationLeaseFence {
  leaseId: string;
  generation: number;
  revision: number;
  expectedHeartbeatAt: string;
  ownerThread: HostOwnerIdentifier;
}

export interface HostDelegationAuthorizeRequest {
  taskId: string;
  directory: string;
  ownerThread: HostOwnerIdentifier;
  writeAuthorized: true;
  reservation: TaskLeaseReservation;
  lease: TaskLease;
  leaseFence: HostDelegationLeaseFence;
}

export interface HostAuthorizationReceipt {
  status: "authorized" | "accepted" | "failed" | "rejected" | "denied";
  receipt?: unknown;
  [key: string]: unknown;
}

/**
 * A host owns the Codex executor. Synod can request the spawn and send the
 * post-bind authorization receipt, but it does not create a Codex process.
 */
export interface HostDelegationAdapter extends HostWaitAdapter {
  spawn(request: HostDelegationSpawnRequest): Promise<HostDelegationSpawnResult>;
  authorize(request: HostDelegationAuthorizeRequest): Promise<HostAuthorizationReceipt | unknown>;
}

export interface HostDelegationWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Test/integration scheduler bound; canonical lease policy remains unchanged. */
  heartbeatIntervalMs?: number;
}

export interface HostDelegationOptions extends Omit<ReserveLeaseOptions, "id"> {
  id?: string;
  taskId?: string;
  adapter?: HostDelegationAdapter;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  evidence?: unknown[];
  wait?: boolean | HostDelegationWaitOptions;
  signal?: AbortSignal;
}

export interface HostDelegationDependencies extends OrchestrationDependencies {
  reserve?: typeof reserveTaskLease;
  bind?: typeof bindTaskLease;
  cancel?: typeof cancelTaskLeaseReservation;
  expire?: typeof expireTaskLeaseReservation;
  heartbeat?: typeof heartbeatTaskLease;
  wait?: typeof waitForThreads;
  hostAdapter?: HostWaitAdapter;
  hostAdapterFactory?: () => HostWaitAdapter;
  cleanupTimeoutMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

type ReservationResult = Awaited<ReturnType<typeof reserveTaskLease>>;
type BindResult = Awaited<ReturnType<typeof bindTaskLease>>;
type CancelResult = Awaited<ReturnType<typeof cancelTaskLeaseReservation>>;
type ExpireResult = Awaited<ReturnType<typeof expireTaskLeaseReservation>>;

export interface HostLivenessDiagnostics {
  status: "stopped";
  stopReason: "complete" | "attention" | "abort" | "timeout" | "incomplete" | "error" | "heartbeat-error";
  heartbeatCount: number;
  heartbeatErrors: Array<{ code: string; message: string }>;
  cleanup: {
    status: "complete" | "failed";
    inFlightHeartbeat: boolean;
    error?: { code: string; message: string };
  };
  finalFence: HostDelegationLeaseFence;
}

export interface HostDelegationResult {
  directory: string;
  task: ReservationResult["task"];
  reservation: TaskLeaseReservation;
  reservationFence: HostDelegationReservationFence;
  spawn: HostDelegationSpawnResult;
  ownerThread: HostOwnerIdentifier;
  lease: TaskLease;
  leaseFence: HostDelegationLeaseFence;
  authorization: HostAuthorizationReceipt;
  bind: BindResult;
  wait?: WaitReport;
  liveness?: HostLivenessDiagnostics;
  cleanup?: { status: "not-required" | "complete" | "failed"; error?: { code: string; message: string } };
}

function taskIdentifier(options: HostDelegationOptions): string {
  const id = String(options.id || options.taskId || "").trim();
  if (!id) throw new SynodError(ERROR_CODES.TASK_INVALID, "Host delegation requires a task ID.");
  return id;
}

function reservationFence(reservation: TaskLeaseReservation): HostDelegationReservationFence {
  return {
    reservationToken: reservation.token,
    leaseId: reservation.id,
    generation: reservation.generation,
    revision: reservation.taskRevision,
    expectedReservedAt: reservation.reservedAt,
    baselineHash: reservation.baseline.snapshotContentHash
  };
}

function leaseFence(lease: TaskLease): HostDelegationLeaseFence {
  return {
    leaseId: lease.id,
    generation: lease.generation,
    revision: lease.taskRevision,
    expectedHeartbeatAt: lease.heartbeatAt,
    ownerThread: lease.ownerThread
  };
}

function ownerFromSpawn(value: HostDelegationSpawnResult): HostOwnerIdentifier | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  for (const key of ["ownerThread", "ownerId", "owner", "threadId"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function authorizationReceipt(value: unknown): HostAuthorizationReceipt {
  // Legacy adapters that returned void remain compatible; every structured
  // receipt must carry an explicit positive status or it fails closed.
  if (value === undefined) return { status: "authorized", receipt: value };
  if (typeof value === "string") {
    const status = value.toLowerCase();
    return status === "authorized" || status === "accepted"
      ? { status, receipt: value }
      : { status: "failed", receipt: value };
  }
  if (!isRecord(value)) return { status: "failed", receipt: value };
  const status = typeof value.status === "string" ? value.status.toLowerCase() : undefined;
  const accepted = status === "authorized" || status === "accepted";
  return {
    ...value,
    status: (accepted ? status : "failed") as HostAuthorizationReceipt["status"]
  };
}

function conciseError(error: unknown): { code: string; message: string } {
  const value = asSynodError(error);
  return { code: value.code, message: value.message };
}

async function cancelReservationAfterFailure(
  error: unknown,
  fallbackCode: typeof ERROR_CODES[keyof typeof ERROR_CODES],
  phase: string,
  reservation: TaskLeaseReservation,
  options: HostDelegationOptions,
  dependencies: HostDelegationDependencies
): Promise<never> {
  const failure = asSynodError(error, fallbackCode);
  let cleanup: { status: "complete" | "failed"; result?: CancelResult; error?: { code: string; message: string } };
  try {
    const cancel = dependencies.cancel || cancelTaskLeaseReservation;
    const result = await cancel({
      directory: options.directory || ".",
      id: reservation.taskId,
      reservationToken: reservation.token,
      leaseId: reservation.id,
      generation: reservation.generation,
      revision: reservation.taskRevision,
      expectedReservedAt: reservation.reservedAt,
      baselineHash: reservation.baseline.snapshotContentHash,
      reason: `${phase}: ${failure.message}`,
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
    cleanup = { status: "complete", result };
  } catch (cleanupError) {
    cleanup = { status: "failed", error: conciseError(cleanupError) };
  }
  failure.details = {
    ...(isRecord(failure.details) ? failure.details : {}),
    phase,
    reservation: {
      taskId: reservation.taskId,
      leaseId: reservation.id,
      generation: reservation.generation,
      revision: reservation.taskRevision,
      reservedAt: reservation.reservedAt,
      baselineHash: reservation.baseline.snapshotContentHash
    },
    cleanup: cleanup.status === "complete"
      ? { status: cleanup.status }
      : { status: cleanup.status, error: cleanup.error }
  };
  throw failure;
}

async function expireReservationAfterFailure(
  error: unknown,
  fallbackCode: typeof ERROR_CODES[keyof typeof ERROR_CODES],
  phase: string,
  reservation: TaskLeaseReservation,
  options: HostDelegationOptions,
  dependencies: HostDelegationDependencies
): Promise<never> {
  const failure = asSynodError(error, fallbackCode);
  let cleanup: { status: "complete" | "failed"; result?: ExpireResult; error?: { code: string; message: string } };
  try {
    const expire = dependencies.expire || expireTaskLeaseReservation;
    const result = await expire({
      directory: options.directory || ".",
      id: reservation.taskId,
      reservationToken: reservation.token,
      leaseId: reservation.id,
      generation: reservation.generation,
      revision: reservation.taskRevision,
      expectedReservedAt: reservation.reservedAt,
      baselineHash: reservation.baseline.snapshotContentHash,
      reason: `${phase}: ${failure.message}`,
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
    cleanup = { status: "complete", result };
  } catch (cleanupError) {
    cleanup = { status: "failed", error: conciseError(cleanupError) };
  }
  failure.details = {
    ...(isRecord(failure.details) ? failure.details : {}),
    phase,
    reservation: {
      taskId: reservation.taskId,
      leaseId: reservation.id,
      generation: reservation.generation,
      revision: reservation.taskRevision,
      reservedAt: reservation.reservedAt,
      expiresAt: reservation.expiresAt,
      baselineHash: reservation.baseline.snapshotContentHash
    },
    cleanup: cleanup.status === "complete"
      ? { status: cleanup.status, action: "expire" }
      : { status: cleanup.status, action: "expire", error: cleanup.error }
  };
  throw failure;
}

type HostSpawnOutcome =
  | { status: "success"; value: HostDelegationSpawnResult }
  | { status: "failure"; error: unknown }
  | { status: "timeout" };

type ReservationDeadlineOutcome = "expired" | "aborted";

function waitUntilReservationExpiry(
  expiresAt: string,
  clock: () => number = () => Date.now(),
  signal?: AbortSignal
): Promise<ReservationDeadlineOutcome> {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return Promise.resolve("expired");
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ReservationDeadlineOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(outcome);
    };
    const aborted = () => finish("aborted");
    const armDeadline = () => {
      if (settled) return;
      const remaining = deadline - clock();
      if (remaining <= 0) {
        finish("expired");
        return;
      }
      timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    if (signal?.aborted) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    armDeadline();
  });
}

function spawnBoundedByReservation(
  adapter: HostDelegationAdapter,
  request: HostDelegationSpawnRequest,
  expiresAt: string,
  clock: () => number = () => Date.now()
): Promise<HostSpawnOutcome> {
  const remainingMs = Date.parse(expiresAt) - clock();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return Promise.resolve({ status: "timeout" });
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const armDeadline = () => {
      timer = setTimeout(() => {
        if (settled) return;
        const left = Date.parse(expiresAt) - clock();
        if (left > 0) {
          armDeadline();
          return;
        }
        settled = true;
        resolve({ status: "timeout" });
      }, Math.min(Math.max(0, Date.parse(expiresAt) - clock()), 2_147_483_647));
    };
    armDeadline();
    Promise.resolve()
      .then(() => adapter.spawn(request))
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "success", value });
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "failure", error });
      });
  });
}

function authorizationFailure(
  value: unknown,
  result: { task: HostDelegationResult["task"]; lease: TaskLease; ownerThread: string }
): SynodError {
  const failure = new SynodError(ERROR_CODES.HOST_AUTHORIZATION_FAILED, "Host authorization was not accepted after the writer lease was bound.", {
    details: {
      taskId: result.task.id,
      lease: result.lease,
      ownerThread: result.ownerThread,
      authorization: authorizationReceipt(value),
      recovery: {
        status: "lease-bound-awaiting-authorization",
        action: "preserve-bound-lease",
        next: "supervisor must inspect the host and use the exact active lease fence for recovery"
      }
    }
  });
  return failure;
}

/** Reserve, host-spawn read-only, bind the returned opaque owner, then authorize. */
export async function startHostDelegation(
  options: HostDelegationOptions = {},
  dependencies: HostDelegationDependencies = {}
): Promise<HostDelegationResult> {
  const adapter = options.adapter;
  if (!adapter) throw new SynodError(ERROR_CODES.HOST_ADAPTER_REQUIRED, "Host delegation requires an injected host adapter.");
  if (typeof adapter.spawn !== "function" || typeof adapter.authorize !== "function") {
    throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "The injected host adapter must expose spawn and authorize methods.");
  }
  const id = taskIdentifier(options);
  const reserve = dependencies.reserve || reserveTaskLease;
  const reserved = await reserve({
    id,
    directory: options.directory || ".",
    read: options.read || [],
    write: options.write || [],
    readTree: options.readTree || [],
    writeTree: options.writeTree || [],
    ...(options.reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds: options.reservationTtlSeconds }),
    ...(options.actor === undefined ? {} : { actor: options.actor })
  }, dependencies);
  const reservation = reserved.reservation;
  const reservedFence = reservationFence(reservation);
  const readOnlyContract: HostDelegationReadOnlyContract = {
    taskId: id,
    taskRevision: reservation.taskRevision,
    scopes: reservation.scopes,
    writeAuthorized: false,
    instruction: "analysis may begin; writes, worktrees, and implementation commands wait for bind authorization"
  };
  const clock = () => {
    const observed = dependencies.clock?.() ?? Date.now();
    return observed instanceof Date ? observed.getTime() : typeof observed === "number" ? observed : Date.parse(observed);
  };
  const spawnRequest: HostDelegationSpawnRequest = {
    taskId: id,
    directory: options.directory || ".",
    reservation,
    reservationFence: reservedFence,
    writeAuthorized: false,
    readOnlyContract,
    initialContract: readOnlyContract,
    contract: readOnlyContract
  };
  const spawnOutcome = await spawnBoundedByReservation(adapter, spawnRequest, reservation.expiresAt, clock);
  if (spawnOutcome.status === "failure") {
    return cancelReservationAfterFailure(spawnOutcome.error, ERROR_CODES.HOST_SPAWN_FAILED, "spawn", reservation, options, dependencies);
  }
  if (spawnOutcome.status === "timeout") {
    return expireReservationAfterFailure(
      new SynodError(ERROR_CODES.HOST_SPAWN_TIMEOUT, "Host spawn did not return an owner before the reservation expired."),
      ERROR_CODES.HOST_SPAWN_TIMEOUT,
      "spawn-timeout",
      reservation,
      options,
      dependencies
    );
  }
  const spawned = spawnOutcome.value;
  const ownerThread = ownerFromSpawn(spawned);
  if (!ownerThread) {
    const deadlineOutcome = await waitUntilReservationExpiry(reservation.expiresAt, clock, options.signal);
    if (deadlineOutcome === "aborted") {
      const failure = new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Host spawn returned no opaque owner identifier before the reservation expired.", {
        details: {
          phase: "missing-owner",
          reservation: {
            taskId: reservation.taskId,
            leaseId: reservation.id,
            generation: reservation.generation,
            revision: reservation.taskRevision,
            expiresAt: reservation.expiresAt,
            baselineHash: reservation.baseline.snapshotContentHash
          },
          cleanup: {
            status: "deferred",
            action: "expire",
            reason: "waiting for the reservation deadline was aborted"
          }
        }
      });
      throw failure;
    }
    return expireReservationAfterFailure(
      new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Host spawn returned no opaque owner identifier."),
      ERROR_CODES.HOST_OWNER_MISSING,
      "missing-owner",
      reservation,
      options,
      dependencies
    );
  }
  if (clock() >= Date.parse(reservation.expiresAt)) {
    return expireReservationAfterFailure(
      new SynodError(ERROR_CODES.HOST_SPAWN_TIMEOUT, "Host spawn returned an owner after the reservation expired."),
      ERROR_CODES.HOST_SPAWN_TIMEOUT,
      "spawn-timeout",
      reservation,
      options,
      dependencies
    );
  }
  const bind = dependencies.bind || bindTaskLease;
  let bound: BindResult;
  try {
    bound = await bind({
      directory: options.directory || ".",
      id,
      ...reservedFence,
      ownerThread,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      ...(options.heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds }),
      evidence: options.evidence || [],
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
  } catch (error) {
    return cancelReservationAfterFailure(error, ERROR_CODES.LEASE_STALE, "bind", reservation, options, dependencies);
  }
  let authorization: HostAuthorizationReceipt;
  try {
    const value = await adapter.authorize({
      taskId: id,
      directory: options.directory || ".",
      ownerThread,
      writeAuthorized: true,
      reservation,
      lease: bound.lease,
      leaseFence: leaseFence(bound.lease)
    });
    authorization = authorizationReceipt(value);
    if (authorization.status === "failed" || authorization.status === "rejected" || authorization.status === "denied") {
      throw authorizationFailure(authorization, { task: bound.task, lease: bound.lease, ownerThread });
    }
  } catch (error) {
    if (error instanceof SynodError && error.code === ERROR_CODES.HOST_AUTHORIZATION_FAILED) throw error;
    throw withErrorDetails(
      authorizationFailure(error, { task: bound.task, lease: bound.lease, ownerThread }),
      { cause: conciseError(error) }
    );
  }
  const result: HostDelegationResult = {
    directory: options.directory || ".",
    task: bound.task,
    reservation,
    reservationFence: reservedFence,
    spawn: spawned,
    ownerThread,
    lease: bound.lease,
    leaseFence: leaseFence(bound.lease),
    authorization,
    bind: bound,
    cleanup: { status: "not-required" }
  };
  if (options.wait) {
    const waitOptions = typeof options.wait === "object" ? options.wait : {};
    const waited = await waitForHostDelegation(result, adapter, waitOptions, dependencies);
    result.wait = waited.report;
    result.liveness = waited.liveness;
  }
  return result;
}

export interface HostDelegationWaitResult {
  report: WaitReport;
  liveness: HostLivenessDiagnostics;
}

/** Wait through the injected host while renewing only the exact active lease fence. */
export async function waitForHostDelegation(
  delegation: Pick<HostDelegationResult, "task" | "lease" | "ownerThread"> & { directory?: string },
  adapter: HostDelegationAdapter,
  options: HostDelegationWaitOptions = {},
  dependencies: HostDelegationDependencies = {}
): Promise<HostDelegationWaitResult> {
  if (typeof adapter.wait !== "function" && typeof adapter.observe !== "function" && typeof adapter.read !== "function") {
    throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "The injected host adapter must expose wait, observe, or read for host observation.");
  }
  const intervalMs = options.heartbeatIntervalMs ?? delegation.lease.heartbeatIntervalSeconds * 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new SynodError(ERROR_CODES.HOST_LIVENESS_FAILED, "Host heartbeat interval must be a positive integer.");
  }
  const controller = new AbortController();
  const abortForward = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortForward, { once: true });
  const heartbeat = dependencies.heartbeat || heartbeatTaskLease;
  const schedule = dependencies.setInterval || setInterval;
  const unschedule = dependencies.clearInterval || clearInterval;
  let fence = leaseFence(delegation.lease);
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let heartbeatCount = 0;
  const heartbeatErrors: Array<{ code: string; message: string }> = [];
  let stopReason: HostLivenessDiagnostics["stopReason"] = "error";
  let cleanupError: { code: string; message: string } | undefined;

  const pulse = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const request: LeaseIdentityOptions = {
      directory: delegation.directory || ".",
      id: delegation.task.id,
      leaseId: fence.leaseId,
      generation: fence.generation,
      revision: fence.revision,
      expectedHeartbeatAt: fence.expectedHeartbeatAt,
      ownerThread: fence.ownerThread
    };
    inFlight = (async () => {
      const value = await heartbeat(request, dependencies);
      const next = value.lease;
      if (
        next.id !== fence.leaseId
        || next.generation !== fence.generation
        || next.taskRevision !== fence.revision
        || next.ownerThread !== fence.ownerThread
        || Date.parse(next.heartbeatAt) < Date.parse(fence.expectedHeartbeatAt)
      ) {
        throw new SynodError(ERROR_CODES.HOST_LIVENESS_FAILED, "Host heartbeat returned a stale or mismatched lease fence.", {
          details: { expected: fence, actual: next }
        });
      }
      fence = { ...fence, expectedHeartbeatAt: next.heartbeatAt };
      heartbeatCount += 1;
    })().catch(error => {
      const value = asSynodError(error, ERROR_CODES.HOST_LIVENESS_FAILED);
      heartbeatErrors.push(conciseError(value));
      controller.abort();
      throw value;
    }).finally(() => {
      inFlight = undefined;
    });
    try {
      await inFlight;
    } catch {
      // The diagnostic and abort signal carry the truthful failure to the wait.
    }
  };
  const stop = async (reason: HostLivenessDiagnostics["stopReason"]): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    if (timer !== undefined) unschedule(timer);
    if (inFlight) await inFlight;
  };
  timer = schedule(() => { void pulse(); }, intervalMs);
  try {
    const wait = dependencies.wait || waitForThreads;
    const waitOptions: WaitForThreadsOptions = {
      threadIds: [delegation.ownerThread],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      signal: controller.signal
    };
    const report = await wait(waitOptions, { hostAdapter: adapter });
    stopReason = heartbeatErrors.length > 0
      ? "heartbeat-error"
      : report.aborted
        ? "abort"
      : report.approvalNeeded || report.userInputNeeded
        ? "attention"
        : report.timedOut
          ? "timeout"
          : report.incomplete
            ? "incomplete"
            : "complete";
    await stop(stopReason);
    const diagnostics: HostLivenessDiagnostics = {
      status: "stopped",
      stopReason,
      heartbeatCount,
      heartbeatErrors,
      cleanup: {
        status: cleanupError ? "failed" : "complete",
        inFlightHeartbeat: Boolean(inFlight),
        ...(cleanupError ? { error: cleanupError } : {})
      },
      finalFence: fence
    };
    return {
      report: {
        ...report,
        diagnostics: {
          ...report.diagnostics,
          hostLiveness: diagnostics
        }
      },
      liveness: diagnostics
    };
  } catch (error) {
    stopReason = heartbeatErrors.length > 0 ? "heartbeat-error" : "error";
    try {
      await stop(stopReason);
    } catch (cleanupFailure) {
      cleanupError = conciseError(cleanupFailure);
    }
    throw withErrorDetails(error, {
      hostLiveness: {
        status: "stopped",
        stopReason,
        heartbeatCount,
        heartbeatErrors,
        cleanup: cleanupError
          ? { status: "failed", inFlightHeartbeat: Boolean(inFlight), error: cleanupError }
          : { status: "complete", inFlightHeartbeat: Boolean(inFlight) },
        finalFence: fence
      }
    });
  } finally {
    options.signal?.removeEventListener("abort", abortForward);
    if (timer !== undefined && !stopped) unschedule(timer);
  }
}

export const delegateWithHostAdapter = startHostDelegation;
export const orchestrateHostDelegation = startHostDelegation;
export const observeHostDelegation = waitForHostDelegation;
