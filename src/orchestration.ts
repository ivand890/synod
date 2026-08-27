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
import { readLocalRuntimeDescriptor } from "./local-runtime.js";
import { readManifest } from "./manifest.js";
import { generatedConfigMarker, removeAgentsBlocks } from "./templates.js";
import { errorCode, errorMessage, isRecord, parseJson } from "./validation.js";
import { isDelegationRole, type DelegationRole } from "./profiles.js";
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
  DEFAULT_LEASE_RESERVATION_TTL_SECONDS,
  DEFAULT_LEASE_TTL_SECONDS,
  LEASE_BASELINES_PATH,
  MAX_LEASE_TTL_SECONDS,
  MAX_LEASE_RESERVATION_TTL_SECONDS,
  MIN_LEASE_TTL_SECONDS,
  createLeaseBaselinesLedger,
  isCorrectionPolicy,
  isEndedTaskLease,
  isLeaseBaselineReference,
  isPlannedLeaseScopes,
  isTaskLease,
  isTaskLeaseReservation,
  isTaskProposalReference,
  leaseBaselinesReference,
  leaseScopeCoversPath,
  leaseScopesOverlap,
  normalizeLeaseScopePath,
  normalizeLeaseScopes,
  normalizePlannedLeaseScopes,
  parseLeaseDuration,
  retainLeaseBaselinesLedger,
  serializeLeaseBaselinesLedger,
  validateLeaseBaselinesLedger,
  type CorrectionPolicy,
  type EndedTaskLease,
  type LeaseBaseline,
  type LeaseBaselinesLedger,
  type LeaseBaselineReference,
  type LeaseScope,
  type TaskLease,
  type TaskLeaseReservation,
  TASK_PROPOSAL_PATH_STATES_VERSION,
  type TaskProposalPathState,
  type TaskProposalReference
} from "./leases.js";
import {
  collectTaskBudgetReport,
  effectiveHardTotalTokens,
  isTaskBudget,
  thresholdStatus,
  type BudgetDecisionAction,
  type BudgetMutationIdentity,
  type CanonicalEventIdentity,
  type TaskBudget,
  type TaskBudgetObservation,
  type TaskBudgetPolicy,
  type TaskBudgetReport
} from "./budgets.js";
import type { UsageClient } from "./usage.js";
import { resolveUsageRootSession } from "./usage.js";
import {
  collectRotationReport,
  currentRotationPhase,
  isProjectRotation,
  isRotationThresholds,
  recommendedRotationThresholds,
  type ProjectRotation,
  type RotationHandoffIdentity,
  type RotationMetric,
  type RotationPolicy,
  type RotationRecommendation,
  type RotationReport,
  type RotationSuggestion,
  type RotationThresholds
} from "./rotation.js";

export const LEGACY_ORCHESTRATION_SCHEMA_VERSION = 1;
export const SCHEMA_TWO_ORCHESTRATION_VERSION = 2;
export const PREVIOUS_ORCHESTRATION_SCHEMA_VERSION = 3;
export const ORCHESTRATION_SCHEMA_VERSION = 4;
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
export type ApprovalDecision = "approved" | "rejected";

export interface TaskApprovalRecord {
  event: BudgetMutationIdentity;
  role: Exclude<DelegationRole, "implementer">;
  decision: ApprovalDecision;
  ownerThread: string;
  revision: number;
  proposalBundleId: string;
  evidence: string[];
  actor: string;
  recordedAt: string;
  consumedAt?: string;
}

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

export interface TaskScopedPathEvidence {
  path: string;
  sourcePath?: string;
  status?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  resolved: boolean;
}

export interface TaskCorrectionRecord {
  round: number;
  revision: number;
  reason: string;
  evidence: string[];
  evidenceIds: string[];
  scopeFingerprint: string;
  paths: string[];
  pathEvidence: TaskScopedPathEvidence[];
  recordedAt: string;
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
  /**
   * Optional additive scheduler intent. Legacy tasks omit this field and
   * remain readable/actionable, but only tasks with a valid writer lane are
   * eligible for parallel writer guidance.
   */
  plannedScopes?: LeaseScope[];
  lease?: TaskLease;
  leaseReservation?: TaskLeaseReservation;
  proposal?: TaskProposalReference;
  /**
   * Durable opt-in for the typed reviewer/verifier lane. Legacy tasks may
   * omit this marker and remain readable, but approval transitions must not
   * infer the lane from incidental approval arrays or lease roles.
   */
  approvalPolicy?: "typed";
  /** Typed reviewer/verifier decisions. Legacy tasks may omit this field. */
  approvals?: TaskApprovalRecord[];
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
  correctionHistory?: TaskCorrectionRecord[];
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
  budget?: TaskBudget;
}

export interface OrchestrationLastEvent {
  sequence: number;
  id: string;
  hash: string;
}

export interface ConcurrencyPolicy {
  maxConcurrentSubagents: number;
}

export const CONCURRENCY_POLICY_DEFAULTS = { maxConcurrentSubagents: 3 } as const;

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
  rotation?: ProjectRotation;
  concurrency?: ConcurrencyPolicy;
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
  SchemaTwoOrchestrationTask,
  "correctionPolicy" | "leaseGeneration" | "lease" | "proposal" | "recovery" | "recoveryHistory" | "split" | "splitFrom" | "preLease" | "correctionHistory"
>;

type SchemaThreeOrchestrationTask = Omit<OrchestrationTask, "leaseReservation">;
type SchemaTwoOrchestrationTask = Omit<SchemaThreeOrchestrationTask, "budget">;

interface SchemaThreeOrchestrationStateCore {
  schemaVersion: typeof PREVIOUS_ORCHESTRATION_SCHEMA_VERSION;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  checkpoint: GitCheckpoint;
  leaseBaselines: LeaseBaselineReference;
  taskOrder: string[];
  tasks: Record<string, SchemaThreeOrchestrationTask>;
  evidenceCounter: number;
  rotation?: ProjectRotation;
}

interface SchemaThreeOrchestrationState extends SchemaThreeOrchestrationStateCore {
  lastEvent: OrchestrationLastEvent;
}

interface SchemaThreeOrchestrationEvent {
  schemaVersion: typeof PREVIOUS_ORCHESTRATION_SCHEMA_VERSION;
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
  state: SchemaThreeOrchestrationStateCore;
  eventHash: string;
}

interface SchemaTwoOrchestrationStateCore {
  schemaVersion: typeof SCHEMA_TWO_ORCHESTRATION_VERSION;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  checkpoint: GitCheckpoint;
  leaseBaselines: LeaseBaselineReference;
  taskOrder: string[];
  tasks: Record<string, SchemaTwoOrchestrationTask>;
  evidenceCounter: number;
}

interface SchemaTwoOrchestrationState extends SchemaTwoOrchestrationStateCore {
  lastEvent: OrchestrationLastEvent;
}

interface SchemaTwoOrchestrationEvent {
  schemaVersion: typeof SCHEMA_TWO_ORCHESTRATION_VERSION;
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
  state: SchemaTwoOrchestrationStateCore;
  eventHash: string;
}

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
  usageClientFactory?: () => UsageClient;
  usageCollector?: Parameters<typeof collectTaskBudgetReport>[0]["collector"];
  usageSessionResolver?: typeof resolveUsageRootSession;
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
  event: BudgetMutationIdentity;
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
  runtimeVersion: string | null;
  installedTemplateVersion: string | null;
  manifestSchemaVersion: number | null;
  stateTemplateVersion: string;
  templateVersion: string;
  updatedAt: string;
  lastEvent: OrchestrationLastEvent;
  eventCount: number;
  checkpoint: GitCheckpoint;
  currentCheckpoint: GitCheckpoint;
  drift: CheckpointDrift;
  taskCounts: Record<TaskState, number>;
  tasks: OrchestrationTask[];
  rotation: ProjectRotation | null;
  leaseExpiryCandidates: Array<{
    taskId: string;
    leaseId: string;
    generation: number;
    heartbeatAt: string;
    expiresAt: string;
  }>;
  leaseReservationExpiryCandidates: Array<{
    taskId: string;
    leaseId: string;
    generation: number;
    reservedAt: string;
    expiresAt: string;
  }>;
  markdownView: string;
  delta?: CheckpointDelta;
  selection?: OrchestrationStatusSelection;
}

export interface OrchestrationStatusSelection {
  type: "task" | "active-only" | "changed-since-checkpoint";
  taskId?: string;
  rationale: string;
  bounded: true;
  taskCount: number;
  totalTaskCount: number;
  pathCount?: number;
  pathsTruncated?: boolean;
  tasksTruncated?: boolean;
  historyLimit?: number;
}

export interface OrchestrationStatusOptions {
  directory?: string;
  explain?: boolean;
  readOnly?: boolean;
  taskId?: string;
  activeOnly?: boolean;
  changedSinceCheckpoint?: boolean;
}

export interface ValidatedCheckpointSource {
  targetDirectory: string;
  state: OrchestrationState;
  events: OrchestrationEvent[];
  snapshot: CheckpointSnapshot;
  current: { checkpoint: GitCheckpoint; snapshot: CheckpointSnapshot };
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["DONE", "SUPERSEDED"]);
const STATUS_TASK_LIMIT = 100;
const STATUS_PATH_LIMIT = 100;
const GIT_PATHSPEC_BATCH_BYTES = 32 * 1024;
const STATUS_HISTORY_LIMIT = 8;
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

function latestBudgetDecision(task: OrchestrationTask): TaskBudget["decisions"][number] | undefined {
  const budget = task.budget;
  const observation = budget?.observations.filter(item => item.policyRevision === budget.policy.revision).at(-1);
  if (!budget || !observation) return undefined;
  return budget.decisions.find(item => item.observation.sequence === observation.event.sequence
    && item.observation.id === observation.event.id);
}

function assertBudgetAllowsExecution(task: OrchestrationTask, action: string): void {
  if (task.budget?.thresholdStatus !== "decision-required") return;
  throw new SynodError(ERROR_CODES.BUDGET_DECISION_REQUIRED, `Task ${task.id} requires a supervisor decision before ${action}.`, {
    details: {
      taskId: task.id,
      action,
      policyRevision: task.budget.policy.revision,
      observation: task.budget.observations.at(-1)?.event
    }
  });
}

function assertBudgetStructuralDecision(task: OrchestrationTask, action: "split" | "supersede"): void {
  if (task.budget?.thresholdStatus !== "decision-required") return;
  const decision = latestBudgetDecision(task);
  if (decision?.action !== action) {
    throw new SynodError(ERROR_CODES.BUDGET_DECISION_REQUIRED, `Task ${task.id} requires an exact ${action} budget decision before ${action}.`, {
      details: { taskId: task.id, action, actualDecision: decision?.action }
    });
  }
}

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
  if (task.budget?.thresholdStatus === "decision-required") {
    allowed = allowed.filter(target => !["READY", "ACTIVE"].includes(target));
    if (latestBudgetDecision(task)?.action !== "supersede") {
      allowed = allowed.filter(target => target !== "SUPERSEDED");
    }
  }
  return allowed;
}

function requiredFlag(flag: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    const items = value.filter(item => typeof item === "string" && item.length > 0);
    return items.length > 0 ? items.flatMap(item => [flag, item]) : [flag];
  }
  if (typeof value === "string" && value.length > 0) return [flag, value];
  return [flag];
}

function guidanceArgv(operation: string, taskId: string, args: Record<string, unknown> = {}): string[] {
  const evidence = Object.hasOwn(args, "evidence") ? requiredFlag("--evidence", args.evidence) : [];
  const reason = Object.hasOwn(args, "reason") ? requiredFlag("--reason", args.reason) : [];
  const ownerThread = Object.hasOwn(args, "ownerThread") ? requiredFlag("--owner-thread", args.ownerThread) : [];
  if (operation === "delegate.start") {
    const lane = (key: "write" | "writeTree" | "read" | "readTree", flag: string) => {
      const values = Array.isArray(args[key]) ? args[key] : [];
      return values.flatMap(value => [flag, String(value)]);
    };
    return [
      "delegate", "start", taskId,
      ...lane("write", "--write"),
      ...lane("writeTree", "--write-tree"),
      ...lane("read", "--read"),
      ...lane("readTree", "--read-tree")
    ];
  }
  if (operation === "delegate.complete") {
    return ["delegate", "complete", taskId, ...evidence, "--owner-thread"];
  }
  if (operation === "wait.task") return ["wait", "--task", taskId];
  if (operation === "proposal.submit") return ["proposal", "submit", taskId, ...requiredFlag("--evidence", args.evidence)];
  if (operation === "task.correct") {
    return ["task", "correct", taskId, "--revision", String(args.revision ?? ""), ...reason, ...evidence];
  }
  if (operation === "task.transition") {
    return [
      "task", "transition", taskId, String(args.to ?? ""),
      "--revision", String(args.revision ?? ""),
      ...evidence,
      ...reason
    ];
  }
  if (operation === "lease.recover") {
    return [
      "lease", "recover", taskId,
      "--lease-id", String(args.leaseId ?? ""),
      "--generation", String(args.generation ?? ""),
      "--revision", String(args.revision ?? ""),
      "--expected-heartbeat-at", String(args.expectedHeartbeatAt ?? ""),
      ...(args.decision ? ["--decision", String(args.decision)] : []),
      ...ownerThread,
      ...reason
    ];
  }
  if (operation === "lease.revoke") {
    return [
      "lease", "revoke", taskId,
      "--lease-id", String(args.leaseId ?? ""),
      "--generation", String(args.generation ?? ""),
      "--revision", String(args.revision ?? ""),
      "--expected-heartbeat-at", String(args.expectedHeartbeatAt ?? ""),
      ...reason
    ];
  }
  if (operation === "lease.cancel") {
    return [
      "lease", "cancel", taskId,
      "--reservation-token", String(args.reservationToken ?? ""),
      "--lease-id", String(args.leaseId ?? ""),
      "--generation", String(args.generation ?? ""),
      "--revision", String(args.revision ?? ""),
      "--expected-reserved-at", String(args.expectedReservedAt ?? ""),
      "--baseline-hash", String(args.baselineHash ?? ""),
      ...reason
    ];
  }
  if (operation === "lease.expire" && args.reservationToken) {
    return [
      "lease", "expire", taskId,
      "--reservation-token", String(args.reservationToken ?? ""),
      "--lease-id", String(args.leaseId ?? ""),
      "--generation", String(args.generation ?? ""),
      "--revision", String(args.revision ?? ""),
      "--expected-reserved-at", String(args.expectedReservedAt ?? ""),
      "--baseline-hash", String(args.baselineHash ?? ""),
      ...reason
    ];
  }
  if (operation === "lease.expire") {
    return [
      "lease", "expire", taskId,
      "--lease-id", String(args.leaseId ?? ""),
      "--generation", String(args.generation ?? ""),
      "--revision", String(args.revision ?? ""),
      "--expected-heartbeat-at", String(args.expectedHeartbeatAt ?? ""),
      ...reason
    ];
  }
  return [];
}

export interface TaskGuidanceAction {
  operation: string;
  arguments: Record<string, unknown>;
  requirements: string[];
  argv: string[];
  fence?: Record<string, unknown>;
}

function guidanceAction(
  operation: string,
  args: Record<string, unknown>,
  requirements: string[],
  fence?: Record<string, unknown>
): TaskGuidanceAction {
  return {
    operation,
    arguments: args,
    requirements,
    argv: guidanceArgv(operation, String(args.taskId ?? ""), args),
    ...(fence ? { fence } : {})
  };
}

function recoverGuidanceActions(task: OrchestrationTask) {
  const ended = task.recovery?.endedLease;
  if (!ended) return [];
  const fence = {
    leaseId: ended.id,
    generation: ended.generation,
    revision: task.revision,
    expectedHeartbeatAt: ended.heartbeatAt
  };
  return (["resume", "reassign", "supersede"] as const).map(decision => guidanceAction("lease.recover", {
    taskId: task.id,
    ...fence,
    decision,
    reason: null,
    ...(decision === "reassign" ? { ownerThread: null } : {})
  }, decision === "reassign" ? ["owner-thread", "reason"] : ["reason"], fence));
}

function preferredTransition(state: TaskState): TaskState | undefined {
  if (state === "READY") return "ACTIVE";
  if (state === "ACTIVE") return "REVIEW";
  if (state === "REVIEW") return "ACCEPTED";
  if (state === "ACCEPTED") return "VERIFIED";
  if (state === "VERIFIED") return "DONE";
  return undefined;
}

interface ParallelTaskBatch {
  taskIds: string[];
  actions: TaskGuidanceAction[];
}

function plannedWriterScopes(task: OrchestrationTask): LeaseScope[] {
  return task.plannedScopes?.filter(scope => scope.access === "write") || [];
}

function plannedScopesConflict(left: readonly LeaseScope[], right: readonly LeaseScope[]): boolean {
  return left.some(scope => right.some(candidate => leaseScopesOverlap(scope, candidate)));
}

function proposalPathsForScheduling(task: OrchestrationTask): string[] {
  const current = task.proposal && proposalReservesPaths(task) ? task.proposal.ownedPaths : [];
  const recovery = task.recovery?.status === "PENDING" ? task.recovery.proposal?.ownedPaths || [] : [];
  return [...new Set([...current, ...recovery])];
}

function plannedScopesHitProposal(scopes: readonly LeaseScope[], paths: readonly string[]): boolean {
  return scopes.some(scope => paths.some(candidate => leaseScopeCoversPath(scope, candidate)));
}

async function parallelReadyBatches(
  targetDirectory: string,
  state: OrchestrationState,
  guidanceTasks: readonly { id: string; actions: TaskGuidanceAction[] }[]
): Promise<ParallelTaskBatch[]> {
  const availableSlots = concurrencyStatus(state).availableSlots;
  if (availableSlots <= 0) return [];

  const activeWriterScopes = taskList(state).flatMap(task => {
    const authority = task.leaseReservation || task.lease;
    if (!authority || authority.observer === true) return [];
    return authority.scopes.filter(scope => scope.access === "write");
  });
  const sealedProposalPaths = taskList(state).flatMap(proposalPathsForScheduling);
  const candidates = guidanceTasks
    .map(guidance => ({ guidance, task: state.tasks[guidance.id]! }))
    .filter(({ guidance, task }) => task.state === "READY"
      && task.lease === undefined
      && task.leaseReservation === undefined
      && task.recovery?.status !== "PENDING"
      && task.dependsOn.every(dependency => state.tasks[dependency]?.state === "DONE")
      && guidance.actions.some(action => action.operation === "delegate.start")
      && plannedWriterScopes(task).length > 0);
  // guidanceTasks already follows the canonical taskOrder. Preserve that
  // order so the scheduler's deterministic winner agrees with the ordinary
  // recommendedTaskId and never promotes a lexical-ID successor.
  const selected: Array<{ task: OrchestrationTask; action: TaskGuidanceAction }> = [];
  for (const candidate of candidates) {
    if (selected.length >= availableSlots) break;
    const scopes = plannedWriterScopes(candidate.task);
    try {
      await validateLeaseScopeFilesystemPaths(targetDirectory, candidate.task.plannedScopes || []);
    } catch {
      // A plan whose filesystem identity drifted after task creation is not a
      // safe scheduler candidate. The ordinary per-task action remains
      // available and the eventual reservation will report the typed fence.
      continue;
    }
    if (plannedScopesConflict(scopes, activeWriterScopes)
      || plannedScopesHitProposal(scopes, sealedProposalPaths)) continue;
    if (selected.some(item => plannedScopesConflict(scopes, plannedWriterScopes(item.task)))) continue;
    const action = candidate.guidance.actions.find(item => item.operation === "delegate.start");
    if (!action) continue;
    selected.push({ task: candidate.task, action });
  }
  return selected.length === 0
    ? []
    : [{ taskIds: selected.map(item => item.task.id), actions: selected.map(item => item.action) }];
}

