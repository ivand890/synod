import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  completeHostDelegation,
  isCodexHostOperator,
  probeCodexHostAdapter,
  resolveHostDelegationAdapter,
  startHostDelegation,
  startHostDelegationHandoff,
  type HostDelegationAdapter,
  type HostDelegationAuthorizeRequest,
  type HostDelegationDependencies
} from "../src/host-delegation.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { isRecord } from "../src/validation.js";
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
  reserve,
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
  release,
  revoke,
  heartbeat,
  setTimeout: scheduleTimeout,
  clearTimeout: clearScheduledTimeout,
  clock = () => Date.parse("2026-08-15T00:00:00.000Z")
}: {
  reserve?: HostDelegationDependencies["reserve"];
  cancel?: (options: Record<string, unknown>) => Promise<unknown>;
  expire?: (options: Record<string, unknown>) => Promise<unknown>;
  reservationValue?: TaskLeaseReservation;
  bind?: (options: { ownerThread?: string }) => Promise<unknown>;
  release?: (options: Record<string, unknown>) => Promise<unknown>;
  revoke?: (options: Record<string, unknown>) => Promise<unknown>;
  heartbeat?: (options: Record<string, unknown>) => Promise<unknown>;
  setTimeout?: HostDelegationDependencies["setTimeout"];
  clearTimeout?: HostDelegationDependencies["clearTimeout"];
  clock?: () => number;
} = {}): HostDelegationDependencies {
  const result: HostDelegationDependencies = {
    reserve: reserve || (async () => ({ task, reservation: reservationValue, writeAuthorized: false as const, state: { checkpoint: {}, lastEvent: {} } }) as never),
    clock
  };
  if (bind) result.bind = bind as unknown as NonNullable<HostDelegationDependencies["bind"]>;
  if (cancel) result.cancel = cancel as unknown as NonNullable<HostDelegationDependencies["cancel"]>;
  if (expire) result.expire = expire as unknown as NonNullable<HostDelegationDependencies["expire"]>;
  if (release) result.release = release as unknown as NonNullable<HostDelegationDependencies["release"]>;
  if (revoke) result.revoke = revoke as unknown as NonNullable<HostDelegationDependencies["revoke"]>;
  if (heartbeat) result.heartbeat = heartbeat as unknown as NonNullable<HostDelegationDependencies["heartbeat"]>;
  if (scheduleTimeout) result.setTimeout = scheduleTimeout;
  if (clearScheduledTimeout) result.clearTimeout = clearScheduledTimeout;
  return result;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the host test condition.");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("host delegation reserves, spawns read-only, preflights, binds, then activates the opaque owner", async () => {
  const calls: string[] = [];
  let spawnedRequest: any;
  const authorizedRequests: any[] = [];
  const adapter: HostDelegationAdapter = {
    async spawn(request) {
      calls.push("spawn");
      spawnedRequest = request;
      return { ownerId: "  opaque-owner  " };
    },
    async authorize(request) {
      calls.push("authorize");
      authorizedRequests.push(request);
      return { status: "authorized", receipt: "host-receipt" };
    },
    async close() {}
  };
  const result = await startHostDelegation({ id: "T-HOST", adapter, write: ["src/host-delegation.ts"] }, {
    ...dependencies(),
    reserve: async () => {
      calls.push("reserve");
      return { task, reservation, writeAuthorized: false as const, state: { checkpoint: {}, lastEvent: {} } } as never;
    },
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

  assert.deepEqual(calls, ["reserve", "spawn", "authorize", "bind", "authorize"]);
  assert.equal(spawnedRequest.writeAuthorized, false);
  assert.equal(spawnedRequest.readOnlyContract.writeAuthorized, false);
  assert.equal(result.ownerThread, "opaque-owner");
  assert.equal(authorizedRequests[0]?.phase, "preflight");
  assert.equal(authorizedRequests[0]?.ownerThread, "opaque-owner");
  assert.equal(authorizedRequests[0]?.writeAuthorized, false);
  assert.equal(authorizedRequests[0]?.lease, undefined);
  assert.equal(authorizedRequests[0]?.leaseFence, undefined);
  assert.equal(authorizedRequests[1]?.phase, "activate");
  assert.equal(authorizedRequests[1]?.writeAuthorized, true);
  assert.equal(authorizedRequests[1]?.lease?.ownerThread, "opaque-owner");
  assert.equal(authorizedRequests[1]?.leaseFence?.ownerThread, "opaque-owner");
  assert.equal(result.preflightAuthorization?.status, "authorized");
  assert.equal(result.authorization.status, "authorized");
});

test("reviewer handoff validates the exact sealed proposal and preserves observer authority", async () => {
  const proposal = {
    status: "SEALED",
    revision: 1,
    bundleId: "sha256:proposal",
    ownedPaths: ["src/owned.ts"]
  } as never;
  const reviewTask = {
    ...task,
    state: "REVIEW",
    revision: 1,
    proposal,
    acceptance: { criteria: [] },
    verification: { commands: [] }
  } as unknown as OrchestrationTask;
  const reviewerReservation = {
    ...reservation,
    generation: 1,
    taskRevision: 1,
    role: "reviewer",
    observer: true,
    scopes: [{ path: "src/owned.ts", access: "read", kind: "file" }]
  } as unknown as TaskLeaseReservation;
  let reservedOptions: Record<string, unknown> | undefined;
  const handoff = await startHostDelegationHandoff({
    id: "T-HOST",
    role: "reviewer",
    read: ["src/owned.ts"]
  }, {
    read: async () => ({ state: { tasks: { "T-HOST": reviewTask } } } as never),
    reserve: async options => {
      reservedOptions = options as unknown as Record<string, unknown>;
      return { task: reviewTask, reservation: reviewerReservation, writeAuthorized: false as const, state: {} } as never;
    },
    hostRuntimeResolver: () => ({ surface: "desktop", resolved: true, executableSource: "desktop-process", executable: "codex" })
  });

  assert.equal(reservedOptions?.role, "reviewer");
  assert.equal(reservedOptions?.observer, true);
  assert.deepEqual(reservedOptions?.read, ["src/owned.ts"]);
  assert.equal(handoff.readOnlyContract.role, "reviewer");
  assert.equal(handoff.readOnlyContract.writeAuthorized, false);
  assert.equal(handoff.readOnlyContract.proposalBundleId, "sha256:proposal");
  assert.deepEqual(handoff.readOnlyContract.ownedPaths, ["src/owned.ts"]);
  assert.match(handoff.readOnlyContract.proposalGuidance, /never write files/);
});

test("spawn failure cancels the complete reservation fence", async () => {
  let cancelled: Record<string, unknown> | undefined;
  let closed = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { throw new Error("host unavailable"); },
    async authorize() { throw new Error("must not authorize"); },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async options => { cancelled = options; }
    })),
    error => {
      assert.equal((error as { code: string }).code, ERROR_CODES.HOST_SPAWN_FAILED);
      assert.equal((error as { details: { cleanup: { status: string } } }).details.cleanup.status, "complete");
      assert.equal((error as { details: { childLoss: string } }).details.childLoss, "spawn-invoked-no-owner");
      return true;
    }
  );
  assert.equal(cancelled?.reservationToken, reservation.token);
  assert.equal(cancelled?.leaseId, reservation.id);
  assert.equal(cancelled?.generation, reservation.generation);
  assert.equal(cancelled?.revision, reservation.taskRevision);
  assert.equal(closed, 1);
});

