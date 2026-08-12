import { createHash } from "node:crypto";
import { ERROR_CODES, SynodError } from "./errors.js";
import { collectUsage } from "./usage.js";
import type { UsageClient, UsageReport } from "./usage.js";
import { isRecord } from "./validation.js";

export const BUDGET_DECISION_ACTIONS = Object.freeze([
  "continue",
  "split",
  "supersede",
  "rotate"
] as const);

export type BudgetThresholdStatus = "within" | "soft-exceeded" | "decision-required";
export type BudgetDecisionAction = typeof BUDGET_DECISION_ACTIONS[number];

export interface CanonicalEventIdentity {
  sequence: number;
  id: string;
  hash: string;
}

export interface BudgetMutationIdentity {
  sequence: number;
  id: string;
  previousHash: string | null;
}

export interface TaskBudgetPolicy {
  revision: number;
  rootSessionId: string;
  startEvent: CanonicalEventIdentity;
  softTotalTokens?: number;
  hardTotalTokens?: number;
  actor: string;
  reason: string;
  evidence: string[];
  recordedAt: string;
}

export interface TaskBudgetObservation {
  policyRevision: number;
  event: BudgetMutationIdentity;
  reportHash: string;
  rootSessionId: string;
  startEvent: CanonicalEventIdentity;
  capturedAt: string;
  totalTokens: number;
  thresholdStatus: BudgetThresholdStatus;
  rollouts: Array<{
    threadId: string;
    bytes: number;
    sha256: string;
  }>;
}

export interface TaskBudgetDecision {
  policyRevision: number;
  event: BudgetMutationIdentity;
  observation: BudgetMutationIdentity;
  action: BudgetDecisionAction;
  actor: string;
  reason: string;
  evidence: string[];
  recordedAt: string;
  addedAllowance?: number;
}

export interface TaskBudget {
  policy: TaskBudgetPolicy;
  policyHistory: TaskBudgetPolicy[];
  observations: TaskBudgetObservation[];
  decisions: TaskBudgetDecision[];
  thresholdStatus: BudgetThresholdStatus;
}

export interface TaskBudgetReport {
  taskId: string;
  policy: TaskBudgetPolicy;
  effectiveHardTotalTokens?: number;
  reportHash: string;
  thresholdStatus: BudgetThresholdStatus;
  usage: UsageReport;
  warnings: Array<{
    code: "SYNOD_BUDGET_SOFT_EXCEEDED" | "SYNOD_BUDGET_HARD_EXCEEDED";
    message: string;
  }>;
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

export function isCanonicalEventIdentity(value: unknown): value is CanonicalEventIdentity {
  return isRecord(value)
    && isPositiveInteger(value.sequence)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.hash);
}

export function isBudgetMutationIdentity(value: unknown): value is BudgetMutationIdentity {
  return isRecord(value)
    && isPositiveInteger(value.sequence)
    && isNonEmptyString(value.id)
    && (value.previousHash === null || isNonEmptyString(value.previousHash));
}

export function isTaskBudgetPolicy(value: unknown): value is TaskBudgetPolicy {
  if (!isRecord(value)) return false;
  const soft = value.softTotalTokens;
  const hard = value.hardTotalTokens;
  return isPositiveInteger(value.revision)
    && isNonEmptyString(value.rootSessionId)
    && isCanonicalEventIdentity(value.startEvent)
    && (soft === undefined || isPositiveInteger(soft))
    && (hard === undefined || isPositiveInteger(hard))
    && (soft !== undefined || hard !== undefined)
    && !(soft !== undefined && hard !== undefined && soft >= hard)
    && isNonEmptyString(value.actor)
    && isNonEmptyString(value.reason)
    && isStringArray(value.evidence)
    && isNonEmptyString(value.recordedAt)
    && Number.isFinite(Date.parse(value.recordedAt));
}

