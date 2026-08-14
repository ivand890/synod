import { createHash } from "node:crypto";
import { usageReportHash } from "./budgets.js";
import type { BudgetMutationIdentity, CanonicalEventIdentity } from "./budgets.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { collectUsage } from "./usage.js";
import type { UsageClient, UsageReport } from "./usage.js";
import { isRecord } from "./validation.js";

export const ROTATION_METRICS = Object.freeze([
  "supervisor-context-percent",
  "compactions",
  "wait-calls",
  "wait-duration-ms",
  "completed-tasks"
] as const);

export type RotationMetricName = typeof ROTATION_METRICS[number];

export interface RotationThresholds {
  supervisorContextPercent?: number;
  compactions?: number;
  waitCalls?: number;
  waitDurationMs?: number;
  completedTasks?: number;
}

export interface RotationPolicy {
  revision: number;
  rootSessionId: string;
  startEvent: CanonicalEventIdentity;
  thresholds: RotationThresholds;
  actor: string;
  reason: string;
  evidence: string[];
  recordedAt: string;
}

export interface RotationCheckpointIdentity {
  capturedAt: string;
  branch: string | null;
  head: string | null;
  worktreeFingerprint: string;
  snapshotHash?: string;
}

export interface RotationHandoffIdentity {
  event: CanonicalEventIdentity;
  checkpoint: RotationCheckpointIdentity;
}

export interface RotationMetric {
  name: RotationMetricName;
  status: "available" | "partial" | "unavailable";
  threshold: number;
  current?: number;
  triggered: boolean;
  detail?: Record<string, number>;
}

export interface RotationRecommendation {
  policyRevision: number;
  event: BudgetMutationIdentity;
  reportHash: string;
  usageReportHash: string;
  rootSessionId: string;
  startEvent: CanonicalEventIdentity | BudgetMutationIdentity;
  capturedAt: string;
  handoff: RotationHandoffIdentity;
  metrics: RotationMetric[];
  reasons: RotationMetricName[];
  completeness: UsageReport["completeness"];
  completedTaskIds: string[];
  rollouts: Array<{ threadId: string; bytes: number; sha256: string }>;
}

export interface RotationVerification {
  policyRevision: number;
  event: BudgetMutationIdentity;
  recommendation: BudgetMutationIdentity;
  oldRootSessionId: string;
  newRootSessionId: string;
  newRootSessionCreatedAt: string;
  priorStartEvent: CanonicalEventIdentity | BudgetMutationIdentity;
  handoff: RotationHandoffIdentity;
  verifiedAt: string;
}

export interface ProjectRotation {
  policy: RotationPolicy;
  policyHistory: RotationPolicy[];
  recommendations: RotationRecommendation[];
  verifications: RotationVerification[];
}

export interface RotationReport {
  policy: RotationPolicy;
  phase: {
    rootSessionId: string;
    startEvent: CanonicalEventIdentity | BudgetMutationIdentity;
  };
  handoff: RotationHandoffIdentity;
  usageReportHash: string;
  reportHash: string;
  usage: UsageReport;
  metrics: RotationMetric[];
  recommended: boolean;
  reasons: RotationMetricName[];
  completedTaskIds: string[];
}

export interface RotationActionArgument {
  value: string | string[] | number | RotationThresholds | CanonicalEventIdentity | null;
  required: boolean;
}

export interface RotationTypedAction {
  operation: "rotation.set" | "rotation.report" | "rotation.prepare" | "rotation.verify";
  arguments: Record<string, RotationActionArgument>;
}

export interface RotationSuggestion {
  configured: boolean;
  phaseTaskCount: number;
  recommendedThresholds: RotationThresholds;
  observations: RotationMetric[];
  report?: RotationReport;
  nextAction: RotationTypedAction;
}