export async function nextTaskGuidance(
  { directory = "." }: { directory?: string } = {},
  { clock = () => Date.now() }: { clock?: () => number } = {}
) {
  const targetDirectory = path.resolve(directory);
  const canonical = await readOrchestration(targetDirectory);
  const tasks = canonical.state.taskOrder
    .map(taskId => canonical.state.tasks[taskId])
    .filter((task): task is OrchestrationTask => task !== undefined)
    .filter(task => !["DONE", "SUPERSEDED"].includes(task.state))
    .map(task => {
      const nominalTransitions = legalTaskTransitions(task, canonical.state.tasks);
      const correctionReady = ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state);
      const leaseActivationReady = !task.lease
        && (task.state === "READY" || correctionReady);
      const expiredReservation = task.leaseReservation?.status === "RESERVED"
        && Date.parse(task.leaseReservation.expiresAt) <= clock();
      const expiredLease = task.lease?.status === "ACTIVE" && Date.parse(task.lease.expiresAt) <= clock();
      const legalTransitions = task.leaseReservation || expiredLease
        ? []
        : nominalTransitions.filter(to => !(task.state === "ACTIVE" && to === "REVIEW" && !task.lease));
      const incompleteDependencies = task.dependsOn.filter(taskId => canonical.state.tasks[taskId]?.state !== "DONE");
      const noInScopeDelta = (() => {
        if (task.state !== "ACTIVE" || !task.lease || expiredLease || !canonical.snapshot) return false;
        try {
          const baseline = leaseBaselineFor(task, task.lease, canonical.leaseBaselines);
          const classified = classifyLeaseDelta(
            canonical.state,
            task,
            task.lease,
            task.lease.baseline.lastEvent.sequence,
            baseline.snapshot,
            canonical.snapshot
          );
          return [...new Set(classified.owned.flatMap(deltaPaths))].length === 0;
        } catch {
          return true;
        }
      })();
      const preferred = preferredTransition(task.state);
      const orderedTransitions = preferred
        ? [...legalTransitions].sort((left, right) => Number(right === preferred) - Number(left === preferred))
        : legalTransitions;
      const transitionActions = orderedTransitions.flatMap(to => {
        if (leaseActivationReady && to === "ACTIVE") {
          const planned = task.plannedScopes || [];
          return [guidanceAction("delegate.start", {
            taskId: task.id,
            write: planned.filter(scope => scope.access === "write" && scope.kind === "file").map(scope => scope.path),
            writeTree: planned.filter(scope => scope.access === "write" && scope.kind === "tree").map(scope => scope.path),
            read: planned.filter(scope => scope.access === "read" && scope.kind === "file").map(scope => scope.path),
            readTree: planned.filter(scope => scope.access === "read" && scope.kind === "tree").map(scope => scope.path)
          }, ["write-scope"])];
        }
        if (task.state === "ACTIVE" && to === "REVIEW") {
          if (noInScopeDelta) return [];
          return [guidanceAction("proposal.submit", { taskId: task.id, evidence: [] }, ["evidence"])];
        }
        const evidenceRequired = (task.state === "REVIEW" && to === "ACCEPTED")
          || (task.state === "ACCEPTED" && to === "VERIFIED")
          || (to === "ACTIVE" && correctionReady);
        const reasonRequired = to === "BLOCKED" || to === "SUPERSEDED";
        return [guidanceAction("task.transition", {
          taskId: task.id,
          to,
          revision: task.revision,
          ...(evidenceRequired ? { evidence: [] } : {}),
          ...(reasonRequired ? { reason: null } : {})
        }, [
          ...(to === "ACTIVE" && !task.lease ? ["active-writer-lease"] : []),
          ...(evidenceRequired ? ["evidence"] : []),
          ...(reasonRequired ? ["reason"] : [])
        ])];
      });
      const reservationFenceArgs = task.leaseReservation
        ? {
            taskId: task.id,
            reservationToken: task.leaseReservation.token,
            leaseId: task.leaseReservation.id,
            generation: task.leaseReservation.generation,
            revision: task.leaseReservation.taskRevision,
            expectedReservedAt: task.leaseReservation.reservedAt,
            baselineHash: task.leaseReservation.baseline.snapshotContentHash
          }
        : undefined;
      const reservationFenceOnly = reservationFenceArgs
        ? (({ taskId: _taskId, ...fence }) => fence)(reservationFenceArgs)
        : undefined;
      const bindRequirements = ["owner-thread", ...(correctionReady ? ["evidence"] : [])];
      const baseActions = expiredReservation && reservationFenceArgs && reservationFenceOnly
        ? [guidanceAction("lease.expire", { ...reservationFenceArgs, reason: null }, ["reason"], reservationFenceOnly)]
        : reservationFenceArgs && reservationFenceOnly
        ? [
            guidanceAction("delegate.complete", {
              taskId: task.id,
              ...(correctionReady ? { evidence: [] } : {})
            }, bindRequirements, reservationFenceOnly),
            guidanceAction("lease.cancel", { ...reservationFenceArgs, reason: null }, ["reason"], reservationFenceOnly)
          ]
        : expiredLease && task.lease
          ? [guidanceAction("lease.expire", {
              taskId: task.id,
              leaseId: task.lease.id,
              generation: task.lease.generation,
              revision: task.revision,
              expectedHeartbeatAt: task.lease.heartbeatAt,
              reason: null
            }, ["reason"], {
              leaseId: task.lease.id,
              generation: task.lease.generation,
              revision: task.revision,
              expectedHeartbeatAt: task.lease.heartbeatAt
            })]
          : task.recovery?.status === "PENDING"
            ? recoverGuidanceActions(task)
            : transitionActions;
      const waitAction = task.state === "ACTIVE"
        && Boolean(task.lease)
        && !expiredLease
        && task.recovery?.status !== "PENDING"
        ? guidanceAction("wait.task", { taskId: task.id }, [])
        : undefined;
      const correctionAction = task.state === "ACTIVE"
        && Boolean(task.lease)
        && !expiredLease
        && task.correctionPolicy.used < task.correctionPolicy.limit
        && task.budget?.thresholdStatus !== "decision-required"
        ? guidanceAction("task.correct", { taskId: task.id, revision: task.revision, reason: null, evidence: [] }, ["reason", "evidence"])
        : undefined;
      const emptyDeliveryRevoke = noInScopeDelta
        && task.lease
        && !expiredLease
        && !correctionAction
        ? guidanceAction("lease.revoke", {
            taskId: task.id,
            leaseId: task.lease.id,
            generation: task.lease.generation,
            revision: task.revision,
            expectedHeartbeatAt: task.lease.heartbeatAt,
            reason: null
          }, ["reason"], {
            leaseId: task.lease.id,
            generation: task.lease.generation,
            revision: task.revision,
            expectedHeartbeatAt: task.lease.heartbeatAt
          })
        : undefined;
      const actions = [
        ...(waitAction ? [waitAction] : []),
        ...(correctionAction ? [correctionAction] : []),
        ...(emptyDeliveryRevoke ? [emptyDeliveryRevoke] : []),
        ...baseActions
      ];
      const proposalPathStates = task.proposal?.pathStates;
      return {
        id: task.id,
        state: task.state,
        revision: task.revision,
        dependsOn: [...task.dependsOn],
        ...(task.plannedScopes === undefined ? {} : { plannedScopes: structuredClone(task.plannedScopes) }),
        incompleteDependencies,
        correction: structuredClone(task.correctionPolicy),
        budget: task.budget ? {
          policyRevision: task.budget.policy.revision,
          thresholdStatus: task.budget.thresholdStatus,
          decisionRequired: task.budget.thresholdStatus === "decision-required"
        } : null,
        recovery: task.recovery ? {
          status: task.recovery.status,
          priorGeneration: task.recovery.endedLease.generation,
          priorOwnerThread: task.recovery.endedLease.ownerThread
        } : null,
        lease: task.lease ? {
          id: task.lease.id,
          generation: task.lease.generation,
          status: task.lease.status,
          ownerThread: task.lease.ownerThread,
          expiresAt: task.lease.expiresAt
        } : null,
        reservation: task.leaseReservation ? {
          id: task.leaseReservation.id,
          generation: task.leaseReservation.generation,
          status: task.leaseReservation.status,
          expiresAt: task.leaseReservation.expiresAt
        } : null,
        proposal: task.proposal ? {
          revision: task.proposal.revision,
          generation: task.proposal.generation,
          status: task.proposal.status,
          bundleId: task.proposal.bundleId,
          ...(task.proposal.pathStatesVersion === undefined ? {} : { pathStatesVersion: task.proposal.pathStatesVersion }),
          ...(proposalPathStates === undefined ? {} : {
            pathStates: structuredClone(proposalPathStates.slice(0, STATUS_PATH_LIMIT)),
            pathSummary: {
              limit: STATUS_PATH_LIMIT,
              pathStates: {
                total: proposalPathStates.length,
                returned: Math.min(proposalPathStates.length, STATUS_PATH_LIMIT),
                truncated: proposalPathStates.length > STATUS_PATH_LIMIT,
                present: true
              }
            }
          })
        } : null,
        constraints: {
          reservationRequiresBind: Boolean(task.leaseReservation),
          reservationExpired: Boolean(expiredReservation),
          leaseExpired: Boolean(expiredLease),
          recoveryDecisionRequired: task.recovery?.status === "PENDING",
          budgetDecisionRequired: task.budget?.thresholdStatus === "decision-required",
          correctionExhausted: task.correctionPolicy.used >= task.correctionPolicy.limit
        },
        legalTransitions,
        actions
      };
    });
  const parallelBatches = await parallelReadyBatches(targetDirectory, canonical.state, tasks);
  return {
    recommendedTaskId: tasks.find(task => task.actions.length > 0)?.id || null,
    tasks,
    parallelBatches,
    concurrency: concurrencyStatus(canonical.state),
    lastEvent: canonical.state.lastEvent
  };
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
  metadata: EventMetadata,
  identity?: { id: string }
): { event: OrchestrationEvent; state: OrchestrationState } {
  const sequence = (previousState?.lastEvent.sequence || 0) + 1;
  const unsignedEvent: Omit<OrchestrationEvent, "eventHash"> = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence,
    id: identity?.id || randomUUID(),
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

function boundedStatusTask(task: OrchestrationTask): OrchestrationTask {
  const bounded = structuredClone(task);
  bounded.acceptance.criteria = bounded.acceptance.criteria.slice(0, STATUS_HISTORY_LIMIT);
  bounded.acceptance.evidenceIds = bounded.acceptance.evidenceIds.slice(-STATUS_HISTORY_LIMIT);
  bounded.verification.commands = bounded.verification.commands.slice(0, STATUS_HISTORY_LIMIT);
  bounded.verification.evidenceIds = bounded.verification.evidenceIds.slice(-STATUS_HISTORY_LIMIT);
  bounded.evidence = bounded.evidence.slice(-STATUS_HISTORY_LIMIT);
  if (bounded.correctionHistory) {
    bounded.correctionHistory = bounded.correctionHistory.slice(-STATUS_HISTORY_LIMIT).map(item => ({
      ...item,
      evidence: item.evidence.slice(-STATUS_HISTORY_LIMIT),
      evidenceIds: item.evidenceIds.slice(-STATUS_HISTORY_LIMIT),
      paths: item.paths.slice(0, STATUS_PATH_LIMIT),
      pathEvidence: item.pathEvidence.slice(0, STATUS_PATH_LIMIT)
    }));
  }
  if (bounded.recoveryHistory) bounded.recoveryHistory = bounded.recoveryHistory.slice(-STATUS_HISTORY_LIMIT);
  if (bounded.split) bounded.split = { ...bounded.split, evidence: bounded.split.evidence.slice(-STATUS_HISTORY_LIMIT) };
  if (bounded.proposal) bounded.proposal = boundedStatusProposal(bounded.proposal);
  if (bounded.recovery?.proposal) {
    bounded.recovery = { ...bounded.recovery, proposal: boundedStatusProposal(bounded.recovery.proposal) };
  }
  if (bounded.recoveryHistory) {
    bounded.recoveryHistory = bounded.recoveryHistory.map(item => item.proposal
      ? { ...item, proposal: boundedStatusProposal(item.proposal) }
      : item);
  }
  return bounded;
}

function boundedStatusProposal(proposal: TaskProposalReference): TaskProposalReference {
  const summarize = (total: number) => ({
    total,
    returned: Math.min(total, STATUS_PATH_LIMIT),
    truncated: total > STATUS_PATH_LIMIT
  });
  const pathStates = proposal.pathStates;
  return {
    ...proposal,
    scopes: proposal.scopes.slice(0, STATUS_PATH_LIMIT),
    ownedPaths: proposal.ownedPaths.slice(0, STATUS_PATH_LIMIT),
    excludedForeignPaths: proposal.excludedForeignPaths.slice(0, STATUS_PATH_LIMIT),
    ...(pathStates === undefined ? {} : { pathStates: pathStates.slice(0, STATUS_PATH_LIMIT) }),
    pathSummary: {
      limit: STATUS_PATH_LIMIT,
      scopes: summarize(proposal.scopes.length),
      ownedPaths: summarize(proposal.ownedPaths.length),
      excludedForeignPaths: summarize(proposal.excludedForeignPaths.length),
      pathStates: {
        ...summarize(pathStates?.length || 0),
        present: pathStates !== undefined
      }
    }
  } as TaskProposalReference;
}

function taskStateCounts(tasks: readonly OrchestrationTask[]): Record<TaskState, number> {
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
  for (const task of tasks) counts[task.state] += 1;
  return counts;
}

function boundedStatusDelta(delta: CheckpointDelta): CheckpointDelta {
  return {
    changed: delta.changed,
    paths: delta.paths.slice(0, STATUS_PATH_LIMIT).map(item => ({
      path: item.path,
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      ...(item.staged ? { staged: item.staged } : {}),
      ...(item.unstaged ? { unstaged: item.unstaged } : {}),
      ...(item.committed ? { committed: item.committed } : {}),
      untracked: item.untracked,
      binary: item.binary,
      resolved: item.resolved
    })),
    counts: { ...delta.counts }
  };
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
    `Phase rotation: ${state.rotation ? `policy r${state.rotation.policy.revision}; session ${markdownCell(currentRotationPhase(state.rotation).rootSessionId)}; ${state.rotation.recommendations.length} recommendation(s); ${state.rotation.verifications.length} verified rotation(s)` : "not configured"}`,
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
        `- Planned delegation scopes: ${task.plannedScopes && task.plannedScopes.length > 0 ? task.plannedScopes.map(scope => `${scope.access} ${scope.kind} ${markdownCell(scope.path)}`).join(", ") : "—"}`,
        `- Token budget: ${task.budget ? `${task.budget.thresholdStatus}; policy r${task.budget.policy.revision}; soft ${task.budget.policy.softTotalTokens ?? "—"}; hard ${effectiveHardTotalTokens(task.budget) ?? "—"}; session ${markdownCell(task.budget.policy.rootSessionId)}; ${task.budget.observations.length} observation(s); ${task.budget.decisions.length} decision(s)` : "—"}`,
        `- Writer lease: ${task.lease ? `${task.lease.id} generation ${task.lease.generation}; owner ${markdownCell(task.lease.ownerThread)}; expires ${task.lease.expiresAt}` : task.preLease ? "migration required before further progress" : "—"}`,
        `- Writer reservation: ${task.leaseReservation ? `${task.leaseReservation.id} generation ${task.leaseReservation.generation}; write authorized no; expires ${task.leaseReservation.expiresAt}` : "—"}`,
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
  const legacyState = isLegacyOrchestrationStateShape(rawState) ? rawState : undefined;
  const schemaTwoState = isSchemaTwoOrchestrationStateShape(rawState) ? rawState : undefined;
  const schemaThreeState = isSchemaThreeOrchestrationStateShape(rawState) ? rawState : undefined;
  if (!legacyState && !schemaTwoState && !schemaThreeState) {
    invalidState("Synod state is not a valid schema-1, schema-2, or schema-3 orchestration record.");
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
  if (!last
    || (legacyState && !isLegacyOrchestrationEvent(rawLast))
    || (schemaTwoState && !isSchemaTwoOrchestrationEvent(rawLast))
    || (schemaThreeState && !isSchemaThreeOrchestrationEvent(rawLast))) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Orchestration migration requires a log ending in the same schema as canonical state.");
  }
  const expectedState = isLegacyOrchestrationEvent(rawLast)
    || isSchemaTwoOrchestrationEvent(rawLast)
    || isSchemaThreeOrchestrationEvent(rawLast) ? {
    ...rawLast.state,
    lastEvent: { sequence: rawLast.sequence, id: rawLast.id, hash: rawLast.eventHash }
  } : undefined;
  if (!expectedState || stableStringify(rawState) !== stableStringify(expectedState)) {
    throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Canonical state does not match the last append-only event before migration.", {
      details: { stateSequence: isRecord(rawState) && isRecord(rawState.lastEvent) ? rawState.lastEvent.sequence : undefined, eventSequence: isRecord(rawLast) ? rawLast.sequence : undefined }
    });
  }

  const timestamp = nowIso(dependencies.clock);
  const appended: Array<SchemaTwoOrchestrationEvent | SchemaThreeOrchestrationEvent | OrchestrationEvent> = [];
  let leaseBaselines: LeaseBaselinesLedger | undefined;
  let checkpointSnapshot: CheckpointSnapshot | undefined;
  let schemaTwoCore: SchemaTwoOrchestrationStateCore | undefined;
  if (legacyState) {
    leaseBaselines = createLeaseBaselinesLedger();
    checkpointSnapshot = await readCheckpointSnapshot(targetDirectory, legacyState.checkpoint);
    const migratedSchemaTwo = migrateLegacyStateCore(legacyState, leaseBaselinesReference(leaseBaselines), timestamp);
    schemaTwoCore = migratedSchemaTwo;
    const unsignedSchemaTwo: Omit<SchemaTwoOrchestrationEvent, "eventHash"> = {
      schemaVersion: SCHEMA_TWO_ORCHESTRATION_VERSION,
      sequence: last.sequence + 1,
      id: randomUUID(),
      timestamp,
      type: "orchestration.migrated",
      actor: "synod",
      checkpoint: migratedSchemaTwo.checkpoint,
      payload: {
        fromSchemaVersion: LEGACY_ORCHESTRATION_SCHEMA_VERSION,
        toSchemaVersion: SCHEMA_TWO_ORCHESTRATION_VERSION,
        preservedEventCount: events.length,
        preLeaseTasks: migratedSchemaTwo.taskOrder.filter(id => migratedSchemaTwo.tasks[id]?.preLease)
      },
      previousHash: last.eventHash,
      state: migratedSchemaTwo
    };
    appended.push({ ...unsignedSchemaTwo, eventHash: eventHash(unsignedSchemaTwo) });
  } else if (schemaTwoState) {
    const { lastEvent: _lastEvent, ...core } = schemaTwoState!;
    schemaTwoCore = core;
  }

  let schemaThreeCore: SchemaThreeOrchestrationStateCore;
  if (schemaThreeState) {
    const { lastEvent: _lastEvent, ...core } = schemaThreeState;
    schemaThreeCore = core;
  } else {
    if (!schemaTwoCore) {
      invalidState("Schema-3 migration requires a valid schema-2 predecessor.");
    }
    const prior = appended.at(-1) || rawLast as SchemaTwoOrchestrationEvent;
    schemaThreeCore = migrateSchemaTwoStateCore(schemaTwoCore, timestamp);
    const unsignedSchemaThree: Omit<SchemaThreeOrchestrationEvent, "eventHash"> = {
      schemaVersion: PREVIOUS_ORCHESTRATION_SCHEMA_VERSION,
      sequence: prior.sequence + 1,
      id: randomUUID(),
      timestamp,
      type: "orchestration.migrated",
      actor: "synod",
      checkpoint: schemaThreeCore.checkpoint,
      payload: {
        fromSchemaVersion: SCHEMA_TWO_ORCHESTRATION_VERSION,
        toSchemaVersion: PREVIOUS_ORCHESTRATION_SCHEMA_VERSION,
        preservedEventCount: events.length
      },
      previousHash: prior.eventHash,
      state: schemaThreeCore
    };
    appended.push({ ...unsignedSchemaThree, eventHash: eventHash(unsignedSchemaThree) });
  }

  const prior = appended.at(-1) || rawLast as SchemaThreeOrchestrationEvent;
  const nextCore = migrateSchemaThreeStateCore(schemaThreeCore, timestamp);
  const unsignedEvent: Omit<OrchestrationEvent, "eventHash"> = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence: prior.sequence + 1,
    id: randomUUID(),
    timestamp,
    type: "orchestration.migrated",
    actor: "synod",
    checkpoint: nextCore.checkpoint,
    payload: {
      fromSchemaVersion: PREVIOUS_ORCHESTRATION_SCHEMA_VERSION,
      toSchemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      preservedEventCount: events.length
    },
    previousHash: prior.eventHash,
    state: nextCore
  };
  const event: OrchestrationEvent = { ...unsignedEvent, eventHash: eventHash(unsignedEvent) };
  appended.push(event);
  const state = validateOrchestrationState({
    ...nextCore,
    lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
  });
  validateEventLog([...parsedEvents, ...appended]);
  const separator = rawEvents.endsWith("\n") ? "" : "\n";
  return {
    status: "migrated",
    files: new Map([
      [ORCHESTRATION_STATE_PATH, serializeJson(state)],
      [ORCHESTRATION_EVENTS_PATH, `${rawEvents}${separator}${appended.map(item => JSON.stringify(item)).join("\n")}\n`],
      [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(state)],
      ...(leaseBaselines ? [[LEASE_BASELINES_PATH, serializeLeaseBaselinesLedger(leaseBaselines)] as const] : []),
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

export function isConcurrencyPolicy(value: unknown): value is ConcurrencyPolicy {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.maxConcurrentSubagents === "number"
    && Number.isSafeInteger(value.maxConcurrentSubagents)
    && value.maxConcurrentSubagents > 0;
}

export function concurrencyPolicy(state: Pick<OrchestrationStateCore, "concurrency">): ConcurrencyPolicy {
  if (state.concurrency === undefined) {
    return { maxConcurrentSubagents: CONCURRENCY_POLICY_DEFAULTS.maxConcurrentSubagents };
  }
  return structuredClone(state.concurrency);
}

export interface ConcurrencyStatus {
  limit: number;
  activeWriters: number;
  activeReaders: number;
  availableSlots: number;
}

function isObserverAuthority(task: Pick<OrchestrationTask, "lease" | "leaseReservation">): boolean {
  return task.lease?.observer === true || task.leaseReservation?.observer === true;
}

export function concurrencyStatus(state: OrchestrationStateCore): ConcurrencyStatus {
  const policy = concurrencyPolicy(state);
  const authorities = taskList(state).filter(task => task.lease || task.leaseReservation);
  const activeWriters = authorities.filter(task => !isObserverAuthority(task)).length;
  const activeReaders = authorities.filter(isObserverAuthority).length;
  return {
    limit: policy.maxConcurrentSubagents,
    activeWriters,
    activeReaders,
    availableSlots: Math.max(policy.maxConcurrentSubagents - activeWriters, 0)
  };
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

function isSafeRepositoryPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeLeaseScopePath(value) === value;
  } catch {
    return false;
  }
}

function isTaskScopedPathEvidence(value: unknown): value is TaskScopedPathEvidence {
  return isRecord(value)
    && isSafeRepositoryPath(value.path)
    && (value.sourcePath === undefined || (isSafeRepositoryPath(value.sourcePath) && value.sourcePath !== value.path))
    && (value.status === undefined || (typeof value.status === "string" && value.status.length === 2))
    && typeof value.staged === "boolean"
    && typeof value.unstaged === "boolean"
    && typeof value.untracked === "boolean"
    && typeof value.resolved === "boolean";
}

function isTaskCorrectionRecord(value: unknown): value is TaskCorrectionRecord {
  return isRecord(value)
    && isNonNegativeInteger(value.round)
    && value.round > 0
    && isNonNegativeInteger(value.revision)
    && typeof value.reason === "string"
    && value.reason.length > 0
    && isStringArray(value.evidence)
    && value.evidence.length > 0
    && isStringArray(value.evidenceIds)
    && value.evidenceIds.length > 0
    && /^sha256:[0-9a-f]{64}$/.test(String(value.scopeFingerprint))
    && isStringArray(value.paths)
    && value.paths.every(isSafeRepositoryPath)
    && Array.isArray(value.pathEvidence)
    && value.pathEvidence.every(isTaskScopedPathEvidence)
    && typeof value.recordedAt === "string"
    && !Number.isNaN(Date.parse(value.recordedAt));
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

function isApprovalRole(value: unknown): value is Exclude<DelegationRole, "implementer"> {
  return value === "reviewer" || value === "verifier";
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "approved" || value === "rejected";
}

function isTaskApprovalRecord(value: unknown): value is TaskApprovalRecord {
  return isRecord(value)
    && isRecord(value.event)
    && isNonNegativeInteger(value.event.sequence)
    && value.event.sequence > 0
    && typeof value.event.id === "string"
    && value.event.id.length > 0
    && (value.event.previousHash === null || (typeof value.event.previousHash === "string" && value.event.previousHash.length > 0))
    && isApprovalRole(value.role)
    && isApprovalDecision(value.decision)
    && typeof value.ownerThread === "string"
    && value.ownerThread.trim().length > 0
    && isNonNegativeInteger(value.revision)
    && typeof value.proposalBundleId === "string"
    && value.proposalBundleId.trim().length > 0
    && isStringArray(value.evidence)
    && value.evidence.length > 0
    && value.evidence.every(item => item.trim().length > 0)
    && typeof value.actor === "string"
    && value.actor.trim().length > 0
    && typeof value.recordedAt === "string"
    && Number.isFinite(Date.parse(value.recordedAt))
    && (value.consumedAt === undefined
      || (typeof value.consumedAt === "string"
        && Number.isFinite(Date.parse(value.consumedAt))
        && Date.parse(value.consumedAt) >= Date.parse(value.recordedAt)));
}

function isOrchestrationTask(value: unknown): value is OrchestrationTask {
  if (!isRecord(value) || !isRecord(value.acceptance) || !isRecord(value.verification)) return false;
  const correctionHistory = value.correctionHistory;
  const approvals = value.approvals;
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
    && (value.plannedScopes === undefined || isPlannedLeaseScopes(value.plannedScopes))
    && (value.lease === undefined || isTaskLease(value.lease))
    && (value.leaseReservation === undefined || isTaskLeaseReservation(value.leaseReservation))
    && (value.proposal === undefined || isTaskProposalReference(value.proposal))
    && (value.approvalPolicy === undefined || value.approvalPolicy === "typed")
    && (approvals === undefined || (Array.isArray(approvals)
      && approvals.every(isTaskApprovalRecord)
      && approvals.every((item, index) => index === 0 || item.event.sequence > approvals[index - 1]!.event.sequence)))
    && (value.recovery === undefined || isTaskRecovery(value.recovery))
    && (value.recoveryHistory === undefined || (Array.isArray(value.recoveryHistory)
      && value.recoveryHistory.every(item => isTaskRecovery(item) && item.status !== "PENDING")))
    && (value.split === undefined || isTaskSplit(value.split))
    && (value.splitFrom === undefined || typeof value.splitFrom === "string")
    && (value.budget === undefined || isTaskBudget(value.budget))
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
    && (correctionHistory === undefined || (
      Array.isArray(correctionHistory)
      && correctionHistory.every(isTaskCorrectionRecord)
      && correctionHistory.every((item, index) => index === 0 || item.round > correctionHistory[index - 1]!.round)
    ))
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && (value.blocker === undefined || typeof value.blocker === "string")
    && (value.blockedFrom === undefined || isTaskState(value.blockedFrom))
    && (value.supersededReason === undefined || typeof value.supersededReason === "string")
    && (value.preLease === undefined || value.preLease === true);
}

function isSchemaTwoOrchestrationTask(value: unknown): value is SchemaTwoOrchestrationTask {
  return isRecord(value) && value.budget === undefined && value.leaseReservation === undefined && isOrchestrationTask(value);
}

function isSchemaThreeOrchestrationTask(value: unknown): value is SchemaThreeOrchestrationTask {
  return isRecord(value) && value.leaseReservation === undefined && isOrchestrationTask(value);
}

function isLegacyOrchestrationTask(value: unknown): value is LegacyOrchestrationTask {
  if (!isRecord(value) || !isNonNegativeInteger(value.correctionRound)) return false;
  return value.correctionPolicy === undefined
    && value.leaseGeneration === undefined
      && value.lease === undefined
      && value.leaseReservation === undefined
    && value.proposal === undefined
    && value.recovery === undefined
    && value.recoveryHistory === undefined
    && value.split === undefined
    && value.splitFrom === undefined
    && value.preLease === undefined
    && value.budget === undefined
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

function migrateLegacyTask(task: LegacyOrchestrationTask): SchemaTwoOrchestrationTask {
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
): SchemaTwoOrchestrationStateCore {
  return {
    schemaVersion: SCHEMA_TWO_ORCHESTRATION_VERSION,
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

function migrateSchemaTwoStateCore(
  state: SchemaTwoOrchestrationStateCore,
  timestamp = state.updatedAt
): SchemaThreeOrchestrationStateCore {
  return {
    ...state,
    schemaVersion: PREVIOUS_ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    updatedAt: timestamp,
    tasks: Object.fromEntries(state.taskOrder.map(id => [id, { ...state.tasks[id]! }]))
  };
}

function migrateSchemaThreeStateCore(
  state: SchemaThreeOrchestrationStateCore,
  timestamp = state.updatedAt
): OrchestrationStateCore {
  return {
    ...state,
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    updatedAt: timestamp,
    tasks: Object.fromEntries(state.taskOrder.map(id => [id, { ...state.tasks[id]! }]))
  };
}

function isSchemaTwoOrchestrationStateCoreShape(value: unknown): value is SchemaTwoOrchestrationStateCore {
  return isRecord(value)
    && value.schemaVersion === SCHEMA_TWO_ORCHESTRATION_VERSION
    && typeof value.templateVersion === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isGitCheckpoint(value.checkpoint)
    && isLeaseBaselineReference(value.leaseBaselines)
    && isStringArray(value.taskOrder)
    && isRecord(value.tasks)
    && new Set(value.taskOrder).size === value.taskOrder.length
    && Object.keys(value.tasks).length === value.taskOrder.length
    && value.taskOrder.every(id => Object.hasOwn(value.tasks as object, id))
    && Object.values(value.tasks).every(isSchemaTwoOrchestrationTask)
    && isNonNegativeInteger(value.evidenceCounter);
}

function isSchemaThreeOrchestrationStateCoreShape(value: unknown): value is SchemaThreeOrchestrationStateCore {
  return isRecord(value)
    && value.schemaVersion === PREVIOUS_ORCHESTRATION_SCHEMA_VERSION
    && typeof value.templateVersion === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isGitCheckpoint(value.checkpoint)
    && isLeaseBaselineReference(value.leaseBaselines)
    && isStringArray(value.taskOrder)
    && isRecord(value.tasks)
    && new Set(value.taskOrder).size === value.taskOrder.length
    && Object.keys(value.tasks).length === value.taskOrder.length
    && value.taskOrder.every(id => Object.hasOwn(value.tasks as object, id))
    && Object.values(value.tasks).every(isSchemaThreeOrchestrationTask)
    && isNonNegativeInteger(value.evidenceCounter)
    && (value.rotation === undefined || isProjectRotation(value.rotation));
}

function isSchemaThreeOrchestrationStateShape(value: unknown): value is SchemaThreeOrchestrationState {
  return isSchemaThreeOrchestrationStateCoreShape(value)
    && isRecord(value)
    && isRecord(value.lastEvent)
    && isNonNegativeInteger(value.lastEvent.sequence)
    && typeof value.lastEvent.id === "string"
    && typeof value.lastEvent.hash === "string";
}

function isSchemaTwoOrchestrationStateShape(value: unknown): value is SchemaTwoOrchestrationState {
  return isSchemaTwoOrchestrationStateCoreShape(value)
    && isRecord(value)
    && isRecord(value.lastEvent)
    && isNonNegativeInteger(value.lastEvent.sequence)
    && typeof value.lastEvent.id === "string"
    && typeof value.lastEvent.hash === "string";
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
    && isNonNegativeInteger(value.evidenceCounter)
    && (value.rotation === undefined || isProjectRotation(value.rotation))
    && (value.concurrency === undefined || isConcurrencyPolicy(value.concurrency));
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

function validateApprovalLaneScopes(
  task: OrchestrationTask,
  lease: Pick<TaskLease | TaskLeaseReservation, "role" | "observer" | "scopes">
): void {
  const role = lease.role;
  if (role !== "reviewer" && role !== "verifier") return;
  const proposal = task.proposal;
  if (!proposal || proposal.status !== "SEALED" || proposal.revision !== task.revision) {
    invalidState(`Task ${task.id} ${role} authority is missing its exact sealed proposal.`, {
      taskId: task.id,
      role,
      revision: task.revision,
      proposal: proposal ?? null
    });
  }
  const expected = [...proposal.ownedPaths].sort(compareCheckpointPaths);
  const actual = lease.scopes
    .filter(scope => scope.access === "read" && scope.kind === "file")
    .map(scope => scope.path)
    .sort(compareCheckpointPaths);
  if (lease.observer !== true
    || lease.scopes.some(scope => scope.access !== "read" || scope.kind !== "file")
    || actual.length !== expected.length
    || actual.some((item, index) => item !== expected[index])) {
    invalidState(`Task ${task.id} ${role} authority must exactly cover proposal-owned read-file scopes.`, {
      taskId: task.id,
      role,
      expectedPaths: expected,
      actualScopes: lease.scopes
    });
  }
}

export function validateOrchestrationState(
  value: unknown,
  options: { pendingEventSequence?: number } = {}
): OrchestrationState {
  if (!isRecord(value)) invalidState("Synod state must be a JSON object.");
  if (value.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
    invalidState(`Unsupported orchestration state schema: ${value.schemaVersion}`, { supported: ORCHESTRATION_SCHEMA_VERSION });
  }
  if (!isOrchestrationStateShape(value)) invalidState("Synod state is missing required canonical fields.");
  const state = value;

  if (state.rotation) {
    const policies = [...state.rotation.policyHistory, state.rotation.policy];
    let priorRecordedAt = 0;
    for (const policy of policies) {
      const recordedAt = Date.parse(policy.recordedAt);
      if (recordedAt < priorRecordedAt) invalidState("Project rotation policies are not chronologically ordered.");
      priorRecordedAt = recordedAt;
    }
    const verified = new Set(state.rotation.verifications.map(item => `${item.recommendation.sequence}:${item.recommendation.id}`));
    const pending = state.rotation.recommendations.filter(item => !verified.has(`${item.event.sequence}:${item.event.id}`));
    if (pending.length > 1 || (pending[0] && pending[0].policyRevision !== state.rotation.policy.revision)) {
      invalidState("Project rotation has an invalid pending recommendation history.");
    }
    for (const recommendation of state.rotation.recommendations) {
      if (recommendation.metrics.some(metric => metric.triggered !== recommendation.reasons.includes(metric.name))) {
        invalidState("Project rotation recommendation reasons do not match their triggering metrics.");
      }
      if (recommendation.completedTaskIds.some((id, index) => index > 0 && id <= recommendation.completedTaskIds[index - 1]!)) {
        invalidState("Project rotation completed-task evidence is not uniquely ordered.");
      }
    }
  }

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
    if (task.budget) {
      const policies = [...task.budget.policyHistory, task.budget.policy];
      const byRevision = new Map(policies.map(policy => [policy.revision, policy]));
      let priorObservationSequence = 0;
      const totals = new Map<number, number>();
      for (const observation of task.budget.observations) {
        const policy = byRevision.get(observation.policyRevision);
        if (!policy
          || observation.rootSessionId !== policy.rootSessionId
          || stableStringify(observation.startEvent) !== stableStringify(policy.startEvent)
          || observation.event.sequence <= priorObservationSequence
          || Date.parse(observation.capturedAt) < Date.parse(policy.recordedAt)
          || observation.totalTokens < (totals.get(observation.policyRevision) || 0)) {
          invalidState(`Task ${id} budget observation history is invalid.`, { taskId: id });
        }
        priorObservationSequence = observation.event.sequence;
        totals.set(observation.policyRevision, observation.totalTokens);
      }
      for (const decision of task.budget.decisions) {
        const observation = task.budget.observations.find(item =>
          item.event.sequence === decision.observation.sequence && item.event.id === decision.observation.id
        );
        if (!observation
          || decision.policyRevision !== observation.policyRevision
          || decision.event.sequence <= observation.event.sequence
          || Date.parse(decision.recordedAt) < Date.parse(observation.capturedAt)) {
          invalidState(`Task ${id} budget decision history is invalid.`, { taskId: id });
        }
      }
    }
    if (task.lease && (
      task.lease.generation !== task.leaseGeneration
      || task.lease.taskId !== task.id
      || task.lease.taskRevision !== task.revision
      || task.lease.executor !== task.executor
    )) {
      invalidState(`Task ${id} lease does not match its canonical task generation, revision, or executor.`, { taskId: id });
    }
    if (task.leaseReservation && (
      task.leaseReservation.generation !== task.leaseGeneration
      || task.leaseReservation.taskId !== task.id
      || task.leaseReservation.taskRevision !== task.revision
      || task.leaseReservation.executor !== task.executor
    )) {
      invalidState(`Task ${id} lease reservation does not match its canonical task generation, revision, or executor.`, { taskId: id });
    }
    if (task.lease && task.leaseReservation) {
      invalidState(`Task ${id} cannot hold both a lease reservation and an active writer lease.`, { taskId: id });
    }
    if (task.lease?.role === "reviewer" && task.state !== "REVIEW") {
      invalidState(`Task ${id} reviewer lease is not bound to REVIEW.`, { taskId: id, state: task.state });
    }
    if (task.lease?.role === "verifier" && task.state !== "ACCEPTED") {
      invalidState(`Task ${id} verifier lease is not bound to ACCEPTED.`, { taskId: id, state: task.state });
    }
    if (task.leaseReservation?.role === "reviewer" && task.state !== "REVIEW") {
      invalidState(`Task ${id} reviewer reservation is not bound to REVIEW.`, { taskId: id, state: task.state });
    }
    if (task.leaseReservation?.role === "verifier" && task.state !== "ACCEPTED") {
      invalidState(`Task ${id} verifier reservation is not bound to ACCEPTED.`, { taskId: id, state: task.state });
    }
    if (task.lease) validateApprovalLaneScopes(task, task.lease);
    if (task.leaseReservation) validateApprovalLaneScopes(task, task.leaseReservation);
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
      if (task.recovery.status === "PENDING" && (task.recovery.proposal || task.lease || task.leaseReservation)) {
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
    if (task.leaseReservation && !["READY", "REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)) {
      invalidState(`Task ${id} holds a lease reservation in an ineligible state.`, { taskId: id, state: task.state });
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
    if (task.approvals) {
      const approvalKeys = new Set<string>();
      const approvalEvents = new Set<string>();
      for (const approval of task.approvals) {
        const key = `${approval.role}:${approval.revision}:${approval.proposalBundleId}`;
        const eventKey = `${approval.event.sequence}:${approval.event.id}`;
        if (approvalKeys.has(key) || approvalEvents.has(eventKey)
          || (approval.event.sequence > state.lastEvent.sequence && approval.event.sequence !== options.pendingEventSequence)) {
          invalidState(`Task ${id} contains duplicate or stale approval records.`, { taskId: id, key, event: approval.event });
        }
        if (!task.proposal
          || approval.revision !== task.revision
          || approval.proposalBundleId !== task.proposal.bundleId) {
          invalidState(`Task ${id} approval does not match its current proposal bundle.`, { taskId: id, approval });
        }
        approvalKeys.add(key);
        approvalEvents.add(eventKey);
      }
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

function isSchemaTwoOrchestrationEvent(value: unknown): value is SchemaTwoOrchestrationEvent {
  return isRecord(value)
    && value.schemaVersion === SCHEMA_TWO_ORCHESTRATION_VERSION
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
    && isSchemaTwoOrchestrationStateCoreShape(value.state)
    && typeof value.eventHash === "string";
}

function isSchemaThreeOrchestrationEvent(value: unknown): value is SchemaThreeOrchestrationEvent {
  return isRecord(value)
    && value.schemaVersion === PREVIOUS_ORCHESTRATION_SCHEMA_VERSION
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
    && isSchemaThreeOrchestrationStateCoreShape(value.state)
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
  let activeSchema = 1;
  let schemaOneSeen = false;
  let schemaTwoSeen = false;
  let schemaThreeSeen = false;
  let schemaFourSeen = false;
  let oneToTwoSeen = false;
  let twoToThreeSeen = false;
  let threeToFourSeen = false;
  const emptyLeaseBaselines = leaseBaselinesReference(createLeaseBaselinesLedger());
  const validated: OrchestrationEvent[] = [];
  const bySequence = new Map<number, OrchestrationEvent>();
  for (const [index, event] of events.entries()) {
    const legacy = isLegacyOrchestrationEvent(event);
    const schemaTwo = isSchemaTwoOrchestrationEvent(event);
    const schemaThree = isSchemaThreeOrchestrationEvent(event);
    const current = isOrchestrationEvent(event);
    const schema = legacy ? 1 : schemaTwo ? 2 : schemaThree ? 3 : current ? 4 : 0;
    const migrated = isRecord(event) && event.type === "orchestration.migrated" && isRecord(event.payload);
    const migrationPayload = migrated ? event.payload as Record<string, unknown> : undefined;
    if (index === 0 && !migrated && schema > 0) activeSchema = schema;
    const validBoundary = migrated && (
      (schema === 2 && activeSchema === 1 && migrationPayload?.fromSchemaVersion === 1 && migrationPayload.toSchemaVersion === 2 && !oneToTwoSeen)
      || (schema === 3 && activeSchema === 2 && migrationPayload?.fromSchemaVersion === 2 && migrationPayload.toSchemaVersion === 3 && !twoToThreeSeen)
      || (schema === 4 && activeSchema === 3 && migrationPayload?.fromSchemaVersion === 3 && migrationPayload.toSchemaVersion === 4 && !threeToFourSeen)
    );
    const validContinuation = schema === activeSchema && !migrated;
    if ((!legacy && !schemaTwo && !schemaThree && !current) || event.sequence !== index + 1
      || event.previousHash !== previousHash || event.eventHash !== eventHash(event)
      || (!validBoundary && !validContinuation)) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log failed sequence or hash-chain validation.", {
        details: { sequence: isRecord(event) ? event.sequence : undefined, expectedSequence: index + 1 }
      });
    }
    if (validBoundary) {
      if (schema === 2) oneToTwoSeen = true;
      if (schema === 3) twoToThreeSeen = true;
      if (schema === 4) threeToFourSeen = true;
      activeSchema = schema;
    }
    if (current) {
      schemaFourSeen = true;
      validateOrchestrationState({
        ...event.state,
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    } else if (schemaThree) {
      schemaThreeSeen = true;
      validateOrchestrationState({
        ...migrateSchemaThreeStateCore(event.state),
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    } else if (schemaTwo) {
      schemaTwoSeen = true;
      validateOrchestrationState({
        ...migrateSchemaThreeStateCore(migrateSchemaTwoStateCore(event.state)),
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    } else {
      schemaOneSeen = true;
      validateOrchestrationState({
        ...migrateSchemaThreeStateCore(migrateSchemaTwoStateCore(migrateLegacyStateCore(event.state, emptyLeaseBaselines))),
        lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
      });
    }
    bySequence.set(event.sequence, event as unknown as OrchestrationEvent);
    if (current) {
      if (event.state.rotation) {
        for (const policy of [...event.state.rotation.policyHistory, event.state.rotation.policy]) {
          const start = bySequence.get(policy.startEvent.sequence);
          if (!start || start.id !== policy.startEvent.id || start.eventHash !== policy.startEvent.hash
            || policy.startEvent.sequence >= event.sequence) {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A rotation policy references a stale or non-canonical start event.", {
              details: { policyRevision: policy.revision }
            });
          }
        }
        for (const recommendation of event.state.rotation.recommendations) {
          const prepared = bySequence.get(recommendation.event.sequence);
          const handoff = bySequence.get(recommendation.handoff.event.sequence);
          const phaseStart = bySequence.get(recommendation.startEvent.sequence);
          const phaseMatches = phaseStart && phaseStart.id === recommendation.startEvent.id
            && ("hash" in recommendation.startEvent
              ? phaseStart.eventHash === recommendation.startEvent.hash
              : phaseStart.previousHash === recommendation.startEvent.previousHash);
          if (!prepared || prepared.id !== recommendation.event.id
            || prepared.previousHash !== recommendation.event.previousHash
            || prepared.type !== "project.rotation-prepared"
            || !handoff || handoff.id !== recommendation.handoff.event.id
            || handoff.eventHash !== recommendation.handoff.event.hash
            || recommendation.handoff.event.sequence >= recommendation.event.sequence
            || !phaseMatches) {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A phase-rotation recommendation identity is not canonical.", {
              details: { sequence: recommendation.event.sequence }
            });
          }
        }
        for (const verification of event.state.rotation.verifications) {
          const verifiedEvent = bySequence.get(verification.event.sequence);
          const recommendation = bySequence.get(verification.recommendation.sequence);
          if (!verifiedEvent || verifiedEvent.id !== verification.event.id
            || verifiedEvent.previousHash !== verification.event.previousHash
            || verifiedEvent.type !== "project.rotation-verified"
            || !recommendation || recommendation.id !== verification.recommendation.id
            || recommendation.previousHash !== verification.recommendation.previousHash
            || recommendation.type !== "project.rotation-prepared"
            || Date.parse(verification.newRootSessionCreatedAt) <= Date.parse(recommendation.timestamp)) {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A phase-rotation verification identity is not canonical.", {
              details: { sequence: verification.event.sequence }
            });
          }
        }
      }
      for (const task of Object.values(event.state.tasks)) {
        if (!task.budget) continue;
        for (const policy of [...task.budget.policyHistory, task.budget.policy]) {
          const start = bySequence.get(policy.startEvent.sequence);
          if (!start || start.id !== policy.startEvent.id || start.eventHash !== policy.startEvent.hash
            || policy.startEvent.sequence >= event.sequence) {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A task budget references a stale or non-canonical start event.", {
              details: { taskId: task.id, policyRevision: policy.revision }
            });
          }
        }
        for (const observation of task.budget.observations) {
          const observedEvent = bySequence.get(observation.event.sequence);
          if (!observedEvent || observedEvent.id !== observation.event.id
            || observedEvent.previousHash !== observation.event.previousHash
            || observedEvent.type !== "task.budget-observed") {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A task budget observation identity is not canonical.", {
              details: { taskId: task.id, sequence: observation.event.sequence }
            });
          }
        }
        for (const decision of task.budget.decisions) {
          const decisionEvent = bySequence.get(decision.event.sequence);
          if (!decisionEvent || decisionEvent.id !== decision.event.id
            || decisionEvent.previousHash !== decision.event.previousHash
            || decisionEvent.type !== "task.budget-decided") {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A task budget decision identity is not canonical.", {
              details: { taskId: task.id, sequence: decision.event.sequence }
            });
          }
        }
      }
      for (const task of Object.values(event.state.tasks)) {
        for (const approval of task.approvals || []) {
          const approvalEvent = bySequence.get(approval.event.sequence);
          if (!approvalEvent
            || approvalEvent.id !== approval.event.id
            || approvalEvent.previousHash !== approval.event.previousHash
            || approvalEvent.type !== "task.approval-recorded"
            || approvalEvent.taskId !== task.id
            || approvalEvent.actor !== approval.actor
            || approvalEvent.timestamp !== approval.recordedAt
            || approvalEvent.revision !== approval.revision
            || !isRecord(approvalEvent.payload.approval)
            || approvalEvent.payload.approval.role !== approval.role
            || approvalEvent.payload.approval.decision !== approval.decision
            || approvalEvent.payload.approval.ownerThread !== approval.ownerThread
            || approvalEvent.payload.approval.revision !== approval.revision
            || approvalEvent.payload.approval.proposalBundleId !== approval.proposalBundleId
            || approvalEvent.payload.approval.actor !== approval.actor
            || approvalEvent.payload.approval.recordedAt !== approval.recordedAt
            || stableStringify(approvalEvent.payload.approval.evidence) !== stableStringify(approval.evidence)
            || stableStringify(approvalEvent.payload.approval.event) !== stableStringify(approval.event)) {
            throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "A task approval identity is not canonical.", {
              details: { taskId: task.id, event: approval.event }
            });
          }
        }
      }
    }
    previousHash = event.eventHash;
    validated.push(event as unknown as OrchestrationEvent);
  }
  if (schemaOneSeen && (schemaThreeSeen || schemaFourSeen) && !schemaTwoSeen) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log skipped orchestration schema 2.");
  }
  if (schemaTwoSeen && schemaFourSeen && !schemaThreeSeen) {
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log skipped orchestration schema 3.");
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
      ...(task.leaseReservation ? [{
        id: task.leaseReservation.id,
        generation: task.leaseReservation.generation,
        taskRevision: task.leaseReservation.taskRevision,
        reference: task.leaseReservation.baseline
      }] : []),
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

async function validateOrchestrationProposalArtifactsFromCanonical(
  targetDirectory: string,
  canonical: Awaited<ReturnType<typeof readOrchestrationRaw>>
): Promise<{
  sealedProposals: number;
  verifiedBundles: number;
}> {
  const recovery = await import("./recovery.js");
    const verifiedPaths = new Map<string, Awaited<ReturnType<typeof recovery.verifyRecoveryBundle>>>();
    let sealedProposals = 0;
    for (const task of taskList(canonical.state)) {
      const references: Array<{ proposal: TaskProposalReference; requiresBaseline: boolean }> = [
        ...(task.proposal ? [{ proposal: task.proposal, requiresBaseline: proposalReservesPaths(task) }] : []),
        ...(task.recovery?.proposal ? [{
          proposal: task.recovery.proposal,
          requiresBaseline: task.recovery.status === "PENDING"
        }] : []),
        ...(task.recoveryHistory || []).flatMap(item => item.proposal
          ? [{ proposal: item.proposal, requiresBaseline: false }]
          : [])
      ];
      for (const reference of references) {
        const { proposal } = reference;
        sealedProposals += 1;
        const baseline = canonical.leaseBaselines.baselines.find(item =>
          item.taskId === task.id
          && item.leaseId === proposal.leaseId
          && item.generation === proposal.generation
          && item.taskRevision === proposal.baseRevision
        );
        if (!baseline && reference.requiresBaseline) {
          throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Task ${task.id} proposal baseline is missing.`, {
            details: { taskId: task.id, leaseId: proposal.leaseId, generation: proposal.generation }
          });
        }
        let verified = verifiedPaths.get(proposal.path);
        if (verified && verified.bundleId !== proposal.bundleId) {
          throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "One proposal path has conflicting canonical bundle identities.", {
            details: { path: proposal.path, firstBundleId: verified.bundleId, secondBundleId: proposal.bundleId }
          });
        }
        if (!verified) {
          verified = await recovery.verifyRecoveryBundle({
            bundle: resolveProjectPath(targetDirectory, proposal.path)
          });
          verifiedPaths.set(proposal.path, verified);
        }
        const expectedIdentity = {
          taskId: task.id,
          leaseId: proposal.leaseId,
          generation: proposal.generation,
          baseRevision: proposal.baseRevision,
          revision: proposal.revision,
          scopes: proposal.scopes,
          ownedPaths: proposal.ownedPaths
        };
        const manifestIdentity = verified.manifest.proposal && {
          taskId: verified.manifest.proposal.taskId,
          leaseId: verified.manifest.proposal.leaseId,
          generation: verified.manifest.proposal.generation,
          baseRevision: verified.manifest.proposal.baseRevision,
          revision: verified.manifest.proposal.revision,
          scopes: verified.manifest.proposal.scopes,
          ownedPaths: verified.manifest.proposal.ownedPaths
        };
        if (verified.bundleId !== proposal.bundleId
          || verified.manifest.checkpoint.fingerprint !== proposal.fingerprint
          || verified.manifest.checkpoint.snapshotHash !== proposal.snapshotHash
          || stableStringify(manifestIdentity) !== stableStringify(expectedIdentity)
          || (baseline && (
            verified.manifest.source.branch !== baseline.snapshot.branch
            || verified.manifest.source.head !== baseline.snapshot.head
            || verified.manifest.proposal?.baseline.snapshotHash !== baseline.snapshot.contentHash
            || verified.manifest.proposal?.baseline.worktreeFingerprint !== baseline.snapshot.worktreeFingerprint
          ))) {
          throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} sealed proposal artifact is invalid.`, {
            details: { taskId: task.id, path: proposal.path, bundleId: proposal.bundleId }
          });
        }
      }
    }
  return { sealedProposals, verifiedBundles: verifiedPaths.size };
}

export async function validateOrchestrationProposalArtifacts({
  directory = ".",
  readOnly = false
}: { directory?: string; readOnly?: boolean } = {}): Promise<{
  sealedProposals: number;
  verifiedBundles: number;
}> {
  const targetDirectory = path.resolve(directory);
  return await withOrchestrationSnapshot(
    targetDirectory,
    canonical => validateOrchestrationProposalArtifactsFromCanonical(targetDirectory, canonical),
    { readOnly }
  );
}

export async function withOrchestrationSnapshot<Result>(
  targetDirectory: string,
  action: (snapshot: {
    state: OrchestrationState;
    events: OrchestrationEvent[];
    leaseBaselines: LeaseBaselinesLedger;
    snapshot?: CheckpointSnapshot;
  }) => Promise<Result>,
  { readOnly = false }: { readOnly?: boolean } = {}
): Promise<Result> {
  const release = await acquireLock(targetDirectory);
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
    const mutationIdentity: BudgetMutationIdentity = {
      sequence: current.lastEvent.sequence + 1,
      id: randomUUID(),
      previousHash: current.lastEvent.hash
    };
    const reducerResult = await reducer(draft, {
      timestamp,
      checkpoint,
      snapshot: captured.snapshot,
      ...(acknowledgedSnapshot ? { acknowledgedSnapshot } : {}),
      leaseBaselines: currentLeaseBaselines,
      nextSequence: mutationIdentity.sequence,
      event: mutationIdentity
    }) || {};
    draft.updatedAt = timestamp;
    if (reducerResult.updateCheckpoint) draft.checkpoint = checkpoint;
    if (reducerResult.leaseBaselines) {
      draft.leaseBaselines = leaseBaselinesReference(reducerResult.leaseBaselines);
    }
    validateOrchestrationState(draft, { pendingEventSequence: mutationIdentity.sequence });

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
    const { event, state } = buildEvent(current, stateCore(draft), type, eventMetadata, { id: mutationIdentity.id });
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
  /** Canonical planned scopes, useful to API callers that already have lanes. */
  plannedScopes?: unknown[];
  plannedRead?: unknown[];
  plannedWrite?: unknown[];
  plannedReadTree?: unknown[];
  plannedWriteTree?: unknown[];
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
  plannedScopes,
  plannedRead = [],
  plannedWrite = [],
  plannedReadTree = [],
  plannedWriteTree = [],
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
  const laneValues = [...plannedRead, ...plannedWrite, ...plannedReadTree, ...plannedWriteTree];
  if (plannedScopes !== undefined && laneValues.length > 0) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, "Task planned scopes must use either canonical scopes or explicit lane options, not both.");
  }
  const normalizedPlannedScopes = plannedScopes !== undefined
    ? normalizePlannedLeaseScopes(plannedScopes)
    : laneValues.length > 0
      ? normalizeLeaseScopes({
          read: plannedRead,
          write: plannedWrite,
          readTree: plannedReadTree,
          writeTree: plannedWriteTree
        })
      : undefined;
  const targetDirectory = path.resolve(directory);

  return commitMutation(targetDirectory, "task.created", { actor, taskId }, async (state, context) => {
    if (state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_EXISTS, `Task ${taskId} already exists.`, { details: { taskId } });
    for (const dependency of dependenciesList) {
      if (!state.tasks[dependency] || dependency === taskId) {
        throw new SynodError(ERROR_CODES.TASK_INVALID, `Task ${taskId} has an unknown or self dependency: ${dependency}`, {
          details: { taskId, dependency }
        });
      }
    }
    if (normalizedPlannedScopes) await validateLeaseScopeFilesystemPaths(targetDirectory, normalizedPlannedScopes);
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
      ...(normalizedPlannedScopes === undefined ? {} : { plannedScopes: normalizedPlannedScopes }),
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

function budgetEventIdentity(events: OrchestrationEvent[], selector: string): CanonicalEventIdentity {
  const normalized = String(selector || "").trim();
  const sequence = /^[1-9]\d*$/.test(normalized) ? Number(normalized) : undefined;
  const matches = events.filter(event => sequence === undefined ? event.id === normalized : event.sequence === sequence);
  if (matches.length !== 1) {
    throw new SynodError(ERROR_CODES.BUDGET_INVALID, `Budget start event did not resolve exactly once: ${normalized}.`, {
      details: { selector: normalized, matches: matches.length }
    });
  }
  const event = matches[0]!;
  return { sequence: event.sequence, id: event.id, hash: event.eventHash };
}

function budgetEvidence(values: unknown[]): string[] {
  const evidence = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  if (evidence.length === 0) throw new SynodError(ERROR_CODES.BUDGET_INVALID, "Budget changes require at least one evidence reference.");
  return evidence;
}

function budgetLimit(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SynodError(ERROR_CODES.BUDGET_INVALID, `${name} must be a positive integer.`);
  }
  return parsed;
}

function assertCanonicalState(
  state: OrchestrationState,
  expected: OrchestrationLastEvent,
  taskId: string,
  policyRevision?: number
): OrchestrationTask {
  if (state.lastEvent.sequence !== expected.sequence || state.lastEvent.id !== expected.id || state.lastEvent.hash !== expected.hash) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} budget input was computed from stale canonical state.`, {
      details: { taskId, expected, actual: state.lastEvent }
    });
  }
  const task = state.tasks[taskId];
  if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  if (policyRevision !== undefined && task.budget?.policy.revision !== policyRevision) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} budget policy changed before the operation committed.`, {
      details: { taskId, expectedPolicyRevision: policyRevision, actualPolicyRevision: task.budget?.policy.revision }
    });
  }
  return task;
}

