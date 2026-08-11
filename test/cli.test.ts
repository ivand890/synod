import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

function initializeGitHead(directory: string): void {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Synod Tests"],
    ["config", "user.email", "synod-tests@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"]
  ]) {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
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
  assert.match(help.stdout, /synod wait/);
  assert.match(help.stdout, /synod upgrade/);
  assert.match(help.stdout, /synod doctor/);
  assert.match(help.stdout, /synod status/);
  assert.match(help.stdout, /synod handoff/);
  assert.match(help.stdout, /--explain/);
  assert.match(help.stdout, /synod task add/);
  assert.match(help.stdout, /synod task override/);
  assert.match(help.stdout, /synod task split/);
  assert.match(help.stdout, /synod lease acquire/);
  assert.match(help.stdout, /synod lease recover/);
  assert.match(help.stdout, /--write-tree/);
  assert.match(help.stdout, /--read-tree/);
  assert.match(help.stdout, /synod bundle export/);
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

test("lease parsing rejects malformed numeric fences before orchestration", async () => {
  const { messages, output } = capturedOutput();
  const status = await run([
    "lease", "heartbeat", "T-001",
    "--lease-id", "00000000-0000-4000-8000-000000000000",
    "--generation", "not-a-number",
    "--revision", "0",
    "--expected-heartbeat-at", "2026-08-10T00:00:00.000Z",
    "--owner-thread", "thread:test",
    "--json"
  ], output);
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 1);
  assert.equal(envelope.error.code, ERROR_CODES.LEASE_INVALID);
  assert.equal(envelope.error.details.option, "--generation");
});

