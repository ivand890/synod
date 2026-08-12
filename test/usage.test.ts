import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { WARNING_CODES, warning } from "../src/contracts.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { initProject } from "../src/lifecycle.js";
import { addTask, readOrchestration, transitionTask } from "../src/orchestration.js";
import { collectUsage, formatUsageReport, readRolloutTimeline, readRolloutUsage } from "../src/usage.js";

const temporaryDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-usage-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

function event(type: string, payload: unknown): string {
  return JSON.stringify({ type, payload });
}

function timedEvent(timestamp: string, type: string, payload: unknown): string {
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
      assert.equal(method, "thread/list");
      if (params.parentThreadId || params.archived) return { data: [], nextCursor: null };
      return { data: [root], nextCursor: null };
    }
  };
}

async function canonicalTaskProject(directory: string): Promise<{
  createdAt: string;
  terminalAt: string;
  events: Awaited<ReturnType<typeof readOrchestration>>["events"];
}> {
  const initializedAt = "2026-08-12T12:00:00.000Z";
  const createdAt = "2026-08-12T12:01:00.000Z";
  const terminalAt = "2026-08-12T12:03:00.000Z";
  await initProject({ directory }, { clock: () => initializedAt });
  await addTask({
    directory,
    id: "SYN-TEST",
    objective: "Measure an exact task interval",
    executor: "synod_implementer",
    acceptance: ["The interval is exact."],
    verification: ["pnpm test"]
  }, { clock: () => createdAt });
  await transitionTask({
    directory,
    id: "SYN-TEST",
    to: "SUPERSEDED",
    revision: 0,
    reason: "Fixture terminal boundary"
  }, { clock: () => terminalAt });
  return { createdAt, terminalAt, events: (await readOrchestration(directory)).events };
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("attributes cumulative token deltas to the active model", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "mixed", [
    event("turn_context", { model: "gpt-5.6-sol" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 20, output_tokens: 10,
      reasoning_output_tokens: 4, total_tokens: 110
    } } }),
    event("turn_context", { model: "gpt-5.6-luna" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 150, cached_input_tokens: 30, output_tokens: 15,
      reasoning_output_tokens: 5, total_tokens: 165
    } } })
  ]);

  const usage = await readRolloutUsage(file);

  assert.deepEqual(usage.get("gpt-5.6-sol"), {
    inputTokens: 100, cachedInputTokens: 20, outputTokens: 10,
    reasoningOutputTokens: 4, totalTokens: 110
  });
  assert.deepEqual(usage.get("gpt-5.6-luna"), {
    inputTokens: 50, cachedInputTokens: 10, outputTokens: 5,
    reasoningOutputTokens: 1, totalTokens: 55
  });
});

test("does not let an invalid token record corrupt the next cumulative delta", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "invalid-middle", [
    event("turn_context", { model: "gpt-5.6-sol" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 20, output_tokens: 10,
      reasoning_output_tokens: 4, total_tokens: 110
    } } }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: "invalid", cached_input_tokens: 25, output_tokens: 12,
      reasoning_output_tokens: 5, total_tokens: 125
    } } }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 150, cached_input_tokens: 30, output_tokens: 15,
      reasoning_output_tokens: 5, total_tokens: 165
    } } })
  ]);

  const timeline = await readRolloutTimeline(file);

  assert.equal(timeline.invalidTokenRecords, 1);
  assert.deepEqual(timeline.tokens.map(item => [item.epoch, item.reset, item.usage.totalTokens]), [
    [0, false, 110],
    [0, false, 55]
  ]);
});