export function isTaskBudgetObservation(value: unknown): value is TaskBudgetObservation {
  return isRecord(value)
    && isPositiveInteger(value.policyRevision)
    && isBudgetMutationIdentity(value.event)
    && isNonEmptyString(value.reportHash)
    && isNonEmptyString(value.rootSessionId)
    && isCanonicalEventIdentity(value.startEvent)
    && isNonEmptyString(value.capturedAt)
    && Number.isFinite(Date.parse(value.capturedAt))
    && isNonNegativeInteger(value.totalTokens)
    && ["within", "soft-exceeded", "decision-required"].includes(String(value.thresholdStatus))
    && Array.isArray(value.rollouts)
    && value.rollouts.length > 0
    && value.rollouts.every(item => isRecord(item)
      && isNonEmptyString(item.threadId)
      && isNonNegativeInteger(item.bytes)
      && isNonEmptyString(item.sha256));
}

export function isTaskBudgetDecision(value: unknown): value is TaskBudgetDecision {
  if (!isRecord(value)) return false;
  const action = String(value.action);
  return isPositiveInteger(value.policyRevision)
    && isBudgetMutationIdentity(value.event)
    && isBudgetMutationIdentity(value.observation)
    && BUDGET_DECISION_ACTIONS.includes(action as BudgetDecisionAction)
    && isNonEmptyString(value.actor)
    && isNonEmptyString(value.reason)
    && isStringArray(value.evidence)
    && isNonEmptyString(value.recordedAt)
    && Number.isFinite(Date.parse(value.recordedAt))
    && (action === "continue" ? isPositiveInteger(value.addedAllowance) : value.addedAllowance === undefined);
}

function sameMutationIdentity(left: BudgetMutationIdentity, right: BudgetMutationIdentity): boolean {
  return left.sequence === right.sequence && left.id === right.id && left.previousHash === right.previousHash;
}

export function isTaskBudget(value: unknown): value is TaskBudget {
  if (!isRecord(value)
    || !isTaskBudgetPolicy(value.policy)
    || !Array.isArray(value.policyHistory)
    || !value.policyHistory.every(isTaskBudgetPolicy)
    || !Array.isArray(value.observations)
    || !value.observations.every(isTaskBudgetObservation)
    || !Array.isArray(value.decisions)
    || !value.decisions.every(isTaskBudgetDecision)
    || !["within", "soft-exceeded", "decision-required"].includes(String(value.thresholdStatus))) return false;
  const budget = value as unknown as TaskBudget;
  const revisions = [...budget.policyHistory, budget.policy].map(item => item.revision);
  if (new Set(revisions).size !== revisions.length
    || revisions.some((revision, index) => revision !== index + 1)
    || budget.policy.revision !== revisions.length) return false;
  const observationIds = new Set(budget.observations.map(item => `${item.event.sequence}:${item.event.id}`));
  if (observationIds.size !== budget.observations.length) return false;
  const decisionIds = new Set<string>();
  for (const decision of budget.decisions) {
    const observation = budget.observations.find(item => sameMutationIdentity(item.event, decision.observation));
    if (!observation || observation.policyRevision !== decision.policyRevision
      || decision.event.sequence <= observation.event.sequence) return false;
    const key = `${decision.observation.sequence}:${decision.observation.id}`;
    if (decisionIds.has(key)) return false;
    decisionIds.add(key);
  }
  for (const observation of budget.observations) {
    const policy = [...budget.policyHistory, budget.policy].find(item => item.revision === observation.policyRevision);
    if (!policy) return false;
    const allowanceBeforeObservation = budget.decisions
      .filter(item => item.policyRevision === policy.revision && item.action === "continue" && item.event.sequence < observation.event.sequence)
      .reduce((sum, item) => sum + (item.addedAllowance || 0), 0);
    const hard = policy.hardTotalTokens === undefined ? undefined : policy.hardTotalTokens + allowanceBeforeObservation;
    if (observation.thresholdStatus !== thresholdStatus(observation.totalTokens, policy, hard)) return false;
  }
  const currentObservations = budget.observations.filter(item => item.policyRevision === budget.policy.revision);
  const latest = currentObservations.at(-1);
  const latestDecision = latest && budget.decisions.find(item => sameMutationIdentity(item.observation, latest.event));
  const expected = !latest
    ? "within"
    : latest.thresholdStatus === "decision-required" && latestDecision?.action === "continue"
      ? thresholdStatus(latest.totalTokens, budget.policy, effectiveHardTotalTokens(budget))
      : latest.thresholdStatus;
  return budget.thresholdStatus === expected;
}