export interface SetTaskBudgetPolicyOptions {
  directory?: string;
  id?: string;
  rootSessionId?: string;
  startEvent?: string;
  softTotalTokens?: number;
  hardTotalTokens?: number;
  reason?: string;
  evidence?: unknown[];
  actor?: string;
  replace?: boolean;
}

export async function setTaskBudgetPolicy({
  directory = ".",
  id,
  rootSessionId,
  startEvent,
  softTotalTokens,
  hardTotalTokens,
  reason,
  evidence = [],
  actor = "supervisor",
  replace = false
}: SetTaskBudgetPolicyOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const taskId = taskIdValue(id);
  const session = String(rootSessionId || "").trim();
  const explanation = String(reason || "").trim();
  const principal = String(actor || "").trim();
  const soft = budgetLimit(softTotalTokens, "Soft token limit");
  const hard = budgetLimit(hardTotalTokens, "Hard token limit");
  const evidenceReferences = budgetEvidence(evidence);
  if (!session || !String(startEvent || "").trim() || !explanation || !principal || (soft === undefined && hard === undefined)
    || (soft !== undefined && hard !== undefined && soft >= hard)) {
    throw new SynodError(ERROR_CODES.BUDGET_INVALID, "Budget policy requires a session, exact start event, actor, reason, evidence, and valid soft/hard limits.");
  }
  const canonical = await readOrchestration(targetDirectory);
  if (!canonical.state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  const start = budgetEventIdentity(canonical.events, String(startEvent));
  const splitFrom = canonical.state.tasks[taskId]!.splitFrom;
  const splitBoundary = splitFrom ? canonical.events.filter(event => event.type === "task.split"
    && event.taskId === splitFrom
    && Array.isArray(event.payload.replacements)
    && event.payload.replacements.includes(taskId)).at(-1) : undefined;
  const expected = canonical.state.lastEvent;
  const type = replace ? "task.budget-replaced" : "task.budget-set";
  return commitMutation(targetDirectory, type, { actor: principal, taskId }, (state, context) => {
    const task = assertCanonicalState(state, expected, taskId);
    if (replace && !task.budget) throw new SynodError(ERROR_CODES.BUDGET_NOT_CONFIGURED, `Task ${taskId} has no budget to replace.`);
    if (!replace && task.budget) throw new SynodError(ERROR_CODES.BUDGET_INVALID, `Task ${taskId} already has a budget; use an explicit replacement.`);
    const structuralDecision = latestBudgetDecision(task);
    const authorizedPolicyReplacement = structuralDecision?.action === "rotate"
      || Boolean(task.splitFrom && structuralDecision?.action === "split");
    if (task.budget?.thresholdStatus === "decision-required" && !authorizedPolicyReplacement) {
      throw new SynodError(ERROR_CODES.BUDGET_DECISION_REQUIRED, `Task ${taskId} requires a decision for its latest hard-budget observation before policy replacement.`);
    }
    if (task.budget?.thresholdStatus === "decision-required" && structuralDecision?.action === "rotate"
      && (session === task.budget.policy.rootSessionId || start.sequence < structuralDecision.event.sequence)) {
      throw new SynodError(ERROR_CODES.BUDGET_INVALID, "A rotate decision requires a new root session and a canonical start event at or after the decision.", {
        details: {
          taskId,
          priorRootSessionId: task.budget.policy.rootSessionId,
          requestedRootSessionId: session,
          decisionEvent: structuralDecision.event,
          requestedStartEvent: start
        }
      });
    }
    if (task.budget?.thresholdStatus === "decision-required" && task.splitFrom && structuralDecision?.action === "split"
      && (!splitBoundary || start.sequence < splitBoundary.sequence)) {
      throw new SynodError(ERROR_CODES.BUDGET_INVALID, "A split replacement requires a canonical start event at or after the split event.", {
        details: {
          taskId,
          splitFrom: task.splitFrom,
          splitEvent: splitBoundary ? { sequence: splitBoundary.sequence, id: splitBoundary.id, hash: splitBoundary.eventHash } : undefined,
          requestedStartEvent: start
        }
      });
    }
    const prior = task.budget;
    const policy: TaskBudgetPolicy = {
      revision: (prior?.policy.revision || 0) + 1,
      rootSessionId: session,
      startEvent: start,
      ...(soft === undefined ? {} : { softTotalTokens: soft }),
      ...(hard === undefined ? {} : { hardTotalTokens: hard }),
      actor: principal,
      reason: explanation,
      evidence: evidenceReferences,
      recordedAt: context.timestamp
    };
    task.budget = {
      policy,
      policyHistory: prior ? [...prior.policyHistory, prior.policy] : [],
      observations: prior ? [...prior.observations] : [],
      decisions: prior ? [...prior.decisions] : [],
      thresholdStatus: "within"
    };
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        revision: task.revision,
        payload: { policy, replacedRevision: prior?.policy.revision }
      },
      result: { task, policy }
    };
  }, dependencies);
}