test("normalizes rollout role, reroutes, counter epochs, activity, and context without retaining content", async () => {
  const directory = await temporaryDirectory();
  const file = await rollout(directory, "normalized", [
    timedEvent("2026-08-12T12:00:01.000Z", "session_meta", {
      source: { subagent: { thread_spawn: { agent_role: "synod_implementer" } } },
      prompt: "SECRET_PROMPT"
    }),
    timedEvent("2026-08-12T12:00:02.000Z", "turn_context", { model: "gpt-5.6-sol" }),
    timedEvent("2026-08-12T12:00:03.000Z", "event_msg", { type: "task_started" }),
    timedEvent("2026-08-12T12:00:04.000Z", "event_msg", { type: "token_count", info: {
      total_token_usage: {
        input_tokens: 100, cached_input_tokens: 20, output_tokens: 10,
        reasoning_output_tokens: 4, total_tokens: 110
      }
    } }),
    timedEvent("2026-08-12T12:00:05.000Z", "event_msg", {
      type: "model_rerouted", to_model: "gpt-5.6-luna"
    }),
    timedEvent("2026-08-12T12:00:06.000Z", "event_msg", { type: "token_count", info: {
      total_token_usage: {
        input_tokens: 150, cached_input_tokens: 30, output_tokens: 15,
        reasoning_output_tokens: 5, total_tokens: 165
      }
    } }),
    timedEvent("2026-08-12T12:00:07.000Z", "response_item", {
      reasoning: "SECRET_REASONING", tool_arguments: "SECRET_ARGUMENTS", output: "SECRET_OUTPUT"
    }),
    timedEvent("2026-08-12T12:00:08.000Z", "event_msg", { type: "token_count", info: {
      total_token_usage: {
        input_tokens: 5, cached_input_tokens: 1, output_tokens: 106,
        reasoning_output_tokens: 6, total_tokens: 111
      },
      last_token_usage: { input_tokens: 7 },
      model_context_window: 1000
    } }),
    timedEvent("2026-08-12T12:00:09.000Z", "event_msg", { type: "task_complete" }),
    timedEvent("2026-08-12T12:00:10.000Z", "turn_aborted", {}),
    timedEvent("2026-08-12T12:00:11.000Z", "compacted", {}),
    timedEvent("2026-08-12T12:00:12.000Z", "event_msg", { type: "context_compacted" })
  ]);

  const timeline = await readRolloutTimeline(file);

  assert.equal(timeline.source, "subagent");
  assert.equal(timeline.role, "synod_implementer");
  assert.equal(timeline.timestampedRecords, 12);
  assert.equal(Object.hasOwn(timeline, "markers"), false);
  assert.deepEqual(timeline.tokens.map(item => [item.model, item.epoch, item.reset, item.usage.totalTokens]), [
    ["gpt-5.6-sol", 0, false, 110],
    ["gpt-5.6-luna", 0, false, 55],
    ["gpt-5.6-luna", 1, true, 111]
  ]);
  assert.deepEqual(timeline.activity, {
    turnsStarted: 1,
    turnsCompleted: 1,
    turnsAborted: 1,
    compactions: 1
  });
  assert.deepEqual(timeline.currentContext, {
    observedAt: "2026-08-12T12:00:08.000Z",
    inputTokens: 7,
    modelContextWindow: 1000
  });
  assert.doesNotMatch(JSON.stringify(timeline), /SECRET_/);
});

