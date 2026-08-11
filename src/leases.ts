import path from "node:path";
import { contentHash } from "./filesystem.js";
import {
  validateCheckpointSnapshot,
  type CheckpointSnapshot
} from "./checkpoint.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { isRecord } from "./validation.js";

export const LEASE_BASELINES_PATH = ".synod/lease-baselines.json";
export const LEASE_BASELINES_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_TTL_SECONDS = 1_800;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 300;
export const MIN_LEASE_TTL_SECONDS = 30;
export const MAX_LEASE_TTL_SECONDS = 86_400;
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

export interface TaskLease {
  id: string;
  generation: number;
  taskId: string;
  taskRevision: number;
  ownerThread: string;
  executor: string;
  scopes: LeaseScope[];
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  heartbeatIntervalSeconds: number;
  ttlSeconds: number;
  baseline: {
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
  };
  status: "ACTIVE";
}

export type EndedTaskLease = Omit<TaskLease, "status"> & {
  status: "RELEASED" | "EXPIRED" | "REVOKED";
};

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
  fingerprint: string;
  snapshotHash: string;
  sealedWorktreeFingerprint: string;
  sealedAt: string;
  status: "SEALED";
}

export interface CorrectionPolicy {
  limit: number;
  used: number;
  overrides: Array<{
    added: number;
    actor: string;
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
}): LeaseScope[] {
  const scopes = [
    ...read.map(value => ({ path: normalizeLeaseScopePath(value), access: "read" as const, kind: "file" as const })),
    ...write.map(value => ({ path: normalizeLeaseScopePath(value), access: "write" as const, kind: "file" as const })),
    ...readTree.map(value => ({ path: normalizeLeaseScopePath(value), access: "read" as const, kind: "tree" as const })),
    ...writeTree.map(value => ({ path: normalizeLeaseScopePath(value), access: "write" as const, kind: "tree" as const }))
  ];
  if (!scopes.some(scope => scope.access === "write")) {
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
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every(isLeaseScope)
    && value.scopes.some(scope => scope.access === "write")
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
    && isRecord(value.baseline)
    && value.baseline.path === LEASE_BASELINES_PATH
    && isHash(value.baseline.snapshotContentHash)
    && (value.baseline.branch === null || typeof value.baseline.branch === "string")
    && (value.baseline.head === null || typeof value.baseline.head === "string")
    && typeof value.baseline.worktreeFingerprint === "string"
    && isRecord(value.baseline.lastEvent)
    && isNonNegativeInteger(value.baseline.lastEvent.sequence)
    && typeof value.baseline.lastEvent.id === "string"
    && typeof value.baseline.lastEvent.hash === "string"
    && value.status === "ACTIVE";
}

export function isTaskProposalReference(value: unknown): value is TaskProposalReference {
  return isRecord(value)
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
