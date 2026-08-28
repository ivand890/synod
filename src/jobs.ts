import type { ThreadStatus, WaitAuthority } from "./wait.js";
import { isValidCodexThreadId } from "./leases.js";

/** The first (and currently only) durable job-contract schema. */
export const JOB_CONTRACT_SCHEMA_VERSION = 1 as const;

export type JobContractSchemaVersion = typeof JOB_CONTRACT_SCHEMA_VERSION;
export type JobKind = "task" | "thread";
export type JobOutcome = "active" | "quiescent" | "attention" | "incomplete";
export type RuntimeWaitAuthority = Exclude<WaitAuthority, "canonical">;
/** A canonical selector has no runtime observation; it must remain explicit. */
export type JobStatus = ThreadStatus | { type: "notObserved" };

type AttentionFlags =
  | ["waitingOnApproval"]
  | ["waitingOnUserInput"]
  | ["waitingOnApproval", "waitingOnUserInput"]
  | ["waitingOnUserInput", "waitingOnApproval"];

/** Status/outcome pairs that can be emitted by an actual runtime observer. */
export type RuntimeJobObservation =
  | { status: { type: "active"; activeFlags: [] }; outcome: "active" }
  | { status: { type: "active"; activeFlags: AttentionFlags }; outcome: "attention" }
  | { status: { type: "idle" }; outcome: "quiescent" }
  | { status: { type: "notLoaded" } | { type: "systemError" }; outcome: "incomplete" };

export interface ThreadJobHandle {
  schemaVersion: JobContractSchemaVersion;
  kind: "thread";
  jobId: string;
  registeredAt: string;
  waitAuthority: RuntimeWaitAuthority;
  threadId: string;
  hostHandle?: string;
}

export interface TaskJobHandle {
  schemaVersion: JobContractSchemaVersion;
  kind: "task";
  jobId: string;
  registeredAt: string;
  waitAuthority: WaitAuthority;
  threadId: string;
  taskId: string;
  taskRevision: number;
  leaseId: string;
  leaseGeneration: number;
  ownerThread: string;
  hostHandle?: string;
}

export type JobHandle = ThreadJobHandle | TaskJobHandle;

export interface JobObservation {
  sequence: number;
  eventId: string;
  previousEventId: string | null;
}

/** Provenance from a canonical state or event-log observation. */
export interface CanonicalJobEventProvenance {
  authority: "canonical";
  sourceId: string;
  sourceSequence: number;
}

/** Provenance from the App Server that supplied a bounded status observation. */
export interface AppServerJobEventProvenance {
  authority: "appServer";
  sourceId: string;
  transport: "notification" | "cursor" | "poll";
}

/** Provenance from the host that owns an externally-created thread. */
export interface HostJobEventProvenance {
  authority: "host";
  sourceId: string;
  observationId: string;
}

export type JobEventProvenance =
  | CanonicalJobEventProvenance
  | AppServerJobEventProvenance
  | HostJobEventProvenance;

interface JobEventIdentity {
  schemaVersion: JobContractSchemaVersion;
  jobId: string;
  kind: JobKind;
  threadId: string;
  hostHandle?: string;
}

interface ThreadJobEventIdentity extends JobEventIdentity {
  kind: "thread";
  observation: JobObservation;
  observedAt: string;
  sourceTimestamp: string | null;
}

type RuntimeThreadJobEvent<A extends RuntimeWaitAuthority> = ThreadJobEventIdentity
  & RuntimeJobObservation
  & { waitAuthority: A; provenance: A extends "host" ? HostJobEventProvenance : AppServerJobEventProvenance };

export type ThreadJobEvent =
  | RuntimeThreadJobEvent<"host">
  | RuntimeThreadJobEvent<"appServer">;

interface TaskJobEventIdentity extends JobEventIdentity {
  kind: "task";
  taskId: string;
  taskRevision: number;
  leaseId: string;
  leaseGeneration: number;
  ownerThread: string;
  observation: JobObservation;
  observedAt: string;
  sourceTimestamp: string | null;
}

