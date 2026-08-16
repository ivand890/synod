import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES } from "../src/errors.js";
import { initProject } from "../src/lifecycle.js";
import { captureGitCheckpointSnapshot, recordCheckpoint } from "../src/orchestration.js";
import { exportRecoveryBundle, verifyRecoveryBundle } from "../src/recovery.js";
import { restoreRecoveryBundle } from "../src/restore.js";
import { compareCheckpointPaths, stableCheckpointStringify } from "../src/checkpoint.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories = new Set<string>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function rewriteManifest(bundle: string, mutate: (manifest: any) => void): Promise<any> {
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  const { bundleId: _bundleId, ...payload } = manifest;
  manifest.bundleId = sha256(Buffer.from(JSON.stringify(stableValue(payload)), "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(stableValue(manifest), null, 2)}\n`);
  return manifest;
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return String(result.stdout);
}

async function fixture(): Promise<{ directory: string; parent: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await writeFile(path.join(directory, "staged.txt"), "staged base\n");
  await writeFile(path.join(directory, "mixed.txt"), "mixed base\n");
  await writeFile(path.join(directory, "deleted.txt"), "delete me\n");
  await writeFile(path.join(directory, "renamed.txt"), "rename me\n");
  await writeFile(path.join(directory, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await initProject({ directory });
  await writeFile(path.join(directory, ".gitignore"), "docs/synod/*.md\n");
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await git(directory, "remote", "add", "origin", "https://example.invalid/synod-recovery.git");

  await writeFile(path.join(directory, "staged.txt"), "staged checkpoint\n");
  await git(directory, "add", "staged.txt");
  await writeFile(path.join(directory, "mixed.txt"), "mixed staged\n");
  await git(directory, "add", "mixed.txt");
  await writeFile(path.join(directory, "mixed.txt"), "mixed worktree\n");
  await unlink(path.join(directory, "deleted.txt"));
  await git(directory, "mv", "renamed.txt", "moved.txt");
  await writeFile(path.join(directory, "binary.dat"), Buffer.from([0, 9, 8, 7, 0]));
  await writeFile(path.join(directory, "untracked.txt"), "untracked checkpoint\n");
  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
  await writeFile(path.join(directory, "AGENTS.md"), `User recovery instruction.\n\n${agents}`);
  if (process.platform !== "win32") await symlink("staged.txt", path.join(directory, "link.txt"));
  await recordCheckpoint({ directory });
  return { directory, parent };
}

async function cloneBase(source: string, parent: string, name: string): Promise<string> {
  const destination = path.join(parent, name);
  await execFileAsync("git", ["clone", "--no-local", source, destination], { encoding: "utf8" });
  await git(destination, "config", "commit.gpgsign", "false");
  return destination;
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("keeps human Synod notes out of checkpoint bundles unless local-doc opt-in is explicit", async () => {
  const { directory, parent } = await fixture();
  const defaultBundle = path.join(parent, "default.bundle");
  const portableBundle = path.join(parent, "portable.bundle");
  await writeFile(path.join(directory, "docs/synod/GOAL.md"), "Private goal with no release authority.\n");
  await writeFile(path.join(directory, "docs/synod/STATE.md"), "Private state note.\n");
  const before = await captureGitCheckpointSnapshot(directory);

  const ordinary = await exportRecoveryBundle({ directory, destination: defaultBundle, includeUntracked: true });
  assert.equal(ordinary.manifest.supplemental, undefined);
  assert.equal((await captureGitCheckpointSnapshot(directory)).checkpoint.worktree.fingerprint, before.checkpoint.worktree.fingerprint);

  const portable = await exportRecoveryBundle({
    directory,
    destination: portableBundle,
    includeUntracked: true,
    includeLocalDocs: true
  });
  assert.deepEqual(portable.manifest.supplemental?.localDocs.map(item => item.path), [
    "docs/synod/DECISIONS.md",
    "docs/synod/GOAL.md",
    "docs/synod/PLAN.md",
    "docs/synod/STATE.md",
    "docs/synod/WORKLOG.md"
  ]);
  assert.equal(portable.manifest.entries.some(entry => entry.path.startsWith("docs/synod/")), false);
  assert.equal((await verifyRecoveryBundle({ bundle: portableBundle })).manifest.supplemental?.localDocs.length, 5);

  const restoredSkipped = await cloneBase(directory, parent, "restored-local-docs-skipped");
  const skipped = await restoreRecoveryBundle({ bundle: portableBundle, directory: restoredSkipped });
  assert.equal(skipped.localDocsRestored, 0);
  await assert.rejects(readFile(path.join(restoredSkipped, "docs/synod/GOAL.md")), { code: "ENOENT" });

  const restored = await cloneBase(directory, parent, "restored-local-docs");
  const restoredPortable = await restoreRecoveryBundle({ bundle: portableBundle, directory: restored, includeLocalDocs: true });
  assert.equal(restoredPortable.localDocsRestored, 5);
  assert.equal(await readFile(path.join(restored, "docs/synod/GOAL.md"), "utf8"), "Private goal with no release authority.\n");
  assert.equal(await readFile(path.join(restored, "docs/synod/STATE.md"), "utf8"), "Private state note.\n");
  await assert.rejects(readFile(path.join(restored, "docs/synod/STATUS.md")), { code: "ENOENT" });

  const conflicting = await cloneBase(directory, parent, "restored-local-docs-conflicting");
  await mkdir(path.join(conflicting, "docs/synod"), { recursive: true });
  await writeFile(path.join(conflicting, "docs/synod/GOAL.md"), "Conflicting local note.\n");
  await assert.rejects(
    restoreRecoveryBundle({ bundle: portableBundle, directory: conflicting, includeLocalDocs: true }),
    { code: ERROR_CODES.RECOVERY_DESTINATION_DIRTY }
  );
  assert.equal(await readFile(path.join(conflicting, "docs/synod/GOAL.md"), "utf8"), "Conflicting local note.\n");

});

test("skips tracked modified supplemental docs because they already belong to checkpoint entries", async () => {
  const { directory, parent } = await fixture();
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  await writeFile(goalPath, "Tracked baseline note.\n", "utf8");
  await git(directory, "add", "-f", "docs/synod/GOAL.md");
  await git(directory, "commit", "-m", "track goal note");
  await writeFile(goalPath, "Tracked modified note.\n", "utf8");
  await recordCheckpoint({ directory });

  const bundle = path.join(parent, "tracked-modified.bundle");
  const exported = await exportRecoveryBundle({
    directory,
    destination: bundle,
    includeUntracked: true,
    includeLocalDocs: true
  });
  assert.equal(exported.manifest.entries.some(entry => entry.path === "docs/synod/GOAL.md"), true);
  assert.equal(exported.manifest.supplemental?.localDocs.some(item => item.path === "docs/synod/GOAL.md"), false);
  assert.equal((await verifyRecoveryBundle({ bundle })).manifest.supplemental?.localDocs.some(item => item.path === "docs/synod/GOAL.md"), false);
});

test("exports and verifies deterministic mixed dirty-state bundles without changing the source", async () => {
  const { directory, parent } = await fixture();
  const firstDestination = path.join(parent, "first.bundle");
  const secondDestination = path.join(parent, "second.bundle");
  const before = {
    index: await readFile(path.join(directory, ".git/index")),
    status: await git(directory, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    state: await readFile(path.join(directory, ".synod/state.json")),
    events: await readFile(path.join(directory, ".synod/events.jsonl")),
    snapshot: await readFile(path.join(directory, ".synod/checkpoint.json")),
    head: await git(directory, "rev-parse", "HEAD"),
    refs: await git(directory, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    remotes: await git(directory, "remote", "-v")
  };
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: firstDestination }),
    { code: ERROR_CODES.RECOVERY_UNTRACKED_REQUIRED }
  );
  await assert.rejects(readFile(path.join(firstDestination, "manifest.json")), { code: "ENOENT" });

  const first = await exportRecoveryBundle({
    directory,
    destination: firstDestination,
    includeUntracked: true
  });
  const second = await exportRecoveryBundle({
    directory,
    destination: secondDestination,
    includeUntracked: true
  });
  const verified = await verifyRecoveryBundle({ bundle: firstDestination });

  assert.equal(first.bundleId, second.bundleId);
  assert.equal(verified.bundleId, first.bundleId);
  assert.ok(first.entries >= 7);
  assert.ok(first.objects >= 6);
  assert.equal(await readFile(path.join(firstDestination, "manifest.json"), "utf8"), await readFile(path.join(secondDestination, "manifest.json"), "utf8"));
  const firstObjects = await readdir(path.join(firstDestination, "objects"));
  assert.deepEqual(firstObjects.sort(), (await readdir(path.join(secondDestination, "objects"))).sort());
  for (const object of firstObjects) {
    assert.deepEqual(await readFile(path.join(firstDestination, "objects", object)), await readFile(path.join(secondDestination, "objects", object)));
  }
  const agentsEntry = first.manifest.entries.find(entry => entry.path === "AGENTS.md");
  assert.ok(agentsEntry);
  assert.equal(agentsEntry.filtered, true);
  assert.equal(agentsEntry.index[0]?.object, null);
  assert.ok(agentsEntry.worktree.object);
  const agentsMaterial = await readFile(path.join(firstDestination, "objects", agentsEntry.worktree.object.slice("sha256:".length)), "utf8");
  assert.equal(agentsMaterial, "User recovery instruction.\n");
  assert.doesNotMatch(agentsMaterial, /BEGIN SYNOD MANAGED BLOCK/);
  assert.deepEqual(await readFile(path.join(directory, ".git/index")), before.index);
  assert.equal(await git(directory, "status", "--porcelain=v1", "-z", "--untracked-files=all"), before.status);
  assert.deepEqual(await readFile(path.join(directory, ".synod/state.json")), before.state);
  assert.deepEqual(await readFile(path.join(directory, ".synod/events.jsonl")), before.events);
  assert.deepEqual(await readFile(path.join(directory, ".synod/checkpoint.json")), before.snapshot);
  assert.equal(await git(directory, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(directory, "for-each-ref", "--format=%(refname)%00%(objectname)"), before.refs);
  assert.equal(await git(directory, "remote", "-v"), before.remotes);
});

test("verification allows several copy destinations to reference one owned source path", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "copies.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  await rewriteManifest(bundle, manifest => {
    const renamed = manifest.entries.find((entry: any) => entry.status.includes("R") && entry.sourcePath);
    assert.ok(renamed);
    for (const destination of ["copy-a.txt", "copy-b.txt"]) {
      manifest.entries.push({ ...structuredClone(renamed), path: destination, status: "C " });
    }
    manifest.entries.sort((left: any, right: any) => compareCheckpointPaths(
      `${left.path}\0${left.sourcePath || ""}`,
      `${right.path}\0${right.sourcePath || ""}`
    ));
  });

  const verified = await verifyRecoveryBundle({ bundle });
  assert.deepEqual(
    verified.manifest.entries.filter(entry => entry.status === "C ").map(entry => entry.sourcePath),
    ["renamed.txt", "renamed.txt"]
  );
});

test("a recreated staged-rename source overrides the rename's implicit deletion", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-recreated-source-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await writeFile(path.join(directory, "old.txt"), "rename source\n");
  await initProject({ directory });
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await git(directory, "mv", "old.txt", "new.txt");
  await writeFile(path.join(directory, "old.txt"), "recreated source\n");
  await recordCheckpoint({ directory });
  const bundle = path.join(parent, "recreated-source.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "restored-recreated-source");

  await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal(await readFile(path.join(destination, "new.txt"), "utf8"), "rename source\n");
  assert.equal(await readFile(path.join(destination, "old.txt"), "utf8"), "recreated source\n");
  assert.equal(
    await git(destination, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "new.txt", "old.txt"),
    await git(directory, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "new.txt", "old.txt")
  );
});

test("export rejects unsupported Git intent-to-add checkpoints before publication", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-intent-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await initProject({ directory });
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await writeFile(path.join(directory, "future.txt"), "intent bytes\n");
  await git(directory, "add", "-N", "future.txt");
  await recordCheckpoint({ directory });
  const bundle = path.join(parent, "intent.bundle");

  await assert.rejects(
    exportRecoveryBundle({ directory, destination: bundle }),
    { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID }
  );
  await assert.rejects(readFile(path.join(bundle, "manifest.json")), { code: "ENOENT" });
});

