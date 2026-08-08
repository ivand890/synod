import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES } from "../src/errors.js";
import { applyTransaction, contentHash } from "../src/filesystem.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "../src/lifecycle.js";
import { migrateManifest } from "../src/migrations/index.js";
import { LEGACY_V1_HASHES } from "../src/migrations/legacy-v1-hashes.js";

const temporaryDirectories = new Set();

async function temporaryProject() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-lifecycle-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("initialization rolls back files and directories after a partial failure", async () => {
  const directory = await temporaryProject();

  await assert.rejects(
    initProject({ directory }, {
      transactionHook(_operation, index) {
        if (index === 2) throw new Error("injected failure");
      }
    }),
    error => error.code === ERROR_CODES.TRANSACTION_FAILED
  );

  assert.deepEqual(await readdir(directory), []);
});

test("initialization detects a destination race immediately before mutation", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");

  await assert.rejects(
    initProject({ directory }, {
      async beforeMutationHook(_operation, index) {
        if (index === 0) await writeFile(agentsPath, "concurrent owner\n", "utf8");
      }
    }),
    error => error.code === ERROR_CODES.TRANSACTION_FAILED && error.details.originalCode === ERROR_CODES.DESTINATION_CHANGED
  );

  assert.equal(await readFile(agentsPath, "utf8"), "concurrent owner\n");
  assert.deepEqual(await readdir(directory), ["AGENTS.md"]);
});

test("rollback preserves content changed after an earlier transaction write", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");

  await assert.rejects(
    initProject({ directory }, {
      async transactionHook(_operation, index) {
        if (index === 0) await writeFile(agentsPath, "concurrent owner\n", "utf8");
        if (index === 1) throw new Error("injected failure after concurrent edit");
      }
    }),
    error => error.code === ERROR_CODES.ROLLBACK_FAILED
      && error.details.rollbackFailures.some(item => item.path === "AGENTS.md")
  );

  assert.equal(await readFile(agentsPath, "utf8"), "concurrent owner\n");
});

test("a fresh mutation recheck backs up a concurrently created file", async () => {
  const directory = await temporaryProject();
  const concurrentPath = path.join(directory, "concurrent.txt");

  await assert.rejects(
    applyTransaction(directory, [
      { action: "write", path: "concurrent.txt", content: "managed\n" },
      { action: "write", path: "later.txt", content: "later\n" }
    ], {
      async beforeMutationHook(_operation, index) {
        if (index === 0) await writeFile(concurrentPath, "concurrent owner\n", "utf8");
      },
      transactionHook(_operation, index) {
        if (index === 1) throw new Error("injected later failure");
      }
    }),
    error => error.code === ERROR_CODES.TRANSACTION_FAILED
  );

  assert.equal(await readFile(concurrentPath, "utf8"), "concurrent owner\n");
});

test("check permits user drift and rejects Synod-owned drift", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  await writeFile(path.join(directory, "docs/synod/GOAL.md"), "# My goal\n", "utf8");
  await writeFile(path.join(directory, ".codex/agents/synod-reviewer.toml"), "modified\n", "utf8");

  const result = await checkProject({ directory });

  assert.equal(result.healthy, false);
  assert.equal(result.checks.find(item => item.path === "docs/synod/GOAL.md").status, "modified-user");
  assert.equal(result.checks.find(item => item.path === ".codex/agents/synod-reviewer.toml").status, "modified");
});

test("check rejects inconsistent canonical orchestration records", async () => {
  const directory = await temporaryProject();
  await initProject({ directory });
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  await writeFile(eventsPath, events.replace("project.initialized", "project.tampered"), "utf8");

  const result = await checkProject({ directory });
  const orchestration = result.checks.find(item => item.path === ".synod/orchestration");

  assert.equal(result.healthy, false);
  assert.equal(orchestration.status, "invalid");
  assert.equal(orchestration.severity, "error");
  assert.equal(orchestration.code, ERROR_CODES.EVENT_LOG_INVALID);
});

