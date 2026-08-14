import { ERROR_CODES, SynodError } from "./errors.js";

export type OutputView = "full" | "summary";

export interface ParsedOutputViewArgs {
  args: string[];
  view: OutputView;
}

export interface JsonEnvelopeLike {
  ok: boolean;
  command: string | null;
  data?: unknown;
}

const HISTORY_KEYS = new Set([
  "evidence",
  "evidenceIds",
  "events",
  "history",
  "recoveryHistory",
  "overrides",
  "observations",
  "decisions",
  "recommendations",
  "verifications",
  "entries",
  "objects"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  return result;
}

function compactCheckpoint(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, ["capturedAt", "available", "branch", "head"]);
  if (isRecord(value.worktree)) {
    result.worktree = pick(value.worktree, ["clean", "entries", "fingerprint"]);
  }
  return result;
}

function compactBaseline(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return pick(value, ["snapshotContentHash", "branch", "head", "worktreeFingerprint", "lastEvent"]);
}

function compactLease(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, [
    "id",
    "generation",
    "taskId",
    "taskRevision",
    "ownerThread",
    "executor",
    "acquiredAt",
    "heartbeatAt",
    "expiresAt",
    "heartbeatIntervalSeconds",
    "ttlSeconds",
    "status"
  ]);
  return result;
}

function compactReservation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, [
    "id",
    "token",
    "generation",
    "taskId",
    "taskRevision",
    "executor",
    "reservedAt",
    "expiresAt",
    "ttlSeconds",
    "status"
  ]);
  if (Object.hasOwn(value, "baseline")) result.baseline = compactBaseline(value.baseline);
  return result;
}

function compactProposal(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return pick(value, [
    "path",
    "bundleId",
    "leaseId",
    "generation",
    "baseRevision",
    "revision",
    "sealedAt",
    "status"
  ]);
}

function compactRecovery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, ["status", "detectedAt", "reason", "decision"]);
  if (isRecord(value.endedLease)) {
    result.endedLease = pick(value.endedLease, ["id", "generation", "taskRevision", "ownerThread", "status"]);
  }
  if (isRecord(value.proposal)) result.proposal = compactProposal(value.proposal);
  return result;
}

function compactBudget(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, ["thresholdStatus"]);
  if (isRecord(value.policy)) {
    result.policy = pick(value.policy, ["revision", "rootSessionId", "startEvent", "softTotalTokens", "hardTotalTokens"]);
  }
  if (Array.isArray(value.observations)) result.observationCount = value.observations.length;
  if (Array.isArray(value.decisions)) result.decisionCount = value.decisions.length;
  return result;
}

function compactTask(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, [
    "id",
    "objective",
    "dependsOn",
    "state",
    "revision",
    "executor",
    "correctionRound",
    "leaseGeneration",
    "blocker",
    "blockedFrom",
    "supersededReason",
    "splitFrom",
    "preLease"
  ]);
  if (isRecord(value.correctionPolicy)) result.correctionPolicy = pick(value.correctionPolicy, ["limit", "used"]);
  if (isRecord(value.acceptance)) result.acceptance = pick(value.acceptance, ["status", "revision"]);
  if (isRecord(value.verification)) result.verification = pick(value.verification, ["status", "revision"]);
  result.lease = isRecord(value.lease) ? compactLease(value.lease) : null;
  result.leaseReservation = isRecord(value.leaseReservation) ? compactReservation(value.leaseReservation) : null;
  if (isRecord(value.reservation)) result.reservation = compactReservation(value.reservation);
  result.proposal = isRecord(value.proposal) ? compactProposal(value.proposal) : null;
  result.recovery = isRecord(value.recovery) ? compactRecovery(value.recovery) : null;
  if (isRecord(value.budget)) result.budget = compactBudget(value.budget);
  if (Array.isArray(value.evidence)) result.evidenceCount = value.evidence.length;
  if (Array.isArray(value.recoveryHistory)) result.recoveryHistoryCount = value.recoveryHistory.length;
  return result;
}

function compactTaskSelection(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return pick(value, ["taskId", "state", "revision", "leaseId", "generation", "ownerThread"]);
}