test("collects a complete recursive advisor session and groups by model", async () => {
  const directory = await temporaryDirectory();
  const rootPath = await rollout(directory, "root", [
    event("turn_context", { model: "gpt-5.6-sol" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
      reasoning_output_tokens: 5, total_tokens: 120
    } } })
  ]);
  const childPath = await rollout(directory, "child", [
    event("turn_context", { model: "gpt-5.6-luna" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 200, cached_input_tokens: 100, output_tokens: 40,
      reasoning_output_tokens: 10, total_tokens: 240
    } } })
  ]);
  const grandchildPath = await rollout(directory, "grandchild", [
    event("turn_context", { model: "gpt-5.6-luna" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 50, cached_input_tokens: 25, output_tokens: 10,
      reasoning_output_tokens: 2, total_tokens: 60
    } } })
  ]);

  const root = { id: "root", parentThreadId: null, path: rootPath, cwd: directory, createdAt: 1, updatedAt: 4 };
  const child = { id: "child", parentThreadId: "root", path: childPath, cwd: directory };
  const grandchild = { id: "grandchild", parentThreadId: "child", path: grandchildPath, cwd: directory };
  const fakeClient = {
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/list");
      if (params.parentThreadId === "root") return { data: [child], nextCursor: null };
      if (params.parentThreadId === "child") return { data: [grandchild], nextCursor: null };
      if (params.parentThreadId === "grandchild") return { data: [], nextCursor: null };
      return { data: [root], nextCursor: null };
    }
  };

  const report = await collectUsage({ cwd: directory, clientFactory: () => fakeClient });

  assert.equal(report.session.threadId, "root");
  assert.equal(report.total.threads, 3);
  assert.equal(report.total.totalTokens, 420);
  assert.deepEqual(report.models.map(row => [row.model, row.threads, row.totalTokens]), [
    ["gpt-5.6-luna", 2, 300],
    ["gpt-5.6-sol", 1, 120]
  ]);
  assert.match(formatUsageReport(report), /gpt-5\.6-luna/);
});

test("reports an exact task interval with marginal reset usage and stable rollout-prefix provenance", async () => {
  const directory = await temporaryDirectory();
  const canonical = await canonicalTaskProject(directory);
  const rootPath = await rollout(directory, "root", [
    timedEvent("2026-08-12T12:00:05.000Z", "session_meta", { source: "cli" }),
    timedEvent("2026-08-12T12:00:10.000Z", "turn_context", { model: "gpt-5.6-sol" }),
    timedEvent(canonical.createdAt, "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 80, cached_input_tokens: 40, output_tokens: 20,
      reasoning_output_tokens: 5, total_tokens: 100
    } } }),
    timedEvent("2026-08-12T12:01:30.000Z", "event_msg", { type: "task_started" }),
    timedEvent("2026-08-12T12:02:00.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 120, cached_input_tokens: 50, output_tokens: 30,
      reasoning_output_tokens: 8, total_tokens: 150
    } } }),
    timedEvent(canonical.terminalAt, "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 8, cached_input_tokens: 2, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 10
    } } }),
    timedEvent("2026-08-12T12:04:00.000Z", "event_msg", { type: "task_complete" }),
    timedEvent("2026-08-12T12:04:10.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 16, cached_input_tokens: 4, output_tokens: 4,
      reasoning_output_tokens: 2, total_tokens: 20
    } } })
  ]);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:05:00.000Z"
  };
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  const canonicalBefore = await Promise.all([statePath, eventsPath, statusPath].map(file => readFile(file)));

  const first = await collectUsage({
    cwd: directory,
    taskId: "SYN-TEST",
    clientFactory: () => usageClient(root),
    clock: () => "2026-08-12T12:06:00.000Z"
  });

  assert.equal(first.interval?.start.kind, "task");
  assert.equal(first.interval?.start.event.sequence, canonical.events[1]?.sequence);
  assert.equal(first.interval?.end.kind, "event");
  assert.equal(first.interval?.complete, true);
  assert.equal(first.capturedAt, canonical.terminalAt);
  assert.deepEqual(first.completeness, { status: "complete", reasons: [] });
  assert.equal(first.total.totalTokens, 60);
  assert.deepEqual(first.models.map(row => [row.model, row.totalTokens]), [["gpt-5.6-sol", 60]]);
  assert.deepEqual(first.roles.map(row => [row.role, row.totalTokens]), [["supervisor", 60]]);
  assert.deepEqual(first.attribution.map(row => [row.threadId, row.model, row.role, row.source, row.totalTokens]), [
    ["root", "gpt-5.6-sol", "supervisor", "cli", 60]
  ]);
  assert.deepEqual(first.threads[0]?.activity, {
    turnsStarted: 1,
    turnsCompleted: 0,
    turnsAborted: 0,
    compactions: 0
  });
  assert.match(formatUsageReport(first), /Completeness: complete/);
  assert.match(formatUsageReport(first), /Thread attribution:/);

  const original = await readFile(rootPath, "utf8");
  await writeFile(rootPath, `${original}${timedEvent("2026-08-12T12:07:00.000Z", "turn_context", {
    model: "gpt-5.6-luna"
  })}\n{not-json}\n${event("event_msg", { type: "task_complete" })}\n${timedEvent(
    "2026-08-12T12:08:00.000Z",
    "event_msg",
    { type: "token_count", info: { total_token_usage: { input_tokens: "invalid" } } }
  )}\n${timedEvent("2026-08-12T12:07:30.000Z", "session_meta", {
    source: "vscode", agent_role: "SECRET_AFTER_INTERVAL"
  })}\n`, "utf8");
  root.updatedAt = "2026-08-12T12:08:00.000Z";
  const second = await collectUsage({
    cwd: directory,
    taskId: "SYN-TEST",
    clientFactory: () => usageClient(root),
    clock: () => "2026-08-12T12:08:00.000Z"
  });
  const canonicalAfter = await Promise.all([statePath, eventsPath, statusPath].map(file => readFile(file)));

  assert.deepEqual(second, first);
  assert.deepEqual(canonicalAfter, canonicalBefore);
});