test("never-resolving spawn expires the reservation and ignores a late owner", async () => {
  let lateOwnerResolved = false;
  let releaseSpawn!: () => void;
  let spawnStarted = false;
  const spawnReleased = new Promise<void>(resolve => { releaseSpawn = resolve; });
  let expired: Record<string, unknown> | undefined;
  let bound = 0;
  let authorized = 0;
  let closed = 0;
  const shortReservation = {
    ...reservation,
    reservedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 10).toISOString()
  } as TaskLeaseReservation;
  const adapter: HostDelegationAdapter = {
    async spawn() {
      spawnStarted = true;
      await spawnReleased;
      lateOwnerResolved = true;
      return "late-owner";
    },
    async authorize() {
      authorized += 1;
      return { status: "authorized" };
    },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      reservationValue: shortReservation,
      clock: () => Date.now(),
      expire: async options => { expired = options; },
      bind: async () => { bound += 1; return {} as never; }
    })),
    error => {
      const value = error as { code: string; details: { phase: string; cleanup: { action: string }; childLoss: string } };
      assert.equal(value.code, ERROR_CODES.HOST_SPAWN_TIMEOUT);
      assert.equal(value.details.phase, "spawn-timeout");
      assert.equal(value.details.cleanup.action, "expire");
      assert.equal(value.details.childLoss, "spawn-invoked-no-owner");
      return true;
    }
  );
  assert.equal(spawnStarted, true);
  assert.equal(closed, 1);
  releaseSpawn();
  await waitForCondition(() => lateOwnerResolved);
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
  let closed = 0;
  const nearExpiryReservation = {
    ...reservation,
    reservedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 15).toISOString()
  } as TaskLeaseReservation;
  const adapter: HostDelegationAdapter = {
    async spawn() { return {}; },
    async authorize() { authorized += 1; throw new Error("must not authorize"); },
    async close() { closed += 1; }
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
      const value = error as { code: string; details: { phase: string; cleanup: { status: string; action: string }; childLoss: string } };
      assert.equal(value.code, ERROR_CODES.HOST_OWNER_MISSING);
      assert.equal(value.details.phase, "missing-owner");
      assert.equal(value.details.cleanup.status, "complete");
      assert.equal(value.details.cleanup.action, "expire");
      assert.equal(value.details.childLoss, "spawn-invoked-no-owner");
      return true;
    }
  );
  assert.equal(expired, 1);
  assert.ok(expiredAt >= Date.parse(nearExpiryReservation.expiresAt));
  assert.equal(bound, 0);
  assert.equal(authorized, 0);
  assert.equal(closed, 1);
});

