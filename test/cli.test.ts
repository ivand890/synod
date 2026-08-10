import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { WARNING_CODES, baseDiagnostics } from "../src/contracts.js";
import { ERROR_CODES, asSynodError } from "../src/errors.js";
import { run } from "../src/cli.js";
import { packageVersion } from "../src/package.js";

const bin = path.resolve("bin/synod.js");

function capturedOutput() {
  const messages: string[] = [];
  return {
    messages,
    output: {
      log(message: unknown) { messages.push(String(message)); },
      warn() {},
      error() {}
    }
  };
}

function takeMessage(messages: string[]): string {
  const message = messages.shift();
  assert.notEqual(message, undefined);
  return message ?? "";
}

test("keeps canonical diagnostics authoritative and preserves error-like messages", () => {
  const diagnostics = baseDiagnostics({
    synodVersion: "spoofed",
    nodeVersion: 0,
    platform: "external"
  });

  assert.equal(diagnostics.synodVersion, packageVersion);
  assert.equal(diagnostics.nodeVersion, process.versions.node);
  assert.equal(diagnostics.platform, process.platform);
  assert.equal(asSynodError({ message: "injected client failure" }).message, "injected client failure");
});

test("the installed entry point keeps init dry-run free of runtime and project writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-test-"));

  try {
    const result = spawnSync(process.execPath, [bin, "init", directory, "--dry-run"], {
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Runtime: ${packageVersion} (install)`));
    assert.match(result.stdout, /Synod init plan is valid/);
    await assert.rejects(readFile(path.join(directory, "docs/synod/PLAN.md"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(directory, ".synod/runtime.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the installed entry point emits one stable JSON error for an unmanaged runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runtime-conflict-test-"));

  try {
    await mkdir(path.join(directory, ".synod/runtime"), { recursive: true });
    const result = spawnSync(process.execPath, [bin, "init", directory, "--json"], {
      encoding: "utf8"
    });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, ERROR_CODES.LOCAL_RUNTIME_CONFLICT);
    assert.equal((await stat(path.join(directory, ".synod/runtime"))).isDirectory(), true);
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
  assert.match(help.stdout, /synod status/);
  assert.match(help.stdout, /--explain/);
  assert.match(help.stdout, /synod task add/);
});

test("init emits versioned JSON for success and conflicts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-json-test-"));
  const { messages, output } = capturedOutput();

  try {
    const successStatus = await run(["init", directory, "--json"], output);
    const success = JSON.parse(takeMessage(messages));
    assert.equal(successStatus, 0);
    assert.equal(success.schemaVersion, 1);
    assert.equal(success.ok, true);
    assert.ok(success.data.created.includes("AGENTS.md"));

    await writeFile(path.join(directory, "docs/synod/GOAL.md"), "user-owned goal\n", "utf8");
    const warningStatus = await run(["init", directory, "--force", "--json"], output);
    const warned = JSON.parse(takeMessage(messages));
    assert.equal(warningStatus, 0);
    assert.equal(warned.ok, true);
    assert.ok(warned.warnings.some((item: { code?: unknown }) => item.code === WARNING_CODES.DURABLE_STATE_PRESERVED));

    await writeFile(path.join(directory, ".codex/agents/synod-reviewer.toml"), "conflict\n", "utf8");
    const conflictStatus = await run(["init", directory, "--json"], output);
    const conflict = JSON.parse(takeMessage(messages));
    assert.equal(conflictStatus, 1);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, ERROR_CODES.INIT_CONFLICT);
    assert.deepEqual(conflict.error.details.paths, [".codex/agents/synod-reviewer.toml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown commands emit stable JSON errors when requested", async () => {
  const { messages, output } = capturedOutput();

  const status = await run(["unknown", "--json"], output);
  const envelope = JSON.parse(messages[0] ?? "");

  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.UNKNOWN_COMMAND);
});

test("task parsing rejects inherited Object.prototype names", async () => {
  const { messages, output } = capturedOutput();

  const status = await run(["task", "add", "T-001", "toString", "value", "--json"], output);
  const envelope = JSON.parse(messages[0] ?? "");

  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.UNEXPECTED_ARGUMENT);
  assert.equal(envelope.error.details.argument, "toString");
});

test("check and doctor emit failure JSON when their health gates fail", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-health-json-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    messages.length = 0;
    await writeFile(path.join(directory, ".codex/agents/synod-reviewer.toml"), "drift\n", "utf8");

    const checkStatus = await run(["check", directory, "--json"], output);
    const check = JSON.parse(takeMessage(messages));
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
    const doctor = JSON.parse(takeMessage(messages));
    assert.equal(doctorStatus, 1);
    assert.equal(doctor.ok, false);
    assert.equal(doctor.error.code, ERROR_CODES.DOCTOR_FAILED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor text identifies the Desktop executable, version, and shared Codex home", async () => {
  const { messages, output } = capturedOutput();
  const executable = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const status = await run(["doctor"], output, {
    doctorRuntimeResolver: () => ({
      surface: "desktop",
      executable,
      executableSource: "desktop-process",
      resolved: true
    }),
    doctorClientFactory: options => ({
      async start() { assert.equal(options.codexBin, executable); },
      async probeCapabilities() {},
      async listModels() {
        return [{
          id: "gpt-5.5",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(reasoningEffort => ({ reasoningEffort }))
        }];
      },
      async close() {},
      getWarnings() { return []; },
      getDiagnostics() {
        return {
          codexExecutable: executable,
          codexHome: "/Users/test/.codex",
          codexSurface: "desktop",
          codexVersion: "0.147.0",
          appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
        };
      }
    })
  });

  assert.equal(status, 0);
  assert.match(messages[0] ?? "", /Codex Desktop: 0\.147\.0 \(known-good; desktop\)/);
  assert.match(messages[0] ?? "", /Codex executable: \/Applications\/ChatGPT\.app\/Contents\/Resources\/codex \(desktop-process\)/);
  assert.match(messages[0] ?? "", /Codex home: \/Users\/test\/\.codex/);
});

test("shared client factories receive the doctor runtime executable", async () => {
  const { output } = capturedOutput();
  const executable = "/opt/codex/bin/codex";
  const receivedExecutables: Array<string | undefined> = [];

  const status = await run(["doctor"], output, {
    doctorRuntimeResolver: () => ({
      surface: "cli",
      executable,
      executableSource: "path",
      resolved: true
    }),
    clientFactory: options => {
      receivedExecutables.push(options?.codexBin);
      return {
        async start() {},
        async probeCapabilities() {},
        async listModels() {
          return [{
            id: "gpt-5.5",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
          }];
        },
        async listThreads() { return { data: [], nextCursor: null }; },
        async close() {},
        getWarnings() { return []; },
        getDiagnostics() {
          return {
            codexExecutable: executable,
            codexSurface: "cli",
            codexVersion: "0.147.0",
            appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
          };
        }
      };
    }
  });

  assert.equal(status, 0);
  assert.deepEqual(receivedExecutables, [executable]);
});

test("doctor text never renders an undefined Codex surface", async () => {
  const { messages, output } = capturedOutput();
  const status = await run(["doctor"], output, {
    doctorRuntimeResolver: () => ({
      executable: "codex",
      executableSource: "PATH-unresolved",
      resolved: false
    }),
    doctorClientFactory: () => ({
      async start() { throw new Error("spawn failed"); },
      async close() {},
      getWarnings() { return []; },
      getDiagnostics() { return {}; }
    })
  });

  assert.equal(status, 1);
  assert.match(messages[0] ?? "", /Codex runtime: unavailable \(unsupported; unknown surface\)/);
  assert.doesNotMatch(messages[0] ?? "", /undefined/);
});

test("task and status commands expose canonical orchestration through schema-1 envelopes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-orchestration-json-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    messages.length = 0;
    const addStatus = await run([
      "task", "add", "T-001",
      "--objective", "Exercise the CLI contract",
      "--executor", "synod_implementer",
      "--acceptance", "The task is persisted",
      "--verification", "pnpm test",
      "--cwd", directory,
      "--json"
    ], output);
    const added = JSON.parse(takeMessage(messages));
    assert.equal(addStatus, 0);
    assert.equal(added.schemaVersion, 1);
    assert.equal(added.command, "task");
    assert.equal(added.data.action, "add");
    assert.equal(added.data.task.id, "T-001");

    const statusCode = await run(["status", directory, "--json"], output);
    const status = JSON.parse(takeMessage(messages));
    assert.equal(statusCode, 0);
    assert.equal(status.ok, true);
    assert.equal(status.command, "status");
    assert.equal(status.data.eventCount, 2);
    assert.equal(status.data.tasks[0].revision, 0);

    const explainCode = await run(["status", directory, "--explain", "--json"], output);
    const explained = JSON.parse(takeMessage(messages));
    assert.equal(explainCode, 0);
    assert.equal(explained.ok, true);
    assert.equal(explained.data.delta.changed, false);
    assert.deepEqual(explained.data.delta.paths, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status explain returns the path delta inside checkpoint-drift JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-delta-json-test-"));
  const { messages, output } = capturedOutput();
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    git("init");
    git("config", "user.name", "Synod Test");
    git("config", "user.email", "synod@example.invalid");
    git("config", "commit.gpgsign", "false");
    await writeFile(path.join(directory, "source.txt"), "base\n", "utf8");
    git("add", "source.txt");
    git("commit", "-m", "initial");
    await run(["init", directory], output);
    messages.length = 0;
    await writeFile(path.join(directory, "source.txt"), "changed\n", "utf8");

    const statusCode = await run(["status", directory, "--explain", "--json"], output);
    const envelope = JSON.parse(takeMessage(messages));
    assert.equal(statusCode, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, ERROR_CODES.CHECKPOINT_DRIFT);
    assert.equal(envelope.error.details.delta.paths[0].path, "source.txt");
    assert.equal(envelope.error.details.delta.paths[0].unstaged, "modified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
