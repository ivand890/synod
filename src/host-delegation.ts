import path from "node:path";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./codex-runtime.js";
import { ERROR_CODES, SynodError, asSynodError, withErrorDetails } from "./errors.js";
import {
  bindTaskLease,
  cancelTaskLeaseReservation,
  expireTaskLeaseReservation,
  heartbeatTaskLease,
  readOrchestration,
  releaseTaskLease,
  reserveTaskLease,
  revokeTaskLease,
  type LeaseIdentityOptions,
  type LeaseReservationIdentityOptions,
  type ReserveLeaseOptions
} from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import { normalizeLeaseScopePath, type LeaseScope, type TaskLease, type TaskLeaseReservation } from "./leases.js";
import {
  waitForThreads,
  type HostWaitAdapter,
  type WaitDependencies,
  type WaitForThreadsOptions,
  type WaitReport
} from "./wait.js";
import { isRecord } from "./validation.js";
import { isDelegationRole, type DelegationRole } from "./profiles.js";

const DEFAULT_HOST_CLEANUP_TIMEOUT_MS = 5_000;

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
  role?: DelegationRole;
  objective: string;
  acceptance: ReadonlyArray<string>;
  verification: ReadonlyArray<string>;
  scopes: ReadonlyArray<LeaseScope>;
  writeAuthorized: false;
  /** Worker-only execution guidance; canonical proposal mutations stay supervisor-owned. */
  proposalGuidance: string;
  /** Exact sealed proposal context supplied to reviewer/verifier lanes. */
  proposalBundleId?: string;
  proposalRevision?: number;
  ownedPaths?: ReadonlyArray<string>;
  instruction: "analysis may begin; writes, worktrees, and implementation commands wait for bind authorization";
}

export interface HostDelegationSpawnRequest {
  taskId: string;
  directory: string;
  reservation: TaskLeaseReservation;
  reservationFence: HostDelegationReservationFence;
  writeAuthorized: false;
  role?: DelegationRole;
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
  phase: "preflight" | "activate";
  taskId: string;
  directory: string;
  ownerThread: HostOwnerIdentifier;
  writeAuthorized: boolean;
  role?: DelegationRole;
  reservation: TaskLeaseReservation;
  /** Present only for the post-bind activation phase. */
  lease?: TaskLease;
  leaseFence?: HostDelegationLeaseFence;
  /** Activation cancellation is mandatory; adapters must stop the operation before close resolves. */
  signal?: AbortSignal;
}

export interface HostAuthorizationReceipt {
  status: "authorized" | "accepted" | "failed" | "rejected" | "denied";
  receipt?: unknown;
  hostNotificationRequired?: boolean;
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
  release?: typeof releaseTaskLease;
  revoke?: typeof revokeTaskLease;
  wait?: typeof waitForThreads;
  hostAdapter?: HostWaitAdapter;
  hostAdapterFactory?: () => HostWaitAdapter;
  hostDelegationAdapter?: HostDelegationAdapter;
  hostDelegationAdapterFactory?: () => HostDelegationAdapter;
  hostRuntimeResolver?: () => ResolvedCodexRuntime;
  env?: NodeJS.ProcessEnv;
  read?: typeof readOrchestration;
  cleanupTimeoutMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface HostNextCommand {
  operation: string;
  argv: string[];
  requirements: string[];
  fence?: HostDelegationReservationFence | HostDelegationLeaseFence;
}

export interface CodexHostAdapterProbe {
  found: false;
  surface: ResolvedCodexRuntime["surface"];
  reason: "host-only-not-found";
  constructedAppServer: false;
}

export interface HostDelegationHandoffResult {
  directory: string;
  task: ReservationResult["task"];
  reservation: TaskLeaseReservation;
  reservationFence: HostDelegationReservationFence;
  readOnlyContract: HostDelegationReadOnlyContract;
  hostSpawnRequired: true;
  nextCommand: HostNextCommand;
  probe: CodexHostAdapterProbe;
}

type ReservationResult = Awaited<ReturnType<typeof reserveTaskLease>>;
type BindResult = Awaited<ReturnType<typeof bindTaskLease>>;
type CancelResult = Awaited<ReturnType<typeof cancelTaskLeaseReservation>>;
type ExpireResult = Awaited<ReturnType<typeof expireTaskLeaseReservation>>;
type ReleaseResult = Awaited<ReturnType<typeof releaseTaskLease>>;

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
  role: DelegationRole;
  lease: TaskLease;
  leaseFence: HostDelegationLeaseFence;
  preflightAuthorization?: HostAuthorizationReceipt;
  authorization: HostAuthorizationReceipt;
  bind: BindResult;
  wait?: WaitReport;
  liveness?: HostLivenessDiagnostics;
  cleanup?: { status: "not-required" | "complete" | "failed"; error?: { code: string; message: string } };
}

function taskIdentifier(options: HostDelegationOptions): string {
  const id = String(options.id || options.taskId || "").trim().toUpperCase();
  if (!id) throw new SynodError(ERROR_CODES.TASK_INVALID, "Host delegation requires a task ID.");
  return id;
}

interface PreparedDelegationReservation {
  role: DelegationRole;
  read: unknown[];
  write: unknown[];
  readTree: unknown[];
  writeTree: unknown[];
  observer?: true;
}

function sortedPaths(values: unknown[]): string[] {
  return values.map(value => normalizeLeaseScopePath(value)).sort((left, right) => left.localeCompare(right));
}

