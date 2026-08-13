import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coordinationReport } from "../src/coordination.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { addTask, transitionTask } from "../src/orchestration.js";
import { initProject } from "../src/lifecycle.js";
import { collectUsage, readRolloutTimeline } from "../src/usage.js";

const temporaryDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-coordination-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

function item(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}

function call(
  timestamp: string,
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): string {
  return item(timestamp, {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    ...extra
  });
}

function customCall(timestamp: string, callId: string, name: string, input: unknown): string {
  return item(timestamp, { type: "custom_tool_call", call_id: callId, name, input });
}

function output(timestamp: string, callId: string, value: unknown, custom = false): string {
  return item(timestamp, {
    type: custom ? "custom_tool_call_output" : "function_call_output",
    call_id: callId,
    output: value
  });
}

function event(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload });
}

async function rollout(directory: string, name: string, events: string[]): Promise<string> {
  const file = path.join(directory, `${name}.jsonl`);
  await writeFile(file, `${events.join("\n")}\n`, "utf8");
  return file;
}

function usageClient(root: Record<string, unknown>) {
  return {
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      if (method === "thread/read") return { thread: root };
      assert.equal(method, "thread/list");
      if (params.parentThreadId || params.archived) return { data: [], nextCursor: null };
      return { data: [root], nextCursor: null };
    }
  };
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("classifies coordination, durations, failures, retries, and paired compactions without retaining content", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "coordination", [
    call("2026-08-12T12:00:01.000Z", "s1", "spawn_agent", { message: "SECRET_SPAWN" }),
    output("2026-08-12T12:00:03.000Z", "s1", JSON.stringify({ ok: true, secret: "SECRET_OUTPUT" })),
    call("2026-08-12T12:00:04.000Z", "f1", "followup_task", { message: "SECRET_FOLLOWUP" }),
    output("2026-08-12T12:00:05.000Z", "f1", JSON.stringify({ status: "completed" })),
    call("2026-08-12T12:00:06.000Z", "m1", "send_message", { message: "SECRET_MESSAGE" }),
    output("2026-08-12T12:00:07.000Z", "m1", JSON.stringify({ isError: true, error: "SECRET_ERROR" })),
    call("2026-08-12T12:00:08.000Z", "w1", "wait_agent", { timeout_ms: 30_000 }),
    output("2026-08-12T12:00:13.000Z", "w1", JSON.stringify({ status: "completed" })),
    call("2026-08-12T12:00:14.000Z", "l1", "list_agents"),
    output("2026-08-12T12:00:15.000Z", "l1", JSON.stringify({ ok: true })),
    call("2026-08-12T12:00:16.000Z", "i1", "interrupt_agent"),
    output("2026-08-12T12:00:17.000Z", "i1", JSON.stringify({ success: true })),
    customCall("2026-08-12T12:00:18.000Z", "x1", "exec", "SECRET_COMMAND"),
    output("2026-08-12T12:00:20.000Z", "x1", { exit_code: 0, output: "SECRET_EXEC" }, true),
    event("2026-08-12T12:00:21.000Z", "compacted", {}),
    event("2026-08-12T12:00:21.100Z", "event_msg", { type: "context_compacted" }),
    call("2026-08-12T12:00:22.000Z", "r1", "exec"),
    output("2026-08-12T12:00:23.000Z", "r1", JSON.stringify({ exit_code: 1 })),
    call("2026-08-12T12:00:24.000Z", "r2", "exec", {}, { retry_of: "r1" }),
    output("2026-08-12T12:00:25.000Z", "r2", JSON.stringify({ exit_code: 0 })),
    call("2026-08-12T12:00:26.000Z", "o1", "exec", { command: "SECRET_OPEN" })
  ]);

  const timeline = await readRolloutTimeline(file);
  const report = coordinationReport([{
    threadId: "root",
    parentThreadId: null,
    role: "supervisor",
    source: "cli",
    calls: timeline.toolCalls,
    compactions: timeline.activity.compactions
  }]);

  assert.deepEqual(report.total.counts, {
    totalCalls: 10,
    coordinationCalls: 6,
    implementationCalls: 4,
    spawn: 1,
    followUp: 1,
    message: 1,
    followUpOrMessage: 2,
    wait: 1,
    listAgents: 1,
    interruptAgent: 1,
    supervision: 2,
    compactions: 1
  });
  assert.deepEqual(report.total.callDuration, {
    status: "partial", observed: 9, missing: 1, totalMs: 15_000
  });
  assert.deepEqual(report.total.waitDuration, {
    status: "available", observed: 1, missing: 0, totalMs: 5_000
  });
  assert.deepEqual(report.total.requestedWaitDuration, {
    status: "available", observed: 1, missing: 0, totalMs: 30_000
  });
  assert.deepEqual(report.total.outcomes, {
    status: "partial", observed: 9, missing: 1,
    succeeded: 7, noChange: 0, timedOut: 0, failed: 2, unknown: 0
  });
  assert.deepEqual(report.total.retries, { available: true, count: 1 });
  assert.deepEqual(report.roles.map(row => [row.role, row.threads, row.metrics.counts.totalCalls]), [
    ["supervisor", 1, 10]
  ]);
  assert.deepEqual(report.completeness, {
    status: "incomplete", reasons: ["tool-call-output-missing"]
  });
  assert.equal(report.total.tools.find(row => row.name === "exec")?.calls, 4);
  assert.doesNotMatch(JSON.stringify({ timeline, report }), /SECRET_/);
});