test("transactionally restores a mixed dirty checkpoint into an exact clean base", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "restore.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "restored");
  const refsBefore = await git(destination, "for-each-ref", "--format=%(refname)%00%(objectname)");
  const remotesBefore = await git(destination, "remote", "-v");

  const restored = await restoreRecoveryBundle({ bundle, directory: destination });

  assert.equal(restored.destination, await realpath(destination));
  assert.equal(restored.fingerprint, restored.manifest.checkpoint.fingerprint);
  assert.equal(restored.recoveredInterruptedRestore, false);
  assert.equal(
    stableCheckpointStringify((await captureGitCheckpointSnapshot(destination)).snapshot.entries),
    stableCheckpointStringify((await captureGitCheckpointSnapshot(directory)).snapshot.entries)
  );
  assert.equal(
    await git(destination, "ls-files", "--stage", "-z", "--", "."),
    await git(directory, "ls-files", "--stage", "-z", "--", ".")
  );
  for (const relativePath of ["staged.txt", "mixed.txt", "binary.dat", "untracked.txt", "AGENTS.md"]) {
    assert.deepEqual(await readFile(path.join(destination, relativePath)), await readFile(path.join(directory, relativePath)));
  }
  await assert.rejects(readFile(path.join(destination, "deleted.txt")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(destination, "moved.txt"), "utf8"), "rename me\n");
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(destination, "link.txt"))).isSymbolicLink(), true);
    assert.equal(await readlink(path.join(destination, "link.txt")), "staged.txt");
  }
  assert.equal(await git(destination, "for-each-ref", "--format=%(refname)%00%(objectname)"), refsBefore);
  assert.equal(await git(destination, "remote", "-v"), remotesBefore);
  await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
});

