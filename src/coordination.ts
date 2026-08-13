import { isRecord } from "./validation.js";

const COORDINATION_TOOLS = {
  spawn_agent: "spawn",
  followup_task: "follow-up",
  send_message: "message",
  wait_agent: "wait",
  list_agents: "supervision",
  interrupt_agent: "supervision"
} as const;

export type ToolCallCategory = (typeof COORDINATION_TOOLS)[keyof typeof COORDINATION_TOOLS] | "implementation";

export interface ToolCallTimestamp {
  iso: string;
  milliseconds: number;
  bytes?: number;
  sha256?: string;
}

export type CoordinationOutcome = "succeeded" | "no-change" | "timed-out" | "failed" | "unknown";

export interface ToolOutputSignals {
  structured: boolean;
  explicitFailure: boolean;
  explicitSuccess: boolean;
  timedOut: boolean;
  plainText: boolean;
}

export interface NormalizedToolCall {
  callId: string;
  name: string;
  category: ToolCallCategory;
  startedAt?: string;
  startedAtMs?: number;
  completedAt?: string;
  completedAtMs?: number;
  completedAtBytes?: number;
  completedAtSha256?: string;
  outputRecorded?: true;
  durationMs?: number;
  requestedWaitMs?: number;
  outcome?: CoordinationOutcome;
  retrySignalSupported: boolean;
  retryOf?: string;
}

export interface NormalizedToolOutput {
  callId: string;
  observedAt?: string;
  observedAtMs?: number;
  observedAtBytes?: number;
  observedAtSha256?: string;
  signals: ToolOutputSignals;
}

export interface CoordinationCounts {
  totalCalls: number;
  coordinationCalls: number;
  implementationCalls: number;
  spawn: number;
  followUp: number;
  message: number;
  followUpOrMessage: number;
  wait: number;
  listAgents: number;
  interruptAgent: number;
  supervision: number;
  compactions: number;
}

export interface CoordinationToolRow {
  name: string;
  category: ToolCallCategory;
  calls: number;
}

export interface CoordinationDurationMetric {
  status: "available" | "partial" | "unavailable";
  observed: number;
  missing: number;
  totalMs?: number;
}

export interface CoordinationOutcomeMetric {
  status: "available" | "partial" | "unavailable";
  observed: number;
  missing: number;
  succeeded: number;
  noChange: number;
  timedOut: number;
  failed: number;
  unknown: number;
}

export interface CoordinationRetryMetric {
  available: boolean;
  count?: number;
}

export interface CoordinationMetrics {
  counts: CoordinationCounts;
  tools: CoordinationToolRow[];
  callDuration: CoordinationDurationMetric;
  waitDuration: CoordinationDurationMetric;
  requestedWaitDuration: CoordinationDurationMetric;
  outcomes: CoordinationOutcomeMetric;
  retries: CoordinationRetryMetric;
}

export interface CoordinationThreadInput {
  threadId: string;
  parentThreadId: string | null;
  role: string;
  source: string;
  calls: NormalizedToolCall[];
  compactions: number;
  boundaryCrossingCalls?: number;
}

export interface CoordinationThreadRow {
  threadId: string;
  parentThreadId: string | null;
  role: string;
  source: string;
  metrics: CoordinationMetrics;
}

export interface CoordinationRoleRow {
  role: string;
  threads: number;
  metrics: CoordinationMetrics;
}

export interface CoordinationReport {
  total: CoordinationMetrics;
  roles: CoordinationRoleRow[];
  threads: CoordinationThreadRow[];
  boundary: {
    crossingCalls: {
      total: number;
      roles: Array<{ role: string; calls: number }>;
      threads: Array<{ threadId: string; role: string; calls: number }>;
    };
  };
  completeness: {
    status: "complete" | "incomplete";
    reasons: string[];
  };
}

function parsedRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeDurationArgument(payload: Record<string, unknown>): number | undefined {
  const argumentsRecord = parsedRecord(payload.arguments) || parsedRecord(payload.input);
  const value = argumentsRecord?.timeout_ms ?? argumentsRecord?.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function retryIdentity(payload: Record<string, unknown>): { supported: boolean; retryOf?: string } {
  const fields = ["retry_of", "retryOf", "retry_call_id", "retryCallId"] as const;
  const supported = fields.some(field => Object.hasOwn(payload, field));
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) return { supported, retryOf: value };
  }
  return { supported };
}

export function toolCallCategory(name: string): ToolCallCategory {
  return COORDINATION_TOOLS[name as keyof typeof COORDINATION_TOOLS] || "implementation";
}

export function isToolCallStartPayload(payload: Record<string, unknown>): boolean {
  return payload.type === "function_call" || payload.type === "custom_tool_call";
}

export function isToolCallOutputPayload(payload: Record<string, unknown>): boolean {
  return payload.type === "function_call_output" || payload.type === "custom_tool_call_output";
}

export function normalizeToolCallStart(
  payload: Record<string, unknown>,
  observed?: ToolCallTimestamp
): NormalizedToolCall | undefined {
  if (!isToolCallStartPayload(payload)) return undefined;
  const callId = payload.call_id ?? payload.callId;
  if (typeof callId !== "string" || callId.length === 0 || typeof payload.name !== "string" || payload.name.length === 0) {
    return undefined;
  }
  const retry = retryIdentity(payload);
  const category = toolCallCategory(payload.name);
  const requestedWaitMs = category === "wait" ? safeDurationArgument(payload) : undefined;
  return {
    callId,
    name: payload.name,
    category,
    ...(observed ? { startedAt: observed.iso, startedAtMs: observed.milliseconds } : {}),
    ...(requestedWaitMs !== undefined ? { requestedWaitMs } : {}),
    retrySignalSupported: retry.supported,
    ...(retry.retryOf ? { retryOf: retry.retryOf } : {})
  };
}

function emptyOutputSignals(): ToolOutputSignals {
  return { structured: false, explicitFailure: false, explicitSuccess: false, timedOut: false, plainText: false };
}

function mergeOutputSignals(target: ToolOutputSignals, source: ToolOutputSignals): void {
  target.structured ||= source.structured;
  target.explicitFailure ||= source.explicitFailure;
  target.explicitSuccess ||= source.explicitSuccess;
  target.timedOut ||= source.timedOut;
  target.plainText ||= source.plainText;
}

function structuredOutcome(value: unknown): ToolOutputSignals {
  if (Array.isArray(value)) {
    const signals = emptyOutputSignals();
    for (const item of value) mergeOutputSignals(signals, structuredOutcome(item));
    return signals;
  }
  if (typeof value === "string") {
    try {
      return structuredOutcome(JSON.parse(value) as unknown);
    } catch {
      return { ...emptyOutputSignals(), plainText: value.trim().length > 0 };
    }
  }
  if (!isRecord(value)) return emptyOutputSignals();
  const record = value;
  const signals = { ...emptyOutputSignals(), structured: true };
  if (record.isError === true || record.is_error === true || record.success === false || record.ok === false) {
    signals.explicitFailure = true;
  }
  const exitCode = record.exitCode ?? record.exit_code;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    if (exitCode === 0) signals.explicitSuccess = true;
    else signals.explicitFailure = true;
  }
  if (record.timedOut === true || record.timed_out === true) signals.timedOut = true;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : undefined;
  if (status && ["error", "failed", "failure", "cancelled", "canceled", "timed-out", "timeout"].includes(status)) {
    if (["timed-out", "timeout"].includes(status)) signals.timedOut = true;
    else signals.explicitFailure = true;
  }
  if (record.isError === false || record.is_error === false || record.success === true || record.ok === true) {
    signals.explicitSuccess = true;
  }
  if (status && ["ok", "success", "succeeded", "completed"].includes(status)) signals.explicitSuccess = true;
  for (const field of ["output", "result", "data", "content"] as const) {
    if (record[field] !== undefined) mergeOutputSignals(signals, structuredOutcome(record[field]));
  }
  return signals;
}