test("classifies a normal wait expiry as no-change and a plain validation error as failed", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "wait-outcomes", [
    call("2026-08-12T12:00:00.000Z", "normal", "wait_agent", { timeout_ms: 10_000 }),
    output("2026-08-12T12:00:10.000Z", "normal", JSON.stringify({ message: "Wait timed out.", timed_out: true })),
    call("2026-08-12T12:00:11.000Z", "invalid", "wait_agent", { timeout_ms: 1 }),
    output("2026-08-12T12:00:12.000Z", "invalid", "timeout_ms must be at least 10000")
  ]);

  const timeline = await readRolloutTimeline(file);
  const report = coordinationReport([{
    threadId: "root",
    parentThreadId: null,
    role: "supervisor",
    source: "cli",
    calls: timeline.toolCalls,
    compactions: 0
  }]);

  assert.deepEqual(report.total.outcomes, {
    status: "available",
    observed: 2,
    missing: 0,
    succeeded: 0,
    noChange: 1,
    timedOut: 0,
    failed: 1,
    unknown: 0
  });
  assert.doesNotMatch(JSON.stringify({ timeline, report }), /Wait timed out|timeout_ms must/);
});

test("recognizes content-free success shapes and keeps ambiguous legacy acknowledgements unknown", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "coordination-success-shapes", [
    call("2026-08-12T12:00:00.000Z", "spawn", "spawn_agent"),
    output("2026-08-12T12:00:01.000Z", "spawn", JSON.stringify({ task_name: "child" })),
    call("2026-08-12T12:00:02.000Z", "follow", "followup_task"),
    output("2026-08-12T12:00:03.000Z", "follow", JSON.stringify({ queued: true })),
    call("2026-08-12T12:00:04.000Z", "message", "send_message"),
    output("2026-08-12T12:00:05.000Z", "message", JSON.stringify({ delivered: true })),
    call("2026-08-12T12:00:06.000Z", "wait", "wait_agent", { timeout_ms: 10_000 }),
    output("2026-08-12T12:00:07.000Z", "wait", JSON.stringify({ message: "done", timed_out: false })),
    call("2026-08-12T12:00:08.000Z", "list", "list_agents"),
    output("2026-08-12T12:00:09.000Z", "list", JSON.stringify({ agents: [] })),
    call("2026-08-12T12:00:10.000Z", "interrupt", "interrupt_agent"),
    output("2026-08-12T12:00:11.000Z", "interrupt", JSON.stringify({ previous_status: "running" })),
    call("2026-08-12T12:00:12.000Z", "legacy-message", "send_message"),
    output("2026-08-12T12:00:13.000Z", "legacy-message", "legacy acknowledgement without a machine-readable result"),
    call("2026-08-12T12:00:14.000Z", "empty", "spawn_agent"),
    output("2026-08-12T12:00:15.000Z", "empty", JSON.stringify({}))
  ]);

  const timeline = await readRolloutTimeline(file);
  const report = coordinationReport([{
    threadId: "root",
    parentThreadId: null,
    role: "supervisor",
    source: "cli",
    calls: timeline.toolCalls,
    compactions: 0
  }]);

  assert.deepEqual(report.total.outcomes, {
    status: "available",
    observed: 8,
    missing: 0,
    succeeded: 6,
    noChange: 0,
    timedOut: 0,
    failed: 0,
    unknown: 2
  });
  assert.doesNotMatch(JSON.stringify({ timeline, report }), /child|legacy acknowledgement|running/);
});

