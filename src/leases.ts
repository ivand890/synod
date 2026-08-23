import path from "node:path";
import { contentHash } from "./filesystem.js";
import {
  validateCheckpointSnapshot,
  type CheckpointSnapshot
} from "./checkpoint.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { isRecord } from "./validation.js";
import type { DelegationRole } from "./profiles.js";

export const LEASE_BASELINES_PATH = ".synod/lease-baselines.json";
export const LEASE_BASELINES_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_TTL_SECONDS = 1_800;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 300;
export const DEFAULT_LEASE_RESERVATION_TTL_SECONDS = 300;
export const MIN_LEASE_TTL_SECONDS = 30;
export const MAX_LEASE_TTL_SECONDS = 86_400;
export const MAX_LEASE_RESERVATION_TTL_SECONDS = 3_600;
export const MAX_RETAINED_LEASE_BASELINES = 64;

export type LeaseAccess = "read" | "write";
export type LeaseScopeKind = "file" | "tree";

export interface LeaseScope {
  path: string;
  access: LeaseAccess;
  kind: LeaseScopeKind;
}

export interface LeaseBaselineReference {
  path: typeof LEASE_BASELINES_PATH;
  contentHash: string;
}

export interface LeaseBaselineBinding {
  path: typeof LEASE_BASELINES_PATH;
  snapshotContentHash: string;
  branch: string | null;
  head: string | null;
  worktreeFingerprint: string;
  lastEvent: {
    sequence: number;
    id: string;
    hash: string;
  };
}

export interface TaskLeaseReservation {
  id: string;
  token: string;
  generation: number;
  taskId: string;
  taskRevision: number;
  executor: string;
  role?: DelegationRole;
  scopes: LeaseScope[];
  observer?: true;
  reservedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  baseline: LeaseBaselineBinding;
  status: "RESERVED";
}

export interface TaskLease {
  id: string;
  generation: number;
  taskId: string;
  taskRevision: number;
  ownerThread: string;
  executor: string;
  role?: DelegationRole;
  scopes: LeaseScope[];
  observer?: true;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  heartbeatIntervalSeconds: number;
  ttlSeconds: number;
  baseline: LeaseBaselineBinding;
  status: "ACTIVE";
}

export type EndedTaskLease = Omit<TaskLease, "status"> & {
  status: "RELEASED" | "EXPIRED" | "REVOKED";
};

export const TASK_PROPOSAL_PATH_STATES_VERSION = 1 as const;

export interface TaskProposalPathState {
  path: string;
  sourcePath?: string;
  proposalAdded: boolean;
  gitTracked: boolean;
  staged: boolean;
  committed: boolean;
}

export interface TaskProposalReference {
  path: string;
  bundleId: string;
  leaseId: string;
  generation: number;
  baseRevision: number;
  revision: number;
  scopes: LeaseScope[];
  ownedPaths: string[];
  excludedForeignPaths: string[];
  /**
   * Historical schema-4 proposals may omit this immutable Git-lane record and
   * its version marker. A marked proposal must retain one entry for every
   * path in the sealed material.
   */
  pathStatesVersion?: typeof TASK_PROPOSAL_PATH_STATES_VERSION;
  pathStates?: TaskProposalPathState[];
  fingerprint: string;
  snapshotHash: string;
  sealedWorktreeFingerprint: string;
  sealedAt: string;
  leaseBaselineEvent: {
    sequence: number;
    id: string;
    hash: string;
  };
  sealedAfterEvent: {
    sequence: number;
    id: string;
    hash: string;
  };
  status: "SEALED";
}

export interface CorrectionPolicy {
  limit: number;
  used: number;
  overrides: Array<{
    added: number;
    actor: string;
    approver: string;
    reference: string;
    reason: string;
    recordedAt: string;
    evidence: string[];
  }>;
}

