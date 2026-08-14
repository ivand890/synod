import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_CONTRACT_SCHEMA_VERSION,
  JobContractError,
  isJobEvent,
  isJobHandle,
  parseJobEvent,
  parseJobEventSequence,
  parseJobHandle,
  validateJobEvent,
  validateJobEventSequence,
  validateJobHandle,
  type JobEvent,
  type JobHandle,
  type RuntimeJobObservation,
  type TaskJobEvent,
  type CanonicalTaskJobEvent,
  type ThreadJobEvent
} from "../src/jobs.js";

const handle: JobHandle = {
  schemaVersion: JOB_CONTRACT_SCHEMA_VERSION,
  kind: "task",
  jobId: "job:SYN-093-JOBS-003",
  registeredAt: "2026-08-14T17:01:00.000Z",
  waitAuthority: "appServer",
  threadId: "thread:jobs",
  taskId: "SYN-093-JOBS-003",
  taskRevision: 0,
  leaseId: "lease:jobs",
  leaseGeneration: 1,
  ownerThread: "thread:jobs"
};

const event = (
  sequence: number,
  eventId: string,
  previousEventId: string | null,
  observedAt: string,
  sourceTimestamp: string | null,
  state: RuntimeJobObservation
): TaskJobEvent => ({
  schemaVersion: JOB_CONTRACT_SCHEMA_VERSION,
  jobId: handle.jobId,
  kind: "task",
  threadId: handle.threadId,
  taskId: handle.taskId,
  taskRevision: handle.taskRevision,
  leaseId: handle.leaseId,
  leaseGeneration: handle.leaseGeneration,
  ownerThread: handle.ownerThread,
  observation: { sequence, eventId, previousEventId },
  observedAt,
  sourceTimestamp,
  ...state,
  waitAuthority: "appServer",
  provenance: { authority: "appServer", sourceId: "server:jobs", transport: "poll" }
});

const active = event(
  1,
  "event:jobs:1",
  null,
  "2026-08-14T17:01:01.000Z",
  "2026-08-14T17:01:00.500Z",
  { status: { type: "active", activeFlags: [] }, outcome: "active" },
);
const attention = event(
  2,
  "event:jobs:2",
  "event:jobs:1",
  "2026-08-14T17:01:02.000Z",
  null,
  { status: { type: "active", activeFlags: ["waitingOnApproval"] }, outcome: "attention" },
);
const quiescent = event(
  3,
  "event:jobs:3",
  "event:jobs:2",
  "2026-08-14T17:01:03.000Z",
  "2026-08-14T17:01:01.000Z",
  { status: { type: "idle" }, outcome: "quiescent" },
);

test("validates a versioned task handle and ordered observation-only events", () => {
  const restoredHandle = JSON.parse(JSON.stringify(handle)) as unknown;
  const restoredEvents = JSON.parse(JSON.stringify([active, attention, quiescent])) as unknown;
  assert.deepEqual(validateJobHandle(restoredHandle), handle);
  assert.deepEqual(validateJobEventSequence(restoredEvents as readonly unknown[], handle), [active, attention, quiescent]);
  assert.deepEqual(validateJobEventSequence(handle, restoredEvents as JobEvent[]), [active, attention, quiescent]);
  assert.equal(isJobHandle(restoredHandle), true);
  assert.equal(isJobEvent(active), true);
  assert.deepEqual(parseJobHandle(restoredHandle), handle);
  assert.deepEqual(parseJobEvent(active), active);
  assert.deepEqual(parseJobEventSequence(restoredEvents as readonly unknown[], handle), [active, attention, quiescent]);
});