test("bind failure closes the spawned adapter before cancelling the reservation", async () => {
  let closed = 0;
  let cancelled = 0;
  const requests: HostDelegationAuthorizeRequest[] = [];
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize(request) { requests.push(request); return { status: "authorized" }; },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      bind: async () => { throw new Error("bind drift"); },
      cancel: async () => { cancelled += 1; }
    })),
    error => {
      assert.equal((error as { code: string }).code, ERROR_CODES.LEASE_STALE);
      return true;
    }
  );
  assert.equal(closed, 1);
  assert.equal(cancelled, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.phase, "preflight");
  assert.equal(requests[0]?.writeAuthorized, false);
});

test("authorization failure cancels the reservation and does not bind", async () => {
  let cancelled = 0;
  let closed = 0;
  let bound = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "failed", reason: "host rejected authorization" }; },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async () => { cancelled += 1; },
      bind: async () => {
        bound += 1;
        throw new Error("must not bind after authorize failure");
      }
    })),
    error => {
      const value = error as { code: string; details: { recovery: { status: string }; lease?: unknown; cleanup: { status: string }; phase: string } };
      assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
      assert.equal(value.details.recovery.status, "authorization-failed-reservation-unbound");
      assert.equal(value.details.phase, "authorize");
      assert.equal(value.details.cleanup.status, "complete");
      assert.equal(Object.hasOwn(value.details, "lease"), false);
      return true;
    }
  );
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
  assert.equal(bound, 0);
});

test("activation failure revokes the bound writer lease instead of leaving ACTIVE", async () => {
  let authorizationCalls = 0;
  let cancelled = 0;
  let revoked: Record<string, unknown> | undefined;
  let closed = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize(request) {
      authorizationCalls += 1;
      return request.phase === "preflight"
        ? { status: "accepted" }
        : { status: "failed", reason: "activation rejected" };
    },
    async close() { closed += 1; }
  };

  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async () => { cancelled += 1; },
      revoke: async options => { revoked = options; return {} as never; }
    })),
    error => {
      const value = error as { code: string; details: { phase: string; cleanup: { status: string; action: string }; recovery: { status: string } } };
      assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
      assert.equal(value.details.phase, "activate");
      assert.equal(value.details.cleanup.status, "complete");
      assert.equal(value.details.cleanup.action, "revoke");
      assert.equal(value.details.recovery.status, "activation-failed-lease-ended");
      return true;
    }
  );

  assert.equal(authorizationCalls, 2);
  assert.equal(cancelled, 0);
  assert.equal(closed, 1);
  assert.equal(revoked?.leaseId, reservation.id);
  assert.equal(revoked?.ownerThread, "opaque-owner");
});

