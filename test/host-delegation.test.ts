import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  startHostDelegation,
  type HostDelegationAdapter,
  type HostDelegationDependencies
} from "../src/host-delegation.js";
import { ERROR_CODES } from "../src/errors.js";
import { run } from "../src/cli.js";
import type { TaskLease, TaskLeaseReservation } from "../src/leases.js";
import type { OrchestrationTask } from "../src/orchestration.js";
import { waitForThreads, type WaitReport } from "../src/wait.js";

const reservation = {
  id: "11111111-1111-4111-8111-111111111111",
  token: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  taskId: "T-HOST",
  taskRevision: 0,
  executor: "synod_implementer",
  scopes: [{ path: "src/host-delegation.ts", access: "write", kind: "file" }],
  reservedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2026-08-15T00:05:00.000Z",
  ttlSeconds: 300,
  baseline: {
    path: ".synod/lease-baselines.json",
    snapshotContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "main",
    head: "deadbeef",
    worktreeFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lastEvent: { sequence: 1, id: "event-1", hash: "hash-1" }
  },
  status: "RESERVED"
} as unknown as TaskLeaseReservation;

const task = {
  id: "T-HOST",
  state: "READY",
  revision: 0
} as unknown as OrchestrationTask;

function lease(ownerThread = "opaque-owner", heartbeatAt = "2026-08-15T00:00:01.000Z"): TaskLease {
  return {
    id: reservation.id,
    generation: reservation.generation,
    taskId: reservation.taskId,
    taskRevision: reservation.taskRevision,
    ownerThread,
    executor: reservation.executor,
    scopes: reservation.scopes,
    acquiredAt: heartbeatAt,
    heartbeatAt,
    expiresAt: "2026-08-15T00:30:01.000Z",
    heartbeatIntervalSeconds: 30,
    ttlSeconds: 1_800,
    baseline: reservation.baseline,
    status: "ACTIVE"
  };
}

function dependencies({
  cancel,
  expire,
  reservationValue = reservation,
  bind = async (options: { ownerThread?: string }) => ({
    task,
    lease: lease(options.ownerThread),
    writeAuthorized: true as const,
    evidence: [],
    state: { checkpoint: {}, lastEvent: {} }
  }),
  heartbeat,
  clock = () => Date.parse("2026-08-15T00:00:00.000Z")
}: {
  cancel?: (options: Record<string, unknown>) => Promise<unknown>;
  expire?: (options: Record<string, unknown>) => Promise<unknown>;
  reservationValue?: TaskLeaseReservation;
  bind?: (options: { ownerThread?: string }) => Promise<unknown>;
  heartbeat?: (options: Record<string, unknown>) => Promise<unknown>;
  clock?: () => number;
} = {}): HostDelegationDependencies {
  const result: HostDelegationDependencies = {
    reserve: async () => ({ task, reservation: reservationValue, writeAuthorized: false as const, state: { checkpoint: {}, lastEvent: {} } }) as never,
    clock
  };
  if (bind) result.bind = bind as unknown as NonNullable<HostDelegationDependencies["bind"]>;
  if (cancel) result.cancel = cancel as unknown as NonNullable<HostDelegationDependencies["cancel"]>;
  if (expire) result.expire = expire as unknown as NonNullable<HostDelegationDependencies["expire"]>;
  if (heartbeat) result.heartbeat = heartbeat as unknown as NonNullable<HostDelegationDependencies["heartbeat"]>;
  return result;
}

test("host delegation reserves, spawns read-only, binds the opaque owner, then authorizes", async () => {
  const calls: string[] = [];
  let spawnedRequest: any;
  let authorizedRequest: any;
  const adapter: HostDelegationAdapter = {
    async spawn(request) {
      calls.push("spawn");
      spawnedRequest = request;
      return { ownerId: "  opaque-owner  " };
    },
    async authorize(request) {
      calls.push("authorize");
      authorizedRequest = request;
      return { status: "authorized", receipt: "host-receipt" };
    }
  };
  const result = await startHostDelegation({ id: "T-HOST", adapter, write: ["src/host-delegation.ts"] }, {
    ...dependencies(),
    bind: async (options = {}) => {
      calls.push("bind");
      return {
        task,
        lease: lease(options.ownerThread),
        writeAuthorized: true as const,
        evidence: [],
        state: { checkpoint: {}, lastEvent: {} }
      } as never;
    }
  });
  calls.unshift("reserve");

  assert.deepEqual(calls, ["reserve", "spawn", "bind", "authorize"]);
  assert.equal(spawnedRequest.writeAuthorized, false);
  assert.equal(spawnedRequest.readOnlyContract.writeAuthorized, false);
  assert.equal(result.ownerThread, "opaque-owner");
  assert.equal(authorizedRequest.ownerThread, "opaque-owner");
  assert.equal(authorizedRequest.writeAuthorized, true);
  assert.equal(result.authorization.status, "authorized");
});

