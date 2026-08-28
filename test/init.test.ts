import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { initProject } from "../src/init.js";
import { packageVersion } from "../src/package.js";
import { isRecord } from "../src/validation.js";

const temporaryDirectories = new Set<string>();

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

test("initializes a fresh project with durable state, agents, and skill", async () => {
  const directory = await temporaryProject();

  const result = await initProject({ directory });

  assert.equal(result.conflicts.length, 0);
  assert.ok(result.created.includes("AGENTS.md"));
  assert.ok(result.created.includes(".codex/config.toml"));
  assert.ok(result.created.includes(".agents/skills/synod-advisor/SKILL.md"));
  assert.ok(result.created.includes("docs/synod/STATE.md"));

  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /<!-- synod:start -->/);
  assert.match(agents, /\$synod-advisor/);
  assert.ok(agents.includes(`pnpm dlx @ivand890/synod@${packageVersion} status`));
  assert.ok(agents.includes("pnpm dlx @ivand890/synod@<target-version> upgrade [directory]"));
  assert.match(agents, /Golden path: `task add` → `delegate start` → `wait --task`/);
  assert.match(agents, /spawn_agent` with the returned `readOnlyContract/);
  assert.match(agents, /execute the returned `argv`/);
  assert.match(agents, /Do not load README, PRODUCT, ROADMAP, STATE notes/);
  assert.match(agents, /handoff --json --view summary/);
  assert.match(agents, /proposal summary returns a typed exact-revision acceptance action/);
  assert.doesNotMatch(agents, /receipt preserves the exact next-operation lease fence/);

  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.templateVersion, packageVersion);
  assert.equal(manifest.profile, "portable");
  assert.equal(manifest.hashAlgorithm, "sha256");
  const manifestEntry = (item: { path?: unknown }) => item.path;
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === "AGENTS.md")?.ownership, "shared");
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === "docs/synod/GOAL.md")?.ownership, "user");
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === ".synod/state.json")?.ownership, "record");
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === ".synod/events.jsonl")?.ownership, "record");
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === ".synod/checkpoint.json")?.ownership, "record");
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === "docs/synod/STATUS.md")?.ownership, "record");
  assert.match(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === ".codex/config.toml")?.contentHash ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.files.find((item: { path?: unknown }) => manifestEntry(item) === "AGENTS.md")?.separatorBefore, "");

  const expectedFileMode = 0o666 & ~process.umask();
  assert.equal((await stat(path.join(directory, "AGENTS.md"))).mode & 0o777, expectedFileMode);
  assert.equal((await stat(path.join(directory, ".synod/manifest.json"))).mode & 0o777, expectedFileMode);

  const state = JSON.parse(await readFile(path.join(directory, ".synod/state.json"), "utf8"));
  const checkpointSnapshot = JSON.parse(await readFile(path.join(directory, ".synod/checkpoint.json"), "utf8"));
  assert.equal(state.checkpoint.worktree.snapshot.path, ".synod/checkpoint.json");
  assert.equal(state.checkpoint.worktree.snapshot.contentHash, checkpointSnapshot.contentHash);
  assert.equal(checkpointSnapshot.worktreeFingerprint, state.checkpoint.worktree.fingerprint);

  const config = await readFile(path.join(directory, ".codex/config.toml"), "utf8");
  assert.match(config, /default_subagent_model = "gpt-5\.5"/);
  assert.match(config, /default_subagent_reasoning_effort = "high"/);

  const implementer = await readFile(path.join(directory, ".codex/agents/synod-implementer.toml"), "utf8");
  assert.match(implementer, /model = "gpt-5\.5"/);
  assert.match(implementer, /model_reasoning_effort = "high"/);
  assert.match(implementer, /sandbox_mode = "workspace-write"/);
});

test("is idempotent when generated files are unchanged", async () => {
  const directory = await temporaryProject();
  const first = await initProject({ directory });

  const second = await initProject({ directory });

  assert.equal(second.conflicts.length, 0);
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.operations.length, 0);
  assert.equal(second.preserved.length, 11);
  assert.equal(second.unchanged.length + second.preserved.length, first.created.length);
});

test("repeated init preserves missing user-owned durable state", async () => {
  const directory = await temporaryProject();
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  await initProject({ directory });
  await rm(goalPath);

  const result = await initProject({ directory });

  assert.ok(result.preserved.includes("docs/synod/GOAL.md"));
  assert.ok(!result.created.includes("docs/synod/GOAL.md"));
  assert.ok(result.warnings.some(item => item.code === WARNING_CODES.USER_OWNED_FILE_MISSING));
  await assert.rejects(readFile(goalPath, "utf8"), { code: "ENOENT" });
});