test("upgrade dry-run is non-mutating and profile changes preserve durable state", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  const configPath = path.join(directory, ".codex/config.toml");
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  await writeFile(goalPath, "# Durable custom goal\n", "utf8");
  const before = await readFile(configPath, "utf8");

  const preview = await upgradeProject({ directory, profile: "synod-5.6", dryRun: true });
  assert.equal(preview.conflicts.length, 0);
  assert.ok(preview.updated.includes(configPath.slice(directory.length + 1).split(path.sep).join("/")));
  assert.equal(await readFile(configPath, "utf8"), before);

  const applied = await upgradeProject({ directory, profile: "synod-5.6" });
  assert.equal(applied.conflicts.length, 0);
  assert.match(await readFile(configPath, "utf8"), /gpt-5\.6-sol/);
  assert.equal(await readFile(goalPath, "utf8"), "# Durable custom goal\n");
  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  assert.equal(manifest.profile, "synod-5.6");
});

test("uninstall removes owned infrastructure and preserves user state and AGENTS content", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");
  const userAgents = "# User rules\n\nKeep me.\n";
  await writeFile(agentsPath, userAgents, "utf8");
  await initProject({ directory, profile: "portable" });
  await writeFile(path.join(directory, "docs/synod/GOAL.md"), "# Keep this goal\n", "utf8");

  const result = await uninstallProject({ directory });

  assert.equal(result.conflicts.length, 0);
  assert.equal(await readFile(agentsPath, "utf8"), userAgents);
  assert.equal(await readFile(path.join(directory, "docs/synod/GOAL.md"), "utf8"), "# Keep this goal\n");
  await assert.rejects(readFile(path.join(directory, ".synod/manifest.json"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(directory, ".agents")), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(directory, ".codex")), { code: "ENOENT" });

  const recordPaths = [
    ".synod/state.json",
    ".synod/events.jsonl",
    "docs/synod/STATUS.md"
  ];
  const recordsBeforeReinstall = await Promise.all(
    recordPaths.map(relativePath => readFile(path.join(directory, relativePath), "utf8"))
  );
  const reinstalled = await initProject({ directory, profile: "portable" });
  assert.equal(reinstalled.conflicts.length, 0);
  assert.deepEqual(
    await Promise.all(recordPaths.map(relativePath => readFile(path.join(directory, relativePath), "utf8"))),
    recordsBeforeReinstall
  );
});

test("uninstall preserves whitespace and trailing spaces outside the managed AGENTS block", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");
  const userAgents = "# A\n\n\n\n# B  \n\n";
  await writeFile(agentsPath, userAgents, "utf8");
  await initProject({ directory, profile: "portable" });

  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  assert.equal(manifest.files.find(item => item.path === "AGENTS.md").separatorBefore, "");

  await uninstallProject({ directory });

  assert.equal(await readFile(agentsPath, "utf8"), userAgents);
});

test("uninstall refuses modified Synod-owned files without removing anything", async () => {
  const directory = await temporaryProject();
  const reviewerPath = path.join(directory, ".codex/agents/synod-reviewer.toml");
  await initProject({ directory, profile: "portable" });
  await writeFile(reviewerPath, "user modification\n", "utf8");

  const result = await uninstallProject({ directory });

  assert.deepEqual(result.conflicts, [".codex/agents/synod-reviewer.toml"]);
  assert.equal(await readFile(reviewerPath, "utf8"), "user modification\n");
  assert.equal(typeof JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8")).profile, "string");
});

test("uninstall reports directory-prune failures after committing removals", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory, profile: "portable" });

  const result = await uninstallProject({ directory }, {
    async pruneEmptyDirectories() {
      throw new Error("injected prune failure");
    }
  });

  assert.ok(result.warnings.some(item => item.code === WARNING_CODES.DIRECTORY_PRUNE_FAILED));
  await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
});

