import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEvent } from "../src/app-server.js";
import {
  resolveWaitSelection,
  waitForThreads,
  type ObservedThreadStatus,
  type ThreadStatusAdapter,
  type WaitClient
} from "../src/wait.js";

class FakeAdapter implements ThreadStatusAdapter {
  readonly notification: boolean;
  readonly cursor: boolean;
  readonly reads: Array<{ statuses: ObservedThreadStatus[]; cursor?: string }>;
  listener: ((event: unknown) => void) | undefined;
  failure: ((error: unknown) => void) | undefined;
  onRead?: (adapter: FakeAdapter) => void;
  cursorResult?: { statuses: ObservedThreadStatus[]; cursor: string };
  started = 0;
  closed = 0;
  unsubscribed = 0;

  constructor({
    notification = false,
    cursor = false,
    reads
  }: {
    notification?: boolean;
    cursor?: boolean;
    reads: Array<{ statuses: ObservedThreadStatus[]; cursor?: string }>;
  }) {
    this.notification = notification;
    this.cursor = cursor;
    this.reads = [...reads];
  }

  async start() { this.started += 1; }
  capabilities() { return { notification: this.notification, cursor: this.cursor }; }
  async read() {
    const value = this.reads.shift();
    assert.ok(value);
    this.onRead?.(this);
    return value;
  }
  subscribe(listener: (event: unknown) => void, onFailure: (error: unknown) => void) {
    this.listener = listener;
    this.failure = onFailure;
    return () => { this.unsubscribed += 1; this.listener = undefined; this.failure = undefined; };
  }
  async waitForCursorChange() {
    assert.ok(this.cursorResult);
    return this.cursorResult;
  }
  async close() { this.closed += 1; }
  getWarnings() { return []; }
  getDiagnostics() { return { fake: true, closed: this.closed }; }
}

const active = (threadId: string): ObservedThreadStatus => ({
  threadId,
  status: { type: "active", activeFlags: [] }
});
const idle = (threadId: string): ObservedThreadStatus => ({ threadId, status: { type: "idle" } });

test("task-aware selection resolves exact active lease owners read-only and deduplicates mixed selectors", async () => {
  let reads = 0;
  const canonical = { state: { tasks: {
    "T-API": {
      state: "ACTIVE",
      revision: 2,
      lease: { id: "lease:api", generation: 3, ownerThread: "thread:shared", status: "ACTIVE", expiresAt: "2030-01-01T00:00:00.000Z" }
    },
    "T-UI": {
      state: "ACTIVE",
      revision: 1,
      lease: { id: "lease:ui", generation: 1, ownerThread: "thread:ui", status: "ACTIVE", expiresAt: "2030-01-01T00:00:00.000Z" }
    }
  } } };
  const before = structuredClone(canonical);
  const selection = await resolveWaitSelection({
    directory: "/tmp/project",
    taskIds: ["t-api", "T-API", "t-ui"],
    threadIds: ["thread:shared", "thread:reader", "thread:reader"]
  }, {
    canonicalReader: async directory => {
      reads += 1;
      assert.equal(directory, "/tmp/project");
      return canonical;
    }
  });

  assert.equal(reads, 1);
  assert.deepEqual(canonical, before);
  assert.equal(selection.waitAuthority, "canonical");
  assert.deepEqual(selection.requestedTaskIds, ["T-API", "T-UI"]);
  assert.deepEqual(selection.tasks, [
    { taskId: "T-API", state: "ACTIVE", revision: 2, leaseId: "lease:api", generation: 3, ownerThread: "thread:shared" },
    { taskId: "T-UI", state: "ACTIVE", revision: 1, leaseId: "lease:ui", generation: 1, ownerThread: "thread:ui" }
  ]);
  assert.deepEqual(selection.threadIds, ["thread:shared", "thread:ui", "thread:reader"]);
});