test("restore computes native blob identities for SHA-256 Git repositories", async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-sha256-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await writeFile(path.join(directory, "tracked.txt"), "base\n");
  await initProject({ directory });
  try {
    await git(directory, "init", "--object-format=sha256");
  } catch {
    t.skip("Installed Git does not support SHA-256 repositories.");
    return;
  }
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await writeFile(path.join(directory, "tracked.txt"), "sha256 checkpoint\n");
  await git(directory, "add", "tracked.txt");
  await recordCheckpoint({ directory });
  const bundle = path.join(parent, "sha256.bundle");
  await exportRecoveryBundle({ directory, destination: bundle });
  assert.match((await verifyRecoveryBundle({ bundle })).manifest.source.head || "", /^[0-9a-f]{64}$/);
  const destination = await cloneBase(directory, parent, "restored-sha256");

  await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal(await git(destination, "ls-files", "--stage", "tracked.txt"), await git(directory, "ls-files", "--stage", "tracked.txt"));
  assert.equal(await readFile(path.join(destination, "tracked.txt"), "utf8"), "sha256 checkpoint\n");
});

test("restore reproduces an unmerged multi-stage Git index", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-conflict-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await writeFile(path.join(directory, "conflict.txt"), "base\n");
  await initProject({ directory });
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  const primaryBranch = (await git(directory, "symbolic-ref", "--short", "HEAD")).trim();
  await git(directory, "switch", "-c", "side");
  await writeFile(path.join(directory, "conflict.txt"), "side\n");
  await git(directory, "add", "conflict.txt");
  await git(directory, "commit", "-m", "side");
  await git(directory, "switch", primaryBranch);
  await writeFile(path.join(directory, "conflict.txt"), "main\n");
  await git(directory, "add", "conflict.txt");
  await git(directory, "commit", "-m", "main");
  await assert.rejects(execFileAsync("git", ["-C", directory, "merge", "side"], { encoding: "utf8" }));
  await recordCheckpoint({ directory });
  const bundle = path.join(parent, "conflict.bundle");
  await exportRecoveryBundle({ directory, destination: bundle });
  const destination = await cloneBase(directory, parent, "restored-conflict");

  await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal(
    await git(destination, "ls-files", "--stage", "-z", "conflict.txt"),
    await git(directory, "ls-files", "--stage", "-z", "conflict.txt")
  );
  assert.deepEqual(await readFile(path.join(destination, "conflict.txt")), await readFile(path.join(directory, "conflict.txt")));
});