export function recommendedRotationThresholds(phaseTaskCount: number): RotationThresholds {
  const normalizedPhaseSize = Number.isSafeInteger(phaseTaskCount) && phaseTaskCount > 0 ? phaseTaskCount : 1;
  return {
    supervisorContextPercent: 80,
    compactions: 3,
    waitCalls: 50,
    completedTasks: Math.min(3, normalizedPhaseSize)
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isCanonicalEvent(value: unknown): value is CanonicalEventIdentity {
  return isRecord(value)
    && isPositiveInteger(value.sequence)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.hash);
}

function isMutationEvent(value: unknown): value is BudgetMutationIdentity {
  return isRecord(value)
    && isPositiveInteger(value.sequence)
    && isNonEmptyString(value.id)
    && (value.previousHash === null || isNonEmptyString(value.previousHash));
}

function isPhaseEvent(value: unknown): value is CanonicalEventIdentity | BudgetMutationIdentity {
  return isCanonicalEvent(value) || isMutationEvent(value);
}

export function isRotationThresholds(value: unknown): value is RotationThresholds {
  if (!isRecord(value)) return false;
  const allowed = new Set(["supervisorContextPercent", "compactions", "waitCalls", "waitDurationMs", "completedTasks"]);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  const thresholds = value as RotationThresholds;
  const entries = Object.entries(thresholds);
  return entries.length > 0
    && entries.every(([key, threshold]) => isPositiveInteger(threshold)
      && (key !== "supervisorContextPercent" || Number(threshold) <= 100));
}

export function isRotationPolicy(value: unknown): value is RotationPolicy {
  return isRecord(value)
    && isPositiveInteger(value.revision)
    && isNonEmptyString(value.rootSessionId)
    && isCanonicalEvent(value.startEvent)
    && isRotationThresholds(value.thresholds)
    && isNonEmptyString(value.actor)
    && isNonEmptyString(value.reason)
    && isStringArray(value.evidence)
    && isNonEmptyString(value.recordedAt)
    && Number.isFinite(Date.parse(value.recordedAt));
}

function isCheckpointIdentity(value: unknown): value is RotationCheckpointIdentity {
  return isRecord(value)
    && isNonEmptyString(value.capturedAt)
    && Number.isFinite(Date.parse(value.capturedAt))
    && (value.branch === null || isNonEmptyString(value.branch))
    && (value.head === null || isNonEmptyString(value.head))
    && isNonEmptyString(value.worktreeFingerprint)
    && (value.snapshotHash === undefined || isNonEmptyString(value.snapshotHash));
}

function isHandoffIdentity(value: unknown): value is RotationHandoffIdentity {
  return isRecord(value) && isCanonicalEvent(value.event) && isCheckpointIdentity(value.checkpoint);
}

function isRotationMetric(value: unknown): value is RotationMetric {
  return isRecord(value)
    && ROTATION_METRICS.includes(value.name as RotationMetricName)
    && ["available", "partial", "unavailable"].includes(String(value.status))
    && isPositiveInteger(value.threshold)
    && (value.current === undefined || (typeof value.current === "number" && Number.isFinite(value.current) && value.current >= 0))
    && typeof value.triggered === "boolean"
    && (!value.triggered || value.current !== undefined)
    && (value.detail === undefined || (isRecord(value.detail) && Object.values(value.detail).every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)));
}

export function isRotationRecommendation(value: unknown): value is RotationRecommendation {
  return isRecord(value)
    && isPositiveInteger(value.policyRevision)
    && isMutationEvent(value.event)
    && isNonEmptyString(value.reportHash)
    && isNonEmptyString(value.usageReportHash)
    && isNonEmptyString(value.rootSessionId)
    && isPhaseEvent(value.startEvent)
    && isNonEmptyString(value.capturedAt)
    && Number.isFinite(Date.parse(value.capturedAt))
    && isHandoffIdentity(value.handoff)
    && Array.isArray(value.metrics)
    && value.metrics.length > 0
    && value.metrics.every(isRotationMetric)
    && Array.isArray(value.reasons)
    && value.reasons.length > 0
    && value.reasons.every(item => ROTATION_METRICS.includes(item as RotationMetricName))
    && isRecord(value.completeness)
    && ["complete", "incomplete"].includes(String(value.completeness.status))
    && Array.isArray(value.completeness.reasons)
    && value.completeness.reasons.every(isNonEmptyString)
    && Array.isArray(value.completedTaskIds)
    && value.completedTaskIds.every(isNonEmptyString)
    && Array.isArray(value.rollouts)
    && value.rollouts.length > 0
    && value.rollouts.every(item => isRecord(item)
      && isNonEmptyString(item.threadId)
      && isNonNegativeInteger(item.bytes)
      && isNonEmptyString(item.sha256));
}

