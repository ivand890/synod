import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WARNING_CODES } from "../src/contracts.js";
import { stableCheckpointStringify } from "../src/checkpoint.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { applyTransaction, contentHash } from "../src/filesystem.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "../src/lifecycle.js";
import { migrateManifest } from "../src/migrations/index.js";
import { LEGACY_V1_HASHES } from "../src/migrations/legacy-v1-hashes.js";
import { packageName, packageVersion } from "../src/package.js";
import {
  acquireTaskLease,
  addTask,
  orchestrationStatus,
  readOrchestration,
  renderStatusMarkdown,
  transitionTask
} from "../src/orchestration.js";
import { isRecord } from "../src/validation.js";
import { TASK_WORKTREES_PATH, validateTaskWorktreeRegistry } from "../src/worktrees.js";

const temporaryDirectories = new Set<string>();
const execFileAsync = promisify(execFile);

async function initializeGitHead(directory: string): Promise<void> {
  await execFileAsync("git", ["-C", directory, "init", "--quiet"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Synod Tests"]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "synod-tests@example.invalid"]);
  await execFileAsync("git", ["-C", directory, "add", "."]);
  await execFileAsync("git", ["-C", directory, "commit", "--quiet", "-m", "fixture"]);
}

async function temporaryProject(): Promise<string> {
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
    error => error instanceof SynodError && error.code === ERROR_CODES.TRANSACTION_FAILED
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
    error => error instanceof SynodError
      && error.code === ERROR_CODES.TRANSACTION_FAILED
      && isRecord(error.details)
      && error.details.originalCode === ERROR_CODES.DESTINATION_CHANGED
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
    error => error instanceof SynodError
      && error.code === ERROR_CODES.ROLLBACK_FAILED
      && isRecord(error.details)
      && Array.isArray(error.details.rollbackFailures)
      && error.details.rollbackFailures.some(item => isRecord(item) && item.path === "AGENTS.md")
  );

  assert.equal(await readFile(agentsPath, "utf8"), "concurrent owner\n");
});