export interface LeaseBaseline {
  leaseId: string;
  generation: number;
  taskId: string;
  taskRevision: number;
  capturedAt: string;
  snapshot: CheckpointSnapshot;
}

export interface LeaseBaselinesLedger {
  schemaVersion: typeof LEASE_BASELINES_SCHEMA_VERSION;
  baselines: LeaseBaseline[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isSortedUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(item => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length
    && value.every((item, index) => index === 0 || value[index - 1]! < item);
}

function isSafeLeasePathArray(value: unknown): value is string[] {
  return isSortedUniqueStringArray(value) && value.every(item => {
    try {
      return normalizeLeaseScopePath(item) === item;
    } catch {
      return false;
    }
  });
}

export function normalizeLeaseScopePath(value: unknown): string {
  const candidate = String(value ?? "");
  const portable = candidate.split("/").every(component => {
    const stem = component.split(".")[0]!.toUpperCase();
    return component.length > 0
      && !/[\u0000-\u001f<>:"|?*]/u.test(component)
      && !/[ .]$/u.test(component)
      && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
  });
  if (
    candidate.length === 0
    || candidate !== candidate.normalize("NFC")
    || !portable
    || candidate.includes("\\")
    || candidate.includes("\0")
    || path.posix.isAbsolute(candidate)
    || path.posix.normalize(candidate) !== candidate
    || candidate.endsWith("/")
    || candidate === "."
    || candidate === ".."
    || candidate.startsWith("../")
    || candidate === ".git"
    || candidate.startsWith(".git/")
    || candidate === ".synod"
    || candidate.startsWith(".synod/")
  ) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease scope must be a safe repository-relative POSIX path.", {
      details: { path: candidate }
    });
  }
  return candidate;
}

export function normalizeLeaseScopes({
  read = [],
  write = [],
  readTree = [],
  writeTree = []
}: {
  read?: unknown[];
  write?: unknown[];
  readTree?: unknown[];
  writeTree?: unknown[];
}, { observer = false }: { observer?: boolean } = {}): LeaseScope[] {
  const scopes = [
    ...read.map(value => ({ path: normalizeLeaseScopePath(value), access: "read" as const, kind: "file" as const })),
    ...write.map(value => ({ path: normalizeLeaseScopePath(value), access: "write" as const, kind: "file" as const })),
    ...readTree.map(value => ({ path: normalizeLeaseScopePath(value), access: "read" as const, kind: "tree" as const })),
    ...writeTree.map(value => ({ path: normalizeLeaseScopePath(value), access: "write" as const, kind: "tree" as const }))
  ];
  if (observer === true) {
    if (scopes.some(scope => scope.access === "write")) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "An observer lease cannot contain write scopes.");
    }
    if (scopes.length === 0) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "An observer lease requires at least one read scope.");
    }
  } else if (!scopes.some(scope => scope.access === "write")) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "A writer lease requires at least one write scope.");
  }
  const spellings = new Map<string, string>();
  for (const scope of scopes) {
    const folded = scope.path.normalize("NFC").toLowerCase();
    const prior = spellings.get(folded);
    if (prior && prior !== scope.path) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease scope paths collide under case-insensitive normalization.", {
        details: { paths: [prior, scope.path] }
      });
    }
    spellings.set(folded, scope.path);
  }
  const unique = scopes.filter((scope, index) =>
    scopes.findIndex(candidate => candidate.access === scope.access
      && candidate.kind === scope.kind && candidate.path === scope.path) === index
  );
  const writes = unique.filter(scope => scope.access === "write");
  const normalized = unique.filter(scope =>
    !(scope.access === "read" && writes.some(candidate => leaseScopeCoversPath(candidate, scope.path)))
  );
  for (const [index, scope] of writes.entries()) {
    const overlap = writes.slice(index + 1).find(candidate => leaseScopesOverlap(scope, candidate));
    if (overlap) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "One lease cannot contain overlapping writer scopes.", {
        details: { paths: [scope.path, overlap.path] }
      });
    }
  }
  return normalized.sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.access.localeCompare(right.access)
    || left.kind.localeCompare(right.kind)
  );
}

