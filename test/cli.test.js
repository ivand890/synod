import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES } from "../src/errors.js";
import { run } from "../src/cli.js";
import { packageVersion } from "../src/package.js";

const bin = path.resolve("bin/synod.js");

test("the installed entry point initializes a target directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-test-"));

  try {
    const result = spawnSync(process.execPath, [bin, "init", directory], {
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Synod init completed/);
    assert.match(await readFile(path.join(directory, "docs/synod/PLAN.md"), "utf8"), /Synod Execution Plan/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prints version and help", () => {
  const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });

  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageVersion);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /synod init/);
  assert.match(help.stdout, /synod usage/);
  assert.match(help.stdout, /synod upgrade/);
  assert.match(help.stdout, /synod doctor/);
});

test("init emits versioned JSON for success and conflicts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-json-test-"));
  const messages = [];
  const output = { log: message => messages.push(message), warn() {}, error() {} };

  try {
    const successStatus = await run(["init", directory, "--json"], output);
    const success = JSON.parse(messages.shift());
    assert.equal(successStatus, 0);
    assert.equal(success.schemaVersion, 1);
    assert.equal(success.ok, true);
    assert.ok(success.data.created.includes("AGENTS.md"));

    await writeFile(path.join(directory, "docs/synod/GOAL.md"), "user-owned goal\n", "utf8");
    const warningStatus = await run(["init", directory, "--force", "--json"], output);
    const warned = JSON.parse(messages.shift());
    assert.equal(warningStatus, 0);
    assert.equal(warned.ok, true);
    assert.ok(warned.warnings.some(item => item.code === WARNING_CODES.DURABLE_STATE_PRESERVED));

    await writeFile(path.join(directory, ".codex/agents/synod-reviewer.toml"), "conflict\n", "utf8");
    const conflictStatus = await run(["init", directory, "--json"], output);
    const conflict = JSON.parse(messages.shift());
    assert.equal(conflictStatus, 1);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, ERROR_CODES.INIT_CONFLICT);
    assert.deepEqual(conflict.error.details.paths, [".codex/agents/synod-reviewer.toml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown commands emit stable JSON errors when requested", async () => {
  const messages = [];
  const output = { log: message => messages.push(message), warn() {}, error() {} };

  const status = await run(["unknown", "--json"], output);
  const envelope = JSON.parse(messages[0]);

  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.UNKNOWN_COMMAND);
});

test("check and doctor emit failure JSON when their health gates fail", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-health-json-test-"));
  const messages = [];
  const output = { log: message => messages.push(message), warn() {}, error() {} };

  try {
    await run(["init", directory], output);
    messages.length = 0;
    await writeFile(path.join(directory, ".codex/agents/synod-reviewer.toml"), "drift\n", "utf8");

    const checkStatus = await run(["check", directory, "--json"], output);
    const check = JSON.parse(messages.shift());
    assert.equal(checkStatus, 1);
    assert.equal(check.ok, false);
    assert.equal(check.error.code, ERROR_CODES.CHECK_FAILED);

    const doctorStatus = await run(["doctor", directory, "--json"], output, {
      doctorClientFactory: () => ({
        async start() {},
        async probeCapabilities() {},
        async listModels() { return []; },
        async close() {},
        getWarnings() { return []; },
        getDiagnostics() {
          return {
            codexVersion: "0.148.0",
            appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
          };
        }
      })
    });
    const doctor = JSON.parse(messages.shift());
    assert.equal(doctorStatus, 1);
    assert.equal(doctor.ok, false);
    assert.equal(doctor.error.code, ERROR_CODES.DOCTOR_FAILED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