test("activation is bounded before lease expiry so cleanup retains the exact fence", async () => {
  let authorizationCalls = 0;
  let activationDeadline: (() => void) | undefined;
  let activationSignal: AbortSignal | undefined;
  let revoked: Record<string, unknown> | undefined;
  let closed = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize(request) {
      authorizationCalls += 1;
      if (request.phase === "preflight") return { status: "accepted" };
      activationSignal = request.signal;
      return new Promise(() => {});
    },
    async close() { closed += 1; }
  };

  const delegated = startHostDelegation({ id: "T-HOST", adapter }, dependencies({
    setTimeout: callback => {
      activationDeadline = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
    revoke: async options => { revoked = options; return {} as never; }
  }));
  await waitForCondition(() => authorizationCalls === 2 && activationDeadline !== undefined);
  activationDeadline?.();

  await assert.rejects(delegated, error => {
    const value = error as { code: string; details: { phase: string; cleanup: { status: string; action: string } } };
    assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
    assert.equal(value.details.phase, "activate");
    assert.equal(value.details.cleanup.status, "complete");
    assert.equal(value.details.cleanup.action, "revoke");
    return true;
  });
  assert.equal(activationSignal?.aborted, true);
  assert.equal(closed, 1);
  assert.equal(revoked?.expectedHeartbeatAt, lease().heartbeatAt);
});

test("activation timeout retains the live lease when bounded adapter shutdown is unconfirmed", async () => {
  let authorizationCalls = 0;
  const deadlines: Array<() => void> = [];
  let revoked: Record<string, unknown> | undefined;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize(request) {
      authorizationCalls += 1;
      if (request.phase === "preflight") return { status: "accepted" };
      return new Promise(() => {});
    },
    async close() { return new Promise(() => {}); }
  };

  const delegated = startHostDelegation({ id: "T-HOST", adapter }, dependencies({
    setTimeout: callback => {
      deadlines.push(callback);
      return deadlines.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
    revoke: async options => { revoked = options; return {} as never; }
  }));
  await waitForCondition(() => authorizationCalls === 2 && deadlines.length === 1);
  deadlines.shift()?.();
  await waitForCondition(() => deadlines.length === 1);
  deadlines.shift()?.();

  await assert.rejects(delegated, error => {
    const value = error as {
      code: string;
      details: {
        hostAdapterClose: { status: string };
        cleanup: { status: string; action: string };
      };
    };
    assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
    assert.equal(value.details.hostAdapterClose.status, "timeout");
    assert.equal(value.details.cleanup.status, "deferred");
    assert.equal(value.details.cleanup.action, "retain-active-lease");
    return true;
  });
  assert.equal(revoked, undefined);
});

test("authorization accepts only explicit positive structured receipts and does not bind", async () => {
  for (const receipt of [
    { status: "pending" },
    { status: "queued" },
    { status: "authorized-later" },
    { ok: true },
    {},
    null,
    true
  ]) {
    let bound = 0;
    const adapter: HostDelegationAdapter = {
      async spawn() { return "opaque-owner"; },
      async authorize() { return receipt; },
      async close() {}
    };
    await assert.rejects(
      startHostDelegation({ id: "T-HOST", adapter }, dependencies({
        cancel: async () => undefined,
        bind: async () => {
          bound += 1;
          throw new Error("must not bind after authorize failure");
        }
      })),
      error => {
        const value = error as { code: string; details: { recovery: { status: string }; lease?: unknown } };
        assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
        assert.equal(value.details.recovery.status, "authorization-failed-reservation-unbound");
        assert.equal(Object.hasOwn(value.details, "lease"), false);
        return true;
      }
    );
    assert.equal(bound, 0);
  }
});

test("legacy void authorization remains the only implicit compatibility success", async () => {
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return undefined; },
    async close() {}
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
    },
    async close() {}
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
    },
    async close() {}
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
    },
    async close() {}
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