test("resolves exact event and open checkpoint intervals against descendant creation times", async () => {
  const directory = await temporaryDirectory();
  const canonical = await canonicalTaskProject(directory);
  const rootPath = await rollout(directory, "event-root", [
    timedEvent("2026-08-12T12:00:00.000Z", "turn_context", { model: "gpt-5.6-sol" }),
    timedEvent("2026-08-12T12:00:00.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 8, cached_input_tokens: 2, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 10
    } } }),
    timedEvent("2026-08-12T12:00:30.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 16, cached_input_tokens: 4, output_tokens: 4,
      reasoning_output_tokens: 2, total_tokens: 20
    } } }),
    timedEvent(canonical.createdAt, "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 24, cached_input_tokens: 6, output_tokens: 6,
      reasoning_output_tokens: 3, total_tokens: 30
    } } }),
    timedEvent("2026-08-12T12:02:00.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 32, cached_input_tokens: 8, output_tokens: 8,
      reasoning_output_tokens: 4, total_tokens: 40
    } } })
  ]);
  const childPath = await rollout(directory, "event-child", [
    timedEvent("2026-08-12T12:02:05.000Z", "session_meta", {
      source: { subagent: { thread_spawn: { agent_role: "synod_reviewer" } } }
    }),
    timedEvent("2026-08-12T12:02:06.000Z", "turn_context", { model: "gpt-5.6-terra" }),
    timedEvent("2026-08-12T12:02:10.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 40, cached_input_tokens: 10, output_tokens: 10,
      reasoning_output_tokens: 3, total_tokens: 50
    } } })
  ]);
  const root = {
    id: "event-root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:02:20.000Z"
  };
  const child = {
    id: "event-child", parentThreadId: "event-root", path: childPath, cwd: directory,
    createdAt: "2026-08-12T12:02:00.000Z", updatedAt: "2026-08-12T12:02:20.000Z"
  };
  const lateChild = {
    id: "event-late-child", parentThreadId: "event-root", cwd: directory,
    createdAt: "2026-08-12T12:02:40.000Z", updatedAt: "2026-08-12T12:02:40.000Z"
  };
  const clientFactory = () => ({
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/list");
      if (params.archived) return { data: [], nextCursor: null };
      if (params.parentThreadId === "event-root") return { data: [child, lateChild], nextCursor: null };
      if (params.parentThreadId) return { data: [], nextCursor: null };
      return { data: [root], nextCursor: null };
    }
  });

  const exact = await collectUsage({
    cwd: directory,
    sinceEvent: String(canonical.events[0]!.sequence),
    untilEvent: canonical.events[1]!.id,
    clientFactory,
    clock: () => "2026-08-12T12:02:30.000Z"
  });
  const checkpoint = await collectUsage({
    cwd: directory,
    sinceCheckpoint: true,
    clientFactory,
    clock: () => "2026-08-12T12:02:30.000Z"
  });

  assert.equal(exact.interval?.start.kind, "event");
  assert.equal(exact.interval?.end.kind, "event");
  assert.equal(exact.total.threads, 1);
  assert.equal(exact.total.totalTokens, 20);
  assert.deepEqual(exact.completeness, { status: "complete", reasons: [] });
  assert.equal(checkpoint.interval?.start.kind, "checkpoint");
  assert.equal(checkpoint.interval?.end.kind, "capture");
  assert.equal(checkpoint.total.threads, 2);
  assert.equal(checkpoint.total.totalTokens, 80);
  assert.deepEqual(checkpoint.roles.map(row => [row.role, row.totalTokens]), [
    ["synod_reviewer", 50],
    ["supervisor", 30]
  ]);
  assert.deepEqual(checkpoint.completeness, {
    status: "incomplete",
    reasons: ["open-canonical-interval"]
  });
});