export function effectiveHardTotalTokens(budget: Pick<TaskBudget, "policy" | "decisions">): number | undefined {
  const hard = budget.policy.hardTotalTokens;
  if (hard === undefined) return undefined;
  return hard + budget.decisions
    .filter(item => item.policyRevision === budget.policy.revision && item.action === "continue")
    .reduce((sum, item) => sum + (item.addedAllowance || 0), 0);
}

export function thresholdStatus(
  totalTokens: number,
  policy: TaskBudgetPolicy,
  effectiveHard = policy.hardTotalTokens
): BudgetThresholdStatus {
  if (effectiveHard !== undefined && totalTokens >= effectiveHard) return "decision-required";
  if (policy.softTotalTokens !== undefined && totalTokens >= policy.softTotalTokens) return "soft-exceeded";
  return "within";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function budgetReportHash(report: UsageReport): string {
  const normalized = {
    session: report.session.threadId,
    capturedAt: report.capturedAt,
    interval: report.interval,
    total: report.total,
    tokenCounters: report.tokenCounters,
    rollouts: report.threads.map(item => ({ threadId: item.threadId, rollout: item.rollout }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId))
  };
  return `sha256:${createHash("sha256").update(stable(normalized), "utf8").digest("hex")}`;
}

export async function collectTaskBudgetReport({
  cwd,
  taskId,
  budget,
  clientFactory,
  clock,
  collector = collectUsage
}: {
  cwd: string;
  taskId: string;
  budget: TaskBudget;
  clientFactory?: () => UsageClient;
  clock?: () => Date | string | number;
  collector?: typeof collectUsage;
}): Promise<TaskBudgetReport> {
  const usage = await collector({
    cwd,
    threadId: budget.policy.rootSessionId,
    sinceEvent: budget.policy.startEvent.id,
    ...(clientFactory ? { clientFactory } : {}),
    ...(clock ? { clock } : {})
  });
  if (usage.session.threadId !== budget.policy.rootSessionId
    || usage.interval?.start.event.sequence !== budget.policy.startEvent.sequence
    || usage.interval.start.event.id !== budget.policy.startEvent.id
    || usage.interval.start.event.hash !== budget.policy.startEvent.hash) {
    throw new SynodError(ERROR_CODES.BUDGET_STALE, `Task ${taskId} budget report no longer matches its bound session or start event.`, {
      details: { taskId, expectedSession: budget.policy.rootSessionId, actualSession: usage.session.threadId }
    });
  }
  if ((usage.tokenCounters?.resets || 0) > 0) {
    throw new SynodError(ERROR_CODES.BUDGET_REPORT_INCOMPLETE, `Task ${taskId} budget report crossed a token-counter reset.`, {
      details: { taskId, resets: usage.tokenCounters.resets }
    });
  }
  const effectiveHard = effectiveHardTotalTokens(budget);
  const status = thresholdStatus(usage.total.totalTokens, budget.policy, effectiveHard);
  const warnings: TaskBudgetReport["warnings"] = [];
  if (status === "decision-required") {
    warnings.push({ code: "SYNOD_BUDGET_HARD_EXCEEDED", message: `Task ${taskId} reached its hard token budget.` });
  } else if (status === "soft-exceeded") {
    warnings.push({ code: "SYNOD_BUDGET_SOFT_EXCEEDED", message: `Task ${taskId} reached its soft token budget.` });
  }
  return {
    taskId,
    policy: budget.policy,
    ...(effectiveHard === undefined ? {} : { effectiveHardTotalTokens: effectiveHard }),
    reportHash: budgetReportHash(usage),
    thresholdStatus: status,
    usage,
    warnings
  };
}