function roleProposalGuidance(role: DelegationRole): string {
  return role === "implementer"
    ? "Worker may implement and run the listed verification only after bind; do not accept, verify, checkpoint, or mutate canonical Synod state. Report the exact changed paths and verification result so the supervisor can seal the exact proposal."
    : `${role} may inspect only the exact sealed proposal and owned paths after bind; never write files, request write authorization, submit delivery, accept, verify, checkpoint, or mutate canonical Synod state. Report the decision and evidence to the supervisor.`;
}

function approvalNextCommand(
  taskId: string,
  role: Exclude<DelegationRole, "implementer">,
  revision: number,
  proposalBundleId: string,
  ownerThread: string
): HostNextCommand {
  return {
    operation: "task.approval",
    argv: [
      "task", "approve", taskId,
      "--role", role,
      "--revision", String(revision),
      "--proposal-bundle-id", proposalBundleId,
      "--owner-thread", ownerThread
    ],
    requirements: ["decision", "evidence", "exact-sealed-proposal"]
  };
}

/** Validate role/state/scope before the first durable reservation mutation. */
async function prepareDelegationReservation(
  id: string,
  options: HostDelegationOptions,
  dependencies: HostDelegationDependencies
): Promise<PreparedDelegationReservation> {
  const role = options.role ?? "implementer";
  if (!isDelegationRole(role)) {
    throw new SynodError(ERROR_CODES.DELEGATION_ROLE_INVALID, `Unsupported delegation role: ${String(role)}.`, {
      details: { role, allowed: ["implementer", "reviewer", "verifier"] }
    });
  }
  if (role === "implementer") {
    return {
      role,
      read: options.read || [],
      write: options.write || [],
      readTree: options.readTree || [],
      writeTree: options.writeTree || []
    };
  }
  if ((options.write || []).length > 0 || (options.writeTree || []).length > 0 || (options.readTree || []).length > 0) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${role} delegation accepts only exact read file scopes.`, {
      details: { role, write: options.write || [], writeTree: options.writeTree || [], readTree: options.readTree || [] }
    });
  }
  const read = dependencies.read || readOrchestration;
  const canonical = await read(path.resolve(options.directory || "."));
  const task = canonical.state.tasks[id];
  if (!task) {
    throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${id} does not exist.`, { details: { taskId: id } });
  }
  const expectedState = role === "reviewer" ? "REVIEW" : "ACCEPTED";
  if (task.state !== expectedState) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${role} delegation is only valid from ${expectedState}.`, {
      details: { taskId: id, role, state: task.state }
    });
  }
  const proposal = task.proposal;
  if (!proposal || proposal.status !== "SEALED" || proposal.revision !== task.revision) {
    throw new SynodError(ERROR_CODES.PROPOSAL_REQUIRED, `${role} delegation requires the current sealed proposal.`, {
      details: { taskId: id, role, revision: task.revision, proposal: proposal ?? null }
    });
  }
  const expected = sortedPaths(proposal.ownedPaths);
  const requested = (options.read || []).length > 0 ? sortedPaths(options.read || []) : expected;
  if (requested.length !== expected.length || requested.some((item, index) => item !== expected[index])) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${role} delegation read scopes must exactly cover proposal-owned paths.`, {
      details: { taskId: id, role, expectedPaths: expected, requestedPaths: requested }
    });
  }
  return { role, read: requested, write: [], readTree: [], writeTree: [], observer: true };
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
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["ownerThread", "ownerId", "owner", "threadId"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
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

/** Exactly one child-loss mode. Unknown or conflicting values fail closed. */
export const CHILD_LOSS_MODES = Object.freeze([
  "spawn-not-invoked",
  "spawn-invoked-no-owner",
  "child-dead-lease-live",
  "wait-never-woke"
] as const);

export type ChildLossMode = typeof CHILD_LOSS_MODES[number];

const CHILD_LOSS_MODE_SET: ReadonlySet<string> = new Set(CHILD_LOSS_MODES);

export function isChildLossMode(value: unknown): value is ChildLossMode {
  return typeof value === "string" && CHILD_LOSS_MODE_SET.has(value);
}

function childLossDetail(error: unknown): unknown {
  if (!(error instanceof SynodError) || !isRecord(error.details) || !Object.hasOwn(error.details, "childLoss")) {
    return undefined;
  }
  return error.details.childLoss;
}

export function childLossFrom(error: unknown): ChildLossMode | undefined {
  const value = childLossDetail(error);
  return isChildLossMode(value) ? value : undefined;
}

export function unclassifiedChildLossError(value: unknown, cause?: unknown): SynodError {
  return new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "child loss was not classified.", {
    ...(cause === undefined ? {} : { cause }),
    details: { childLoss: value }
  });
}

export function withChildLoss(
  error: unknown,
  mode: ChildLossMode,
  fallbackCode: typeof ERROR_CODES[keyof typeof ERROR_CODES] = ERROR_CODES.INTERNAL
): SynodError {
  if (!isChildLossMode(mode)) return unclassifiedChildLossError(mode, error);
  const existing = childLossDetail(error);
  if (existing !== undefined && (!isChildLossMode(existing) || existing !== mode)) {
    return unclassifiedChildLossError(existing, error);
  }
  return withErrorDetails(asSynodError(error, fallbackCode), { childLoss: mode });
}