test("spawn failure cancels the complete reservation fence", async () => {
  let cancelled: Record<string, unknown> | undefined;
  const adapter: HostDelegationAdapter = {
    async spawn() { throw new Error("host unavailable"); },
    async authorize() { throw new Error("must not authorize"); }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async options => { cancelled = options; }
    })),
    error => {
      assert.equal((error as { code: string }).code, ERROR_CODES.HOST_SPAWN_FAILED);
      assert.equal((error as { details: { cleanup: { status: string } } }).details.cleanup.status, "complete");
      return true;
    }
  );
  assert.equal(cancelled?.reservationToken, reservation.token);
  assert.equal(cancelled?.leaseId, reservation.id);
  assert.equal(cancelled?.generation, reservation.generation);
  assert.equal(cancelled?.revision, reservation.taskRevision);
});

test("never-resolving spawn expires the reservation and ignores a late owner", async () => {
  let lateOwnerResolved = false;
  let expired: Record<string, unknown> | undefined;
  let bound = 0;
  let authorized = 0;
  const shortReservation = {
    ...reservation,
    reservedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 10).toISOString()
  } as TaskLeaseReservation;
  const adapter: HostDelegationAdapter = {
    async spawn() {
      await delay(40);
      lateOwnerResolved = true;
      return "late-owner";
    },
    async authorize() {
      authorized += 1;
      return { status: "authorized" };
    }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      reservationValue: shortReservation,
      clock: () => Date.now(),
      expire: async options => { expired = options; },
      bind: async () => { bound += 1; return {} as never; }
    })),
    error => {
      const value = error as { code: string; details: { phase: string; cleanup: { action: string } } };
      assert.equal(value.code, ERROR_CODES.HOST_SPAWN_TIMEOUT);
      assert.equal(value.details.phase, "spawn-timeout");
      assert.equal(value.details.cleanup.action, "expire");
      return true;
    }
  );
  await delay(50);
  assert.equal(lateOwnerResolved, true);
  assert.equal(bound, 0);
  assert.equal(authorized, 0);
  assert.equal(expired?.reservationToken, shortReservation.token);
  assert.equal(expired?.leaseId, shortReservation.id);
});

test("missing owner fails closed and expires without binding", async () => {
  let expired = 0;
  let expiredAt = 0;
  let bound = 0;
  let authorized = 0;
  const nearExpiryReservation = {
    ...reservation,
    reservedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 15).toISOString()
  } as TaskLeaseReservation;
  const adapter: HostDelegationAdapter = {
    async spawn() { return {}; },
    async authorize() { authorized += 1; throw new Error("must not authorize"); }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      expire: async options => {
        expired += 1;
        expiredAt = Date.now();
        assert.equal(options.reservationToken, nearExpiryReservation.token);
        assert.equal(options.leaseId, nearExpiryReservation.id);
      },
      reservationValue: nearExpiryReservation,
      clock: () => Date.now(),
      bind: async () => { bound += 1; return {} as never; }
    })),
    error => {
      const value = error as { code: string; details: { phase: string; cleanup: { status: string; action: string } } };
      assert.equal(value.code, ERROR_CODES.HOST_OWNER_MISSING);
      assert.equal(value.details.phase, "missing-owner");
      assert.equal(value.details.cleanup.status, "complete");
      assert.equal(value.details.cleanup.action, "expire");
      return true;
    }
  );
  assert.equal(expired, 1);
  assert.ok(expiredAt >= Date.parse(nearExpiryReservation.expiresAt));
  assert.equal(bound, 0);
  assert.equal(authorized, 0);
});

test("authorization failure leaves the bound lease as truthful recovery state", async () => {
  let cancelled = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "failed", reason: "host rejected authorization" }; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({ cancel: async () => { cancelled += 1; } })),
    error => {
      const value = error as { code: string; details: { recovery: { status: string }; lease: TaskLease } };
      assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
      assert.equal(value.details.recovery.status, "lease-bound-awaiting-authorization");
      assert.equal(value.details.lease.ownerThread, "opaque-owner");
      return true;
    }
  );
  assert.equal(cancelled, 0);
});

test("authorization accepts only explicit positive structured receipts and preserves the bound lease", async () => {
  for (const receipt of [
    { status: "pending" },
    { status: "queued" },
    { status: "authorized-later" },
    { ok: true },
    {},
    null,
    true
  ]) {
    const adapter: HostDelegationAdapter = {
      async spawn() { return "opaque-owner"; },
      async authorize() { return receipt; }
    };
    await assert.rejects(
      startHostDelegation({ id: "T-HOST", adapter }, dependencies()),
      error => {
        const value = error as { code: string; details: { recovery: { status: string }; lease: TaskLease } };
        assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
        assert.equal(value.details.recovery.status, "lease-bound-awaiting-authorization");
        assert.equal(value.details.lease.ownerThread, "opaque-owner");
        return true;
      }
    );
  }
});

test("legacy void authorization remains the only implicit compatibility success", async () => {
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return undefined; }
  };
  const result = await startHostDelegation({ id: "T-HOST", adapter }, dependencies());
  assert.equal(result.authorization.status, "authorized");
});