test("task-aware selection rejects missing, unbound, recovery-pending, and inactive tasks", async () => {
  const tasks = {
    RESERVED: {
      state: "READY",
      revision: 0,
      leaseReservation: { id: "lease:reserved", generation: 1 }
    },
    RECOVERY: {
      state: "BLOCKED",
      revision: 0,
      recovery: { status: "PENDING", endedLease: { id: "lease:ended", generation: 2 } }
    },
    EXPIRED: {
      state: "ACTIVE",
      revision: 1,
      lease: {
        id: "lease:expired",
        generation: 1,
        ownerThread: "thread:expired",
        status: "ACTIVE",
        expiresAt: "2000-01-01T00:00:00.000Z"
      }
    },
    IDLE: { state: "READY", revision: 0 }
  };
  const canonicalReader = async () => ({ state: { tasks } });

  for (const [taskId, code] of [
    ["MISSING", "SYNOD_TASK_NOT_FOUND"],
    ["RESERVED", "SYNOD_LEASE_REQUIRED"],
    ["RECOVERY", "SYNOD_LEASE_STALE"],
    ["EXPIRED", "SYNOD_LEASE_STALE"],
    ["IDLE", "SYNOD_LEASE_REQUIRED"]
  ] as const) {
    await assert.rejects(
      resolveWaitSelection({ taskIds: [taskId] }, { canonicalReader }),
      error => error instanceof Error && (error as Error & { code?: string }).code === code
    );
  }
});

test("notification wait registers before its initial read and cannot lose completion", async () => {
  const adapter = new FakeAdapter({ notification: true, reads: [
    { statuses: [active("thread:a")] },
    { statuses: [idle("thread:a")] }
  ] });
  let reads = 0;
  adapter.onRead = current => {
    if (reads++ === 0) queueMicrotask(() => current.listener?.(idle("thread:a")));
  };

  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => adapter });

  assert.equal(report.mode, "notification");
  assert.equal(report.waitAuthority, "appServer");
  assert.equal(report.incomplete, false);
  assert.equal(report.wakeCount, 1);
  assert.equal(report.fallbackPollCount, 0);
  assert.deepEqual(report.statuses, [idle("thread:a")]);
  assert.deepEqual(report.diagnostics, { fake: true, closed: 1 });
  assert.equal(adapter.started, 1);
  assert.equal(adapter.unsubscribed, 1);
  assert.equal(adapter.closed, 1);
});

test("the App Server adapter preserves a notification that races thread/read", async () => {
  let listener: ((event: AppServerEvent) => void) | undefined;
  let closed = 0;
  let reads = 0;
  const client: WaitClient = {
    async start() {},
    async request(method, params) {
      assert.equal(method, "thread/read");
      assert.deepEqual(params, { threadId: "thread:a", includeTurns: false });
      if (reads++ === 0) {
        queueMicrotask(() => listener?.({
          type: "notification",
          method: "thread/status/changed",
          params: idle("thread:a")
        }));
        return { thread: { id: "thread:a", status: active("thread:a").status } };
      }
      return { thread: { id: "thread:a", status: idle("thread:a").status } };
    },
    async close() { closed += 1; },
    subscribeEvents(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    supportsThreadStatusNotifications: () => true,
    getWarnings: () => [],
    getDiagnostics: () => ({ fake: true, closed })
  };

  const report = await waitForThreads({ threadIds: ["thread:a"], cwd: "/tmp/project", timeoutMs: 100 }, {
    clientFactory: options => {
      assert.deepEqual(options, { cwd: "/tmp/project", codexBin: "/tmp/codex" });
      return client;
    },
    runtimeResolver: () => ({ surface: "cli", executable: "/tmp/codex", resolved: true })
  });

  assert.equal(report.mode, "notification");
  assert.equal(report.waitAuthority, "appServer");
  assert.equal(report.incomplete, false);
  assert.equal(report.wakeCount, 1);
  assert.deepEqual(report.statuses, [idle("thread:a")]);
  assert.deepEqual(report.diagnostics, { fake: true, closed: 1 });
});

test("a notification overlapping thread/read cannot overwrite a newer snapshot", async () => {
  const adapter = new FakeAdapter({ notification: true, reads: [
    { statuses: [idle("thread:a")] },
    { statuses: [idle("thread:a")] }
  ] });
  let reads = 0;
  adapter.onRead = current => {
    if (reads++ === 0) current.listener?.(active("thread:a"));
  };

  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, {
    adapterFactory: () => adapter
  });

  assert.equal(report.incomplete, false);
  assert.equal(report.wakeCount, 1);
  assert.deepEqual(report.statuses, [idle("thread:a")]);
  assert.equal(adapter.closed, 1);
});