test("starts checkpoint usage at the checkpoint capture time rather than its introducing event", async () => {
  const directory = await temporaryDirectory();
  const eventAt = "2026-08-12T12:00:00.000Z";
  const checkpointAt = "2026-08-12T12:00:05.000Z";
  const times = [eventAt, checkpointAt];
  await initProject({ directory }, { clock: () => times.shift() || checkpointAt });
  const canonical = await readOrchestration(directory);
  assert.equal(canonical.events[0]?.timestamp, eventAt);
  assert.equal(canonical.state.checkpoint.capturedAt, checkpointAt);
  const rootPath = await rollout(directory, "checkpoint-boundary", [
    timedEvent("2026-08-12T12:00:01.000Z", "turn_context", { model: "gpt-5.6-sol" }),
    timedEvent("2026-08-12T12:00:03.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 8, cached_input_tokens: 2, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 10
    } } }),
    timedEvent("2026-08-12T12:00:06.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 16, cached_input_tokens: 4, output_tokens: 4,
      reasoning_output_tokens: 2, total_tokens: 20
    } } })
  ]);
  const root = {
    id: "checkpoint-root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:00:07.000Z"
  };

  const report = await collectUsage({
    cwd: directory,
    sinceCheckpoint: true,
    clientFactory: () => usageClient(root),
    clock: () => "2026-08-12T12:01:00.000Z"
  });

  assert.equal(report.interval?.start.kind, "checkpoint");
  assert.equal(report.interval?.start.timestamp, checkpointAt);
  assert.equal(report.total.totalTokens, 10);
});

test("labels historical timestamp gaps incomplete and fails closed for a canonical interval", async () => {
  const directory = await temporaryDirectory();
  await initProject({ directory }, { clock: () => "2026-08-12T12:00:00.000Z" });
  const rootPath = await rollout(directory, "untimed", [
    timedEvent("2026-08-12T12:00:01.000Z", "turn_context", { model: "gpt-5.6-sol" }),
    timedEvent("2026-08-12T12:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 8, cached_input_tokens: 2, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 10
    } } }),
    event("event_msg", { type: "task_complete" })
  ]);
  const root = {
    id: "untimed-root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: "2026-08-12T11:59:00.000Z", updatedAt: "2026-08-12T12:01:00.000Z"
  };

  const snapshot = await collectUsage({ cwd: directory, clientFactory: () => usageClient(root) });

  assert.equal(snapshot.total.totalTokens, 10);
  assert.deepEqual(snapshot.completeness, {
    status: "incomplete",
    reasons: ["missing-record-timestamps", "session-snapshot"]
  });
  await assert.rejects(
    collectUsage({
      cwd: directory,
      sinceCheckpoint: true,
      clientFactory: () => usageClient(root),
      clock: () => "2026-08-12T12:02:00.000Z"
    }),
    (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.ROLLOUT_INVALID
  );
});