export function classifyChildLoss(
  error: unknown,
  mode: ChildLossMode,
  fallbackCode: typeof ERROR_CODES[keyof typeof ERROR_CODES] = ERROR_CODES.INTERNAL
): SynodError {
  const existing = childLossDetail(error);
  if (existing !== undefined && !isChildLossMode(existing)) return unclassifiedChildLossError(existing, error);
  if (isChildLossMode(existing)) return asSynodError(error, fallbackCode);
  return withChildLoss(error, mode, fallbackCode);
}

function classifyPostBindChildLoss(error: unknown): SynodError {
  const existing = childLossDetail(error);
  if (existing !== undefined && !isChildLossMode(existing)) return unclassifiedChildLossError(existing, error);
  const failure = asSynodError(error);
  if (isChildLossMode(existing)) return failure;
  if (failure.code === ERROR_CODES.APP_SERVER_TIMEOUT || failure.code === ERROR_CODES.WAIT_INVALID) {
    return withChildLoss(failure, "wait-never-woke");
  }
  if (
    failure.code === ERROR_CODES.APP_SERVER_EXITED
    || failure.code === ERROR_CODES.APP_SERVER_NOT_RUNNING
    || failure.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED
  ) {
    return withChildLoss(failure, "child-dead-lease-live");
  }
  if (failure.code === ERROR_CODES.HOST_OWNER_MISSING) {
    return withChildLoss(failure, "spawn-invoked-no-owner");
  }
  return failure;
}

/**
 * Once a host spawn has been invoked, release its transport before surfacing
 * the canonical reservation/bind/authorization failure. A host close failure
 * is diagnostic only and must never replace the primary failure.
 */
async function closeAdapterAfterSpawnFailure(
  adapter: HostDelegationAdapter,
  error: unknown,
  fallbackCode: typeof ERROR_CODES[keyof typeof ERROR_CODES] = ERROR_CODES.INTERNAL,
  dependencies: HostDelegationDependencies = {}
): Promise<SynodError> {
  const existing = childLossDetail(error);
  const failure = existing !== undefined && !isChildLossMode(existing)
    ? unclassifiedChildLossError(existing, error)
    : asSynodError(error, fallbackCode);
  const timeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_HOST_CLEANUP_TIMEOUT_MS;
  const schedule = dependencies.setTimeout || setTimeout;
  const unschedule = dependencies.clearTimeout || clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeOutcome = await Promise.race([
    Promise.resolve().then(() => adapter.close?.()).then(
      () => ({ status: "complete" as const }),
      closeError => ({ status: "failed" as const, error: conciseError(closeError) })
    ),
    new Promise<{ status: "timeout" }>(resolve => {
      timer = schedule(() => resolve({ status: "timeout" }), timeoutMs);
    })
  ]);
  if (timer !== undefined) unschedule(timer);
  if (closeOutcome.status !== "complete") {
    failure.details = {
      ...(isRecord(failure.details) ? failure.details : {}),
      hostAdapterClose: {
        status: closeOutcome.status,
        ...(closeOutcome.status === "failed" ? { error: closeOutcome.error } : { timeoutMs })
      }
    };
  } else {
    failure.details = {
      ...(isRecord(failure.details) ? failure.details : {}),
      hostAdapterClose: { status: "complete" }
    };
  }
  return failure;
}

function hostAdapterStopped(error: SynodError): boolean {
  return isRecord(error.details)
    && isRecord(error.details.hostAdapterClose)
    && error.details.hostAdapterClose.status === "complete";
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
  | { status: "success"; value: HostDelegationSpawnResult; invoked: true }
  | { status: "failure"; error: unknown; invoked: true }
  | { status: "timeout"; invoked: boolean };

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
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return Promise.resolve({ status: "timeout", invoked: false });
  return new Promise(resolve => {
    let settled = false;
    let invoked = false;
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
        resolve({ status: "timeout", invoked });
      }, Math.min(Math.max(0, Date.parse(expiresAt) - clock()), 2_147_483_647));
    };
    armDeadline();
    Promise.resolve()
      .then(() => {
        invoked = true;
        return adapter.spawn(request);
      })
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "success", value, invoked: true });
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "failure", error, invoked: true });
      });
  });
}

function authorizationFailure(
  value: unknown,
  result: HostDelegationAuthorizeRequest
): SynodError {
  const preflight = result.phase === "preflight";
  return new SynodError(ERROR_CODES.HOST_AUTHORIZATION_FAILED, preflight
    ? "Host preflight authorization was not accepted before the lease was bound."
    : "Host activation was not accepted after the lease was bound.", {
    details: {
      phase: result.phase,
      taskId: result.taskId,
      ownerThread: result.ownerThread,
      reservation: {
        taskId: result.reservation.taskId,
        leaseId: result.reservation.id,
        generation: result.reservation.generation,
        revision: result.reservation.taskRevision,
        reservedAt: result.reservation.reservedAt,
        baselineHash: result.reservation.baseline.snapshotContentHash
      },
      authorization: authorizationReceipt(value),
      recovery: {
        status: preflight ? "authorization-failed-reservation-unbound" : "activation-failed-lease-ended",
        action: preflight ? "cancel-reservation" : "end-active-lease",
        next: preflight
          ? "supervisor must inspect the host and retry delegate start after reservation cleanup"
          : "supervisor must inspect the host and make a typed recovery decision"
      }
    }
  });
}

async function authorizeHostOwner(
  adapter: HostDelegationAdapter,
  request: HostDelegationAuthorizeRequest
): Promise<HostAuthorizationReceipt> {
  const value = await adapter.authorize(request);
  const authorization = authorizationReceipt(value);
  if (authorization.status === "failed" || authorization.status === "rejected" || authorization.status === "denied") {
    throw authorizationFailure(authorization, request);
  }
  return authorization;
}

