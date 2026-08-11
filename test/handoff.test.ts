import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES } from "../src/errors.js";
import { formatHandoff, generateHandoff } from "../src/handoff.js";
import { initProject } from "../src/lifecycle.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  acquireTaskLease,
  addTask,
  readOrchestration,
  recordCheckpoint,
  revokeTaskLease,
  transitionTask
} from "../src/orchestration.js";
import { CHECKPOINT_SNAPSHOT_PATH } from "../src/checkpoint.js";
import { exportRecoveryBundle } from "../src/recovery.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
}

async function project(): Promise<{ directory: string; parent: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-handoff-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await git(directory, "init");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "user.email", "synod@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(path.join(directory, "source.txt"), "base\n");
  await git(directory, "add", "source.txt");
  await git(directory, "commit", "-m", "base");
  await initProject({ directory });
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "synod baseline");
  await recordCheckpoint({ directory, message: "Acknowledge Synod baseline" });
  return { directory, parent };
}

async function add(directory: string, id: string, dependsOn: string[] = []): Promise<void> {
  await addTask({
    directory,
    id,
    objective: `Deliver ${id}`,
    executor: "synod_implementer",
    acceptance: [`${id} is accepted`],
    verification: [`verify ${id}`],
    dependsOn
  });
}

async function activate(directory: string, id: string): Promise<void> {
  await transitionTask({ directory, id, to: "READY", revision: 0 });
  await acquireTaskLease({ directory, id, ownerThread: `test:${id}`, write: [`src/${id.toLowerCase()}.ts`] });
  await transitionTask({ directory, id, to: "ACTIVE", revision: 0 });
}

async function reacquire(directory: string, id: string): Promise<void> {
  await acquireTaskLease({ directory, id, ownerThread: `test:${id}`, write: [`src/${id.toLowerCase()}.ts`] });
}