type RuntimeTaskJobEvent<A extends RuntimeWaitAuthority> = TaskJobEventIdentity
  & RuntimeJobObservation
  & { waitAuthority: A; provenance: A extends "host" ? HostJobEventProvenance : AppServerJobEventProvenance };

export type CanonicalTaskJobEvent = TaskJobEventIdentity & {
  waitAuthority: "canonical";
  status: { type: "notObserved" };
  outcome: "incomplete";
  provenance: CanonicalJobEventProvenance;
};

export type TaskJobEvent =
  | CanonicalTaskJobEvent
  | RuntimeTaskJobEvent<"host">
  | RuntimeTaskJobEvent<"appServer">;

export type JobEvent = ThreadJobEvent | TaskJobEvent;

/** Stable error category for callers that need to fail closed on bad durable data. */
export class JobContractError extends TypeError {
  readonly code = "SYNOD_JOB_CONTRACT_INVALID";
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "JobContractError";
    this.path = path;
  }
}

const AUTHORITIES = new Set<WaitAuthority>(["host", "appServer", "canonical"]);
const OUTCOMES = new Set<JobOutcome>(["active", "quiescent", "attention", "incomplete"]);
const TRANSPORTS = new Set<AppServerJobEventProvenance["transport"]>(["notification", "cursor", "poll"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const HANDLE_BASE_KEYS = ["schemaVersion", "kind", "jobId", "registeredAt", "waitAuthority", "threadId"] as const;
const HANDLE_TASK_KEYS = [...HANDLE_BASE_KEYS, "taskId", "taskRevision", "leaseId", "leaseGeneration", "ownerThread"] as const;
const OBSERVATION_KEYS = ["sequence", "eventId", "previousEventId"] as const;
const PROVENANCE_KEYS = {
  canonical: ["authority", "sourceId", "sourceSequence"],
  appServer: ["authority", "sourceId", "transport"],
  host: ["authority", "sourceId", "observationId"]
} as const;
const EVENT_BASE_KEYS = [
  "schemaVersion",
  "jobId",
  "kind",
  "threadId",
  "observation",
  "observedAt",
  "sourceTimestamp",
  "status",
  "outcome",
  "waitAuthority",
  "provenance"
] as const;
const EVENT_TASK_KEYS = [
  ...EVENT_BASE_KEYS,
  "taskId",
  "taskRevision",
  "leaseId",
  "leaseGeneration",
  "ownerThread"
] as const;

function fail(message: string, path?: string): never {
  throw new JobContractError(message, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected a JSON object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    return fail("expected a JSON object with the standard prototype", path);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail("JSON objects cannot contain symbol keys", path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || "get" in descriptor || "set" in descriptor) {
      return fail("JSON object fields must be enumerable data properties", `${path}.${key}`);
    }
  }
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail("expected a JSON array", path);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      return fail("array contains an unknown field", path);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || "get" in descriptor || "set" in descriptor) {
      return fail("JSON array entries must be enumerable data properties", `${path}.${key}`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail("array must not contain holes", path);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string, optional: readonly string[] = []): void {
  const allowedSet = new Set([...expected, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowedSet.has(key))) {
    return fail(`unknown field; expected exactly ${expected.join(", ")}`, path);
  }
  if (keys.length < expected.length || keys.length > expected.length + optional.length) {
    return fail(`missing field; expected exactly ${expected.join(", ")}`, path);
  }
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return fail("expected a positive safe integer", path);
  }
  return value;
}

function revision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("expected a nonnegative safe integer", path);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || !ID_PATTERN.test(value)
  ) {
    return fail("expected a non-empty canonical identifier", path);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return fail("expected a canonical UTC ISO timestamp with millisecond precision", path);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail("expected a canonical UTC ISO timestamp", path);
  }
  return value;
}

function authority(value: unknown, path: string): WaitAuthority {
  if (typeof value !== "string" || !AUTHORITIES.has(value as WaitAuthority)) {
    return fail("expected waitAuthority host, appServer, or canonical", path);
  }
  return value as WaitAuthority;
}