test("PATH CLI delegate start uses the Synod-owned App Server adapter", async () => {
  const messages: string[] = [];
  const adapter: HostDelegationAdapter = {
    async spawn() { return { ownerId: "thread-from-appserver" }; },
    async authorize() { return { status: "authorized" }; },
    async close() {}
  };
  const status = await run(["delegate", "start", "T-HOST", "--json"], {
    log: value => messages.push(String(value)),
    warn() {},
    error() {}
  }, {
    hostRuntimeResolver: () => ({
      surface: "cli",
      executable: "codex",
      executableSource: "PATH",
      resolved: true
    }),
    cliAppServerAdapterFactory: () => adapter
  });
  const envelope = JSON.parse(messages[0]!);
  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.notEqual(envelope.error.code, ERROR_CODES.HOST_ADAPTER_REQUIRED);
});

test("resolver uses an injected adapter and fails closed for SYNOD_HOST_ADAPTER", () => {
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async close() {}
  };
  assert.equal(resolveHostDelegationAdapter({ adapter }), adapter);
  assert.throws(
    () => resolveHostDelegationAdapter({
      adapter: {
        async spawn() { return "opaque-owner"; },
        async authorize() { return { status: "authorized" }; }
      } as unknown as HostDelegationAdapter
    }),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
  assert.equal(resolveHostDelegationAdapter({}, {}), undefined);
  assert.throws(
    () => resolveHostDelegationAdapter({}, { SYNOD_HOST_ADAPTER: "unix:/tmp/synod-host.sock" }),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
  assert.equal(
    resolveHostDelegationAdapter({}, { SYNOD_HOST_ADAPTER: "unix:/tmp/synod-host.sock" }, { allowUnsupportedChannel: true }),
    undefined
  );
});

test("Codex host-only probe never constructs an App Server", () => {
  const desktop = probeCodexHostAdapter({ surface: "desktop" });
  assert.equal(desktop.found, false);
  assert.equal(desktop.constructedAppServer, false);
  assert.equal(desktop.reason, "host-only-not-found");
  assert.equal(desktop.surface, "desktop");
  assert.equal(isCodexHostOperator({ surface: "desktop", resolved: false, executableSource: "PATH-fallback" }), true);
  assert.equal(isCodexHostOperator({ surface: "cli", resolved: true, executableSource: "cli-process" }), true);
  assert.equal(isCodexHostOperator({ surface: "cli", resolved: true, executableSource: "PATH" }), false);
  assert.equal(isCodexHostOperator({
    surface: "cli",
    resolved: true,
    executableSource: "SYNOD_CODEX_BIN",
    hostOperator: true
  }), true);
});

test("Codex handoff reserves and complete binds the stored fence", async () => {
  const handoff = await startHostDelegationHandoff({
    id: "T-HOST",
    write: ["src/host-delegation.ts"],
    evidence: ["correction:round-1"]
  }, {
    ...dependencies(),
    hostRuntimeResolver: () => ({
      surface: "desktop",
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      executableSource: "desktop-process",
      resolved: true
    })
  });
  assert.equal(handoff.hostSpawnRequired, true);
  assert.equal(handoff.readOnlyContract.writeAuthorized, false);
  assert.equal(handoff.nextCommand.operation, "delegate.complete");
  assert.deepEqual(handoff.nextCommand.argv, [
    "delegate", "complete", "T-HOST", "--evidence", "correction:round-1", "--owner-thread"
  ]);
  assert.deepEqual(handoff.nextCommand.requirements, ["owner-thread"]);
  assert.equal(handoff.probe.constructedAppServer, false);
  assert.equal(handoff.reservationFence.reservationToken, reservation.token);

  const completed = await completeHostDelegation({
    id: "T-HOST",
    ownerThread: "opaque-owner"
  }, {
    ...dependencies(),
    read: (async () => ({
      state: { tasks: { "T-HOST": { id: "T-HOST", leaseReservation: reservation } } },
      events: [],
      leaseBaselines: { baselines: [] }
    })) as never
  });
  assert.equal(completed.ownerThread, "opaque-owner");
  assert.equal(completed.authorization.status, "accepted");
  assert.equal(completed.authorization.hostNotificationRequired, true);
});

test("complete authorizes legacy role-less reservations as implementers", async () => {
  const authorizedRequests: HostDelegationAuthorizeRequest[] = [];
  const adapter: HostDelegationAdapter = {
    async spawn() { return "unused"; },
    async authorize(request) {
      authorizedRequests.push(request);
      return { status: "authorized" };
    },
    async close() {}
  };
  const completed = await completeHostDelegation({
    id: "T-HOST",
    ownerThread: "legacy-owner",
    adapter
  }, {
    ...dependencies({
      bind: async (options = {}) => ({
        task,
        lease: lease(options.ownerThread),
        writeAuthorized: true as const,
        evidence: [],
        state: { checkpoint: {}, lastEvent: {} }
      })
    }),
    read: (async () => ({
      state: { tasks: { "T-HOST": { id: "T-HOST", leaseReservation: reservation } } },
      events: [],
      leaseBaselines: { baselines: [] }
    })) as never
  });

  assert.equal(authorizedRequests[0]?.phase, "preflight");
  assert.equal(authorizedRequests[0]?.writeAuthorized, false);
  assert.equal(authorizedRequests[0]?.role, undefined);
  assert.equal(authorizedRequests[0]?.lease, undefined);
  assert.equal(authorizedRequests[1]?.phase, "activate");
  assert.equal(authorizedRequests[1]?.writeAuthorized, true);
  assert.equal(authorizedRequests[1]?.role, undefined);
  assert.equal(authorizedRequests[1]?.lease?.ownerThread, "legacy-owner");
  assert.equal(completed.role, "implementer");
});

test("complete authorization failure cancels the reservation and does not bind", async () => {
  let cancelled = 0;
  let bound = 0;
  let closed = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "unused"; },
    async authorize() { return { status: "denied" }; },
    async close() { closed += 1; }
  };
  await assert.rejects(
    completeHostDelegation({
      id: "T-HOST",
      ownerThread: "opaque-owner",
      adapter
    }, {
      ...dependencies({
        cancel: async () => { cancelled += 1; },
        bind: async () => {
          bound += 1;
          throw new Error("must not bind after authorize failure");
        }
      }),
      read: (async () => ({
        state: { tasks: { "T-HOST": { id: "T-HOST", leaseReservation: reservation } } },
        events: [],
        leaseBaselines: { baselines: [] }
      })) as never
    }),
    error => {
      const value = error as { code: string; details: { recovery: { status: string }; phase: string; cleanup: { status: string } } };
      assert.equal(value.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
      assert.equal(value.details.recovery.status, "authorization-failed-reservation-unbound");
      assert.equal(value.details.phase, "authorize");
      assert.equal(value.details.cleanup.status, "complete");
      return true;
    }
  );
  assert.equal(cancelled, 1);
  assert.equal(bound, 0);
  assert.equal(closed, 1);
});