async function review(directory: string, id: string, revision = 1): Promise<void> {
  await transitionTask({ directory, id, to: "REVIEW", revision, evidence: [`delivery:${id}:r${revision}`] });
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("handoff derives focus, current evidence, blockers, gates, and legal transitions from canonical state", async () => {
  const { directory } = await project();
  await add(directory, "T-ACTIVE");
  await activate(directory, "T-ACTIVE");

  await add(directory, "T-CORRECTION");
  await activate(directory, "T-CORRECTION");
  await review(directory, "T-CORRECTION");
  await transitionTask({ directory, id: "T-CORRECTION", to: "ACCEPTED", revision: 1, evidence: ["acceptance:T-CORRECTION:r1"] });
  await reacquire(directory, "T-CORRECTION");
  await transitionTask({ directory, id: "T-CORRECTION", to: "ACTIVE", revision: 1, evidence: ["correction:T-CORRECTION:r1"] });

  await add(directory, "T-REVIEW");
  await activate(directory, "T-REVIEW");
  await review(directory, "T-REVIEW");
  await transitionTask({ directory, id: "T-REVIEW", to: "ACCEPTED", revision: 1, evidence: ["acceptance:T-REVIEW:r1"] });
  await reacquire(directory, "T-REVIEW");
  await transitionTask({ directory, id: "T-REVIEW", to: "ACTIVE", revision: 1, evidence: ["correction:T-REVIEW:r1"] });
  await review(directory, "T-REVIEW", 2);

  await add(directory, "T-ACCEPTED");
  await activate(directory, "T-ACCEPTED");
  await review(directory, "T-ACCEPTED");
  await transitionTask({ directory, id: "T-ACCEPTED", to: "ACCEPTED", revision: 1, evidence: ["acceptance:T-ACCEPTED:r1"] });

  await add(directory, "T-VERIFIED");
  await activate(directory, "T-VERIFIED");
  await review(directory, "T-VERIFIED");
  await transitionTask({ directory, id: "T-VERIFIED", to: "ACCEPTED", revision: 1, evidence: ["acceptance:T-VERIFIED:r1"] });
  await transitionTask({ directory, id: "T-VERIFIED", to: "VERIFIED", revision: 1, evidence: ["verification:T-VERIFIED:r1"] });

  await add(directory, "T-BLOCKED");
  await activate(directory, "T-BLOCKED");
  await transitionTask({ directory, id: "T-BLOCKED", to: "BLOCKED", revision: 0, reason: "Awaiting authorization" });
  await add(directory, "T-RECOVERY");
  await activate(directory, "T-RECOVERY");
  const recoveryLease = (await readOrchestration(directory)).state.tasks["T-RECOVERY"]!.lease!;
  await revokeTaskLease({
    directory,
    id: "T-RECOVERY",
    leaseId: recoveryLease.id,
    generation: recoveryLease.generation,
    revision: 0,
    expectedHeartbeatAt: recoveryLease.heartbeatAt,
    reason: "worker unavailable"
  });
  await add(directory, "T-DEPENDENT", ["T-ACTIVE"]);

  const canonicalPaths = [
    ORCHESTRATION_STATE_PATH,
    ORCHESTRATION_EVENTS_PATH,
    ORCHESTRATION_STATUS_PATH,
    CHECKPOINT_SNAPSHOT_PATH
  ];
  const before = await Promise.all(canonicalPaths.map(relativePath => readFile(path.join(directory, relativePath))));
  const handoff = await generateHandoff({ directory });
  const byId = new Map(handoff.tasks.map(task => [task.id, task]));

  assert.equal(handoff.checkpoint.drift.detected, false);
  assert.equal(handoff.recoveryBundle.status, "not-supplied");
  assert.deepEqual(handoff.focusTaskIds, ["T-ACTIVE", "T-CORRECTION", "T-REVIEW", "T-ACCEPTED", "T-VERIFIED", "T-BLOCKED", "T-RECOVERY"]);
  assert.deepEqual(byId.get("T-CORRECTION")?.evidence.delivery, []);
  assert.deepEqual(byId.get("T-CORRECTION")?.evidence.correction.map(item => item.reference), ["correction:T-CORRECTION:r1"]);
  assert.deepEqual(byId.get("T-CORRECTION")?.evidence.acceptance, []);
  assert.equal(byId.get("T-CORRECTION")?.acceptance.unresolved, true);
  assert.deepEqual(byId.get("T-CORRECTION")?.correctionPolicy, { limit: 2, used: 1, overrides: [] });
  assert.deepEqual(byId.get("T-REVIEW")?.evidence.acceptance, []);
  assert.deepEqual(byId.get("T-REVIEW")?.evidence.delivery.map(item => item.reference), ["delivery:T-REVIEW:r2"]);
  assert.equal(byId.get("T-REVIEW")?.acceptance.unresolved, true);
  assert.match(byId.get("T-REVIEW")?.proposal?.bundleId || "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(byId.get("T-REVIEW")?.proposal?.excludedForeignPaths, []);
  assert.deepEqual(byId.get("T-VERIFIED")?.evidence.verification.map(item => item.reference), ["verification:T-VERIFIED:r1"]);
  assert.deepEqual(byId.get("T-BLOCKED")?.legalNextTransitions, ["ACTIVE", "SUPERSEDED"]);
  assert.equal(byId.get("T-BLOCKED")?.blocker, "Awaiting authorization");
  assert.equal(byId.get("T-RECOVERY")?.recovery?.status, "PENDING");
  assert.equal(byId.get("T-RECOVERY")?.recovery?.endedLease.ownerThread, "test:T-RECOVERY");
  assert.deepEqual(byId.get("T-RECOVERY")?.legalNextTransitions, []);
  assert.deepEqual(byId.get("T-DEPENDENT")?.incompleteDependencies, ["T-ACTIVE"]);
  assert.deepEqual(byId.get("T-DEPENDENT")?.legalNextTransitions, ["BLOCKED", "SUPERSEDED"]);
  assert.match(formatHandoff(handoff), /Synod canonical handoff/);
  assert.match(formatHandoff(handoff), /T-VERIFIED: VERIFIED r1/);
  assert.match(formatHandoff(handoff), /Acceptance criteria: T-VERIFIED is accepted/);
  assert.match(formatHandoff(handoff), /Verification commands: verify T-VERIFIED/);
  assert.match(formatHandoff(handoff), /Correction evidence: E-\d{6}=correction:T-CORRECTION:r1/);
  assert.match(formatHandoff(handoff), /Sealed proposal: sha256:[0-9a-f]{64}/);
  assert.match(formatHandoff(handoff), /Abandoned-owner recovery: PENDING; prior owner test:T-RECOVERY generation 1; proposal not sealed; choices resume, reassign, supersede/);
  assert.match(formatHandoff(handoff), /Recovery bundle: not supplied/);

  const after = await Promise.all(canonicalPaths.map(relativePath => readFile(path.join(directory, relativePath))));
  for (const [index, content] of before.entries()) assert.deepEqual(after[index], content);

  await writeFile(path.join(directory, "docs/synod/PLAN.md"), "User-edited continuation note.\n");
  const afterNoteEdit = await generateHandoff({ directory });
  assert.deepEqual(afterNoteEdit.tasks, handoff.tasks);
  assert.equal(afterNoteEdit.checkpoint.drift.detected, true);
  assert.ok(afterNoteEdit.checkpoint.delta.paths.some(item => item.path === "docs/synod/PLAN.md"));
});

test("handoff verifies and binds a supplied recovery bundle to the canonical checkpoint", async () => {
  const { directory, parent } = await project();
  await writeFile(path.join(directory, "source.txt"), "acknowledged dirty bytes\n");
  await recordCheckpoint({ directory, message: "Accept dirty source" });
  const bundle = path.join(parent, "handoff.bundle");
  await exportRecoveryBundle({ directory, destination: bundle });

  const handoff = await generateHandoff({ directory, bundle });
  assert.equal(handoff.recoveryBundle.status, "verified");
  if (handoff.recoveryBundle.status === "verified") {
    assert.equal(handoff.recoveryBundle.event.sequence, handoff.lastEvent.sequence);
    assert.equal(handoff.recoveryBundle.event.hash, handoff.lastEvent.hash);
    assert.equal(handoff.recoveryBundle.eventMatchesCanonical, true);
    assert.equal(handoff.recoveryBundle.checkpointFingerprint, handoff.checkpoint.acknowledged.worktree.fingerprint);
  }

  await add(directory, "T-LATER");
  const laterHandoff = await generateHandoff({ directory, bundle });
  assert.equal(laterHandoff.recoveryBundle.status, "verified");
  if (laterHandoff.recoveryBundle.status === "verified") {
    assert.equal(laterHandoff.recoveryBundle.eventMatchesCanonical, false);
  }

  await writeFile(path.join(directory, "source.txt"), "new checkpoint bytes\n");
  await recordCheckpoint({ directory, message: "Move beyond exported bundle" });
  await assert.rejects(
    generateHandoff({ directory, bundle }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.RECOVERY_BUNDLE_INVALID);
      return true;
    }
  );
});

test("failed bundle verification awaits handoff status cleanup", async () => {
  const { directory, parent } = await project();
  await assert.rejects(generateHandoff({ directory, bundle: path.join(parent, "missing.bundle") }));
  await add(directory, "T-AFTER-FAILURE");
  const handoff = await generateHandoff({ directory });
  assert.deepEqual(handoff.tasks.map(task => task.id), ["T-AFTER-FAILURE"]);
});