/** Keep post-bind activation inside the lease's safe cleanup window without changing its exact fence. */
async function authorizeHostOwnerBeforeLeaseCleanupWindow(
  adapter: HostDelegationAdapter,
  request: HostDelegationAuthorizeRequest,
  lease: TaskLease,
  dependencies: HostDelegationDependencies
): Promise<HostAuthorizationReceipt> {
  const observed = dependencies.clock?.() ?? Date.now();
  const now = observed instanceof Date ? observed.getTime() : typeof observed === "number" ? observed : Date.parse(observed);
  const deadline = Date.parse(lease.expiresAt) - lease.heartbeatIntervalSeconds * 1_000;
  const timeoutMs = Math.max(0, deadline - now);
  const schedule = dependencies.setTimeout || setTimeout;
  const unschedule = dependencies.clearTimeout || clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const controller = new AbortController();
  const activationRequest = { ...request, signal: controller.signal };

  return new Promise((resolve, reject) => {
    timer = schedule(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new SynodError(
        ERROR_CODES.HOST_AUTHORIZATION_FAILED,
        "Host activation did not finish inside the active lease cleanup window.",
        {
          details: {
            phase: "activate",
            taskId: request.taskId,
            ownerThread: request.ownerThread,
            lease: leaseFence(lease),
            activationDeadline: new Date(deadline).toISOString(),
            expiresAt: lease.expiresAt
          }
        }
      ));
    }, Math.min(timeoutMs, 2_147_483_647));
    Promise.resolve()
      .then(() => authorizeHostOwner(adapter, activationRequest))
      .then(authorization => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) unschedule(timer);
        resolve(authorization);
      }, error => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) unschedule(timer);
        reject(error);
      });
  });
}