test("usage command supports JSON output", async () => {
  const directory = await temporaryDirectory();
  const rootPath = await rollout(directory, "root", [
    event("turn_context", { model: "gpt-5.6-sol" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: {
      input_tokens: 10, cached_input_tokens: 5, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 12
    } } })
  ]);
  const root = { id: "root", parentThreadId: null, path: rootPath, cwd: directory, createdAt: 1, updatedAt: 2 };
  const fakeClient = {
    async start() {},
    async close() {},
    async request() { return { data: [root], nextCursor: null }; }
  };
  const messages: string[] = [];
  const output = { log: (message: unknown) => messages.push(String(message)), warn() {}, error() {} };

  const status = await run(["usage", "--cwd", directory, "--json"], output, {
    clientFactory: () => fakeClient
  });

  assert.equal(status, 0);
  const envelope = JSON.parse(messages[0] ?? "");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "usage");
  assert.equal(envelope.data.models[0].model, "gpt-5.6-sol");
  assert.equal(envelope.data.roles[0].role, "supervisor");
  assert.equal(envelope.data.threads[0].threadId, "root");
  assert.equal(envelope.data.attribution[0].model, "gpt-5.6-sol");
  assert.equal(envelope.data.coordination.total.counts.totalCalls, 0);
  assert.equal(envelope.data.coordination.total.callDuration.status, "unavailable");
  assert.equal(envelope.data.coordination.total.retries.available, false);
  assert.equal(Object.hasOwn(envelope.data.coordination.threads[0], "calls"), false);
  assert.equal(envelope.data.completeness.status, "incomplete");
  assert.deepEqual(envelope.warnings, []);
  assert.equal(typeof envelope.diagnostics.synodVersion, "string");
});

test("usage CLI rejects ambiguous, repeated, and end-only interval selectors before starting Codex", async () => {
  let starts = 0;
  const fakeClient = {
    async start() { starts += 1; },
    async close() {}
  };
  const cases = [
    ["usage", "--since-event", "1", "--task", "SYN-TEST", "--json"],
    ["usage", "--task", "SYN-TEST", "--task", "SYN-OTHER", "--json"],
    ["usage", "--until-event", "2", "--json"]
  ];

  for (const args of cases) {
    const messages: string[] = [];
    const output = { log: (message: unknown) => messages.push(String(message)), warn() {}, error() {} };
    const status = await run(args, output, { clientFactory: () => fakeClient });
    const envelope = JSON.parse(messages[0] ?? "");
    assert.equal(status, 1);
    assert.equal(envelope.error.code, ERROR_CODES.USAGE_INTERVAL_INVALID);
  }
  for (const options of [{ sinceEvent: "" }, { untilEvent: "" }]) {
    await assert.rejects(
      collectUsage({ ...options, clientFactory: () => fakeClient }),
      (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.USAGE_INTERVAL_INVALID
    );
  }
  assert.equal(starts, 0);
});

test("selects the newest root across active and archived sessions", async () => {
  const directory = await temporaryDirectory();
  const activePath = await rollout(directory, "active", []);
  const archivedPath = await rollout(directory, "archived", []);
  const active = {
    id: "active-root", parentThreadId: null, path: activePath, cwd: directory,
    createdAt: 100, updatedAt: 200
  };
  const archived = {
    id: "archived-root", parentThreadId: null, path: archivedPath, cwd: directory,
    createdAt: "1970-01-01T00:02:30.000Z", updatedAt: "1970-01-01T00:05:00.000Z"
  };
  const fakeClient = {
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/list");
      if (params.parentThreadId) return { data: [], nextCursor: null };
      return { data: params.archived ? [archived] : [active], nextCursor: null };
    }
  };

  const report = await collectUsage({ cwd: directory, clientFactory: () => fakeClient });

  assert.equal(report.session.threadId, "archived-root");
});

