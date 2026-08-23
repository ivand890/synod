import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AppServerDiagnostics, AppServerEvent } from "../src/app-server.js";
import { WARNING_CODES, baseDiagnostics } from "../src/contracts.js";
import { ERROR_CODES, asSynodError } from "../src/errors.js";
import { run } from "../src/cli.js";
import { createCliAppServerAdapter, findCliAppServerWaitClient, type CliAppServerClient } from "../src/cli-app-server-adapter.js";
import { cliAppServerEndpointPaths } from "../src/cli-app-server-runner.js";
import { parseDelegateArgs, parseLeaseArgs, parseProposalArgs, parseStatusArgs, parseTaskArgs, parseWorktreeArgs } from "../src/command-options.js";
import { initProject } from "../src/lifecycle.js";
import { packageName, packageVersion } from "../src/package.js";

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
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture"]
  ]) {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}

class CliPathAFakeClient implements CliAppServerClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly threadId: string;
  readonly listeners = new Set<(event: AppServerEvent) => void>();
  started = 0;
  closed = 0;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  async start(): Promise<void> {
    this.started += 1;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: params.cwd,
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        reasoningEffort: "max",
        sandbox: { type: "readOnly" },
        thread: { id: this.threadId, status: { type: "idle" } }
      };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        const settings: AppServerEvent = {
          type: "notification",
          method: "thread/settings/updated",
          params: {
            threadId: this.threadId,
            threadSettings: {
              approvalPolicy: "never",
              approvalsReviewer: "user",
              collaborationMode: { mode: "default", settings: { model: "gpt-5.6-luna" } },
              cwd: params.cwd,
              model: "gpt-5.6-luna",
              modelProvider: "openai",
              effort: "max",
              sandboxPolicy: params.sandboxPolicy
            }
          }
        };
        const completed: AppServerEvent = {
          type: "notification",
          method: "turn/completed",
          params: { threadId: this.threadId, turn: { id: "turn-1", status: "completed" } }
        };
        for (const listener of this.listeners) {
          listener(settings);
          listener(completed);
        }
      });
      return { turn: { id: "turn-1", items: [], status: "inProgress" } };
    }
    if (method === "thread/list") {
      return {
        data: [{ id: this.threadId, status: { type: "notLoaded" } }],
        nextCursor: null
      };
    }
    if (method === "thread/read") {
      return { thread: { id: this.threadId, status: { type: "idle" } } };
    }
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeEvents(listener: (event: AppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDiagnostics(): AppServerDiagnostics {
    return {
      codexExecutable: "codex",
      codexSurface: "cli",
      appServer: {
        capabilities: { initialize: true, threadList: true, modelList: false }
      }
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
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

test("status selectors are single, explicit, and mutually exclusive", () => {
  assert.deepEqual(parseStatusArgs(["--task", " t-001 ", "--json"]), {
    directory: ".",
    json: true,
    taskId: "T-001"
  });
  assert.deepEqual(parseStatusArgs(["--active-only"]), {
    directory: ".",
    json: false,
    activeOnly: true
  });
  assert.throws(
    () => parseStatusArgs(["--task", "T-001", "--task", "T-002"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
  assert.throws(
    () => parseStatusArgs(["--active-only", "--changed-since-checkpoint"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
  assert.throws(
    () => parseStatusArgs(["--task", "T-001", "--explain"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
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

test("installed status bypasses malformed runtime metadata but not malformed canonical state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-status-runtime-invalid-test-"));

  try {
    await initProject({ directory });
    const runtimePath = path.join(directory, ".synod/runtime.json");
    const statePath = path.join(directory, ".synod/state.json");
    await writeFile(runtimePath, "{ malformed\n", "utf8");

    const status = spawnSync(process.execPath, [bin, "status", directory, "--json"], {
      cwd: directory,
      encoding: "utf8"
    });
    assert.notEqual(status.stdout.trim(), "");
    const envelope = JSON.parse(status.stdout);
    const statusData = envelope.ok ? envelope.data : envelope.error.details;
    assert.notEqual(envelope.error?.code, ERROR_CODES.LOCAL_RUNTIME_INVALID);
    assert.equal(statusData.runtimeVersion, null);
    assert.equal(statusData.stateTemplateVersion, packageVersion);

    await writeFile(statePath, "{ malformed\n", "utf8");
    const malformedState = spawnSync(process.execPath, [bin, "status", directory, "--json"], {
      cwd: directory,
      encoding: "utf8"
    });
    assert.equal(malformedState.status, 1);
    const malformedStateEnvelope = JSON.parse(malformedState.stdout);
    assert.equal(malformedStateEnvelope.ok, false);
    assert.equal(malformedStateEnvelope.error.code, ERROR_CODES.ORCHESTRATION_STATE_INVALID);
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

test("prints version and help", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-version-help-test-"));

  try {
    const version = spawnSync(process.execPath, [bin, "--version"], { cwd: directory, encoding: "utf8" });
    const help = spawnSync(process.execPath, [bin, "--help"], { cwd: directory, encoding: "utf8" });

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
    assert.match(help.stdout, /synod lease reserve/);
    assert.match(help.stdout, /synod lease bind/);
    assert.match(help.stdout, /synod lease recover/);
    assert.match(help.stdout, /synod worktree create/);
    assert.match(help.stdout, /synod worktree seal/);
    assert.match(help.stdout, /synod worktree integrate/);
    assert.match(help.stdout, /synod worktree cleanup/);
    assert.match(help.stdout, /synod worktree status/);
    assert.match(help.stdout, /--write-tree/);
    assert.match(help.stdout, /--read-tree/);
    assert.match(help.stdout, /synod bundle export/);
    for (const option of [
      "--actor <id>",
      "--evidence <reference>",
      "--reservation-ttl-seconds <n>",
      "--ttl-seconds <n>",
      "--heartbeat-seconds <n>",
      "--timeout-seconds <n>",
      "--poll-interval-ms <n>",
    ]) {
      assert.match(help.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(help.stdout, /Delegate start options:/);
    assert.match(help.stdout, /Bound delegated waiting; requires --wait\./);
    assert.match(help.stdout, /Set delegated polling; requires --wait\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("lease bind parsing requires the complete reservation fence", async () => {
  const { messages, output } = capturedOutput();
  const status = await run([
    "lease", "bind", "T-001",
    "--reservation-token", "00000000-0000-4000-8000-000000000001",
    "--lease-id", "00000000-0000-4000-8000-000000000002",
    "--generation", "1",
    "--revision", "0",
    "--expected-reserved-at", "2026-08-10T00:00:00.000Z",
    "--owner-thread", "thread:test",
    "--json"
  ], output);
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 1);
  assert.equal(envelope.error.code, ERROR_CODES.LEASE_INVALID);
  assert.match(envelope.error.message, /complete reservation fence/);
});

test("worktree parsing requires a complete exact lease fence", async () => {
  for (const args of [
    ["worktree", "create", "T-001", "--destination", "/tmp/task", "--json"],
    [
      "worktree", "create", "T-001",
      "--destination", "/tmp/task",
      "--lease-id", "00000000-0000-4000-8000-000000000000",
      "--generation", "zero",
      "--revision", "0",
      "--expected-heartbeat-at", "2026-08-10T00:00:00.000Z",
      "--owner-thread", "thread:test",
      "--json"
    ]
  ]) {
    const { messages, output } = capturedOutput();
    const status = await run(args, output);
    const envelope = JSON.parse(takeMessage(messages));
    assert.equal(status, 1);
    assert.equal(envelope.error.code, ERROR_CODES.WORKTREE_INVALID);
  }
  for (const args of [
    ["worktree", "cleanup", "T-001", "--lease-id", "00000000-0000-4000-8000-000000000000", "--json"],
    [
      "worktree", "seal", "T-001", "--destination", "/tmp/task",
      "--lease-id", "00000000-0000-4000-8000-000000000000",
      "--generation", "1", "--revision", "0",
      "--expected-heartbeat-at", "2026-08-10T00:00:00.000Z",
      "--owner-thread", "thread:test", "--json"
    ]
  ]) {
    const { messages, output } = capturedOutput();
    const status = await run(args, output);
    const envelope = JSON.parse(takeMessage(messages));
    assert.equal(status, 1);
    assert.equal(envelope.error.code, ERROR_CODES.UNKNOWN_OPTION);
    if (args[1] === "cleanup") {
      assert.match(envelope.error.message, /cleanup/);
      assert.equal(envelope.error.details.action, "cleanup");
      assert.equal(envelope.error.details.option, "--lease-id");
    }
  }
});

test("wait parsing requires a task or thread and rejects out-of-range fallback intervals", async () => {
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

test("delegate complete requires an owner thread and rejects unknown actions", () => {
  assert.throws(
    () => parseDelegateArgs(["complete", "T-001"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.HOST_OWNER_MISSING
  );
  const parsed = parseDelegateArgs(["complete", "T-001", "--owner-thread", "thread:worker", "--json"]);
  assert.equal("help" in parsed, false);
  if ("help" in parsed) return;
  assert.equal(parsed.action, "complete");
  assert.equal(parsed.action === "complete" ? parsed.ownerThread : "", "thread:worker");
  assert.throws(
    () => parseDelegateArgs(["begin", "T-001"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.UNEXPECTED_ARGUMENT
  );
});

test("CLI delegate start on PATH CLI binds the App Server thread UUID before a turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-delegate-cli-path-a-"));
  const { messages, output } = capturedOutput();
  const methods: string[] = [];
  let observedProfile: string | undefined;
  let observedThreadIds: string[] = [];
  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-HOST",
      "--objective", "Exercise CLI Path A identity before execute",
      "--executor", "synod_implementer",
      "--acceptance", "Owner UUID comes from thread/start",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    await run(["task", "transition", "T-HOST", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;
    const startStatus = await run(
      ["delegate", "start", "T-HOST", "--write", "AGENTS.md", "--cwd", directory, "--json"],
      output,
      {
        hostRuntimeResolver: () => ({
          surface: "cli",
          executable: "codex",
          executableSource: "PATH",
          resolved: true
        }),
        cliAppServerAdapterFactory: options => {
          observedProfile = options?.profile;
          return {
            async spawn() {
              methods.push("spawn");
              return { ownerId: "thread-from-appserver", threadId: "thread-from-appserver" };
            },
            async authorize() {
              methods.push("authorize");
              return { status: "authorized" };
            }
          };
        }
      }
    );
    const start = JSON.parse(takeMessage(messages));
    assert.equal(startStatus, 0);
    assert.equal(start.ok, true);
    assert.equal(start.data.hostSpawnRequired, undefined);
    assert.equal(start.data.ownerThread, "thread-from-appserver");
    assert.equal(start.data.authorization.status, "authorized");
    assert.equal(observedProfile, "portable");
    assert.deepEqual(methods, ["spawn", "authorize"]);

    messages.length = 0;
    const waitStatus = await run(
      ["wait", "--task", "T-HOST", "--cwd", directory, "--json"],
      output,
      {
        waitRuntimeResolver: () => ({
          surface: "cli",
          executable: "codex",
          executableSource: "PATH",
          resolved: true
        }),
        waitAdapterFactory: () => ({
          async start() {},
          capabilities: () => ({ notification: false, cursor: false }),
          async read(threadIds: string[]) {
            observedThreadIds = [...threadIds];
            return {
              statuses: threadIds.map(threadId => ({ threadId, status: { type: "idle" as const } }))
            };
          },
          async close() {}
        })
      }
    );
    const waited = JSON.parse(takeMessage(messages));
    assert.equal(waitStatus, 0);
    assert.equal(waited.ok, true);
    assert.equal(waited.data.waitAuthority, "appServer");
    assert.deepEqual(waited.data.threadIds, ["thread-from-appserver"]);
    assert.deepEqual(observedThreadIds, ["thread-from-appserver"]);
    assert.equal(waited.data.hostWaitRequired, false);
    assert.equal(waited.data.hostFallbackRequired, false);
    assert.equal(waited.data.hostSpawnRequired, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI Path A writer authorization fails closed before turn/start and retains the bound UUID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-delegate-cli-wait-endpoint-"));
  const { messages, output } = capturedOutput();
  const ownerThread = "11111111-2222-4333-8444-555555555555";
  const spawnClient = new CliPathAFakeClient(ownerThread);
  const restartClient = new CliPathAFakeClient(ownerThread);
  let created = 0;
  let adapter: ReturnType<typeof createCliAppServerAdapter> | undefined;
  try {
    await run(["init", directory], output);
    await mkdir(path.join(directory, "scope"));
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-ENDPOINT",
      "--objective", "Exercise exact cross-process wait authority",
      "--executor", "synod_implementer",
      "--acceptance", "Wait reads the exact owner UUID",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    await run(["task", "transition", "T-ENDPOINT", "READY", "--revision", "0", "--cwd", directory], output);

    adapter = createCliAppServerAdapter({
      runtime: { surface: "cli", executable: "codex" },
      profile: "portable",
      directory,
      clientFactory: () => {
        created += 1;
        return created === 1 ? spawnClient : restartClient;
      }
    });
    messages.length = 0;
    const startStatus = await run(
      ["delegate", "start", "T-ENDPOINT", "--write-tree", "scope", "--cwd", directory, "--json"],
      output,
      {
        hostRuntimeResolver: () => ({
          surface: "cli",
          executable: "codex",
          executableSource: "PATH",
          resolved: true
        }),
        cliAppServerAdapterFactory: () => adapter!
      }
    );
    const start = JSON.parse(takeMessage(messages));
    assert.equal(startStatus, 1);
    assert.equal(start.ok, false, JSON.stringify(start));
    assert.equal(start.error.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
    assert.equal(start.error.details.ownerThread, ownerThread);
    assert.equal(start.error.details.lease.ownerThread, ownerThread);
    assert.equal(start.error.details.lease.status, "ACTIVE");
    assert.equal(start.error.details.recovery.status, "lease-bound-awaiting-authorization");
    assert.equal(start.error.details.authorization.status, "failed");
    assert.equal(start.error.details.authorization.code, ERROR_CODES.APP_SERVER_UNSUPPORTED);
    assert.equal(start.error.details.authorization.details.phase, "before-turn/start");
    assert.equal(start.error.details.authorization.details.authority, "effective-writable-boundary");
    assert.equal(start.error.details.cause.code, ERROR_CODES.APP_SERVER_UNSUPPORTED);
    assert.deepEqual(spawnClient.calls.map(call => call.method), ["thread/start"]);
    assert.equal(spawnClient.calls[0]?.params.model, "gpt-5.5");
    assert.equal(spawnClient.calls.some(call => call.method === "turn/start"), false);
    assert.equal(created, 1);
    assert.equal(restartClient.calls.some(call => call.method === "thread/read"), false);
    assert.equal(findCliAppServerWaitClient(directory, ownerThread), undefined);
  } finally {
    await adapter?.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production delegate start retains the bound owner for the next same-shell wait", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-delegate-cli-production-boundary-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const ownerThread = "22222222-3333-4444-8555-666666666666";
  await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
const ownerThread = ${JSON.stringify(ownerThread)};
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const thread = () => ({ id: ownerThread, cliVersion: "0.148.0", cwd: process.cwd(), status: { type: "idle" }, turns: [] });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
  else if (message.method === "thread/start") reply(message.id, { thread: { ...thread(), model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "readOnly" } } });
  else if (message.method === "thread/read") reply(message.id, { thread: thread() });
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const { messages, output } = capturedOutput();
  const runtime = {
    surface: "cli" as const,
    executable: fakeCodex,
    executableSource: "test",
    resolved: true
  };
  try {
    await run(["init", directory], output);
    await mkdir(path.join(directory, "scope"));
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-PRODUCTION-BOUNDARY",
      "--objective", "Retain exact owner after the pre-turn writer fence",
      "--executor", "synod_implementer",
      "--acceptance", "The exact owner remains observable after typed authorization failure",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    await run(["task", "transition", "T-PRODUCTION-BOUNDARY", "READY", "--revision", "0", "--cwd", directory], output);

    messages.length = 0;
    const startedAt = Date.now();
    const startStatus = await run(
      ["delegate", "start", "T-PRODUCTION-BOUNDARY", "--write-tree", "scope", "--cwd", directory, "--json"],
      output,
      {
        hostRuntimeResolver: () => runtime,
        cliAppServerAdapterFactory: () => createCliAppServerAdapter({ runtime, directory, profile: "portable" })
      }
    );
    const start = JSON.parse(takeMessage(messages));
    assert.ok(Date.now() - startedAt < 5_000, "typed pre-turn failure must return promptly");
    assert.equal(startStatus, 1);
    assert.equal(start.ok, false, JSON.stringify(start));
    assert.equal(start.error.code, ERROR_CODES.HOST_AUTHORIZATION_FAILED);
    assert.equal(start.error.details.ownerThread, ownerThread);
    assert.equal(start.error.details.lease.ownerThread, ownerThread);
    assert.equal(start.error.details.lease.status, "ACTIVE");
    assert.equal(start.error.details.authorization.details.phase, "before-turn/start");
    assert.equal(start.error.details.authorization.details.authority, "effective-writable-boundary");
    assert.equal(start.error.details.authorization.details.retainedForObservation, true);

    messages.length = 0;
    const waitStatus = await run(
      ["wait", "--task", "T-PRODUCTION-BOUNDARY", "--cwd", directory, "--json"],
      output,
      { waitRuntimeResolver: () => runtime }
    );
    const waited = JSON.parse(takeMessage(messages));
    assert.equal(waitStatus, 0);
    assert.equal(waited.ok, true, JSON.stringify(waited));
    assert.equal(waited.data.waitAuthority, "appServer");
    assert.deepEqual(waited.data.threadIds, [ownerThread]);
    assert.equal(waited.data.hostWaitRequired, false);
    assert.equal(waited.data.hostFallbackRequired, false);

    for (let attempt = 0; attempt < 100 && findCliAppServerWaitClient(directory, ownerThread); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(findCliAppServerWaitClient(directory, ownerThread), undefined, "wait cleanup must remove the retained owner endpoint");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI delegate start on Desktop reserves a host spawn handoff", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-delegate-handoff-"));
  const { messages, output } = capturedOutput();
  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-HOST",
      "--objective", "Exercise Desktop host handoff",
      "--executor", "synod_implementer",
      "--acceptance", "Reservation is returned",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    await run(["task", "transition", "T-HOST", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;
    const startStatus = await run(
      ["delegate", "start", "T-HOST", "--write", "AGENTS.md", "--cwd", directory, "--json"],
      output,
      {
        hostRuntimeResolver: () => ({
          surface: "desktop",
          executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
          executableSource: "desktop-process",
          resolved: true
        })
      }
    );
    const start = JSON.parse(takeMessage(messages));
    assert.equal(startStatus, 1);
    assert.equal(start.ok, true);
    assert.equal(start.data.hostSpawnRequired, true);
    assert.equal(start.data.nextCommand.operation, "delegate.complete");
    assert.equal(start.data.probe.constructedAppServer, false);
    assert.equal(start.data.readOnlyContract.writeAuthorized, false);

    messages.length = 0;
    const completeStatus = await run(
      ["delegate", "complete", "T-HOST", "--owner-thread", "thread:desktop-worker", "--cwd", directory, "--json"],
      output
    );
    const complete = JSON.parse(takeMessage(messages));
    assert.equal(completeStatus, 0);
    assert.equal(complete.ok, true);
    assert.equal(complete.data.ownerThread, "thread:desktop-worker");
    assert.equal(complete.data.authorization.status, "accepted");
    assert.equal(complete.data.hostNotificationRequired, true);
    assert.deepEqual(complete.data.nextCommand, {
      operation: "wait.task",
      argv: ["wait", "--task", "T-HOST"],
      requirements: []
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI delegate start fails closed when SYNOD_HOST_ADAPTER is set", async () => {
  const { messages, output } = capturedOutput();
  const status = await run(["delegate", "start", "T-HOST", "--json"], output, {
    hostAdapterEnv: { SYNOD_HOST_ADAPTER: "unix:/tmp/missing.sock" },
    hostRuntimeResolver: () => ({
      surface: "desktop",
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      executableSource: "desktop-process",
      resolved: true
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.HOST_ADAPTER_INVALID);
});

test("wait still hands off on Desktop when SYNOD_HOST_ADAPTER is unsupported", async () => {
  const { messages, output } = capturedOutput();
  let created = false;
  const status = await run(["wait", "--thread", "thread:one", "--json"], output, {
    hostAdapterEnv: { SYNOD_HOST_ADAPTER: "unix:/tmp/missing.sock" },
    waitClientFactory: () => {
      created = true;
      return {
        async start() {},
        async request() { return {}; },
        async close() {}
      };
    },
    waitRuntimeResolver: () => ({
      surface: "desktop",
      executable: "/tmp/codex-desktop",
      executableSource: "desktop-process",
      resolved: true
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 1);
  assert.equal(created, false);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.mode, "handoff");
  assert.equal(envelope.data.waitAuthority, "host");
  assert.equal(envelope.data.hostWaitRequired, true);
  assert.deepEqual(envelope.data.hostWaitThreadIds, ["thread:one"]);
});

test("delegate timeout and poll options require explicit waiting", () => {
  for (const args of [
    ["start", "T-001", "--timeout-seconds", "10"],
    ["start", "T-001", "--poll-interval-ms", "200"]
  ]) {
    assert.throws(
      () => parseDelegateArgs(args),
      error => error instanceof Error
        && (error as Error & { code?: string }).code === ERROR_CODES.WAIT_INVALID
    );
  }
  const parsed = parseDelegateArgs([
    "start", "T-001", "--timeout-seconds", "10", "--poll-interval-ms", "200", "--wait"
  ]);
  assert.equal("help" in parsed, false);
  if ("help" in parsed) return;
  assert.equal(parsed.action, "start");
  assert.equal(parsed.action === "start" ? parsed.wait : false, true);
  assert.equal(parsed.action === "start" ? parsed.timeoutMs : 0, 10_000);
  assert.equal(parsed.action === "start" ? parsed.pollIntervalMs : 0, 200);
});

test("typed task-next and proposal-submit parsing reject copied transition fences", () => {
  assert.deepEqual(parseTaskArgs(["next", "--cwd", "/tmp/project", "--json"]), {
    action: "next",
    directory: "/tmp/project",
    json: true,
    actor: "supervisor"
  });
  assert.deepEqual(parseTaskArgs([
    "correct", "t-api", "--revision", "2", "--reason", "review feedback", "--evidence", "review:one", "--cwd", "/tmp/project", "--json"
  ]), {
    action: "correct",
    id: "t-api",
    revision: 2,
    reason: "review feedback",
    evidence: ["review:one"],
    directory: "/tmp/project",
    json: true,
    actor: "supervisor"
  });
  assert.throws(
    () => parseTaskArgs(["correct", "t-api", "--reason", "review feedback", "--evidence", "review:one"]),
    error => error instanceof Error && error.message.includes("--revision")
  );
  assert.deepEqual(parseProposalArgs([
    "submit", "t-api", "--evidence", "test:pass", "--evidence", "test:pass", "--cwd", "/tmp/project", "--json"
  ]), {
    action: "submit",
    id: "t-api",
    evidence: ["test:pass"],
    directory: "/tmp/project",
    json: true,
    actor: "supervisor"
  });
  assert.throws(
    () => parseProposalArgs(["submit", "T-API", "--revision", "1", "--evidence", "test:pass"]),
    error => error instanceof Error && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
  );
});

test("task add parses explicit planned file and tree lanes", () => {
  assert.deepEqual(parseTaskArgs([
    "add", "T-PLANNED",
    "--objective", "Plan exact lanes",
    "--executor", "synod_implementer",
    "--acceptance", "The lanes are retained",
    "--verification", "pnpm test",
    "--planned-write", "src/a.ts",
    "--planned-write-tree", "src/generated",
    "--planned-read", "README.md",
    "--planned-read-tree", "docs"
  ]), {
    action: "add",
    id: "T-PLANNED",
    objective: "Plan exact lanes",
    executor: "synod_implementer",
    acceptance: ["The lanes are retained"],
    verification: ["pnpm test"],
    dependsOn: [],
    plannedRead: ["README.md"],
    plannedWrite: ["src/a.ts"],
    plannedReadTree: ["docs"],
    plannedWriteTree: ["src/generated"],
    directory: ".",
    json: false,
    actor: "supervisor"
  });
});

test("recognized nested help wins before positional validation and mutation", async () => {
  const parserCases = [
    { parser: parseLeaseArgs, actions: ["reserve", "bind", "cancel", "acquire", "heartbeat", "release", "expire", "revoke", "recover"] },
    { parser: parseWorktreeArgs, actions: ["create", "seal", "integrate", "cleanup", "status"] },
    { parser: parseTaskArgs, actions: ["add", "transition", "correct", "override", "split", "next"] },
    { parser: parseProposalArgs, actions: ["submit"] }
  ];
  for (const { parser, actions } of parserCases) {
    for (const action of actions) assert.deepEqual(parser([action, "--help"]), { help: true });
  }
  assert.deepEqual(parseTaskArgs(["next", "--json", "--help"]), { help: true });
  assert.deepEqual(parseTaskArgs(["add", "T-1", "--help"]), { help: true });
  assert.deepEqual(parseProposalArgs(["submit", "T-1", "--help"]), { help: true });
  assert.throws(
    () => parseLeaseArgs(["unknown", "--help"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNEXPECTED_ARGUMENT
      && error.message === "Unknown lease action: unknown"
  );
  assert.throws(
    () => parseWorktreeArgs(["unknown", "--help"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNEXPECTED_ARGUMENT
      && error.message === "Unknown worktree action: unknown"
  );
  assert.throws(
    () => parseTaskArgs(["unknown", "--help"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNEXPECTED_ARGUMENT
      && error.message === "Unknown task action: unknown"
  );
  assert.throws(
    () => parseProposalArgs(["unknown", "--help"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNEXPECTED_ARGUMENT
      && error.message === "Unknown proposal action: unknown"
  );
  assert.throws(() => parseLeaseArgs(["reserve"]), /Lease reserve is missing its task ID/);
  assert.throws(() => parseWorktreeArgs(["create"]), /Worktree create is missing its task ID/);
  assert.throws(() => parseTaskArgs(["add"]), /Task add is missing required positional arguments/);
  assert.throws(() => parseProposalArgs(["submit"]), /Proposal submit requires a task ID/);
  for (const { parser, action } of [
    { parser: parseLeaseArgs, action: "reserve" },
    { parser: parseWorktreeArgs, action: "create" },
    { parser: parseTaskArgs, action: "add" },
    { parser: parseProposalArgs, action: "submit" }
  ]) {
    assert.throws(
      () => parser([action, "T-1", "--not-a-real-option", "--help"]),
      error => error instanceof Error
        && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
        && error.message === "Unknown option: --not-a-real-option"
    );
  }
  assert.throws(
    () => parseTaskArgs(["next", "--not-a-real-option", "--help"]),
    error => error instanceof Error
      && (error as Error & { code?: string }).code === ERROR_CODES.UNKNOWN_OPTION
      && error.message === "Unknown option: --not-a-real-option"
  );

  const { messages, output } = capturedOutput();
  let mutationCalls = 0;
  const dependencies = {
    beforeMutationHook() { mutationCalls += 1; },
    worktreeDependencies: { worktreeHook() { mutationCalls += 1; } }
  };
  for (const args of [
    ["lease", "reserve", "--help"],
    ["lease", "bind", "-h"],
    ["worktree", "create", "--help"],
    ["task", "add", "-h"],
    ["proposal", "submit", "--help"],
    ["task", "next", "--json", "--help"],
    ["task", "add", "T-1", "--help"],
    ["proposal", "submit", "T-1", "--help"]
  ]) {
    messages.length = 0;
    assert.equal(await run(args, output, dependencies), 0);
    assert.match(takeMessage(messages), /synod task add/);
  }
  assert.equal(mutationCalls, 0);
});

test("wait accepts repeatable mixed task and thread selectors", async () => {
  const { messages, output } = capturedOutput();
  const status = await run([
    "wait",
    "--task", "t-api",
    "--task", "T-API",
    "--thread", "thread:reader",
    "--json"
  ], output, {
    waitSelectionResolver: async options => {
      assert.deepEqual(options, {
        directory: process.cwd(),
        taskIds: ["T-API"],
        threadIds: ["thread:reader"]
      });
      return {
        requestedTaskIds: ["T-API"],
        requestedThreadIds: ["thread:reader"],
        tasks: [{
          taskId: "T-API",
          state: "ACTIVE",
          revision: 2,
          leaseId: "lease:api",
          generation: 3,
          ownerThread: "thread:writer",
          expectedHeartbeatAt: "2026-08-18T00:00:00.000Z"
        }],
        threadIds: ["thread:writer", "thread:reader"]
      };
    },
    waitAdapterFactory: () => ({
      async start() {},
      capabilities() { return { notification: false, cursor: false }; },
      async read(threadIds) {
        return { statuses: threadIds.map(threadId => ({ threadId, status: { type: "idle" as const } })) };
      },
      async close() {}
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 0);
  assert.deepEqual(envelope.data.selection.tasks, [{
    taskId: "T-API",
    state: "ACTIVE",
    revision: 2,
    leaseId: "lease:api",
    generation: 3,
    ownerThread: "thread:writer",
    expectedHeartbeatAt: "2026-08-18T00:00:00.000Z"
  }]);
  assert.deepEqual(envelope.data.threadIds, ["thread:writer", "thread:reader"]);
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

test("doctor preserves divergent project version truth in JSON and text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-doctor-versions-test-"));
  const { messages, output } = capturedOutput();
  const manifestPath = path.join(directory, ".synod/manifest.json");
  const runtimePath = path.join(directory, ".synod/runtime.json");
  const doctorDependencies = {
    doctorRuntimeResolver: () => ({
      surface: "cli",
      executable: "codex",
      executableSource: "test",
      resolved: true
    }),
    doctorClientFactory: () => ({
      async start() {},
      async probeCapabilities() {},
      async listModels() {
        return [{ id: "gpt-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] }];
      },
      async close() {},
      getWarnings() { return []; },
      getDiagnostics() {
        return {
          codexVersion: "0.148.0",
          codexSurface: "cli",
          appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
        };
      }
    })
  };

  try {
    await run(["init", directory], output);
    messages.length = 0;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.templateVersion = "0.9.1";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(runtimePath, `${JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: "0.9.3",
      packageSpec: packageVersion,
      packageName,
      packageManager: "pnpm",
      runtimeDirectory: ".synod/runtime",
      executable: `.synod/runtime/node_modules/${packageName}/bin/synod.js`
    }, null, 2)}\n`, "utf8");

    const jsonStatus = await run(["doctor", directory, "--json"], output, doctorDependencies);
    const doctor = JSON.parse(takeMessage(messages));
    assert.equal(jsonStatus, 1);
    const doctorData = doctor.ok ? doctor.data : doctor.error.details;
    assert.equal(doctorData.project.runtimeVersion, "0.9.3");
    assert.equal(doctorData.project.installedTemplateVersion, "0.9.1");
    assert.equal(doctorData.project.stateTemplateVersion, packageVersion);
    assert.equal(doctorData.project.templateVersion, "0.9.1");

    messages.length = 0;
    const textStatus = await run(["doctor", directory], output, doctorDependencies);
    const text = takeMessage(messages);
    assert.equal(textStatus, 1);
    assert.match(text, /Project runtime: 0\.9\.3/);
    assert.match(text, /Project installed template: 0\.9\.1/);
    assert.match(text, new RegExp(`Project state template: ${packageVersion.replaceAll(".", "\\.")}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor text identifies the Desktop executable, version, and shared Codex home", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-doctor-text-test-"));
  const { messages, output } = capturedOutput();
  const executable = "/Applications/ChatGPT.app/Contents/Resources/codex";

  try {
    const status = await run(["doctor", directory], output, {
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
            codexVersion: "0.148.0-alpha.9",
            appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
          };
        }
      })
    });

    assert.equal(status, 0);
    assert.match(messages[0] ?? "", /Codex Desktop: 0\.148\.0-alpha\.9 \(known-good; desktop\)/);
    assert.match(messages[0] ?? "", /Codex executable: \/Applications\/ChatGPT\.app\/Contents\/Resources\/codex \(desktop-process\)/);
    assert.match(messages[0] ?? "", /Codex home: \/Users\/test\/\.codex/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared client factories receive the doctor runtime executable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-doctor-factory-test-"));
  const { output } = capturedOutput();
  const executable = "/opt/codex/bin/codex";
  const receivedExecutables: Array<string | undefined> = [];

  try {
    const status = await run(["doctor", directory], output, {
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
              codexVersion: "0.148.0-alpha.9",
              appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
            };
          }
        };
      }
    });

    assert.equal(status, 0);
    assert.deepEqual(receivedExecutables, [executable]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal(status.data.runtimeVersion, null);
    assert.equal(status.data.installedTemplateVersion, packageVersion);
    assert.equal(status.data.stateTemplateVersion, packageVersion);
    assert.equal(status.data.templateVersion, packageVersion);

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

    const checkTextCode = await run(["check", directory], output);
    assert.equal(checkTextCode, 0);
    const checkText = takeMessage(messages);
    assert.match(checkText, /Installed template:/);
    assert.match(checkText, /State template:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status selectors bound task and checkpoint output in text and JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-status-selector-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    await run([
      "task", "add", "T-SELECT",
      "--objective", "Exercise status task selection",
      "--executor", "synod_implementer",
      "--acceptance", "The task is selected",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    await run(["task", "transition", "T-SELECT", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const taskCode = await run(["status", directory, "--task", " t-select ", "--json"], output);
    const taskEnvelope = JSON.parse(takeMessage(messages));
    assert.equal(taskCode, 0);
    assert.equal(taskEnvelope.ok, true);
    assert.deepEqual(taskEnvelope.data.tasks.map((task: { id: string }) => task.id), ["T-SELECT"]);
    assert.equal(taskEnvelope.data.selection.type, "task");
    assert.equal(taskEnvelope.data.selection.taskId, "T-SELECT");

    const textCode = await run(["status", directory, "--active-only"], output);
    const text = takeMessage(messages);
    assert.equal(textCode, 0);
    assert.match(text, /Selection: active-only/);
    assert.match(text, /T-SELECT/);

    const changedTextCode = await run(["status", directory, "--changed-since-checkpoint"], output);
    const changedText = takeMessage(messages);
    assert.equal(changedTextCode, 0);
    assert.match(changedText, /Selection: changed-since-checkpoint/);

    const unknownCode = await run(["status", directory, "--task", "T-MISSING", "--json"], output);
    const unknown = JSON.parse(takeMessage(messages));
    assert.equal(unknownCode, 1);
    assert.equal(unknown.error.code, ERROR_CODES.TASK_NOT_FOUND);

    const duplicateCode = await run(["status", directory, "--task", "T-SELECT", "--task", "T-SELECT", "--json"], output);
    const duplicate = JSON.parse(takeMessage(messages));
    assert.equal(duplicateCode, 1);
    assert.equal(duplicate.error.code, ERROR_CODES.UNKNOWN_OPTION);

    const incompatibleCode = await run(["status", directory, "--active-only", "--changed-since-checkpoint", "--json"], output);
    const incompatible = JSON.parse(takeMessage(messages));
    assert.equal(incompatibleCode, 1);
    assert.equal(incompatible.error.code, ERROR_CODES.UNKNOWN_OPTION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease commands expose durable owner, generation, and heartbeat state through JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-lease-json-test-"));
  const { messages, output } = capturedOutput();
  let ownerServer: ReturnType<typeof createServer> | undefined;
  let ownerEndpoint: ReturnType<typeof cliAppServerEndpointPaths> | undefined;

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
    ownerEndpoint = cliAppServerEndpointPaths(directory, "thread:cli");
    await mkdir(path.dirname(ownerEndpoint.socketPath), { recursive: true, mode: 0o700 });
    await writeFile(ownerEndpoint.metadataPath, JSON.stringify({
      version: 1,
      threadId: "thread:cli",
      directory: path.resolve(directory),
      token: "thread-cli-token",
      expiresAt: Date.now() + 60_000,
      socketPath: ownerEndpoint.socketPath
    }), { encoding: "utf8", mode: 0o600 });
    ownerServer = createServer(socket => {
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        const request = JSON.parse(String(chunk));
        assert.equal(request.method, "close");
        socket.write(JSON.stringify({ ok: true }) + "\n");
        socket.end();
        ownerServer?.close();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ownerServer!.once("error", reject);
      ownerServer!.listen(ownerEndpoint!.socketPath, resolve);
    });
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
    assert.deepEqual(revoked.data.ownerCleanup, { ownerThread: "thread:cli", status: "closed" });
    assert.equal(findCliAppServerWaitClient(directory, "thread:cli"), undefined);

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
    assert.deepEqual(recovered.data.ownerCleanup, { ownerThread: "thread:cli", status: "not-found" });
  } finally {
    if (ownerServer?.listening) {
      await new Promise<void>(resolve => ownerServer!.close(() => resolve()));
    }
    if (ownerEndpoint) {
      await rm(ownerEndpoint.metadataPath, { force: true });
      await rm(ownerEndpoint.socketPath, { force: true });
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only lease scopes acquire observer leases through the CLI", async () => {
  const parsedObserverAcquire = parseLeaseArgs(["acquire", "T-001", "--owner-thread", "thread:x", "--read", "src/a.ts"]);
  assert.equal("observer" in parsedObserverAcquire && parsedObserverAcquire.observer === true, true);
  const parsedWriterAcquire = parseLeaseArgs(["acquire", "T-001", "--owner-thread", "thread:x", "--write", "src/b.ts"]);
  assert.equal("observer" in parsedWriterAcquire, false);
  const parsedObserverReserve = parseLeaseArgs(["reserve", "T-001", "--read-tree", "docs"]);
  assert.equal("observer" in parsedObserverReserve && parsedObserverReserve.observer === true, true);

  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-observer-lease-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    messages.length = 0;
    await run([
      "task", "add", "T-OBS",
      "--objective", "Observe without writes",
      "--executor", "synod_implementer",
      "--acceptance", "The observer lease is fenced",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    messages.length = 0;
    await run(["task", "transition", "T-OBS", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const acquireCode = await run([
      "lease", "acquire", "T-OBS",
      "--owner-thread", "thread:obs",
      "--read", "src/observed.ts",
      "--read-tree", "docs",
      "--cwd", directory,
      "--json"
    ], output);
    const acquired = JSON.parse(takeMessage(messages));
    assert.equal(acquireCode, 0);
    assert.equal(acquired.data.action, "acquire");
    assert.equal(acquired.data.lease.observer, true);
    assert.deepEqual(acquired.data.lease.scopes, [
      { path: "docs", access: "read", kind: "tree" },
      { path: "src/observed.ts", access: "read", kind: "file" }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delegate start parses only the three supported delegation roles", () => {
  const roleOf = (value: ReturnType<typeof parseDelegateArgs>) => "role" in value ? value.role : undefined;
  assert.equal(roleOf(parseDelegateArgs(["start", "T-001"])), undefined);
  assert.equal(roleOf(parseDelegateArgs(["start", "T-001", "--role", "reviewer"])), "reviewer");
  assert.equal(roleOf(parseDelegateArgs(["start", "T-001", "--role", "verifier"])), "verifier");
  assert.throws(
    () => parseDelegateArgs(["start", "T-001", "--role", "explorer"]),
    error => error instanceof Error
      && "code" in error
      && (error as Error & { code?: string }).code === ERROR_CODES.DELEGATION_ROLE_INVALID
  );
});

test("lease reservation commands expose the pre-spawn and post-bind authorization boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-reservation-json-test-"));
  const { messages, output } = capturedOutput();
  const addReady = async (id: string) => {
    await run([
      "task", "add", id,
      "--objective", `Reserve ${id}`,
      "--executor", "synod_implementer",
      "--acceptance", "The reservation is fenced",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    messages.length = 0;
    await run(["task", "transition", id, "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;
  };
  const fence = (reservation: Record<string, unknown>, reservationToken = String(reservation.token)) => [
    "--reservation-token", reservationToken,
    "--lease-id", String(reservation.id),
    "--generation", String(reservation.generation),
    "--revision", String(reservation.taskRevision),
    "--expected-reserved-at", String(reservation.reservedAt),
    "--baseline-hash", String((reservation.baseline as Record<string, unknown>).snapshotContentHash)
  ];

  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    messages.length = 0;
    await addReady("T-RESERVE");
    await addReady("T-CANCEL");
    await addReady("T-SUMMARY");

    const reserveCode = await run([
      "lease", "reserve", "T-RESERVE",
      "--write", "src/reserved.ts",
      "--reservation-ttl-seconds", "120",
      "--cwd", directory,
      "--json"
    ], output);
    const reserved = JSON.parse(takeMessage(messages));
    assert.equal(reserveCode, 0);
    assert.equal(reserved.data.action, "reserve");
    assert.equal(reserved.data.writeAuthorized, false);
    assert.equal(reserved.data.task.state, "READY");
    assert.match(reserved.data.reservation.token, /^[0-9a-f-]{36}$/);

    const handoffCode = await run(["handoff", directory, "--json"], output);
    const handoffJson = takeMessage(messages);
    const handoff = JSON.parse(handoffJson);
    const handoffReservation = handoff.data.tasks.find((task: Record<string, unknown>) => task.id === "T-RESERVE").leaseReservation;
    assert.equal(handoffCode, 0);
    assert.equal(handoffReservation.id, reserved.data.reservation.id);
    assert.equal(Object.hasOwn(handoffReservation, "token"), false);
    assert.equal(handoffJson.includes(reserved.data.reservation.token), false);

    const invalidReservationToken = "11111111-1111-4111-8111-111111111111";
    const staleBindCode = await run([
      "lease", "bind", "T-RESERVE",
      ...fence(reserved.data.reservation, invalidReservationToken),
      "--owner-thread", "thread:untrusted",
      "--cwd", directory,
      "--json"
    ], output);
    const staleBind = JSON.parse(takeMessage(messages));
    const serializedStaleBind = JSON.stringify(staleBind);
    assert.equal(staleBindCode, 1);
    assert.equal(staleBind.error.code, ERROR_CODES.LEASE_RESERVATION_STALE);
    assert.equal(staleBind.error.details.reservationTokenMatches, false);
    assert.equal(serializedStaleBind.includes(invalidReservationToken), false);
    assert.equal(serializedStaleBind.includes(reserved.data.reservation.token), false);

    const bindCode = await run([
      "lease", "bind", "T-RESERVE",
      ...fence(reserved.data.reservation),
      "--owner-thread", "thread:spawned",
      "--ttl-seconds", "120",
      "--heartbeat-seconds", "30",
      "--cwd", directory,
      "--json"
    ], output);
    const bound = JSON.parse(takeMessage(messages));
    assert.equal(bindCode, 0);
    assert.equal(bound.data.action, "bind");
    assert.equal(bound.data.writeAuthorized, true);
    assert.equal(bound.data.task.state, "ACTIVE");
    assert.equal(bound.data.lease.id, reserved.data.reservation.id);
    assert.equal(bound.data.lease.ownerThread, "thread:spawned");
    assert.deepEqual(bound.data.evidence, []);
    assert.deepEqual(bound.data.activation, {
      taskId: "T-RESERVE",
      revision: 0,
      leaseId: reserved.data.reservation.id,
      generation: reserved.data.reservation.generation,
      ownerThread: "thread:spawned",
      boundAt: bound.data.lease.acquiredAt,
      event: bound.data.lastEvent,
      writeAuthorized: true,
      supervisorNotification: { status: "required-not-observed" },
      followUp: {
        operation: "wait",
        arguments: { taskIds: ["T-RESERVE"] },
        requirements: []
      }
    });
    assert.equal(JSON.stringify(bound).includes(reserved.data.reservation.token), false);

    const summaryReserveCode = await run([
      "lease", "reserve", "T-SUMMARY",
      "--write", "src/activation-summary.ts",
      "--cwd", directory,
      "--json"
    ], output);
    const summaryReserved = JSON.parse(takeMessage(messages));
    assert.equal(summaryReserveCode, 0);
    const summaryBindCode = await run([
      "lease", "bind", "T-SUMMARY",
      ...fence(summaryReserved.data.reservation),
      "--owner-thread", "thread:summary",
      "--cwd", directory,
      "--json", "--view", "summary"
    ], output);
    const summaryBound = JSON.parse(takeMessage(messages));
    assert.equal(summaryBindCode, 0);
    assert.equal(summaryBound.data.writeAuthorized, true);
    assert.deepEqual(summaryBound.data.activation.followUp, {
      operation: "wait",
      arguments: { taskIds: ["T-SUMMARY"] },
      requirements: []
    });
    assert.deepEqual(summaryBound.data.activation.event, summaryBound.data.lastEvent);
    assert.equal(summaryBound.data.activation.supervisorNotification.status, "required-not-observed");
    assert.equal(JSON.stringify(summaryBound).includes(summaryReserved.data.reservation.token), false);

    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src/reserved.ts"), "reserved\n", "utf8");
    const reviewCode = await run([
      "task", "transition", "T-RESERVE", "REVIEW",
      "--revision", "1",
      "--evidence", "delivery:initial",
      "--cwd", directory
    ], output);
    assert.equal(reviewCode, 0);
    messages.length = 0;
    const correctionReserveCode = await run([
      "lease", "reserve", "T-RESERVE",
      "--write", "src/reserved.ts",
      "--cwd", directory,
      "--json"
    ], output);
    const correctionReserved = JSON.parse(takeMessage(messages));
    assert.equal(correctionReserveCode, 0);
    const correctionBindCode = await run([
      "lease", "bind", "T-RESERVE",
      ...fence(correctionReserved.data.reservation),
      "--owner-thread", "thread:correction",
      "--evidence", "review:changes-requested",
      "--cwd", directory
    ], output);
    assert.equal(correctionBindCode, 0);
    assert.match(messages.join("\n"), /Recorded evidence E-\d+: correction @ revision 1\./);
    messages.length = 0;

    const cancelReserveCode = await run([
      "lease", "reserve", "T-CANCEL",
      "--write", "src/cancelled.ts",
      "--cwd", directory,
      "--json"
    ], output);
    const cancelReserved = JSON.parse(takeMessage(messages));
    assert.equal(cancelReserveCode, 0);
    const cancelCode = await run([
      "lease", "cancel", "T-CANCEL",
      ...fence(cancelReserved.data.reservation),
      "--reason", "spawn failed",
      "--cwd", directory,
      "--json"
    ], output);
    const cancelled = JSON.parse(takeMessage(messages));
    assert.equal(cancelCode, 0);
    assert.equal(cancelled.data.action, "cancel");
    assert.equal(cancelled.data.writeAuthorized, false);
    assert.equal(cancelled.data.task.state, "READY");
    assert.equal(cancelled.data.task.recovery, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer bind activation is read-only and offers an exact lease release", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-observer-bind-test-"));
  const { messages, output } = capturedOutput();
  const fence = (reservation: Record<string, unknown>) => [
    "--reservation-token", String(reservation.token),
    "--lease-id", String(reservation.id),
    "--generation", String(reservation.generation),
    "--revision", String(reservation.taskRevision),
    "--expected-reserved-at", String(reservation.reservedAt),
    "--baseline-hash", String((reservation.baseline as Record<string, unknown>).snapshotContentHash)
  ];

  try {
    await run(["init", directory], output);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src/observed.ts"), "observed\n", "utf8");
    initializeGitHead(directory);
    messages.length = 0;
    await run([
      "task", "add", "T-OBSERVER",
      "--objective", "Observe a task without changing lifecycle state",
      "--executor", "synod_implementer",
      "--acceptance", "The observer remains read-only",
      "--verification", "pnpm test",
      "--cwd", directory
    ], output);
    messages.length = 0;
    await run(["task", "transition", "T-OBSERVER", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const reserveCode = await run([
      "lease", "reserve", "T-OBSERVER",
      "--read", "src/observed.ts",
      "--cwd", directory,
      "--json"
    ], output);
    const reserved = JSON.parse(takeMessage(messages));
    assert.equal(reserveCode, 0);

    const bindCode = await run([
      "lease", "bind", "T-OBSERVER",
      ...fence(reserved.data.reservation),
      "--owner-thread", "thread:observer",
      "--cwd", directory,
      "--json"
    ], output);
    const bound = JSON.parse(takeMessage(messages));
    assert.equal(bindCode, 0);
    assert.equal(bound.data.writeAuthorized, false);
    assert.equal(bound.data.task.state, "READY");
    assert.deepEqual(bound.data.activation.followUp, {
      operation: "lease.release",
      arguments: {
        taskId: "T-OBSERVER",
        leaseId: bound.data.lease.id,
        generation: bound.data.lease.generation,
        revision: bound.data.lease.taskRevision,
        expectedHeartbeatAt: bound.data.lease.heartbeatAt,
        ownerThread: "thread:observer"
      },
      requirements: []
    });

    const releaseCode = await run([
      "lease", "release", "T-OBSERVER",
      "--lease-id", bound.data.lease.id,
      "--generation", String(bound.data.lease.generation),
      "--revision", String(bound.data.lease.taskRevision),
      "--expected-heartbeat-at", bound.data.lease.heartbeatAt,
      "--owner-thread", "thread:observer",
      "--cwd", directory,
      "--json"
    ], output);
    const released = JSON.parse(takeMessage(messages));
    assert.equal(releaseCode, 0);
    assert.equal(released.data.task.state, "READY");
    assert.equal(released.data.task.lease, undefined);
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
  assert.equal(envelope.data.waitAuthority, "appServer");
  assert.equal(envelope.data.mode, "poll");
  assert.deepEqual(envelope.data.threadIds, ["thread:one"]);
  assert.equal(envelope.data.fallbackPollCount, 0);
  assert.equal(envelope.data.incomplete, false);
  assert.equal(envelope.data.hostWaitRequired, false);
  assert.equal(envelope.diagnostics.closed, 1);
});

test("wait command returns an explicit Desktop host handoff without creating a child client", async () => {
  const { messages, output } = capturedOutput();
  let created = false;
  const status = await run([
    "wait",
    "--thread", "thread:one",
    "--cwd", "/tmp/project",
    "--json"
  ], output, {
    waitClientFactory: options => {
      created = true;
      return {
        async start() {},
        async request() {
          return { thread: { id: "thread:one", status: { type: "systemError" } } };
        },
        async close() {},
        supportsThreadStatusNotifications: () => false
      };
    },
    waitRuntimeResolver: () => ({
      surface: "desktop",
      executable: "/tmp/codex-desktop",
      executableSource: "desktop-process",
      resolved: true
    })
  });
  const envelope = JSON.parse(takeMessage(messages));

  assert.equal(status, 1);
  assert.equal(created, false);
  assert.equal(envelope.command, "wait");
  assert.equal(envelope.data.waitAuthority, "host");
  assert.equal(envelope.data.mode, "handoff");
  assert.equal(envelope.data.incomplete, true);
  assert.equal(envelope.data.approvalNeeded, false);
  assert.equal(envelope.data.userInputNeeded, false);
  assert.equal(envelope.data.hostWaitRequired, true);
  assert.deepEqual(envelope.data.hostWaitThreadIds, ["thread:one"]);
  assert.equal(Object.hasOwn(envelope.data, "nextCommand"), false);
});

test("wait returns a revoke next command when an observed owner stops", async () => {
  const { messages, output } = capturedOutput();
  const status = await run(["wait", "--task", "T-WAIT", "--json"], output, {
    waitSelectionResolver: async () => ({
      waitAuthority: "canonical" as const,
      requestedTaskIds: ["T-WAIT"],
      requestedThreadIds: [],
      tasks: [{
        taskId: "T-WAIT",
        state: "ACTIVE",
        revision: 1,
        leaseId: "lease-dead",
        generation: 2,
        ownerThread: "thread:dead",
        expectedHeartbeatAt: "2026-08-18T00:00:00.000Z"
      }],
      threadIds: ["thread:dead"]
    }),
    waitRuntimeResolver: () => ({
      surface: "cli",
      executable: "codex",
      executableSource: "PATH",
      resolved: true
    }),
    waitAdapterFactory: () => ({
      async start() {},
      capabilities: () => ({ notification: false, cursor: false }),
      async read() {
        return { statuses: [{ threadId: "thread:dead", status: { type: "systemError" as const } }] };
      },
      getDiagnostics() {
        return {
          waitLoss: {
            cause: "child-terminated",
            authority: "appServer",
            threadId: "thread:dead",
            directEvidence: true
          }
        };
      },
      async close() {}
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 1);
  assert.equal(envelope.data.childLoss, "child-dead-lease-live");
  assert.equal(envelope.diagnostics.childLoss, "child-dead-lease-live");
  assert.equal(envelope.data.nextCommand.operation, "lease.revoke");
  assert.deepEqual(envelope.data.nextCommand.argv, [
    "lease", "revoke", "T-WAIT",
    "--lease-id", "lease-dead",
    "--generation", "2",
    "--revision", "1",
    "--expected-heartbeat-at", "2026-08-18T00:00:00.000Z",
    "--reason", "worker-stopped"
  ]);
});

test("wait does not advertise revoke on timeout or notLoaded observation", async () => {
  const cases = [
    {
      args: ["wait", "--task", "T-WAIT", "--timeout-seconds", "1", "--poll-interval-ms", "100", "--json"],
      statuses: [{ threadId: "thread:live", status: { type: "active" as const, activeFlags: [] } }]
    },
    {
      args: ["wait", "--task", "T-WAIT", "--json"],
      statuses: [{ threadId: "thread:live", status: { type: "notLoaded" as const } }]
    }
  ];
  for (const item of cases) {
    const { messages, output } = capturedOutput();
    const status = await run(item.args, output, {
      waitSelectionResolver: async () => ({
        waitAuthority: "canonical" as const,
        requestedTaskIds: ["T-WAIT"],
        requestedThreadIds: [],
        tasks: [{
          taskId: "T-WAIT",
          state: "ACTIVE",
          revision: 1,
          leaseId: "lease-live",
          generation: 2,
          ownerThread: "thread:live",
          expectedHeartbeatAt: "2026-08-18T00:00:00.000Z"
        }],
        threadIds: ["thread:live"]
      }),
      waitRuntimeResolver: () => ({
        surface: "cli",
        executable: "codex",
        executableSource: "PATH",
        resolved: true
      }),
      waitAdapterFactory: () => ({
        async start() {},
        capabilities: () => ({ notification: false, cursor: false }),
        async read() {
          return { statuses: item.statuses };
        },
        async close() {}
      })
    });
    assert.equal(status, 1);
    const envelope = JSON.parse(takeMessage(messages));
    assert.ok(envelope.data);
    assert.equal(Object.hasOwn(envelope.data, "nextCommand"), false, JSON.stringify(item.statuses));
  }
});

test("wait uses the same host adapter resolver and does not request a host handoff", async () => {
  const { messages, output } = capturedOutput();
  let created = false;
  const status = await run([
    "wait",
    "--thread", "opaque-owner",
    "--json"
  ], output, {
    waitClientFactory: () => {
      created = true;
      return {
        async start() {},
        async request() { return {}; },
        async close() {}
      };
    },
    hostDelegationAdapterFactory: () => ({
      async spawn() { return "opaque-owner"; },
      async authorize() { return { status: "authorized" }; },
      async wait() {
        return {
          statuses: [{ threadId: "opaque-owner", status: { type: "idle" } }],
          mode: "notification",
          wakeCount: 1
        };
      }
    }),
    waitRuntimeResolver: () => ({
      surface: "desktop",
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      executableSource: "desktop-process",
      resolved: true
    })
  });
  const envelope = JSON.parse(takeMessage(messages));
  assert.equal(status, 0);
  assert.equal(created, false);
  assert.equal(envelope.data.waitAuthority, "host");
  assert.equal(envelope.data.incomplete, false);
  assert.equal(envelope.data.hostWaitRequired, false);
  assert.deepEqual(envelope.data.hostWaitThreadIds, []);
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

test("CLI summary view keeps status and lease mutation fences while full stays default", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-output-view-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    messages.length = 0;
    await run([
      "task", "add", "T-VIEW",
      "--objective", "Exercise summary output",
      "--executor", "synod_implementer",
      "--acceptance", "Summary keeps lifecycle",
      "--verification", "pnpm test",
      "--cwd", directory,
      "--json"
    ], output);
    messages.length = 0;
    await run(["task", "transition", "T-VIEW", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const fullCode = await run(["status", directory, "--json"], output);
    const full = JSON.parse(takeMessage(messages));
    assert.equal(fullCode, 0);
    assert.ok(full.data.tasks[0].evidence);
    assert.equal(Object.hasOwn(full.data, "selection"), false);

    const summaryCode = await run(["status", directory, "--json", "--view", "summary"], output);
    const summary = JSON.parse(takeMessage(messages));
    assert.equal(summaryCode, 0);
    assert.equal(summary.data.healthy, true);
    assert.equal(summary.data.tasks[0].state, "READY");
    assert.equal(Object.hasOwn(summary.data.tasks[0], "evidence"), false);
    assert.equal(Object.hasOwn(summary.data, "selection"), false);

    const reserveCode = await run([
      "lease", "reserve", "T-VIEW", "--write", "src/output-view.ts", "--cwd", directory,
      "--json", "--view", "summary"
    ], output);
    const reserved = JSON.parse(takeMessage(messages));
    assert.equal(reserveCode, 0);
    assert.deepEqual(reserved.data.nextOperation.fence, {
      reservationToken: reserved.data.reservation.token,
      leaseId: reserved.data.reservation.id,
      generation: reserved.data.reservation.generation,
      revision: reserved.data.reservation.taskRevision,
      expectedReservedAt: reserved.data.reservation.reservedAt,
      baselineHash: reserved.data.reservation.baseline.snapshotContentHash
    });

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI task-next summary preserves typed lease-reserve guidance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-task-next-summary-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-NEXT",
      "--objective", "Exercise task-next summary output",
      "--executor", "synod_implementer",
      "--acceptance", "Summary keeps guidance gates",
      "--verification", "pnpm test",
      "--cwd", directory,
      "--json"
    ], output);
    await run(["task", "transition", "T-NEXT", "READY", "--revision", "0", "--cwd", directory], output);
    messages.length = 0;

    const fullCode = await run(["task", "next", "--cwd", directory, "--json"], output);
    const full = JSON.parse(takeMessage(messages));
    assert.equal(fullCode, 0);
    const fullTask = full.data.guidance.tasks.find((task: { id: string }) => task.id === "T-NEXT");
    assert.ok(fullTask);
    assert.equal(fullTask.actions[0].operation, "delegate.start");
    assert.deepEqual(fullTask.actions[0].argv, ["delegate", "start", "T-NEXT"]);
    assert.ok(fullTask.constraints);
    assert.ok(fullTask.legalTransitions.includes("ACTIVE"));
    assert.ok(Object.hasOwn(fullTask, "incompleteDependencies"));
    assert.ok(Object.hasOwn(fullTask, "budget"));
    assert.ok(Object.hasOwn(fullTask, "recovery"));

    messages.length = 0;
    const summaryCode = await run(["task", "next", "--cwd", directory, "--json", "--view", "summary"], output);
    const summary = JSON.parse(takeMessage(messages));
    assert.equal(summaryCode, 0);
    const summaryTask = summary.data.guidance.tasks.find((task: { id: string }) => task.id === "T-NEXT");
    assert.ok(summaryTask);
    assert.equal(summaryTask.actions[0].operation, "delegate.start");
    assert.deepEqual(summaryTask.actions[0].argv, ["delegate", "start", "T-NEXT"]);
    assert.deepEqual(summaryTask.actions[0].arguments, {
      taskId: "T-NEXT",
      write: [],
      writeTree: [],
      read: [],
      readTree: []
    });
    assert.deepEqual(summaryTask.actions[0].requirements, ["write-scope"]);
    assert.deepEqual(summaryTask.legalTransitions, fullTask.legalTransitions);
    assert.deepEqual(summaryTask.constraints, fullTask.constraints);
    assert.deepEqual(summaryTask.incompleteDependencies, fullTask.incompleteDependencies);
    assert.deepEqual(summaryTask.budget, fullTask.budget);
    assert.deepEqual(summaryTask.recovery, fullTask.recovery);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI proposal summary exposes the exact acceptance action after releasing its lease", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-proposal-summary-test-"));
  const { messages, output } = capturedOutput();

  try {
    await run(["init", directory], output);
    await mkdir(path.join(directory, "src"), { recursive: true });
    initializeGitHead(directory);
    await run(["checkpoint", directory], output);
    await run([
      "task", "add", "T-PROPOSAL",
      "--objective", "Exercise proposal summary output",
      "--executor", "synod_implementer",
      "--acceptance", "The proposal can be accepted",
      "--verification", "pnpm test",
      "--cwd", directory,
      "--json"
    ], output);
    await run(["task", "transition", "T-PROPOSAL", "READY", "--revision", "0", "--cwd", directory], output);
    const acquireCode = await run([
      "lease", "acquire", "T-PROPOSAL",
      "--owner-thread", "thread:proposal",
      "--write", "src/proposal.ts",
      "--cwd", directory,
      "--json"
    ], output);
    assert.equal(acquireCode, 0);
    const activateCode = await run([
      "task", "transition", "T-PROPOSAL", "ACTIVE",
      "--revision", "0",
      "--cwd", directory
    ], output);
    assert.equal(activateCode, 0);
    await writeFile(path.join(directory, "src/proposal.ts"), "proposal\n", "utf8");
    messages.length = 0;

    const submitCode = await run([
      "proposal", "submit", "T-PROPOSAL",
      "--evidence", "test:proposal-summary",
      "--cwd", directory,
      "--json", "--view", "summary"
    ], output);
    const summary = JSON.parse(takeMessage(messages));
    assert.equal(submitCode, 0);
    assert.equal(summary.data.action, "submit");
    assert.deepEqual(summary.data.nextOperation, {
      operation: "task.transition",
      arguments: { taskId: "T-PROPOSAL", to: "ACCEPTED", revision: 1, evidence: [] },
      argv: ["task", "transition", "T-PROPOSAL", "ACCEPTED", "--revision", "1"],
      requirements: ["evidence"]
    });
    assert.equal(Object.hasOwn(summary.data.nextOperation, "fence"), false);
    assert.equal(summary.data.task.state, "REVIEW");
    assert.equal(summary.data.task.lease, null);
    assert.equal(summary.data.proposal.status, "SEALED");
    assert.equal(summary.data.evidenceCount, 1);
    assert.ok(summary.data.lastEvent);
    assert.ok(summary.data.checkpoint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