/**
 * Normalize the additive task-level implementer plan into the same canonical
 * scope representation used by runtime leases. Task plans describe the
 * implementer delegate.start lane and therefore require at least one writer
 * scope; read scopes may accompany those writer scopes. Read-only observer
 * and reviewer/verifier lanes continue to use runtime lease normalization.
 */
export function normalizePlannedLeaseScopes(value: unknown): LeaseScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "A planned delegation requires at least one scope.");
  }
  const lanes: {
    read: unknown[];
    write: unknown[];
    readTree: unknown[];
    writeTree: unknown[];
  } = { read: [], write: [], readTree: [], writeTree: [] };
  for (const scope of value) {
    if (!isRecord(scope)
      || (scope.access !== "read" && scope.access !== "write")
      || (scope.kind !== "file" && scope.kind !== "tree")
      || typeof scope.path !== "string") {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "Planned delegation scopes must use the canonical path/access/kind shape.", {
        details: { scope }
      });
    }
    if (scope.access === "read" && scope.kind === "file") lanes.read.push(scope.path);
    else if (scope.access === "write" && scope.kind === "file") lanes.write.push(scope.path);
    else if (scope.access === "read" && scope.kind === "tree") lanes.readTree.push(scope.path);
    else lanes.writeTree.push(scope.path);
  }
  return normalizeLeaseScopes(lanes);
}

export function isPlannedLeaseScopes(value: unknown): value is LeaseScope[] {
  try {
    const normalized = normalizePlannedLeaseScopes(value);
    return Array.isArray(value)
      && value.length === normalized.length
      && value.every((scope, index) => {
        const candidate = normalized[index];
        return isRecord(scope)
          && candidate !== undefined
          && scope.path === candidate.path
          && scope.access === candidate.access
          && scope.kind === candidate.kind;
      });
  } catch {
    return false;
  }
}

export function leaseScopesOverlap(left: LeaseScope, right: LeaseScope): boolean {
  if (left.access !== "write" || right.access !== "write") return false;
  const leftPath = left.path.normalize("NFC").toLowerCase();
  const rightPath = right.path.normalize("NFC").toLowerCase();
  if (leftPath === rightPath) return true;
  if (left.kind === "tree" && rightPath.startsWith(`${leftPath}/`)) return true;
  if (right.kind === "tree" && leftPath.startsWith(`${rightPath}/`)) return true;
  return false;
}

export function leaseScopeCoversPath(scope: LeaseScope, candidate: string): boolean {
  const scopePath = scope.path.normalize("NFC").toLowerCase();
  const candidatePath = candidate.normalize("NFC").toLowerCase();
  return scopePath === candidatePath || (scope.kind === "tree" && candidatePath.startsWith(`${scopePath}/`));
}

export function isLeaseScope(value: unknown): value is LeaseScope {
  return isRecord(value)
    && (value.access === "read" || value.access === "write")
    && (value.kind === "file" || value.kind === "tree")
    && typeof value.path === "string"
    && (() => {
      try {
        return normalizeLeaseScopePath(value.path) === value.path;
      } catch {
        return false;
      }
    })();
}

function hasValidObserverScopes(value: { observer?: unknown; scopes: LeaseScope[] }): boolean {
  if (value.observer === undefined) return value.scopes.some(scope => scope.access === "write");
  if (value.observer !== true) return false;
  return value.scopes.length > 0 && value.scopes.every(scope => scope.access === "read");
}

function isDelegationRole(value: unknown): value is DelegationRole {
  return value === "implementer" || value === "reviewer" || value === "verifier";
}