test("schema 1 migration uses published hashes instead of adopting managed drift", async () => {
  const directory = await temporaryProject();
  const configPath = path.join(directory, ".codex/config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  const modified = "# Generated by Synod.\nmodel = \"modified\"\n";
  await writeFile(configPath, modified, "utf8");
  const legacy = { schemaVersion: 1, templateVersion: "0.3.2", method: "advisor-loop" };

  const { manifest, applied } = await migrateManifest(directory, legacy);
  const entry = manifest.files.find(item => item.path === ".codex/config.toml");

  assert.deepEqual(applied, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.equal(entry.contentHash, LEGACY_V1_HASHES["0.3.2"][".codex/config.toml"]);
  assert.notEqual(entry.contentHash, contentHash(modified));
  assert.equal(entry.provenance, "legacy-baseline");
});

test("schema 1 migration records exact or ambiguous AGENTS separators safely", async () => {
  const exactDirectory = await temporaryProject();
  const ambiguousDirectory = await temporaryProject();
  const block = "<!-- synod:start -->\nlegacy\n<!-- synod:end -->";
  await writeFile(path.join(exactDirectory, "AGENTS.md"), `# User\n\n\n${block}\n`, "utf8");
  await writeFile(path.join(ambiguousDirectory, "AGENTS.md"), `# User\n\n${block}\n`, "utf8");
  const legacy = { schemaVersion: 1, templateVersion: "0.3.2", method: "advisor-loop" };

  const exact = await migrateManifest(exactDirectory, legacy);
  const ambiguous = await migrateManifest(ambiguousDirectory, legacy);

  assert.equal(exact.manifest.files.find(item => item.path === "AGENTS.md").separatorBefore, "");
  assert.equal(ambiguous.manifest.files.find(item => item.path === "AGENTS.md").separatorAmbiguous, true);
});

test("schema 2 upgrade creates canonical orchestration records through migration 2 to 3", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory, profile: "portable" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.schemaVersion = 2;
  manifest.templateVersion = "0.4.0";
  manifest.migrations = [];
  manifest.files = manifest.files.filter(entry => entry.ownership !== "record");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(path.join(directory, ".synod/state.json"));
  await rm(path.join(directory, ".synod/events.jsonl"));
  await rm(path.join(directory, "docs/synod/STATUS.md"));

  const result = await upgradeProject({ directory });
  const upgraded = JSON.parse(await readFile(manifestPath, "utf8"));
  const state = JSON.parse(await readFile(path.join(directory, ".synod/state.json"), "utf8"));

  assert.deepEqual(result.migrations, [{ from: 2, to: 3 }]);
  assert.equal(upgraded.schemaVersion, 3);
  assert.ok(upgraded.migrations.some(item => item.from === 2 && item.to === 3));
  assert.equal(upgraded.files.find(entry => entry.path === ".synod/state.json").ownership, "record");
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.lastEvent.sequence, 1);
});

test("uninstall fails closed when a migrated AGENTS separator is ambiguous", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory, profile: "portable" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const agentsEntry = manifest.files.find(item => item.path === "AGENTS.md");
  delete agentsEntry.separatorBefore;
  agentsEntry.separatorAmbiguous = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await uninstallProject({ directory });

  assert.ok(result.conflicts.includes("AGENTS.md"));
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).schemaVersion, 3);
});

test("check refuses a manifest reached through a symbolic-link ancestor", async () => {
  const directory = await temporaryProject();
  const outside = await temporaryProject();
  await writeFile(path.join(outside, "manifest.json"), JSON.stringify({ schemaVersion: 2 }), "utf8");
  await symlink(outside, path.join(directory, ".synod"));

  await assert.rejects(
    checkProject({ directory }),
    error => error.code === ERROR_CODES.UNSAFE_PATH
  );
});

test("uninstall rejects manifest paths outside Synod ownership boundaries", async () => {
  const directory = await temporaryProject();
  const importantPath = path.join(directory, "important.txt");
  const manifestDirectory = path.join(directory, ".synod");
  await mkdir(manifestDirectory);
  await writeFile(importantPath, "keep\n", "utf8");
  await writeFile(path.join(manifestDirectory, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    templateVersion: "0.4.0",
    method: "advisor-loop",
    profile: "portable",
    hashAlgorithm: "sha256",
    migrations: [],
    files: [{ path: "important.txt", ownership: "synod", contentHash: contentHash("keep\n") }]
  }), "utf8");

  await assert.rejects(
    uninstallProject({ directory, force: true }),
    error => error.code === ERROR_CODES.MANIFEST_INVALID
  );
  assert.equal(await readFile(importantPath, "utf8"), "keep\n");
});
