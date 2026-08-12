import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { run } from "../src/cli.js";
import { formatHandoff, generateHandoff } from "../src/handoff.js";
import { initProject } from "../src/lifecycle.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  addTask,
  prepareProjectRotation,
  readOrchestration,
  reportProjectRotation,
  setRotationPolicy,
  transitionTask,
  verifyProjectRotation
} from "../src/orchestration.js";
import { currentRotationPhase } from "../src/rotation.js";
import type { OrchestrationEvent } from "../src/orchestration.js";
import type { CoordinationMetrics } from "../src/coordination.js";
import { resolveUsageRootSession } from "../src/usage.js";
import type { UsageReport } from "../src/usage.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-rotation-test-"));
  temporaryDirectories.add(directory);
  await execFileAsync("git", ["-C", directory, "init", "--quiet"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Synod Tests"]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "synod-tests@example.invalid"]);
  await execFileAsync("git", ["-C", directory, "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  await initProject({ directory }, { clock: () => "2026-08-12T10:00:00.000Z" });
  return directory;
}

function metrics({ compactions = 0, waits = 0, waitMs }: { compactions?: number; waits?: number; waitMs?: number } = {}): CoordinationMetrics {
  return {
    counts: {
      totalCalls: waits,
      coordinationCalls: waits,
      implementationCalls: 0,
      spawn: 0,
      followUp: 0,
      message: 0,
      followUpOrMessage: 0,
      wait: waits,
      listAgents: 0,
      interruptAgent: 0,
      supervision: 0,
      compactions
    },
    tools: waits > 0 ? [{ name: "wait_agent", category: "wait", calls: waits }] : [],
    callDuration: waitMs === undefined
      ? { status: "unavailable", observed: 0, missing: waits }
      : { status: "available", observed: waits, missing: 0, totalMs: waitMs },
    waitDuration: waitMs === undefined
      ? { status: "unavailable", observed: 0, missing: waits }
      : { status: "available", observed: waits, missing: 0, totalMs: waitMs },
    requestedWaitDuration: { status: "unavailable", observed: 0, missing: waits },
    outcomes: { status: "unavailable", observed: 0, missing: waits },
    retries: { available: false }
  };
}

function usageReport(
  start: OrchestrationEvent,
  session: string,
  capturedAt: string,
  options: { contextInput?: number; contextWindow?: number; compactions?: number; waits?: number; waitMs?: number } = {}
): UsageReport {
  const coordination = metrics(options);
  return {
    session: { threadId: session, cwd: "/fixture" },
    capturedAt,
    models: [{
      model: "gpt-5.6-sol",
      threads: 1,
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      totalTokens: 60
    }],
    roles: [],
    attribution: [],
    threads: [{
      threadId: session,
      parentThreadId: null,
      role: "supervisor",
      source: "vscode",
      models: 1,
      rollout: { bytes: 512, sha256: `sha256:${"a".repeat(64)}`, lastObservedAt: capturedAt },
      activity: { turnsStarted: 2, turnsCompleted: 2, turnsAborted: 0, compactions: options.compactions || 0 },
      ...(options.contextInput !== undefined && options.contextWindow !== undefined ? {
        currentContext: { observedAt: capturedAt, inputTokens: options.contextInput, modelContextWindow: options.contextWindow }
      } : {}),
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      totalTokens: 60
    }],
    total: {
      threads: 1,
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      totalTokens: 60
    },
    tokenCounters: { resets: 0 },
    completeness: { status: "incomplete", reasons: ["open-canonical-interval"] },
    coordination: {
      total: coordination,
      roles: [],
      threads: [],
      completeness: { status: "incomplete", reasons: ["active-session-tree"] }
    },
    interval: {
      inclusion: "(start,end]",
      start: {
        kind: "event",
        timestamp: start.timestamp,
        event: { sequence: start.sequence, id: start.id, hash: start.eventHash, type: start.type }
      },
      end: { kind: "capture", timestamp: capturedAt },
      complete: false
    },
    warnings: [],
    diagnostics: {}
  };
}

function collector(directory: string, now: () => string, options: Parameters<typeof usageReport>[3] = {}) {
  const implementation: typeof import("../src/usage.js").collectUsage = async ({ threadId, sinceEvent } = {}) => {
    const canonical = await readOrchestration(directory);
    const start = canonical.events.find(event => event.id === sinceEvent);
    assert.ok(start);
    return usageReport(start, String(threadId), now(), options);
  };
  return implementation;
}

test("unconfigured projects expose no recommendation and handoff stays read-only", async () => {
  const directory = await project();
  const paths = [ORCHESTRATION_STATE_PATH, ORCHESTRATION_EVENTS_PATH, ORCHESTRATION_STATUS_PATH].map(item => path.join(directory, item));
  const before = await Promise.all(paths.map(item => readFile(item)));

  const handoff = await generateHandoff({ directory });

  assert.equal(handoff.rotation, null);
  assert.match(formatHandoff(handoff), /Phase rotation: not configured/);
  assert.deepEqual(await Promise.all(paths.map(item => readFile(item))), before);
});

test("reports every configured metric deterministically and missing context cannot trigger", async () => {
  const directory = await project();
  const start = (await readOrchestration(directory)).events[0]!;
  await setRotationPolicy({
    directory,
    rootSessionId: "root-old",
    startEvent: start.id,
    thresholds: { supervisorContextPercent: 80, compactions: 2, waitCalls: 3, waitDurationMs: 1_000, completedTasks: 1 },
    reason: "Bound the supervision phase",
    evidence: ["roadmap:SYN-093A"]
  }, { clock: () => "2026-08-12T10:01:00.000Z" });
  const now = () => "2026-08-12T10:02:00.000Z";
  const report = await reportProjectRotation({ directory }, {
    clock: now,
    usageCollector: collector(directory, now, { compactions: 2, waits: 3, waitMs: 1_500 })
  });
  const repeated = await reportProjectRotation({ directory }, {
    clock: now,
    usageCollector: collector(directory, now, { compactions: 2, waits: 3, waitMs: 1_500 })
  });

  assert.equal(report.reportHash, repeated.reportHash);
  assert.equal(report.metrics.length, 5);
  assert.equal(report.metrics.find(item => item.name === "supervisor-context-percent")?.status, "unavailable");
  assert.equal(report.metrics.find(item => item.name === "supervisor-context-percent")?.triggered, false);
  assert.deepEqual(report.reasons, ["compactions", "wait-calls", "wait-duration-ms"]);
  assert.equal(report.recommended, true);

  const nearThreshold = await reportProjectRotation({ directory }, {
    clock: now,
    usageCollector: collector(directory, now, { contextInput: 79_999, contextWindow: 100_000 })
  });
  const contextMetric = nearThreshold.metrics.find(item => item.name === "supervisor-context-percent");
  assert.equal(contextMetric?.current, 79.999);
  assert.equal(contextMetric?.triggered, false);
});

test("superseded tasks do not satisfy the completed-task threshold", async () => {
  const directory = await project();
  const start = (await readOrchestration(directory)).events[0]!;
  await setRotationPolicy({
    directory,
    rootSessionId: "root-old",
    startEvent: start.id,
    thresholds: { completedTasks: 1 },
    reason: "Rotate after completed work",
    evidence: ["roadmap:SYN-093A"]
  });
  await addTask({
    directory,
    id: "SYN-ABANDONED",
    objective: "Do not count abandonment as completion",
    executor: "synod_implementer",
    acceptance: ["Only DONE counts."],
    verification: ["pnpm test"]
  });
  await transitionTask({
    directory,
    id: "SYN-ABANDONED",
    to: "SUPERSEDED",
    revision: 0,
    reason: "Fixture abandonment"
  });
  const now = () => "2026-08-12T10:05:00.000Z";

  const report = await reportProjectRotation({ directory }, { clock: now, usageCollector: collector(directory, now) });

  assert.deepEqual(report.completedTaskIds, []);
  assert.equal(report.metrics.find(item => item.name === "completed-tasks")?.current, 0);
  assert.equal(report.recommended, false);
});

test("prepare and verify bind a new root while preserving tasks, Git, and exact phase boundaries", async () => {
  const directory = await project();
  await addTask({
    directory,
    id: "SYN-ROTATE",
    objective: "Remain unchanged across rotation",
    executor: "synod_implementer",
    acceptance: ["Task state is preserved."],
    verification: ["pnpm test"]
  }, { clock: () => "2026-08-12T10:01:00.000Z" });
  const start = (await readOrchestration(directory)).events[0]!;
  await setRotationPolicy({
    directory,
    rootSessionId: "root-old",
    startEvent: start.id,
    thresholds: { supervisorContextPercent: 75, compactions: 2 },
    reason: "Bound the supervision phase",
    evidence: ["roadmap:SYN-093A"]
  }, { clock: () => "2026-08-12T10:02:00.000Z" });
  let now = "2026-08-12T10:03:00.000Z";
  const usageCollector = collector(directory, () => now, { contextInput: 80, contextWindow: 100, compactions: 2 });
  const before = await readOrchestration(directory);
  const head = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

  const prepared = await prepareProjectRotation({ directory }, { clock: () => now, usageCollector });

  assert.deepEqual(prepared.recommendation.reasons, ["supervisor-context-percent", "compactions"]);
  assert.deepEqual(prepared.state.tasks, before.state.tasks);
  await assert.rejects(
    verifyProjectRotation({ directory, recommendation: prepared.recommendation.event.id, rootSessionId: "root-old" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_STALE
  );
  await assert.rejects(
    verifyProjectRotation({ directory, recommendation: prepared.recommendation.event.id, rootSessionId: "root-preexisting" }, {
      usageSessionResolver: async (options = {}) => ({
        threadId: String(options.threadId),
        cwd: path.resolve(String(options.cwd)),
        createdAt: "2026-08-12T10:02:59.000Z",
        warnings: [],
        diagnostics: {}
      })
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_SESSION_INVALID
  );

  now = "2026-08-12T10:04:00.000Z";
  const verified = await verifyProjectRotation({
    directory,
    recommendation: prepared.recommendation.event.id,
    rootSessionId: "root-new"
  }, {
    clock: () => now,
    usageSessionResolver: async (options = {}) => ({ threadId: String(options.threadId), cwd: path.resolve(String(options.cwd)), createdAt: now, warnings: [], diagnostics: {} })
  });
  const phase = currentRotationPhase(verified.rotation);
  assert.equal(phase.rootSessionId, "root-new");
  assert.equal(phase.startEvent.sequence, verified.verification.event.sequence);
  assert.deepEqual(verified.state.tasks, before.state.tasks);
  assert.equal((await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim(), head);
  await assert.rejects(
    verifyProjectRotation({ directory, recommendation: prepared.recommendation.event.id, rootSessionId: "another-root" }, {
      usageSessionResolver: async (options = {}) => ({ threadId: String(options.threadId), cwd: path.resolve(String(options.cwd)), createdAt: now, warnings: [], diagnostics: {} })
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_STALE
  );

  now = "2026-08-12T10:05:00.000Z";
  const handoff = await generateHandoff({ directory }, { clock: () => now, usageCollector });
  assert.equal(handoff.rotation?.phase.rootSessionId, "root-new");
  assert.equal(handoff.rotation?.phase.startEvent.sequence, verified.verification.event.sequence);
  assert.match(formatHandoff(handoff), /Phase rotation: recommended/);
});

test("stale canonical handoffs and absent threshold evidence fail closed", async () => {
  const directory = await project();
  const start = (await readOrchestration(directory)).events[0]!;
  await setRotationPolicy({
    directory,
    rootSessionId: "root-old",
    startEvent: start.id,
    thresholds: { supervisorContextPercent: 75 },
    reason: "Require explicit context evidence",
    evidence: ["roadmap:SYN-093A"]
  });
  let now = "2026-08-12T10:02:00.000Z";
  const unavailable = collector(directory, () => now);
  const report = await reportProjectRotation({ directory }, { clock: () => now, usageCollector: unavailable });
  assert.equal(report.recommended, false);
  await assert.rejects(
    prepareProjectRotation({ directory }, { clock: () => now, usageCollector: unavailable }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_NOT_RECOMMENDED
  );

  await setRotationPolicy({
    directory,
    rootSessionId: "root-old",
    startEvent: (await readOrchestration(directory)).events.at(-1)!.id,
    thresholds: { compactions: 1 },
    reason: "Use available compaction evidence",
    evidence: ["roadmap:SYN-093A"],
    replace: true
  });
  now = "2026-08-12T10:03:00.000Z";
  const available = collector(directory, () => now, { compactions: 1 });
  const prepared = await prepareProjectRotation({ directory }, { clock: () => now, usageCollector: available });
  await addTask({
    directory,
    id: "SYN-STALE",
    objective: "Invalidate the prepared handoff",
    executor: "synod_implementer",
    acceptance: ["Staleness is detected."],
    verification: ["pnpm test"]
  });
  await assert.rejects(
    verifyProjectRotation({ directory, recommendation: prepared.recommendation.event.id, rootSessionId: "root-new" }, {
      usageSessionResolver: async (options = {}) => ({ threadId: String(options.threadId), cwd: path.resolve(String(options.cwd)), createdAt: "2026-08-12T10:04:00.000Z", warnings: [], diagnostics: {} })
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_STALE
  );
});

test("new-root resolution rejects descendants and sessions from another project", async () => {
  const directory = await project();
  let closed = 0;
  const client = (records: Record<string, { id: string; parentThreadId: string | null; cwd: string }>) => ({
    async start() {},
    async close() { closed += 1; },
    async request(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "thread/read");
      return { thread: records[String(params.threadId)] };
    },
    getWarnings() { return []; },
    getDiagnostics() { return {}; }
  });

  const descendants = {
    child: { id: "child", parentThreadId: "root", cwd: directory },
    root: { id: "root", parentThreadId: null, cwd: directory }
  };
  await assert.rejects(
    resolveUsageRootSession({ cwd: directory, threadId: "child", clientFactory: () => client(descendants) }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_SESSION_INVALID
  );
  await assert.rejects(
    resolveUsageRootSession({
      cwd: directory,
      threadId: "other",
      clientFactory: () => client({ other: { id: "other", parentThreadId: null, cwd: path.join(directory, "other") } })
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ROTATION_SESSION_INVALID
  );
  assert.equal(closed, 2);
});

test("rotation CLI exposes set, report, prepare, and verify envelopes", async () => {
  const directory = await project();
  const start = (await readOrchestration(directory)).events[0]!;
  const messages: string[] = [];
  const output = {
    log(...values: unknown[]) { messages.push(values.join(" ")); },
    warn(...values: unknown[]) { messages.push(values.join(" ")); },
    error(...values: unknown[]) { messages.push(values.join(" ")); }
  };
  let now = "2026-08-12T10:01:00.000Z";
  const usageCollector = collector(directory, () => now, { compactions: 1 });
  const dependencies = {
    clock: () => now,
    usageCollector,
    usageSessionResolver: async (options: NonNullable<Parameters<typeof import("../src/usage.js").resolveUsageRootSession>[0]> = {}) => ({
      threadId: String(options.threadId),
      cwd: path.resolve(String(options.cwd)),
      createdAt: now,
      warnings: [],
      diagnostics: {}
    })
  };

  assert.equal(await run([
    "rotation", "set", "--session", "root-old", "--since-event", start.id,
    "--compactions", "1", "--reason", "CLI phase", "--evidence", "cli:set", "--cwd", directory, "--json"
  ], output, dependencies), 0);
  assert.equal(JSON.parse(messages.pop()!).data.policy.revision, 1);
  now = "2026-08-12T10:02:00.000Z";
  assert.equal(await run(["rotation", "report", "--cwd", directory, "--json"], output, dependencies), 0);
  assert.equal(JSON.parse(messages.pop()!).data.report.recommended, true);
  assert.equal(await run(["rotation", "prepare", "--cwd", directory, "--json"], output, dependencies), 0);
  const prepared = JSON.parse(messages.pop()!);
  now = "2026-08-12T10:03:00.000Z";
  assert.equal(await run([
    "rotation", "verify", "--recommendation", prepared.data.recommendation.event.id,
    "--session", "root-new", "--cwd", directory, "--json"
  ], output, dependencies), 0);
  assert.equal(JSON.parse(messages.pop()!).data.verification.newRootSessionId, "root-new");
});