test("restore preserves an unstaged executable-mode change", {
  skip: process.platform === "win32" ? "Windows Git does not expose POSIX executable modes." : false
}, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-mode-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await writeFile(path.join(directory, "tool.sh"), "#!/bin/sh\nexit 0\n");
  await initProject({ directory });
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await chmod(path.join(directory, "tool.sh"), 0o755);
  await recordCheckpoint({ directory });
  const bundle = path.join(parent, "mode.bundle");
  await exportRecoveryBundle({ directory, destination: bundle });
  const destination = await cloneBase(directory, parent, "restored-mode");

  await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal((await lstat(path.join(destination, "tool.sh"))).mode & 0o111, 0o111);
  assert.equal(await git(destination, "ls-files", "--stage", "tool.sh"), await git(directory, "ls-files", "--stage", "tool.sh"));
});

async function gitPathForTest(directory: string, name: string): Promise<string> {
  const result = (await git(directory, "rev-parse", "--git-path", name)).trim();
  return path.isAbsolute(result) ? result : path.resolve(directory, result);
}

test("restore refuses the wrong base and dirty destinations before mutation", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "precondition.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });

  const wrongBase = await cloneBase(directory, parent, "wrong-base");
  await writeFile(path.join(wrongBase, "later.txt"), "later\n");
  await git(wrongBase, "add", "later.txt");
  await git(wrongBase, "config", "user.email", "synod@example.test");
  await git(wrongBase, "config", "user.name", "Synod Test");
  await git(wrongBase, "commit", "-m", "later");
  const wrongIndex = await readFile(await gitPathForTest(wrongBase, "index"));
  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: wrongBase }),
    { code: ERROR_CODES.RECOVERY_BASE_MISMATCH }
  );
  assert.deepEqual(await readFile(await gitPathForTest(wrongBase, "index")), wrongIndex);

  const dirty = await cloneBase(directory, parent, "dirty");
  await writeFile(path.join(dirty, "staged.txt"), "destination dirt\n");
  const dirtyIndex = await readFile(await gitPathForTest(dirty, "index"));
  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: dirty }),
    { code: ERROR_CODES.RECOVERY_DESTINATION_DIRTY }
  );
  assert.equal(await readFile(path.join(dirty, "staged.txt"), "utf8"), "destination dirt\n");
  assert.deepEqual(await readFile(await gitPathForTest(dirty, "index")), dirtyIndex);
});

test("restore rejects an irreproducible declared fingerprint before destination mutation", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "wrong-fingerprint.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  await rewriteManifest(bundle, manifest => {
    manifest.checkpoint.fingerprint = `sha256:${"0".repeat(64)}`;
  });
  const destination = await cloneBase(directory, parent, "wrong-fingerprint");
  const indexPath = await gitPathForTest(destination, "index");
  const beforeIndex = await readFile(indexPath);
  const beforeTracked = await readFile(path.join(destination, "staged.txt"));

  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: destination }),
    { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID }
  );
  assert.deepEqual(await readFile(indexPath), beforeIndex);
  assert.deepEqual(await readFile(path.join(destination, "staged.txt")), beforeTracked);
  await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
});