export function isTaskLease(value: unknown): value is TaskLease {
  return isRecord(value)
    && isUuid(value.id)
    && isPositiveInteger(value.generation)
    && typeof value.taskId === "string"
    && value.taskId.length > 0
    && isNonNegativeInteger(value.taskRevision)
    && typeof value.ownerThread === "string"
    && value.ownerThread.length > 0
    && typeof value.executor === "string"
    && value.executor.length > 0
    && (value.role === undefined || isDelegationRole(value.role))
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every(isLeaseScope)
    && (value.role === undefined || value.role === "implementer"
      || (value.observer === true && value.scopes.every(scope => scope.access === "read")))
    && hasValidObserverScopes({ ...value, scopes: value.scopes })
    && validIsoTimestamp(value.acquiredAt)
    && validIsoTimestamp(value.heartbeatAt)
    && validIsoTimestamp(value.expiresAt)
    && isPositiveInteger(value.heartbeatIntervalSeconds)
    && isPositiveInteger(value.ttlSeconds)
    && value.ttlSeconds >= MIN_LEASE_TTL_SECONDS
    && value.ttlSeconds <= MAX_LEASE_TTL_SECONDS
    && value.heartbeatIntervalSeconds < value.ttlSeconds
    && Date.parse(value.acquiredAt) <= Date.parse(value.heartbeatAt)
    && Date.parse(value.heartbeatAt) < Date.parse(value.expiresAt)
    && isLeaseBaselineBinding(value.baseline)
    && value.status === "ACTIVE";
}

function isLeaseBaselineBinding(value: unknown): value is LeaseBaselineBinding {
  return isRecord(value)
    && value.path === LEASE_BASELINES_PATH
    && isHash(value.snapshotContentHash)
    && (value.branch === null || typeof value.branch === "string")
    && (value.head === null || typeof value.head === "string")
    && typeof value.worktreeFingerprint === "string"
    && isRecord(value.lastEvent)
    && isNonNegativeInteger(value.lastEvent.sequence)
    && typeof value.lastEvent.id === "string"
    && typeof value.lastEvent.hash === "string";
}

export function isTaskLeaseReservation(value: unknown): value is TaskLeaseReservation {
  return isRecord(value)
    && isUuid(value.id)
    && isUuid(value.token)
    && isPositiveInteger(value.generation)
    && typeof value.taskId === "string"
    && value.taskId.length > 0
    && isNonNegativeInteger(value.taskRevision)
    && typeof value.executor === "string"
    && value.executor.length > 0
    && (value.role === undefined || isDelegationRole(value.role))
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every(isLeaseScope)
    && (value.role === undefined || value.role === "implementer"
      || (value.observer === true && value.scopes.every(scope => scope.access === "read")))
    && hasValidObserverScopes({ ...value, scopes: value.scopes })
    && validIsoTimestamp(value.reservedAt)
    && validIsoTimestamp(value.expiresAt)
    && isPositiveInteger(value.ttlSeconds)
    && value.ttlSeconds >= MIN_LEASE_TTL_SECONDS
    && value.ttlSeconds <= MAX_LEASE_RESERVATION_TTL_SECONDS
    && Date.parse(value.reservedAt) < Date.parse(value.expiresAt)
    && isLeaseBaselineBinding(value.baseline)
    && value.status === "RESERVED";
}

export function isEndedTaskLease(value: unknown): value is EndedTaskLease {
  if (!isRecord(value) || !["RELEASED", "EXPIRED", "REVOKED"].includes(String(value.status))) return false;
  return isTaskLease({ ...value, status: "ACTIVE" });
}

function isTaskProposalPathState(value: unknown): value is TaskProposalPathState {
  return isRecord(value)
    && typeof value.path === "string"
    && isSafeLeasePathArray([value.path])
    && (value.sourcePath === undefined || (
      typeof value.sourcePath === "string"
      && isSafeLeasePathArray([value.sourcePath])
      && value.sourcePath !== value.path
    ))
    && typeof value.proposalAdded === "boolean"
    && typeof value.gitTracked === "boolean"
    && typeof value.staged === "boolean"
    && typeof value.committed === "boolean";
}

