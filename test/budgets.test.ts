import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  acquireTaskLease,
  addTask,
  createOrchestrationSchemaMigrationFiles,
  decideTaskBudget,
  heartbeatTaskLease,
  observeTaskBudget,
  orchestrationStatus,
  readOrchestration,
  reportTaskBudget,
  setTaskBudgetPolicy,
  splitTask,
  transitionTask,
  validateOrchestrationState
} from "../src/orchestration.js";
import type { OrchestrationEvent } from "../src/orchestration.js";
import type { UsageReport } from "../src/usage.js";
import { isRecord } from "../src/validation.js";

const temporaryDirectories = new Set<string>();
const execFileAsync = promisify(execFile);

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-budget-test-"));
  temporaryDirectories.add(directory);
  await execFileAsync("git", ["-C", directory, "init", "--quiet"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Synod Tests"]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "synod-tests@example.invalid"]);
  await execFileAsync("git", ["-C", directory, "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  await initProject({ directory }, { clock: () => "2026-08-12T10:00:00.000Z" });
  return directory;
}

async function task(directory: string, id = "T-BUDGET"): Promise<void> {
  await addTask({
    directory,
    id,
    objective: `Budget ${id}`,
    executor: "synod_implementer",
    acceptance: ["Budget history is canonical."],
    verification: ["pnpm test"]
  }, { clock: () => "2026-08-12T10:01:00.000Z" });
}

function usageReport(start: OrchestrationEvent, totalTokens: number, {
  session = "root-session",
  resets = 0,
  capturedAt = "2026-08-12T10:05:00.000Z"
}: { session?: string; resets?: number; capturedAt?: string } = {}): UsageReport {
  return {
    session: { threadId: session },
    capturedAt,
    models: [],
    roles: [],
    attribution: [],
    threads: [{
      threadId: session,
      parentThreadId: null,
      role: "supervisor",
      source: "cli",
      models: 1,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
      rollout: { bytes: 256, sha256: `sha256:${"a".repeat(64)}`, lastObservedAt: capturedAt },
      activity: { turnsStarted: 1, turnsCompleted: 0, turnsAborted: 0, compactions: 0 }
    }],
    total: {
      threads: 1,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens
    },
    tokenCounters: { resets },
    completeness: { status: "incomplete", reasons: ["open-canonical-interval"] },
    coordination: {} as UsageReport["coordination"],
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

function collector(report: UsageReport) {
  return async () => report;
}

async function configure(directory: string, limits: { soft?: number; hard?: number } = { soft: 80, hard: 100 }) {
  const start = (await readOrchestration(directory)).events[0]!;
  return {
    start,
    result: await setTaskBudgetPolicy({
      directory,
      id: "T-BUDGET",
      rootSessionId: "root-session",
      startEvent: start.id,
      ...(limits.soft === undefined ? {} : { softTotalTokens: limits.soft }),
      ...(limits.hard === undefined ? {} : { hardTotalTokens: limits.hard }),
      reason: "Bound the implementation phase",
      evidence: ["roadmap:SYN-092A"]
    }, { clock: () => "2026-08-12T10:02:00.000Z" })
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hashEvent(event: Record<string, unknown>): string {
  const unsigned = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
  return `sha256:${createHash("sha256").update(stable(unsigned), "utf8").digest("hex")}`;
}

test("migrates schema 2 to schema 3 without rewriting the event prefix or inventing budgets", async () => {
  const directory = await project();
  const statePath = path.join(directory, ORCHESTRATION_STATE_PATH);
  const eventPath = path.join(directory, ORCHESTRATION_EVENTS_PATH);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  state.schemaVersion = 2;
  event.schemaVersion = 2;
  event.state.schemaVersion = 2;
  event.eventHash = hashEvent(event);
  state.lastEvent.hash = event.eventHash;
  const prefix = `${JSON.stringify(event)}\n`;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(eventPath, prefix, "utf8");

  const migration = await createOrchestrationSchemaMigrationFiles(directory, {
    clock: () => "2026-08-12T10:03:00.000Z"
  });
  assert.equal(migration.status, "migrated");
  if (migration.status !== "migrated") return;
  for (const [relativePath, contents] of migration.files) {
    await mkdir(path.dirname(path.join(directory, relativePath)), { recursive: true });
    await writeFile(path.join(directory, relativePath), contents, "utf8");
  }

  const migratedBytes = await readFile(eventPath, "utf8");
  assert.ok(migratedBytes.startsWith(prefix));
  const canonical = await readOrchestration(directory);
  assert.equal(canonical.state.schemaVersion, 3);
  assert.equal(canonical.events.length, 2);
  assert.deepEqual(canonical.events[1]?.payload, {
    fromSchemaVersion: 2,
    toSchemaVersion: 3,
    preservedEventCount: 1
  });
  assert.ok(canonical.state.taskOrder.every(id => canonical.state.tasks[id]?.budget === undefined));
});

test("rejects skipped schema boundaries and old-schema events after schema 3", async () => {
  const skippedDirectory = await project();
  const skippedEventPath = path.join(skippedDirectory, ORCHESTRATION_EVENTS_PATH);
  const skippedStatePath = path.join(skippedDirectory, ORCHESTRATION_STATE_PATH);
  const currentEvent = JSON.parse(await readFile(skippedEventPath, "utf8"));
  const legacyCore = structuredClone(currentEvent.state);
  legacyCore.schemaVersion = 1;
  delete legacyCore.leaseBaselines;
  const legacyEvent = { ...currentEvent, schemaVersion: 1, state: legacyCore };
  legacyEvent.eventHash = hashEvent(legacyEvent);
  const skippedEvent = {
    ...currentEvent,
    sequence: 2,
    id: "skipped-schema-boundary",
    type: "orchestration.migrated",
    payload: { fromSchemaVersion: 1, toSchemaVersion: 3 },
    previousHash: legacyEvent.eventHash
  };
  skippedEvent.eventHash = hashEvent(skippedEvent);
  const skippedState = {
    ...skippedEvent.state,
    lastEvent: { sequence: 2, id: skippedEvent.id, hash: skippedEvent.eventHash }
  };
  await writeFile(skippedEventPath, `${JSON.stringify(legacyEvent)}\n${JSON.stringify(skippedEvent)}\n`, "utf8");
  await writeFile(skippedStatePath, `${JSON.stringify(skippedState, null, 2)}\n`, "utf8");
  await assert.rejects(
    readOrchestration(skippedDirectory),
    error => error instanceof SynodError && error.code === ERROR_CODES.EVENT_LOG_INVALID
  );

  const downgradeDirectory = await project();
  const downgradeEventPath = path.join(downgradeDirectory, ORCHESTRATION_EVENTS_PATH);
  const schemaThreeEvent = JSON.parse(await readFile(downgradeEventPath, "utf8"));
  const schemaTwoCore = structuredClone(schemaThreeEvent.state);
  schemaTwoCore.schemaVersion = 2;
  const downgradeEvent = {
    ...schemaThreeEvent,
    schemaVersion: 2,
    sequence: 2,
    id: "schema-downgrade",
    type: "task.invalid-downgrade",
    payload: {},
    previousHash: schemaThreeEvent.eventHash,
    state: schemaTwoCore
  };
  downgradeEvent.eventHash = hashEvent(downgradeEvent);
  await writeFile(downgradeEventPath, `${JSON.stringify(schemaThreeEvent)}\n${JSON.stringify(downgradeEvent)}\n`, "utf8");
  await assert.rejects(
    readOrchestration(downgradeDirectory),
    error => error instanceof SynodError && error.code === ERROR_CODES.EVENT_LOG_INVALID
  );
});

test("reports a soft crossing without mutating canonical state", async () => {
  const directory = await project();
  await task(directory);
  const { start } = await configure(directory);
  const paths = [ORCHESTRATION_STATE_PATH, ORCHESTRATION_EVENTS_PATH, ORCHESTRATION_STATUS_PATH]
    .map(item => path.join(directory, item));
  const before = await Promise.all(paths.map(item => readFile(item)));

  const report = await reportTaskBudget({ directory, id: "T-BUDGET" }, {
    usageCollector: collector(usageReport(start, 90))
  });

  assert.equal(report.thresholdStatus, "soft-exceeded");
  assert.equal(report.warnings[0]?.code, "SYNOD_BUDGET_SOFT_EXCEEDED");
  assert.deepEqual(await Promise.all(paths.map(item => readFile(item))), before);
  assert.equal((await readOrchestration(directory)).state.tasks["T-BUDGET"]?.budget?.thresholdStatus, "within");
});

test("records a hard crossing, gates execution, and resumes only through an exact bounded continuation", async () => {
  const directory = await project();
  await task(directory);
  const { start } = await configure(directory);
  const observed = await observeTaskBudget({ directory, id: "T-BUDGET" }, {
    clock: () => "2026-08-12T10:06:00.000Z",
    usageCollector: collector(usageReport(start, 120))
  });

  assert.equal(observed.task.state, "PLANNED");
  assert.equal(observed.task.budget?.thresholdStatus, "decision-required");
  const forged = structuredClone((await readOrchestration(directory)).state);
  forged.tasks["T-BUDGET"]!.budget!.observations.at(-1)!.thresholdStatus = "within";
  forged.tasks["T-BUDGET"]!.budget!.thresholdStatus = "within";
  assert.throws(
    () => validateOrchestrationState(forged),
    error => error instanceof SynodError && error.code === ERROR_CODES.ORCHESTRATION_STATE_INVALID
  );
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await assert.rejects(
    transitionTask({ directory, id: "T-BUDGET", to: "READY", revision: 0 }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_DECISION_REQUIRED
  );
  await assert.rejects(
    acquireTaskLease({ directory, id: "T-BUDGET", ownerThread: "worker", write: ["src/budget.ts"] }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_DECISION_REQUIRED
  );
  await assert.rejects(
    decideTaskBudget({
      directory,
      id: "T-BUDGET",
      observation: observed.observation.event.id,
      action: "continue",
      addedAllowance: 1,
      reason: "Too small",
      evidence: ["review:budget"]
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_INVALID
  );

  const continued = await decideTaskBudget({
    directory,
    id: "T-BUDGET",
    observation: observed.observation.event.id,
    action: "continue",
    addedAllowance: 50,
    reason: "Finish the bounded implementation",
    evidence: ["review:budget"]
  }, { clock: () => "2026-08-12T10:07:00.000Z" });
  assert.equal(continued.task.budget?.thresholdStatus, "soft-exceeded");
  assert.equal(continued.task.budget && continued.task.budget.policy.hardTotalTokens! + continued.decision.addedAllowance!, 150);
  await transitionTask({ directory, id: "T-BUDGET", to: "READY", revision: 0 });
  await assert.rejects(
    decideTaskBudget({
      directory,
      id: "T-BUDGET",
      observation: observed.observation.event.id,
      action: "continue",
      addedAllowance: 50,
      reason: "Replay",
      evidence: ["review:budget"]
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_STALE
  );
});

test("a rotate decision authorizes policy and session replacement", async () => {
  const directory = await project();
  await task(directory);
  const { start } = await configure(directory);
  const observed = await observeTaskBudget({ directory, id: "T-BUDGET" }, {
    usageCollector: collector(usageReport(start, 120))
  });
  await decideTaskBudget({
    directory,
    id: "T-BUDGET",
    observation: observed.observation.event.id,
    action: "rotate",
    reason: "Continue in a fresh root session",
    evidence: ["handoff:rotation"]
  });
  const rotationStart = (await readOrchestration(directory)).events.at(-1)!;
  await assert.rejects(
    setTaskBudgetPolicy({
      directory,
      id: "T-BUDGET",
      rootSessionId: "root-session",
      startEvent: rotationStart.id,
      hardTotalTokens: 100,
      reason: "Attempt to clear the gate without a new session",
      evidence: ["handoff:rotation"],
      replace: true
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_INVALID
  );
  await assert.rejects(
    setTaskBudgetPolicy({
      directory,
      id: "T-BUDGET",
      rootSessionId: "rotated-root-session",
      startEvent: start.id,
      hardTotalTokens: 100,
      reason: "Attempt to reuse the old phase boundary",
      evidence: ["handoff:rotation"],
      replace: true
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_INVALID
  );
  const replaced = await setTaskBudgetPolicy({
    directory,
    id: "T-BUDGET",
    rootSessionId: "rotated-root-session",
    startEvent: rotationStart.id,
    hardTotalTokens: 100,
    reason: "Bind the rotated execution phase",
    evidence: ["handoff:rotation"],
    replace: true
  });

  assert.equal(replaced.policy.revision, 2);
  assert.equal(replaced.task.budget?.thresholdStatus, "within");
  assert.equal(replaced.task.budget?.policyHistory[0]?.rootSessionId, "root-session");
  assert.equal(replaced.task.budget?.observations[0]?.totalTokens, 120);
  assert.equal(replaced.task.budget?.decisions[0]?.action, "rotate");
  assert.match(formatHandoff(await generateHandoff({ directory })), /Token budget: within; policy r2; raw unobserved;/);
  await transitionTask({ directory, id: "T-BUDGET", to: "READY", revision: 0 });
});

test("hard enforcement blocks lease renewal while preserving the delivery and review path", async () => {
  const directory = await project();
  await task(directory);
  const { start } = await configure(directory);
  await transitionTask({ directory, id: "T-BUDGET", to: "READY", revision: 0 });
  const acquired = await acquireTaskLease({
    directory,
    id: "T-BUDGET",
    ownerThread: "worker",
    write: ["src/budget.ts"]
  });
  await transitionTask({ directory, id: "T-BUDGET", to: "ACTIVE", revision: 0 });
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "src/budget.ts"), "export const budget = true;\n", "utf8");
  await observeTaskBudget({ directory, id: "T-BUDGET" }, {
    usageCollector: collector(usageReport(start, 120))
  });

  await assert.rejects(
    heartbeatTaskLease({
      directory,
      id: "T-BUDGET",
      leaseId: acquired.lease.id,
      generation: acquired.lease.generation,
      revision: acquired.lease.taskRevision,
      expectedHeartbeatAt: acquired.lease.heartbeatAt,
      ownerThread: acquired.lease.ownerThread
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_DECISION_REQUIRED
  );
  const delivered = await transitionTask({
    directory,
    id: "T-BUDGET",
    to: "REVIEW",
    revision: 1,
    evidence: ["delivery:budget"]
  });
  assert.equal(delivered.task.state, "REVIEW");
  assert.equal(delivered.task.budget?.thresholdStatus, "decision-required");
  assert.ok(delivered.task.proposal);
});

test("fails closed for changed sessions, counter resets, and canonical races", async () => {
  const directory = await project();
  await task(directory);
  const { start } = await configure(directory);
  await assert.rejects(
    reportTaskBudget({ directory, id: "T-BUDGET" }, {
      usageCollector: collector(usageReport(start, 20, { session: "different-root" }))
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_STALE
  );
  await assert.rejects(
    reportTaskBudget({ directory, id: "T-BUDGET" }, {
      usageCollector: collector(usageReport(start, 20, { resets: 1 }))
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_REPORT_INCOMPLETE
  );

  const racedReport = usageReport(start, 20);
  await assert.rejects(
    observeTaskBudget({ directory, id: "T-BUDGET" }, {
      usageCollector: async () => {
        await task(directory, "T-RACE");
        return racedReport;
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_STALE
  );
  assert.equal((await readOrchestration(directory)).state.tasks["T-BUDGET"]?.budget?.observations.length, 0);

  const first = usageReport(start, 20);
  const changed = structuredClone(first);
  changed.threads[0]!.rollout.sha256 = `sha256:${"b".repeat(64)}`;
  let calls = 0;
  await assert.rejects(
    observeTaskBudget({ directory, id: "T-BUDGET" }, {
      usageCollector: async () => calls++ === 0 ? first : changed
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_STALE
  );
  assert.equal((await readOrchestration(directory)).state.tasks["T-BUDGET"]?.budget?.observations.length, 0);
});

test("split decisions preserve complete budget history and require explicit replacement before child execution", async () => {
  const directory = await project();
  await task(directory);
  await task(directory, "T-LEFT");
  await task(directory, "T-RIGHT");
  const { start } = await configure(directory);
  const observed = await observeTaskBudget({ directory, id: "T-BUDGET" }, {
    usageCollector: collector(usageReport(start, 120))
  });
  await decideTaskBudget({
    directory,
    id: "T-BUDGET",
    observation: observed.observation.event.id,
    action: "split",
    reason: "Separate the remaining work",
    evidence: ["review:split"]
  });
  const split = await splitTask({
    directory,
    id: "T-BUDGET",
    replacements: ["T-LEFT", "T-RIGHT"],
    reason: "Separate the remaining work",
    evidence: ["review:split"]
  });
  assert.equal(split.task.state, "SUPERSEDED");
  assert.ok(split.replacements.every(item => item.budget?.observations[0]?.totalTokens === 120));
  await assert.rejects(
    transitionTask({ directory, id: "T-LEFT", to: "READY", revision: 0 }),
    error => error instanceof SynodError && error.code === ERROR_CODES.BUDGET_DECISION_REQUIRED
  );

  const replacementStart = (await readOrchestration(directory)).events.at(-1)!;
  const replaced = await setTaskBudgetPolicy({
    directory,
    id: "T-LEFT",
    rootSessionId: "left-session",
    startEvent: replacementStart.id,
    hardTotalTokens: 50,
    reason: "Bind the left child phase",
    evidence: ["handoff:left"],
    replace: true
  });
  assert.equal(replaced.policy.revision, 2);
  assert.equal(replaced.task.budget?.policyHistory[0]?.rootSessionId, "root-session");
  assert.equal(replaced.task.budget?.observations[0]?.totalTokens, 120);
  await transitionTask({ directory, id: "T-LEFT", to: "READY", revision: 0 });
});

test("budget CLI exposes policy, report, observation, and exact decision envelopes", async () => {
  const directory = await project();
  await task(directory);
  const start = (await readOrchestration(directory)).events[0]!;
  const messages: string[] = [];
  const output = {
    log(...values: unknown[]) { messages.push(values.join(" ")); },
    warn(...values: unknown[]) { messages.push(values.join(" ")); },
    error(...values: unknown[]) { messages.push(values.join(" ")); }
  };
  let now = "2026-08-12T10:02:00.000Z";
  const dependencies = {
    clock: () => now,
    usageCollector: collector(usageReport(start, 120))
  };
  assert.equal(await run([
    "budget", "set", "T-BUDGET",
    "--session", "root-session",
    "--since-event", start.id,
    "--soft-tokens", "80",
    "--hard-tokens", "100",
    "--reason", "CLI policy",
    "--evidence", "roadmap:SYN-092A",
    "--cwd", directory,
    "--json"
  ], output, dependencies), 0);
  assert.equal(JSON.parse(messages.pop()!).data.policy.revision, 1);

  assert.equal(await run(["budget", "report", "T-BUDGET", "--cwd", directory, "--json"], output, dependencies), 0);
  const reported = JSON.parse(messages.pop()!);
  assert.equal(reported.data.report.thresholdStatus, "decision-required");
  assert.equal(reported.warnings[0]?.code, "SYNOD_BUDGET_HARD_EXCEEDED");

  now = "2026-08-12T10:06:00.000Z";
  assert.equal(await run(["budget", "observe", "T-BUDGET", "--cwd", directory, "--json"], output, dependencies), 0);
  const observed = JSON.parse(messages.pop()!);
  const observationId = observed.data.observation.event.id;
  assert.equal(observed.data.observation.totalTokens, 120);

  now = "2026-08-12T10:07:00.000Z";
  assert.equal(await run([
    "budget", "decide", "T-BUDGET",
    "--observation", observationId,
    "--decision", "continue",
    "--additional-tokens", "50",
    "--reason", "Finish CLI work",
    "--evidence", "review:budget",
    "--cwd", directory,
    "--json"
  ], output, dependencies), 0);
  assert.equal(JSON.parse(messages.pop()!).data.decision.action, "continue");
});