test("clips coordination calls and durations to the canonical task interval", async () => {
  const directory = await temporaryDirectory();
  await initProject({ directory }, { clock: () => "2026-08-12T12:00:00.000Z" });
  await addTask({
    directory,
    id: "SYN-COORD",
    objective: "Measure coordination",
    executor: "synod_implementer",
    acceptance: ["Coordination is attributable."],
    verification: ["pnpm test"]
  }, { clock: () => "2026-08-12T12:01:00.000Z" });
  await transitionTask({
    directory,
    id: "SYN-COORD",
    to: "SUPERSEDED",
    revision: 0,
    reason: "Close fixture"
  }, { clock: () => "2026-08-12T12:03:00.000Z" });
  const rootPath = await rollout(directory, "interval", [
    call("2026-08-12T12:00:30.000Z", "before", "exec"),
    output("2026-08-12T12:00:31.000Z", "before", JSON.stringify({ ok: true })),
    call("2026-08-12T12:02:00.000Z", "spawn", "spawn_agent"),
    output("2026-08-12T12:02:02.000Z", "spawn", JSON.stringify({ ok: true })),
    call("2026-08-12T12:02:10.000Z", "wait", "wait_agent", { timeout_ms: 120_000 }),
    output("2026-08-12T12:04:00.000Z", "wait", JSON.stringify({ ok: true })),
    call("2026-08-12T12:04:10.000Z", "after", "send_message"),
    output("2026-08-12T12:04:11.000Z", "after", JSON.stringify({ ok: true }))
  ]);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:05:00.000Z"
  };

  const report = await collectUsage({
    cwd: directory,
    threadId: "root",
    taskId: "SYN-COORD",
    clientFactory: () => usageClient(root),
    clock: () => "2026-08-12T12:05:00.000Z"
  });

  assert.equal(report.coordination.total.counts.totalCalls, 1);
  assert.equal(report.coordination.total.counts.spawn, 1);
  assert.equal(report.coordination.total.counts.wait, 0);
  assert.deepEqual(report.coordination.total.callDuration, {
    status: "available", observed: 1, missing: 0, totalMs: 2_000
  });
  assert.deepEqual(report.coordination.total.waitDuration, {
    status: "unavailable", observed: 0, missing: 0
  });
  assert.deepEqual(report.coordination.total.requestedWaitDuration, {
    status: "unavailable", observed: 0, missing: 0
  });
  assert.deepEqual(report.coordination.total.retries, { available: false });
  assert.deepEqual(report.coordination.threads.map(row => [row.threadId, row.role, row.metrics.counts.totalCalls]), [
    ["root", "supervisor", 1]
  ]);
  assert.deepEqual(report.coordination.completeness, {
    status: "complete", reasons: []
  });
  assert.deepEqual(report.completeness, {
    status: "complete", reasons: []
  });
  assert.equal(report.coordination.boundary.crossingCalls.total, 1);
  assert.ok(report.threads[0]?.boundaryEvidence);

  const original = await readFile(rootPath, "utf8");
  const crossingOutput = output("2026-08-12T12:04:00.000Z", "wait", JSON.stringify({ ok: true }));
  const malformedBoundaryPrefix = original.replace(crossingOutput, `{not-json}\n${crossingOutput}`);
  assert.notEqual(malformedBoundaryPrefix, original);
  await writeFile(rootPath, malformedBoundaryPrefix, "utf8");
  await assert.rejects(
    collectUsage({
      cwd: directory,
      threadId: "root",
      taskId: "SYN-COORD",
      clientFactory: () => usageClient(root),
      clock: () => "2026-08-12T12:05:30.000Z"
    }),
    (error: unknown) => error instanceof SynodError
      && error.code === ERROR_CODES.ROLLOUT_INVALID
      && (error.details as { malformedRecords?: number } | undefined)?.malformedRecords === 1
  );
  await writeFile(rootPath, `${original}${call("2026-08-12T12:04:20.000Z", "late-duplicate", "exec")}\n${call(
    "2026-08-12T12:04:21.000Z",
    "late-duplicate",
    "exec"
  )}\n${output(
    "2026-08-12T12:04:22.000Z",
    "late-orphan",
    JSON.stringify({ ok: true })
  )}\n`, "utf8");

  const repeated = await collectUsage({
    cwd: directory,
    threadId: "root",
    taskId: "SYN-COORD",
    clientFactory: () => usageClient(root),
    clock: () => "2026-08-12T12:06:00.000Z"
  });
  assert.deepEqual(repeated, report);
});