export async function reportTaskBudget({
  directory = ".",
  id
}: { directory?: string; id?: string } = {}, dependencies: OrchestrationDependencies = {}): Promise<TaskBudgetReport> {
  const targetDirectory = path.resolve(directory);
  const taskId = taskIdValue(id);
  const canonical = await readOrchestration(targetDirectory);
  const budget = canonical.state.tasks[taskId]?.budget;
  if (!canonical.state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  if (!budget) throw new SynodError(ERROR_CODES.BUDGET_NOT_CONFIGURED, `Task ${taskId} has no token budget.`);
  return collectTaskBudgetReport({
    cwd: targetDirectory,
    taskId,
    budget,
    ...(dependencies.usageClientFactory ? { clientFactory: dependencies.usageClientFactory } : {}),
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    ...(dependencies.usageCollector ? { collector: dependencies.usageCollector } : {})
  });
}

export async function observeTaskBudget({
  directory = ".",
  id,
  actor = "supervisor"
}: { directory?: string; id?: string; actor?: string } = {}, dependencies: OrchestrationDependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const taskId = taskIdValue(id);
  const canonical = await readOrchestration(targetDirectory);
  const budget = canonical.state.tasks[taskId]?.budget;
  if (!canonical.state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  if (!budget) throw new SynodError(ERROR_CODES.BUDGET_NOT_CONFIGURED, `Task ${taskId} has no token budget.`);
  if (budget.thresholdStatus === "decision-required") {
    throw new SynodError(ERROR_CODES.BUDGET_DECISION_REQUIRED, `Task ${taskId} already requires a decision for its latest hard-budget observation.`);
  }
  const expected = canonical.state.lastEvent;
  const policyRevision = budget.policy.revision;
  const report = await collectTaskBudgetReport({
    cwd: targetDirectory,
    taskId,
    budget,
    ...(dependencies.usageClientFactory ? { clientFactory: dependencies.usageClientFactory } : {}),
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    ...(dependencies.usageCollector ? { collector: dependencies.usageCollector } : {})
  });
  const afterReport = await readOrchestration(targetDirectory);
  const afterTask = afterReport.state.tasks[taskId];
  if (afterReport.state.lastEvent.sequence !== expected.sequence
    || afterReport.state.lastEvent.id !== expected.id
    || afterReport.state.lastEvent.hash !== expected.hash
    || afterTask?.budget?.policy.revision !== policyRevision) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} changed while its budget report was being collected.`);
  }
  const rechecked = await collectTaskBudgetReport({
    cwd: targetDirectory,
    taskId,
    budget: afterTask.budget,
    ...(dependencies.usageClientFactory ? { clientFactory: dependencies.usageClientFactory } : {}),
    clock: () => report.usage.capturedAt,
    ...(dependencies.usageCollector ? { collector: dependencies.usageCollector } : {})
  });
  if (rechecked.reportHash !== report.reportHash || rechecked.thresholdStatus !== report.thresholdStatus) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} rollout provenance changed while its budget observation was being prepared.`, {
      details: { taskId, firstReportHash: report.reportHash, secondReportHash: rechecked.reportHash }
    });
  }
  return commitMutation(targetDirectory, "task.budget-observed", { actor, taskId }, (state, context) => {
    const task = assertCanonicalState(state, expected, taskId, policyRevision);
    const currentBudget = task.budget!;
    const prior = currentBudget.observations.filter(item => item.policyRevision === policyRevision).at(-1);
    if (prior && report.usage.total.totalTokens < prior.totalTokens) {
      throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} budget usage moved behind its prior canonical observation.`, {
        details: { taskId, priorTotalTokens: prior.totalTokens, actualTotalTokens: report.usage.total.totalTokens }
      });
    }
    const observation: TaskBudgetObservation = {
      policyRevision,
      event: context.event,
      reportHash: report.reportHash,
      rootSessionId: report.usage.session.threadId,
      startEvent: currentBudget.policy.startEvent,
      capturedAt: report.usage.capturedAt,
      totalTokens: report.usage.total.totalTokens,
      thresholdStatus: report.thresholdStatus,
      rollouts: report.usage.threads.map(item => ({
        threadId: item.threadId,
        bytes: item.rollout.bytes,
        sha256: item.rollout.sha256
      })).sort((left, right) => left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0)
    };
    currentBudget.observations.push(observation);
    currentBudget.thresholdStatus = observation.thresholdStatus;
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        revision: task.revision,
        payload: { observation }
      },
      result: { task, observation, report }
    };
  }, dependencies);
}

export interface DecideTaskBudgetOptions {
  directory?: string;
  id?: string;
  observation?: string;
  action?: BudgetDecisionAction;
  addedAllowance?: number;
  reason?: string;
  evidence?: unknown[];
  actor?: string;
}

function selectedBudgetObservation(budget: TaskBudget, selector: string): TaskBudgetObservation {
  const normalized = String(selector || "").trim();
  const sequence = /^[1-9]\d*$/.test(normalized) ? Number(normalized) : undefined;
  const matches = budget.observations.filter(item => sequence === undefined ? item.event.id === normalized : item.event.sequence === sequence);
  if (matches.length !== 1) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Budget observation did not resolve exactly once: ${normalized}.`, {
      details: { selector: normalized, matches: matches.length }
    });
  }
  return matches[0]!;
}