function compactSelection(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    if (entryKey === "tasks" && Array.isArray(entry)) {
      result.tasks = entry.map(task => compactTaskSelection(task));
    } else {
      result[entryKey] = compactValue(entry, entryKey);
    }
  }
  return result;
}

function compactWait(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    result[entryKey] = entryKey === "selection" ? compactSelection(entry) : compactValue(entry, entryKey);
  }
  return result;
}

function compactRotation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, ["policy", "handoff", "phase", "currentPhase"]);
  if (isRecord(value.policy)) result.policy = pick(value.policy, ["revision", "rootSessionId", "startEvent", "thresholds"]);
  if (Array.isArray(value.recommendations)) result.recommendationCount = value.recommendations.length;
  if (Array.isArray(value.verifications)) result.verificationCount = value.verifications.length;
  return result;
}

function compactArtifacts(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      const counts = pick(entry, ["records", "verifiedBundles", "sealedProposals", "invalidBundles", "manualReconciliation"]);
      result[key] = Object.keys(counts).length > 0 ? counts : compactValue(entry);
    } else if (typeof entry !== "object" || entry === null) {
      result[key] = entry;
    }
  }
  return result;
}

function compactValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    if (key === "tasks" || key === "replacements") return value.map(item => compactTask(item));
    return value.map(item => compactValue(item));
  }
  if (!isRecord(value)) return value;
  if (key === "task" || key === "tasks") return key === "task" ? compactTask(value) : compactValue(value);
  if (key === "lease") return compactLease(value);
  if (key === "reservation" || key === "leaseReservation") return compactReservation(value);
  if (key === "proposal") return compactProposal(value);
  if (key === "recovery") return compactRecovery(value);
  if (key === "checkpoint" || key === "currentCheckpoint") return compactCheckpoint(value);
  if (key === "rotation") return compactRotation(value);
  if (key === "artifacts") return compactArtifacts(value);
  const result: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    if (HISTORY_KEYS.has(entryKey) && Array.isArray(entry)) {
      result[`${entryKey}Count`] = entry.length;
      continue;
    }
    result[entryKey] = compactValue(entry, entryKey);
  }
  return result;
}

function reservationFence(value: Record<string, unknown>): Record<string, unknown> {
  const baseline = isRecord(value.baseline) ? value.baseline : {};
  return {
    reservationToken: value.token,
    leaseId: value.id,
    generation: value.generation,
    revision: value.taskRevision,
    expectedReservedAt: value.reservedAt,
    baselineHash: baseline.snapshotContentHash
  };
}

function leaseFence(value: Record<string, unknown>): Record<string, unknown> {
  return {
    leaseId: value.id,
    generation: value.generation,
    revision: value.taskRevision,
    expectedHeartbeatAt: value.heartbeatAt,
    ...(value.ownerThread === undefined ? {} : { ownerThread: value.ownerThread })
  };
}

function nextOperation(data: Record<string, unknown>): unknown {
  const action = typeof data.action === "string" ? data.action : undefined;
  const task = isRecord(data.task) ? data.task : undefined;
  const taskId = typeof task?.id === "string" ? task.id : undefined;
  const reservation = isRecord(data.reservation) ? data.reservation : undefined;
  if (action === "reserve" && reservation) {
    return {
      operation: "lease.bind",
      ...(taskId ? { taskId } : {}),
      fence: reservationFence(reservation),
      alternatives: ["lease.cancel", "lease.expire"]
    };
  }
  const lease = isRecord(data.lease) ? data.lease : undefined;
  if (lease && lease.status === "ACTIVE") {
    return {
      operation: "lease.heartbeat",
      ...(taskId ? { taskId } : {}),
      fence: leaseFence(lease),
      alternatives: ["lease.release", "lease.expire", "lease.revoke"]
    };
  }
  if (lease && task && isRecord(task.recovery) && task.recovery.status === "PENDING") {
    return {
      operation: "lease.recover",
      ...(taskId ? { taskId } : {}),
      fence: leaseFence(lease),
      alternatives: ["resume", "reassign", "supersede"]
    };
  }
  return null;
}