function classifyOutcome(start: NormalizedToolCall, output: NormalizedToolOutput): CoordinationOutcome {
  const signals = output.signals;
  if (signals.explicitFailure) return "failed";
  if (signals.timedOut) return start.category === "wait" ? "no-change" : "timed-out";
  if (signals.explicitSuccess) return "succeeded";
  if (signals.plainText && start.category !== "implementation") return "failed";
  return "unknown";
}

export function normalizeToolCallOutput(
  payload: Record<string, unknown>,
  observed?: ToolCallTimestamp
): NormalizedToolOutput | undefined {
  if (!isToolCallOutputPayload(payload)) return undefined;
  const callId = payload.call_id ?? payload.callId;
  if (typeof callId !== "string" || callId.length === 0) return undefined;
  const signals = structuredOutcome(payload.output ?? payload);
  return {
    callId,
    ...(observed ? { observedAt: observed.iso, observedAtMs: observed.milliseconds } : {}),
    ...(observed?.bytes !== undefined ? { observedAtBytes: observed.bytes } : {}),
    ...(observed?.sha256 !== undefined ? { observedAtSha256: observed.sha256 } : {}),
    signals
  };
}

export function pairToolCall(start: NormalizedToolCall, output: NormalizedToolOutput): NormalizedToolCall {
  const durationMs = start.startedAtMs !== undefined && output.observedAtMs !== undefined
    ? output.observedAtMs - start.startedAtMs
    : undefined;
  return {
    ...start,
    outputRecorded: true,
    ...(output.observedAt ? { completedAt: output.observedAt } : {}),
    ...(output.observedAtMs !== undefined ? { completedAtMs: output.observedAtMs } : {}),
    ...(output.observedAtBytes !== undefined ? { completedAtBytes: output.observedAtBytes } : {}),
    ...(output.observedAtSha256 !== undefined ? { completedAtSha256: output.observedAtSha256 } : {}),
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    outcome: classifyOutcome(start, output)
  };
}

function emptyCounts(): CoordinationCounts {
  return {
    totalCalls: 0,
    coordinationCalls: 0,
    implementationCalls: 0,
    spawn: 0,
    followUp: 0,
    message: 0,
    followUpOrMessage: 0,
    wait: 0,
    listAgents: 0,
    interruptAgent: 0,
    supervision: 0,
    compactions: 0
  };
}

function durationMetric(observed: number[], missing: number): CoordinationDurationMetric {
  return {
    status: observed.length === 0 ? "unavailable" : missing > 0 ? "partial" : "available",
    observed: observed.length,
    missing,
    ...(observed.length > 0 ? { totalMs: observed.reduce((total, value) => total + value, 0) } : {})
  };
}

