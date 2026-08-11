import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { stableCheckpointStringify } from "../src/checkpoint.js";
import { initProject } from "../src/lifecycle.js";
import { acquireTaskLease, addTask, releaseTaskLease, transitionTask } from "../src/orchestration.js";
import {
  TASK_WORKTREES_PATH,
  cleanupTaskWorktree,
  createTaskWorktree,
  integrateTaskWorktreeProposal,
  sealTaskWorktreeProposal,
  taskWorktreeStatus,
  validateTaskWorktreeArtifacts,
  validateTaskWorktreeRegistry
} from "../src/worktrees.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synod-worktree-test-"));
  temporaryDirectories.add(root);
  const control = path.join(root, "control");
  await mkdir(control);
  await initProject({ directory: control });
  await git(control, "init", "--quiet");
  await git(control, "config", "user.name", "Synod Tests");
  await git(control, "config", "user.email", "synod-tests@example.invalid");
  await git(control, "config", "commit.gpgsign", "false");
  await writeFile(path.join(control, "source.txt"), "base\n");
  await writeFile(path.join(control, ".gitignore"), "ignored.txt\n");
  await git(control, "add", ".");
  await git(control, "commit", "--quiet", "-m", "fixture");
  await addTask({
    directory: control,
    id: "T-001",
    objective: "Build in an isolated task worktree",
    executor: "synod_implementer",
    acceptance: ["The worktree is exact and detached."],
    verification: ["pnpm test"]
  });
  await transitionTask({ directory: control, id: "T-001", to: "READY", revision: 0 });
  const acquired = await acquireTaskLease({
    directory: control,
    id: "T-001",
    ownerThread: "thread:T-001",
    writeTree: ["src"]
  });
  const lease = acquired.lease;
  return {
    root,
    control,
    lease,
    destination: path.join(root, "task-T-001"),
    options: {
      directory: control,
      taskId: "T-001",
      destination: path.join(root, "task-T-001"),
      leaseId: lease.id,
      generation: lease.generation,
      revision: lease.taskRevision,
      expectedHeartbeatAt: lease.heartbeatAt,
      ownerThread: lease.ownerThread
    }
  };
}