function schemaVersion(value: unknown, path: string): JobContractSchemaVersion {
  if (value !== JOB_CONTRACT_SCHEMA_VERSION) return fail("unsupported schemaVersion", path);
  return JOB_CONTRACT_SCHEMA_VERSION;
}

function kind(value: unknown, path: string): JobKind {
  if (value !== "task" && value !== "thread") return fail("expected kind task or thread", path);
  return value;
}

function parseStatus(value: unknown, path: string): JobStatus {
  const item = record(value, path);
  if (typeof item.type !== "string") return fail("status.type must be a string", `${path}.type`);
  if (item.type === "notLoaded" || item.type === "idle" || item.type === "systemError" || item.type === "notObserved") {
    exactKeys(item, ["type"], path);
    return { type: item.type };
  }
  if (item.type !== "active") return fail("unknown thread status", `${path}.type`);
  exactKeys(item, ["type", "activeFlags"], path);
  const activeFlags = jsonArray(item.activeFlags, `${path}.activeFlags`);
  const flags = activeFlags.map((flag, index) => {
    if (flag !== "waitingOnApproval" && flag !== "waitingOnUserInput") {
      return fail("unknown active flag", `${path}.activeFlags[${index}]`);
    }
    return flag;
  });
  if (new Set(flags).size !== flags.length) return fail("activeFlags must not contain duplicates", `${path}.activeFlags`);
  return { type: "active", activeFlags: [...flags] };
}

function expectedOutcome(status: JobStatus): JobOutcome {
  if (status.type === "active") {
    return status.activeFlags.length > 0 ? "attention" : "active";
  }
  if (status.type === "idle") return "quiescent";
  return "incomplete";
}

function parseOutcome(value: unknown, status: JobStatus, path: string): JobOutcome {
  if (typeof value !== "string" || !OUTCOMES.has(value as JobOutcome)) {
    return fail("unknown outcome", path);
  }
  const outcome = value as JobOutcome;
  if (outcome !== expectedOutcome(status)) {
    return fail(`outcome must be ${expectedOutcome(status)} for this status`, path);
  }
  return outcome;
}

function parseObservation(value: unknown, path: string): JobObservation {
  const item = record(value, path);
  exactKeys(item, OBSERVATION_KEYS, path);
  const sequence = integer(item.sequence, `${path}.sequence`);
  const eventId = identifier(item.eventId, `${path}.eventId`);
  let previousEventId: string | null;
  if (item.previousEventId === null) previousEventId = null;
  else previousEventId = identifier(item.previousEventId, `${path}.previousEventId`);
  if (previousEventId === eventId) return fail("previousEventId cannot equal eventId", path);
  return { sequence, eventId, previousEventId };
}

function parseProvenance(value: unknown, expectedAuthority: WaitAuthority, path: string): JobEventProvenance {
  const item = record(value, path);
  const provenanceAuthority = authority(item.authority, `${path}.authority`);
  if (provenanceAuthority !== expectedAuthority) {
    return fail("provenance authority must match waitAuthority", `${path}.authority`);
  }
  if (provenanceAuthority === "canonical") {
    exactKeys(item, PROVENANCE_KEYS.canonical, path);
    return {
      authority: "canonical",
      sourceId: identifier(item.sourceId, `${path}.sourceId`),
      sourceSequence: integer(item.sourceSequence, `${path}.sourceSequence`)
    };
  }
  if (provenanceAuthority === "appServer") {
    exactKeys(item, PROVENANCE_KEYS.appServer, path);
    if (typeof item.transport !== "string" || !TRANSPORTS.has(item.transport as AppServerJobEventProvenance["transport"])) {
      return fail("unknown App Server transport", `${path}.transport`);
    }
    return {
      authority: "appServer",
      sourceId: identifier(item.sourceId, `${path}.sourceId`),
      transport: item.transport as AppServerJobEventProvenance["transport"]
    };
  }
  exactKeys(item, PROVENANCE_KEYS.host, path);
  return {
    authority: "host",
    sourceId: identifier(item.sourceId, `${path}.sourceId`),
    observationId: identifier(item.observationId, `${path}.observationId`)
  };
}