test("a notification transport failure rejects a blocked wait and cleans up", async () => {
  const adapter = new FakeAdapter({ notification: true, reads: [{ statuses: [active("thread:a")] }] });
  adapter.onRead = current => setImmediate(() => current.failure?.(new Error("transport lost")));

  await assert.rejects(
    waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => adapter }),
    /transport lost/
  );
  assert.equal(adapter.unsubscribed, 1);
  assert.equal(adapter.closed, 1);
});

test("cleanup failure does not replace the original wait failure", async () => {
  const adapter = new FakeAdapter({ notification: true, reads: [{ statuses: [active("thread:a")] }] });
  adapter.subscribe = (listener, onFailure) => {
    adapter.listener = listener;
    adapter.failure = onFailure;
    return () => {
      adapter.unsubscribed += 1;
      throw new Error("unsubscribe failed");
    };
  };
  adapter.onRead = current => setImmediate(() => current.failure?.(new Error("transport lost")));
  adapter.close = async () => { adapter.closed += 1; throw new Error("close failed"); };

  await assert.rejects(
    waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => adapter }),
    error => error instanceof Error
      && error.message === "transport lost"
      && Array.isArray((error as Error & { warnings?: unknown[] }).warnings)
  );
  assert.equal(adapter.unsubscribed, 1);
  assert.equal(adapter.closed, 1);
});

test("notification wait ignores unrelated and malformed status events", async () => {
  const adapter = new FakeAdapter({ notification: true, reads: [
    { statuses: [active("thread:a")] },
    { statuses: [idle("thread:a")] }
  ] });
  let reads = 0;
  adapter.onRead = current => {
    if (reads++ > 0) return;
    current.listener?.(idle("thread:other"));
    current.listener?.({ threadId: "thread:a", status: { type: "active", activeFlags: ["unknown"] } });
    current.listener?.(idle("thread:a"));
  };

  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => adapter });
  assert.equal(report.incomplete, false);
  assert.equal(report.wakeCount, 1);
  assert.deepEqual(report.statuses, [idle("thread:a")]);
});

test("cursor capability reports change-driven wake metrics", async () => {
  const adapter = new FakeAdapter({ cursor: true, reads: [{ statuses: [active("thread:a")], cursor: "cursor:1" }] });
  adapter.cursorResult = { statuses: [idle("thread:a")], cursor: "cursor:2" };

  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => adapter });
  assert.equal(report.mode, "cursor");
  assert.equal(report.wakeCount, 1);
  assert.equal(report.fallbackPollCount, 0);
  assert.equal(report.incomplete, false);
});

test("poll fallback is bounded and observable", async () => {
  const adapter = new FakeAdapter({
    reads: [{ statuses: [active("thread:a")] }, { statuses: [idle("thread:a")] }]
  });
  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100, pollIntervalMs: 1 }, {
    adapterFactory: () => adapter
  });
  assert.equal(report.mode, "poll");
  assert.equal(report.fallbackPollCount, 1);
  assert.equal(report.incomplete, false);
});

test("a successfully read unloaded thread requires attention instead of claiming completion", async () => {
  const adapter = new FakeAdapter({
    notification: true,
    reads: [{ statuses: [{ threadId: "thread:a", status: { type: "notLoaded" } }] }]
  });

  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, {
    adapterFactory: () => adapter
  });

  assert.equal(report.timedOut, false);
  assert.equal(report.incomplete, true);
  assert.equal(report.hostFallbackRequired, true);
  assert.deepEqual(report.hostFallbackThreadIds, ["thread:a"]);
  assert.equal(report.waitAuthority, "appServer");
  assert.equal(report.hostWaitRequired, true);
  assert.deepEqual(report.hostWaitThreadIds, ["thread:a"]);
  assert.equal(report.wakeCount, 0);
  assert.equal(adapter.closed, 1);
});

test("Desktop selects host authority before creating an App Server client", async () => {
  let clientCreated = false;
  const report = await waitForThreads({ threadIds: ["thread:a"], cwd: "/tmp/project", timeoutMs: 100 }, {
    runtimeResolver: () => ({
      surface: "desktop",
      executable: "/Applications/Codex Desktop/codex",
      executableSource: "desktop-process",
      resolved: true
    }),
    clientFactory: options => {
      clientCreated = true;
      return {
        async start() {},
        async request() { return { thread: { id: "thread:a", status: { type: "idle" } } }; },
        async close() {},
        supportsThreadStatusNotifications: () => false
      };
    }
  });

  assert.equal(clientCreated, false);
  assert.equal(report.waitAuthority, "host");
  assert.equal(report.mode, "handoff");
  assert.equal(report.incomplete, true);
  assert.equal(report.hostWaitRequired, true);
  assert.deepEqual(report.hostWaitThreadIds, ["thread:a"]);
  assert.deepEqual(report.hostFallbackThreadIds, ["thread:a"]);
  assert.equal(report.diagnostics.codexSurface, "desktop");
  assert.equal(report.diagnostics.codexExecutableSource, "desktop-process");
});