export async function decideTaskBudget({
  directory = ".",
  id,
  observation,
  action,
  addedAllowance,
  reason,
  evidence = [],
  actor = "supervisor"
}: DecideTaskBudgetOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const taskId = taskIdValue(id);
  const choice = String(action || "") as BudgetDecisionAction;
  const explanation = String(reason || "").trim();
  const principal = String(actor || "").trim();
  const evidenceReferences = budgetEvidence(evidence);
  const allowance = addedAllowance === undefined ? undefined : budgetLimit(addedAllowance, "Additional token allowance");
  if (!(["continue", "split", "supersede", "rotate"] as string[]).includes(choice)
    || !String(observation || "").trim() || !explanation || !principal
    || (choice === "continue" ? allowance === undefined : allowance !== undefined)) {
    throw new SynodError(ERROR_CODES.BUDGET_INVALID, "Budget decision requires an exact observation, action, actor, reason, evidence, and an allowance only for continue.");
  }
  const canonical = await readOrchestration(targetDirectory);
  const budget = canonical.state.tasks[taskId]?.budget;
  if (!canonical.state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  if (!budget) throw new SynodError(ERROR_CODES.BUDGET_NOT_CONFIGURED, `Task ${taskId} has no token budget.`);
  const selected = selectedBudgetObservation(budget, String(observation));
  const latest = budget.observations.filter(item => item.policyRevision === budget.policy.revision).at(-1);
  if (!latest || selected.event.sequence !== latest.event.sequence || selected.event.id !== latest.event.id
    || selected.policyRevision !== budget.policy.revision || selected.thresholdStatus !== "decision-required"
    || budget.decisions.some(item => item.observation.sequence === selected.event.sequence && item.observation.id === selected.event.id)) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} decision must target the latest unresolved hard-budget observation.`);
  }
  if (choice === "continue") {
    const effectiveHard = effectiveHardTotalTokens(budget);
    if (effectiveHard === undefined || effectiveHard + allowance! <= selected.totalTokens) {
      throw new SynodError(ERROR_CODES.BUDGET_INVALID, "Continuation allowance must raise the effective hard limit above the observed raw total.", {
        details: { observedTotalTokens: selected.totalTokens, effectiveHardTotalTokens: effectiveHard, addedAllowance: allowance }
      });
    }
  }
  const expected = canonical.state.lastEvent;
  const policyRevision = budget.policy.revision;
  return commitMutation(targetDirectory, "task.budget-decided", { actor: principal, taskId }, (state, context) => {
    const task = assertCanonicalState(state, expected, taskId, policyRevision);
    const currentBudget = task.budget!;
    const current = selectedBudgetObservation(currentBudget, String(observation));
    const decision = {
      policyRevision,
      event: context.event,
      observation: current.event,
      action: choice,
      actor: principal,
      reason: explanation,
      evidence: evidenceReferences,
      recordedAt: context.timestamp,
      ...(choice === "continue" ? { addedAllowance: allowance! } : {})
    };
    currentBudget.decisions.push(decision);
    currentBudget.thresholdStatus = choice === "continue"
      ? thresholdStatus(current.totalTokens, currentBudget.policy, effectiveHardTotalTokens(currentBudget))
      : "decision-required";
    task.updatedAt = context.timestamp;
    return {
      metadata: { revision: task.revision, payload: { decision } },
      result: { task, decision }
    };
  }, dependencies);
}

export function formatTaskBudgetReport(report: TaskBudgetReport): string {
  const soft = report.policy.softTotalTokens ?? "—";
  const hard = report.effectiveHardTotalTokens ?? "—";
  return [
    `Task budget: ${report.taskId}`,
    `Status: ${report.thresholdStatus}`,
    `Raw total tokens: ${report.usage.total.totalTokens}`,
    `Soft limit: ${soft}`,
    `Effective hard limit: ${hard}`,
    `Session: ${report.policy.rootSessionId}`,
    `Start event: ${report.policy.startEvent.sequence}:${report.policy.startEvent.id}`,
    `Report: ${report.reportHash}`
  ].join("\n");
}

function rotationEvidence(values: unknown[]): string[] {
  const evidence = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  if (evidence.length === 0) throw new SynodError(ERROR_CODES.ROTATION_INVALID, "Rotation changes require at least one evidence reference.");
  return evidence;
}

function rotationHandoffIdentity(state: OrchestrationState): RotationHandoffIdentity {
  return {
    event: { sequence: state.lastEvent.sequence, id: state.lastEvent.id, hash: state.lastEvent.hash },
    checkpoint: {
      capturedAt: state.checkpoint.capturedAt,
      branch: state.checkpoint.branch,
      head: state.checkpoint.head,
      worktreeFingerprint: state.checkpoint.worktree.fingerprint,
      ...(state.checkpoint.worktree.snapshot ? { snapshotHash: state.checkpoint.worktree.snapshot.contentHash } : {})
    }
  };
}

function completedTasksSince(events: OrchestrationEvent[], startSequence: number, endSequence: number): string[] {
  return [...new Set(events
    .filter(event => event.sequence > startSequence
      && event.sequence <= endSequence
      && event.taskId
      && event.toState === "DONE")
    .map(event => event.taskId!))].sort();
}

function pendingRotationRecommendation(rotation: ProjectRotation): RotationRecommendation | undefined {
  const verified = new Set(rotation.verifications.map(item => `${item.recommendation.sequence}:${item.recommendation.id}`));
  return rotation.recommendations.find(item => !verified.has(`${item.event.sequence}:${item.event.id}`));
}

export interface SetRotationPolicyOptions {
  directory?: string;
  rootSessionId?: string;
  startEvent?: string;
  thresholds?: RotationThresholds;
  reason?: string;
  evidence?: unknown[];
  actor?: string;
  replace?: boolean;
}

export async function setRotationPolicy({
  directory = ".",
  rootSessionId,
  startEvent,
  thresholds,
  reason,
  evidence = [],
  actor = "supervisor",
  replace = false
}: SetRotationPolicyOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const session = String(rootSessionId || "").trim();
  const explanation = String(reason || "").trim();
  const principal = String(actor || "").trim();
  const evidenceReferences = rotationEvidence(evidence);
  if (!session || !String(startEvent || "").trim() || !isRotationThresholds(thresholds) || !explanation || !principal) {
    throw new SynodError(ERROR_CODES.ROTATION_INVALID, "Rotation policy requires a root session, exact start event, at least one valid threshold, actor, reason, and evidence.");
  }
  const canonical = await readOrchestration(targetDirectory);
  const start = budgetEventIdentity(canonical.events, String(startEvent));
  const expected = canonical.state.lastEvent;
  return commitMutation(targetDirectory, replace ? "project.rotation-policy-replaced" : "project.rotation-policy-set", { actor: principal }, (state, context) => {
    if (state.lastEvent.sequence !== expected.sequence || state.lastEvent.id !== expected.id || state.lastEvent.hash !== expected.hash) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation policy input was computed from stale canonical state.");
    }
    if (replace && !state.rotation) throw new SynodError(ERROR_CODES.ROTATION_NOT_CONFIGURED, "No project rotation policy is configured.");
    if (!replace && state.rotation) throw new SynodError(ERROR_CODES.ROTATION_INVALID, "A project rotation policy already exists; use an explicit replacement.");
    if (state.rotation && pendingRotationRecommendation(state.rotation)) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "The pending phase-rotation recommendation must be verified before replacing its policy.");
    }
    const prior = state.rotation;
    const policy: RotationPolicy = {
      revision: (prior?.policy.revision || 0) + 1,
      rootSessionId: session,
      startEvent: start,
      thresholds: structuredClone(thresholds),
      actor: principal,
      reason: explanation,
      evidence: evidenceReferences,
      recordedAt: context.timestamp
    };
    state.rotation = {
      policy,
      policyHistory: prior ? [...prior.policyHistory, prior.policy] : [],
      recommendations: prior ? [...prior.recommendations] : [],
      verifications: prior ? [...prior.verifications] : []
    };
    return {
      metadata: { payload: { policy, replacedRevision: prior?.policy.revision } },
      result: { policy, rotation: state.rotation }
    };
  }, dependencies);
}

async function rotationReportFromCanonical(
  targetDirectory: string,
  canonical: Awaited<ReturnType<typeof readOrchestration>>,
  dependencies: OrchestrationDependencies
): Promise<RotationReport> {
  const rotation = canonical.state.rotation;
  if (!rotation) throw new SynodError(ERROR_CODES.ROTATION_NOT_CONFIGURED, "No project rotation policy is configured.");
  const phase = currentRotationPhase(rotation);
  return collectRotationReport({
    cwd: targetDirectory,
    rotation,
    handoff: rotationHandoffIdentity(canonical.state),
    completedTaskIds: completedTasksSince(canonical.events, phase.startEvent.sequence, canonical.state.lastEvent.sequence),
    ...(dependencies.usageClientFactory ? { clientFactory: dependencies.usageClientFactory } : {}),
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    ...(dependencies.usageCollector ? { collector: dependencies.usageCollector } : {})
  });
}

export async function reportProjectRotation(
  { directory = "." }: { directory?: string } = {},
  dependencies: OrchestrationDependencies = {}
): Promise<RotationReport> {
  const targetDirectory = path.resolve(directory);
  return rotationReportFromCanonical(targetDirectory, await readOrchestration(targetDirectory), dependencies);
}

export async function suggestProjectRotation(
  { directory = "." }: { directory?: string } = {},
  dependencies: OrchestrationDependencies = {}
): Promise<RotationSuggestion> {
  const targetDirectory = path.resolve(directory);
  const canonical = await readOrchestration(targetDirectory);
  const phaseTaskCount = canonical.state.taskOrder.filter(taskId => canonical.state.tasks[taskId]?.state !== "SUPERSEDED").length;
  const recommendedThresholds = recommendedRotationThresholds(phaseTaskCount);
  if (canonical.state.rotation) {
    const report = await rotationReportFromCanonical(targetDirectory, canonical, dependencies);
    const pending = pendingRotationRecommendation(canonical.state.rotation);
    return {
      configured: true,
      phaseTaskCount,
      recommendedThresholds,
      observations: report.metrics,
      report,
      nextAction: pending
        ? {
            operation: "rotation.verify",
            arguments: {
              recommendation: { value: pending.event.id, required: false },
              rootSessionId: { value: null, required: true }
            }
          }
        : report.recommended
          ? { operation: "rotation.prepare", arguments: {} }
          : { operation: "rotation.report", arguments: {} }
    };
  }
  const metricThresholds: Array<[RotationMetric["name"], number | undefined]> = [
    ["supervisor-context-percent", recommendedThresholds.supervisorContextPercent],
    ["compactions", recommendedThresholds.compactions],
    ["wait-calls", recommendedThresholds.waitCalls],
    ["completed-tasks", recommendedThresholds.completedTasks]
  ];
  const observations: RotationMetric[] = metricThresholds.map(([name, threshold]) => ({
    name,
    status: "unavailable",
    threshold: threshold!,
    triggered: false
  }));
  return {
    configured: false,
    phaseTaskCount,
    recommendedThresholds,
    observations,
    nextAction: {
      operation: "rotation.set",
      arguments: {
        rootSessionId: { value: null, required: true },
        startEvent: {
          value: {
            sequence: canonical.state.lastEvent.sequence,
            id: canonical.state.lastEvent.id,
            hash: canonical.state.lastEvent.hash
          },
          required: false
        },
        thresholds: { value: recommendedThresholds, required: false },
        reason: { value: null, required: true },
        evidence: { value: [], required: true }
      }
    }
  };
}

export async function prepareProjectRotation(
  { directory = ".", actor = "supervisor" }: { directory?: string; actor?: string } = {},
  dependencies: OrchestrationDependencies = {}
) {
  const targetDirectory = path.resolve(directory);
  const canonical = await readOrchestration(targetDirectory);
  if (!canonical.state.rotation) throw new SynodError(ERROR_CODES.ROTATION_NOT_CONFIGURED, "No project rotation policy is configured.");
  if (pendingRotationRecommendation(canonical.state.rotation)) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "A phase-rotation recommendation is already waiting for verification.");
  }
  const expected = canonical.state.lastEvent;
  const policyRevision = canonical.state.rotation.policy.revision;
  const report = await rotationReportFromCanonical(targetDirectory, canonical, dependencies);
  if (!report.recommended) {
    throw new SynodError(ERROR_CODES.ROTATION_NOT_RECOMMENDED, "No configured phase-rotation threshold has been reached.", {
      details: { metrics: report.metrics }
    });
  }
  const afterReport = await readOrchestration(targetDirectory);
  if (afterReport.state.lastEvent.sequence !== expected.sequence
    || afterReport.state.lastEvent.id !== expected.id
    || afterReport.state.lastEvent.hash !== expected.hash
    || afterReport.state.rotation?.policy.revision !== policyRevision) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Canonical state changed while the rotation recommendation was being collected.");
  }
  const rechecked = await rotationReportFromCanonical(targetDirectory, afterReport, {
    ...dependencies,
    clock: () => report.usage.capturedAt
  });
  if (rechecked.reportHash !== report.reportHash) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rollout provenance changed while the rotation recommendation was being prepared.", {
      details: { firstReportHash: report.reportHash, secondReportHash: rechecked.reportHash }
    });
  }
  return commitMutation(targetDirectory, "project.rotation-prepared", { actor }, (state, context) => {
    if (state.lastEvent.sequence !== expected.sequence || state.lastEvent.id !== expected.id || state.lastEvent.hash !== expected.hash
      || state.rotation?.policy.revision !== policyRevision) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation recommendation input is stale.");
    }
    if (checkpointDrift(state.checkpoint, context.checkpoint).detected) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Checkpoint drift prevents a canonical phase-rotation handoff.", {
        details: checkpointDrift(state.checkpoint, context.checkpoint)
      });
    }
    if (pendingRotationRecommendation(state.rotation)) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "A phase-rotation recommendation is already pending.");
    }
    const recommendation: RotationRecommendation = {
      policyRevision,
      event: context.event,
      reportHash: report.reportHash,
      usageReportHash: report.usageReportHash,
      rootSessionId: report.phase.rootSessionId,
      startEvent: report.phase.startEvent,
      capturedAt: report.usage.capturedAt,
      handoff: report.handoff,
      metrics: report.metrics,
      reasons: report.reasons,
      completeness: report.usage.completeness,
      completedTaskIds: report.completedTaskIds,
      rollouts: report.usage.threads.map(item => ({
        threadId: item.threadId,
        bytes: item.rollout.bytes,
        sha256: item.rollout.sha256
      })).sort((left, right) => left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0)
    };
    state.rotation.recommendations.push(recommendation);
    return {
      metadata: { payload: { recommendation } },
      result: { recommendation, report, rotation: state.rotation }
    };
  }, dependencies);
}

function selectedRotationRecommendation(rotation: ProjectRotation, selector: string): RotationRecommendation {
  const normalized = String(selector || "").trim();
  const sequence = /^[1-9]\d*$/.test(normalized) ? Number(normalized) : undefined;
  const matches = rotation.recommendations.filter(item => sequence === undefined ? item.event.id === normalized : item.event.sequence === sequence);
  if (matches.length !== 1) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, `Rotation recommendation did not resolve exactly once: ${normalized}.`, {
      details: { selector: normalized, matches: matches.length }
    });
  }
  return matches[0]!;
}

function codexSessionTimestamp(value: unknown): number | undefined {
  let milliseconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric
      : Date.parse(value);
  }
  return milliseconds !== undefined && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
}

export async function verifyProjectRotation({
  directory = ".",
  recommendation,
  rootSessionId,
  actor = "supervisor"
}: {
  directory?: string;
  recommendation?: string;
  rootSessionId?: string;
  actor?: string;
} = {}, dependencies: OrchestrationDependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const selectedSession = String(rootSessionId || "").trim();
  const canonical = await readOrchestration(targetDirectory);
  const rotation = canonical.state.rotation;
  if (!rotation) throw new SynodError(ERROR_CODES.ROTATION_NOT_CONFIGURED, "No project rotation policy is configured.");
  const selected = selectedRotationRecommendation(rotation, String(recommendation || ""));
  const pending = pendingRotationRecommendation(rotation);
  if (!pending || pending.event.sequence !== selected.event.sequence || pending.event.id !== selected.event.id
    || selected.policyRevision !== rotation.policy.revision
    || canonical.state.lastEvent.sequence !== selected.event.sequence || canonical.state.lastEvent.id !== selected.event.id
    || selectedSession === selected.rootSessionId) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation verification must target the latest pending recommendation from a different root session.");
  }
  const expected = canonical.state.lastEvent;
  const resolver = dependencies.usageSessionResolver || resolveUsageRootSession;
  const session = await resolver({
    cwd: targetDirectory,
    threadId: selectedSession,
    ...(dependencies.usageClientFactory ? { clientFactory: dependencies.usageClientFactory } : {})
  });
  if (session.threadId !== selectedSession || session.threadId === selected.rootSessionId) {
    throw new SynodError(ERROR_CODES.ROTATION_SESSION_INVALID, "The verified session does not establish a new root identity.");
  }
  const preparedEvent = canonical.events.find(event => event.sequence === selected.event.sequence && event.id === selected.event.id);
  const preparedAt = preparedEvent ? Date.parse(preparedEvent.timestamp) : Number.NaN;
  const newRootCreatedAt = codexSessionTimestamp(session.createdAt);
  if (!Number.isFinite(preparedAt) || newRootCreatedAt === undefined || newRootCreatedAt <= preparedAt) {
    throw new SynodError(ERROR_CODES.ROTATION_SESSION_INVALID, "The verified root session must include creation evidence after the prepared handoff.", {
      details: { threadId: session.threadId, createdAt: session.createdAt, preparedAt: preparedEvent?.timestamp }
    });
  }
  const newRootSessionCreatedAt = new Date(newRootCreatedAt).toISOString();
  const afterSession = await readOrchestration(targetDirectory);
  if (afterSession.state.lastEvent.sequence !== expected.sequence || afterSession.state.lastEvent.id !== expected.id
    || afterSession.state.lastEvent.hash !== expected.hash) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Canonical state changed while the new root session was being verified.");
  }
  return commitMutation(targetDirectory, "project.rotation-verified", { actor }, (state, context) => {
    if (state.lastEvent.sequence !== expected.sequence || state.lastEvent.id !== expected.id || state.lastEvent.hash !== expected.hash
      || !state.rotation || state.rotation.policy.revision !== selected.policyRevision) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation verification input is stale.");
    }
    const currentPending = pendingRotationRecommendation(state.rotation);
    if (!currentPending || currentPending.event.sequence !== selected.event.sequence || currentPending.event.id !== selected.event.id) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation recommendation is no longer pending.");
    }
    const drift = checkpointDrift(state.checkpoint, context.checkpoint);
    if (drift.detected || stableStringify(rotationHandoffIdentity(state).checkpoint) !== stableStringify(selected.handoff.checkpoint)) {
      throw new SynodError(ERROR_CODES.ROTATION_STALE, "Checkpoint drift or a stale handoff prevents rotation verification.", { details: { drift } });
    }
    const verification = {
      policyRevision: selected.policyRevision,
      event: context.event,
      recommendation: selected.event,
      oldRootSessionId: selected.rootSessionId,
      newRootSessionId: session.threadId,
      newRootSessionCreatedAt,
      priorStartEvent: selected.startEvent,
      handoff: selected.handoff,
      verifiedAt: context.timestamp
    };
    state.rotation.verifications.push(verification);
    return {
      metadata: { payload: { verification } },
      result: { verification, session, rotation: state.rotation }
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
    assertBudgetAllowsExecution(task, "ordinary correction approval");
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
    assertBudgetStructuralDecision(task, "split");
    const budgetSplit = task.budget?.thresholdStatus === "decision-required" && latestBudgetDecision(task)?.action === "split";
    if ((!budgetSplit && task.correctionPolicy.used < task.correctionPolicy.limit) || TERMINAL_STATES.has(task.state) || task.lease) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} is not eligible for an exhausted-policy split.`, {
        details: { taskId, state: task.state, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    if (task.recovery?.status === "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} requires an explicit abandoned-owner recovery decision before it can split.`, {
        details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
      });
    }
    if (task.leaseReservation) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} has an unbound writer reservation; bind or cancel it before splitting.`, {
        details: { taskId, leaseId: task.leaseReservation.id, generation: task.leaseReservation.generation }
      });
    }
    for (const replacementId of replacementIds) {
      const replacement = state.tasks[replacementId];
      if (!replacement || replacement.state !== "PLANNED" || replacement.splitFrom) {
        throw new SynodError(ERROR_CODES.TASK_INVALID, `Split replacement ${replacementId} must be an unlinked PLANNED task.`, {
          details: { taskId, replacementId, state: replacement?.state }
        });
      }
      if (task.budget && replacement.budget) {
        throw new SynodError(ERROR_CODES.BUDGET_INVALID, `Split replacement ${replacementId} already has a budget that cannot be overwritten.`, {
          details: { taskId, replacementId, policyRevision: replacement.budget.policy.revision }
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
      if (task.budget) replacement.budget = structuredClone(task.budget);
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
      ...(task.leaseReservation ? [task.leaseReservation] : []),
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

async function gitPathOutput(
  directory: string,
  args: string[],
  gitRunner: GitRunner
): Promise<string> {
  try {
    return await gitRunner(directory, args);
  } catch (error) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, "Could not capture immutable proposal Git path semantics.", {
      cause: error,
      details: { command: args.slice(0, 5) }
    });
  }
}

async function gitPathNames(
  directory: string,
  args: string[],
  gitRunner: GitRunner
): Promise<Set<string>> {
  return new Set((await gitPathOutput(directory, args, gitRunner)).split("\0").filter(Boolean));
}

function literalPathspecBatches(baseArgs: readonly string[], pathspecs: readonly string[]): string[][] {
  const baseBytes = baseArgs.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 1, 0)
    + Buffer.byteLength("--", "utf8") + 1;
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = baseBytes;
  for (const pathspec of pathspecs) {
    const pathspecBytes = Buffer.byteLength(pathspec, "utf8") + 1;
    if (current.length > 0 && currentBytes + pathspecBytes > GIT_PATHSPEC_BATCH_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = baseBytes;
    }
    current.push(pathspec);
    currentBytes += pathspecBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function batchedGitPathNames(
  directory: string,
  baseArgs: string[],
  literalPathspecs: readonly string[],
  gitRunner: GitRunner
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const batch of literalPathspecBatches(baseArgs, literalPathspecs)) {
    const result = await gitPathNames(directory, [...baseArgs, "--", ...batch], gitRunner);
    for (const relativePath of result) paths.add(relativePath);
  }
  return paths;
}

async function captureProposalPathStates(
  directory: string,
  current: CheckpointSnapshot,
  owned: ClassifiedLeaseDelta["owned"],
  gitRunner: GitRunner
): Promise<TaskProposalPathState[]> {
  const paths = [...new Set(owned.flatMap(deltaPaths))].sort(compareCheckpointPaths);
  if (paths.length === 0) return [];
  const literalPathspecs = paths.map(relativePath => `:(literal)${relativePath}`);
  const indexPaths = new Set<string>();
  for (const batch of literalPathspecBatches(["ls-files", "--stage", "-z"], literalPathspecs)) {
    const output = await gitPathOutput(directory, ["ls-files", "--stage", "-z", "--", ...batch], gitRunner);
    for (const relativePath of indexRecords(output).keys()) indexPaths.add(relativePath);
  }
  const committedPaths = current.head
    ? await batchedGitPathNames(directory, ["ls-tree", "-r", "-z", "--name-only", current.head], literalPathspecs, gitRunner)
    : new Set<string>();
  const currentByPath = new Map<string, CheckpointEntry>();
  for (const item of owned) {
    if (item.current) currentByPath.set(item.path, item.current);
    if (item.sourcePath && item.current) currentByPath.set(item.sourcePath, item.current);
  }
  const sourceFor = new Map<string, string>();
  for (const item of owned) if (item.sourcePath) sourceFor.set(item.path, item.sourcePath);
  return paths.map(relativePath => {
    const status = currentByPath.get(relativePath)?.status;
    return {
      path: relativePath,
      ...(sourceFor.has(relativePath) ? { sourcePath: sourceFor.get(relativePath)! } : {}),
      proposalAdded: true,
      gitTracked: indexPaths.has(relativePath),
      staged: Boolean(status && status[0] !== " " && status[0] !== "?"),
      committed: committedPaths.has(relativePath)
    };
  });
}

function scopedPathEvidence(owned: ClassifiedLeaseDelta["owned"]): TaskScopedPathEvidence[] {
  const byPath = new Map<string, TaskScopedPathEvidence>();
  for (const item of owned) {
    const paths = [
      { path: item.path, sourcePath: item.sourcePath },
      ...(item.sourcePath ? [{ path: item.sourcePath, sourcePath: undefined }] : [])
    ];
    for (const candidate of paths) {
      if (byPath.has(candidate.path)) continue;
      const status = item.current?.status;
      byPath.set(candidate.path, {
        path: candidate.path,
        ...(candidate.sourcePath ? { sourcePath: candidate.sourcePath } : {}),
        ...(status ? { status } : {}),
        staged: Boolean(status && status[0] !== " " && status[0] !== "?"),
        unstaged: Boolean(status && status[1] !== " " && status[1] !== "?"),
        untracked: status === "??",
        resolved: !item.current
      });
    }
  }
  return [...byPath.values()].sort((left, right) => compareCheckpointPaths(
    `${left.path}\0${left.sourcePath || ""}`,
    `${right.path}\0${right.sourcePath || ""}`
  ));
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
  dependencies: OrchestrationDependencies,
  options: { allowEmpty?: boolean } = {}
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
  if (ownedPaths.length === 0 && !options.allowEmpty) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} has no in-scope owned delta to seal.`, {
      details: { taskId: task.id, leaseId: lease.id, generation: lease.generation }
    });
  }
  const pathStates = await captureProposalPathStates(targetDirectory, context.snapshot, classified.owned, dependencies.gitRunner || defaultGitRunner);
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
      pathStatesVersion: TASK_PROPOSAL_PATH_STATES_VERSION,
      pathStates,
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
  context: MutationContext,
  dependencies: OrchestrationDependencies
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
  const pathStates = await captureProposalPathStates(targetDirectory, context.snapshot, classified.owned, dependencies.gitRunner || defaultGitRunner);
  const currentPathStates = proposal.pathStatesVersion === TASK_PROPOSAL_PATH_STATES_VERSION;
  const completeCurrentPathStates = currentPathStates
    && proposal.pathStates !== undefined
    && proposal.pathStates.length === proposal.ownedPaths.length
    && proposal.pathStates.every((item, index) => item.path === proposal.ownedPaths[index])
    && proposal.pathStates.every(item => item.sourcePath === undefined || proposal.ownedPaths.includes(item.sourcePath));
  if (currentPathStates && !completeCurrentPathStates) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} current proposal path-state lanes are incomplete.`, {
      details: { taskId: task.id, ownedPaths: proposal.ownedPaths, pathStates: proposal.pathStates }
    });
  }
  if (
    stableStringify(ownedPaths) !== stableStringify(proposal.ownedPaths)
    || snapshot.worktreeFingerprint !== proposal.fingerprint
    || snapshot.contentHash !== proposal.snapshotHash
    || (currentPathStates && stableStringify(pathStates) !== stableStringify(proposal.pathStates))
  ) {
    throw new SynodError(ERROR_CODES.PROPOSAL_INVALID, `Task ${task.id} owned material changed after proposal sealing.`, {
      details: {
        taskId: task.id,
        expectedOwnedPaths: proposal.ownedPaths,
        actualOwnedPaths: ownedPaths,
        expectedFingerprint: proposal.fingerprint,
        actualFingerprint: snapshot.worktreeFingerprint,
        expectedSnapshotHash: proposal.snapshotHash,
        actualSnapshotHash: snapshot.contentHash,
        ...(currentPathStates ? { expectedPathStates: proposal.pathStates, actualPathStates: pathStates } : {})
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

function requireLeaseReservationIdentity(
  task: OrchestrationTask,
  {
    reservationToken,
    leaseId,
    generation,
    revision,
    expectedReservedAt,
    baselineHash
  }: {
    reservationToken?: unknown;
    leaseId?: unknown;
    generation?: unknown;
    revision?: unknown;
    expectedReservedAt?: unknown;
    baselineHash?: unknown;
  }
): TaskLeaseReservation {
  const reservation = task.leaseReservation;
  if (!reservation) {
    throw new SynodError(ERROR_CODES.LEASE_RESERVATION_NOT_FOUND, `Task ${task.id} has no unbound writer reservation.`, {
      details: { taskId: task.id }
    });
  }
  const reservationTokenMatches = String(reservationToken || "") === reservation.token;
  const expected = {
    leaseId: reservation.id,
    generation: reservation.generation,
    revision: reservation.taskRevision,
    reservedAt: reservation.reservedAt,
    baselineHash: reservation.baseline.snapshotContentHash
  };
  if (!reservationTokenMatches
    || String(leaseId || "") !== reservation.id
    || generation !== reservation.generation
    || revision !== task.revision
    || revision !== reservation.taskRevision
    || String(expectedReservedAt || "") !== reservation.reservedAt
    || String(baselineHash || "") !== reservation.baseline.snapshotContentHash) {
    throw new SynodError(ERROR_CODES.LEASE_RESERVATION_STALE, `Task ${task.id} lease reservation fence is stale.`, {
      details: {
        taskId: task.id,
        expected,
        reservationTokenMatches,
        actual: { leaseId, generation, revision, reservedAt: expectedReservedAt, baselineHash }
      }
    });
  }
  return reservation;
}

function assertReservationEligible(task: OrchestrationTask, role?: DelegationRole): void {
  if (!["READY", "REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `Task ${task.id} cannot reserve a writer lease from ${task.state}.`, {
      details: { taskId: task.id, state: task.state }
    });
  }
  if (task.recovery?.status === "PENDING") {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `Task ${task.id} requires an explicit abandoned-owner recovery decision.`, {
      details: { taskId: task.id, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
    });
  }
  if (role === "reviewer" || role === "verifier") return;
  if (["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)
    && task.correctionPolicy.used >= task.correctionPolicy.limit) {
    throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${task.id} has exhausted its correction allowance.`, {
      details: { taskId: task.id, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
    });
  }
}