function parseHandleValue(value: unknown): JobHandle {
  const item = record(value, "handle");
  const itemKind = kind(item.kind, "handle.kind");
  exactKeys(item, itemKind === "task" ? HANDLE_TASK_KEYS : HANDLE_BASE_KEYS, "handle", ["hostHandle"]);
  const base = {
    schemaVersion: schemaVersion(item.schemaVersion, "handle.schemaVersion"),
    kind: itemKind,
    jobId: identifier(item.jobId, "handle.jobId"),
    registeredAt: timestamp(item.registeredAt, "handle.registeredAt"),
    waitAuthority: authority(item.waitAuthority, "handle.waitAuthority"),
    threadId: identifier(item.threadId, "handle.threadId")
  } as const;
  if (base.waitAuthority === "appServer" && !isValidCodexThreadId(base.threadId)) {
    return fail("App Server authority requires an exact UUID threadId", "handle.threadId");
  }
  if (base.kind === "thread" && base.waitAuthority === "canonical") {
    return fail("canonical authority requires task identity", "handle.waitAuthority");
  }
  const hostHandle = item.hostHandle === undefined ? undefined : identifier(item.hostHandle, "handle.hostHandle");
  if (base.waitAuthority !== "host" && hostHandle !== undefined) {
    return fail("hostHandle requires host authority", "handle.hostHandle");
  }
  if (itemKind === "thread") return {
    ...base,
    kind: "thread",
    waitAuthority: base.waitAuthority as RuntimeWaitAuthority,
    ...(hostHandle === undefined ? {} : { hostHandle })
  };
  const ownerThread = identifier(item.ownerThread, "handle.ownerThread");
  if (base.waitAuthority === "host") {
    if (hostHandle === undefined) {
      if (ownerThread !== base.threadId) return fail("legacy host ownerThread must equal threadId", "handle.ownerThread");
    } else if (ownerThread !== hostHandle) return fail("ownerThread must equal hostHandle", "handle.ownerThread");
  } else if (ownerThread !== base.threadId) return fail("ownerThread must equal threadId", "handle.ownerThread");
  if (base.waitAuthority !== "host" && hostHandle !== undefined) {
    return fail("hostHandle requires host authority", "handle.hostHandle");
  }
  return {
    ...base,
    kind: "task",
    taskId: identifier(item.taskId, "handle.taskId"),
    taskRevision: revision(item.taskRevision, "handle.taskRevision"),
    leaseId: identifier(item.leaseId, "handle.leaseId"),
    leaseGeneration: integer(item.leaseGeneration, "handle.leaseGeneration"),
    ownerThread,
    ...(hostHandle === undefined ? {} : { hostHandle })
  };
}