async function endBoundLeaseAfterFailure(
  error: unknown,
  role: DelegationRole,
  lease: TaskLease,
  options: { directory?: string; actor?: string },
  dependencies: HostDelegationDependencies
): Promise<never> {
  const failure = asSynodError(error, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
  let cleanup: { status: "complete" | "failed"; result?: ReleaseResult; error?: { code: string; message: string } };
  try {
    const end = role === "implementer"
      ? dependencies.revoke || revokeTaskLease
      : dependencies.release || releaseTaskLease;
    const result = await end({
      directory: options.directory || ".",
      id: lease.taskId,
      leaseId: lease.id,
      generation: lease.generation,
      revision: lease.taskRevision,
      expectedHeartbeatAt: lease.heartbeatAt,
      ownerThread: lease.ownerThread,
      reason: `activate: ${failure.message}`,
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
    cleanup = { status: "complete", result };
  } catch (cleanupError) {
    cleanup = { status: "failed", error: conciseError(cleanupError) };
  }
  failure.details = {
    ...(isRecord(failure.details) ? failure.details : {}),
    phase: "activate",
    lease: {
      taskId: lease.taskId,
      leaseId: lease.id,
      generation: lease.generation,
      revision: lease.taskRevision,
      expectedHeartbeatAt: lease.heartbeatAt,
      ownerThread: lease.ownerThread
    },
    cleanup: cleanup.status === "complete"
      ? { status: cleanup.status, action: role === "implementer" ? "revoke" : "release" }
      : { status: cleanup.status, action: role === "implementer" ? "revoke" : "release", error: cleanup.error }
  };
  throw failure;
}

function approvalProposal(
  role: DelegationRole,
  task: { proposal?: { revision: number; bundleId: string } }
): { role: Exclude<DelegationRole, "implementer">; revision: number; bundleId: string } | undefined {
  if (role === "implementer" || !task.proposal) return undefined;
  return { role, revision: task.proposal.revision, bundleId: task.proposal.bundleId };
}

function withApprovalCommand(
  authorization: HostAuthorizationReceipt,
  taskId: string,
  ownerThread: string,
  proposal: ReturnType<typeof approvalProposal>
): HostAuthorizationReceipt {
  if (!proposal) return authorization;
  return {
    ...authorization,
    approvalRequired: true,
    nextCommand: approvalNextCommand(taskId, proposal.role, proposal.revision, proposal.bundleId, ownerThread)
  };
}

/** Reserve, host-spawn read-only, preflight, bind, then activate the opaque owner. */
export async function startHostDelegation(
  options: HostDelegationOptions = {},
  dependencies: HostDelegationDependencies = {}
): Promise<HostDelegationResult> {
  const adapter = options.adapter;
  if (!adapter) throw new SynodError(ERROR_CODES.HOST_ADAPTER_REQUIRED, "Host delegation requires an injected host adapter.");
  if (typeof adapter.spawn !== "function" || typeof adapter.authorize !== "function" || typeof adapter.close !== "function") {
    throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "The injected host adapter must expose spawn, authorize, and cancellable close methods.");
  }
  const id = taskIdentifier(options);
  const prepared = await prepareDelegationReservation(id, options, dependencies);
  const reserve = dependencies.reserve || reserveTaskLease;
  const reserved = await reserve({
    id,
    directory: options.directory || ".",
    role: prepared.role,
    read: prepared.read,
    write: prepared.write,
    readTree: prepared.readTree,
    writeTree: prepared.writeTree,
    ...(prepared.observer ? { observer: true } : {}),
    ...(options.reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds: options.reservationTtlSeconds }),
    ...(options.actor === undefined ? {} : { actor: options.actor })
  }, dependencies);
  const reservation = reserved.reservation;
  if (prepared.role !== "implementer"
    && (reservation.role !== prepared.role || reservation.observer !== true)) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${prepared.role} reservation was not preserved as an observer-only role lane.`, {
      details: { role: prepared.role, reservation }
    });
  }
  if (prepared.role !== "implementer" && !reserved.task.proposal) {
    throw new SynodError(ERROR_CODES.PROPOSAL_REQUIRED, `${prepared.role} delegation requires the exact sealed proposal in the reservation result.`, {
      details: { taskId: id, role: prepared.role }
    });
  }
  const reservedFence = reservationFence(reservation);
  const readOnlyContract: HostDelegationReadOnlyContract = {
    taskId: id,
    taskRevision: reservation.taskRevision,
    role: prepared.role,
    objective: typeof reserved.task.objective === "string" ? reserved.task.objective : "",
    acceptance: reserved.task.acceptance?.criteria || [],
    verification: reserved.task.verification?.commands || [],
    scopes: reservation.scopes,
    writeAuthorized: false,
    proposalGuidance: roleProposalGuidance(prepared.role),
    ...(prepared.role !== "implementer" && reserved.task.proposal ? {
      proposalBundleId: reserved.task.proposal.bundleId,
      proposalRevision: reserved.task.proposal.revision,
      ownedPaths: [...reserved.task.proposal.ownedPaths]
    } : {}),
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
    role: prepared.role,
    readOnlyContract,
    initialContract: readOnlyContract,
    contract: readOnlyContract
  };
  const spawnOutcome = await spawnBoundedByReservation(adapter, spawnRequest, reservation.expiresAt, clock);
  if (spawnOutcome.status === "failure") {
    const failure = await closeAdapterAfterSpawnFailure(
      adapter,
      classifyChildLoss(spawnOutcome.error, "spawn-invoked-no-owner", ERROR_CODES.HOST_SPAWN_FAILED),
      ERROR_CODES.HOST_SPAWN_FAILED
    );
    return cancelReservationAfterFailure(failure, ERROR_CODES.HOST_SPAWN_FAILED, "spawn", reservation, options, dependencies);
  }
  if (spawnOutcome.status === "timeout") {
    const timeoutError = withChildLoss(
      new SynodError(
        ERROR_CODES.HOST_SPAWN_TIMEOUT,
        "Host spawn did not return an owner before the reservation expired."
      ),
      spawnOutcome.invoked ? "spawn-invoked-no-owner" : "spawn-not-invoked"
    );
    if (spawnOutcome.invoked) {
      const failure = await closeAdapterAfterSpawnFailure(adapter, timeoutError);
      return expireReservationAfterFailure(
        failure,
        ERROR_CODES.HOST_SPAWN_TIMEOUT,
        "spawn-timeout",
        reservation,
        options,
        dependencies
      );
    }
    return expireReservationAfterFailure(
      timeoutError,
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
      const failure = withChildLoss(new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Host spawn returned no opaque owner identifier before the reservation expired.", {
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
      }), "spawn-invoked-no-owner");
      throw await closeAdapterAfterSpawnFailure(adapter, failure);
    }
    const failure = await closeAdapterAfterSpawnFailure(
      adapter,
      withChildLoss(
        new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Host spawn returned no opaque owner identifier."),
        "spawn-invoked-no-owner"
      )
    );
    return expireReservationAfterFailure(
      failure,
      ERROR_CODES.HOST_OWNER_MISSING,
      "missing-owner",
      reservation,
      options,
      dependencies
    );
  }
  if (clock() >= Date.parse(reservation.expiresAt)) {
    const failure = await closeAdapterAfterSpawnFailure(
      adapter,
      withChildLoss(
        new SynodError(ERROR_CODES.HOST_SPAWN_TIMEOUT, "Host spawn returned an owner after the reservation expired."),
        "spawn-invoked-no-owner"
      )
    );
    return expireReservationAfterFailure(
      failure,
      ERROR_CODES.HOST_SPAWN_TIMEOUT,
      "spawn-timeout",
      reservation,
      options,
      dependencies
    );
  }
  const authorizeRequest: HostDelegationAuthorizeRequest = {
    phase: "preflight",
    taskId: id,
    directory: options.directory || ".",
    ownerThread,
    writeAuthorized: false,
    role: prepared.role,
    reservation
  };
  let preflightAuthorization: HostAuthorizationReceipt;
  try {
    preflightAuthorization = await authorizeHostOwner(adapter, authorizeRequest);
  } catch (error) {
    const classified = classifyPostBindChildLoss(error);
    const failure = classified instanceof SynodError && classified.code === ERROR_CODES.HOST_AUTHORIZATION_FAILED
      ? classified
      : childLossFrom(classified)
        ? classified
        : withErrorDetails(authorizationFailure(classified, authorizeRequest), { cause: conciseError(classified) });
    const closed = await closeAdapterAfterSpawnFailure(adapter, failure);
    return cancelReservationAfterFailure(closed, closed.code, "authorize", reservation, options, dependencies);
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
    const failure = await closeAdapterAfterSpawnFailure(adapter, error, ERROR_CODES.LEASE_STALE);
    return cancelReservationAfterFailure(failure, ERROR_CODES.LEASE_STALE, "bind", reservation, options, dependencies);
  }
  const activationRequest: HostDelegationAuthorizeRequest = {
    phase: "activate",
    taskId: id,
    directory: options.directory || ".",
    ownerThread,
    writeAuthorized: prepared.role === "implementer",
    role: prepared.role,
    reservation,
    lease: bound.lease,
    leaseFence: leaseFence(bound.lease)
  };
  let authorization: HostAuthorizationReceipt;
  try {
    authorization = withApprovalCommand(
      await authorizeHostOwnerBeforeLeaseCleanupWindow(adapter, activationRequest, bound.lease, dependencies),
      id,
      ownerThread,
      approvalProposal(prepared.role, bound.task)
    );
  } catch (error) {
    const classified = classifyPostBindChildLoss(error);
    const failure = classified instanceof SynodError && classified.code === ERROR_CODES.HOST_AUTHORIZATION_FAILED
      ? classified
      : childLossFrom(classified)
        ? classified
        : withErrorDetails(authorizationFailure(classified, activationRequest), { cause: conciseError(classified) });
    const remainingMs = Math.max(1, Date.parse(bound.lease.expiresAt) - clock());
    const closeTimeoutMs = Math.min(
      dependencies.cleanupTimeoutMs ?? DEFAULT_HOST_CLEANUP_TIMEOUT_MS,
      Math.max(1, Math.floor(remainingMs / 2))
    );
    const closed = await closeAdapterAfterSpawnFailure(adapter, failure, ERROR_CODES.HOST_AUTHORIZATION_FAILED, {
      ...dependencies,
      cleanupTimeoutMs: closeTimeoutMs
    });
    if (hostAdapterStopped(closed)) {
      return endBoundLeaseAfterFailure(closed, prepared.role, bound.lease, options, dependencies);
    }
    closed.details = {
      ...(isRecord(closed.details) ? closed.details : {}),
      phase: "activate",
      cleanup: {
        status: "deferred",
        action: "retain-active-lease",
        reason: "adapter shutdown was not confirmed; ending the lease could race a late write authorization",
        expiresAt: bound.lease.expiresAt
      }
    };
    throw closed;
  }
  const result: HostDelegationResult = {
    directory: options.directory || ".",
    task: bound.task,
    reservation,
    reservationFence: reservedFence,
    spawn: spawned,
    ownerThread,
    role: prepared.role,
    lease: bound.lease,
    leaseFence: leaseFence(bound.lease),
    preflightAuthorization,
    authorization,
    bind: bound,
    cleanup: { status: "not-required" }
  };
  if (options.wait) {
    const waitOptions = typeof options.wait === "object" ? options.wait : {};
    try {
      const waited = await waitForHostDelegation(result, adapter, waitOptions, dependencies);
      result.wait = waited.report;
      result.liveness = waited.liveness;
    } catch (error) {
      throw await closeAdapterAfterSpawnFailure(adapter, classifyPostBindChildLoss(error));
    }
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
    const childLoss = report.timedOut && report.wakeCount === 0
      ? { childLoss: "wait-never-woke" as const }
      : {};
    return {
      report: {
        ...report,
        diagnostics: {
          ...report.diagnostics,
          hostLiveness: diagnostics,
          ...childLoss
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

export function isCodexHostOperator(
  runtime: Pick<ResolvedCodexRuntime, "surface" | "resolved" | "executableSource">
): boolean {
  if (runtime.surface === "desktop") return true;
  return runtime.resolved === true
    && (runtime.executableSource === "cli-process" || runtime.executableSource === "desktop-process");
}

/** Host-only 0.148 probe. Never constructs a child App Server. */
export function probeCodexHostAdapter(
  runtime: Pick<ResolvedCodexRuntime, "surface"> = resolveCodexRuntime()
): CodexHostAdapterProbe {
  return {
    found: false,
    surface: runtime.surface,
    reason: "host-only-not-found",
    constructedAppServer: false
  };
}

export type SelectedHostDelegation =
  | { path: "injected" | "cli-app-server"; adapter: HostDelegationAdapter }
  | { path: "handoff" };

/**
 * Injected adapters win. Desktop stays Path B and never constructs an App Server.
 * CLI without an injection uses the Synod-owned App Server adapter.
 */
export function selectHostDelegationAdapter(options: {
  adapter?: HostDelegationAdapter;
  runtime: Pick<ResolvedCodexRuntime, "surface" | "resolved" | "executableSource">;
  createCliAdapter: () => HostDelegationAdapter;
}): SelectedHostDelegation {
  if (options.adapter) return { path: "injected", adapter: options.adapter };
  if (options.runtime.surface === "desktop") return { path: "handoff" };
  if (options.runtime.surface === "cli") {
    return { path: "cli-app-server", adapter: options.createCliAdapter() };
  }
  return { path: "handoff" };
}

export function resolveHostDelegationAdapter(
  dependencies: Pick<HostDelegationDependencies, "hostDelegationAdapter" | "hostDelegationAdapterFactory" | "env"> & {
    adapter?: HostDelegationAdapter;
    adapterFactory?: () => HostDelegationAdapter;
  } = {},
  env: NodeJS.ProcessEnv = dependencies.env ?? process.env,
  options: { allowUnsupportedChannel?: boolean } = {}
): HostDelegationAdapter | undefined {
  const injected = dependencies.adapterFactory?.()
    || dependencies.adapter
    || dependencies.hostDelegationAdapterFactory?.()
    || dependencies.hostDelegationAdapter;
  if (injected) {
    if (typeof injected.spawn !== "function" || typeof injected.authorize !== "function" || typeof injected.close !== "function") {
      throw new SynodError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "The injected host adapter must expose spawn, authorize, and cancellable close methods."
      );
    }
    return injected;
  }
  if (Object.hasOwn(env, "SYNOD_HOST_ADAPTER") && !options.allowUnsupportedChannel) {
    throw new SynodError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "SYNOD_HOST_ADAPTER is set but no supported host adapter channel is available.",
      { details: { channel: env.SYNOD_HOST_ADAPTER ?? null, constructedAppServer: false } }
    );
  }
  return undefined;
}

function evidenceReferences(value: unknown[] | undefined): string[] {
  return [...new Set((value || []).flatMap(item => {
    if (typeof item !== "string") return [];
    const reference = item.trim();
    return reference ? [reference] : [];
  }))];
}

export function delegateCompleteCommand(
  taskId: string,
  fence: HostDelegationReservationFence,
  evidence: readonly string[] = []
): HostNextCommand {
  return {
    operation: "delegate.complete",
    argv: ["delegate", "complete", taskId, ...evidence.flatMap(reference => ["--evidence", reference])],
    requirements: ["owner-thread"],
    fence
  };
}

function readOnlyContractFor(
  taskId: string,
  reservation: TaskLeaseReservation,
  task: {
    objective: string;
    acceptance: { criteria: ReadonlyArray<string> };
    verification: { commands: ReadonlyArray<string> };
    proposal?: { bundleId: string; revision: number; ownedPaths: ReadonlyArray<string> };
  }
): HostDelegationReadOnlyContract {
  return {
    taskId,
    taskRevision: reservation.taskRevision,
    ...(reservation.role === undefined ? {} : { role: reservation.role }),
    objective: typeof task.objective === "string" ? task.objective : "",
    acceptance: task.acceptance?.criteria || [],
    verification: task.verification?.commands || [],
    scopes: reservation.scopes,
    writeAuthorized: false,
    proposalGuidance: roleProposalGuidance(reservation.role ?? "implementer"),
    ...((reservation.role === "reviewer" || reservation.role === "verifier") && task.proposal ? {
      proposalBundleId: task.proposal.bundleId,
      proposalRevision: task.proposal.revision,
      ownedPaths: [...task.proposal.ownedPaths]
    } : {}),
    instruction: "analysis may begin; writes, worktrees, and implementation commands wait for bind authorization"
  };
}

/** Reserve and return an incomplete host spawn handoff. Does not spawn or bind. */
export async function startHostDelegationHandoff(
  options: HostDelegationOptions = {},
  dependencies: HostDelegationDependencies = {}
): Promise<HostDelegationHandoffResult> {
  if (options.wait) {
    throw new SynodError(
      ERROR_CODES.HOST_ADAPTER_REQUIRED,
      "Delegate --wait requires an injected host adapter."
    );
  }
  const id = taskIdentifier(options);
  const prepared = await prepareDelegationReservation(id, options, dependencies);
  const reserve = dependencies.reserve || reserveTaskLease;
  const reserved = await reserve({
    id,
    directory: options.directory || ".",
    role: prepared.role,
    read: prepared.read,
    write: prepared.write,
    readTree: prepared.readTree,
    writeTree: prepared.writeTree,
    ...(prepared.observer ? { observer: true } : {}),
    ...(options.reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds: options.reservationTtlSeconds }),
    ...(options.actor === undefined ? {} : { actor: options.actor })
  }, dependencies);
  const reservation = reserved.reservation;
  if (prepared.role !== "implementer"
    && (reservation.role !== prepared.role || reservation.observer !== true)) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${prepared.role} reservation was not preserved as an observer-only role lane.`, {
      details: { role: prepared.role, reservation }
    });
  }
  if (prepared.role !== "implementer" && !reserved.task.proposal) {
    throw new SynodError(ERROR_CODES.PROPOSAL_REQUIRED, `${prepared.role} delegation requires the exact sealed proposal in the reservation result.`, {
      details: { taskId: id, role: prepared.role }
    });
  }
  const reservedFence = reservationFence(reservation);
  const runtime = dependencies.hostRuntimeResolver?.() || resolveCodexRuntime();
  return {
    directory: options.directory || ".",
    task: reserved.task,
    reservation,
    reservationFence: reservedFence,
    readOnlyContract: readOnlyContractFor(id, reservation, reserved.task),
    hostSpawnRequired: true,
    nextCommand: delegateCompleteCommand(id, reservedFence, evidenceReferences(options.evidence)),
    probe: probeCodexHostAdapter(runtime)
  };
}

