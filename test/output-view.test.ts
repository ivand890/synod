import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import {
  parseOutputViewArgs,
  projectJsonEnvelope,
  projectSummary
} from "../src/output-view.js";

test("output view parsing is explicit, JSON-only, and backward compatible", () => {
  assert.deepEqual(parseOutputViewArgs(["status", "--json"]), {
    args: ["status", "--json"],
    view: "full"
  });
  assert.deepEqual(parseOutputViewArgs(["status", "--json", "--view", "summary"]), {
    args: ["status", "--json"],
    view: "summary"
  });
  assert.throws(
    () => parseOutputViewArgs(["status", "--view", "summary"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
  assert.throws(
    () => parseOutputViewArgs(["status", "--json", "--view", "compact"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
});

test("summary status retains live lifecycle while omitting historical bulk", () => {
  const status = projectSummary("status", {
    targetDirectory: "/tmp/project",
    healthy: true,
    stateSchemaVersion: 4,
    templateVersion: "0.9.1",
    updatedAt: "2026-08-14T00:00:00.000Z",
    lastEvent: { sequence: 7, id: "event-7", hash: "sha256:event" },
    eventCount: 7,
    checkpoint: {
      capturedAt: "2026-08-14T00:00:00.000Z",
      available: true,
      branch: "main",
      head: "abc",
      worktree: { clean: true, entries: 0, fingerprint: "sha256:worktree", snapshot: { contentHash: "sha256:snapshot" } }
    },
    currentCheckpoint: {
      capturedAt: "2026-08-14T00:00:00.000Z",
      available: true,
      branch: "main",
      head: "abc",
      worktree: { clean: true, entries: 0, fingerprint: "sha256:worktree", snapshot: { contentHash: "sha256:snapshot" } }
    },
    drift: { detected: false, reasons: [] },
    taskCounts: { READY: 1 },
    tasks: [{
      id: "T-001",
      objective: "Keep supervision small",
      dependsOn: [],
      state: "READY",
      revision: 2,
      executor: "synod_implementer",
      correctionRound: 1,
      leaseGeneration: 3,
      correctionPolicy: { limit: 2, used: 1, overrides: [{ reason: "history" }] },
      acceptance: { status: "pending", revision: null, evidenceIds: ["E-1"] },
      verification: { status: "pending", revision: null, evidenceIds: ["E-2"] },
      evidence: [{ id: "E-1" }],
      recoveryHistory: [{ status: "REASSIGNED" }],
      lease: { id: "lease-1", generation: 3, taskId: "T-001", taskRevision: 2, ownerThread: "thread:worker", status: "ACTIVE", scopes: [], heartbeatAt: "now" },
      leaseReservation: undefined,
      proposal: { bundleId: "sha256:proposal", revision: 2, status: "SEALED", ownedPaths: ["src/output-view.ts"] },
      recovery: undefined
    }],
    rotation: null,
    leaseExpiryCandidates: [],
    leaseReservationExpiryCandidates: [],
    markdownView: "docs/synod/STATUS.md",
    delta: { changed: false, paths: [{ path: "history" }], counts: { staged: 0 } }
  }) as Record<string, unknown>;

  assert.equal(status.healthy, true);
  assert.deepEqual(status.lastEvent, { sequence: 7, id: "event-7", hash: "sha256:event" });
  assert.deepEqual(status.taskCounts, { READY: 1 });
  assert.deepEqual((status.delta as Record<string, unknown>).counts, { staged: 0 });
  assert.equal(Object.hasOwn(status.delta as Record<string, unknown>, "paths"), false);
  const task = (status.tasks as Array<Record<string, unknown>>)[0]!;
  assert.equal(task.state, "READY");
  assert.equal(task.revision, 2);
  assert.deepEqual(task.lease, {
    id: "lease-1",
    generation: 3,
    taskId: "T-001",
    taskRevision: 2,
    ownerThread: "thread:worker",
    status: "ACTIVE",
    heartbeatAt: "now"
  });
  assert.deepEqual(task.proposal, {
    bundleId: "sha256:proposal",
    revision: 2,
    status: "SEALED"
  });
  assert.equal(Object.hasOwn(task, "evidence"), false);
  assert.equal(task.evidenceCount, 1);
  assert.equal(task.recoveryHistoryCount, 1);
  assert.equal((status.checkpoint as Record<string, unknown>).worktree !== undefined, true);
  assert.equal(Object.hasOwn((status.checkpoint as Record<string, unknown>).worktree as Record<string, unknown>, "snapshot"), false);
});

test("summary lease mutation keeps the exact next-operation fence", () => {
  const reservation = projectSummary("lease", {
    action: "reserve",
    task: { id: "T-RESERVE", state: "READY", revision: 0, correctionPolicy: { limit: 2, used: 0 }, leaseReservation: { id: "lease-1" } },
    reservation: {
      id: "lease-1",
      token: "token-1",
      generation: 1,
      taskId: "T-RESERVE",
      taskRevision: 0,
      reservedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T00:05:00.000Z",
      baseline: { snapshotContentHash: "sha256:baseline" },
      status: "RESERVED"
    }
  }) as Record<string, unknown>;
  const next = reservation.nextOperation as Record<string, unknown>;
  assert.equal(next.operation, "lease.bind");
  assert.deepEqual(next.fence, {
    reservationToken: "token-1",
    leaseId: "lease-1",
    generation: 1,
    revision: 0,
    expectedReservedAt: "2026-08-14T00:00:00.000Z",
    baselineHash: "sha256:baseline"
  });

  const active = projectSummary("lease", {
    action: "heartbeat",
    task: { id: "T-ACTIVE", state: "ACTIVE", revision: 1, recovery: null },
    lease: {
      id: "lease-2",
      generation: 2,
      taskId: "T-ACTIVE",
      taskRevision: 1,
      ownerThread: "thread:worker",
      heartbeatAt: "2026-08-14T00:01:00.000Z",
      status: "ACTIVE"
    }
  }) as Record<string, unknown>;
  assert.deepEqual((active.nextOperation as Record<string, unknown>).fence, {
    leaseId: "lease-2",
    generation: 2,
    revision: 1,
    expectedHeartbeatAt: "2026-08-14T00:01:00.000Z",
    ownerThread: "thread:worker"
  });
});

test("summary proposal submission exposes the exact acceptance action without a lease fence", () => {
  const summary = projectSummary("proposal", {
    action: "submit",
    task: {
      id: "T-PROPOSAL",
      state: "REVIEW",
      revision: 3,
      correctionPolicy: { limit: 2, used: 0 },
      lease: undefined,
      proposal: { bundleId: "sha256:proposal", revision: 3, status: "SEALED" }
    },
    proposal: {
      path: ".synod/proposals/lease-1/1",
      bundleId: "sha256:proposal",
      leaseId: "lease-1",
      generation: 1,
      baseRevision: 2,
      revision: 3,
      status: "SEALED"
    },
    evidence: [{ id: "E-1", kind: "test", revision: 3, reference: "test:proposal" }],
    checkpoint: {
      capturedAt: "2026-08-14T00:00:00.000Z",
      available: true,
      branch: "main",
      head: "abc",
      worktree: { clean: true, entries: 0, fingerprint: "sha256:worktree", snapshot: { contentHash: "sha256:snapshot" } }
    },
    lastEvent: { sequence: 8, id: "event-8", hash: "sha256:event" }
  }) as Record<string, unknown>;

  assert.deepEqual(summary.nextOperation, {
    operation: "task.transition",
    arguments: { taskId: "T-PROPOSAL", to: "ACCEPTED", revision: 3, evidence: [] },
    requirements: ["evidence"]
  });
  assert.equal(Object.hasOwn(summary.nextOperation as Record<string, unknown>, "fence"), false);
  assert.deepEqual(summary.task, {
    id: "T-PROPOSAL",
    state: "REVIEW",
    revision: 3,
    correctionPolicy: { limit: 2, used: 0 },
    lease: null,
    leaseReservation: null,
    proposal: { bundleId: "sha256:proposal", revision: 3, status: "SEALED" },
    recovery: null
  });
  assert.deepEqual(summary.proposal, {
    path: ".synod/proposals/lease-1/1",
    bundleId: "sha256:proposal",
    leaseId: "lease-1",
    generation: 1,
    baseRevision: 2,
    revision: 3,
    status: "SEALED"
  });
  assert.equal(summary.evidenceCount, 1);
  assert.deepEqual(summary.lastEvent, { sequence: 8, id: "event-8", hash: "sha256:event" });
  assert.deepEqual(summary.checkpoint, {
    capturedAt: "2026-08-14T00:00:00.000Z",
    available: true,
    branch: "main",
    head: "abc",
    worktree: { clean: true, entries: 0, fingerprint: "sha256:worktree" }
  });
});

test("summary task-next preserves guidance gates and exact typed actions", () => {
  const action = {
    operation: "lease.bind",
    arguments: {
      taskId: "T-GUIDANCE",
      reservationToken: "reservation-token",
      leaseId: "lease-guidance",
      generation: 2,
      revision: 4,
      expectedReservedAt: "2026-08-14T00:00:00.000Z",
      baselineHash: "sha256:baseline",
      ownerThread: null,
      evidence: []
    },
    requirements: ["owner-thread", "evidence"]
  };
  const envelope = {
    ok: true as const,
    command: "task",
    data: {
      action: "next",
      guidance: {
        recommendedTaskId: "T-GUIDANCE",
        tasks: [{
          id: "T-GUIDANCE",
          state: "REVIEW",
          revision: 4,
          dependsOn: ["T-BASE"],
          incompleteDependencies: ["T-BASE"],
          correction: { limit: 2, used: 1, overrides: [{ reason: "history" }] },
          budget: { policyRevision: 3, thresholdStatus: "ok", decisionRequired: false, observations: [{ event: "omit" }] },
          recovery: { status: "PENDING", priorGeneration: 1, priorOwnerThread: "thread:old", endedLease: { id: "omit" } },
          lease: {
            id: "lease-guidance",
            generation: 2,
            taskId: "T-GUIDANCE",
            taskRevision: 4,
            ownerThread: "thread:worker",
            status: "ACTIVE",
            heartbeatAt: "2026-08-14T00:01:00.000Z",
            scopes: ["omit"]
          },
          reservation: {
            id: "reservation-guidance",
            token: "reservation-token",
            generation: 2,
            taskId: "T-GUIDANCE",
            taskRevision: 4,
            reservedAt: "2026-08-14T00:00:00.000Z",
            expiresAt: "2026-08-14T00:05:00.000Z",
            baseline: { snapshotContentHash: "sha256:baseline", branch: "omit" },
            status: "RESERVED"
          },
          proposal: { bundleId: "sha256:proposal", revision: 4, status: "SEALED", path: ".synod/proposals/omit" },
          constraints: { reservationRequiresBind: true, recoveryDecisionRequired: true },
          legalTransitions: ["ACTIVE", "BLOCKED"],
          actions: [action],
          evidence: [{ id: "omit-history" }]
        }],
        lastEvent: { sequence: 12, id: "event-12", hash: "sha256:event" }
      }
    },
    warnings: [],
    diagnostics: {}
  };

  assert.deepEqual(projectJsonEnvelope(envelope, "full"), envelope);
  const summary = projectJsonEnvelope(envelope, "summary") as typeof envelope;
  const task = summary.data.guidance.tasks[0]!;
  assert.equal(task.id, "T-GUIDANCE");
  assert.deepEqual(task.dependsOn, ["T-BASE"]);
  assert.deepEqual(task.incompleteDependencies, ["T-BASE"]);
  assert.deepEqual(task.correction, { limit: 2, used: 1 });
  assert.deepEqual(task.budget, { policyRevision: 3, thresholdStatus: "ok", decisionRequired: false });
  assert.deepEqual(task.recovery, { status: "PENDING", priorGeneration: 1, priorOwnerThread: "thread:old" });
  assert.deepEqual(task.constraints, { reservationRequiresBind: true, recoveryDecisionRequired: true });
  assert.deepEqual(task.legalTransitions, ["ACTIVE", "BLOCKED"]);
  assert.deepEqual(task.actions, [action]);
  assert.equal(Object.hasOwn(task, "evidence"), false);
  assert.deepEqual(task.lease, {
    id: "lease-guidance",
    generation: 2,
    taskId: "T-GUIDANCE",
    taskRevision: 4,
    ownerThread: "thread:worker",
    status: "ACTIVE",
    heartbeatAt: "2026-08-14T00:01:00.000Z"
  });
  assert.deepEqual(task.reservation, {
    id: "reservation-guidance",
    token: "reservation-token",
    generation: 2,
    taskId: "T-GUIDANCE",
    taskRevision: 4,
    reservedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:05:00.000Z",
    status: "RESERVED",
    baseline: { snapshotContentHash: "sha256:baseline", branch: "omit" }
  });
  assert.deepEqual(task.proposal, {
    path: ".synod/proposals/omit",
    bundleId: "sha256:proposal",
    revision: 4,
    status: "SEALED"
  });

  const fencedActions: Array<Record<string, unknown>> = [
    {
      operation: "lease.expire",
      arguments: {
        taskId: "T-EXPIRED-RESERVATION",
        reservationToken: "expired-reservation-token",
        leaseId: "expired-reservation-lease",
        generation: 3,
        revision: 2,
        expectedReservedAt: "2026-08-14T00:00:00.000Z",
        baselineHash: "sha256:expired-baseline",
        reason: null
      },
      requirements: ["reason"]
    },
    {
      operation: "lease.expire",
      arguments: {
        taskId: "T-EXPIRED-LEASE",
        leaseId: "expired-lease",
        generation: 4,
        revision: 2,
        expectedHeartbeatAt: "2026-08-14T00:01:00.000Z",
        reason: null
      },
      requirements: ["reason"]
    },
    {
      operation: "lease.recover",
      arguments: {
        taskId: "T-RECOVER",
        leaseId: "recover-lease",
        generation: 5,
        revision: 3,
        expectedHeartbeatAt: "2026-08-14T00:02:00.000Z",
        decision: null,
        reason: null
      },
      requirements: ["decision", "reason"]
    }
  ];
  const fencedSummary = projectSummary("task", {
    action: "next",
    guidance: {
      recommendedTaskId: "T-EXPIRED-RESERVATION",
      tasks: fencedActions.map((actions, index) => ({
        id: `T-FENCE-${index}`,
        state: "READY",
        revision: 0,
        dependsOn: [],
        incompleteDependencies: [],
        budget: null,
        recovery: null,
        lease: null,
        reservation: null,
        proposal: null,
        constraints: {},
        legalTransitions: [],
        actions: [actions]
      }))
    }
  }) as Record<string, unknown>;
  const fencedTasks = (fencedSummary.guidance as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
  assert.deepEqual(fencedTasks.map(task => task.actions), fencedActions.map(action => [action]));
});

test("summary wait selection retains task selector identity", () => {
  const envelope = {
    ok: true as const,
    command: "wait",
    data: {
      selection: {
        requestedTaskIds: ["T-001", "T-002"],
        requestedThreadIds: ["thread:reader"],
        tasks: [
          {
            taskId: "T-001",
            state: "ACTIVE",
            revision: 2,
            leaseId: "lease-1",
            generation: 3,
            ownerThread: "thread:worker",
            objective: "omit this"
          },
          {
            taskId: "T-002",
            state: "ACTIVE",
            revision: 4,
            leaseId: "lease-2",
            generation: 1,
            ownerThread: "thread:other"
          }
        ],
        threadIds: ["thread:worker", "thread:other", "thread:reader"]
      },
      mode: "poll",
      statuses: []
    },
    warnings: [],
    diagnostics: {}
  };

  assert.deepEqual(projectJsonEnvelope(envelope, "full"), envelope);
  const summary = projectJsonEnvelope(envelope, "summary") as typeof envelope;
  assert.deepEqual(summary.data.selection.tasks, [
    {
      taskId: "T-001",
      state: "ACTIVE",
      revision: 2,
      leaseId: "lease-1",
      generation: 3,
      ownerThread: "thread:worker"
    },
    {
      taskId: "T-002",
      state: "ACTIVE",
      revision: 4,
      leaseId: "lease-2",
      generation: 1,
      ownerThread: "thread:other"
    }
  ]);
});

test("full envelope projection preserves the original payload", () => {
  const envelope = {
    schemaVersion: 1,
    ok: true as const,
    command: "status",
    data: { tasks: [{ evidence: [{ id: "E-1" }] }] },
    warnings: [],
    diagnostics: {}
  };
  assert.deepEqual(projectJsonEnvelope(envelope, "full"), envelope);
  assert.notDeepEqual(projectJsonEnvelope(envelope, "summary"), envelope);
});
