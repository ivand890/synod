import assert from "node:assert/strict";
import test from "node:test";
import { parseLeaseArgs } from "../src/command-options.js";
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
    runtimeVersion: "0.9.2",
    installedTemplateVersion: "0.9.3",
    manifestSchemaVersion: 3,
    stateTemplateVersion: "0.9.1",
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
  assert.equal(status.runtimeVersion, "0.9.2");
  assert.equal(status.installedTemplateVersion, "0.9.3");
  assert.equal(status.stateTemplateVersion, "0.9.1");
  assert.equal(status.templateVersion, "0.9.1");
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

test("summary status retains bounded selector identity and closeout paths", () => {
  const summary = projectSummary("status", {
    healthy: false,
    tasks: [],
    selection: {
      type: "changed-since-checkpoint",
      rationale: "Closeout path delta",
      bounded: true,
      taskCount: 0,
      totalTaskCount: 4,
      pathCount: 1,
      pathsTruncated: false
    },
    delta: {
      changed: true,
      paths: [{
        path: "src/changed.ts",
        untracked: false,
        binary: false,
        resolved: false,
        checkpoint: { status: " M", path: "src/changed.ts", type: "file" },
        current: { status: " M", path: "src/changed.ts", type: "file" }
      }],
      counts: { staged: 0, unstaged: 1, committed: 0, untracked: 0, resolved: 0, binary: 0 }
    }
  }) as Record<string, unknown>;
  assert.deepEqual(summary.selection, {
    type: "changed-since-checkpoint",
    rationale: "Closeout path delta",
    bounded: true,
    taskCount: 0,
    totalTaskCount: 4,
    pathCount: 1,
    pathsTruncated: false
  });
  assert.deepEqual((summary.delta as Record<string, unknown>).paths, [{
    path: "src/changed.ts",
    untracked: false,
    binary: false,
    resolved: false
  }]);
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
  assert.equal(next.operation, "delegate.complete");
  assert.deepEqual(next.argv, ["delegate", "complete", "T-RESERVE", "--owner-thread"]);
  assert.equal(Object.hasOwn(next.fence as object, "reservationToken"), false);
  assert.deepEqual(next.fence, {
    leaseId: "lease-1",
    generation: 1,
    revision: 0,
    expectedReservedAt: "2026-08-14T00:00:00.000Z",
    baselineHash: "sha256:baseline"
  });
  assert.equal(Object.hasOwn(reservation.reservation as object, "token"), false);

  const correction = projectSummary("lease", {
    action: "reserve",
    task: { id: "T-CORRECTION", state: "REVIEW", revision: 2 },
    reservation: {
      id: "lease-correction",
      token: "token-correction",
      generation: 3,
      taskId: "T-CORRECTION",
      taskRevision: 2,
      role: "implementer",
      observer: false,
      reservedAt: "2026-08-14T00:00:00.000Z",
      baseline: { snapshotContentHash: "sha256:correction-baseline" },
      status: "RESERVED"
    }
  }) as Record<string, unknown>;
  assert.deepEqual((correction.nextOperation as Record<string, unknown>).argv, [
    "delegate", "complete", "T-CORRECTION", "--evidence", "--owner-thread"
  ]);
  assert.deepEqual((correction.nextOperation as Record<string, unknown>).requirements, ["owner-thread", "evidence"]);

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
  assert.equal((active.nextOperation as Record<string, unknown>).operation, "wait.task");
  assert.deepEqual((active.nextOperation as Record<string, unknown>).argv, ["wait", "--task", "T-ACTIVE"]);
  assert.deepEqual((active.nextOperation as Record<string, unknown>).fence, {
    leaseId: "lease-2",
    generation: 2,
    revision: 1,
    expectedHeartbeatAt: "2026-08-14T00:01:00.000Z",
    ownerThread: "thread:worker"
  });
});