test("wait parsing rejects missing threads and out-of-range fallback intervals", async () => {
  for (const args of [
    ["wait", "--json"],
    ["wait", "--thread", "thread:one", "--poll-interval-ms", "99", "--json"]
  ]) {
    const { messages, output } = capturedOutput();
    const status = await run(args, output);
    const envelope = JSON.parse(takeMessage(messages));
    assert.equal(status, 1);
    assert.equal(envelope.error.code, ERROR_CODES.WAIT_INVALID);
  }
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
      "--correction-limit", "4",
      "--cwd", directory,
      "--json"
    ], output);
    const added = JSON.parse(takeMessage(messages));
    assert.equal(addStatus, 0);
    assert.equal(added.schemaVersion, 1);
    assert.equal(added.command, "task");
    assert.equal(added.data.action, "add");
    assert.equal(added.data.task.id, "T-001");
    assert.equal(added.data.task.correctionPolicy.limit, 4);

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

    const handoffCode = await run(["handoff", directory, "--json"], output);
    const handoff = JSON.parse(takeMessage(messages));
    assert.equal(handoffCode, 0);
    assert.equal(handoff.ok, true);
    assert.equal(handoff.command, "handoff");
    assert.equal(handoff.data.tasks[0].id, "T-001");
    assert.equal(handoff.data.recoveryBundle.status, "not-supplied");

    const handoffTextCode = await run(["handoff", "--cwd", directory], output);
    assert.equal(handoffTextCode, 0);
    assert.match(takeMessage(messages), /T-001: PLANNED r0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease commands expose durable owner, generation, and heartbeat state through JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-lease-json-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    messages.length = 0;
    await run([
      "task", "add", "T-LEASE",
      "--objective", "Exercise writer leases",
      "--executor", "synod_implementer",
      "--acceptance", "The lease is fenced",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    messages.length = 0;
    await run(["task", "transition", "T-LEASE", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const acquireCode = await run([
      "lease", "acquire", "T-LEASE",
      "--owner-thread", "thread:cli",
      "--write-tree", "src/lease",
      "--ttl-seconds", "120",
      "--heartbeat-seconds", "30",
      "--cwd", directory,
      "--json"
    ], output);
    const acquired = JSON.parse(takeMessage(messages));
    assert.equal(acquireCode, 0);
    assert.equal(acquired.command, "lease");
    assert.equal(acquired.data.action, "acquire");
    assert.equal(acquired.data.lease.ownerThread, "thread:cli");
    assert.equal(acquired.data.lease.generation, 1);
    assert.deepEqual(acquired.data.lease.scopes, [{ path: "src/lease", access: "write", kind: "tree" }]);

    const heartbeatCode = await run([
      "lease", "heartbeat", "T-LEASE",
      "--lease-id", acquired.data.lease.id,
      "--generation", "1",
      "--revision", "0",
      "--expected-heartbeat-at", acquired.data.lease.heartbeatAt,
      "--owner-thread", "thread:cli",
      "--cwd", directory,
      "--json"
    ], output);
    const heartbeat = JSON.parse(takeMessage(messages));
    assert.equal(heartbeatCode, 0);
    assert.equal(heartbeat.data.action, "heartbeat");
    assert.equal(heartbeat.data.lease.generation, 1);

    await run(["task", "transition", "T-LEASE", "ACTIVE", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;
    await mkdir(path.join(directory, "src/lease"), { recursive: true });
    await writeFile(path.join(directory, "src/lease/work.ts"), "abandoned\n");
    const revokeCode = await run([
      "lease", "revoke", "T-LEASE",
      "--lease-id", heartbeat.data.lease.id,
      "--generation", "1",
      "--revision", "0",
      "--expected-heartbeat-at", heartbeat.data.lease.heartbeatAt,
      "--reason", "worker stopped",
      "--cwd", directory,
      "--json"
    ], output);
    const revoked = JSON.parse(takeMessage(messages));
    assert.equal(revokeCode, 0);
    assert.equal(revoked.data.task.recovery.status, "PENDING");

    const recoverCode = await run([
      "lease", "recover", "T-LEASE",
      "--lease-id", heartbeat.data.lease.id,
      "--generation", "1",
      "--revision", "0",
      "--expected-heartbeat-at", heartbeat.data.lease.heartbeatAt,
      "--decision", "reassign",
      "--owner-thread", "thread:replacement",
      "--reason", "continue with replacement",
      "--cwd", directory,
      "--json"
    ], output);
    const recovered = JSON.parse(takeMessage(messages));
    assert.equal(recoverCode, 0);
    assert.equal(recovered.data.action, "recover");
    assert.equal(recovered.data.lease.ownerThread, "thread:replacement");
    assert.equal(recovered.data.lease.generation, 2);
    assert.equal(recovered.data.task.recovery.status, "REASSIGNED");
    assert.match(recovered.data.task.recovery.proposal.bundleId, /^sha256:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task override and split commands expose canonical policy decisions through JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-policy-json-test-"));
  const { messages, output } = capturedOutput();
  const add = async (id: string) => {
    const code = await run([
      "task", "add", id,
      "--objective", `Exercise ${id}`,
      "--executor", "synod_implementer",
      "--acceptance", "The policy decision is recorded",
      "--verification", "pnpm test",
      "--correction-limit", "0",
      "--cwd", directory,
      "--json"
    ], output);
    assert.equal(code, 0);
    messages.length = 0;
  };

  try {
    await run(["init", directory], output);
    messages.length = 0;
    await add("T-OVERRIDE");
    const overrideCode = await run([
      "task", "override", "T-OVERRIDE",
      "--additional-rounds", "1",
      "--approver", "release-owner",
      "--reference", "approval:cli",
      "--reason", "one bounded retry",
      "--evidence", "review:exhausted",
      "--cwd", directory,
      "--json"
    ], output);
    const overridden = JSON.parse(takeMessage(messages));
    assert.equal(overrideCode, 0);
    assert.equal(overridden.data.action, "override");
    assert.equal(overridden.data.task.correctionPolicy.limit, 1);
    assert.equal(overridden.data.override.reference, "approval:cli");

    await add("T-SPLIT");
    await add("T-LEFT");
    await add("T-RIGHT");
    const splitCode = await run([
      "task", "split", "T-SPLIT",
      "--replacement", "T-LEFT",
      "--replacement", "T-RIGHT",
      "--reason", "separate exhausted scope",
      "--evidence", "review:split",
      "--cwd", directory,
      "--json"
    ], output);
    const split = JSON.parse(takeMessage(messages));
    assert.equal(splitCode, 0);
    assert.equal(split.data.action, "split");
    assert.equal(split.data.task.state, "SUPERSEDED");
    assert.deepEqual(split.data.replacements.map((item: { id: string }) => item.id), ["T-LEFT", "T-RIGHT"]);
    assert.ok(split.data.replacements.every((item: { state: string; acceptance: { status: string } }) =>
      item.state === "PLANNED" && item.acceptance.status === "pending"
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wait command exposes bounded mode and final thread status through JSON", async () => {
  const { messages, output } = capturedOutput();
  let closed = 0;
  const status = await run([
    "wait",
    "--thread", "thread:one",
    "--thread", "thread:one",
    "--timeout-seconds", "1",
    "--json"
  ], output, {
    waitAdapterFactory: () => ({
      async start() {},
      capabilities() { return { notification: false, cursor: false }; },
      async read() { return { statuses: [{ threadId: "thread:one", status: { type: "idle" as const } }] }; },
      async close() { closed += 1; },
      getWarnings() { return []; },
      getDiagnostics() { return { closed }; }
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 0);
  assert.equal(envelope.command, "wait");
  assert.equal(envelope.data.mode, "poll");
  assert.deepEqual(envelope.data.threadIds, ["thread:one"]);
  assert.equal(envelope.data.fallbackPollCount, 0);
  assert.equal(envelope.data.incomplete, false);
  assert.equal(envelope.diagnostics.closed, 1);
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

test("bundle export and verify expose schema-1 JSON success and corruption errors", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "synod-cli-bundle-test-"));
  const directory = path.join(parent, "project");
  const destination = path.join(parent, "recovery.bundle");
  const textDestination = path.join(parent, "recovery-text.bundle");
  const restoreDirectory = path.join(parent, "restored-project");
  const { messages, output } = capturedOutput();
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    await mkdir(directory);
    await writeFile(path.join(directory, "tracked.txt"), "base\n");
    await run(["init", directory], output);
    messages.length = 0;
    git("init");
    git("config", "user.name", "Synod Test");
    git("config", "user.email", "synod@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "base");
    await writeFile(path.join(directory, "tracked.txt"), "checkpoint\n");
    assert.equal(await run(["checkpoint", directory, "--json"], output), 0);
    messages.length = 0;

    const exportCode = await run(["bundle", "export", destination, "--cwd", directory, "--json"], output);
    const exported = JSON.parse(takeMessage(messages));
    assert.equal(exportCode, 0);
    assert.equal(exported.ok, true);
    assert.equal(exported.command, "bundle");
    assert.equal(exported.data.action, "export");
    assert.match(exported.data.bundleId, /^sha256:/);

    const textCode = await run(["bundle", "export", textDestination, "--cwd", directory], output);
    const text = takeMessage(messages);
    assert.equal(textCode, 0);
    assert.match(text, /base .+@[0-9a-f]{40}/);
    assert.match(text, /fingerprint sha256:[0-9a-f]{64}/);
    assert.match(text, /untracked excluded/);

    const verifyCode = await run(["bundle", "verify", destination, "--json"], output);
    const verified = JSON.parse(takeMessage(messages));
    assert.equal(verifyCode, 0);
    assert.equal(verified.ok, true);
    assert.equal(verified.data.action, "verify");
    assert.equal(verified.data.bundleId, exported.data.bundleId);

    const clone = spawnSync("git", ["clone", "--no-local", directory, restoreDirectory], { encoding: "utf8" });
    assert.equal(clone.status, 0, clone.stderr);
    const restoreCode = await run(["bundle", "restore", destination, "--cwd", restoreDirectory, "--json"], output);
    const restored = JSON.parse(takeMessage(messages));
    assert.equal(restoreCode, 0);
    assert.equal(restored.ok, true);
    assert.equal(restored.data.action, "restore");
    assert.equal(restored.data.bundleId, exported.data.bundleId);
    assert.equal(restored.data.recoveredInterruptedRestore, false);
    assert.equal(await readFile(path.join(restoreDirectory, "tracked.txt"), "utf8"), "checkpoint\n");

    const object = (await readdir(path.join(destination, "objects")))[0];
    assert.ok(object);
    await writeFile(path.join(destination, "objects", object), "tampered");
    const corruptCode = await run(["bundle", "verify", destination, "--json"], output);
    const corrupt = JSON.parse(takeMessage(messages));
    assert.equal(corruptCode, 1);
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.error.code, ERROR_CODES.RECOVERY_BUNDLE_CORRUPT);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("bundle restore requires an explicit destination checkout", async () => {
  const { messages, output } = capturedOutput();
  const code = await run(["bundle", "restore", "recovery.bundle", "--json"], output);
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(code, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.UNEXPECTED_ARGUMENT);
  assert.equal(envelope.error.details.option, "--cwd");
});