function parseEventValue(value: unknown): JobEvent {
  const item = record(value, "event");
  const itemKind = kind(item.kind, "event.kind");
  exactKeys(item, itemKind === "task" ? EVENT_TASK_KEYS : EVENT_BASE_KEYS, "event", ["hostHandle"]);
  const itemAuthority = authority(item.waitAuthority, "event.waitAuthority");
  const status = parseStatus(item.status, "event.status");
  const observedAt = timestamp(item.observedAt, "event.observedAt");
  if (item.sourceTimestamp !== null && item.sourceTimestamp !== undefined) {
    timestamp(item.sourceTimestamp, "event.sourceTimestamp");
  } else if (item.sourceTimestamp !== null) {
    return fail("sourceTimestamp must be a timestamp or null", "event.sourceTimestamp");
  }
  const base = {
    schemaVersion: schemaVersion(item.schemaVersion, "event.schemaVersion"),
    jobId: identifier(item.jobId, "event.jobId"),
    kind: itemKind,
    threadId: identifier(item.threadId, "event.threadId"),
    observation: parseObservation(item.observation, "event.observation"),
    observedAt,
    sourceTimestamp: item.sourceTimestamp as string | null,
    status,
    outcome: parseOutcome(item.outcome, status, "event.outcome"),
    waitAuthority: itemAuthority,
    provenance: parseProvenance(item.provenance, itemAuthority, "event.provenance")
  } as const;
  if (itemAuthority === "appServer" && !isValidCodexThreadId(base.threadId)) {
    return fail("App Server authority requires an exact UUID threadId", "event.threadId");
  }
  if (itemAuthority === "canonical" && (status.type !== "notObserved" || base.outcome !== "incomplete")) {
    return fail("canonical authority may only record notObserved/incomplete", "event.status");
  }
  if (itemAuthority !== "canonical" && status.type === "notObserved") {
    return fail("notObserved status requires canonical authority", "event.status");
  }
  if (base.kind === "thread" && base.waitAuthority === "canonical") {
    return fail("canonical authority requires task identity", "event.waitAuthority");
  }
  const hostHandle = item.hostHandle === undefined ? undefined : identifier(item.hostHandle, "event.hostHandle");
  if (itemAuthority === "host" && hostHandle === undefined && itemKind === "thread") {
    // Runtime events may retain only their observed thread identity; a host
    // handle is optional on event records for compatibility with old streams.
  }
  if (itemAuthority !== "host" && hostHandle !== undefined) {
    return fail("hostHandle requires host authority", "event.hostHandle");
  }
  if (itemKind === "thread") return {
    ...base,
    kind: "thread",
    ...(hostHandle === undefined ? {} : { hostHandle })
  } as JobEvent;
  const ownerThread = identifier(item.ownerThread, "event.ownerThread");
  if (itemAuthority === "host") {
    if (hostHandle === undefined) {
      if (ownerThread !== base.threadId) return fail("legacy host ownerThread must equal threadId", "event.ownerThread");
    } else if (ownerThread !== hostHandle) return fail("ownerThread must equal hostHandle", "event.ownerThread");
  } else if (ownerThread !== base.threadId) return fail("ownerThread must equal threadId", "event.ownerThread");
  return {
    ...base,
    kind: "task",
    taskId: identifier(item.taskId, "event.taskId"),
    taskRevision: revision(item.taskRevision, "event.taskRevision"),
    leaseId: identifier(item.leaseId, "event.leaseId"),
    leaseGeneration: integer(item.leaseGeneration, "event.leaseGeneration"),
    ownerThread,
    ...(hostHandle === undefined ? {} : { hostHandle })
  } as JobEvent;
}

export function validateJobHandle(value: unknown): JobHandle {
  return parseHandleValue(value);
}

export function parseJobHandle(value: unknown): JobHandle | undefined {
  try {
    return validateJobHandle(value);
  } catch (error) {
    if (error instanceof JobContractError) return undefined;
    throw error;
  }
}

export function isJobHandle(value: unknown): value is JobHandle {
  return parseJobHandle(value) !== undefined;
}

export function validateJobEvent(value: unknown): JobEvent {
  return parseEventValue(value);
}

export function parseJobEvent(value: unknown): JobEvent | undefined {
  try {
    return validateJobEvent(value);
  } catch (error) {
    if (error instanceof JobContractError) return undefined;
    throw error;
  }
}

export function isJobEvent(value: unknown): value is JobEvent {
  return parseJobEvent(value) !== undefined;
}

function eventIdentity(event: JobEvent): readonly unknown[] {
  if (event.kind === "task") {
    return [event.jobId, event.kind, event.threadId, event.taskId, event.taskRevision, event.leaseId, event.leaseGeneration, event.ownerThread, event.waitAuthority, event.hostHandle];
  }
  return [event.jobId, event.kind, event.threadId, event.waitAuthority, event.hostHandle];
}

function handleIdentity(handle: JobHandle): readonly unknown[] {
  if (handle.kind === "task") {
    return [handle.jobId, handle.kind, handle.threadId, handle.taskId, handle.taskRevision, handle.leaseId, handle.leaseGeneration, handle.ownerThread, handle.waitAuthority, handle.hostHandle];
  }
  return [handle.jobId, handle.kind, handle.threadId, handle.waitAuthority, handle.hostHandle];
}