export function isRotationVerification(value: unknown): value is RotationVerification {
  return isRecord(value)
    && isPositiveInteger(value.policyRevision)
    && isMutationEvent(value.event)
    && isMutationEvent(value.recommendation)
    && isNonEmptyString(value.oldRootSessionId)
    && isNonEmptyString(value.newRootSessionId)
    && value.oldRootSessionId !== value.newRootSessionId
    && isNonEmptyString(value.newRootSessionCreatedAt)
    && Number.isFinite(Date.parse(value.newRootSessionCreatedAt))
    && isPhaseEvent(value.priorStartEvent)
    && isHandoffIdentity(value.handoff)
    && isNonEmptyString(value.verifiedAt)
    && Number.isFinite(Date.parse(value.verifiedAt));
}

function sameMutation(left: BudgetMutationIdentity, right: BudgetMutationIdentity): boolean {
  return left.sequence === right.sequence && left.id === right.id && left.previousHash === right.previousHash;
}

export function isProjectRotation(value: unknown): value is ProjectRotation {
  if (!isRecord(value)
    || !isRotationPolicy(value.policy)
    || !Array.isArray(value.policyHistory)
    || !value.policyHistory.every(isRotationPolicy)
    || !Array.isArray(value.recommendations)
    || !value.recommendations.every(isRotationRecommendation)
    || !Array.isArray(value.verifications)
    || !value.verifications.every(isRotationVerification)) return false;
  const rotation = value as unknown as ProjectRotation;
  const policies = [...rotation.policyHistory, rotation.policy];
  if (policies.some((policy, index) => policy.revision !== index + 1)) return false;
  let priorRecommendation = 0;
  for (const recommendation of rotation.recommendations) {
    if (!policies.some(policy => policy.revision === recommendation.policyRevision)
      || recommendation.event.sequence <= recommendation.handoff.event.sequence
      || recommendation.event.sequence <= priorRecommendation
      || recommendation.reasons.some(reason => !recommendation.metrics.some(metric => metric.name === reason && metric.triggered))) return false;
    priorRecommendation = recommendation.event.sequence;
  }
  const verifiedRecommendations = new Set<string>();
  let priorVerification = 0;
  for (const verification of rotation.verifications) {
    const recommendation = rotation.recommendations.find(item => sameMutation(item.event, verification.recommendation));
    const key = `${verification.recommendation.sequence}:${verification.recommendation.id}`;
    if (!recommendation
      || verification.policyRevision !== recommendation.policyRevision
      || verification.oldRootSessionId !== recommendation.rootSessionId
      || verification.event.sequence <= recommendation.event.sequence
      || verification.event.sequence <= priorVerification
      || verifiedRecommendations.has(key)) return false;
    verifiedRecommendations.add(key);
    priorVerification = verification.event.sequence;
  }
  return true;
}

export function currentRotationPhase(rotation: ProjectRotation): {
  rootSessionId: string;
  startEvent: CanonicalEventIdentity | BudgetMutationIdentity;
} {
  const verification = rotation.verifications.filter(item => item.policyRevision === rotation.policy.revision).at(-1);
  return verification
    ? { rootSessionId: verification.newRootSessionId, startEvent: verification.event }
    : { rootSessionId: rotation.policy.rootSessionId, startEvent: rotation.policy.startEvent };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
}

function metric(
  name: RotationMetricName,
  threshold: number,
  current: number | undefined,
  status: RotationMetric["status"] = "available",
  detail?: Record<string, number>
): RotationMetric {
  return {
    name,
    status: current === undefined ? "unavailable" : status,
    threshold,
    ...(current === undefined ? {} : { current }),
    triggered: current !== undefined && current >= threshold,
    ...(detail ? { detail } : {})
  };
}