test("host wait reports host authority and stops exact-fenced heartbeat on completion", async () => {
  let heartbeatCount = 0;
  let cleared = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async wait() {
      return { statuses: [{ threadId: "opaque-owner", status: { type: "idle" as const } }] };
    }
  };
  const report: WaitReport = {
    mode: "poll",
    waitAuthority: "host",
    threadIds: ["opaque-owner"],
    wakeCount: 0,
    fallbackPollCount: 0,
    elapsedMs: 1,
    timedOut: false,
    aborted: false,
    incomplete: false,
    approvalNeeded: false,
    userInputNeeded: false,
    hostWaitRequired: false,
    hostWaitThreadIds: [],
    hostFallbackRequired: false,
    hostFallbackThreadIds: [],
    statuses: [{ threadId: "opaque-owner", status: { type: "idle" } }],
    warnings: [],
    diagnostics: {}
  };
  const result = await startHostDelegation({
    id: "T-HOST",
    adapter,
    wait: { timeoutMs: 100, heartbeatIntervalMs: 1 }
  }, {
    ...dependencies({
      heartbeat: async options => {
        heartbeatCount += 1;
        assert.equal(options.leaseId, reservation.id);
        assert.equal(options.generation, 1);
        assert.equal(options.revision, 0);
        assert.equal(options.expectedHeartbeatAt, "2026-08-15T00:00:01.000Z");
        return { lease: lease("opaque-owner", "2026-08-15T00:00:02.000Z") };
      }
    }),
    wait: async (_options, waitDependencies) => {
      assert.equal(waitDependencies?.hostAdapter, adapter);
      return report;
    },
    setInterval: ((callback: () => void) => { callback(); return 1 as never; }) as never,
    clearInterval: (() => { cleared += 1; }) as never
  });
  assert.equal(result.wait?.waitAuthority, "host");
  assert.equal(result.liveness?.stopReason, "complete");
  assert.equal(result.liveness?.heartbeatCount, 1);
  assert.equal(heartbeatCount, 1);
  assert.equal(cleared, 1);
});

test("wait uses an injected host observer with host authority and transport kept separate", async () => {
  let closed = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async wait(request) {
      assert.deepEqual(request.threadIds, ["opaque-owner"]);
      return { statuses: [{ threadId: "opaque-owner", status: { type: "idle" } }], mode: "poll", diagnostics: { source: "host" } };
    },
    async close() { closed += 1; }
  };
  const report = await waitForThreads({ threadIds: ["opaque-owner"], timeoutMs: 100 }, { hostAdapter: adapter });
  assert.equal(report.waitAuthority, "host");
  assert.equal(report.mode, "poll");
  assert.equal(report.incomplete, false);
  assert.equal(report.diagnostics.source, "host");
  assert.equal(closed, 1);
});

test("host-owned notLoaded observation stays incomplete without recursive host handoff", async () => {
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async read() {
      return { statuses: [{ threadId: "opaque-owner", status: { type: "notLoaded" } }] };
    }
  };
  const report = await waitForThreads({ threadIds: ["opaque-owner"], timeoutMs: 100 }, { hostAdapter: adapter });
  assert.equal(report.waitAuthority, "host");
  assert.equal(report.incomplete, true);
  assert.deepEqual(report.statuses, [{ threadId: "opaque-owner", status: { type: "notLoaded" } }]);
  assert.equal(report.hostWaitRequired, false);
  assert.deepEqual(report.hostWaitThreadIds, []);
  assert.equal(report.hostFallbackRequired, false);
  assert.deepEqual(report.hostFallbackThreadIds, []);
});

test("stale host heartbeat fails closed and stops liveness with diagnostics", async () => {
  let cleared = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async wait() {
      await new Promise<void>(resolve => setImmediate(resolve));
      return { statuses: [{ threadId: "opaque-owner", status: { type: "active", activeFlags: [] } }] };
    }
  };
  const result = await startHostDelegation({ id: "T-HOST", adapter, wait: { timeoutMs: 100, heartbeatIntervalMs: 1 } }, {
    ...dependencies({
      heartbeat: async () => ({ lease: lease("different-owner", "2026-08-14T23:59:00.000Z") })
    }),
    setInterval: ((callback: () => void) => { callback(); return 1 as never; }) as never,
    clearInterval: (() => { cleared += 1; }) as never
  });
  assert.equal(result.liveness?.stopReason, "heartbeat-error");
  assert.equal(result.liveness?.heartbeatErrors.length, 1);
  assert.equal(result.wait?.diagnostics.hostLiveness !== undefined, true);
  assert.equal(cleared, 1);
});

test("CLI delegate start fails closed without a host adapter", async () => {
  const messages: string[] = [];
  const status = await run(["delegate", "start", "T-HOST", "--json"], {
    log: value => messages.push(String(value)),
    warn() {},
    error() {}
  });
  const envelope = JSON.parse(messages[0]!);
  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.HOST_ADAPTER_REQUIRED);
});