function approvalRoleState(role: Exclude<DelegationRole, "implementer">): TaskState {
  return role === "reviewer" ? "REVIEW" : "ACCEPTED";
}

function approvalProposal(task: OrchestrationTask, role: Exclude<DelegationRole, "implementer">): TaskProposalReference {
  if (task.state !== approvalRoleState(role)) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${role} delegation is only valid from ${approvalRoleState(role)}.`, {
      details: { taskId: task.id, role, state: task.state }
    });
  }
  if (!task.proposal || task.proposal.revision !== task.revision || task.proposal.status !== "SEALED") {
    throw new SynodError(ERROR_CODES.PROPOSAL_REQUIRED, `${role} delegation requires the current sealed proposal.`, {
      details: { taskId: task.id, role, revision: task.revision, proposal: task.proposal ?? null }
    });
  }
  return task.proposal;
}

function assertApprovalScopes(
  task: OrchestrationTask,
  role: Exclude<DelegationRole, "implementer">,
  scopes: TaskLeaseReservation["scopes"]
): TaskProposalReference {
  const proposal = approvalProposal(task, role);
  const actual = scopes
    .filter(scope => scope.access === "read" && scope.kind === "file")
    .map(scope => scope.path)
    .sort(compareCheckpointPaths);
  const expected = [...proposal.ownedPaths].sort(compareCheckpointPaths);
  if (scopes.some(scope => scope.access !== "read" || scope.kind !== "file")
    || actual.length !== expected.length
    || actual.some((item, index) => item !== expected[index])) {
    throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${role} delegation scopes must exactly cover the sealed proposal-owned paths.`, {
      details: { taskId: task.id, role, expectedPaths: expected, actualScopes: scopes }
    });
  }
  return proposal;
}

function activeApproval(
  task: OrchestrationTask,
  role: Exclude<DelegationRole, "implementer">,
  revision: number,
  proposalBundleId: string
): TaskApprovalRecord | undefined {
  return task.approvals?.find(item => item.role === role
    && item.decision === "approved"
    && item.revision === revision
    && item.proposalBundleId === proposalBundleId
    && item.consumedAt === undefined);
}

function requireApproval(
  task: OrchestrationTask,
  role: Exclude<DelegationRole, "implementer">,
  revision: number
): TaskApprovalRecord {
  const proposal = task.proposal;
  const approval = proposal ? activeApproval(task, role, revision, proposal.bundleId) : undefined;
  if (!approval) {
    throw new SynodError(ERROR_CODES.APPROVAL_REQUIRED, `Task ${task.id} requires an approved ${role} record for revision ${revision}.`, {
      details: {
        taskId: task.id,
        role,
        revision,
        proposalBundleId: proposal?.bundleId ?? null,
        approvals: task.approvals ?? null
      }
    });
  }
  return approval;
}