export async function collectRotationReport({
  cwd,
  rotation,
  handoff,
  completedTaskIds,
  clientFactory,
  clock,
  collector = collectUsage
}: {
  cwd: string;
  rotation: ProjectRotation;
  handoff: RotationHandoffIdentity;
  completedTaskIds: string[];
  clientFactory?: () => UsageClient;
  clock?: () => Date | string | number;
  collector?: typeof collectUsage;
}): Promise<RotationReport> {
  const phase = currentRotationPhase(rotation);
  const usage = await collector({
    cwd,
    threadId: phase.rootSessionId,
    sinceEvent: phase.startEvent.id,
    ...(clientFactory ? { clientFactory } : {}),
    ...(clock ? { clock } : {})
  });
  if (usage.session.threadId !== phase.rootSessionId) {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation usage resolved to a different root session.", {
      details: { expectedRootSessionId: phase.rootSessionId, actualRootSessionId: usage.session.threadId }
    });
  }
  if (!usage.interval
    || usage.interval.start.event.sequence !== phase.startEvent.sequence
    || usage.interval.start.event.id !== phase.startEvent.id
    || usage.interval.end.kind !== "capture") {
    throw new SynodError(ERROR_CODES.ROTATION_STALE, "Rotation usage did not preserve the exact current-phase interval.", {
      details: { expectedStartEvent: phase.startEvent, actualInterval: usage.interval }
    });
  }
  const root = usage.threads.find(item => item.threadId === phase.rootSessionId && item.parentThreadId === null);
  const context = root?.currentContext;
  const thresholds = rotation.policy.thresholds;
  const metrics: RotationMetric[] = [];
  if (thresholds.supervisorContextPercent !== undefined) {
    const percent = context && context.modelContextWindow > 0
      ? (context.inputTokens / context.modelContextWindow) * 100
      : undefined;
    metrics.push(metric("supervisor-context-percent", thresholds.supervisorContextPercent, percent, "available",
      context ? { inputTokens: context.inputTokens, modelContextWindow: context.modelContextWindow } : undefined));
  }
  if (thresholds.compactions !== undefined) {
    metrics.push(metric("compactions", thresholds.compactions, usage.coordination.total.counts.compactions));
  }
  if (thresholds.waitCalls !== undefined) {
    metrics.push(metric("wait-calls", thresholds.waitCalls, usage.coordination.total.counts.wait));
  }
  if (thresholds.waitDurationMs !== undefined) {
    const duration = usage.coordination.total.waitDuration;
    metrics.push(metric("wait-duration-ms", thresholds.waitDurationMs, duration.totalMs, duration.status));
  }
  if (thresholds.completedTasks !== undefined) {
    metrics.push(metric("completed-tasks", thresholds.completedTasks, completedTaskIds.length));
  }
  const reasons = metrics.filter(item => item.triggered).map(item => item.name);
  const usageHash = usageReportHash(usage);
  const normalized = {
    policyRevision: rotation.policy.revision,
    phase,
    handoff,
    usageReportHash: usageHash,
    metrics,
    reasons,
    completeness: usage.completeness,
    completedTaskIds: [...completedTaskIds].sort(),
    rollouts: usage.threads.map(item => ({ threadId: item.threadId, rollout: item.rollout }))
      .sort((left, right) => left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0)
  };
  return {
    policy: rotation.policy,
    phase,
    handoff,
    usageReportHash: usageHash,
    reportHash: reportHash(normalized),
    usage,
    metrics,
    recommended: reasons.length > 0,
    reasons,
    completedTaskIds: [...completedTaskIds].sort()
  };
}

export function formatRotationReport(report: RotationReport): string {
  const metrics = report.metrics.map(item => {
    const current = item.current === undefined
      ? "unavailable"
      : item.name === "supervisor-context-percent"
        ? Math.round(item.current * 100) / 100
        : item.current;
    return `- ${item.name}: ${current}/${item.threshold} (${item.status})${item.triggered ? " TRIGGERED" : ""}`;
  });
  return [
    `Phase rotation: ${report.recommended ? "recommended" : "not recommended"}`,
    `Policy revision: ${report.policy.revision}`,
    `Session: ${report.phase.rootSessionId}`,
    `Start event: ${report.phase.startEvent.sequence}:${report.phase.startEvent.id}`,
    `Handoff event: ${report.handoff.event.sequence}:${report.handoff.event.id}`,
    `Completeness: ${report.usage.completeness.status}${report.usage.completeness.reasons.length > 0 ? ` (${report.usage.completeness.reasons.join(", ")})` : ""}`,
    ...metrics,
    `Report: ${report.reportHash}`
  ].join("\n");
}

export function formatRotationSuggestion(suggestion: RotationSuggestion): string {
  const observations = suggestion.observations.map(item => {
    const current = item.current === undefined ? "unavailable" : Math.round(item.current * 100) / 100;
    return `- ${item.name}: ${current}/${item.threshold} (${item.status})${item.triggered ? " TRIGGERED" : ""}`;
  });
  return [
    `Phase rotation preflight: ${suggestion.configured ? "configured" : "unconfigured"}`,
    `Canonical phase tasks: ${suggestion.phaseTaskCount}`,
    ...observations,
    `Next typed action: ${suggestion.nextAction.operation}`
  ].join("\n");
}