function compareIdentity(left: readonly unknown[], right: readonly unknown[], path: string): void {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    return fail("event identity does not match the sequence handle", path);
  }
}

function sequenceArguments(
  first: readonly unknown[] | JobHandle,
  second?: readonly unknown[] | JobHandle
): { events: readonly unknown[]; handle?: JobHandle } {
  if (Array.isArray(first)) {
    if (second === undefined) return { events: first };
    if (Array.isArray(second)) return fail("event sequence received two event arrays", "events");
    return { events: first, handle: validateJobHandle(second) };
  }
  const handle = validateJobHandle(first);
  if (!Array.isArray(second)) return fail("event sequence requires an array of events", "events");
  return { events: second, handle };
}

/**
 * Validate an ordered observation stream. The overload with the handle first
 * is convenient for callers that already have a durable registration; the
 * array-first form derives identity from the first event.
 */
export function validateJobEventSequence(events: readonly unknown[], handle?: JobHandle): JobEvent[];
export function validateJobEventSequence(handle: JobHandle, events: readonly unknown[]): JobEvent[];
export function validateJobEventSequence(
  first: readonly unknown[] | JobHandle,
  second?: readonly unknown[] | JobHandle
): JobEvent[] {
  const { events, handle } = sequenceArguments(first, second);
  const eventValues = jsonArray(events, "events");
  const parsed = eventValues.map((event, index) => validateJobEvent(event));
  if (parsed.length === 0) return [];
  const expectedIdentity = handle ? handleIdentity(validateJobHandle(handle)) : eventIdentity(parsed[0]!);
  const eventIds = new Set<string>();
  let previous: JobEvent | undefined;
  let lastSourceTimestamp: string | null = null;
  for (const [index, event] of parsed.entries()) {
    compareIdentity(eventIdentity(event), expectedIdentity, `events[${index}]`);
    if (event.observation.sequence !== index + 1) {
      return fail("observation sequence must start at 1 and increment by one", `events[${index}].observation.sequence`);
    }
    if (eventIds.has(event.observation.eventId)) {
      return fail("observation eventId must be unique", `events[${index}].observation.eventId`);
    }
    if (index === 0) {
      if (event.observation.previousEventId !== null) {
        return fail("the first observation must not link to a previous event", `events[${index}].observation.previousEventId`);
      }
    } else {
      if (event.observation.previousEventId !== previous?.observation.eventId) {
        return fail("previousEventId must link to the preceding observation", `events[${index}].observation.previousEventId`);
      }
      if (event.observedAt < (previous?.observedAt || event.observedAt)) {
        return fail("observedAt must be nondecreasing", `events[${index}].observedAt`);
      }
      if (event.sourceTimestamp !== null && lastSourceTimestamp !== null && event.sourceTimestamp < lastSourceTimestamp) {
        return fail("sourceTimestamp must be nondecreasing when present", `events[${index}].sourceTimestamp`);
      }
    }
    if (event.sourceTimestamp !== null) lastSourceTimestamp = event.sourceTimestamp;
    eventIds.add(event.observation.eventId);
    previous = event;
  }
  return parsed;
}

export function parseJobEventSequence(
  first: readonly unknown[] | JobHandle,
  second?: readonly unknown[] | JobHandle
): JobEvent[] | undefined {
  try {
    if (Array.isArray(first)) {
      if (second === undefined) return validateJobEventSequence(first);
      if (Array.isArray(second)) return undefined;
      return validateJobEventSequence(first, validateJobHandle(second));
    }
    if (!Array.isArray(second)) return undefined;
    return validateJobEventSequence(validateJobHandle(first), second);
  } catch (error) {
    if (error instanceof JobContractError) return undefined;
    throw error;
  }
}

export const validateJobEvents = validateJobEventSequence;
export const parseJobEvents = parseJobEventSequence;