function reservationScopeConflicts(
  state: OrchestrationState,
  taskId: string,
  scopes: TaskLeaseReservation["scopes"],
  ownReservationId?: string
): void {
  for (const other of taskList(state)) {
    const leaseCollisions = other.lease
      ? scopes.filter(scope => other.lease?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
      : [];
    const reservationCollisions = other.leaseReservation && other.leaseReservation.id !== ownReservationId
      ? scopes.filter(scope => other.leaseReservation?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
      : [];
    const recoveryCollisions = other.id !== taskId && other.recovery?.status === "PENDING"
      ? scopes.filter(scope => other.recovery?.endedLease.scopes.some(existing => leaseScopesOverlap(scope, existing)))
      : [];
    const proposalCollisions = other.id !== taskId && proposalReservesPaths(other) && other.proposal
      ? scopes.filter(scope => scope.access === "write" && other.proposal?.ownedPaths.some(candidate =>
        leaseScopeCoversPath(scope, candidate)
      ))
      : [];
    const collisions = [...leaseCollisions, ...reservationCollisions, ...recoveryCollisions, ...proposalCollisions];
    if (collisions.length > 0) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} write scope overlaps task ${other.id}.`, {
        details: { taskId, conflictingTaskId: other.id, paths: [...new Set(collisions.map(scope => scope.path))] }
      });
    }
  }
}

function concurrentWriterTaskIds(state: OrchestrationState, taskId?: string): string[] {
  return taskList(state)
    .filter(other => other.id !== taskId
      && !isObserverAuthority(other)
      && (other.lease || other.leaseReservation))
    .map(other => other.id)
    .sort();
}

function assertConcurrencyCapacity(state: OrchestrationState, taskId: string): void {
  const policy = concurrencyPolicy(state);
  const conflictingTaskIds = concurrentWriterTaskIds(state, taskId);
  if (conflictingTaskIds.length >= policy.maxConcurrentSubagents) {
    throw new SynodError(ERROR_CODES.CONCURRENCY_EXCEEDED, `Task ${taskId} writer reservation exceeds the concurrent subagent limit.`, {
      details: {
        taskId,
        limit: policy.maxConcurrentSubagents,
        active: conflictingTaskIds.length,
        conflictingTaskIds
      }
    });
  }
}

function assertReservationBaselineUnchanged(
  task: OrchestrationTask,
  reservation: TaskLeaseReservation,
  baseline: CheckpointSnapshot,
  current: CheckpointSnapshot
): void {
  const changedIdentity = baseline.available !== current.available
    || baseline.branch !== current.branch
    || baseline.head !== current.head;
  const changedScopes = explainCheckpointDelta(baseline, current).paths.filter(item =>
    deltaPaths(item).some(candidate => reservation.scopes.some(scope => leaseScopeCoversPath(scope, candidate)))
  );
  if (changedIdentity || changedScopes.length > 0) {
    throw new SynodError(ERROR_CODES.LEASE_SCOPE_DRIFT, `Task ${task.id} reservation scope changed before owner binding.`, {
      details: {
        taskId: task.id,
        gitIdentityChanged: changedIdentity,
        paths: changedScopes.map(item => ({ path: item.path, ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) }))
      }
    });
  }
}

export interface ReserveLeaseOptions {
  directory?: string;
  id?: string;
  read?: unknown[];
  write?: unknown[];
  readTree?: unknown[];
  writeTree?: unknown[];
  observer?: boolean;
  role?: DelegationRole;
  reservationTtlSeconds?: number;
  actor?: string;
}

export async function reserveTaskLease({
  directory = ".",
  id,
  read = [],
  write = [],
  readTree = [],
  writeTree = [],
  observer,
  role,
  reservationTtlSeconds = DEFAULT_LEASE_RESERVATION_TTL_SECONDS,
  actor = "supervisor"
}: ReserveLeaseOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const ttl = parseLeaseDuration(reservationTtlSeconds, "reservationTtlSeconds");
  if (ttl < MIN_LEASE_TTL_SECONDS || ttl > MAX_LEASE_RESERVATION_TTL_SECONDS) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease reservation expiry policy is outside the supported bounds.", {
      details: {
        reservationTtlSeconds: ttl,
        minimumTtlSeconds: MIN_LEASE_TTL_SECONDS,
        maximumTtlSeconds: MAX_LEASE_RESERVATION_TTL_SECONDS
      }
    });
  }
  if (observer !== undefined && observer !== true) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Observer mode must be requested with a true observer flag.");
  }
  if (role !== undefined && !isDelegationRole(role)) {
    throw new SynodError(ERROR_CODES.DELEGATION_ROLE_INVALID, `Unsupported delegation role: ${String(role)}.`, {
      details: { role, allowed: ["implementer", "reviewer", "verifier"] }
    });
  }
  const approvalRole = role === "reviewer" || role === "verifier" ? role : undefined;
  const observerRequested = approvalRole !== undefined || observer === true;
  if (observerRequested && (write.length > 0 || writeTree.length > 0)) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "An observer lease cannot contain write scopes.");
  }
  const scopes = normalizeLeaseScopes({ read, write, readTree, writeTree }, { observer: observerRequested });
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "lease.reserved", { actor, taskId }, async (state, context) => {
    if (!context.snapshot.available || !context.snapshot.head) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "A writer reservation requires an exact Git HEAD and worktree snapshot.", {
        details: { taskId, branch: context.snapshot.branch, head: context.snapshot.head }
      });
    }
    await validateLeaseScopeFilesystemPaths(targetDirectory, scopes);
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    assertBudgetAllowsExecution(task, observerRequested ? "observer lease reservation" : "writer lease reservation");
    assertReservationEligible(task, role);
    if (approvalRole) assertApprovalScopes(task, approvalRole, scopes);
    if (task.lease || task.leaseReservation) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} already has writer authority reserved.`, {
        details: {
          taskId,
          leaseId: task.lease?.id || task.leaseReservation?.id,
          generation: task.lease?.generation || task.leaseReservation?.generation
        }
      });
    }
    if (!observerRequested) assertConcurrencyCapacity(state, taskId);
    reservationScopeConflicts(state, taskId, scopes);
    if (!context.acknowledgedSnapshot) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "A writer reservation requires an acknowledged checkpoint snapshot.", {
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
    // Reviewer/verifier observers must not consume the writer generation that
    // identifies the sealed proposal. Their lease is an independent,
    // read-only observation of that exact delivery, so it reuses the current
    // task generation while writer reservations continue to advance it.
    if (!approvalRole) task.leaseGeneration += 1;
    const reservation: TaskLeaseReservation = {
      id: randomUUID(),
      token: randomUUID(),
      generation: task.leaseGeneration,
      taskId,
      taskRevision: task.revision,
      executor: task.executor,
      ...(role === undefined ? {} : { role }),
      scopes,
      ...(observerRequested ? { observer: true as const } : {}),
      reservedAt: context.timestamp,
      expiresAt: leaseDeadline(context.timestamp, ttl),
      ttlSeconds: ttl,
      baseline: {
        path: LEASE_BASELINES_PATH,
        snapshotContentHash: context.snapshot.contentHash,
        branch: context.snapshot.branch,
        head: context.snapshot.head,
        worktreeFingerprint: context.snapshot.worktreeFingerprint,
        lastEvent: state.lastEvent
      },
      status: "RESERVED"
    };
    if (approvalRole) {
      // This marker is the durable policy boundary. It survives observer
      // lease release/cancellation and prevents lifecycle transitions from
      // inferring approval requirements from incidental runtime state.
      task.approvalPolicy = "typed";
      if (task.approvals === undefined) task.approvals = [];
    }
    task.leaseReservation = reservation;
    task.updatedAt = context.timestamp;
    const baseline: LeaseBaseline = {
      leaseId: reservation.id,
      generation: reservation.generation,
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
      ...(currentTask.leaseReservation ? [currentTask.leaseReservation] : []),
      ...(currentTask.proposal ? [{ id: currentTask.proposal.leaseId, generation: currentTask.proposal.generation }] : []),
      ...(currentTask.recovery?.status === "PENDING"
        ? [{ id: currentTask.recovery.endedLease.id, generation: currentTask.recovery.endedLease.generation }]
        : [])
    ]));
    return {
      leaseBaselines,
      metadata: {
        revision: task.revision,
        payload: {
          leaseId: reservation.id,
          generation: reservation.generation,
          reservedAt: reservation.reservedAt,
          expiresAt: reservation.expiresAt,
          baselineHash: reservation.baseline.snapshotContentHash,
          writeAuthorized: false
        }
      },
      result: { task, reservation, writeAuthorized: false as const }
    };
  }, dependencies);
}

export interface LeaseReservationIdentityOptions {
  directory?: string;
  id?: string;
  reservationToken?: string;
  leaseId?: string;
  generation?: number;
  revision?: number;
  expectedReservedAt?: string;
  baselineHash?: string;
  ownerThread?: string;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  evidence?: unknown[];
  actor?: string;
  reason?: string;
}

export async function bindTaskLease({
  directory = ".",
  id,
  reservationToken,
  leaseId,
  generation,
  revision,
  expectedReservedAt,
  baselineHash,
  ownerThread,
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  evidence = [],
  actor = "supervisor"
}: LeaseReservationIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const owner = String(ownerThread || "").trim();
  const ttl = parseLeaseDuration(ttlSeconds, "ttlSeconds");
  const heartbeat = parseLeaseDuration(heartbeatIntervalSeconds, "heartbeatIntervalSeconds");
  if (!owner) throw new SynodError(ERROR_CODES.LEASE_INVALID, "Binding a writer reservation requires --owner-thread.");
  if (ttl < MIN_LEASE_TTL_SECONDS || ttl > MAX_LEASE_TTL_SECONDS || heartbeat >= ttl) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease heartbeat/expiry policy is outside the supported bounds.", {
      details: { ttlSeconds: ttl, heartbeatIntervalSeconds: heartbeat, minimumTtlSeconds: MIN_LEASE_TTL_SECONDS, maximumTtlSeconds: MAX_LEASE_TTL_SECONDS }
    });
  }
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "lease.bound", { actor, taskId }, async (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    assertBudgetAllowsExecution(task, "writer lease binding");
    const reservation = requireLeaseReservationIdentity(task, {
      reservationToken, leaseId, generation, revision, expectedReservedAt, baselineHash
    });
    assertReservationEligible(task, reservation.role);
    const approvalRole = reservation.role === "reviewer" || reservation.role === "verifier" ? reservation.role : undefined;
    if (approvalRole && reservation.observer !== true) {
      throw new SynodError(ERROR_CODES.DELEGATION_INVALID, `${approvalRole} reservations must be observer-only.`, {
        details: { taskId, role: approvalRole, reservation }
      });
    }
    if (approvalRole) assertApprovalScopes(task, approvalRole, reservation.scopes);
    if (Date.parse(context.timestamp) >= Date.parse(reservation.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_RESERVATION_STALE, "The writer reservation expired before owner binding.", {
        details: { taskId, expiresAt: reservation.expiresAt, observedAt: context.timestamp }
      });
    }
    await validateLeaseScopeFilesystemPaths(targetDirectory, reservation.scopes);
    reservationScopeConflicts(state, taskId, reservation.scopes, reservation.id);
    const baseline = leaseBaselineFor(task, reservation, context.leaseBaselines);
    if (baseline.snapshot.contentHash !== reservation.baseline.snapshotContentHash) {
      throw new SynodError(ERROR_CODES.LEASE_BASELINE_INVALID, `Task ${taskId} reservation baseline identity is invalid.`, {
        details: { taskId, expected: reservation.baseline.snapshotContentHash, actual: baseline.snapshot.contentHash }
      });
    }
    assertReservationBaselineUnchanged(task, reservation, baseline.snapshot, context.snapshot);
    if (task.state === "READY") {
      const incomplete = task.dependsOn.filter(dependency => state.tasks[dependency]?.state !== "DONE");
      if (incomplete.length > 0) {
        throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} has incomplete dependencies.`, {
          details: { taskId, incomplete }
        });
      }
    }
    const fromState = task.state;
    const observerLease = reservation.observer === true;
    const references = !observerLease && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)
      ? requireEvidence(task, "ACTIVE", evidence)
      : [];
    const createdEvidence = references.length > 0
      ? recordEvidence(state, task, "correction", task.revision, references, actor, context)
      : [];
    if (!observerLease && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) {
      task.correctionRound += 1;
      task.correctionPolicy.used += 1;
      resetAcceptanceAndVerification(task);
      delete task.proposal;
    }
    const lease: TaskLease = {
      id: reservation.id,
      generation: reservation.generation,
      taskId,
      taskRevision: reservation.taskRevision,
      ownerThread: owner,
      executor: reservation.executor,
      ...(reservation.role === undefined ? {} : { role: reservation.role }),
      scopes: reservation.scopes,
      ...(reservation.observer === true ? { observer: true as const } : {}),
      acquiredAt: context.timestamp,
      heartbeatAt: context.timestamp,
      expiresAt: leaseDeadline(context.timestamp, ttl),
      heartbeatIntervalSeconds: heartbeat,
      ttlSeconds: ttl,
      baseline: reservation.baseline,
      status: "ACTIVE"
    };
    delete task.leaseReservation;
    task.lease = lease;
    if (!observerLease) {
      task.state = "ACTIVE";
      delete task.preLease;
      delete task.blocker;
      delete task.blockedFrom;
    }
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        fromState,
        ...(observerLease ? {} : { toState: "ACTIVE" as const }),
        revision: task.revision,
        payload: {
          leaseId: lease.id,
          generation: lease.generation,
          ownerThread: lease.ownerThread,
          reservedAt: reservation.reservedAt,
          acquiredAt: lease.acquiredAt,
          baselineHash: lease.baseline.snapshotContentHash,
          evidenceIds: createdEvidence.map(item => item.id),
          writeAuthorized: !observerLease,
          ...(reservation.role === undefined ? {} : { role: reservation.role })
        }
      },
      result: { task, lease, writeAuthorized: !observerLease as false | true, evidence: createdEvidence }
    };
  }, dependencies);
}

async function endTaskLeaseReservation(
  action: "cancel" | "expire",
  {
    directory = ".",
    id,
    reservationToken,
    leaseId,
    generation,
    revision,
    expectedReservedAt,
    baselineHash,
    actor = "supervisor",
    reason
  }: LeaseReservationIdentityOptions = {},
  dependencies: OrchestrationDependencies = {}
) {
  const taskId = taskIdValue(id);
  const explanation = String(reason || "").trim();
  if (!explanation) throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease reservation ${action} requires --reason.`);
  return commitMutation(path.resolve(directory), `lease.reservation-${action === "cancel" ? "cancelled" : "expired"}`, { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    const reservation = requireLeaseReservationIdentity(task, {
      reservationToken, leaseId, generation, revision, expectedReservedAt, baselineHash
    });
    if (action === "expire" && Date.parse(context.timestamp) < Date.parse(reservation.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_NOT_EXPIRED, `Task ${taskId} reservation has not reached its expiry deadline.`, {
        details: { taskId, expiresAt: reservation.expiresAt, observedAt: context.timestamp }
      });
    }
    delete task.leaseReservation;
    task.updatedAt = context.timestamp;
    const leaseBaselines = validateLeaseBaselinesLedger({
      ...context.leaseBaselines,
      baselines: context.leaseBaselines.baselines.filter(item =>
        item.leaseId !== reservation.id || item.generation !== reservation.generation
      )
    });
    return {
      leaseBaselines,
      metadata: {
        revision: task.revision,
        payload: {
          leaseId: reservation.id,
          generation: reservation.generation,
          reservedAt: reservation.reservedAt,
          reason: explanation,
          writeAuthorized: false
        }
      },
      result: { task, reservation, writeAuthorized: false as const }
    };
  }, dependencies);
}

export function cancelTaskLeaseReservation(options: LeaseReservationIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  return endTaskLeaseReservation("cancel", options, dependencies);
}

export function expireTaskLeaseReservation(options: LeaseReservationIdentityOptions = {}, dependencies: OrchestrationDependencies = {}) {
  return endTaskLeaseReservation("expire", options, dependencies);
}

export interface AcquireLeaseOptions {
  directory?: string;
  id?: string;
  ownerThread?: string;
  read?: unknown[];
  write?: unknown[];
  readTree?: unknown[];
  writeTree?: unknown[];
  observer?: boolean;
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
  observer,
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  actor = "supervisor"
}: AcquireLeaseOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const owner = String(ownerThread || "").trim();
  const ttl = parseLeaseDuration(ttlSeconds, "ttlSeconds");
  const heartbeat = parseLeaseDuration(heartbeatIntervalSeconds, "heartbeatIntervalSeconds");
  if (!owner) throw new SynodError(ERROR_CODES.LEASE_INVALID, "A writer lease requires --owner-thread.");
  if (observer !== undefined && observer !== true) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "Observer mode must be requested with a true observer flag.");
  }
  const observerRequested = observer === true;
  if (observerRequested && (write.length > 0 || writeTree.length > 0)) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, "An observer lease cannot contain write scopes.");
  }
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
  const scopes = normalizeLeaseScopes({ read, write, readTree, writeTree }, { observer: observerRequested });
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "lease.acquired", { actor, taskId }, async (state, context) => {
    if (!context.snapshot.available || !context.snapshot.head) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, `A ${observerRequested ? "observer" : "writer"} lease requires an exact Git HEAD and worktree snapshot.`, {
        details: { taskId, branch: context.snapshot.branch, head: context.snapshot.head }
      });
    }
    await validateLeaseScopeFilesystemPaths(targetDirectory, scopes);
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    assertBudgetAllowsExecution(task, observerRequested ? "observer lease acquisition" : "writer lease acquisition");
    const eligible = task.state === "READY"
      || (task.state === "ACTIVE" && task.preLease)
      || ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state)
      || (task.state === "BLOCKED" && (
        task.blockedFrom === "ACTIVE"
        || (task.preLease && leaseMigrationState(task.blockedFrom))
      ));
    if (!eligible) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Task ${taskId} cannot acquire an ${observerRequested ? "observer" : "writer"} lease from ${task.state}.`, {
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
    if (task.leaseReservation) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} already has an unbound writer reservation.`, {
        details: { taskId, leaseId: task.leaseReservation.id, generation: task.leaseReservation.generation }
      });
    }
    if (!observerRequested) assertConcurrencyCapacity(state, taskId);
    for (const other of taskList(state)) {
      const leaseCollisions = other.lease
        ? scopes.filter(scope => other.lease?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const recoveryCollisions = other.id !== taskId && other.recovery?.status === "PENDING"
        ? scopes.filter(scope => other.recovery?.endedLease.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const reservationCollisions = other.leaseReservation
        ? scopes.filter(scope => other.leaseReservation?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const proposalCollisions = other.id !== taskId && proposalReservesPaths(other) && other.proposal
        ? scopes.filter(scope => scope.access === "write" && other.proposal?.ownedPaths.some(candidate =>
          leaseScopeCoversPath(scope, candidate)
        ))
        : [];
      const collisions = [...leaseCollisions, ...reservationCollisions, ...recoveryCollisions, ...proposalCollisions];
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
      ...(observerRequested ? { observer: true as const } : {}),
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
      ...(currentTask.leaseReservation ? [currentTask.leaseReservation] : []),
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
    assertBudgetAllowsExecution(task, "writer lease heartbeat");
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
    if (action === "resume" || action === "reassign") assertBudgetAllowsExecution(task, `lease ${action}`);
    if (action === "supersede") assertBudgetStructuralDecision(task, "supersede");
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
      const reservationCollisions = other.leaseReservation
        ? ended.scopes.filter(scope => other.leaseReservation?.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const recoveryCollisions = other.recovery?.status === "PENDING"
        ? ended.scopes.filter(scope => other.recovery?.endedLease.scopes.some(existing => leaseScopesOverlap(scope, existing)))
        : [];
      const proposalCollisions = proposalReservesPaths(other) && other.proposal
        ? ended.scopes.filter(scope => scope.access === "write" && other.proposal?.ownedPaths.some(candidate =>
          leaseScopeCoversPath(scope, candidate)
        ))
        : [];
      const collisions = [...leaseCollisions, ...reservationCollisions, ...recoveryCollisions, ...proposalCollisions];
      if (collisions.length > 0) {
        throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} recovery scope overlaps task ${other.id}.`, {
          details: { taskId, conflictingTaskId: other.id, paths: [...new Set(collisions.map(scope => scope.path))] }
        });
      }
    }
    const sealed = await sealTaskProposal(targetDirectory, state, task, ended, task.revision + 1, context, dependencies, { allowEmpty: true });
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

function requireExactTaskRevision(task: OrchestrationTask, revision: unknown, operation: string): asserts revision is number {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || revision !== task.revision) {
    throw new SynodError(ERROR_CODES.REVISION_MISMATCH, `Task ${task.id} ${operation} requires revision ${task.revision}, received ${String(revision)}.`, {
      details: { taskId: task.id, expected: task.revision, actual: revision, current: task.revision, operation }
    });
  }
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
  if (task.approvals !== undefined) task.approvals = [];
}

export interface RecordTaskApprovalOptions {
  directory?: string;
  id?: string;
  role?: Exclude<DelegationRole, "implementer">;
  decision?: ApprovalDecision;
  revision?: number;
  proposalBundleId?: string;
  ownerThread?: string;
  evidence?: unknown[];
  actor?: string;
}

/** Record one exact, append-only reviewer or verifier decision. */
export async function recordTaskApproval({
  directory = ".",
  id,
  role,
  decision,
  revision,
  proposalBundleId,
  ownerThread,
  evidence = [],
  actor = "supervisor"
}: RecordTaskApprovalOptions = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = taskIdValue(id);
  const approvalRole = role === "reviewer" || role === "verifier" ? role : undefined;
  const choice = decision === "approved" || decision === "rejected" ? decision : undefined;
  const owner = typeof ownerThread === "string" ? ownerThread.trim() : "";
  const principal = typeof actor === "string" ? actor.trim() : "";
  const requestedBundle = typeof proposalBundleId === "string" ? proposalBundleId.trim() : "";
  const validEvidence = Array.isArray(evidence)
    && evidence.length > 0
    && evidence.every(value => typeof value === "string" && value.trim().length > 0);
  const references = validEvidence
    ? [...new Set(evidence.map(value => (value as string).trim()))]
    : [];
  if (!approvalRole || !choice || !owner || !principal || !Number.isSafeInteger(revision) || revision! < 0
    || !requestedBundle || references.length === 0) {
    throw new SynodError(ERROR_CODES.APPROVAL_INVALID, "Approval requires role, decision, exact revision, proposal bundle, owner thread, actor, and evidence.", {
      details: { taskId, role: role ?? null, decision: decision ?? null, revision: revision ?? null }
    });
  }
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "task.approval-recorded", { actor: principal, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    requireExactTaskRevision(task, revision, "approval");
    const proposal = approvalProposal(task, approvalRole);
    const bundleId = requestedBundle;
    if (bundleId !== proposal.bundleId) {
      throw new SynodError(ERROR_CODES.APPROVAL_STALE, `Task ${taskId} approval proposal bundle is stale.`, {
        details: { taskId, role: approvalRole, revision, expectedProposalBundleId: proposal.bundleId, actualProposalBundleId: bundleId }
      });
    }
    if (!task.lease) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} approval requires its bound observer lease.`, {
        details: { taskId, role: approvalRole, ownerThread: owner }
      });
    }
    if (task.lease.observer !== true || task.lease.role !== approvalRole || task.lease.ownerThread !== owner) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} approval owner does not match its observer lease.`, {
        details: { taskId, role: approvalRole, ownerThread: owner, lease: task.lease }
      });
    }
    if (Date.parse(context.timestamp) >= Date.parse(task.lease.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} approval observer lease has expired.`, {
        details: { taskId, leaseId: task.lease.id, expiresAt: task.lease.expiresAt }
      });
    }
    const existing = task.approvals || [];
    const duplicate = existing.find(item => item.role === approvalRole
      && item.revision === revision
      && item.proposalBundleId === bundleId);
    if (duplicate) {
      throw new SynodError(ERROR_CODES.APPROVAL_CONFLICT, `Task ${taskId} already has a ${approvalRole} approval for this revision and proposal.`, {
        details: { taskId, role: approvalRole, revision, proposalBundleId: bundleId, existing: duplicate }
      });
    }
    const approval: TaskApprovalRecord = {
      event: context.event,
      role: approvalRole,
      decision: choice,
      ownerThread: owner,
      revision,
      proposalBundleId: bundleId,
      evidence: references,
      actor: principal,
      recordedAt: context.timestamp
    };
    task.approvalPolicy = "typed";
    task.approvals = [...existing, approval];
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        revision,
        payload: { approval }
      },
      result: { task, approval }
    };
  }, dependencies);
}

