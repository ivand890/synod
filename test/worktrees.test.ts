import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { initProject } from "../src/lifecycle.js";
import { acquireTaskLease, addTask, transitionTask } from "../src/orchestration.js";
import {
  TASK_WORKTREES_PATH,
  createTaskWorktree,
  taskWorktreeStatus,
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
    await assert.rejects(readFile(path.join(fixtureData.control, TASK_WORKTREES_PATH), "utf8"), { code: "ENOENT" });
  }
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
  await assert.rejects(readFile(path.join(moved.control, TASK_WORKTREES_PATH), "utf8"), { code: "ENOENT" });
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