test("summary delegate handoff redacts every reservation-token copy", () => {
  const full = {
    action: "start",
    reservation: {
      id: "lease-1",
      token: "secret-token",
      generation: 1,
      taskId: "T-HOST",
      taskRevision: 0,
      status: "RESERVED"
    },
    reservationFence: {
      reservationToken: "secret-token",
      leaseId: "lease-1",
      generation: 1,
      revision: 0,
      expectedReservedAt: "2026-08-27T00:00:00.000Z",
      baselineHash: "sha256:baseline"
    },
    nextCommand: {
      operation: "delegate.complete",
      argv: ["delegate", "complete", "T-HOST", "--owner-thread"],
      requirements: ["owner-thread"],
      fence: {
        reservationToken: "secret-token",
        leaseId: "lease-1",
        generation: 1,
        revision: 0
      }
    }
  };
  const summary = projectSummary("delegate", full) as Record<string, unknown>;

  assert.equal(Object.hasOwn(summary.reservation as object, "token"), false);
  assert.equal(Object.hasOwn(summary.reservationFence as object, "reservationToken"), false);
  assert.equal(Object.hasOwn((summary.nextCommand as Record<string, unknown>).fence as object, "reservationToken"), false);
  assert.equal(full.reservation.token, "secret-token");
  assert.equal(full.reservationFence.reservationToken, "secret-token");
  assert.equal(full.nextCommand.fence.reservationToken, "secret-token");
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
    argv: ["task", "transition", "T-PROPOSAL", "ACCEPTED", "--revision", "3", "--evidence"],
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

test("summary proposal output bounds Git path-lane detail while full output retains it", () => {
  const proposal = {
    path: ".synod/proposals/lease-1/1",
    bundleId: "sha256:proposal",
    leaseId: "lease-1",
    generation: 1,
    baseRevision: 0,
    revision: 1,
    pathStatesVersion: 1,
    status: "SEALED",
    pathStates: [
      { path: "src/tracked.ts", proposalAdded: true, gitTracked: true, staged: false, committed: true },
      { path: "src/new.ts", proposalAdded: true, gitTracked: false, staged: false, committed: false }
    ]
  };
  const full = projectJsonEnvelope({ ok: true, command: "proposal", data: { proposal } }, "full") as {
    data: { proposal: Record<string, unknown> }
  };
  assert.deepEqual(full.data.proposal.pathStates, proposal.pathStates);
  assert.equal(full.data.proposal.pathStatesVersion, 1);
  const summary = projectJsonEnvelope({ ok: true, command: "proposal", data: { proposal } }, "summary") as {
    data: { proposal: Record<string, unknown> }
  };
  assert.deepEqual(summary.data.proposal.pathStateSummary, {
    total: 2,
    proposalAdded: 2,
    gitTracked: 1,
    staged: 0,
    committed: 1,
    exceptions: [{ path: "src/new.ts", proposalAdded: true, gitTracked: false, staged: false, committed: false }]
  });
  assert.equal(summary.data.proposal.pathStatesVersion, 1);
  assert.equal(Object.hasOwn(summary.data.proposal, "pathStates"), false);
});

test("summary task-next preserves guidance gates and exact typed actions", () => {
  const action = {
    operation: "delegate.complete",
    arguments: { taskId: "T-GUIDANCE" },
    argv: ["delegate", "complete", "T-GUIDANCE"],
    requirements: ["owner-thread", "evidence"],
    fence: {
      reservationToken: "reservation-token",
      leaseId: "lease-guidance",
      generation: 2,
      revision: 4,
      expectedReservedAt: "2026-08-14T00:00:00.000Z",
      baselineHash: "sha256:baseline"
    }
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
          proposal: {
            bundleId: "sha256:proposal",
            revision: 4,
            status: "SEALED",
            path: ".synod/proposals/omit",
            pathStatesVersion: 1,
            pathStates: [
              { path: "src/guidance.ts", proposalAdded: true, gitTracked: true, staged: false, committed: true },
              { path: "src/guidance-new.ts", proposalAdded: true, gitTracked: false, staged: false, committed: false }
            ]
          },
          constraints: { reservationRequiresBind: true, recoveryDecisionRequired: true },
          legalTransitions: ["ACTIVE", "BLOCKED"],
          actions: [action],
          evidence: [{ id: "omit-history" }]
        }],
        parallelBatches: [{ taskIds: ["T-GUIDANCE"], actions: [action] }],
        concurrency: { limit: 3, activeWriters: 2, activeReaders: 0, availableSlots: 1 },
        lastEvent: { sequence: 12, id: "event-12", hash: "sha256:event" }
      }
    },
    warnings: [],
    diagnostics: {}
  };

  assert.deepEqual(projectJsonEnvelope(envelope, "full"), envelope);
  assert.equal((envelope.data.guidance.tasks[0]!.reservation as { token: string }).token, "reservation-token");
  assert.equal((action.fence as { reservationToken: string }).reservationToken, "reservation-token");
  assert.deepEqual(envelope.data.guidance.concurrency, { limit: 3, activeWriters: 2, activeReaders: 0, availableSlots: 1 });
  assert.deepEqual(envelope.data.guidance.tasks[0]!.proposal?.pathStates, [
    { path: "src/guidance.ts", proposalAdded: true, gitTracked: true, staged: false, committed: true },
    { path: "src/guidance-new.ts", proposalAdded: true, gitTracked: false, staged: false, committed: false }
  ]);
  const summary = projectJsonEnvelope(envelope, "summary") as typeof envelope;
  const task = summary.data.guidance.tasks[0]!;
  assert.deepEqual(summary.data.guidance.concurrency, { limit: 3, activeWriters: 2, activeReaders: 0, availableSlots: 1 });
  const redactedAction = {
    ...action,
    arguments: { taskId: "T-GUIDANCE" },
    fence: {
      leaseId: "lease-guidance",
      generation: 2,
      revision: 4,
      expectedReservedAt: "2026-08-14T00:00:00.000Z",
      baselineHash: "sha256:baseline"
    }
  };
  assert.deepEqual(summary.data.guidance.parallelBatches, [{ taskIds: ["T-GUIDANCE"], actions: [redactedAction] }]);
  assert.equal(task.id, "T-GUIDANCE");
  assert.deepEqual(task.dependsOn, ["T-BASE"]);
  assert.deepEqual(task.incompleteDependencies, ["T-BASE"]);
  assert.deepEqual(task.correction, { limit: 2, used: 1 });
  assert.deepEqual(task.budget, { policyRevision: 3, thresholdStatus: "ok", decisionRequired: false });
  assert.deepEqual(task.recovery, { status: "PENDING", priorGeneration: 1, priorOwnerThread: "thread:old" });
  assert.deepEqual(task.constraints, { reservationRequiresBind: true, recoveryDecisionRequired: true });
  assert.deepEqual(task.legalTransitions, ["ACTIVE", "BLOCKED"]);
  assert.deepEqual(task.actions, [redactedAction]);
  assert.equal(Object.hasOwn(task.actions[0]!.fence as object, "reservationToken"), false);
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
    generation: 2,
    taskId: "T-GUIDANCE",
    taskRevision: 4,
    reservedAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:05:00.000Z",
    status: "RESERVED",
    baseline: { snapshotContentHash: "sha256:baseline", branch: "omit" }
  });
  assert.equal(Object.hasOwn(task.reservation as object, "token"), false);
  assert.deepEqual(task.proposal, {
    path: ".synod/proposals/omit",
    bundleId: "sha256:proposal",
    revision: 4,
    pathStatesVersion: 1,
    pathStateSummary: {
      total: 2,
      proposalAdded: 2,
      gitTracked: 1,
      staged: 0,
      committed: 1,
      exceptions: [{ path: "src/guidance-new.ts", proposalAdded: true, gitTracked: false, staged: false, committed: false }]
    },
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
      argv: [
        "lease", "expire", "T-EXPIRED-RESERVATION",
        "--reservation-token", "expired-reservation-token",
        "--lease-id", "expired-reservation-lease",
        "--generation", "3",
        "--revision", "2",
        "--expected-reserved-at", "2026-08-14T00:00:00.000Z",
        "--baseline-hash", "sha256:expired-baseline",
        "--reason"
      ],
      fence: { reservationToken: "expired-reservation-token", leaseId: "expired-reservation-lease" },
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
  const redactedExpire = {
    ...fencedActions[0],
    arguments: {
      taskId: "T-EXPIRED-RESERVATION",
      leaseId: "expired-reservation-lease",
      generation: 3,
      revision: 2,
      expectedReservedAt: "2026-08-14T00:00:00.000Z",
      baselineHash: "sha256:expired-baseline",
      reason: null
    },
    argv: [
      "lease", "expire", "T-EXPIRED-RESERVATION",
      "--reservation-token",
      "--lease-id", "expired-reservation-lease",
      "--generation", "3",
      "--revision", "2",
      "--expected-reserved-at", "2026-08-14T00:00:00.000Z",
      "--baseline-hash", "sha256:expired-baseline",
      "--reason"
    ],
    fence: { leaseId: "expired-reservation-lease" },
    requirements: ["reservation-token", "reason"]
  };
  assert.deepEqual(fencedTasks.map(task => task.actions), [
    [redactedExpire],
    [fencedActions[1]],
    [fencedActions[2]]
  ]);
  assert.equal(JSON.stringify(fencedSummary).includes("expired-reservation-token"), false);
  const filledExpireArgv = (redactedExpire.argv as string[]).flatMap(item => {
    if (item === "--reservation-token") return [item, "supervisor-supplied-token"];
    if (item === "--reason") return [item, "reservation expired"];
    return [item];
  });
  const parsedExpire = parseLeaseArgs(filledExpireArgv.slice(1));
  assert.equal("help" in parsedExpire, false);
  if (!("help" in parsedExpire)) {
    assert.equal(parsedExpire.action, "expire");
    assert.equal("reservationToken" in parsedExpire ? parsedExpire.reservationToken : undefined, "supervisor-supplied-token");
    assert.equal(parsedExpire.reason, "reservation expired");
  }
});

test("summary wait selection retains task selector identity", () => {
  const envelope = {
    ok: true as const,
    command: "wait",
    data: {
      selection: {
        waitAuthority: "canonical",
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
      waitAuthority: "appServer",
      mode: "poll",
      hostWaitRequired: false,
      hostWaitThreadIds: [],
      hostFallbackRequired: false,
      hostFallbackThreadIds: [],
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
  assert.equal(summary.data.selection.waitAuthority, "canonical");
  assert.equal(summary.data.waitAuthority, "appServer");
  assert.equal(summary.data.mode, "poll");
  assert.equal(summary.data.hostWaitRequired, false);
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