export function summarizeCoordination(inputs: CoordinationThreadInput[]): CoordinationMetrics {
  const calls = inputs.flatMap(input => input.calls);
  const counts = emptyCounts();
  counts.compactions = inputs.reduce((total, input) => total + input.compactions, 0);
  const toolCounts = new Map<string, CoordinationToolRow>();
  const callDurations: number[] = [];
  const waitDurations: number[] = [];
  const requestedWaitDurations: number[] = [];
  let missingCallDurations = 0;
  let missingWaitDurations = 0;
  let missingRequestedWaitDurations = 0;
  let observedOutcomes = 0;
  let missingOutcomes = 0;
  let succeeded = 0;
  let noChange = 0;
  let timedOut = 0;
  let failed = 0;
  let unknown = 0;
  let retrySignals = 0;
  let retries = 0;

  for (const call of calls) {
    counts.totalCalls += 1;
    if (call.category === "implementation") counts.implementationCalls += 1;
    else counts.coordinationCalls += 1;
    if (call.category === "spawn") counts.spawn += 1;
    else if (call.category === "follow-up") counts.followUp += 1;
    else if (call.category === "message") counts.message += 1;
    else if (call.category === "wait") counts.wait += 1;
    else if (call.name === "list_agents") counts.listAgents += 1;
    else if (call.name === "interrupt_agent") counts.interruptAgent += 1;
    counts.followUpOrMessage = counts.followUp + counts.message;
    counts.supervision = counts.listAgents + counts.interruptAgent;

    const toolKey = `${call.category}\u0000${call.name}`;
    const tool = toolCounts.get(toolKey) || { name: call.name, category: call.category, calls: 0 };
    tool.calls += 1;
    toolCounts.set(toolKey, tool);

    if (call.durationMs === undefined) missingCallDurations += 1;
    else callDurations.push(call.durationMs);
    if (call.category === "wait") {
      if (call.durationMs === undefined) missingWaitDurations += 1;
      else waitDurations.push(call.durationMs);
      if (call.requestedWaitMs === undefined) missingRequestedWaitDurations += 1;
      else requestedWaitDurations.push(call.requestedWaitMs);
    }
    if (!call.outputRecorded) missingOutcomes += 1;
    else {
      observedOutcomes += 1;
      if (call.outcome === "succeeded") succeeded += 1;
      else if (call.outcome === "no-change") noChange += 1;
      else if (call.outcome === "timed-out") timedOut += 1;
      else if (call.outcome === "failed") failed += 1;
      else unknown += 1;
    }
    if (call.retrySignalSupported) retrySignals += 1;
    if (call.retryOf) retries += 1;
  }

  const outcomeStatus = observedOutcomes === 0 ? "unavailable" : missingOutcomes > 0 ? "partial" : "available";
  return {
    counts,
    tools: [...toolCounts.values()].sort((left, right) => right.calls - left.calls
      || left.name.localeCompare(right.name)
      || left.category.localeCompare(right.category)),
    callDuration: durationMetric(callDurations, missingCallDurations),
    waitDuration: durationMetric(waitDurations, missingWaitDurations),
    requestedWaitDuration: durationMetric(requestedWaitDurations, missingRequestedWaitDurations),
    outcomes: {
      status: outcomeStatus,
      observed: observedOutcomes,
      missing: missingOutcomes,
      succeeded,
      noChange,
      timedOut,
      failed,
      unknown
    },
    retries: retrySignals > 0 ? { available: true, count: retries } : { available: false }
  };
}

export function coordinationReport(
  inputs: CoordinationThreadInput[],
  baseReasons: Iterable<string> = []
): CoordinationReport {
  const reasons = new Set(baseReasons);
  if (inputs.some(input => input.calls.some(call => !call.outputRecorded))) {
    reasons.add("tool-call-output-missing");
  }
  const byRole = new Map<string, CoordinationThreadInput[]>();
  for (const input of inputs) {
    const current = byRole.get(input.role) || [];
    current.push(input);
    byRole.set(input.role, current);
  }
  return {
    total: summarizeCoordination(inputs),
    roles: [...byRole.entries()].map(([role, rows]) => ({
      role,
      threads: rows.length,
      metrics: summarizeCoordination(rows)
    })).sort((left, right) => right.metrics.counts.totalCalls - left.metrics.counts.totalCalls
      || left.role.localeCompare(right.role)),
    threads: inputs.map(input => ({
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
      role: input.role,
      source: input.source,
      metrics: summarizeCoordination([input])
    }))
      .sort((left, right) => right.metrics.counts.totalCalls - left.metrics.counts.totalCalls
        || left.threadId.localeCompare(right.threadId)),
    boundary: {
      crossingCalls: {
        total: inputs.reduce((total, input) => total + (input.boundaryCrossingCalls || 0), 0),
        roles: [...byRole.entries()].map(([role, rows]) => ({
          role,
          calls: rows.reduce((total, row) => total + (row.boundaryCrossingCalls || 0), 0)
        })).filter(row => row.calls > 0).sort((left, right) => right.calls - left.calls || left.role.localeCompare(right.role)),
        threads: inputs.map(input => ({
          threadId: input.threadId,
          role: input.role,
          calls: input.boundaryCrossingCalls || 0
        })).filter(row => row.calls > 0).sort((left, right) => right.calls - left.calls || left.threadId.localeCompare(right.threadId))
      }
    },
    completeness: {
      status: reasons.size === 0 ? "complete" : "incomplete",
      reasons: [...reasons].sort()
    }
  };
}