test("rejects unknown fields and malformed handle identity", () => {
  assert.throws(
    () => validateJobHandle({ ...handle, extra: true }),
    (error: unknown) => error instanceof JobContractError && error.code === "SYNOD_JOB_CONTRACT_INVALID"
  );
  assert.equal(parseJobHandle({ ...handle, extra: true }), undefined);
  assert.equal(isJobHandle({ ...handle, extra: true }), false);
  assert.throws(() => validateJobHandle({ ...handle, ownerThread: "thread:other" }));
  assert.throws(() => validateJobHandle({ ...handle, taskRevision: -1 }));
  assert.throws(() => validateJobHandle({ ...handle, taskRevision: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => validateJobHandle({ ...handle, leaseGeneration: 0 }));
  assert.throws(() => validateJobHandle({ ...handle, waitAuthority: "desktop" }));
  assert.throws(() => validateJobHandle({ ...handle, jobId: " job" }));
  assert.throws(() => validateJobHandle({ ...handle, registeredAt: "2026-08-14T17:01:00Z" }));
});

test("rejects non-JSON prototypes, fields, and accessors at every object boundary", () => {
  const nullPrototype = (value: object): unknown => Object.assign(Object.create(null), value);
  const hiddenField = (value: object, key: string): unknown => {
    const source = value as Record<string, unknown>;
    const clone = { ...source };
    Object.defineProperty(clone, key, { value: source[key], enumerable: false, configurable: true });
    return clone;
  };
  let getterCalls = 0;
  const accessorField = (value: object, key: string): unknown => {
    const source = value as Record<string, unknown>;
    const clone = { ...source };
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return source[key];
      }
    });
    return clone;
  };

  assert.throws(() => validateJobHandle(nullPrototype(handle)));
  assert.throws(() => validateJobHandle(hiddenField(handle, "jobId")));
  assert.throws(() => validateJobHandle(accessorField(handle, "jobId")));
  assert.throws(() => validateJobHandle({ ...handle, [Symbol("extra")]: true }));
  assert.equal(getterCalls, 0);

  const nestedBoundaries: Array<[string, Record<string, unknown>]> = [
    ["observation", active.observation as unknown as Record<string, unknown>],
    ["status", active.status as unknown as Record<string, unknown>],
    ["provenance", active.provenance as unknown as Record<string, unknown>]
  ];
  for (const [boundary, value] of nestedBoundaries) {
    assert.throws(() => validateJobEvent({ ...active, [boundary]: nullPrototype(value) }));
    assert.throws(() => validateJobEvent({ ...active, [boundary]: hiddenField(value, Object.keys(value)[0]!) }));
    assert.throws(() => validateJobEvent({ ...active, [boundary]: accessorField(value, Object.keys(value)[0]!) }));
    assert.equal(getterCalls, 0);
  }
  assert.throws(() => validateJobEvent({
    ...active,
    observation: { ...active.observation, [Symbol("extra")]: true }
  }));

  const flagsWithAccessor = ["waitingOnApproval"];
  Object.defineProperty(flagsWithAccessor, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "waitingOnApproval";
    }
  });
  assert.throws(() => validateJobEvent({
    ...active,
    status: { type: "active", activeFlags: flagsWithAccessor }
  }));
  assert.equal(getterCalls, 0);
});

test("rejects invalid status, outcome, provenance, and event fields", () => {
  assert.throws(() => validateJobEvent({ ...active, extra: true }));
  assert.equal(parseJobEvent({ ...active, extra: true }), undefined);
  assert.throws(() => validateJobEvent({
    ...active,
    status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnApproval"] }
  }));
  assert.throws(() => validateJobEvent({ ...active, outcome: "quiescent" }));
  assert.throws(() => validateJobEvent({ ...active, status: { type: "idle" }, outcome: "active" }));
  assert.throws(() => validateJobEvent({
    ...active,
    waitAuthority: "appServer",
    provenance: { authority: "canonical", sourceId: "canonical:jobs", sourceSequence: 1 }
  }));
  assert.throws(() => validateJobEvent({
    ...active,
    provenance: { authority: "appServer", sourceId: "server:jobs", transport: "resume" }
  }));
  assert.throws(() => validateJobEvent({ ...active, sourceTimestamp: undefined }));
  assert.throws(() => validateJobEvent({ ...active, observedAt: "2026-08-14T17:01:01+00:00" }));
  const flagsWithExtra = ["waitingOnApproval"] as unknown as string[] & { extra?: boolean };
  flagsWithExtra.extra = true;
  assert.throws(() => validateJobEvent({ ...active, status: { type: "active", activeFlags: flagsWithExtra } }));
  assert.throws(() => validateJobEvent({ ...active, observation: { ...active.observation, sequence: 0 } }));
  assert.throws(() => validateJobEvent({ ...active, observation: { ...active.observation, eventId: "event jobs" } }));
  assert.throws(() => validateJobEvent({ ...active, completed: true }));
});