function compactStatus(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = pick(value, [
    "targetDirectory",
    "healthy",
    "stateSchemaVersion",
    "templateVersion",
    "updatedAt",
    "lastEvent",
    "eventCount",
    "checkpoint",
    "currentCheckpoint",
    "drift",
    "taskCounts",
    "leaseExpiryCandidates",
    "leaseReservationExpiryCandidates",
    "markdownView"
  ]);
  result.checkpoint = compactCheckpoint(value.checkpoint);
  result.currentCheckpoint = compactCheckpoint(value.currentCheckpoint);
  result.tasks = Array.isArray(value.tasks) ? value.tasks.map(task => compactTask(task)) : [];
  if (Object.hasOwn(value, "rotation")) result.rotation = compactRotation(value.rotation);
  if (Object.hasOwn(value, "artifacts")) result.artifacts = compactArtifacts(value.artifacts);
  if (isRecord(value.delta)) result.delta = pick(value.delta, ["changed", "counts"]);
  return result;
}

function compactMutation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "task") result.task = compactTask(entry);
    else if (key === "lease") result.lease = compactLease(entry);
    else if (key === "reservation") result.reservation = compactReservation(entry);
    else if (key === "checkpoint" || key === "currentCheckpoint") result[key] = compactCheckpoint(entry);
    else if (key === "evidence" && Array.isArray(entry)) {
      result.evidence = entry.map(item => isRecord(item) ? pick(item, ["id", "kind", "revision", "reference"]) : item);
    } else result[key] = compactValue(entry, key);
  }
  result.nextOperation = nextOperation(value);
  return result;
}

export function parseOutputViewArgs(args: string[]): ParsedOutputViewArgs {
  const remaining: string[] = [];
  let view: OutputView = "full";
  let explicit = false;
  const json = args.includes("--json");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--view") {
      remaining.push(arg!);
      continue;
    }
    if (explicit) {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "The --view option may be specified only once.", {
        details: { option: "--view" }
      });
    }
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new SynodError(ERROR_CODES.MISSING_OPTION_VALUE, "Missing value for --view.", {
        details: { option: "--view" }
      });
    }
    if (value !== "full" && value !== "summary") {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown output view: ${value}`, {
        details: { option: "--view", value, allowed: ["full", "summary"] }
      });
    }
    view = value;
    explicit = true;
    index += 1;
  }
  if (explicit && !json) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "The --view option requires --json.", {
      details: { option: "--view", requires: "--json" }
    });
  }
  return { args: remaining, view };
}

export function projectSummary(command: string | null, data: unknown): unknown {
  if (command === "status") return compactStatus(data);
  if (command === "lease") return compactMutation(data);
  if (command === "wait") return compactWait(data);
  if (command === "handoff") {
    if (!isRecord(data)) return data;
    const result = pick(data, ["targetDirectory", "lastEvent", "focusTaskIds", "recoveryBundle"]);
    result.checkpoint = isRecord(data.checkpoint)
      ? {
          acknowledged: compactCheckpoint(data.checkpoint.acknowledged),
          current: compactCheckpoint(data.checkpoint.current),
          drift: data.checkpoint.drift,
          delta: isRecord(data.checkpoint.delta) ? pick(data.checkpoint.delta, ["changed", "counts"]) : data.checkpoint.delta
        }
      : data.checkpoint;
    result.tasks = Array.isArray(data.tasks) ? data.tasks.map(task => compactTask(task)) : [];
    if (Object.hasOwn(data, "artifacts")) result.artifacts = compactArtifacts(data.artifacts);
    if (Object.hasOwn(data, "rotation")) result.rotation = compactRotation(data.rotation);
    return result;
  }
  return compactValue(data);
}

export function projectJsonEnvelope<T extends JsonEnvelopeLike>(envelope: T, view: OutputView): T {
  if (view === "full" || !Object.hasOwn(envelope, "data")) {
    if (view === "summary" && envelope.ok !== true && envelope.command === "status") {
      const raw = envelope as unknown as Record<string, unknown>;
      if (isRecord(raw.error) && Object.hasOwn(raw.error, "details")) {
        return {
          ...envelope,
          error: { ...raw.error, details: compactStatus(raw.error.details) }
        } as T;
      }
    }
    return envelope;
  }
  return { ...envelope, data: projectSummary(envelope.command, envelope.data) } as T;
}