export const recordApproval = recordTaskApproval;

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
    if (["READY", "ACTIVE"].includes(targetState)) assertBudgetAllowsExecution(task, `transition to ${targetState}`);
    if (targetState === "SUPERSEDED") assertBudgetStructuralDecision(task, "supersede");
    if (task.recovery?.status === "PENDING") {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} requires an explicit abandoned-owner recovery decision before any transition.`, {
        details: { taskId, leaseId: task.recovery.endedLease.id, generation: task.recovery.endedLease.generation }
      });
    }
    if (task.leaseReservation) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} has an unbound writer reservation; bind or cancel it before transitioning.`, {
        details: { taskId, leaseId: task.leaseReservation.id, generation: task.leaseReservation.generation, targetState }
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
    const reviewerTransition = task.state === "REVIEW" && targetState === "ACCEPTED";
    const verifierTransition = task.state === "ACCEPTED" && targetState === "VERIFIED";
    const typedApprovalState = task.approvals !== undefined
      || task.lease?.role === "reviewer"
      || task.lease?.role === "verifier";
    if ((reviewerTransition || verifierTransition)
      && task.approvalPolicy !== "typed"
      && typedApprovalState) {
      throw new SynodError(ERROR_CODES.APPROVAL_REQUIRED, `Task ${task.id} has typed approval data without a durable approval policy.`, {
        details: { taskId: task.id, targetState, revision, approvalPolicy: task.approvalPolicy ?? null }
      });
    }
    const approvalLane = task.approvalPolicy === "typed";
    const reviewerApproval = reviewerTransition && approvalLane
      ? requireApproval(task, "reviewer", revision)
      : undefined;
    const verifierApproval = verifierTransition && approvalLane
      ? requireApproval(task, "verifier", revision)
      : undefined;
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
    const approvalLease = task.lease
      && task.lease.observer === true
      && ((task.lease.role === "reviewer" && targetState === "ACCEPTED")
        || (task.lease.role === "verifier" && targetState === "VERIFIED"))
      ? task.lease
      : undefined;
    if (["ACCEPTED", "VERIFIED", "DONE"].includes(targetState) && task.lease && !approvalLease) {
      throw new SynodError(ERROR_CODES.LEASE_CONFLICT, `Task ${taskId} must release its reserved writer lease before ${targetState}.`, {
        details: { taskId, leaseId: task.lease.id, generation: task.lease.generation }
      });
    }

    const fromState = task.state;
    const deliveredLease = fromState === "ACTIVE" && targetState === "REVIEW" ? task.lease : undefined;
    const releasedLease = deliveredLease
      || approvalLease
      || (targetState === "BLOCKED" && fromState !== "ACTIVE" ? task.lease : undefined);
    if (fromState === "ACTIVE" && targetState === "REVIEW" && !deliveredLease) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} cannot deliver without its active writer lease.`, {
        details: { taskId, revision }
      });
    }
    if (deliveredLease && deliveredLease.observer === true) {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} cannot deliver under an observer lease; a writer lease is required.`, {
        details: { taskId, revision }
      });
    }
    const sealed = deliveredLease
      ? await sealTaskProposal(targetDirectory, state, task, deliveredLease, revision, context, dependencies)
      : undefined;
    const acceptanceForeign = fromState === "REVIEW" && targetState === "ACCEPTED"
      ? await verifyTaskProposalForAcceptance(targetDirectory, state, task, context, dependencies)
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
      if (reviewerApproval) reviewerApproval.consumedAt = context.timestamp;
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
      if (verifierApproval) verifierApproval.consumedAt = context.timestamp;
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

export async function submitTaskProposal({
  directory = ".",
  id,
  evidence = [],
  actor = "supervisor"
}: { directory?: string; id?: string; evidence?: unknown[]; actor?: string } = {}, dependencies: OrchestrationDependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const canonical = await readOrchestration(path.resolve(directory));
  const task = canonical.state.tasks[taskId];
  if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  if (task.state !== "ACTIVE" || !task.lease || task.lease.status !== "ACTIVE") {
    throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} requires an active bound writer lease before proposal submission.`, {
      details: { taskId, state: task.state, hasLease: Boolean(task.lease) }
    });
  }
  if (task.lease.observer === true) {
    throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} proposal submission requires a writer lease; observer leases are read-only.`, {
      details: { taskId, state: task.state, leaseId: task.lease.id }
    });
  }
  return transitionTask({
    directory,
    id: taskId,
    to: "REVIEW",
    revision: task.revision + 1,
    evidence,
    actor
  }, dependencies);
}

export interface RecordTaskCorrectionOptions {
  directory?: string;
  id?: string;
  revision: number;
  reason?: string;
  evidence?: unknown[];
  actor?: string;
}

/**
 * Record supervisor feedback while a worker is still ACTIVE. This mutation is
 * intentionally separate from proposal submission: the correction allowance
 * is consumed before any material is sealed for review.
 */
export async function recordTaskCorrection(
  options: RecordTaskCorrectionOptions | undefined = undefined,
  dependencies: OrchestrationDependencies = {}
) {
  const {
    directory = ".",
    id,
    revision,
    reason,
    evidence = [],
    actor = "supervisor"
  } = options ?? {};
  const taskId = taskIdValue(id);
  const explanation = String(reason || "").trim();
  const references = [...new Set(evidence.map(value => String(value).trim()).filter(Boolean))];
  if (!explanation) throw new SynodError(ERROR_CODES.TASK_INVALID, "Task correction requires --reason.");
  if (references.length === 0) throw new SynodError(ERROR_CODES.EVIDENCE_REQUIRED, "Task correction requires at least one --evidence reference.");
  return commitMutation(path.resolve(directory), "task.corrected", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (task.state !== "ACTIVE") {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} can receive supervisor correction only while ACTIVE.`, {
        details: { taskId, state: task.state }
      });
    }
    requireExactTaskRevision(task, revision, "correction");
    assertBudgetAllowsExecution(task, "recording a task correction");
    if (task.correctionPolicy.used >= task.correctionPolicy.limit) {
      throw new SynodError(ERROR_CODES.CORRECTION_EXHAUSTED, `Task ${taskId} has exhausted its correction allowance.`, {
        details: { taskId, used: task.correctionPolicy.used, limit: task.correctionPolicy.limit }
      });
    }
    const lease = task.lease;
    if (!lease || lease.status !== "ACTIVE") {
      throw new SynodError(ERROR_CODES.LEASE_REQUIRED, `Task ${taskId} requires an active writer lease before correction.`, {
        details: { taskId, state: task.state }
      });
    }
    if (Date.parse(context.timestamp) >= Date.parse(lease.expiresAt)) {
      throw new SynodError(ERROR_CODES.LEASE_STALE, `Task ${taskId} writer lease has expired.`, {
        details: { taskId, leaseId: lease.id, generation: lease.generation, expiresAt: lease.expiresAt }
      });
    }
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
    const scoped = proposalSnapshot(context.snapshot, classified.owned, baseline.capturedAt);
    const createdEvidence = recordEvidence(state, task, "correction", task.revision, references, actor, context);
    task.correctionRound += 1;
    task.correctionPolicy.used += 1;
    resetAcceptanceAndVerification(task);
    const correction: TaskCorrectionRecord = {
      round: task.correctionRound,
      revision: task.revision,
      reason: explanation,
      evidence: references,
      evidenceIds: createdEvidence.map(item => item.id),
      scopeFingerprint: scoped.worktreeFingerprint,
      paths: [...new Set(classified.owned.flatMap(deltaPaths))].sort(compareCheckpointPaths),
      pathEvidence: scopedPathEvidence(classified.owned),
      recordedAt: context.timestamp
    };
    task.correctionHistory = [...(task.correctionHistory || []), correction];
    task.updatedAt = context.timestamp;
    return {
      metadata: {
        fromState: "ACTIVE",
        toState: "ACTIVE",
        revision: task.revision,
        payload: {
          correction,
          evidenceIds: createdEvidence.map(item => item.id),
          foreignPaths: classified.foreign.flatMap(deltaPaths)
        }
      },
      result: { task, correction, evidence: createdEvidence }
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

async function orchestrationStatusFromCanonical(
  targetDirectory: string,
  canonical: Awaited<ReturnType<typeof readOrchestrationRaw>>,
  {
    explain = false,
    taskId,
    activeOnly = false,
    changedSinceCheckpoint = false
  }: Pick<OrchestrationStatusOptions, "explain" | "taskId" | "activeOnly" | "changedSinceCheckpoint">,
  dependencies: OrchestrationDependencies = {}
): Promise<OrchestrationStatusResult> {
  let state: OrchestrationState;
  let events: OrchestrationEvent[];
  let markdown: string;
  let currentCheckpoint: GitCheckpoint;
  let delta: CheckpointDelta | undefined;
  ({ state, events } = canonical);
  const allTasks = taskList(state);
  const selectorCount = Number(taskId !== undefined) + Number(activeOnly) + Number(changedSinceCheckpoint);
  if (selectorCount > 1 || (selectorCount > 0 && explain)) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Status selectors are mutually exclusive and cannot be combined with --explain.", {
      details: {
        taskId,
        activeOnly,
        changedSinceCheckpoint,
        explain
      }
    });
  }
  const selectedTask = taskId === undefined ? undefined : allTasks.find(task => task.id === taskId);
  if (taskId !== undefined && !selectedTask) {
    throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
  }
  const selector: OrchestrationStatusSelection["type"] | undefined = taskId !== undefined
    ? "task"
    : activeOnly
      ? "active-only"
      : changedSinceCheckpoint
        ? "changed-since-checkpoint"
        : undefined;
  const selectedTasks = selector === "task" && selectedTask
    ? [selectedTask]
    : selector === "active-only"
      ? allTasks.filter(task => !TERMINAL_STATES.has(task.state))
      : selector === "changed-since-checkpoint"
        ? []
        : allTasks;
  const visibleTasks = selector === undefined
    ? allTasks
    : selector === "changed-since-checkpoint"
      ? []
      : selectedTasks.slice(0, STATUS_TASK_LIMIT).map(boundedStatusTask);
  const selection: OrchestrationStatusSelection | undefined = selector === undefined
    ? undefined
    : {
        type: selector,
        ...(taskId === undefined ? {} : { taskId }),
        rationale: selector === "task"
          ? "Exact task identity; task history arrays are bounded to the most recent entries."
          : selector === "active-only"
            ? "Operationally open, nonterminal tasks only; DONE and SUPERSEDED are excluded while PLANNED, READY, ACTIVE, REVIEW, ACCEPTED, VERIFIED, and BLOCKED remain visible for follow-up."
            : "Closeout path delta from the acknowledged checkpoint; task histories are omitted and path entries are bounded.",
        bounded: true,
        taskCount: visibleTasks.length,
        totalTaskCount: selector === "changed-since-checkpoint" ? allTasks.length : selectedTasks.length,
        ...(selector === "task" || selector === "active-only" ? {
          tasksTruncated: selectedTasks.length > STATUS_TASK_LIMIT,
          historyLimit: STATUS_HISTORY_LIMIT
        } : {})
      };
    markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
    const current = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
    currentCheckpoint = current.checkpoint;
    if (explain || changedSinceCheckpoint) {
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
  if (changedSinceCheckpoint && delta && selection) {
    const pathCount = delta.paths.length;
    selection.pathCount = pathCount;
    selection.pathsTruncated = pathCount > STATUS_PATH_LIMIT;
    delta = boundedStatusDelta(delta);
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
  const [runtimeRead, manifestRead] = await Promise.allSettled([
    readLocalRuntimeDescriptor(targetDirectory),
    readManifest(targetDirectory, { required: false })
  ]);
  const localRuntimeDescriptor = runtimeRead.status === "fulfilled" ? runtimeRead.value : undefined;
  const rawManifest = manifestRead.status === "fulfilled" ? manifestRead.value : undefined;
  const counts = taskStateCounts(selector && selector !== "changed-since-checkpoint" ? selectedTasks : allTasks);
  const candidateTasks = selector === undefined || selector === "changed-since-checkpoint" ? allTasks : selectedTasks;
  const leaseExpiryCandidates = candidateTasks.flatMap(task => task.lease && Date.parse(currentCheckpoint.capturedAt) >= Date.parse(task.lease.expiresAt)
    ? [{
        taskId: task.id,
        leaseId: task.lease.id,
        generation: task.lease.generation,
        heartbeatAt: task.lease.heartbeatAt,
        expiresAt: task.lease.expiresAt
      }]
    : []);
  const leaseReservationExpiryCandidates = candidateTasks.flatMap(task => task.leaseReservation
    && Date.parse(currentCheckpoint.capturedAt) >= Date.parse(task.leaseReservation.expiresAt)
    ? [{
        taskId: task.id,
        leaseId: task.leaseReservation.id,
        generation: task.leaseReservation.generation,
        reservedAt: task.leaseReservation.reservedAt,
        expiresAt: task.leaseReservation.expiresAt
      }]
    : []);
  return {
    targetDirectory,
    healthy: !drift.detected,
    stateSchemaVersion: state.schemaVersion,
    runtimeVersion: localRuntimeDescriptor?.runtimeVersion || null,
    installedTemplateVersion: rawManifest?.templateVersion || null,
    manifestSchemaVersion: rawManifest?.schemaVersion || null,
    stateTemplateVersion: state.templateVersion,
    templateVersion: state.templateVersion,
    updatedAt: state.updatedAt,
    lastEvent: state.lastEvent,
    eventCount: events.length,
    checkpoint: state.checkpoint,
    currentCheckpoint,
    drift,
    taskCounts: counts,
    tasks: visibleTasks,
    rotation: state.rotation || null,
    leaseExpiryCandidates,
    leaseReservationExpiryCandidates,
    markdownView: ORCHESTRATION_STATUS_PATH,
    ...(selection ? { selection } : {}),
    ...(delta ? { delta } : {})
  };
}

export async function orchestrationStatus(
  {
    directory = ".",
    explain = false,
    readOnly = false,
    taskId,
    activeOnly = false,
    changedSinceCheckpoint = false
  }: OrchestrationStatusOptions = {},
  dependencies: OrchestrationDependencies = {}
): Promise<OrchestrationStatusResult> {
  const targetDirectory = path.resolve(directory);
  return await withOrchestrationSnapshot(
    targetDirectory,
    canonical => orchestrationStatusFromCanonical(targetDirectory, canonical, {
      explain,
      activeOnly,
      changedSinceCheckpoint,
      ...(taskId === undefined ? {} : { taskId })
    }, dependencies),
    { readOnly }
  );
}

export async function orchestrationStatusWithArtifacts(
  {
    directory = ".",
    explain = false,
    readOnly = false,
    taskId,
    activeOnly = false,
    changedSinceCheckpoint = false
  }: OrchestrationStatusOptions = {},
  dependencies: OrchestrationDependencies = {}
) {
  const targetDirectory = path.resolve(directory);
  return await withOrchestrationSnapshot(targetDirectory, async canonical => {
    const [status, proposals, worktreeModule] = await Promise.all([
      orchestrationStatusFromCanonical(targetDirectory, canonical, {
        explain,
        activeOnly,
        changedSinceCheckpoint,
        ...(taskId === undefined ? {} : { taskId })
      }, dependencies),
      validateOrchestrationProposalArtifactsFromCanonical(targetDirectory, canonical),
      import("./worktrees.js")
    ]);
    const worktrees = await worktreeModule.validateTaskWorktreeArtifacts({ directory: targetDirectory });
    return { ...status, artifacts: { proposals, worktrees } };
  }, { readOnly });
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
  if (result.selection) {
    const taskLabel = result.selection.taskId ? ` ${result.selection.taskId}` : "";
    lines.push(`Selection: ${result.selection.type}${taskLabel}; ${result.selection.rationale}`);
    lines.push(`Bounded selection: ${result.selection.taskCount}/${result.selection.totalTaskCount} task(s)${result.selection.tasksTruncated ? "; tasks truncated" : ""}${result.selection.pathsTruncated ? `; ${result.selection.pathCount} path(s), list truncated` : result.selection.pathCount === undefined ? "" : `; ${result.selection.pathCount} path(s)`}.`);
  }
  lines.push(`State schema: ${result.stateSchemaVersion}; events: ${result.eventCount}`);
  lines.push(`Runtime: ${result.runtimeVersion || "external"}`);
  lines.push(`Installed template: ${result.installedTemplateVersion || "unavailable"} (manifest schema ${result.manifestSchemaVersion ?? "unknown"})`);
  lines.push(`State template: ${result.stateTemplateVersion}`);
  lines.push(`Checkpoint: ${checkpointLabel(result.checkpoint)}`);
  lines.push(`Current: ${checkpointLabel(result.currentCheckpoint)}`);
  lines.push(`Phase rotation: ${result.rotation ? `policy r${result.rotation.policy.revision}; session ${currentRotationPhase(result.rotation).rootSessionId}; ${result.rotation.recommendations.length} recommendation(s); ${result.rotation.verifications.length} verified` : "not configured"}`);
  for (const task of result.tasks) {
    const lease = task.lease
      ? `lease ${task.lease.id} g${task.lease.generation} owner ${task.lease.ownerThread} expires ${task.lease.expiresAt}`
      : task.leaseReservation
        ? `reservation ${task.leaseReservation.id} g${task.leaseReservation.generation} write-authorized no expires ${task.leaseReservation.expiresAt}`
        : task.preLease ? "lease migration required" : "no writer lease";
    const recovery = task.recovery
      ? `; recovery ${task.recovery.status} prior ${task.recovery.endedLease.ownerThread} g${task.recovery.endedLease.generation} proposal ${task.recovery.proposal?.bundleId || "unsealed"}`
      : "";
    lines.push(`${task.id.padEnd(12)} ${task.state.padEnd(10)} r${task.revision} corrections ${task.correctionPolicy.used}/${task.correctionPolicy.limit} executor ${task.executor}; acceptance ${task.acceptance.status}; verification ${task.verification.status}; ${lease}${recovery}`);
  }
  for (const candidate of result.leaseExpiryCandidates) {
    lines.push(`Expiry candidate: ${candidate.taskId} lease ${candidate.leaseId} g${candidate.generation}; heartbeat ${candidate.heartbeatAt}; expired ${candidate.expiresAt}`);
  }
  for (const candidate of result.leaseReservationExpiryCandidates) {
    lines.push(`Reservation expiry candidate: ${candidate.taskId} lease ${candidate.leaseId} g${candidate.generation}; reserved ${candidate.reservedAt}; expired ${candidate.expiresAt}`);
  }
  if (result.tasks.length === 0) {
    lines.push(result.selection ? "No tasks match this status selector." : "No tasks recorded.");
  }
  for (const reason of result.drift.reasons) lines.push(`Drift ${reason.field}: expected ${reason.expected}, actual ${reason.actual}`);
  if (result.delta) lines.push(...formatCheckpointDelta(result.delta));
  return lines.join("\n");
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
