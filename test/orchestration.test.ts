import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { CHECKPOINT_SNAPSHOT_PATH } from "../src/checkpoint.js";
import { contentHash } from "../src/filesystem.js";
import { initProject } from "../src/lifecycle.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  TASK_STATES,
  addTask,
  formatOrchestrationStatus,
  orchestrationStatus,
  readOrchestration,
  recordCheckpoint,
  renderStatusMarkdown,
  transitionTask
} from "../src/orchestration.js";
import type { AddTaskOptions } from "../src/orchestration.js";
import { isRecord } from "../src/validation.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

test("keeps the exported task-state table immutable at runtime", () => {
  assert.equal(Object.isFrozen(TASK_STATES), true);
  assert.throws(() => Reflect.apply(Array.prototype.push, TASK_STATES, ["INVALID"]), TypeError);
});

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-test-"));
  temporaryDirectories.add(directory);
  await initProject({ directory });
  return directory;
}

async function git(directory: string, ...args: string[]): Promise<unknown> {
  return execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function orchestrationEventHash(event: Record<string, unknown>): string {
  const unsigned = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(unsigned)), "utf8").digest("hex")}`;
}

async function addDefaultTask(directory: string, extra: Partial<AddTaskOptions> = {}) {
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
  const initialEvent = events[0];
  assert.ok(initialEvent);
  assert.equal(initialEvent.type, "project.initialized");
  assert.equal(initialEvent.previousHash, null);
  assert.equal(initialEvent.eventHash, state.lastEvent.hash);
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
  assert.ok(task);
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
    if (index > 0) assert.equal(event.previousHash, events[index - 1]?.eventHash);
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
    error => error instanceof SynodError && error.code === ERROR_CODES.REVISION_MISMATCH
  );
  await assert.rejects(
    transitionTask({ directory, id: "T-001", to: "REVIEW", revision: 1 }),
    error => error instanceof SynodError && error.code === ERROR_CODES.EVIDENCE_REQUIRED
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
    error => error instanceof SynodError
      && error.code === ERROR_CODES.TRANSITION_INVALID
      && isRecord(error.details)
      && Array.isArray(error.details.incomplete)
      && error.details.incomplete[0] === "T-001"
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
    error => error instanceof SynodError
      && error.code === ERROR_CODES.TRANSITION_INVALID
      && isRecord(error.details)
      && error.details.blockedFrom === "ACTIVE"
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

test("status explain distinguishes committed, staged, unstaged, untracked, deleted, renamed, and binary paths without writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-delta-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  for (const [name, content] of ([
    ["committed.txt", "base\n"],
    ["staged.txt", "base\n"],
    ["unstaged.txt", "base\n"],
    ["deleted.txt", "base\n"],
    ["rename.txt", "base\n"]
  ] as const)) await writeFile(path.join(directory, name), content, "utf8");
  await writeFile(path.join(directory, "binary.dat"), Buffer.from([0]));
  await writeFile(path.join(directory, "committed-binary.dat"), Buffer.from([0]));
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });

  await writeFile(path.join(directory, "committed.txt"), "committed\n", "utf8");
  await git(directory, "add", "committed.txt");
  await git(directory, "commit", "-m", "advance head");
  await writeFile(path.join(directory, "committed-binary.dat"), Buffer.from([0xff]));
  await git(directory, "add", "committed-binary.dat");
  await git(directory, "commit", "-m", "advance binary head");
  await writeFile(path.join(directory, "staged.txt"), "staged\n", "utf8");
  await git(directory, "add", "staged.txt");
  await writeFile(path.join(directory, "unstaged.txt"), "unstaged\n", "utf8");
  await unlink(path.join(directory, "deleted.txt"));
  await git(directory, "mv", "rename.txt", "renamed.txt");
  await writeFile(path.join(directory, "untracked.txt"), "new\n", "utf8");
  await writeFile(path.join(directory, "untracked-nul.dat"), Buffer.from([0, 65]));
  await writeFile(path.join(directory, "binary.dat"), Buffer.from([0xff]));

  const trackedRecords = [ORCHESTRATION_STATE_PATH, ORCHESTRATION_EVENTS_PATH, ORCHESTRATION_STATUS_PATH, CHECKPOINT_SNAPSHOT_PATH];
  const before = await Promise.all(trackedRecords.map(relativePath => readFile(path.join(directory, relativePath))));
  const indexPath = String((await git(directory, "rev-parse", "--git-path", "index") as { stdout: string }).stdout).trim();
  const beforeIndex = await readFile(path.resolve(directory, indexPath));

  const explained = await orchestrationStatus({ directory, explain: true });
  const byPath = new Map(explained.delta?.paths.map(item => [item.path, item]));
  assert.equal(byPath.get("committed.txt")?.committed, "modified");
  assert.equal(byPath.get("committed-binary.dat")?.committed, "modified");
  assert.equal(byPath.get("committed-binary.dat")?.binary, true);
  assert.equal(byPath.get("staged.txt")?.staged, "modified");
  assert.equal(byPath.get("unstaged.txt")?.unstaged, "modified");
  assert.equal(byPath.get("deleted.txt")?.unstaged, "deleted");
  assert.equal(byPath.get("renamed.txt")?.staged, "renamed");
  assert.equal(byPath.get("renamed.txt")?.sourcePath, "rename.txt");
  assert.equal(byPath.get("untracked.txt")?.untracked, true);
  assert.equal(byPath.get("untracked-nul.dat")?.untracked, true);
  assert.equal(byPath.get("untracked-nul.dat")?.binary, true);
  assert.equal(byPath.get("binary.dat")?.binary, true);
  const text = formatOrchestrationStatus(explained);
  assert.match(text, /committed modified/);
  assert.match(text, /staged renamed/);
  assert.match(text, /untracked/);
  assert.match(text, /binary/);

  const after = await Promise.all(trackedRecords.map(relativePath => readFile(path.join(directory, relativePath))));
  for (const [index, content] of before.entries()) assert.deepEqual(after[index], content);
  assert.deepEqual(await readFile(path.resolve(directory, indexPath)), beforeIndex);
});

test("status explain retains paths that became clean after a dirty checkpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-resolved-delta-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  const sourcePath = path.join(directory, "source.txt");
  await writeFile(sourcePath, "base\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });
  await writeFile(sourcePath, "accepted dirty\n", "utf8");
  await recordCheckpoint({ directory, message: "accept dirty source" });
  await writeFile(sourcePath, "base\n", "utf8");

  const result = await orchestrationStatus({ directory, explain: true });
  const source = result.delta?.paths.find(item => item.path === "source.txt");
  assert.equal(source?.resolved, true);
  assert.equal(source?.current, undefined);
  assert.equal(source?.checkpoint?.status, " M");
});

test("checkpoint snapshot tampering fails closed", async () => {
  const directory = await temporaryProject();
  const snapshotPath = path.join(directory, CHECKPOINT_SNAPSHOT_PATH);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.entries.push({ status: "??", path: "forged.txt", type: "file", contentHash: `sha256:${"0".repeat(64)}` });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  await assert.rejects(
    orchestrationStatus({ directory, explain: true }),
    error => error instanceof SynodError && error.code === ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID
  );
});

test("checkpoint capture rejects unsafe Git paths before mutating canonical records", async t => {
  if (process.platform === "win32") {
    t.skip("Windows does not permit backslashes in a path component.");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-unsafe-path-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(path.join(directory, "source.txt"), "base\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });
  const recordPaths = [ORCHESTRATION_STATE_PATH, ORCHESTRATION_EVENTS_PATH, ORCHESTRATION_STATUS_PATH, CHECKPOINT_SNAPSHOT_PATH];
  const before = await Promise.all(recordPaths.map(relativePath => readFile(path.join(directory, relativePath))));
  await writeFile(path.join(directory, "unsafe\\name.txt"), "unsafe path\n", "utf8");

  await assert.rejects(
    recordCheckpoint({ directory }),
    error => error instanceof SynodError && error.code === ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID
  );
  const after = await Promise.all(recordPaths.map(relativePath => readFile(path.join(directory, relativePath))));
  for (const [index, content] of before.entries()) assert.deepEqual(after[index], content);
});

test("status explain fails closed when a historical checkpoint has no snapshot", async () => {
  const directory = await temporaryProject();
  const statePath = path.join(directory, ORCHESTRATION_STATE_PATH);
  const eventPath = path.join(directory, ORCHESTRATION_EVENTS_PATH);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  delete state.checkpoint.worktree.snapshot;
  delete event.checkpoint.worktree.snapshot;
  delete event.state.checkpoint.worktree.snapshot;
  event.eventHash = orchestrationEventHash(event);
  state.lastEvent.hash = event.eventHash;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(path.join(directory, ORCHESTRATION_STATUS_PATH), renderStatusMarkdown(state), "utf8");

  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await assert.rejects(
    orchestrationStatus({ directory, explain: true }),
    error => error instanceof SynodError && error.code === ERROR_CODES.CHECKPOINT_SNAPSHOT_UNAVAILABLE
  );
});

test("status explain fails closed when its checkpoint Git base is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-base-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(path.join(directory, "source.txt"), "base\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });
  await writeFile(path.join(directory, "source.txt"), "next\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "advance head");

  await assert.rejects(
    orchestrationStatus({ directory, explain: true }, {
      async gitRunner(targetDirectory, args) {
        if (args[0] === "cat-file" && args[1] === "-e") throw new Error("missing checkpoint base");
        const result = await execFileAsync("git", ["-C", targetDirectory, ...args], { encoding: "utf8" });
        return String(result.stdout);
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE
  );
});

test("status explain treats the first commit after an unborn checkpoint as committed additions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-unborn-head-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await initProject({ directory });
  await writeFile(path.join(directory, "first.txt"), "first commit\n", "utf8");
  await git(directory, "add", "first.txt");
  await git(directory, "commit", "-m", "first commit");

  const result = await orchestrationStatus({ directory, explain: true });
  const first = result.delta?.paths.find(item => item.path === "first.txt");
  assert.equal(first?.committed, "added");
  assert.equal(result.delta?.counts.committed, 1);
});

test("status explain filters committed Synod guidance but retains user-owned guidance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-committed-guidance-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(path.join(directory, "source.txt"), "base\n", "utf8");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });
  await git(directory, "add", "AGENTS.md", ".codex/config.toml");
  await git(directory, "commit", "-m", "commit generated guidance");

  const generatedOnly = await orchestrationStatus({ directory, explain: true });
  assert.equal(generatedOnly.delta?.paths.some(item => item.path === "AGENTS.md"), false);
  assert.equal(generatedOnly.delta?.paths.some(item => item.path === ".codex/config.toml"), false);

  await writeFile(path.join(directory, "AGENTS.md"), `${await readFile(path.join(directory, "AGENTS.md"), "utf8")}\nUser-owned instruction.\n`, "utf8");
  await git(directory, "add", "AGENTS.md");
  await git(directory, "commit", "-m", "add user guidance");
  const withUserGuidance = await orchestrationStatus({ directory, explain: true });
  assert.equal(withUserGuidance.delta?.paths.find(item => item.path === "AGENTS.md")?.committed, "added");
});

test("checkpoint snapshot participates in pending mutation recovery", async () => {
  const directory = await temporaryProject();
  await writeFile(path.join(directory, "proposal.txt"), "recover me\n", "utf8");
  let injected = false;
  const result = await recordCheckpoint({ directory, message: "atomic snapshot" }, {
    transactionHook(operation) {
      if (!injected && operation.path === CHECKPOINT_SNAPSHOT_PATH) {
        injected = true;
        throw new Error("injected checkpoint snapshot failure");
      }
    }
  });

  const snapshot = JSON.parse(await readFile(path.join(directory, CHECKPOINT_SNAPSHOT_PATH), "utf8"));
  assert.equal(snapshot.contentHash, result.state.checkpoint.worktree.snapshot?.contentHash);
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await assert.rejects(readFile(path.join(directory, ".synod/pending-mutation.json"), "utf8"), { code: "ENOENT" });
});

test("checkpoint fingerprints preserve user-owned AGENTS and Codex config content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-guidance-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await mkdir(path.join(directory, ".codex"), { recursive: true });
  const agentsPath = path.join(directory, "AGENTS.md");
  const configPath = path.join(directory, ".codex/config.toml");
  await writeFile(agentsPath, "# Project guidance\n\nKeep releases signed.\n", "utf8");
  await writeFile(configPath, "model = \"project-owned\"\n", "utf8");
  await git(directory, "add", "AGENTS.md", ".codex/config.toml");
  await git(directory, "commit", "-m", "add project guidance");
  await initProject({ directory });

  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  const installedAgents = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, installedAgents.replace("Keep releases signed.", "Skip release signatures."), "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
  await writeFile(agentsPath, installedAgents, "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, true);

  await writeFile(configPath, "model = \"changed-by-user\"\n", "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
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

test("checkpoint fingerprints hash raw binary worktree bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-binary-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  const binaryPath = path.join(directory, "binary.dat");
  await writeFile(binaryPath, Buffer.from([0]));
  await git(directory, "add", "binary.dat");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });

  await writeFile(binaryPath, Buffer.from([0xff]));
  await recordCheckpoint({ directory, message: "Record binary work" });
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await writeFile(binaryPath, Buffer.from([0xfe]));
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
});

test("checkpoint fingerprints hash exact symlink targets", {
  skip: process.platform === "win32" ? "Symlink creation is privilege-dependent on Windows." : false
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-symlink-test-"));
  temporaryDirectories.add(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  const linkPath = path.join(directory, "pointer");
  for (const name of ["target-one", "target-two", "target-three"]) {
    await writeFile(path.join(directory, name), `${name}\n`, "utf8");
  }
  await symlink("target-one", linkPath);
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  await initProject({ directory });

  await unlink(linkPath);
  await symlink("target-two", linkPath);
  await recordCheckpoint({ directory, message: "Record symlink target" });
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await unlink(linkPath);
  await symlink("target-three", linkPath);
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
});

test("checkpoint fingerprints include dirty submodule worktrees", async () => {
  const submodule = await mkdtemp(path.join(os.tmpdir(), "synod-submodule-test-"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-orchestration-submodule-test-"));
  temporaryDirectories.add(submodule);
  temporaryDirectories.add(directory);
  for (const repository of [submodule, directory]) {
    await git(repository, "init");
    await git(repository, "config", "user.name", "Synod Test");
    await git(repository, "config", "user.email", "synod@example.invalid");
    await git(repository, "config", "commit.gpgsign", "false");
  }
  await writeFile(path.join(submodule, "nested.txt"), "initial\n", "utf8");
  await git(submodule, "add", "nested.txt");
  await git(submodule, "commit", "-m", "initial");
  await git(directory, "-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/submodule");
  await git(directory, "commit", "-m", "add submodule");
  await initProject({ directory });

  const nestedPath = path.join(directory, "vendor/submodule/nested.txt");
  await writeFile(nestedPath, "dirty one\n", "utf8");
  await recordCheckpoint({ directory, message: "Record dirty submodule" });
  assert.equal((await orchestrationStatus({ directory })).healthy, true);
  await writeFile(nestedPath, "dirty two\n", "utf8");
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
});

test("stale orchestration locks are reclaimed while live locks fail closed", async () => {
  const directory = await temporaryProject();
  const lockPath = path.join(directory, ".synod/orchestration.lock");
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const stalePid = exited.pid;
  assert.notEqual(stalePid, undefined);
  await once(exited, "exit");
  const staleLock = `${JSON.stringify({
    pid: stalePid,
    token: "stale-owner",
    createdAt: "2026-08-08T00:00:00.000Z"
  })}\n`;
  await writeFile(lockPath, staleLock, "utf8");

  assert.equal((await readOrchestration(directory)).state.schemaVersion, 1);
  await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });

  await writeFile(lockPath, staleLock, "utf8");
  const claimId = createHash("sha256").update(staleLock, "utf8").digest("hex");
  const claimPath = path.join(directory, `.synod/orchestration-reclaim-${claimId}.lock`);
  await link(lockPath, claimPath);
  assert.equal((await readOrchestration(directory)).state.schemaVersion, 1);
  await assert.rejects(readFile(claimPath, "utf8"), { code: "ENOENT" });

  const liveLock = `${JSON.stringify({
    pid: process.pid,
    token: "live-owner",
    createdAt: "2026-08-08T00:00:00.000Z"
  })}\n`;
  await writeFile(lockPath, liveLock, "utf8");
  await assert.rejects(
    readOrchestration(directory),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.ORCHESTRATION_LOCKED
      && isRecord(error.details)
      && error.details.pid === process.pid
  );
  assert.equal(await readFile(lockPath, "utf8"), liveLock);
});

test("an interrupted unpublished lock candidate never blocks orchestration", async () => {
  const directory = await temporaryProject();
  const candidatePath = path.join(directory, ".synod/orchestration-candidate-interrupted.lock");
  await writeFile(candidatePath, "{", "utf8");

  assert.equal((await readOrchestration(directory)).state.schemaVersion, 1);
  assert.equal(await readFile(candidatePath, "utf8"), "{");
});

test("status holds one lock across its canonical snapshot", async () => {
  const directory = await temporaryProject();
  let signalCheckpoint: () => void = () => {};
  let releaseCheckpoint: () => void = () => {};
  const checkpointStarted = new Promise<void>(resolve => { signalCheckpoint = resolve; });
  const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  const statusPromise = orchestrationStatus({ directory }, {
    async gitRunner(_directory, args) {
      assert.deepEqual(args, ["rev-parse", "--is-inside-work-tree"]);
      signalCheckpoint();
      await checkpointGate;
      return "false\n";
    }
  });

  await checkpointStarted;
  await assert.rejects(
    addDefaultTask(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.ORCHESTRATION_LOCKED
  );
  releaseCheckpoint();
  assert.equal((await statusPromise).healthy, true);
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

test("recovery replaces a matching partial event suffix from the pending mutation", async () => {
  const directory = await temporaryProject();
  const statePath = path.join(directory, ORCHESTRATION_STATE_PATH);
  const eventPath = path.join(directory, ORCHESTRATION_EVENTS_PATH);
  const statusPath = path.join(directory, ORCHESTRATION_STATUS_PATH);
  const pendingPath = path.join(directory, ".synod/pending-mutation.json");
  const previousState = await readFile(statePath, "utf8");
  const previousEvents = await readFile(eventPath);
  const previousStatus = await readFile(statusPath, "utf8");

  await addDefaultTask(directory, { objective: "Recuperación atómica 🔒" });
  const nextStateContent = await readFile(statePath, "utf8");
  const nextEvents = await readFile(eventPath);
  const nextStatus = await readFile(statusPath, "utf8");
  const pendingLine = nextEvents.subarray(previousEvents.length, nextEvents.length - 1);
  const event = JSON.parse(pendingLine.toString("utf8"));
  const pending = {
    schemaVersion: 1,
    event,
    state: JSON.parse(nextStateContent),
    status: nextStatus,
    expectedStateHash: contentHash(previousState),
    expectedStatusHash: contentHash(previousStatus)
  };

  await writeFile(statePath, previousState, "utf8");
  await writeFile(statusPath, previousStatus, "utf8");
  const lockEmoji = Buffer.from("🔒", "utf8");
  const emojiOffset = pendingLine.indexOf(lockEmoji);
  assert.ok(emojiOffset > 0);
  await writeFile(eventPath, Buffer.concat([previousEvents, pendingLine.subarray(0, emojiOffset + 1)]));
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");

  const recovered = await readOrchestration(directory);
  assert.equal(recovered.state.lastEvent.sequence, 2);
  assert.equal(recovered.events.length, 2);
  assert.deepEqual(await readFile(eventPath), nextEvents);
  assert.equal(await readFile(statePath, "utf8"), nextStateContent);
  assert.equal(await readFile(statusPath, "utf8"), nextStatus);
  await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
});

test("tampered event logs fail closed", async () => {
  const directory = await temporaryProject();
  const eventPath = path.join(directory, ORCHESTRATION_EVENTS_PATH);
  const events = await readFile(eventPath, "utf8");
  await writeFile(eventPath, events.replace("project.initialized", "project.rewritten"), "utf8");

  await assert.rejects(
    readOrchestration(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.EVENT_LOG_INVALID
  );
});

test("status fails closed when the generated Markdown view diverges from canonical state", async () => {
  const directory = await temporaryProject();
  await writeFile(path.join(directory, ORCHESTRATION_STATUS_PATH), "# Hand-edited status\n", "utf8");

  await assert.rejects(
    orchestrationStatus({ directory }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.ORCHESTRATION_STATE_INVALID
      && isRecord(error.details)
      && error.details.path === ORCHESTRATION_STATUS_PATH
  );
});
