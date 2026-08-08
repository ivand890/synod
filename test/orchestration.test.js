import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES } from "../src/errors.js";
import { initProject } from "../src/lifecycle.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  addTask,
  orchestrationStatus,
  readOrchestration,
  recordCheckpoint,
  transitionTask
} from "../src/orchestration.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set();

async function temporaryProject() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-test-"));
  temporaryDirectories.add(directory);
  await initProject({ directory });
  return directory;
}

async function git(directory, ...args) {
  return execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
}

async function addDefaultTask(directory, extra = {}) {
  return addTask({
    directory,
    id: "T-001",
    objective: "Implement enforced orchestration",
    executor: "synod_implementer",
    acceptance: ["The observable contract is satisfied."],
    verification: ["pnpm test"],
    ...extra
  });
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("initializes canonical state, a hash-chained log, and a Markdown projection", async () => {
  const directory = await temporaryProject();
  const { state, events } = await readOrchestration(directory);
  const markdown = await readFile(path.join(directory, ORCHESTRATION_STATUS_PATH), "utf8");

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.lastEvent.sequence, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "project.initialized");
  assert.equal(events[0].previousHash, null);
  assert.equal(events[0].eventHash, state.lastEvent.hash);
  assert.match(markdown, /Generated from `\.synod\/state\.json`/);
  assert.match(markdown, /No tasks recorded/);
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
});

test("enforces the complete revision, acceptance, verification, and completion path", async () => {
  const directory = await temporaryProject();
  await addDefaultTask(directory);
  await transitionTask({ directory, id: "T-001", to: "READY", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 1, evidence: ["commit:abc123"] });
  await transitionTask({ directory, id: "T-001", to: "ACCEPTED", revision: 1, evidence: ["review:approved"] });
  await transitionTask({ directory, id: "T-001", to: "VERIFIED", revision: 1, evidence: ["test:pnpm-test:pass"] });
  await transitionTask({ directory, id: "T-001", to: "DONE", revision: 1 });

  const { state, events } = await readOrchestration(directory);
  const task = state.tasks["T-001"];
  assert.equal(task.state, "DONE");
  assert.equal(task.revision, 1);
  assert.equal(task.executor, "synod_implementer");
  assert.equal(task.correctionRound, 0);
  assert.equal(task.acceptance.status, "accepted");
  assert.equal(task.acceptance.revision, 1);
  assert.equal(task.verification.status, "passed");
  assert.equal(task.verification.revision, 1);
  assert.deepEqual(task.evidence.map(item => [item.kind, item.revision]), [
    ["delivery", 1],
    ["acceptance", 1],
    ["verification", 1]
  ]);
  assert.equal(events.length, 8);
  for (const [index, event] of events.entries()) {
    assert.equal(event.sequence, index + 1);
    if (index > 0) assert.equal(event.previousHash, events[index - 1].eventHash);
  }
});

test("rejected transitions do not mutate canonical state or append the log", async () => {
  const directory = await temporaryProject();
  await addDefaultTask(directory);
  await transitionTask({ directory, id: "T-001", to: "READY", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
  const stateBefore = await readFile(path.join(directory, ORCHESTRATION_STATE_PATH), "utf8");
  const eventsBefore = await readFile(path.join(directory, ORCHESTRATION_EVENTS_PATH), "utf8");

  await assert.rejects(
    transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 0, evidence: ["delivery"] }),
    error => error.code === ERROR_CODES.REVISION_MISMATCH
  );
  await assert.rejects(
    transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 1 }),
    error => error.code === ERROR_CODES.EVIDENCE_REQUIRED
  );

  assert.equal(await readFile(path.join(directory, ORCHESTRATION_STATE_PATH), "utf8"), stateBefore);
  assert.equal(await readFile(path.join(directory, ORCHESTRATION_EVENTS_PATH), "utf8"), eventsBefore);
});

test("a correction round invalidates prior acceptance and advances the next delivery revision", async () => {
  const directory = await temporaryProject();
  await addDefaultTask(directory);
  await transitionTask({ directory, id: "T-001", to: "READY", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 1, evidence: ["delivery:r1"] });
  await transitionTask({ directory, id: "T-001", to: "ACCEPTED", revision: 1, evidence: ["acceptance:r1"] });
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 1, evidence: ["correction:requested"] });
  const corrected = await transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 2, evidence: ["delivery:r2"] });

  assert.equal(corrected.task.state, "REVIEW");
  assert.equal(corrected.task.revision, 2);
  assert.equal(corrected.task.correctionRound, 1);
  assert.equal(corrected.task.acceptance.status, "pending");
  assert.equal(corrected.task.acceptance.revision, null);
  assert.deepEqual(corrected.task.evidence.map(item => [item.kind, item.revision]), [
    ["delivery", 1],
    ["acceptance", 1],
    ["correction", 1],
    ["delivery", 2]
  ]);
});

test("dependencies gate READY transitions", async () => {
  const directory = await temporaryProject();
  await addDefaultTask(directory);
  await addTask({
    directory,
    id: "T-002",
    objective: "Consume the first task",
    executor: "synod_implementer",
    acceptance: ["Dependency output is consumed."],
    verification: ["pnpm test"],
    dependsOn: ["T-001"]
  });

  await assert.rejects(
    transitionTask({ directory, id: "T-002", to: "READY", revision: 0 }),
    error => error.code === ERROR_CODES.TRANSITION_INVALID && error.details.incomplete[0] === "T-001"
  );
});