test("failures at every restore mutation boundary roll back exact index and filesystem bytes", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "rollback.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  for (const failurePhase of [
    "before-index-install", "after-index", "before-path-install", "after-path", "before-verify"
  ] as const) {
    const destination = await cloneBase(directory, parent, `rollback-${failurePhase}`);
    const indexPath = await gitPathForTest(destination, "index");
    const before = {
      index: await readFile(indexPath),
      indexMode: (await lstat(indexPath)).mode & 0o777,
      status: await git(destination, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
      staged: await readFile(path.join(destination, "staged.txt")),
      mixed: await readFile(path.join(destination, "mixed.txt")),
      deleted: await readFile(path.join(destination, "deleted.txt")),
      renamed: await readFile(path.join(destination, "renamed.txt")),
      agents: await readFile(path.join(destination, "AGENTS.md"))
    };
    let paths = 0;
    await assert.rejects(
      restoreRecoveryBundle({ bundle, directory: destination }, {
        restoreHook(phase) {
          if (phase === failurePhase && (!["before-path-install", "after-path"].includes(phase) || ++paths === 3)) {
            throw new Error(`injected ${failurePhase} restore failure`);
          }
        }
      }),
      (error: any) => {
        assert.equal(error?.code, ERROR_CODES.RECOVERY_RESTORE_FAILED, `${failurePhase}: ${JSON.stringify(error?.details)}`);
        return true;
      }
    );

    assert.deepEqual(await readFile(indexPath), before.index, failurePhase);
    assert.equal((await lstat(indexPath)).mode & 0o777, before.indexMode, failurePhase);
    assert.equal(await git(destination, "status", "--porcelain=v1", "-z", "--untracked-files=all"), before.status, failurePhase);
    assert.deepEqual(await readFile(path.join(destination, "staged.txt")), before.staged, failurePhase);
    assert.deepEqual(await readFile(path.join(destination, "mixed.txt")), before.mixed, failurePhase);
    assert.deepEqual(await readFile(path.join(destination, "deleted.txt")), before.deleted, failurePhase);
    assert.deepEqual(await readFile(path.join(destination, "renamed.txt")), before.renamed, failurePhase);
    assert.deepEqual(await readFile(path.join(destination, "AGENTS.md")), before.agents, failurePhase);
    await assert.rejects(readFile(path.join(destination, "moved.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(destination, "untracked.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
  }
});

test("a later restore safely rolls back an interrupted durable journal before retrying", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "interrupted.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "interrupted");
  const restoreModule = new URL("../src/restore.ts", import.meta.url).href;
  const script = `
    import { restoreRecoveryBundle } from ${JSON.stringify(restoreModule)};
    await restoreRecoveryBundle(
      { bundle: ${JSON.stringify(bundle)}, directory: ${JSON.stringify(destination)} },
      { restoreHook(phase) { if (phase === "before-index-install") process.exit(77); } }
    );
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" }),
    (error: any) => error?.code === 77
  );
  assert.equal(await pathTypeForTest(await gitPathForTest(destination, "synod-recovery-journal.json")), "file");

  const restored = await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal(restored.recoveredInterruptedRestore, true);
  assert.equal(
    stableCheckpointStringify((await captureGitCheckpointSnapshot(destination)).snapshot.entries),
    stableCheckpointStringify((await captureGitCheckpointSnapshot(directory)).snapshot.entries)
  );
  await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
});

test("a retry finalizes a fully applied interrupted restore without rolling it back", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "fully-applied.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "fully-applied");
  const restoreModule = new URL("../src/restore.ts", import.meta.url).href;
  const script = `
    import { restoreRecoveryBundle } from ${JSON.stringify(restoreModule)};
    await restoreRecoveryBundle(
      { bundle: ${JSON.stringify(bundle)}, directory: ${JSON.stringify(destination)} },
      { restoreHook(phase) { if (phase === "before-verify") process.exit(79); } }
    );
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" }),
    (error: any) => error?.code === 79
  );

  const restored = await restoreRecoveryBundle({ bundle, directory: destination });
  assert.equal(restored.recoveredInterruptedRestore, true);
  assert.equal(
    stableCheckpointStringify((await captureGitCheckpointSnapshot(destination)).snapshot.entries),
    stableCheckpointStringify((await captureGitCheckpointSnapshot(directory)).snapshot.entries)
  );
  await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
});

test("mode-switch retries roll back a fully applied supplemental journal before replanning", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "mode-switch-fully-applied.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true, includeLocalDocs: true });
  const restoreModule = new URL("../src/restore.ts", import.meta.url).href;

  for (const [initialSelection, retrySelection] of [[true, false], [false, true]] as const) {
    const destination = await cloneBase(directory, parent, `mode-switch-fully-applied-${initialSelection ? "on-off" : "off-on"}`);
    const script = `
      import { restoreRecoveryBundle } from ${JSON.stringify(restoreModule)};
      await restoreRecoveryBundle(
        { bundle: ${JSON.stringify(bundle)}, directory: ${JSON.stringify(destination)}, includeLocalDocs: ${initialSelection} },
        { restoreHook(phase) { if (phase === "before-verify") process.exit(81); } }
      );
    `;
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" }),
      (error: any) => error?.code === 81
    );
    const journal = JSON.parse(await readFile(await gitPathForTest(destination, "synod-recovery-journal.json"), "utf8"));
    assert.equal(journal.includeLocalDocs, initialSelection);
    assert.equal(journal.localDocs.length, initialSelection ? 5 : 0);

    const restored = await restoreRecoveryBundle({ bundle, directory: destination, includeLocalDocs: retrySelection });
    assert.equal(restored.localDocsRestored, retrySelection ? 5 : 0);
    if (retrySelection) {
      assert.match(await readFile(path.join(destination, "docs/synod/GOAL.md"), "utf8"), /^# Synod Goal\n/);
    } else {
      await assert.rejects(readFile(path.join(destination, "docs/synod/GOAL.md")), { code: "ENOENT" });
    }
    await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
  }
});

