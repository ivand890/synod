import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { collectUsage, formatUsageReport, readRolloutUsage } from "../src/usage.js";

const temporaryDirectories = new Set();

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-usage-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

function event(type, payload) {
  return JSON.stringify({ type, payload });
}

async function rollout(directory, name, events) {
  const file = path.join(directory, `${name}.jsonl`);
  await writeFile(file, `${events.join("\n")}\n`, "utf8");
  return file;
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
    async request(method, params) {
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
  const messages = [];
  const output = { log: message => messages.push(message), warn() {}, error() {} };

  const status = await run(["usage", "--cwd", directory, "--json"], output, {
    clientFactory: () => fakeClient
  });

  assert.equal(status, 0);
  assert.equal(JSON.parse(messages[0]).models[0].model, "gpt-5.6-sol");
});