test("Desktop host handoff does not require an App Server executable", async () => {
  let clientCreated = false;
  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, {
      runtimeResolver: () => ({
        surface: "desktop",
        executable: "codex",
        executableSource: "PATH-fallback",
        resolved: false
      }),
      clientFactory: () => {
        clientCreated = true;
        throw new Error("must not create client");
      }
    });
  assert.equal(clientCreated, false);
  assert.equal(report.waitAuthority, "host");
  assert.equal(report.mode, "handoff");
  assert.equal(report.incomplete, true);
  assert.equal(report.diagnostics.codexExecutableSource, "PATH-fallback");
});

test("the overall deadline bounds an initial status read", async () => {
  let closed = 0;
  const report = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 5 }, {
    adapterFactory: () => ({
      async start() {},
      capabilities: () => ({ notification: false, cursor: false }),
      read: () => new Promise(() => {}),
      async close() { closed += 1; }
    })
  });

  assert.equal(report.timedOut, true);
  assert.equal(report.incomplete, true);
  assert.deepEqual(report.statuses, [{ threadId: "thread:a", status: { type: "notLoaded" } }]);
  assert.equal(closed, 1);
});

test("cleanup itself has an independent bound", async () => {
  const adapter = new FakeAdapter({ reads: [{ statuses: [idle("thread:a")] }] });
  adapter.close = () => new Promise(() => {});

  await assert.rejects(
    waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, {
      adapterFactory: () => adapter,
      cleanupTimeoutMs: 5
    }),
    error => error instanceof Error && error.message.includes("cleanup did not finish")
  );
});

test("an abort during a blocked notification wait stops the wait", async () => {
  const controller = new AbortController();
  const adapter = new FakeAdapter({ notification: true, reads: [{ statuses: [active("thread:a")] }] });
  adapter.onRead = () => setImmediate(() => controller.abort());

  const report = await waitForThreads({
    threadIds: ["thread:a"],
    timeoutMs: 1_000,
    signal: controller.signal
  }, { adapterFactory: () => adapter });

  assert.equal(report.aborted, true);
  assert.equal(report.incomplete, true);
  assert.equal(adapter.unsubscribed, 1);
  assert.equal(adapter.closed, 1);
});

test("timeout, abort, and approval-needed exits clean up the adapter", async () => {
  const timeoutAdapter = new FakeAdapter({ notification: true, reads: [{ statuses: [active("thread:a")] }] });
  const timedOut = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 5 }, { adapterFactory: () => timeoutAdapter });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.incomplete, true);
  assert.equal(timeoutAdapter.closed, 1);
  assert.equal(timeoutAdapter.unsubscribed, 1);

  const controller = new AbortController();
  controller.abort();
  const abortAdapter = new FakeAdapter({ notification: true, reads: [{ statuses: [active("thread:a")] }] });
  const aborted = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100, signal: controller.signal }, {
    adapterFactory: () => abortAdapter
  });
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.incomplete, true);
  assert.equal(abortAdapter.closed, 1);

  const approvalAdapter = new FakeAdapter({ notification: true, reads: [{
    statuses: [{ threadId: "thread:a", status: { type: "active", activeFlags: ["waitingOnApproval"] } }]
  }] });
  const approval = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, { adapterFactory: () => approvalAdapter });
  assert.equal(approval.approvalNeeded, true);
  assert.equal(approval.userInputNeeded, false);
  assert.equal(approval.incomplete, true);
  assert.equal(approval.timedOut, false);

  const inputAdapter = new FakeAdapter({ notification: true, reads: [{
    statuses: [{ threadId: "thread:a", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }]
  }] });
  const input = await waitForThreads({ threadIds: ["thread:a"], timeoutMs: 100 }, {
    adapterFactory: () => inputAdapter
  });
  assert.equal(input.approvalNeeded, false);
  assert.equal(input.userInputNeeded, true);
  assert.equal(input.incomplete, true);
});