test("rejects conflicting duplicate root identities across active and archived listings", async () => {
  const directory = await temporaryDirectory();
  const activePath = await rollout(directory, "duplicate-active", []);
  const archivedPath = await rollout(directory, "duplicate-archived", []);
  const fakeClient = {
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/list");
      if (params.parentThreadId) return { data: [], nextCursor: null };
      const pathValue = params.archived ? archivedPath : activePath;
      return {
        data: [{
          id: "duplicate-root", parentThreadId: null, path: pathValue, cwd: directory,
          createdAt: 1, updatedAt: 2
        }],
        nextCursor: null
      };
    }
  };

  await assert.rejects(
    collectUsage({ cwd: directory, clientFactory: () => fakeClient }),
    (error: unknown) => error instanceof SynodError && error.code === ERROR_CODES.ROLLOUT_INVALID
  );
});

test("usage JSON errors use a stable versioned contract", async () => {
  const messages: string[] = [];
  const output = { log: (message: unknown) => messages.push(String(message)), warn() {}, error() {} };
  const fakeClient = {
    async start() {
      throw new SynodError(ERROR_CODES.APP_SERVER_SPAWN_FAILED, "Codex is unavailable.");
    },
    async close() {},
    getDiagnostics() { return { codexVersion: "0.142.0" }; },
    getWarnings() { return []; }
  };

  const status = await run(["usage", "--json"], output, { clientFactory: () => fakeClient });
  const envelope = JSON.parse(messages[0] ?? "");

  assert.equal(status, 1);
  assert.equal(messages.length, 1);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.APP_SERVER_SPAWN_FAILED);
  assert.equal(envelope.diagnostics.codexVersion, "0.142.0");
});

test("usage text output surfaces App Server cleanup warnings", async () => {
  const directory = await temporaryDirectory();
  const rootPath = await rollout(directory, "root", []);
  const root = {
    id: "root", parentThreadId: null, path: rootPath, cwd: directory,
    createdAt: 1, updatedAt: 2
  };
  const fakeClient = {
    async start() {},
    async close() {},
    async request(_method: string, params: Record<string, unknown> = {}) {
      if (params.parentThreadId) return { data: [], nextCursor: null };
      return { data: params.archived ? [] : [root], nextCursor: null };
    },
    getDiagnostics() { return {}; },
    getWarnings() {
      return [warning(
        WARNING_CODES.APP_SERVER_FORCE_KILLED,
        "Codex App Server required SIGKILL."
      )];
    }
  };
  const messages: string[] = [];
  const warnings: string[] = [];
  const output = {
    log: (message: unknown) => messages.push(String(message)),
    warn: (message: unknown) => warnings.push(String(message)),
    error() {}
  };

  const status = await run(["usage", "--cwd", directory], output, {
    clientFactory: () => fakeClient
  });

  assert.equal(status, 0);
  assert.match(messages[0] ?? "", /Session: root/);
  assert.deepEqual(warnings, [
    `Warning [${WARNING_CODES.APP_SERVER_FORCE_KILLED}]: Codex App Server required SIGKILL.`
  ]);
});

test("usage text errors still surface App Server cleanup warnings", async () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const output = {
    log() {},
    warn: (message: unknown) => warnings.push(String(message)),
    error: (message: unknown) => errors.push(String(message))
  };
  const fakeClient = {
    async start() {
      throw new SynodError(ERROR_CODES.APP_SERVER_TIMEOUT, "Initialize timed out.");
    },
    async close() {},
    getDiagnostics() { return {}; },
    getWarnings() {
      return [warning(
        WARNING_CODES.APP_SERVER_EXIT_UNCONFIRMED,
        "Codex App Server exit could not be confirmed."
      )];
    }
  };

  const status = await run(["usage"], output, { clientFactory: () => fakeClient });

  assert.equal(status, 1);
  assert.deepEqual(warnings, [
    `Warning [${WARNING_CODES.APP_SERVER_EXIT_UNCONFIRMED}]: Codex App Server exit could not be confirmed.`
  ]);
  assert.match(errors[0] ?? "", new RegExp(ERROR_CODES.APP_SERVER_TIMEOUT));
});