test("mode-switch retries roll back a partial supplemental journal before replanning", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "mode-switch-partial.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true, includeLocalDocs: true });
  const restoreModule = new URL("../src/restore.ts", import.meta.url).href;

  for (const [initialSelection, retrySelection] of [[true, false], [false, true]] as const) {
    const destination = await cloneBase(directory, parent, `mode-switch-partial-${initialSelection ? "on-off" : "off-on"}`);
    const script = `
      import { restoreRecoveryBundle } from ${JSON.stringify(restoreModule)};
      await restoreRecoveryBundle(
        { bundle: ${JSON.stringify(bundle)}, directory: ${JSON.stringify(destination)}, includeLocalDocs: ${initialSelection} },
        { restoreHook(phase) { if (phase === "after-path") process.exit(82); } }
      );
    `;
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" }),
      (error: any) => error?.code === 82
    );
    const journal = JSON.parse(await readFile(await gitPathForTest(destination, "synod-recovery-journal.json"), "utf8"));
    assert.equal(journal.includeLocalDocs, initialSelection);
    assert.equal(journal.localDocs.length, initialSelection ? 5 : 0);

    const restored = await restoreRecoveryBundle({ bundle, directory: destination, includeLocalDocs: retrySelection });
    assert.equal(restored.localDocsRestored, retrySelection ? 5 : 0);
    if (retrySelection) {
      assert.match(await readFile(path.join(destination, "docs/synod/GOAL.md"), "utf8"), /^# Synod Goal\n/);
    } else {
      await assert.rejects(readFile(path.join(destination, "docs/synod/GOAL.md")), { code: "ENOENT" });
    }
    await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
  }
});

