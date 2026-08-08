import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES } from "../src/errors.js";
import { initProject } from "../src/init.js";
import { packageVersion } from "../src/package.js";

const temporaryDirectories = new Set();

async function temporaryProject() {
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

  const manifest = JSON.parse(await readFile(path.join(directory, ".synod/manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.templateVersion, packageVersion);
  assert.equal(manifest.profile, "portable");
  assert.equal(manifest.hashAlgorithm, "sha256");
  assert.equal(manifest.files.find(item => item.path === "AGENTS.md").ownership, "shared");
  assert.equal(manifest.files.find(item => item.path === "docs/synod/GOAL.md").ownership, "user");
  assert.match(manifest.files.find(item => item.path === ".codex/config.toml").contentHash, /^sha256:[0-9a-f]{64}$/);

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
  assert.equal(second.preserved.length, 5);
  assert.equal(second.unchanged.length + second.preserved.length, first.created.length);
});

test("appends a managed block without replacing existing AGENTS.md guidance", async () => {
  const directory = await temporaryProject();
  await writeFile(path.join(directory, "AGENTS.md"), "# Existing guidance\n\n- Keep this rule.\n", "utf8");

  await initProject({ directory });

  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Existing guidance/m);
  assert.match(agents, /- Keep this rule\./);
  assert.equal(agents.match(/<!-- synod:start -->/g).length, 1);
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

  assert.match(skill, /Do not use the supervising model as the routine implementation worker\./);
  assert.match(skill, /synod_implementer.*selected profile/);
  assert.match(agents, /Do not use the supervising model as the default implementation worker\./);
  assert.match(decisions, /Cost-efficient agents perform implementation/);
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
  assert.equal(agents.match(/<!-- synod:start -->/g).length, 1);
  assert.equal(agents.match(/<!-- synod:end -->/g).length, 1);
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
    error => error.code === ERROR_CODES.AGENTS_BLOCK_MALFORMED && error.details.reason === "missing_end"
  );
  assert.equal(await readFile(agentsPath, "utf8"), malformed);
  await assert.rejects(readFile(path.join(directory, ".synod/manifest.json"), "utf8"), { code: "ENOENT" });
});