test("handoff --wait without an adapter fails closed", async () => {
  await assert.rejects(
    () => startHostDelegationHandoff({ id: "T-HOST", wait: true }, dependencies()),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.HOST_ADAPTER_REQUIRED
  );
});

test("reservation expiry before spawn classifies spawn-not-invoked and does not invoke spawn", async () => {
  let spawned = 0;
  let closed = 0;
  let expired: Record<string, unknown> | undefined;
  const expiredReservation = {
    ...reservation,
    expiresAt: "2026-08-14T23:59:59.000Z"
  } as TaskLeaseReservation;
  const adapter: HostDelegationAdapter = {
    async spawn() {
      spawned += 1;
      return "should-not-run";
    },
    async authorize() { throw new Error("must not authorize"); },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      reservationValue: expiredReservation,
      clock: () => Date.parse("2026-08-15T00:00:00.000Z"),
      expire: async options => { expired = options; }
    })),
    error => {
      assert.ok(error instanceof SynodError);
      assert.equal(error.code, ERROR_CODES.HOST_SPAWN_TIMEOUT);
      assert.ok(isRecord(error.details));
      assert.equal(error.details.childLoss, "spawn-not-invoked");
      return true;
    }
  );
  assert.equal(spawned, 0);
  assert.equal(closed, 0);
  assert.equal(expired?.reservationToken, expiredReservation.token);
});

test("unclassified child-loss details fail closed and still close the child", async () => {
  let closed = 0;
  let cancelled = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() {
      throw new SynodError(ERROR_CODES.HOST_SPAWN_FAILED, "collapsed", {
        details: { childLoss: "mystery" }
      });
    },
    async authorize() { throw new Error("must not authorize"); },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async () => { cancelled += 1; }
    })),
    error => {
      assert.ok(error instanceof SynodError);
      assert.equal(error.code, ERROR_CODES.HOST_ADAPTER_INVALID);
      assert.equal(error.message, "child loss was not classified.");
      assert.ok(isRecord(error.details));
      assert.equal(error.details.childLoss, "mystery");
      return true;
    }
  );
  assert.equal(closed, 1);
  assert.equal(cancelled, 1);
});

