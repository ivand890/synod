import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { WARNING_CODES } from "../src/contracts.js";
import { ERROR_CODES } from "../src/errors.js";

class FakeChild extends EventEmitter {
  constructor(onMessage, { exitOnTerm = true, exitOnKill = true } = {}) {
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
          if (line) onMessage?.(JSON.parse(line), this);
        }
        callback();
      }
    });
    this.exitOnTerm = exitOnTerm;
    this.exitOnKill = exitOnKill;
  }

  respond(id, result) {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal) {
    this.signals.push(signal);
    if ((signal === "SIGTERM" && this.exitOnTerm) || (signal === "SIGKILL" && this.exitOnKill)) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  unref() {
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

function respondingChild(options) {
  return new FakeChild((message, child) => {
    if (message.method === "initialize") child.respond(message.id, initializedResponse());
    if (message.method === "thread/list") child.respond(message.id, { data: [], nextCursor: null });
    if (message.method === "echo") child.respond(message.id, message.params);
  }, options);
}

test("spawns, initializes, probes, and resolves App Server responses", async () => {
  const child = respondingChild();
  const calls = [];
  const client = new CodexAppServerClient({
    codexBin: "custom-codex",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  });

  await client.start();
  await client.probeCapabilities();
  const response = await client.request("echo", { value: 42 });
  const diagnostics = client.getDiagnostics();
  await client.close();

  assert.deepEqual(calls, [{
    command: "custom-codex",
    args: ["app-server"],
    options: { stdio: ["pipe", "pipe", "pipe"] }
  }]);
  assert.deepEqual(response, { value: 42 });
  assert.equal(diagnostics.codexVersion, "0.142.0");
  assert.equal(diagnostics.appServer.capabilities.initialize, true);
  assert.equal(diagnostics.appServer.capabilities.threadList, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("rejects timed out App Server requests with a stable code", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({
    requestTimeoutMs: 10,
    spawnProcess: () => child
  });
  await client.start();

  await assert.rejects(client.request("never/responds"), error =>
    error.code === ERROR_CODES.APP_SERVER_TIMEOUT && error.details.method === "never/responds"
  );
  await client.close();
});

test("rejects malformed App Server output", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  const pending = client.request("never/responds");
  child.stdout.write("not-json\n");
  await assert.rejects(pending, error => error.code === ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT);
  await client.close();
});

test("malformed output poisons subsequent App Server requests", async () => {
  const child = respondingChild();
  const client = new CodexAppServerClient({ spawnProcess: () => child });
  await client.start();

  child.stdout.write("not-json\n");
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(client.request("echo", { value: 1 }), error =>
    error.code === ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT
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
    error.code === ERROR_CODES.APP_SERVER_EXITED && error.details.code === 17
  );
  await client.close();
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

  await assert.rejects(client.start(), error => error.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED);
});