test("rejects duplicate and negative tool-call pairs in an exact interval", async () => {
  const directory = await temporaryDirectory();
  await initProject({ directory }, { clock: () => "2026-08-12T12:00:00.000Z" });
  const rootPath = await rollout(directory, "invalid-pairs", [
    call("2026-08-12T12:01:00.000Z", "duplicate", "exec"),
    call("2026-08-12T12:01:01.000Z", "duplicate", "exec"),
    output("2026-08-12T12:01:02.000Z", "duplicate", JSON.stringify({ ok: true })),
    output("2026-08-12T12:01:03.000Z", "duplicate", JSON.stringify({ ok: true })),
    output("2026-08-12T12:01:04.000Z", "negative", JSON.stringify({ ok: true })),
    call("2026-08-12T12:01:05.000Z", "negative", "exec")
  ]);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:02:00.000Z"
  };

  await assert.rejects(
    collectUsage({
      cwd: directory,
      sinceCheckpoint: true,
      clientFactory: () => usageClient(root),
      clock: () => "2026-08-12T12:02:00.000Z"
    }),
    (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.ROLLOUT_INVALID
      && (error.details as { duplicateStarts?: number } | undefined)?.duplicateStarts === 1
  );
  await assert.rejects(
    collectUsage({ cwd: directory, clientFactory: () => usageClient(root) }),
    (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.ROLLOUT_INVALID
      && (error.details as { duplicateOutputs?: number; negativeDurations?: number } | undefined)?.duplicateOutputs === 1
      && (error.details as { negativeDurations?: number } | undefined)?.negativeDurations === 1
  );
});

test("rejects a tool output paired to a start in another thread", async () => {
  const directory = await temporaryDirectory();
  const rootPath = await rollout(directory, "root", [
    call("2026-08-12T12:01:00.000Z", "cross-thread", "spawn_agent")
  ]);
  const childPath = await rollout(directory, "child", [
    output("2026-08-12T12:01:01.000Z", "cross-thread", JSON.stringify({ ok: true }))
  ]);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:02:00.000Z"
  };
  const child = {
    id: "child", parentThreadId: "root", path: childPath, cwd: directory,
    createdAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:02:00.000Z"
  };
  const client = {
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/list");
      if (params.parentThreadId === "root") return { data: [child], nextCursor: null };
      if (params.parentThreadId || params.archived) return { data: [], nextCursor: null };
      return { data: [root], nextCursor: null };
    }
  };

  await assert.rejects(
    collectUsage({ cwd: directory, clientFactory: () => client }),
    (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.ROLLOUT_INVALID
      && (error.details as { unpairedOutputs?: number } | undefined)?.unpairedOutputs === 1
  );
});

test("rejects outputs without a matching call start in snapshots and exact prefixes", async () => {
  const directory = await temporaryDirectory();
  await initProject({ directory }, { clock: () => "2026-08-12T12:00:00.000Z" });
  const rootPath = await rollout(directory, "orphan-output", [
    output("2026-08-12T12:01:00.000Z", "missing-start", JSON.stringify({ ok: true }))
  ]);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:02:00.000Z"
  };
  const isUnpairedError = (error: unknown) => error instanceof SynodError
    && error.code === ERROR_CODES.ROLLOUT_INVALID
    && (error.details as { unpairedOutputs?: number } | undefined)?.unpairedOutputs === 1;

  await assert.rejects(
    collectUsage({ cwd: directory, clientFactory: () => usageClient(root) }),
    isUnpairedError
  );
  await assert.rejects(
    collectUsage({
      cwd: directory,
      sinceCheckpoint: true,
      clientFactory: () => usageClient(root),
      clock: () => "2026-08-12T12:02:00.000Z"
    }),
    isUnpairedError
  );
});