test("authorize-time App Server exit classifies child-dead-lease-live, closes, and cancels the reservation", async () => {
  let closed = 0;
  let cancelled = 0;
  let bound = 0;
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() {
      throw new SynodError(ERROR_CODES.APP_SERVER_EXITED, "owned App Server exited");
    },
    async close() { closed += 1; }
  };
  await assert.rejects(
    startHostDelegation({ id: "T-HOST", adapter }, dependencies({
      cancel: async () => { cancelled += 1; },
      bind: async () => {
        bound += 1;
        throw new Error("must not bind after authorize failure");
      }
    })),
    error => {
      assert.ok(error instanceof SynodError);
      assert.equal(error.code, ERROR_CODES.APP_SERVER_EXITED);
      assert.ok(isRecord(error.details));
      assert.equal(error.details.childLoss, "child-dead-lease-live");
      assert.equal(error.details.phase, "authorize");
      assert.equal(isRecord(error.details.cleanup) && error.details.cleanup.status, "complete");
      assert.equal(Object.hasOwn(error.details, "lease"), false);
      return true;
    }
  );
  assert.equal(closed, 1);
  assert.equal(cancelled, 1);
  assert.equal(bound, 0);
});

test("host wait timeout without a wake classifies wait-never-woke", async () => {
  const adapter: HostDelegationAdapter = {
    async spawn() { return "opaque-owner"; },
    async authorize() { return { status: "authorized" }; },
    async wait() {
      return { statuses: [{ threadId: "opaque-owner", status: { type: "active" as const, activeFlags: [] } }] };
    },
    async close() {}
  };
  const report: WaitReport = {
    mode: "poll",
    waitAuthority: "host",
    threadIds: ["opaque-owner"],
    wakeCount: 0,
    fallbackPollCount: 1,
    elapsedMs: 10,
    timedOut: true,
    aborted: false,
    incomplete: true,
    approvalNeeded: false,
    userInputNeeded: false,
    hostWaitRequired: false,
    hostWaitThreadIds: [],
    hostFallbackRequired: false,
    hostFallbackThreadIds: [],
    statuses: [{ threadId: "opaque-owner", status: { type: "active", activeFlags: [] } }],
    warnings: [],
    diagnostics: {}
  };
  const result = await startHostDelegation({
    id: "T-HOST",
    adapter,
    wait: { timeoutMs: 10, heartbeatIntervalMs: 1_000 }
  }, {
    ...dependencies({
      heartbeat: async () => ({ lease: lease("opaque-owner", "2026-08-15T00:00:02.000Z") })
    }),
    wait: async () => report,
    setInterval: ((callback: () => void) => { callback(); return 1 as never; }) as never,
    clearInterval: (() => undefined) as never
  });
  assert.equal(result.wait?.timedOut, true);
  assert.equal(result.wait?.diagnostics.childLoss, "wait-never-woke");
});

test("PATH CLI delegate --wait does not treat App Server events as wait --task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-delegate-cli-wait-unmanaged-"));
  const messages: string[] = [];
  let spawned = 0;
  try {
    const adapter: HostDelegationAdapter = {
      async spawn() {
        spawned += 1;
        return { ownerId: "thread-from-appserver" };
      },
      async authorize() { return { status: "authorized" }; },
      async wait() { throw new Error("must not treat App Server events as wait --task"); },
      async close() {}
    };
    const status = await run(["delegate", "start", "T-HOST", "--wait", "--cwd", directory, "--json"], {
      log: value => messages.push(String(value)),
      warn() {},
      error() {}
    }, {
      hostRuntimeResolver: () => ({
        surface: "cli",
        executable: "codex",
        executableSource: "PATH",
        resolved: true
      }),
      cliAppServerAdapterFactory: () => adapter
    });
    const envelope = JSON.parse(messages[0]!);
    assert.equal(status, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, ERROR_CODES.HOST_ADAPTER_INVALID);
    assert.equal(spawned, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