async function activate(directory: string) {
  await transitionTask({ directory, id: "T-001", to: "ACTIVE", revision: 0 });
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("creates an exact detached worktree without moving control Git state", async () => {
  const { control, destination, options } = await fixture();
  const before = {
    head: await git(control, "rev-parse", "HEAD"),
    branch: await git(control, "symbolic-ref", "--short", "HEAD"),
    index: await git(control, "diff", "--cached", "--binary"),
    refs: await git(control, "for-each-ref", "--format=%(refname) %(objectname)")
  };

  const result = await createTaskWorktree(options);
  const registry = validateTaskWorktreeRegistry(JSON.parse(await readFile(path.join(control, TASK_WORKTREES_PATH), "utf8")));

  assert.equal(result.reconciliation, "complete");
  assert.equal(result.record.baseHead, before.head);
  assert.equal(await git(destination, "rev-parse", "HEAD"), before.head);
  await assert.rejects(git(destination, "symbolic-ref", "--short", "HEAD"));
  assert.equal(await git(destination, "status", "--porcelain"), "");
  assert.equal(await git(control, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(control, "symbolic-ref", "--short", "HEAD"), before.branch);
  assert.equal(await git(control, "diff", "--cached", "--binary"), before.index);
  assert.equal(await git(control, "for-each-ref", "--format=%(refname) %(objectname)"), before.refs);
  assert.equal(registry.records.length, 1);
  assert.deepEqual(registry.events.map(event => event.type), ["worktree.create.intent", "worktree.create.completed"]);
  assert.equal((await taskWorktreeStatus({ directory: control, taskId: "T-001" })).reconciliation, "complete");
});

test("rejects existing, in-control, and symlink destinations before registration", async () => {
  for (const destinationKind of ["existing", "inside", "symlink"] as const) {
    const fixtureData = await fixture();
    const destination = destinationKind === "inside"
      ? path.join(fixtureData.control, "nested-worktree")
      : fixtureData.destination;
    if (destinationKind === "existing") await mkdir(destination);
    if (destinationKind === "symlink") {
      const target = path.join(fixtureData.root, "target");
      await mkdir(target);
      await symlink(target, destination);
    }
    await assert.rejects(
      createTaskWorktree({ ...fixtureData.options, destination }),
      error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
    );
    assert.equal(JSON.parse(await readFile(path.join(fixtureData.control, TASK_WORKTREES_PATH), "utf8")).records.length, 0);
  }
});

test("rejects destinations nested in another registered worktree", async () => {
  const data = await fixture();
  const outer = path.join(data.root, "outer-worktree");
  await git(data.control, "worktree", "add", "--detach", outer, "HEAD");
  await assert.rejects(
    createTaskWorktree({ ...data.options, destination: path.join(outer, "nested-worktree") }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );
  assert.equal(await git(outer, "status", "--porcelain"), "");
  assert.equal(JSON.parse(await readFile(path.join(data.control, TASK_WORKTREES_PATH), "utf8")).records.length, 0);
});

test("fails closed when the exact lease fence or control HEAD moves", async () => {
  const stale = await fixture();
  await assert.rejects(
    createTaskWorktree({ ...stale.options, expectedHeartbeatAt: "2020-01-01T00:00:00.000Z" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );

  const moved = await fixture();
  await writeFile(path.join(moved.control, "moved.txt"), "new head\n");
  await git(moved.control, "add", ".");
  await git(moved.control, "commit", "--quiet", "-m", "move control head");
  await assert.rejects(
    createTaskWorktree(moved.options),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );
  assert.equal(JSON.parse(await readFile(path.join(moved.control, TASK_WORKTREES_PATH), "utf8")).records.length, 0);
});

test("resumes an interrupted intent only when both path and registration are absent", async () => {
  const { control, options } = await fixture();
  await assert.rejects(createTaskWorktree(options, {
    worktreeHook(stage) {
      if (stage === "after-intent") throw new Error("simulated stop after intent");
    }
  }), /simulated stop after intent/);

  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.record.creation.status, "INTENT");
  assert.equal(interrupted.reconciliation, "absent_resumable");

  const resumed = await createTaskWorktree(options);
  assert.equal(resumed.record.id, interrupted.record.id);
  assert.equal(resumed.record.creation.status, "COMPLETE");
  assert.equal(resumed.reconciliation, "complete");
});

test("recognizes an exact Git registration after interruption and completes the intent on retry", async () => {
  const { control, destination, options } = await fixture();
  await assert.rejects(createTaskWorktree(options, {
    worktreeHook(stage) {
      if (stage === "after-add") throw new Error("simulated stop after add");
    }
  }), /simulated stop after add/);

  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.record.creation.status, "INTENT");
  assert.equal(interrupted.reconciliation, "complete");
  assert.equal(await git(destination, "status", "--porcelain"), "");

  const resumed = await createTaskWorktree(options);
  assert.equal(resumed.record.id, interrupted.record.id);
  assert.equal(resumed.record.creation.status, "COMPLETE");
});

test("rechecks cleanliness at the completion boundary and preserves an intent on drift", async () => {
  const { control, destination, options } = await fixture();
  await assert.rejects(
    createTaskWorktree(options, {
      async worktreeHook(stage) {
        if (stage === "before-complete") await writeFile(path.join(destination, "source.txt"), "raced\n");
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_RECONCILIATION_REQUIRED
  );
  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.record.creation.status, "INTENT");
  assert.equal(interrupted.reconciliation, "manual_reconciliation");
  assert.ok(interrupted.reasons.includes("interrupted creation worktree is not clean"));
});

test("rechecks lease expiry at the completion boundary", async () => {
  const { control, lease, options } = await fixture();
  const beforeExpiry = new Date(Date.parse(lease.expiresAt) - 1);
  const expired = new Date(lease.expiresAt);
  let calls = 0;
  await assert.rejects(
    createTaskWorktree(options, { clock: () => (++calls >= 3 ? expired : beforeExpiry) }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );
  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.record.creation.status, "INTENT");
  assert.equal(interrupted.reconciliation, "complete");
});

test("rechecks lease expiry before returning an existing completed worktree", async () => {
  const { control, lease, options } = await fixture();
  await createTaskWorktree(options);
  const beforeExpiry = new Date(Date.parse(lease.expiresAt) - 1);
  const expired = new Date(lease.expiresAt);
  let calls = 0;
  await assert.rejects(
    createTaskWorktree(options, { clock: () => (++calls >= 2 ? expired : beforeExpiry) }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );
  assert.equal((await taskWorktreeStatus({ directory: control, taskId: "T-001" })).record.creation.status, "COMPLETE");
});

test("seals and transactionally integrates a scoped proposal while preserving attributed drift", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await activate(control);
  await addTask({
    directory: control,
    id: "T-002",
    objective: "Own disjoint control drift",
    executor: "synod_implementer",
    acceptance: ["Disjoint drift is preserved."],
    verification: ["pnpm test"]
  });
  await transitionTask({ directory: control, id: "T-002", to: "READY", revision: 0 });
  await acquireTaskLease({ directory: control, id: "T-002", ownerThread: "thread:T-002", writeTree: ["other"] });
  await mkdir(path.join(control, "other"));
  await writeFile(path.join(control, "other/owned.txt"), "other task\n");
  await git(control, "add", "other/owned.txt");
  const otherIndex = await git(control, "rev-parse", ":other/owned.txt");
  await mkdir(path.join(destination, "src"));
  await writeFile(path.join(destination, "src/t-001.ts"), "staged proposal\n");
  await git(destination, "add", "src/t-001.ts");
  await writeFile(path.join(destination, "src/t-001.ts"), "staged proposal\nunstaged proposal\n");

  const sealed = await sealTaskWorktreeProposal(options);
  assert.equal(sealed.proposal?.status, "SEALED");
  assert.ok(sealed.proposal?.bundleId);
  const integrated = await integrateTaskWorktreeProposal(options);
  assert.equal(integrated.integration.status, "COMPLETE");
  assert.equal(await readFile(path.join(control, "src/t-001.ts"), "utf8"), "staged proposal\nunstaged proposal\n");
  assert.equal(await git(control, "show", ":src/t-001.ts"), "staged proposal");
  assert.equal(await readFile(path.join(control, "other/owned.txt"), "utf8"), "other task\n");
  assert.equal(await git(control, "rev-parse", ":other/owned.txt"), otherIndex);
  assert.equal((await integrateTaskWorktreeProposal(options)).integration.status, "COMPLETE");
  const reviewed = await transitionTask({
    directory: control,
    id: "T-001",
    to: "REVIEW",
    revision: 1,
    evidence: ["worktree:integrated"]
  });
  assert.equal(reviewed.task.state, "REVIEW");
  assert.equal(reviewed.task.proposal?.fingerprint, integrated.integration.fingerprint);
});

test("integration rejects unowned drift and rolls back ordinary restore failures", async () => {
  const unowned = await fixture();
  await createTaskWorktree(unowned.options);
  await activate(unowned.control);
  await mkdir(path.join(unowned.destination, "src"));
  await writeFile(path.join(unowned.destination, "src/t-001.ts"), "proposal\n");
  await sealTaskWorktreeProposal(unowned.options);
  await writeFile(path.join(unowned.control, "foreign.txt"), "unowned\n");
  await assert.rejects(
    integrateTaskWorktreeProposal(unowned.options),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );
  await assert.rejects(readFile(path.join(unowned.control, "src/t-001.ts"), "utf8"), { code: "ENOENT" });

  const rollback = await fixture();
  await createTaskWorktree(rollback.options);
  await activate(rollback.control);
  await mkdir(path.join(rollback.destination, "src"));
  await writeFile(path.join(rollback.destination, "src/t-001.ts"), "proposal\n");
  await sealTaskWorktreeProposal(rollback.options);
  await assert.rejects(
    integrateTaskWorktreeProposal(rollback.options, {
      restoreHook(phase) {
        if (phase === "before-path-install") throw new Error("simulated integration failure");
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.RECOVERY_RESTORE_FAILED
  );
  await assert.rejects(readFile(path.join(rollback.control, "src/t-001.ts"), "utf8"), { code: "ENOENT" });
  assert.equal((await integrateTaskWorktreeProposal(rollback.options)).integration.status, "COMPLETE");
});

test("reconciles killed integration after restore without applying the proposal twice", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await activate(control);
  await mkdir(path.join(destination, "src"));
  await writeFile(path.join(destination, "src/t-001.ts"), "proposal\n");
  await sealTaskWorktreeProposal(options);
  await assert.rejects(
    integrateTaskWorktreeProposal(options, {
      worktreeHook(stage) {
        if (stage === "after-integration-restore") throw new Error("simulated stop after integration");
      }
    }),
    /simulated stop after integration/
  );
  assert.equal(await readFile(path.join(control, "src/t-001.ts"), "utf8"), "proposal\n");
  const completed = await integrateTaskWorktreeProposal(options);
  assert.equal(completed.integration.status, "COMPLETE");
  assert.equal(await readFile(path.join(control, "src/t-001.ts"), "utf8"), "proposal\n");
});

test("proposal sealing recovers when interrupted before atomic publication", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await activate(control);
  await mkdir(path.join(destination, "src"));
  await writeFile(path.join(destination, "src/t-001.ts"), "proposal\n");
  await assert.rejects(
    sealTaskWorktreeProposal(options, {
      worktreeHook(stage) {
        if (stage === "before-proposal-rename") throw new Error("simulated stop before proposal rename");
      }
    }),
    /simulated stop before proposal rename/
  );
  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.record.proposal?.status, "INTENT");
  await assert.rejects(readFile(path.join(control, interrupted.record.proposal!.path, "manifest.json")), { code: "ENOENT" });
  const sealed = await sealTaskWorktreeProposal(options);
  assert.equal(sealed.proposal?.status, "SEALED");
});

test("integration rechecks checkout contents at the completion boundary", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await activate(control);
  await mkdir(path.join(destination, "src"));
  await writeFile(path.join(destination, "src/t-001.ts"), "proposal\n");
  await sealTaskWorktreeProposal(options);
  await assert.rejects(
    integrateTaskWorktreeProposal(options, {
      async worktreeHook(stage) {
        if (stage === "before-integration-complete") {
          await writeFile(path.join(control, "src/t-001.ts"), "raced after restore\n");
        }
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_RECONCILIATION_REQUIRED
  );
  const status = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(status.record.integration.status, "INTENT");
});

test("completed integration retries revalidate the sealed proposal and control checkout", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await activate(control);
  await mkdir(path.join(destination, "src"));
  await writeFile(path.join(destination, "src/t-001.ts"), "proposal\n");
  await sealTaskWorktreeProposal(options);
  await integrateTaskWorktreeProposal(options);
  await writeFile(path.join(control, "src/t-001.ts"), "changed after integration\n");
  await assert.rejects(
    integrateTaskWorktreeProposal(options),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_RECONCILIATION_REQUIRED
  );
});

test("cleanup is explicit, non-force, interruption-safe, and unblocks a new generation", async () => {
  for (const interruptedStage of ["after-cleanup-intent", "after-cleanup-remove"] as const) {
    const data = await fixture();
    await createTaskWorktree(data.options);
    await assert.rejects(
      cleanupTaskWorktree({ directory: data.control, taskId: "T-001" }, {
        worktreeHook(stage) {
          if (stage === interruptedStage) throw new Error(`simulated ${interruptedStage}`);
        }
      }),
      new RegExp(interruptedStage)
    );
    const cleaned = await cleanupTaskWorktree({ directory: data.control, taskId: "T-001" });
    assert.equal(cleaned.cleanup.status, "COMPLETE");
    await assert.rejects(git(data.destination, "status", "--porcelain"));
  }

  const replacement = await fixture();
  await createTaskWorktree(replacement.options);
  await cleanupTaskWorktree({ directory: replacement.control, taskId: "T-001" });
  await releaseTaskLease({
    directory: replacement.control,
    id: "T-001",
    leaseId: replacement.lease.id,
    generation: replacement.lease.generation,
    revision: replacement.lease.taskRevision,
    expectedHeartbeatAt: replacement.lease.heartbeatAt,
    ownerThread: replacement.lease.ownerThread
  });
  const next = await acquireTaskLease({
    directory: replacement.control,
    id: "T-001",
    ownerThread: "thread:T-001-next",
    writeTree: ["src"]
  });
  const nextDestination = path.join(replacement.root, "task-T-001-next");
  const created = await createTaskWorktree({
    directory: replacement.control,
    taskId: "T-001",
    destination: nextDestination,
    leaseId: next.lease.id,
    generation: next.lease.generation,
    revision: next.lease.taskRevision,
    expectedHeartbeatAt: next.lease.heartbeatAt,
    ownerThread: next.lease.ownerThread
  });
  assert.equal(created.record.generation, replacement.lease.generation + 1);
});

test("cleanup refuses dirty or untracked worktree material", async () => {
  for (const filename of ["untracked.txt", "ignored.txt"]) {
    const { control, destination, options } = await fixture();
    await createTaskWorktree(options);
    await writeFile(path.join(destination, filename), "preserve me\n");
    await assert.rejects(
      cleanupTaskWorktree({ directory: control, taskId: "T-001" }),
      error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
    );
    assert.equal(await readFile(path.join(destination, filename), "utf8"), "preserve me\n");
  }
});

test("cleanup reconciliation preserves unrelated registered worktrees", async () => {
  const { root, control, options } = await fixture();
  await createTaskWorktree(options);
  const unrelated = path.join(root, "unrelated-worktree");
  await git(control, "worktree", "add", "--detach", unrelated, "HEAD");
  await assert.rejects(
    cleanupTaskWorktree({ directory: control, taskId: "T-001" }, {
      worktreeHook(stage) {
        if (stage === "after-cleanup-remove") throw new Error("simulated cleanup stop");
      }
    }),
    /simulated cleanup stop/
  );
  const interrupted = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(interrupted.reconciliation, "absent_resumable");
  assert.equal((await cleanupTaskWorktree({ directory: control, taskId: "T-001" })).cleanup.status, "COMPLETE");
  assert.equal(await git(unrelated, "rev-parse", "HEAD"), await git(control, "rev-parse", "HEAD"));
});

test("completed history rotates before the registry record limit blocks new work", async () => {
  const data = await fixture();
  await createTaskWorktree(data.options);
  await cleanupTaskWorktree({ directory: data.control, taskId: "T-001" });
  const registryPath = path.join(data.control, TASK_WORKTREES_PATH);
  const template = JSON.parse(await readFile(registryPath, "utf8"));
  const records: unknown[] = [];
  const events: any[] = [];
  let previousHash: string | null = null;
  for (let index = 0; index < 128; index += 1) {
    const recordId = randomUUID();
    for (const templateEvent of template.events) {
      const event = structuredClone(templateEvent);
      event.sequence = events.length + 1;
      event.id = randomUUID();
      event.worktreeId = recordId;
      event.previousHash = previousHash;
      event.payload.record.id = recordId;
      const { eventHash: _eventHash, ...core } = event;
      event.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(core), "utf8").digest("hex")}`;
      previousHash = event.eventHash;
      events.push(event);
    }
    records.push(structuredClone(events.at(-1)!.payload.record));
  }
  await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 1, records, events }, null, 2)}\n`);
  await releaseTaskLease({
    directory: data.control,
    id: "T-001",
    leaseId: data.lease.id,
    generation: data.lease.generation,
    revision: data.lease.taskRevision,
    expectedHeartbeatAt: data.lease.heartbeatAt,
    ownerThread: data.lease.ownerThread
  });
  const next = await acquireTaskLease({
    directory: data.control,
    id: "T-001",
    ownerThread: "thread:T-001-next",
    writeTree: ["src"]
  });
  await createTaskWorktree({
    directory: data.control,
    taskId: "T-001",
    destination: path.join(data.root, "task-T-001-next"),
    leaseId: next.lease.id,
    generation: next.lease.generation,
    revision: next.lease.taskRevision,
    expectedHeartbeatAt: next.lease.heartbeatAt,
    ownerThread: next.lease.ownerThread
  });
  const rotated = validateTaskWorktreeRegistry(JSON.parse(await readFile(registryPath, "utf8")));
  assert.equal(rotated.records.length, 128);
  assert.equal(rotated.records.filter(record => record.cleanup.status !== "COMPLETE").length, 1);
  assert.equal(rotated.events[0]?.sequence, 1);
  assert.equal(rotated.events[0]?.previousHash, null);
});

test("pruned worktree history retains and validates every sealed proposal", async () => {
  const data = await fixture();
  await createTaskWorktree(data.options);
  await activate(data.control);
  await mkdir(path.join(data.destination, "src"));
  await writeFile(path.join(data.destination, "src/t-001.ts"), "proposal\n");
  const sealed = await sealTaskWorktreeProposal(data.options);
  await git(data.destination, "reset", "--hard", "HEAD");
  await git(data.destination, "clean", "-fd");
  await cleanupTaskWorktree({ directory: data.control, taskId: "T-001" });

  const registryPath = path.join(data.control, TASK_WORKTREES_PATH);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.sealedProposals.length, 1);
  registry.records = [];
  registry.events = [];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  assert.equal((await validateTaskWorktreeArtifacts({ directory: data.control })).sealedProposals, 1);
  await rm(path.join(data.control, sealed.proposal!.path), { recursive: true });
  await assert.rejects(
    validateTaskWorktreeArtifacts({ directory: data.control }),
    error => error instanceof SynodError && error.code === ERROR_CODES.RECOVERY_BUNDLE_INVALID
  );
});

test("requires manual reconciliation after a registered worktree changes", async () => {
  const { control, destination, options } = await fixture();
  await createTaskWorktree(options);
  await writeFile(path.join(destination, "source.txt"), "dirty\n");
  const status = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(status.reconciliation, "complete");

  await git(destination, "checkout", "--detach", "HEAD~0");
  await git(control, "worktree", "move", destination, `${destination}-moved`);
  const moved = await taskWorktreeStatus({ directory: control, taskId: "T-001" });
  assert.equal(moved.reconciliation, "manual_reconciliation");
  await assert.rejects(
    createTaskWorktree(options),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_RECONCILIATION_REQUIRED
  );
});

test("rejects foreign registrations and tampered registry event hashes", async () => {
  const foreign = await fixture();
  await git(foreign.control, "worktree", "add", "--detach", foreign.destination, "HEAD");
  await rm(foreign.destination, { recursive: true, force: true });
  await assert.rejects(
    createTaskWorktree(foreign.options),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_CONFLICT
  );

  const tampered = await fixture();
  await createTaskWorktree(tampered.options);
  const registryPath = path.join(tampered.control, TASK_WORKTREES_PATH);
  const original = await readFile(registryPath, "utf8");
  const registry = JSON.parse(original);
  registry.records[0].worktreePath = "/tampered-record";
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await assert.rejects(
    taskWorktreeStatus({ directory: tampered.control, taskId: "T-001" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_INVALID
  );

  const eventTamper = JSON.parse(original);
  eventTamper.events[0].payload.path = "/tampered-event";
  await writeFile(registryPath, `${JSON.stringify(eventTamper, null, 2)}\n`);
  await assert.rejects(
    taskWorktreeStatus({ directory: tampered.control, taskId: "T-001" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.WORKTREE_INVALID
  );
});