test("rollback recognizes unchanged Buffer writes by their persisted text hash", async () => {
  const directory = await temporaryProject();
  const originalPath = path.join(directory, "original.txt");
  await writeFile(originalPath, "original\n", "utf8");

  await assert.rejects(
    applyTransaction(directory, [
      { action: "write", path: "original.txt", content: Buffer.from("managed\n", "utf8") },
      { action: "write", path: "later.txt", content: "later\n" }
    ], {
      transactionHook(_operation, index) {
        if (index === 1) throw new Error("injected failure after Buffer write");
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.TRANSACTION_FAILED
  );

  assert.equal(await readFile(originalPath, "utf8"), "original\n");
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
    error => error instanceof SynodError && error.code === ERROR_CODES.TRANSACTION_FAILED
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
  assert.equal(result.checks.find(item => item.path === "docs/synod/GOAL.md")?.status, "modified-user");
  assert.equal(result.checks.find(item => item.path === ".codex/agents/synod-reviewer.toml")?.status, "modified");
});

test("check rejects inconsistent canonical orchestration records", async () => {
  const directory = await temporaryProject();
  await initProject({ directory });
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  await writeFile(eventsPath, events.replace("project.initialized", "project.tampered"), "utf8");

  const result = await checkProject({ directory });
  const orchestration = result.checks.find(item => item.path === ".synod/orchestration");
  assert.ok(orchestration);

  assert.equal(result.healthy, false);
  assert.equal(orchestration.status, "invalid");
  assert.equal(orchestration.severity, "error");
  assert.equal(orchestration.code, ERROR_CODES.EVENT_LOG_INVALID);
});

test("fresh projects record and validate the durable task worktree registry", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  const registryPath = path.join(directory, TASK_WORKTREES_PATH);
  const registry = validateTaskWorktreeRegistry(JSON.parse(await readFile(registryPath, "utf8")));

  assert.equal(manifest.files.find((entry: { path?: unknown }) => entry.path === TASK_WORKTREES_PATH)?.ownership, "record");
  assert.deepEqual(registry.records, []);
  const healthy = await checkProject({ directory });
  assert.equal(healthy.checks.find(item => item.path === ".synod/task-worktrees")?.status, "valid");

  await writeFile(registryPath, `${JSON.stringify({ ...registry, schemaVersion: 99 }, null, 2)}\n`);
  const tampered = await checkProject({ directory });
  assert.equal(tampered.healthy, false);
  assert.equal(tampered.checks.find(item => item.path === ".synod/task-worktrees")?.status, "invalid");
  assert.equal(tampered.checks.find(item => item.path === ".synod/task-worktrees")?.code, ERROR_CODES.WORKTREE_INVALID);
});

test("init dry-run refuses pending orchestration recovery without writing", async () => {
  const directory = await temporaryProject();
  await initProject({ directory });
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  const pendingPath = path.join(directory, ".synod/pending-mutation.json");
  const stateContent = await readFile(statePath, "utf8");
  const eventsContent = await readFile(eventsPath, "utf8");
  const statusContent = await readFile(statusPath, "utf8");
  const eventLine = eventsContent.trimEnd().split("\n").at(-1);
  assert.ok(eventLine);
  const event = JSON.parse(eventLine);
  const pendingContent = `${JSON.stringify({
    schemaVersion: 1,
    event,
    state: JSON.parse(stateContent),
    status: statusContent,
    expectedStateHash: contentHash(stateContent),
    expectedStatusHash: contentHash(statusContent)
  }, null, 2)}\n`;
  await writeFile(pendingPath, pendingContent, "utf8");
  await unlink(path.join(directory, ".synod/manifest.json"));

  await assert.rejects(
    initProject({ directory, dryRun: true }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.ORCHESTRATION_STATE_INVALID
      && isRecord(error.details)
      && error.details.path === ".synod/pending-mutation.json"
  );

  assert.equal(await readFile(statePath, "utf8"), stateContent);
  assert.equal(await readFile(eventsPath, "utf8"), eventsContent);
  assert.equal(await readFile(statusPath, "utf8"), statusContent);
  assert.equal(await readFile(pendingPath, "utf8"), pendingContent);
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

test("upgrade creates the v0.8 worktree registry and rejects template downgrade", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const registryPath = path.join(directory, TASK_WORKTREES_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.templateVersion = "0.7.0";
  manifest.files = manifest.files.filter((entry: { path?: unknown }) => entry.path !== TASK_WORKTREES_PATH);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await unlink(registryPath);

  const upgraded = await upgradeProject({ directory, profile: "portable" });
  assert.ok(upgraded.created.includes(TASK_WORKTREES_PATH));
  assert.deepEqual(validateTaskWorktreeRegistry(JSON.parse(await readFile(registryPath, "utf8"))).records, []);

  const newer = JSON.parse(await readFile(manifestPath, "utf8"));
  newer.templateVersion = "9.0.0";
  await writeFile(manifestPath, `${JSON.stringify(newer, null, 2)}\n`);
  await assert.rejects(
    upgradeProject({ directory, profile: "portable" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.DOWNGRADE_UNSUPPORTED
  );
});

test("init recommends an upgrade for the validated project and requested profile", async () => {
  const parent = await temporaryProject();
  const directory = path.join(parent, "project with spaces");
  await mkdir(directory);
  await initProject({ directory, profile: "portable" });

  await assert.rejects(
    initProject({ directory, profile: "synod-5.6" }),
    error => {
      const expected = `pnpm dlx ${packageName}@${packageVersion} upgrade '${directory}' --profile synod-5.6`;
      assert.ok(error instanceof SynodError);
      assert.ok(isRecord(error.details));
      assert.equal(error.code, ERROR_CODES.UPGRADE_REQUIRED);
      assert.equal(error.details.recommendedCommand, expected);
      assert.match(error.message, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
});

test("init renders Windows-compatible quoting in upgrade recovery commands", async () => {
  const parent = await temporaryProject();
  const directory = path.join(parent, "project with spaces");
  await mkdir(directory);
  await initProject({ directory, profile: "portable" });

  await assert.rejects(
    initProject(
      { directory, profile: "synod-5.6" },
      { platform: "win32" }
    ),
    error => {
      const expected = `pnpm dlx ${packageName}@${packageVersion} upgrade "${directory}" --profile synod-5.6`;
      assert.ok(error instanceof SynodError);
      assert.ok(isRecord(error.details));
      assert.equal(error.code, ERROR_CODES.UPGRADE_REQUIRED);
      assert.equal(error.details.recommendedCommand, expected);
      assert.doesNotMatch(error.details.recommendedCommand, /'[^']*'/);
      return true;
    }
  );
});

test("upgrade preserves stale user guidance and emits an explicit repair path", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  const guidancePaths = [
    "docs/synod/DECISIONS.md",
    "docs/synod/PLAN.md",
    "docs/synod/STATE.md"
  ];
  const preservedContent = "Custom project guidance using bare synod commands.\n";
  for (const relativePath of guidancePaths) {
    await writeFile(path.join(directory, relativePath), preservedContent, "utf8");
  }

  const result = await upgradeProject({ directory, profile: "synod-5.6" });

  for (const relativePath of guidancePaths) {
    assert.equal(await readFile(path.join(directory, relativePath), "utf8"), preservedContent);
    const warning = result.warnings.find(item => isRecord(item.details) && item.details.path === relativePath);
    assert.ok(warning);
    assert.ok(isRecord(warning.details));
    assert.equal(warning.code, WARNING_CODES.DURABLE_STATE_PRESERVED);
    assert.equal(warning.details.action, "review-and-update-manually");
    assert.deepEqual(warning.details.currentGuidance, [
      "AGENTS.md",
      ".agents/skills/synod-advisor/SKILL.md"
    ]);
  }
});

test("upgrade regenerates a stale status projection and records its new hash", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  await writeFile(statusPath, "# Stale pre-upgrade status\n", "utf8");

  const upgraded = await upgradeProject({ directory, profile: "portable" });

  assert.ok(upgraded.updated.includes("docs/synod/STATUS.md"));
  const canonical = await readOrchestration(directory);
  const status = await readFile(statusPath, "utf8");
  assert.equal(status, renderStatusMarkdown(canonical.state));
  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  const statusEntry = manifest.files.find((entry: { path?: unknown }) => entry.path === "docs/synod/STATUS.md");
  assert.equal(statusEntry.contentHash, contentHash(status));
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
    ".synod/checkpoint.json",
    ".synod/lease-baselines.json",
    TASK_WORKTREES_PATH,
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
  assert.equal(manifest.files.find((item: { path?: unknown }) => item.path === "AGENTS.md")?.separatorBefore, "");

  await uninstallProject({ directory });

  assert.equal(await readFile(agentsPath, "utf8"), userAgents);
});

test("uninstall preserves immutable sealed proposal material", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  await initializeGitHead(directory);
  await addTask({
    directory,
    id: "T-PROPOSAL",
    objective: "Preserve proposal bytes",
    executor: "synod_implementer",
    acceptance: ["Proposal remains local"],
    verification: ["pnpm test"]
  });
  await transitionTask({ directory, id: "T-PROPOSAL", to: "READY", revision: 0 });
  await acquireTaskLease({
    directory,
    id: "T-PROPOSAL",
    ownerThread: "test:proposal",
    write: ["src/proposal.ts"]
  });
  await transitionTask({ directory, id: "T-PROPOSAL", to: "ACTIVE", revision: 0 });
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "src/proposal.ts"), "proposal\n");
  const delivered = await transitionTask({
    directory,
    id: "T-PROPOSAL",
    to: "REVIEW",
    revision: 1,
    evidence: ["delivery"]
  });
  assert.ok(delivered.task.proposal);
  const manifestPath = path.join(directory, delivered.task.proposal.path, "manifest.json");
  const manifestBefore = await readFile(manifestPath, "utf8");
  const checked = await checkProject({ directory });
  assert.equal(checked.checks.find(item => item.path === ".synod/proposals")?.status, "valid");

  const uninstalled = await uninstallProject({ directory });

  assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
  assert.ok(uninstalled.preserved.includes(".synod/proposals"));
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
  assert.ok(entry);

  assert.deepEqual(applied, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.equal(entry.contentHash, LEGACY_V1_HASHES["0.3.2"]?.[".codex/config.toml"]);
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

  assert.equal(exact.manifest.files.find(item => item.path === "AGENTS.md")?.separatorBefore, "");
  assert.equal(ambiguous.manifest.files.find(item => item.path === "AGENTS.md")?.separatorAmbiguous, true);
});

test("schema 2 upgrade creates canonical orchestration records through migration 2 to 3 and orchestration schema 4", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory, profile: "portable" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.schemaVersion = 2;
  manifest.templateVersion = "0.4.0";
  manifest.migrations = [];
  manifest.files = manifest.files.filter((entry: { ownership?: unknown }) => entry.ownership !== "record");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(path.join(directory, ".synod/state.json"));
  await rm(path.join(directory, ".synod/events.jsonl"));
  await rm(path.join(directory, ".synod/checkpoint.json"));
  await rm(path.join(directory, ".synod/lease-baselines.json"));
  await rm(path.join(directory, "docs/synod/STATUS.md"));

  const result = await upgradeProject({ directory });
  const upgraded = JSON.parse(await readFile(manifestPath, "utf8"));
  const state = JSON.parse(await readFile(path.join(directory, ".synod/state.json"), "utf8"));

  assert.deepEqual(result.migrations, [{ from: 2, to: 3 }]);
  assert.equal(upgraded.schemaVersion, 3);
  assert.ok(upgraded.migrations.some((item: { from?: unknown; to?: unknown }) => item.from === 2 && item.to === 3));
  assert.equal(upgraded.files.find((entry: { path?: unknown }) => entry.path === ".synod/state.json")?.ownership, "record");
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.lastEvent.sequence, 1);
});

test("init adopts and migrates no-manifest schema-1 records without a lease ledger", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const ledgerPath = path.join(directory, ".synod/lease-baselines.json");
  await initProject({ directory, profile: "portable" });

  const currentEvent = JSON.parse((await readFile(eventsPath, "utf8")).trim());
  const legacyCore = structuredClone(currentEvent.state) as Record<string, any>;
  legacyCore.schemaVersion = 1;
  delete legacyCore.leaseBaselines;
  for (const task of Object.values(legacyCore.tasks ?? {}) as Array<Record<string, unknown>>) {
    delete task.correctionPolicy;
    delete task.leaseGeneration;
    delete task.lease;
    delete task.proposal;
    delete task.preLease;
  }
  const legacyEvent = {
    ...currentEvent,
    schemaVersion: 1,
    state: legacyCore
  };
  const unsigned = Object.fromEntries(Object.entries(legacyEvent).filter(([key]) => key !== "eventHash"));
  legacyEvent.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(unsigned), "utf8").digest("hex")}`;
  const legacyState = {
    ...legacyCore,
    lastEvent: {
      sequence: legacyEvent.sequence,
      id: legacyEvent.id,
      hash: legacyEvent.eventHash
    }
  };
  const legacyEventContent = `${JSON.stringify(legacyEvent)}\n`;
  await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, legacyEventContent, "utf8");
  await unlink(manifestPath);
  await unlink(ledgerPath);

  const adopted = await initProject({ directory, profile: "portable" }, {
    clock: () => "2026-08-10T12:30:00.000Z"
  });

  assert.deepEqual(adopted.conflicts, []);
  assert.ok(adopted.created.includes(".synod/lease-baselines.json"));
  assert.ok(adopted.updated.includes(".synod/state.json"));
  assert.ok((await readFile(eventsPath, "utf8")).startsWith(legacyEventContent));
  const canonical = await readOrchestration(directory);
  assert.equal(canonical.state.schemaVersion, 4);
  assert.equal(canonical.events.at(-1)?.type, "orchestration.migrated");
});

test("upgrade preserves the schema-1 event prefix and fences migrated in-flight tasks", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  const ledgerPath = path.join(directory, ".synod/lease-baselines.json");
  await initProject({ directory, profile: "portable" });
  await initializeGitHead(directory);
  await addTask({
    directory,
    id: "T-MIGRATE",
    objective: "Preserve in-flight work",
    executor: "synod_implementer",
    acceptance: ["The old log remains immutable"],
    verification: ["pnpm test"]
  });
  await transitionTask({ directory, id: "T-MIGRATE", to: "READY", revision: 0 });
  await acquireTaskLease({ directory, id: "T-MIGRATE", ownerThread: "legacy-thread", write: ["src/migrate.ts"] });
  await transitionTask({ directory, id: "T-MIGRATE", to: "ACTIVE", revision: 0 });
  await addTask({
    directory,
    id: "T-MIGRATE-REVIEW",
    objective: "Preserve blocked review work",
    executor: "synod_implementer",
    acceptance: ["The migrated review can be blocked and resumed"],
    verification: ["pnpm test"]
  });
  await transitionTask({ directory, id: "T-MIGRATE-REVIEW", to: "READY", revision: 0 });
  await acquireTaskLease({ directory, id: "T-MIGRATE-REVIEW", ownerThread: "legacy-review-thread", write: ["src/review.ts"] });
  await transitionTask({ directory, id: "T-MIGRATE-REVIEW", to: "ACTIVE", revision: 0 });
  await transitionTask({ directory, id: "T-MIGRATE-REVIEW", to: "REVIEW", revision: 1, evidence: ["legacy review delivery"] });

  const stripCore = (source: Record<string, unknown>) => {
    const core = structuredClone(source) as Record<string, any>;
    core.schemaVersion = 1;
    delete core.leaseBaselines;
    delete core.lastEvent;
    for (const task of Object.values(core.tasks ?? {}) as Array<Record<string, unknown>>) {
      delete task.correctionPolicy;
      delete task.leaseGeneration;
      delete task.lease;
      delete task.proposal;
      delete task.preLease;
    }
    return core;
  };
  const currentEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  let previousHash: string | null = null;
  const legacyEvents = currentEvents.map(source => {
    const event = structuredClone(source) as Record<string, any>;
    event.schemaVersion = 1;
    event.previousHash = previousHash;
    event.state = stripCore(event.state);
    const unsigned = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
    event.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(unsigned), "utf8").digest("hex")}`;
    previousHash = event.eventHash;
    return event;
  });
  const currentState = JSON.parse(await readFile(statePath, "utf8"));
  const legacyState = {
    ...stripCore(currentState),
    lastEvent: {
      sequence: legacyEvents.length,
      id: legacyEvents.at(-1)?.id,
      hash: legacyEvents.at(-1)?.eventHash
    }
  };
  const legacyEventContent = `${legacyEvents.map(event => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, legacyEventContent, "utf8");
  await writeFile(statusPath, "# Legacy Synod status\n", "utf8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter((entry: { path?: unknown }) => entry.path !== ".synod/lease-baselines.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await unlink(ledgerPath);

  await writeFile(ledgerPath, "user-owned lease notes\n", "utf8");
  const unmanagedLedger = await upgradeProject({ directory, profile: "portable", dryRun: true }, {
    clock: () => "2026-08-10T13:00:00.000Z"
  });
  assert.ok(unmanagedLedger.conflicts.includes(".synod/lease-baselines.json"));
  assert.equal(await readFile(ledgerPath, "utf8"), "user-owned lease notes\n");
  await unlink(ledgerPath);

  const beforeDryRun = await Promise.all([
    readFile(statePath, "utf8"),
    readFile(eventsPath, "utf8"),
    readFile(manifestPath, "utf8")
  ]);
  const dryRun = await upgradeProject({ directory, profile: "portable", dryRun: true }, {
    clock: () => "2026-08-10T13:00:00.000Z"
  });
  assert.ok(dryRun.updated.includes(".synod/state.json"));
  assert.ok(dryRun.created.includes(".synod/lease-baselines.json"));
  assert.deepEqual(await Promise.all([
    readFile(statePath, "utf8"),
    readFile(eventsPath, "utf8"),
    readFile(manifestPath, "utf8")
  ]), beforeDryRun);

  await assert.rejects(
    upgradeProject({ directory, profile: "portable" }, {
      clock: () => "2026-08-10T13:00:00.000Z",
      transactionHook(operation) {
        if (operation.path === ".synod/state.json") throw new Error("interrupt schema migration");
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.TRANSACTION_FAILED
  );
  assert.deepEqual(await Promise.all([
    readFile(statePath, "utf8"),
    readFile(eventsPath, "utf8"),
    readFile(manifestPath, "utf8")
  ]), beforeDryRun);
  await assert.rejects(readFile(ledgerPath, "utf8"), { code: "ENOENT" });

  const upgraded = await upgradeProject({ directory, profile: "portable" }, {
    clock: () => "2026-08-10T13:00:00.000Z"
  });
  assert.deepEqual(upgraded.conflicts, []);
  const upgradedEventContent = await readFile(eventsPath, "utf8");
  assert.ok(upgradedEventContent.startsWith(legacyEventContent));
  const canonical = await readOrchestration(directory);
  assert.equal(canonical.state.schemaVersion, 4);
  assert.equal(canonical.events.at(-1)?.type, "orchestration.migrated");
  assert.deepEqual(
    canonical.events.slice(-3).map(event => event.payload.preservedEventCount),
    [legacyEvents.length, legacyEvents.length, legacyEvents.length]
  );
  assert.equal(canonical.state.tasks["T-MIGRATE"]?.preLease, true);
  assert.equal(canonical.state.tasks["T-MIGRATE-REVIEW"]?.preLease, true);
  await assert.rejects(
    transitionTask({ directory, id: "T-MIGRATE", to: "REVIEW", revision: 1, evidence: ["legacy delivery"] }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_REQUIRED
  );
  const acquired = await acquireTaskLease({
    directory,
    id: "T-MIGRATE",
    ownerThread: "migrated-thread",
    write: ["src/migrate.ts"]
  });
  assert.equal(acquired.task.preLease, undefined);
  assert.equal(acquired.lease.generation, 1);

  const blockedReview = await transitionTask({
    directory,
    id: "T-MIGRATE-REVIEW",
    to: "BLOCKED",
    revision: 1,
    reason: "Waiting for review input"
  });
  assert.equal(blockedReview.task.blockedFrom, "REVIEW");
  assert.equal(blockedReview.task.preLease, true);
  const acquiredReview = await acquireTaskLease({
    directory,
    id: "T-MIGRATE-REVIEW",
    ownerThread: "migrated-review-thread",
    write: ["src/review.ts"]
  });
  assert.equal(acquiredReview.task.preLease, undefined);
  assert.equal(acquiredReview.lease.generation, 1);
  const resumedReview = await transitionTask({
    directory,
    id: "T-MIGRATE-REVIEW",
    to: "REVIEW",
    revision: 1
  });
  assert.equal(resumedReview.task.state, "REVIEW");

  const postAcquireEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const duplicateBoundary = postAcquireEvents.at(-1);
  duplicateBoundary.type = "orchestration.migrated";
  const duplicateUnsigned = Object.fromEntries(Object.entries(duplicateBoundary).filter(([key]) => key !== "eventHash"));
  duplicateBoundary.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(duplicateUnsigned), "utf8").digest("hex")}`;
  const duplicateState = JSON.parse(await readFile(statePath, "utf8"));
  duplicateState.lastEvent.hash = duplicateBoundary.eventHash;
  await writeFile(eventsPath, `${postAcquireEvents.map(event => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify(duplicateState, null, 2)}\n`, "utf8");
  await assert.rejects(
    readOrchestration(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.EVENT_LOG_INVALID
  );
});