function completeTaskProposalPathStates(
  pathStates: unknown,
  ownedPaths: unknown
): pathStates is TaskProposalPathState[] {
  return Array.isArray(pathStates)
    && isSafeLeasePathArray(ownedPaths)
    && pathStates.length === ownedPaths.length
    && pathStates.every(isTaskProposalPathState)
    && pathStates.every((item, index) => item.path === ownedPaths[index])
    && pathStates.every(item => item.sourcePath === undefined || ownedPaths.includes(item.sourcePath));
}

export function isTaskProposalReference(value: unknown): value is TaskProposalReference {
  if (!isRecord(value)) return false;
  const pathStatesVersion = value.pathStatesVersion;
  const pathStates = value.pathStates;
  const ownedPaths = Array.isArray(value.ownedPaths) ? value.ownedPaths : undefined;
  const legacyPathStates = pathStates === undefined || (
    Array.isArray(pathStates)
    && pathStates.every(isTaskProposalPathState)
    && new Set(pathStates.map(item => item.path)).size === pathStates.length
    && pathStates.every((item, index) => index === 0 || pathStates[index - 1]!.path < item.path)
    && ownedPaths !== undefined
    && pathStates.every(item => ownedPaths.includes(item.path)
      && (item.sourcePath === undefined || ownedPaths.includes(item.sourcePath)))
  );
  const validPathStates = pathStatesVersion === undefined
    ? legacyPathStates
    : pathStatesVersion === TASK_PROPOSAL_PATH_STATES_VERSION
      && completeTaskProposalPathStates(pathStates, ownedPaths);
  return validPathStates
    && isRecord(value)
    && typeof value.path === "string"
    && /^\.synod\/proposals\/[0-9a-f-]{36}\/[1-9][0-9]*$/i.test(value.path)
    && isHash(value.bundleId)
    && isUuid(value.leaseId)
    && isPositiveInteger(value.generation)
    && isNonNegativeInteger(value.baseRevision)
    && value.revision === value.baseRevision + 1
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every(isLeaseScope)
    && value.scopes.some(scope => scope.access === "write")
    && isSafeLeasePathArray(value.ownedPaths)
    && isSafeLeasePathArray(value.excludedForeignPaths)
    && isHash(value.fingerprint)
    && isHash(value.snapshotHash)
    && isHash(value.sealedWorktreeFingerprint)
    && validIsoTimestamp(value.sealedAt)
    && isRecord(value.leaseBaselineEvent)
    && isNonNegativeInteger(value.leaseBaselineEvent.sequence)
    && typeof value.leaseBaselineEvent.id === "string"
    && typeof value.leaseBaselineEvent.hash === "string"
    && isRecord(value.sealedAfterEvent)
    && isNonNegativeInteger(value.sealedAfterEvent.sequence)
    && typeof value.sealedAfterEvent.id === "string"
    && typeof value.sealedAfterEvent.hash === "string"
    && value.sealedAfterEvent.sequence >= value.leaseBaselineEvent.sequence
    && value.status === "SEALED";
}

export function isCorrectionPolicy(value: unknown): value is CorrectionPolicy {
  return isRecord(value)
    && isNonNegativeInteger(value.limit)
    && isNonNegativeInteger(value.used)
    && Array.isArray(value.overrides)
    && value.overrides.every(item => isRecord(item)
      && isPositiveInteger(item.added)
      && typeof item.actor === "string"
      && item.actor.length > 0
      && typeof item.approver === "string"
      && item.approver.length > 0
      && typeof item.reference === "string"
      && item.reference.length > 0
      && typeof item.reason === "string"
      && item.reason.length > 0
      && validIsoTimestamp(item.recordedAt)
      && Array.isArray(item.evidence)
      && item.evidence.every(reference => typeof reference === "string" && reference.length > 0));
}

