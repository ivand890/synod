import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import type { AppServerChild } from "../src/app-server.js";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { isRecord } from "../src/validation.js";

interface FakeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type FakeHandler = (message: FakeRequest, child: FakeChild) => void;

class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: Writable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  readonly signals: NodeJS.Signals[];
  unreferenced: boolean;
  readonly exitOnTerm: boolean;
  readonly exitOnKill: boolean;

  constructor(onMessage?: FakeHandler, { exitOnTerm = true, exitOnKill = true }: {
    exitOnTerm?: boolean;
    exitOnKill?: boolean;
  } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.unreferenced = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).trimEnd().split("\n")) {
          if (line) {
            const message: unknown = JSON.parse(line);
            if (isRecord(message) && typeof message.id === "number" && typeof message.method === "string" && isRecord(message.params)) {
              onMessage?.({ id: message.id, method: message.method, params: message.params }, this);
            }
          }
        }
        callback();
      }
    });
    this.exitOnTerm = exitOnTerm;
    this.exitOnKill = exitOnKill;
  }

  respond(id: number, result: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  notify(method: string, params: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ method, params })}\n`));
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if ((signal === "SIGTERM" && this.exitOnTerm) || (signal === "SIGKILL" && this.exitOnKill)) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  unref(): void {
    this.unreferenced = true;
  }
}

function initializedResponse() {
  return {
    codexHome: "/tmp/codex",
    platformFamily: "unix",
    platformOs: "linux",
    userAgent: "codex-cli/0.142.0"
  };
}

function respondingChild(options?: { exitOnTerm?: boolean; exitOnKill?: boolean }): FakeChild {
  return new FakeChild((message, child) => {
    if (message.method === "initialize") child.respond(message.id, initializedResponse());
    if (message.method === "thread/list") child.respond(message.id, { data: [], nextCursor: null });
    if (message.method === "model/list" && message.params.cursor === undefined) child.respond(message.id, {
      data: [{ id: "gpt-test", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      nextCursor: "models-page-2"
    });
    if (message.method === "model/list" && message.params.cursor === "models-page-2") child.respond(message.id, {
      data: [{ id: "gpt-second", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
      nextCursor: null
    });
    if (message.method === "echo") child.respond(message.id, message.params);
  }, options);
}

test("spawns, initializes, probes, and resolves App Server responses", async () => {
  const child = respondingChild();
  const calls: Array<{ command: string; args: string[]; options: { stdio: ["pipe", "pipe", "pipe"] } }> = [];
  const client = new CodexAppServerClient({
    codexBin: "custom-codex",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  });

  await client.start();
  await client.probeCapabilities();
  const models = await client.listModels();
  const response = await client.request("echo", { value: 42 });
  const diagnostics = client.getDiagnostics();
  await client.close();

  assert.deepEqual(calls, [{
    command: "custom-codex",
    args: ["app-server"],
    options: { stdio: ["pipe", "pipe", "pipe"] }
  }]);
  assert.deepEqual(response, { value: 42 });
  assert.deepEqual(models.map(model => model.id), ["gpt-test", "gpt-second"]);
  assert.equal(diagnostics.codexExecutable, "custom-codex");
  assert.equal(diagnostics.codexHome, "/tmp/codex");
  assert.equal(diagnostics.codexSurface, "cli");
  assert.equal(diagnostics.codexVersion, "0.142.0");
  assert.equal(diagnostics.appServer.capabilities.initialize, true);
  assert.equal(diagnostics.appServer.capabilities.threadList, true);
  assert.equal(diagnostics.appServer.capabilities.modelList, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("distinguishes Codex Desktop from Codex CLI user agents", async () => {
  const child = respondingChild();
  const desktopChild = new FakeChild((message, value) => {
    if (message.method === "initialize") value.respond(message.id, {
      ...initializedResponse(),
      userAgent: "Codex Desktop/0.147.0-alpha.6.5"
    });
  });
  const cliClient = new CodexAppServerClient({ spawnProcess: () => child });
  const desktopClient = new CodexAppServerClient({
    codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    spawnProcess: () => desktopChild
  });

  await cliClient.start();
  await desktopClient.start();

  assert.deepEqual(
    {
      surface: cliClient.getDiagnostics().codexSurface,
      version: cliClient.getDiagnostics().codexVersion
    },
    { surface: "cli", version: "0.142.0" }
  );
  assert.deepEqual(
    {
      surface: desktopClient.getDiagnostics().codexSurface,
      version: desktopClient.getDiagnostics().codexVersion
    },
    { surface: "desktop", version: "0.147.0-alpha.6.5" }
  );
  assert.equal(cliClient.supportsThreadStatusNotifications(), false);
  assert.equal(desktopClient.supportsThreadStatusNotifications(), true);

  await cliClient.close();
  await desktopClient.close();
});

test("rejects repeated model pagination cursors", async () => {
  const child = new FakeChild((message, value) => {
    if (message.method === "initialize") value.respond(message.id, initializedResponse());
    if (message.method === "model/list") value.respond(message.id, { data: [], nextCursor: "repeat" });
  });
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  await assert.rejects(
    client.listModels(),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
      && isRecord(error.details)
      && error.details.reason === "repeated_cursor"
  );
  await client.close();
});

test("rejects timed out App Server requests with a stable code", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({
    requestTimeoutMs: 10,
    spawnProcess: () => child
  });
  await client.start();

  await assert.rejects(client.request("never/responds"), error =>
    error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_TIMEOUT
      && isRecord(error.details)
      && error.details.method === "never/responds"
  );
  await client.close();
});

test("rejects malformed App Server output", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  const pending = client.request("never/responds");
  child.stdout.write("not-json\n");
  await assert.rejects(pending, error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT);
  await client.close();
});

test("malformed output poisons subsequent App Server requests", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  child.stdout.write("not-json\n");
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(client.request("echo", { value: 1 }), error =>
    error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT
  );
  await client.close();
});

test("rejects pending requests when App Server exits", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  const pending = client.request("never/responds");
  child.exit(17, null);
  await assert.rejects(pending, error =>
    error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_EXITED
      && isRecord(error.details)
      && error.details.code === 17
  );
  await client.close();
});

test("delivers server notifications and connection failures to bounded subscribers", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();
  const events: Array<{ type: string; method?: string; code?: string }> = [];
  const unsubscribe = client.subscribeEvents(event => {
    events.push(event.type === "notification"
      ? { type: event.type, method: event.method }
      : { type: event.type, code: event.error.code });
  });

  child.notify("thread/status/changed", { threadId: "thread:test", status: { type: "idle" } });
  await new Promise(resolve => setImmediate(resolve));
  child.exit(17, null);
  await new Promise(resolve => setImmediate(resolve));
  unsubscribe();
  await client.close();

  assert.deepEqual(events, [
    { type: "notification", method: "thread/status/changed" },
    { type: "failure", code: ERROR_CODES.APP_SERVER_EXITED }
  ]);
});

test("cleanup falls back from bounded SIGTERM to SIGKILL", async () => {
  const child = respondingChild({ exitOnTerm: false, exitOnKill: true });
  const client = new CodexAppServerClient({
    shutdownTimeoutMs: 5,
    forceKillTimeoutMs: 20,
    spawnProcess: () => child
  });
  await client.start();

  const cleanup = await client.close();
  assert.ok(cleanup);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(cleanup.forced, true);
  assert.equal(cleanup.exitConfirmed, true);
  assert.ok(client.getWarnings().some(item => item.code === WARNING_CODES.APP_SERVER_FORCE_KILLED));
});

test("cleanup remains bounded when exit cannot be confirmed", async () => {
  const child = respondingChild({ exitOnTerm: false, exitOnKill: false });
  const client = new CodexAppServerClient({
    shutdownTimeoutMs: 5,
    forceKillTimeoutMs: 5,
    spawnProcess: () => child
  });
  await client.start();

  const cleanup = await client.close();
  assert.ok(cleanup);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(cleanup.exitConfirmed, false);
  assert.equal(cleanup.detached, true);
  assert.equal(child.unreferenced, true);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.ok(client.getWarnings().some(item => item.code === WARNING_CODES.APP_SERVER_EXIT_UNCONFIRMED));
});

test("synchronous App Server spawn failures use a stable code", async () => {
  const client = new CodexAppServerClient({
    spawnProcess() {
      throw new Error("ENOENT");
    }
  });

  await assert.rejects(client.start(), error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED);
});