test("repeated init does not reclassify modified Synod config as user-owned", async () => {
  const directory = await temporaryProject();
  const configPath = path.join(directory, ".codex/config.toml");
  const manifestPath = path.join(directory, ".synod/manifest.json");
  await initProject({ directory });
  await writeFile(configPath, "model = \"custom-model\"\n", "utf8");

  const result = await initProject({ directory });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.ok(result.conflicts.includes(".codex/config.toml"));
  assert.equal(manifest.files.find((item: { path?: unknown }) => item.path === ".codex/config.toml")?.ownership, "synod");
  assert.equal(await readFile(configPath, "utf8"), "model = \"custom-model\"\n");
});

test("appends a managed block without replacing existing AGENTS.md guidance", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");
  await writeFile(agentsPath, "# Existing guidance\n\n- Keep this rule.\n", "utf8");
  await chmod(agentsPath, 0o640);

  await initProject({ directory });

  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /^# Existing guidance/m);
  assert.match(agents, /- Keep this rule\./);
  assert.equal(agents.match(/<!-- synod:start -->/g)?.length, 1);
  assert.equal((await stat(agentsPath)).mode & 0o777, 0o640);
});

test("reports conflicts before writing any new files", async () => {
  const directory = await temporaryProject();
  const agentPath = path.join(directory, ".codex/agents/synod-reviewer.toml");
  await mkdir(path.dirname(agentPath), { recursive: true });
  await writeFile(agentPath, "user-owned agent\n", "utf8");

  const result = await initProject({ directory });

  assert.deepEqual(result.conflicts, [".codex/agents/synod-reviewer.toml"]);
  await assert.rejects(readFile(path.join(directory, "AGENTS.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(agentPath, "utf8"), "user-owned agent\n");
});

test("force replaces Synod infrastructure but preserves config and durable state", async () => {
  const directory = await temporaryProject();
  const configPath = path.join(directory, ".codex/config.toml");
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.dirname(goalPath), { recursive: true });
  await writeFile(configPath, "model = \"custom-model\"\n", "utf8");
  await writeFile(goalPath, "stale generated content\n", "utf8");

  const result = await initProject({ directory, force: true });

  assert.equal(result.conflicts.length, 0);
  assert.ok(result.preserved.includes("docs/synod/GOAL.md"));
  assert.equal(result.warnings.filter(item => item.message.includes("Preserved")).length, 2);
  assert.equal(await readFile(configPath, "utf8"), "model = \"custom-model\"\n");
  assert.equal(await readFile(goalPath, "utf8"), "stale generated content\n");
});

test("dry-run returns the complete plan without writing", async () => {
  const directory = await temporaryProject();

  const result = await initProject({ directory, dryRun: true });

  assert.ok(result.created.length > 0);
  await assert.rejects(readFile(path.join(directory, "AGENTS.md"), "utf8"), { code: "ENOENT" });
});

test("rejects symbolic links in generated destinations", async () => {
  const directory = await temporaryProject();
  const outside = path.join(await temporaryProject(), "outside.md");
  const goalPath = path.join(directory, "docs/synod/GOAL.md");
  await mkdir(path.dirname(goalPath), { recursive: true });
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, goalPath);

  const result = await initProject({ directory, force: true });

  assert.deepEqual(result.conflicts, ["docs/synod/GOAL.md"]);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("rejects symbolic links in generated destination ancestors", async () => {
  const directory = await temporaryProject();
  const outside = await temporaryProject();
  await symlink(outside, path.join(directory, ".codex"));

  const result = await initProject({ directory, force: true });

  assert.ok(result.conflicts.includes(".codex/config.toml"));
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(readFile(path.join(directory, "AGENTS.md"), "utf8"), { code: "ENOENT" });
});

test("keeps the primary agent supervisory and delegates routine implementation", async () => {
  const directory = await temporaryProject();
  await initProject({ directory });

  const skill = await readFile(path.join(directory, ".agents/skills/synod-advisor/SKILL.md"), "utf8");
  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
  const decisions = await readFile(path.join(directory, "docs/synod/DECISIONS.md"), "utf8");

  assert.match(skill, /Do not use the supervising model as the routine implementation worker/);
  assert.match(skill, /synod_implementer.*selected profile/);
  assert.match(skill, /task add → delegate start → wait --task → proposal submit/);
  assert.match(skill, /task next --json --view summary/);
  assert.match(skill, /execute the returned `argv`/);
  assert.match(skill, /Do not load README, PRODUCT, ROADMAP, STATE notes/);
  assert.match(skill, /handoff --json --view summary/);
  assert.match(skill, /lease.revoke/);
  assert.match(skill, /Do not load `STATE\.md`/);
  assert.match(skill, /wait --task <id>/);
  assert.match(skill, /wait_agent` only for the exact `hostWaitHandles` \(or legacy `hostWaitThreadIds`\)/);
  assert.match(skill, /hostFallbackRequired` \/ `hostFallbackThreadIds` as compatibility aliases/);
  assert.match(skill, /On Desktop without an injected adapter/);
  assert.match(skill, /Do not start a child App Server/);
  assert.match(skill, /delegate complete --owner-thread/);
  assert.doesNotMatch(skill, /send_message/);
  assert.match(skill, /followup_task/);
  assert.match(skill, /exact returned `ownerThread`/);
  assert.match(skill, /followup_task` is required because it wakes an idle worker/);
  assert.doesNotMatch(skill, /atomic `delegate start` remains deferred/);
  assert.doesNotMatch(skill, /receipt preserves the exact next-operation lease fence/);
  assert.match(agents, /Do not use the supervising model as the default implementation worker\./);
  assert.doesNotMatch(agents, /send_message/);
  assert.match(agents, /followup_task/);
  assert.match(agents, /exact returned `ownerThread`/);
  assert.match(agents, /followup_task` is required because it wakes an idle worker/);
  assert.match(decisions, /Cost-efficient agents perform implementation/);
});

test("renders the GPT-5.6 profile with a spawn-safe default and Luna custom-agent overrides", async () => {
  const directory = await temporaryProject();
  await initProject({ directory, profile: "synod-5.6" });

  const config = await readFile(path.join(directory, ".codex/config.toml"), "utf8");
  const implementer = await readFile(path.join(directory, ".codex/agents/synod-implementer.toml"), "utf8");
  const mechanical = await readFile(path.join(directory, ".codex/agents/synod-mechanical.toml"), "utf8");
  const skill = await readFile(path.join(directory, ".agents/skills/synod-advisor/SKILL.md"), "utf8");

  assert.match(config, /model = "gpt-5\.6-sol"/);
  assert.match(config, /default_subagent_model = "gpt-5\.6-terra"/);
  assert.match(config, /default_subagent_reasoning_effort = "max"/);
  assert.match(implementer, /model = "gpt-5\.6-luna"/);
  assert.match(mechanical, /model = "gpt-5\.6-luna"/);
  assert.match(skill, /Omit explicit `model` and `reasoning_effort` spawn overrides/);
  assert.match(skill, /full-history fork inherits the parent agent type/);
  assert.ok(skill.includes(`pnpm dlx @ivand890/synod@${packageVersion} doctor`));
  assert.ok(skill.includes("pnpm dlx @ivand890/synod@<target-version> upgrade [directory]"));
});

test("rejects duplicate complete AGENTS.md blocks unless force repairs them", async () => {
  const directory = await temporaryProject();
  await initProject({ directory });
  const agentsPath = path.join(directory, "AGENTS.md");
  const canonical = await readFile(agentsPath, "utf8");
  const duplicated = `${canonical}\n# User guidance between blocks\n\n${canonical}`;
  await writeFile(agentsPath, duplicated, "utf8");

  const rejected = await initProject({ directory });

  assert.deepEqual(rejected.conflicts, ["AGENTS.md"]);
  assert.equal(await readFile(agentsPath, "utf8"), duplicated);

  const repaired = await initProject({ directory, force: true });
  const agents = await readFile(agentsPath, "utf8");

  assert.equal(repaired.conflicts.length, 0);
  assert.equal(agents.match(/<!-- synod:start -->/g)?.length, 1);
  assert.equal(agents.match(/<!-- synod:end -->/g)?.length, 1);
  assert.match(agents, /# User guidance between blocks/);
  assert.ok(repaired.warnings.some(item => item.code === WARNING_CODES.AGENTS_BLOCK_DUPLICATES_REPAIRED));
});

test("rejects incomplete AGENTS.md blocks even with force and makes no changes", async () => {
  const directory = await temporaryProject();
  const agentsPath = path.join(directory, "AGENTS.md");
  const malformed = "# User guidance\n\n<!-- synod:start -->\nmanaged or user content?\n";
  await writeFile(agentsPath, malformed, "utf8");

  await assert.rejects(
    initProject({ directory, force: true }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.AGENTS_BLOCK_MALFORMED
      && isRecord(error.details)
      && error.details.reason === "missing_end"
  );
  assert.equal(await readFile(agentsPath, "utf8"), malformed);
  await assert.rejects(readFile(path.join(directory, ".synod/manifest.json"), "utf8"), { code: "ENOENT" });
});