/** Preflight, bind, then activate the stored reservation for a host-returned owner. */
export async function completeHostDelegation(
  options: {
    directory?: string;
    id?: string;
    taskId?: string;
    ownerThread: string;
    actor?: string;
    evidence?: unknown[];
    adapter?: HostDelegationAdapter;
    ttlSeconds?: number;
    heartbeatIntervalSeconds?: number;
  },
  dependencies: HostDelegationDependencies = {}
): Promise<HostDelegationResult> {
  const id = taskIdentifier(options);
  const ownerThread = String(options.ownerThread || "").trim();
  if (!ownerThread) {
    throw new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Host delegation complete requires an opaque owner thread.");
  }
  if (options.adapter && (
    typeof options.adapter.authorize !== "function"
    || typeof options.adapter.close !== "function"
  )) {
    throw new SynodError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "Host delegation complete requires authorize and cancellable close methods."
    );
  }
  const targetDirectory = options.directory || ".";
  const read = dependencies.read || readOrchestration;
  const canonical = await read(path.resolve(targetDirectory));
  const task = canonical.state.tasks[id];
  if (!task) {
    throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${id} does not exist.`, { details: { taskId: id } });
  }
  const reservation = task.leaseReservation;
  if (!reservation || reservation.status !== "RESERVED") {
    throw new SynodError(ERROR_CODES.LEASE_STALE, "Host delegation complete requires an active reservation.", {
      details: { taskId: id, reservation: reservation ?? null }
    });
  }
  const reservedFence = reservationFence(reservation);
  const completeRole = reservation.role ?? "implementer";
  const authorizeRequest: HostDelegationAuthorizeRequest = {
    phase: "preflight",
    taskId: id,
    directory: targetDirectory,
    ownerThread,
    writeAuthorized: false,
    ...(reservation.role === undefined ? {} : { role: reservation.role }),
    reservation
  };
  let preflightAuthorization: HostAuthorizationReceipt | undefined;
  if (options.adapter) {
    try {
      preflightAuthorization = await authorizeHostOwner(options.adapter, authorizeRequest);
    } catch (error) {
      const classified = error instanceof SynodError && error.code === ERROR_CODES.HOST_AUTHORIZATION_FAILED
        ? error
        : withErrorDetails(authorizationFailure(error, authorizeRequest), { cause: conciseError(error) });
      const closed = await closeAdapterAfterSpawnFailure(options.adapter, classified);
      return cancelReservationAfterFailure(closed, closed.code, "authorize", reservation, {
        directory: targetDirectory,
        ...(options.actor === undefined ? {} : { actor: options.actor })
      }, dependencies);
    }
  }
  const bind = dependencies.bind || bindTaskLease;
  let bound: BindResult;
  try {
    bound = await bind({
      directory: targetDirectory,
      id,
      ...reservedFence,
      ownerThread,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      ...(options.heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds }),
      evidence: options.evidence || [],
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
  } catch (error) {
    const failure = options.adapter
      ? await closeAdapterAfterSpawnFailure(options.adapter, error, ERROR_CODES.LEASE_STALE)
      : asSynodError(error, ERROR_CODES.LEASE_STALE);
    return cancelReservationAfterFailure(failure, ERROR_CODES.LEASE_STALE, "bind", reservation, {
      directory: targetDirectory,
      ...(options.actor === undefined ? {} : { actor: options.actor })
    }, dependencies);
  }
  let authorization: HostAuthorizationReceipt;
  if (options.adapter) {
    const activationRequest: HostDelegationAuthorizeRequest = {
      phase: "activate",
      taskId: id,
      directory: targetDirectory,
      ownerThread,
      writeAuthorized: completeRole === "implementer",
      ...(reservation.role === undefined ? {} : { role: reservation.role }),
      reservation,
      lease: bound.lease,
      leaseFence: leaseFence(bound.lease)
    };
    try {
      authorization = withApprovalCommand(
        await authorizeHostOwnerBeforeLeaseCleanupWindow(options.adapter, activationRequest, bound.lease, dependencies),
        id,
        ownerThread,
        approvalProposal(completeRole, bound.task)
      );
    } catch (error) {
      const classified = classifyPostBindChildLoss(error);
      const failure = classified instanceof SynodError && classified.code === ERROR_CODES.HOST_AUTHORIZATION_FAILED
        ? classified
        : childLossFrom(classified)
          ? classified
          : withErrorDetails(authorizationFailure(classified, activationRequest), { cause: conciseError(classified) });
      const observed = dependencies.clock?.() ?? Date.now();
      const now = observed instanceof Date ? observed.getTime() : typeof observed === "number" ? observed : Date.parse(observed);
      const remainingMs = Math.max(1, Date.parse(bound.lease.expiresAt) - now);
      const closeTimeoutMs = Math.min(
        dependencies.cleanupTimeoutMs ?? DEFAULT_HOST_CLEANUP_TIMEOUT_MS,
        Math.max(1, Math.floor(remainingMs / 2))
      );
      const closed = await closeAdapterAfterSpawnFailure(options.adapter, failure, ERROR_CODES.HOST_AUTHORIZATION_FAILED, {
        ...dependencies,
        cleanupTimeoutMs: closeTimeoutMs
      });
      if (hostAdapterStopped(closed)) {
        return endBoundLeaseAfterFailure(closed, completeRole, bound.lease, {
          directory: targetDirectory,
          ...(options.actor === undefined ? {} : { actor: options.actor })
        }, dependencies);
      }
      closed.details = {
        ...(isRecord(closed.details) ? closed.details : {}),
        phase: "activate",
        cleanup: {
          status: "deferred",
          action: "retain-active-lease",
          reason: "adapter shutdown was not confirmed; ending the lease could race a late write authorization",
          expiresAt: bound.lease.expiresAt
        }
      };
      throw closed;
    }
  } else {
    authorization = withApprovalCommand(
      { status: "accepted", hostNotificationRequired: true },
      id,
      ownerThread,
      approvalProposal(completeRole, bound.task)
    );
  }
  return {
    directory: targetDirectory,
    task: bound.task,
    reservation,
    reservationFence: reservedFence,
    spawn: ownerThread,
    ownerThread,
    role: reservation.role ?? "implementer",
    lease: bound.lease,
    leaseFence: leaseFence(bound.lease),
    ...(preflightAuthorization ? { preflightAuthorization } : {}),
    authorization,
    bind: bound,
    cleanup: { status: "not-required" }
  };
}

export const delegateWithHostAdapter = startHostDelegation;
export const orchestrateHostDelegation = startHostDelegation;
export const observeHostDelegation = waitForHostDelegation;