test("blocked tasks can resume only their recorded prior state", async () => {
  const directory = await temporaryProject();
  await addDefaultTask(directory);
  await transitionTask({ directory, id: "T-001", to: "READY", revision: 0 });
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
  const blocked = await transitionTask({
    directory,
    id: "T-001",
    to: "BLOCKED",
    revision: 0,
    reason: "Waiting for an authorized service"
  });
  assert.equal(blocked.task.blockedFrom, "ACTIVE");

  await assert.rejects(
    transitionTask({ directory, id: "T-001", to: "READY", revision: 0 }),
    error => error.code === ERROR_CODES.TRANSITION_INVALID && error.details.blockedFrom === "ACTIVE"
  );
  const resumed = await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
  assert.equal(resumed.task.state, "ACTIVE");
  assert.equal(resumed.task.blockedFrom, undefined);
});

test("status detects content-sensitive checkpoint drift and checkpoint reconciles it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-git-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(path.join(directory, "source.txt"), "version one\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });

  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  const goal = await readFile(goalPath, "utf8");
  await writeFile(goalPath, `${goal}\nChanged durable goal.\n`, "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
  await writeFile(goalPath, goal, "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, true);

  await writeFile(path.join(directory, "source.txt"), "version two\n", "utf8");
  const drifted = await orchestrationStatus({ directory });
  assert.equal(drifted.healthy, false);
  assert.ok(drifted.drift.reasons.some(item => item.field === "git.worktree"));

  await addDefaultTask(directory);
  assert.equal((await orchestrationStatus({ directory })).healthy, false);

  await recordCheckpoint({ directory, message: "Accept source update" });
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
});

test("checkpoint fingerprints include the exact staged index content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-index-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  const sourcePath = path.join(directory, "source.txt");
  await writeFile(sourcePath, "initial\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });

  await writeFile(sourcePath, "staged one\n", "utf8");
  await git(directory, "add", "source.txt");
  await writeFile(sourcePath, "stable worktree\n", "utf8");
  await recordCheckpoint({ directory, message: "Record partially staged work" });
  assert.equal((await orchestrationStatus({ directory })).healthy, true);

  await writeFile(sourcePath, "staged two\n", "utf8");
  await git(directory, "add", "source.txt");
  await writeFile(sourcePath, "stable worktree\n", "utf8");
  const drifted = await orchestrationStatus({ directory });
  assert.equal(drifted.healthy, false);
  assert.ok(drifted.drift.reasons.some(item => item.field === "git.worktree"));
});

test("stale orchestration locks are reclaimed while live locks fail closed", async () => {
  const directory = await temporaryProject();
  const lockPath = path.join(directory, ".synod/orchestration.lock");
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const stalePid = exited.pid;
  await once(exited, "exit");
  await writeFile(lockPath, `${JSON.stringify({
    pid: stalePid,
    token: "stale-owner",
    createdAt: "2026-08-08T00:00:00.000Z"
  })}\n`, "utf8");

  assert.equal((await readOrchestration(directory)).state.schemaVersion, 1);
  await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });

  const liveLock = `${JSON.stringify({
    pid: process.pid,
    token: "live-owner",
    createdAt: "2026-08-08T00:00:00.000Z"
  })}\n`;
  await writeFile(lockPath, liveLock, "utf8");
  await assert.rejects(
    readOrchestration(directory),
    error => error.code === ERROR_CODES.ORCHESTRATION_LOCKED && error.details.pid === process.pid
  );
  assert.equal(await readFile(lockPath, "utf8"), liveLock);
});

test("event log mutations append without rewriting the prior prefix", async () => {
  const directory = await temporaryProject();
  const before = await readFile(path.join(directory, ORCHESTRATION_EVENTS_PATH), "utf8");
  await addDefaultTask(directory);
  const after = await readFile(path.join(directory, ORCHESTRATION_EVENTS_PATH), "utf8");

  assert.ok(after.startsWith(before));
  assert.ok(after.length > before.length);
});

test("a transient state/view transaction failure is recovered from the pending append", async () => {
  const directory = await temporaryProject();
  let injected = false;
  const result = await addTask({
    directory,
    id: "T-001",
    objective: "Recover a committed event",
    executor: "synod_implementer",
    acceptance: ["The event and state agree."],
    verification: ["pnpm test"]
  }, {
    transactionHook(operation) {
      if (!injected && operation.path === ORCHESTRATION_STATUS_PATH) {
        injected = true;
        throw new Error("injected projection failure");
      }
    }
  });

  assert.equal(result.task.id, "T-001");
  const { state, events } = await readOrchestration(directory);
  assert.equal(state.lastEvent.sequence, 2);
  assert.equal(events.length, 2);
  await assert.rejects(readFile(path.join(directory, ".synod/pending-mutation.json"), "utf8"), { code: "ENOENT" });
});

test("tampered event logs fail closed", async () => {
  const directory = await temporaryProject();
  const eventPath = path.join(directory, ORCHESTRATION_EVENTS_PATH);
  const events = await readFile(eventPath, "utf8");
  await writeFile(eventPath, events.replace("project.initialized", "project.rewritten"), "utf8");

  await assert.rejects(
    readOrchestration(directory),
    error => error.code === ERROR_CODES.EVENT_LOG_INVALID
  );
});

test("status fails closed when the generated Markdown view diverges from canonical state", async () => {
  const directory = await temporaryProject();
  await writeFile(path.join(directory, ORCHESTRATION_STATUS_PATH), "# Hand-edited status\n", "utf8");

  await assert.rejects(
    orchestrationStatus({ directory }),
    error => error.code === ERROR_CODES.ORCHESTRATION_STATE_INVALID
      && error.details.path === ORCHESTRATION_STATUS_PATH
  );
});