test("interrupted rollback preserves concurrent path content and its durable journal", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "concurrent-interrupted.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "concurrent-interrupted");
  const restoreModule = new URL("../src/restore.ts", import.meta.url).href;
  const script = `
    import { restoreRecoveryBundle } from ${JSON.stringify(restoreModule)};
    await restoreRecoveryBundle(
      { bundle: ${JSON.stringify(bundle)}, directory: ${JSON.stringify(destination)} },
      { restoreHook(phase) { if (phase === "after-path") process.exit(78); } }
    );
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" }),
    (error: any) => error?.code === 78
  );
  await writeFile(path.join(destination, "AGENTS.md"), "Concurrent user content.\n");

  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: destination }),
    { code: ERROR_CODES.RECOVERY_ROLLBACK_FAILED }
  );
  assert.equal(await readFile(path.join(destination, "AGENTS.md"), "utf8"), "Concurrent user content.\n");
  assert.equal(await pathTypeForTest(await gitPathForTest(destination, "synod-recovery-journal.json")), "file");
});

test("restore does not overwrite a path changed at its installation boundary", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "concurrent-install.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "concurrent-install");
  const concurrent = "Concurrent boundary content.\n";

  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: destination }, {
      async restoreHook(phase, relativePath) {
        if (phase === "before-path-install" && relativePath === "AGENTS.md") {
          await writeFile(path.join(destination, relativePath), concurrent);
        }
      }
    }),
    { code: ERROR_CODES.RECOVERY_ROLLBACK_FAILED }
  );
  assert.equal(await readFile(path.join(destination, "AGENTS.md"), "utf8"), concurrent);
  assert.equal(await pathTypeForTest(await gitPathForTest(destination, "synod-recovery-journal.json")), "file");
});

test("restore holds Git's index lock across its final index installation boundary", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "concurrent-index.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  const destination = await cloneBase(directory, parent, "concurrent-index");
  const indexPath = await gitPathForTest(destination, "index");
  const beforeIndex = await readFile(indexPath);
  const concurrentPath = path.join(destination, "concurrent-index.txt");
  let writerRejected = false;

  await assert.rejects(
    restoreRecoveryBundle({ bundle, directory: destination }, {
      async restoreHook(phase) {
        if (phase !== "before-index-install") return;
        await writeFile(concurrentPath, "concurrent index content\n");
        try {
          await git(destination, "add", "concurrent-index.txt");
        } catch (error) {
          writerRejected = true;
          throw error;
        }
      }
    }),
    { code: ERROR_CODES.RECOVERY_RESTORE_FAILED }
  );
  assert.equal(writerRejected, true);
  assert.deepEqual(await readFile(indexPath), beforeIndex);
  assert.equal(await readFile(concurrentPath, "utf8"), "concurrent index content\n");
  assert.match(await git(destination, "status", "--porcelain=v1", "--untracked-files=all"), /^\?\? concurrent-index\.txt$/m);
  await assert.rejects(readFile(await gitPathForTest(destination, "synod-recovery-journal.json")), { code: "ENOENT" });
});

async function pathTypeForTest(candidate: string): Promise<string> {
  try {
    const stats = await lstat(candidate);
    return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

test("refuses existing destinations, checkpoint drift, and destinations inside the source", async () => {
  const { directory, parent } = await fixture();
  const destination = path.join(parent, "existing.bundle");
  await mkdir(destination);
  await assert.rejects(
    exportRecoveryBundle({ directory, destination, includeUntracked: true }),
    { code: ERROR_CODES.RECOVERY_DESTINATION_EXISTS }
  );
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: path.join(directory, "inside.bundle"), includeUntracked: true }),
    { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID }
  );
  await writeFile(path.join(directory, "staged.txt"), "drifted after checkpoint\n");
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: path.join(parent, "drift.bundle"), includeUntracked: true }),
    { code: ERROR_CODES.CHECKPOINT_DRIFT }
  );
});

test("refuses canonical destination aliases and an atomically raced destination", {
  skip: process.platform === "win32" ? "Windows symlink creation requires elevated privileges." : false
}, async () => {
  const { directory, parent } = await fixture();
  const alias = path.join(parent, "project-alias");
  await symlink(directory, alias);
  const aliasedDestination = path.join(alias, ".synod", "inside.bundle");
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: aliasedDestination, includeUntracked: true }),
    { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID }
  );

  const racedDestination = path.join(parent, "raced-destination.bundle");
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: racedDestination, includeUntracked: true }, {
      async beforePublish(destination) {
        await mkdir(destination);
      }
    }),
    { code: ERROR_CODES.RECOVERY_DESTINATION_EXISTS }
  );
  assert.deepEqual(await readdir(racedDestination), []);

  const outputParent = path.join(parent, "replaceable-output");
  const movedParent = path.join(parent, "moved-output");
  const redirectedDestination = path.join(outputParent, "redirected.bundle");
  await mkdir(outputParent);
  await assert.rejects(
    exportRecoveryBundle({ directory, destination: redirectedDestination, includeUntracked: true }, {
      async beforePublish() {
        await rename(outputParent, movedParent);
        await symlink(path.join(directory, ".synod"), outputParent);
      }
    }),
    { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID }
  );
  await assert.rejects(readFile(path.join(directory, ".synod", "redirected.bundle", "manifest.json")), { code: "ENOENT" });
});

test("fails closed when source bytes race export materialization", async () => {
  const { directory, parent } = await fixture();
  const destination = path.join(parent, "raced.bundle");
  let mutated = false;
  const rawGitRunner = async (gitDirectory: string, args: string[]): Promise<Buffer> => {
    const result = await new Promise<Buffer>((resolve, reject) => {
      execFile("git", ["-C", gitDirectory, ...args], { encoding: "buffer" }, (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      });
    });
    if (!mutated && args[0] === "ls-files") {
      mutated = true;
      await writeFile(path.join(directory, "mixed.txt"), "raced worktree bytes\n");
    }
    return result;
  };

  await assert.rejects(
    exportRecoveryBundle({ directory, destination, includeUntracked: true }, { rawGitRunner }),
    { code: ERROR_CODES.CHECKPOINT_DRIFT }
  );
  await assert.rejects(readFile(path.join(destination, "manifest.json")), { code: "ENOENT" });
});

test("rejects dirty submodules without creating an incomplete bundle", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-submodule-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  const nested = path.join(directory, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "nested.txt"), "base\n");
  await git(nested, "init");
  await git(nested, "config", "user.email", "synod@example.test");
  await git(nested, "config", "user.name", "Synod Test");
  await git(nested, "config", "commit.gpgsign", "false");
  await git(nested, "add", ".");
  await git(nested, "commit", "-m", "nested base");
  await initProject({ directory });
  await git(directory, "init");
  await git(directory, "config", "user.email", "synod@example.test");
  await git(directory, "config", "user.name", "Synod Test");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  await writeFile(path.join(nested, "nested.txt"), "dirty\n");
  await recordCheckpoint({ directory });
  const destination = path.join(parent, "submodule.bundle");

  await assert.rejects(
    exportRecoveryBundle({ directory, destination }),
    { code: ERROR_CODES.RECOVERY_SUBMODULE_UNSUPPORTED }
  );
  await assert.rejects(readFile(path.join(destination, "manifest.json")), { code: "ENOENT" });
});

test("requires an acknowledged Git HEAD for portable export", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-recovery-no-base-test-"));
  temporaryDirectories.add(parent);
  const directory = path.join(parent, "project");
  await mkdir(directory);
  await initProject({ directory });
  const destination = path.join(parent, "no-base.bundle");

  await assert.rejects(
    exportRecoveryBundle({ directory, destination }),
    { code: ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE }
  );
  await assert.rejects(readFile(path.join(destination, "manifest.json")), { code: "ENOENT" });
});

test("verification rejects tampered objects, extra material, traversal, and symlinked roots without writes", async () => {
  const { directory, parent } = await fixture();
  const canonical = path.join(parent, "canonical.bundle");
  await exportRecoveryBundle({ directory, destination: canonical, includeUntracked: true });

  {
    const target = path.join(parent, "tampered.bundle");
    await cp(canonical, target, { recursive: true });
    const object = (await readdir(path.join(target, "objects"))).sort()[0];
    assert.ok(object);
    await writeFile(path.join(target, "objects", object), "tampered");
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_CORRUPT });
  }

  {
    const target = path.join(parent, "extra.bundle");
    await cp(canonical, target, { recursive: true });
    await writeFile(path.join(target, "objects", "0".repeat(64)), "extra");
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_CORRUPT });
  }

  {
    const target = path.join(parent, "traversal.bundle");
    await cp(canonical, target, { recursive: true });
    const manifestPath = path.join(target, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].path = "../escape";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
    await assert.rejects(readFile(path.join(parent, "escape")), { code: "ENOENT" });
  }

  {
    const target = path.join(parent, "windows-alias.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => { manifest.entries[0].path = "CON.txt"; });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "non-normalized.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => { manifest.entries[0].path = "cafe\u0301.txt"; });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "surrogate-alias.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => { manifest.entries[0].path = "alias\uD800.txt"; });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "ignored-untracked.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => {
      const entry = manifest.entries.find((item: any) => item.path === "AGENTS.md");
      assert.ok(entry);
      entry.status = "??";
      entry.index = [];
      entry.worktree = { type: "ignored", mode: null, object: null };
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "malformed.bundle");
    await cp(canonical, target, { recursive: true });
    await writeFile(path.join(target, "manifest.json"), "{not-json\n");
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "unknown-key.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => { manifest.untrusted = true; });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "missing.bundle");
    await cp(canonical, target, { recursive: true });
    const object = (await readdir(path.join(target, "objects"))).sort()[0];
    assert.ok(object);
    await unlink(path.join(target, "objects", object));
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_CORRUPT });
  }

  {
    const target = path.join(parent, "case-collision.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => {
      const entry = structuredClone(manifest.entries[0]);
      entry.path = String(entry.path).toLocaleUpperCase("en-US");
      manifest.entries.push(entry);
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "parent-collision.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => {
      manifest.entries[0].path = "collision";
      manifest.entries[1].path = "collision/child";
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  {
    const target = path.join(parent, "gitlink-index.bundle");
    await cp(canonical, target, { recursive: true });
    await rewriteManifest(target, manifest => {
      const entry = manifest.entries.find((item: any) => item.index.length > 0);
      assert.ok(entry);
      entry.index[0].mode = "160000";
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  if (process.platform !== "win32") {
    const target = path.join(parent, "unsafe-link.bundle");
    await cp(canonical, target, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
    const linkEntry = manifest.entries.find((entry: any) => entry.worktree.type === "symlink");
    assert.ok(linkEntry);
    const previousHash = linkEntry.worktree.object;
    const unsafeTarget = Buffer.from("../../escape", "utf8");
    const nextHash = sha256(unsafeTarget);
    await writeFile(path.join(target, "objects", nextHash.slice("sha256:".length)), unsafeTarget);
    await unlink(path.join(target, "objects", previousHash.slice("sha256:".length)));
    await rewriteManifest(target, next => {
      next.entries.find((entry: any) => entry.path === linkEntry.path).worktree.object = nextHash;
      next.objects = next.objects
        .filter((object: any) => object.hash !== previousHash)
        .concat({ hash: nextHash, size: unsafeTarget.byteLength })
        .sort((left: any, right: any) => left.hash.localeCompare(right.hash));
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  if (process.platform !== "win32") {
    const target = path.join(parent, "unsafe-index-link.bundle");
    await cp(canonical, target, { recursive: true });
    const unsafeTarget = Buffer.from("../../index-escape", "utf8");
    const nextHash = sha256(unsafeTarget);
    await writeFile(path.join(target, "objects", nextHash.slice("sha256:".length)), unsafeTarget);
    await rewriteManifest(target, manifest => {
      const entry = manifest.entries.find((item: any) => item.index.length > 0 && item.worktree.type === "file");
      assert.ok(entry);
      entry.index[0].mode = "120000";
      entry.index[0].object = nextHash;
      const references = new Set<string>();
      for (const item of manifest.entries) {
        for (const index of item.index) if (index.object) references.add(index.object);
        if (item.worktree.object) references.add(item.worktree.object);
      }
      manifest.objects = manifest.objects
        .filter((object: any) => references.has(object.hash))
        .concat({ hash: nextHash, size: unsafeTarget.byteLength })
        .filter((object: any, index: number, values: any[]) => values.findIndex(item => item.hash === object.hash) === index)
        .sort((left: any, right: any) => left.hash.localeCompare(right.hash));
    });
    await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
  }

  if (process.platform !== "win32") {
    {
      const target = path.join(parent, "linked.bundle");
      await symlink(canonical, target);
      await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
    }

    {
      const target = path.join(parent, "linked-objects.bundle");
      await cp(canonical, target, { recursive: true });
      await rm(path.join(target, "objects"), { recursive: true });
      await symlink(path.join(canonical, "objects"), path.join(target, "objects"));
      await assert.rejects(verifyRecoveryBundle({ bundle: target }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
    }
  }
});

test("proposal identities reject administrative owned paths", async () => {
  const { directory, parent } = await fixture();
  const bundle = path.join(parent, "reserved-proposal.bundle");
  await exportRecoveryBundle({ directory, destination: bundle, includeUntracked: true });
  await rewriteManifest(bundle, manifest => {
    manifest.proposal = {
      taskId: "T-RESERVED",
      leaseId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      baseRevision: 0,
      revision: 1,
      scopes: [{ path: "src/task.ts", access: "write", kind: "file" }],
      ownedPaths: [".git/index"],
      baseline: {
        snapshotHash: manifest.checkpoint.snapshotHash,
        worktreeFingerprint: manifest.checkpoint.fingerprint
      }
    };
  });

  await assert.rejects(verifyRecoveryBundle({ bundle }), { code: ERROR_CODES.RECOVERY_BUNDLE_INVALID });
});
