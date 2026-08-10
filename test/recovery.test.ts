import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ERROR_CODES } from "../src/errors.js";
import { initProject } from "../src/lifecycle.js";
import { recordCheckpoint } from "../src/orchestration.js";
import { exportRecoveryBundle, verifyRecoveryBundle } from "../src/recovery.js";

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

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
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