test("keeps authority semantics explicit and never treats App Server idle as completed", () => {
  const appServerEvent = active;
  const idleEvent = event(
    1,
    "event:server:1",
    null,
    "2026-08-14T17:01:01.000Z",
    null,
    { status: { type: "idle" }, outcome: "quiescent" }
  );
  assert.deepEqual(validateJobEvent(idleEvent), idleEvent);
  assert.throws(() => validateJobEvent({ ...idleEvent, outcome: "incomplete" }));

  const canonicalHandle: JobHandle = {
    ...handle,
    waitAuthority: "canonical"
  };
  const canonicalEvent: CanonicalTaskJobEvent = {
    schemaVersion: JOB_CONTRACT_SCHEMA_VERSION,
    kind: "task",
    jobId: canonicalHandle.jobId,
    threadId: canonicalHandle.threadId,
    taskId: canonicalHandle.taskId,
    taskRevision: canonicalHandle.taskRevision,
    leaseId: canonicalHandle.leaseId,
    leaseGeneration: canonicalHandle.leaseGeneration,
    ownerThread: canonicalHandle.ownerThread,
    observation: { sequence: 1, eventId: "event:canonical:1", previousEventId: null },
    observedAt: "2026-08-14T17:01:01.000Z",
    sourceTimestamp: null,
    waitAuthority: "canonical",
    status: { type: "notObserved" },
    outcome: "incomplete",
    provenance: { authority: "canonical", sourceId: "canonical:jobs", sourceSequence: 1 }
  };
  assert.deepEqual(validateJobEvent(canonicalEvent), canonicalEvent);
  assert.throws(() => validateJobEvent({ ...canonicalEvent, status: { type: "idle" }, outcome: "quiescent" }));

  const hostEvent: ThreadJobEvent = {
    schemaVersion: JOB_CONTRACT_SCHEMA_VERSION,
    kind: "thread",
    jobId: "job:desktop",
    threadId: "thread:desktop",
    waitAuthority: "host",
    provenance: { authority: "host", sourceId: "desktop:session", observationId: "host-observation:1" },
    observation: { sequence: 1, eventId: "event:desktop:1", previousEventId: null },
    observedAt: "2026-08-14T17:01:01.000Z",
    sourceTimestamp: null,
    status: { type: "notLoaded" },
    outcome: "incomplete"
  };
  assert.deepEqual(validateJobEvent(hostEvent), hostEvent);
  assert.throws(() => validateJobHandle({
    schemaVersion: 1,
    kind: "thread",
    jobId: "job:desktop",
    registeredAt: handle.registeredAt,
    waitAuthority: "canonical",
    threadId: "thread:desktop"
  }));
});

test("enforces sequence identity, links, monotonic timestamps, and positive observations", () => {
  const invalidSequences: unknown[][] = [
    [{ ...active, observation: { ...active.observation, sequence: 2 } }],
    [active, { ...attention, observation: { ...attention.observation, previousEventId: "event:jobs:wrong" } }],
    [active, { ...attention, jobId: "job:other" }],
    [active, { ...attention, observedAt: "2026-08-14T17:00:59.000Z" }],
    [active, attention, { ...quiescent, sourceTimestamp: "2026-08-14T17:00:59.000Z" }],
    [active, { ...attention, observation: { ...attention.observation, eventId: active.observation.eventId } }]
  ];
  for (const invalid of invalidSequences) {
    assert.throws(() => validateJobEventSequence(invalid, handle));
    assert.equal(parseJobEventSequence(invalid, handle), undefined);
  }
});