test("upgrade reports malformed canonical state with a stable orchestration code", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "portable" });
  await writeFile(path.join(directory, ".synod/state.json"), "{", "utf8");

  await assert.rejects(
    upgradeProject({ directory, profile: "portable" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.ORCHESTRATION_STATE_INVALID
  );
});

test("upgrade atomically adopts a matching legacy checkpoint snapshot", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  const checkpointPath = path.join(directory, ".synod/checkpoint.json");
  await initProject({ directory, profile: "portable" });

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const event = JSON.parse(await readFile(eventsPath, "utf8"));
  delete state.checkpoint.worktree.snapshot;
  delete event.checkpoint.worktree.snapshot;
  delete event.state.checkpoint.worktree.snapshot;
  const unsignedEvent = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
  event.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(unsignedEvent), "utf8").digest("hex")}`;
  state.lastEvent.hash = event.eventHash;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(statusPath, "# Stale pre-adoption status\n", "utf8");
  await unlink(checkpointPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter((entry: { path?: unknown }) => entry.path !== ".synod/checkpoint.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await upgradeProject({ directory, profile: "portable" });
  const adoptedState = JSON.parse(await readFile(statePath, "utf8"));
  const adoptedEvents = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const snapshot = JSON.parse(await readFile(checkpointPath, "utf8"));

  assert.deepEqual(result.conflicts, []);
  assert.equal(adoptedState.lastEvent.sequence, 2);
  assert.equal(adoptedEvents[1]?.type, "checkpoint.snapshot-adopted");
  assert.equal(adoptedState.checkpoint.worktree.snapshot.path, ".synod/checkpoint.json");
  assert.equal(adoptedState.checkpoint.worktree.snapshot.contentHash, snapshot.contentHash);
  assert.equal(snapshot.worktreeFingerprint, adoptedState.checkpoint.worktree.fingerprint);
  assert.ok(result.updated.includes(".synod/state.json"));
  assert.equal(await readFile(statusPath, "utf8"), renderStatusMarkdown(adoptedState));
});

test("upgrade preserves a drifted legacy checkpoint without creating a mismatched snapshot", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const statePath = path.join(directory, ".synod/state.json");
  const eventsPath = path.join(directory, ".synod/events.jsonl");
  const statusPath = path.join(directory, "docs/synod/STATUS.md");
  const checkpointPath = path.join(directory, ".synod/checkpoint.json");
  await initProject({ directory, profile: "portable" });

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const event = JSON.parse(await readFile(eventsPath, "utf8"));
  delete state.checkpoint.worktree.snapshot;
  delete event.checkpoint.worktree.snapshot;
  delete event.state.checkpoint.worktree.snapshot;
  const historicalFingerprint = `sha256:${"f".repeat(64)}`;
  state.checkpoint.worktree.fingerprint = historicalFingerprint;
  event.checkpoint.worktree.fingerprint = historicalFingerprint;
  event.state.checkpoint.worktree.fingerprint = historicalFingerprint;
  const unsignedEvent = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventHash"));
  event.eventHash = `sha256:${createHash("sha256").update(stableCheckpointStringify(unsignedEvent), "utf8").digest("hex")}`;
  state.lastEvent.hash = event.eventHash;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(statusPath, renderStatusMarkdown(state), "utf8");
  await unlink(checkpointPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter((entry: { path?: unknown }) => entry.path !== ".synod/checkpoint.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await upgradeProject({ directory, profile: "portable" });
  const preservedState = JSON.parse(await readFile(statePath, "utf8"));
  const upgradedManifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.deepEqual(result.conflicts, []);
  assert.equal(preservedState.lastEvent.sequence, 1);
  assert.equal(preservedState.checkpoint.worktree.snapshot, undefined);
  assert.equal(upgradedManifest.files.some((entry: { path?: unknown }) => entry.path === ".synod/checkpoint.json"), false);
  await assert.rejects(readFile(checkpointPath, "utf8"), { code: "ENOENT" });
  assert.equal((await orchestrationStatus({ directory })).healthy, false);
});

test("uninstall fails closed when a migrated AGENTS separator is ambiguous", async () => {
  const directory = await temporaryProject();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory, profile: "portable" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const agentsEntry = manifest.files.find((item: { path?: unknown }) => item.path === "AGENTS.md");
  assert.ok(agentsEntry);
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
    error => error instanceof SynodError && error.code === ERROR_CODES.UNSAFE_PATH
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
    error => error instanceof SynodError && error.code === ERROR_CODES.MANIFEST_INVALID
  );
  assert.equal(await readFile(importantPath, "utf8"), "keep\n");
});