export function isLeaseBaselineReference(value: unknown): value is LeaseBaselineReference {
  return isRecord(value)
    && value.path === LEASE_BASELINES_PATH
    && isHash(value.contentHash);
}

function validateLeaseBaseline(value: unknown): LeaseBaseline {
  if (
    !isRecord(value)
    || !isUuid(value.leaseId)
    || !isPositiveInteger(value.generation)
    || typeof value.taskId !== "string"
    || value.taskId.length === 0
    || !isNonNegativeInteger(value.taskRevision)
    || !validIsoTimestamp(value.capturedAt)
  ) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline metadata is invalid.");
  }
  let snapshot: CheckpointSnapshot;
  try {
    snapshot = validateCheckpointSnapshot(value.snapshot);
  } catch (error) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline checkpoint snapshot is invalid.", {
      cause: error
    });
  }
  if (snapshot.capturedAt !== value.capturedAt) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline timestamp does not match its snapshot.");
  }
  return {
    leaseId: value.leaseId,
    generation: value.generation,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    capturedAt: value.capturedAt,
    snapshot
  };
}

export function validateLeaseBaselinesLedger(value: unknown): LeaseBaselinesLedger {
  if (!isRecord(value) || value.schemaVersion !== LEASE_BASELINES_SCHEMA_VERSION || !Array.isArray(value.baselines)) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline ledger is invalid.");
  }
  const baselines = value.baselines.map(validateLeaseBaseline);
  const identities = new Set<string>();
  for (const baseline of baselines) {
    const identity = `${baseline.leaseId}:${baseline.generation}`;
    if (identities.has(identity)) {
      throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline ledger contains a duplicate generation.", {
        details: { leaseId: baseline.leaseId, generation: baseline.generation }
      });
    }
    identities.add(identity);
  }
  baselines.sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
    || left.generation - right.generation
    || left.leaseId.localeCompare(right.leaseId)
  );
  return { schemaVersion: LEASE_BASELINES_SCHEMA_VERSION, baselines };
}

export function createLeaseBaselinesLedger(): LeaseBaselinesLedger {
  return { schemaVersion: LEASE_BASELINES_SCHEMA_VERSION, baselines: [] };
}

export function retainLeaseBaselinesLedger(
  value: LeaseBaselinesLedger,
  activeLeases: ReadonlyArray<Pick<TaskLease, "id" | "generation">>,
  historyLimit = MAX_RETAINED_LEASE_BASELINES
): LeaseBaselinesLedger {
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
    throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, "Lease baseline history limit is invalid.");
  }
  const ledger = validateLeaseBaselinesLedger(value);
  const active = new Set(activeLeases.map(lease => `${lease.id}:${lease.generation}`));
  const retainedActive = ledger.baselines.filter(item => active.has(`${item.leaseId}:${item.generation}`));
  const retainedHistory = ledger.baselines
    .filter(item => !active.has(`${item.leaseId}:${item.generation}`))
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)
      || right.generation - left.generation
      || right.leaseId.localeCompare(left.leaseId))
    .slice(0, historyLimit);
  return validateLeaseBaselinesLedger({
    schemaVersion: LEASE_BASELINES_SCHEMA_VERSION,
    baselines: [...retainedActive, ...retainedHistory]
  });
}

export function serializeLeaseBaselinesLedger(value: LeaseBaselinesLedger): string {
  const validated = validateLeaseBaselinesLedger(value);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function leaseBaselinesReference(value: LeaseBaselinesLedger): LeaseBaselineReference {
  return {
    path: LEASE_BASELINES_PATH,
    contentHash: contentHash(serializeLeaseBaselinesLedger(value))
  };
}

export function parseLeaseDuration(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `${label} must be a positive integer.`, {
      details: { field: label, value }
    });
  }
  return parsed;
}
