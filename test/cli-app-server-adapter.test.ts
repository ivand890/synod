import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppServerDiagnostics, AppServerEvent } from "../src/app-server.js";
import {
  createCliAppServerAdapter,
  findCliAppServerWaitClient,
  type CliAppServerClient
} from "../src/cli-app-server-adapter.js";
import { createCliAppServerRunnerClient } from "../src/cli-app-server-runner.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { isRecord } from "../src/validation.js";
import { selectHostDelegationAdapter } from "../src/host-delegation.js";
import type {
  HostDelegationAdapter,
  HostDelegationAuthorizeRequest,
  HostDelegationSpawnRequest
} from "../src/host-delegation.js";
import type { TaskLease, TaskLeaseReservation } from "../src/leases.js";

function threadRecord(
  id = "thread-from-appserver",
  status: { type: "idle" | "notLoaded" | "systemError" } = { type: "idle" }
): Record<string, unknown> {
  return {
    cliVersion: "0.148.0",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id,
    modelProvider: "openai",
    preview: false,
    sessionId: `session-${id}`,
    source: "cli",
    status,
    turns: [],
    updatedAt: 0
  };
}

function diagnostics(overrides: Record<string, unknown> = {}): AppServerDiagnostics {
  return {
    codexExecutable: "codex",
    codexSurface: "cli",
    appServer: {
      capabilities: { initialize: true, threadList: false, modelList: false }
    },
    ...overrides
  };
}

const waitEndpointRoot = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "synod-cli-app-server");
const testRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function childLoaderSpecifier(specifier: string, requireMode: boolean): string {
  const resolved = specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")
    || specifier.startsWith("node:") || specifier.startsWith("data:")
    ? specifier
    : (() => {
      try { return import.meta.resolve(specifier); } catch { return specifier; }
    })();
  return requireMode && resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}

function childLoaderArgv(): string[] {
  const result: string[] = [];
  const argv = process.execArgv;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--import" || item === "--require") {
      const next = argv[index + 1];
      if (next) result.push(item, childLoaderSpecifier(next, item === "--require"));
      index += 1;
    } else if (item?.startsWith("--import=") || item?.startsWith("--require=")) {
      const separator = item.indexOf("=");
      const flag = item.slice(0, separator);
      result.push(`${flag}=${childLoaderSpecifier(item.slice(separator + 1), flag === "--require")}`);
    }
  }
  return result;
}

function waitEndpointPaths(directory: string, threadId: string): { metadataPath: string; socketPath: string } {
  const identity = createHash("sha256")
    .update(`${process.getuid?.() ?? "unknown"}\0${path.resolve(directory)}\0${threadId}`)
    .digest("hex");
  return {
    metadataPath: path.join(waitEndpointRoot, `${identity.slice(0, 32)}.json`),
    socketPath: path.join(waitEndpointRoot, `${identity.slice(0, 32)}.sock`)
  };
}

async function writeWaitEndpointMetadata(
  directory: string,
  threadId: string,
  expiresAt: number
): Promise<{ metadataPath: string; socketPath: string }> {
  const paths = waitEndpointPaths(directory, threadId);
  await mkdir(waitEndpointRoot, { recursive: true, mode: 0o700 });
  await rm(paths.metadataPath, { force: true });
  await rm(paths.socketPath, { force: true });
  await writeFile(paths.metadataPath, JSON.stringify({
    version: 1,
    threadId,
    directory: path.resolve(directory),
    token: `${threadId}-token`,
    expiresAt,
    socketPath: paths.socketPath
  }), { encoding: "utf8", mode: 0o600 });
  return paths;
}

function endpointWaitLoss(client: CliAppServerClient): Record<string, unknown> {
  const appServer = client.getDiagnostics().appServer as unknown;
  assert.ok(isRecord(appServer));
  assert.ok(isRecord(appServer.waitLoss));
  return appServer.waitLoss;
}

async function closeEndpointServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

class FakeClient implements CliAppServerClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  started = 0;
  closed = 0;
  threadId = "thread-from-appserver";
  deferCompleted?: Promise<void>;
  threadStartResponse: unknown = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    reasoningEffort: "max",
    sandbox: { type: "readOnly" },
    thread: threadRecord()
  };
  turnStartResponse: unknown = {
    turn: { id: "turn-1", items: [], status: "inProgress" }
  };
  listResponse: unknown = {
    data: [threadRecord("thread-from-appserver", { type: "notLoaded" })],
    nextCursor: null
  };
  completionStatus: string | null = "completed";
  readStatus: "idle" | "notLoaded" | "systemError" = "idle";
  emitUsage = true;
  emitSettings = true;
  settingsCwd: string | undefined = "/tmp/project";
  turnStartCwd: string | undefined;
  omitTurnStartCwd = false;
  failureOnTurnStart?: SynodError;
  currentDiagnostics: AppServerDiagnostics;
  failStart?: Error;
  private readonly listeners = new Set<(event: AppServerEvent) => void>();

  constructor(diagnosticOverrides: Record<string, unknown> = {}) {
    this.currentDiagnostics = diagnostics(diagnosticOverrides);
  }

  async start(): Promise<void> {
    if (this.failStart) throw this.failStart;
    this.started += 1;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") return this.threadStartResponse;
    if (method === "turn/start") {
      if (this.omitTurnStartCwd) delete params.cwd;
      else if (this.turnStartCwd !== undefined) params.cwd = this.turnStartCwd;
      if (this.failureOnTurnStart) {
        queueMicrotask(() => this.fail(this.failureOnTurnStart!));
      }
      queueMicrotask(() => {
        void Promise.resolve(this.deferCompleted).then(() => {
      const turn = this.turnStartResponse;
      const extra = turn && typeof turn === "object" ? turn as Record<string, unknown> : {};
          const item = {
            threadId: this.threadId,
            turn: {
              id: "turn-1",
              items: [],
              ...(this.completionStatus === null ? { status: "inProgress" } : { status: this.completionStatus })
            }
          };
          const sandboxPolicy = extra.sandbox === "workspace-write"
            ? {
              type: "workspaceWrite",
              ...(extra.runtimeWorkspaceRoots === undefined ? {} : { writableRoots: extra.runtimeWorkspaceRoots })
            }
            : { type: "readOnly" };
          const settings = {
            threadId: this.threadId,
            threadSettings: {
              approvalPolicy: "never",
              approvalsReviewer: "user",
              collaborationMode: { mode: "default", settings: { model: typeof params.model === "string" ? params.model : "gpt-5.6-luna" } },
              ...(this.settingsCwd === undefined ? {} : { cwd: this.settingsCwd }),
              model: typeof params.model === "string" ? params.model : "gpt-5.6-luna",
              modelProvider: "openai",
              effort: typeof params.effort === "string" ? params.effort : "max",
              sandboxPolicy
            }
          };
          if (this.emitSettings) this.notify("thread/settings/updated", settings);
          this.notify("turn/completed", item);
          if (this.emitUsage) {
            this.notify("thread/tokenUsage/updated", {
              threadId: this.threadId,
              turnId: "turn-1",
              tokenUsage: { totalTokens: 7 }
            });
          }
        });
      });
      const response = this.turnStartResponse;
      if (isRecord(response) && isRecord(response.turn)) return { turn: response.turn };
      return response;
    }
    if (method === "thread/read") return { thread: threadRecord(this.threadId, { type: this.readStatus }) };
    if (method === "thread/list") return this.listResponse;
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeEvents(listener: (event: AppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(method: string, params: unknown): void {
    const event: AppServerEvent = { type: "notification", method, params };
    for (const listener of this.listeners) listener(event);
  }

  private fail(error: SynodError): void {
    for (const listener of this.listeners) listener({ type: "failure", error });
  }

  getDiagnostics(): AppServerDiagnostics {
    return this.currentDiagnostics;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

const reservation = {
  id: "lease-1",
  token: "token-1",
  generation: 1,
  taskId: "T-HOST",
  taskRevision: 0,
  executor: "synod_implementer",
  reservedAt: "2026-08-21T00:00:00.000Z",
  baseline: { snapshotContentHash: "sha256:aa" }
} as unknown as TaskLeaseReservation;

function spawnRequest(): HostDelegationSpawnRequest {
  const contract = {
    taskId: "T-HOST",
    taskRevision: 0,
    objective: "Exercise the App Server task contract",
    acceptance: ["The worker reports the exact result"],
    verification: ["pnpm test -- test/cli-app-server-adapter.test.ts"],
    scopes: [],
    writeAuthorized: false as const,
    proposalGuidance: "The supervisor seals the exact proposal after the worker turn.",
    instruction: "analysis may begin; writes, worktrees, and implementation commands wait for bind authorization" as const
  };
  return {
    taskId: "T-HOST",
    directory: "/tmp/project",
    reservation,
    reservationFence: {
      reservationToken: "token-1",
      leaseId: "lease-1",
      generation: 1,
      revision: 0,
      expectedReservedAt: "2026-08-21T00:00:00.000Z",
      baselineHash: "sha256:aa"
    },
    writeAuthorized: false,
    readOnlyContract: contract,
    initialContract: contract,
    contract
  };
}

function authorizeRequest(ownerThread = "thread-from-appserver"): HostDelegationAuthorizeRequest {
  return {
    phase: "activate",
    taskId: "T-HOST",
    directory: "/tmp/project",
    ownerThread,
    writeAuthorized: true,
    reservation,
    lease: { ownerThread } as TaskLease,
    leaseFence: {
      leaseId: "lease-1",
      generation: 1,
      revision: 0,
      expectedHeartbeatAt: "2026-08-21T00:00:01.000Z",
      ownerThread
    }
  };
}

function cliAdapter(client: FakeClient, factory?: () => CliAppServerClient): HostDelegationAdapter {
  let calls = 0;
  return createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: factory ?? (() => {
      calls += 1;
      return calls === 1 ? client : new FakeClient();
    })
  });
}

test("CLI adapter starts one App Server thread without a turn and returns the UUID", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  const spawned = await adapter.spawn(spawnRequest());

  assert.equal(client.started, 1);
  assert.deepEqual(spawned, { ownerId: "thread-from-appserver", threadId: "thread-from-appserver" });
  assert.deepEqual(client.calls.map(call => call.method), ["thread/start"]);
  assert.equal(client.calls[0]?.params.approvalPolicy, "never");
  assert.equal(client.calls[0]?.params.model, "gpt-5.6-luna");
  assert.equal(client.calls[0]?.params.sandbox, "read-only");
  assert.equal(Object.hasOwn(client.calls[0]?.params || {}, "runtimeWorkspaceRoots"), false);
  assert.equal(client.closed, 0);
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
});

test("CLI adapter resolves the portable implementer for both thread/start and turn/start", async () => {
  const client = new FakeClient();
  const start = client.threadStartResponse as Record<string, unknown>;
  client.threadStartResponse = { ...start, model: "gpt-5.5", reasoningEffort: "high" };
  const portable = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "portable",
    directory: "/tmp/project",
    clientFactory: () => client
  });

  await portable.spawn(spawnRequest());
  const authorized = await portable.authorize(authorizeRequest());
  assert.equal((authorized as { model: string }).model, "gpt-5.5");
  assert.equal((authorized as { reasoningEffort: string }).reasoningEffort, "high");
  const threadCall = client.calls.find(call => call.method === "thread/start");
  const turnCall = client.calls.find(call => call.method === "turn/start");
  assert.equal(threadCall?.params.model, "gpt-5.5");
  assert.equal(turnCall?.params.model, "gpt-5.5");
  assert.equal(turnCall?.params.effort, "high");
  await portable.close?.();
});

test("CLI adapter rejects missing, invalid, and unsupported profiles before worker execution", async () => {
  for (const profile of [undefined, "", "portable ", "not-a-profile"]) {
    const client = new FakeClient();
    const adapter = createCliAppServerAdapter({
      runtime: { surface: "cli", executable: "codex" },
      ...(profile === undefined ? {} : { profile }),
      directory: "/tmp/project",
      clientFactory: () => client
    });
    await assert.rejects(
      adapter.spawn(spawnRequest()),
      error => error instanceof SynodError
        && error.code === ERROR_CODES.PROFILE_NOT_FOUND
        && isRecord(error.details)
        && error.details.constructedAppServer === false
    );
    assert.equal(client.started, 0);
    assert.deepEqual(client.calls, []);
  }
});

test("CLI adapter rejects a non-implementer executor before constructing the App Server", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  const request = spawnRequest();
  request.reservation = { ...request.reservation, executor: "synod_supervisor" };

  await assert.rejects(
    adapter.spawn(request),
    error => {
      if (!(error instanceof SynodError)) return false;
      const details = error.details as Record<string, unknown>;
      return error.code === ERROR_CODES.HOST_ADAPTER_INVALID
        && details.constructedAppServer === false
        && details.expectedExecutor === "synod_implementer"
        && details.observedExecutor === "synod_supervisor";
    }
  );
  assert.equal(client.started, 0);
  assert.equal(client.calls.length, 0);
});

test("authorize runs one read-only turn after bind and does not treat wait as wait --task", async () => {
  const spawnClient = new FakeClient();
  const restartClient = new FakeClient();
  let created = 0;
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => {
      created += 1;
      return created === 1 ? spawnClient : restartClient;
    }
  });
  await adapter.spawn(spawnRequest());
  const authorized = await adapter.authorize(authorizeRequest());

  assert.equal((authorized as { status: string }).status, "authorized");
  assert.equal((authorized as { threadId: string }).threadId, "thread-from-appserver");
  assert.equal((authorized as { turnId: string }).turnId, "turn-1");
  assert.equal((authorized as { waitAuthority: string }).waitAuthority, "appServer");
  assert.equal((authorized as { completion: string }).completion, "incomplete");
  assert.equal((authorized as { proposalRequired: boolean }).proposalRequired, true);
  const nextCommand = (authorized as { nextCommand: { operation: string; requirements: string[]; argv: string[] } }).nextCommand;
  assert.equal(nextCommand.operation, "proposal.submit");
  assert.deepEqual(nextCommand.requirements, ["exact-sealed-proposal"]);
  assert.deepEqual(nextCommand.argv.slice(0, 3), ["proposal", "submit", "T-HOST"]);
  assert.equal((authorized as { sandbox: string }).sandbox, "read-only");
  assert.equal((authorized as { model: string }).model, "gpt-5.6-luna");
  assert.equal((authorized as { reasoningEffort: string }).reasoningEffort, "max");
  assert.equal((authorized as { tokenAttribution: string }).tokenAttribution, "available");
  assert.equal((authorized as { restartLineage: { usedThreadResume: boolean } }).restartLineage.usedThreadResume, false);
  assert.equal((authorized as { restartLineage: { completion: string } }).restartLineage.completion, "not-claimed");
  assert.equal((authorized as { restartLineage: { status: string } }).restartLineage.status, "notLoaded");
  const turnCall = spawnClient.calls.find(call => call.method === "turn/start");
  assert.equal(turnCall?.params.threadId, "thread-from-appserver");
  assert.equal(turnCall?.params.cwd, "/tmp/project");
  assert.equal(turnCall?.params.approvalPolicy, "never");
  assert.equal(turnCall?.params.model, "gpt-5.6-luna");
  assert.equal(turnCall?.params.effort, "max");
  assert.deepEqual(turnCall?.params.sandboxPolicy, { type: "readOnly" });
  assert.equal(Object.hasOwn(turnCall?.params || {}, "runtimeWorkspaceRoots"), false);
  const prompt = (turnCall?.params.input as Array<{ type: string; text: string }> | undefined)?.[0]?.text || "";
  assert.match(prompt, /Task ID: T-HOST/);
  assert.match(prompt, /Objective: Exercise the App Server task contract/);
  assert.match(prompt, /Acceptance criteria:[\s\S]*The worker reports the exact result/);
  assert.match(prompt, /Verification commands:[\s\S]*cli-app-server-adapter\.test\.ts/);
  assert.match(prompt, /Worker-only proposal guidance:/);
  assert.equal(spawnClient.calls.some(call => call.method === "turn/interrupt"), false);
  assert.equal(restartClient.calls.some(call => call.method === "thread/resume"), false);
  assert.equal(restartClient.calls.some(call => call.method === "thread/list"), true);
  const listCall = restartClient.calls.find(call => call.method === "thread/list");
  assert.deepEqual(listCall?.params, { archived: false, limit: 100, cwd: "/tmp/project" });
  assert.equal(created, 2);
  await adapter.close?.();
  assert.ok(spawnClient.closed >= 1);
  assert.ok(restartClient.closed >= 1);
});

test("CLI App Server wait endpoint is exact-UUID, cross-client, one-shot, and closes the owner", async () => {
  const spawnClient = new FakeClient();
  const restartClient = new FakeClient();
  let created = 0;
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => {
      created += 1;
      return created === 1 ? spawnClient : restartClient;
    }
  });
  await adapter.spawn(spawnRequest());
  await adapter.authorize(authorizeRequest());

  const waitClient = findCliAppServerWaitClient("/tmp/project", "thread-from-appserver");
  assert.ok(waitClient);
  await waitClient!.start();
  const response = await waitClient!.request("thread/read", { threadId: "thread-from-appserver" });
  const observed = (response as { thread: { id: string; status: { type: string } } }).thread;
  assert.equal(observed.id, "thread-from-appserver");
  assert.deepEqual(observed.status, { type: "idle" });
  await assert.rejects(
    waitClient!.request("thread/read", { threadId: "other-thread" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );
  assert.equal(spawnClient.calls.filter(call => call.method === "thread/read").length, 1);
  await waitClient!.close();
  await adapter.close?.();
  assert.ok(spawnClient.closed >= 1);
  assert.equal(findCliAppServerWaitClient("/tmp/project", "thread-from-appserver"), undefined);
});

test("CLI App Server wait endpoint marks direct child termination without collapsing endpoint loss", async () => {
  const spawnClient = new FakeClient();
  spawnClient.readStatus = "systemError";
  const restartClient = new FakeClient();
  let created = 0;
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => {
      created += 1;
      return created === 1 ? spawnClient : restartClient;
    }
  });

  await adapter.spawn(spawnRequest());
  await adapter.authorize(authorizeRequest());
  const waitClient = findCliAppServerWaitClient("/tmp/project", "thread-from-appserver");
  assert.ok(waitClient);
  const response = await waitClient!.request("thread/read", { threadId: "thread-from-appserver" });
  assert.deepEqual((response as { thread: { status: unknown } }).thread.status, { type: "systemError" });
  const endpointDiagnostics = waitClient!.getDiagnostics();
  const appServer = endpointDiagnostics.appServer as Record<string, unknown>;
  assert.deepEqual(appServer.waitLoss, {
    cause: "child-terminated",
    authority: "appServer",
    threadId: "thread-from-appserver",
    directEvidence: true
  });
  await waitClient!.close();
  await adapter.close?.();
});

test("CLI App Server wait endpoint reports expired metadata as a typed loss", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-wait-expired-"));
  const threadId = `thread-expired-${process.pid}`;
  const paths = await writeWaitEndpointMetadata(directory, threadId, Date.now() - 1);
  try {
    const waitClient = findCliAppServerWaitClient(directory, threadId);
    assert.ok(waitClient);
    const response = await waitClient!.request("thread/read", { threadId });
    assert.deepEqual((response as { thread: { status: unknown } }).thread.status, { type: "notLoaded" });
    assert.deepEqual(endpointWaitLoss(waitClient!), {
      cause: "endpoint-expired",
      authority: "appServer",
      directEvidence: false
    });
    await waitClient!.close();
  } finally {
    await rm(paths.metadataPath, { force: true });
    await rm(paths.socketPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI App Server wait endpoint reports an unreachable owner as a typed loss", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-wait-unreachable-"));
  const threadId = `thread-unreachable-${process.pid}`;
  const paths = await writeWaitEndpointMetadata(directory, threadId, Date.now() + 60_000);
  try {
    const waitClient = findCliAppServerWaitClient(directory, threadId);
    assert.ok(waitClient);
    const response = await waitClient!.request("thread/read", { threadId });
    assert.deepEqual((response as { thread: { status: unknown } }).thread.status, { type: "notLoaded" });
    assert.deepEqual(endpointWaitLoss(waitClient!), {
      cause: "endpoint-unreachable",
      authority: "appServer",
      directEvidence: false
    });
    await waitClient!.close();
  } finally {
    await rm(paths.metadataPath, { force: true });
    await rm(paths.socketPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI App Server wait endpoint reports an exited owner as a typed loss", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-wait-owner-exited-"));
  const threadId = `thread-owner-exited-${process.pid}`;
  const paths = await writeWaitEndpointMetadata(directory, threadId, Date.now() + 60_000);
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(paths.socketPath);
    });

    const waitClient = findCliAppServerWaitClient(directory, threadId);
    assert.ok(waitClient);
    const response = await waitClient!.request("thread/read", { threadId });
    assert.deepEqual((response as { thread: { status: unknown } }).thread.status, { type: "notLoaded" });
    assert.deepEqual(endpointWaitLoss(waitClient!), {
      cause: "endpoint-owner-exited",
      authority: "appServer",
      directEvidence: false
    });
    await waitClient!.close();
  } finally {
    await closeEndpointServer(server);
    await rm(paths.metadataPath, { force: true });
    await rm(paths.socketPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("Desktop runtime never constructs an App Server", async () => {
  let constructed = 0;
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "desktop", executable: "/Applications/ChatGPT.app/Contents/Resources/codex" },
    clientFactory: () => {
      constructed += 1;
      return new FakeClient();
    }
  });
  await assert.rejects(
    adapter.spawn(spawnRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
      && typeof error.details === "object"
      && error.details !== null
      && "constructedAppServer" in error.details
      && error.details.constructedAppServer === false
  );
  assert.equal(constructed, 0);
});

test("App Server Desktop user agent fails closed after start and closes the child", async () => {
  const client = new FakeClient({ codexSurface: "desktop" });
  await assert.rejects(
    cliAdapter(client, () => client).spawn(spawnRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
  assert.equal(client.started, 1);
  assert.equal(client.calls.some(call => call.method === "thread/start"), false);
  assert.equal(client.closed, 1);
});

function childLossOf(error: unknown): unknown {
  return error instanceof SynodError && isRecord(error.details) ? error.details.childLoss : undefined;
}

test("missing thread identity and a started turn fail closed", async () => {
  const missing = new FakeClient();
  missing.threadStartResponse = { thread: { parentThreadId: null } };
  await assert.rejects(
    cliAdapter(missing, () => missing).spawn(spawnRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.HOST_OWNER_MISSING
      && childLossOf(error) === "spawn-invoked-no-owner"
  );
  assert.equal(missing.closed, 1);

  const withTurn = new FakeClient();
  withTurn.threadStartResponse = { thread: { id: "thread-1" }, turn: { id: "turn-1" } };
  await assert.rejects(
    cliAdapter(withTurn, () => withTurn).spawn(spawnRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );
  assert.equal(withTurn.calls.some(call => call.method === "turn/start"), false);
  assert.equal(withTurn.closed, 1);
});

test("multi_agent_v2 on the launched argv fails closed before thread/start", async () => {
  const client = new FakeClient({
    launchedArgv: ["codex", "app-server", "--enable", "multi_agent_v2"]
  });
  await assert.rejects(
    cliAdapter(client, () => client).spawn(spawnRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
  assert.equal(client.calls.some(call => call.method === "thread/start"), false);
  assert.equal(client.closed, 1);
});

test("App Server failure wakes an owned turn immediately and closes the client", async () => {
  const client = new FakeClient();
  client.failureOnTurnStart = new SynodError(ERROR_CODES.APP_SERVER_EXITED, "owned App Server exited");
  const adapter = cliAdapter(client, () => client);
  await adapter.spawn(spawnRequest());

  const startedAt = Date.now();
  await assert.rejects(
    adapter.authorize(authorizeRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_EXITED
      && childLossOf(error) === "child-dead-lease-live"
  );
  assert.ok(Date.now() - startedAt < 500, "failure should wake before the turn timeout");
  assert.ok(client.closed >= 1);
});

test("adapter wait fails closed and is not wait --task", async () => {
  const adapter = cliAdapter(new FakeClient());
  await assert.rejects(
    adapter.wait?.({
      threadIds: ["thread-from-appserver"],
      timeoutMs: 100,
      pollIntervalMs: 100
    }) ?? Promise.reject(new Error("missing wait")),
    error => error instanceof SynodError && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
});

test("missing effective sandbox, model, or reasoning fails closed", async () => {
  for (const threadStartResponse of [
    { model: "gpt-5.6-luna", reasoningEffort: "max" },
    { reasoningEffort: "max", sandbox: { type: "readOnly" } },
    { model: "gpt-5.6-luna", sandbox: { type: "readOnly" } },
    { model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "workspaceWrite", writableRoots: ["/tmp/write"] } },
    { model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "workspaceWrite", writableRoots: [] } }
  ]) {
    const client = new FakeClient();
    client.threadStartResponse = {
      ...threadStartResponse,
      thread: { id: "thread-from-appserver", parentThreadId: null }
    };
    client.emitSettings = false;
    const adapter = cliAdapter(client, () => client);
    await adapter.spawn(spawnRequest());
    await assert.rejects(
      adapter.authorize(authorizeRequest()),
      error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
    );
  }
});

test("missing token usage is unavailable and is not recorded as zero", async () => {
  const spawnClient = new FakeClient();
  spawnClient.emitUsage = false;
  const restartClient = new FakeClient();
  let created = 0;
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    clientFactory: () => {
      created += 1;
      return created === 1 ? spawnClient : restartClient;
    }
  });
  await adapter.spawn(spawnRequest());
  const authorized = await adapter.authorize(authorizeRequest());
  assert.equal((authorized as { tokenAttribution: string }).tokenAttribution, "unavailable");
  assert.equal(Object.prototype.hasOwnProperty.call(authorized, "totalTokens"), false);
  await adapter.close?.();
});

const writerScope = { path: "src", access: "write" as const, kind: "tree" as const };
const writerRoot = path.resolve("/tmp/project", writerScope.path);

function writerAuthorizeRequest(ownerThread = "thread-from-appserver"): HostDelegationAuthorizeRequest {
  const scopedReservation = {
    ...reservation,
    scopes: [writerScope]
  } as unknown as TaskLeaseReservation;
  return {
    ...authorizeRequest(ownerThread),
    reservation: scopedReservation,
    lease: { ownerThread, scopes: [writerScope] } as TaskLease
  };
}

test("thread/start stays read-only when the reservation already has a write scope", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  const request = spawnRequest();
  request.reservation = { ...reservation, scopes: [writerScope] } as unknown as TaskLeaseReservation;
  await adapter.spawn(request);
  assert.equal(client.calls[0]?.params.sandbox, "read-only");
  assert.equal(Object.hasOwn(client.calls[0]?.params || {}, "runtimeWorkspaceRoots"), false);
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
});

test("workspace-write fails closed before turn/start without a pre-turn observed boundary", async () => {
  const client = new FakeClient();
  client.turnStartResponse = {
    turn: { id: "turn-1" },
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    runtimeWorkspaceRoots: [writerRoot]
  };
  const adapter = cliAdapter(client, () => client);

  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(writerAuthorizeRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
      && isRecord(error.details)
      && error.details.phase === "before-turn/start"
      && error.details.authority === "effective-writable-boundary"
      && error.details.observed === false
  );
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
  assert.ok(client.closed >= 1);
});

test("workspace-write with omitted writableRoots never derives a root from turn/start cwd", async () => {
  const spawnClient = new FakeClient();
  spawnClient.turnStartResponse = {
    turn: { id: "turn-1" },
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    reasoningEffort: "max"
  };
  const adapter = cliAdapter(spawnClient, () => spawnClient);

  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(writerAuthorizeRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );

  assert.equal(spawnClient.calls.some(call => call.method === "turn/start"), false);
  assert.ok(spawnClient.closed >= 1);
});

test("workspace-write with omitted writableRoots fails without an exact adapter turn/start cwd", async () => {
  for (const mode of ["missing", "different"] as const) {
    const spawnClient = new FakeClient();
    if (mode === "missing") spawnClient.omitTurnStartCwd = true;
    else spawnClient.turnStartCwd = "/tmp/project/other";
    spawnClient.turnStartResponse = {
      turn: { id: "turn-1" },
      sandbox: "workspace-write",
      model: "gpt-5.6-luna",
      reasoningEffort: "max"
    };
    const adapter = cliAdapter(spawnClient, () => spawnClient);

    await adapter.spawn(spawnRequest());
    await assert.rejects(
      adapter.authorize(writerAuthorizeRequest()),
      error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
    );
    assert.equal(spawnClient.calls.some(call => call.method === "turn/start"), false);
    assert.ok(spawnClient.closed >= 1);
  }
});

test("workspace-write with empty writableRoots never derives a root from turn/start cwd", async () => {
  const spawnClient = new FakeClient();
  spawnClient.turnStartResponse = {
    turn: { id: "turn-1" },
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    runtimeWorkspaceRoots: []
  };
  const adapter = cliAdapter(spawnClient, () => spawnClient);

  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(writerAuthorizeRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );

  assert.equal(spawnClient.calls.some(call => call.method === "turn/start"), false);
  assert.ok(spawnClient.closed >= 1);
});

test("workspace-write with empty writableRoots fails without an exact adapter turn/start cwd", async () => {
  for (const mode of ["missing", "different"] as const) {
    const spawnClient = new FakeClient();
    if (mode === "missing") spawnClient.omitTurnStartCwd = true;
    else spawnClient.turnStartCwd = "/tmp/project/other";
    spawnClient.turnStartResponse = {
      turn: { id: "turn-1" },
      sandbox: "workspace-write",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      runtimeWorkspaceRoots: []
    };
    const adapter = cliAdapter(spawnClient, () => spawnClient);

    await adapter.spawn(spawnRequest());
    await assert.rejects(
      adapter.authorize(writerAuthorizeRequest()),
      error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
    );
    assert.equal(spawnClient.calls.some(call => call.method === "turn/start"), false);
    assert.ok(spawnClient.closed >= 1);
  }
});

test("workspace-write with nonempty mismatched roots fails closed", async () => {
  const client = new FakeClient();
  client.turnStartResponse = {
    turn: { id: "turn-1" },
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    runtimeWorkspaceRoots: [path.resolve("/tmp/project", "other")]
  };
  const adapter = cliAdapter(client, () => client);

  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(writerAuthorizeRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
  assert.ok(client.closed >= 1);
});

test("workspace-write with multiple observed roots is ambiguous and fails closed", async () => {
  const client = new FakeClient();
  client.turnStartResponse = {
    turn: { id: "turn-1" },
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    runtimeWorkspaceRoots: [writerRoot, path.resolve("/tmp/project", "other")]
  };
  const adapter = cliAdapter(client, () => client);

  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(writerAuthorizeRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
  assert.ok(client.closed >= 1);
});

test("two writer scopes fail closed without starting a turn", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize({
      ...authorizeRequest(),
      lease: {
        ownerThread: "thread-from-appserver",
        scopes: [writerScope, { path: "src/other.ts", access: "write", kind: "file" }]
      } as TaskLease
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_CONFLICT
  );
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
});

test("a file writer scope fails closed before starting a turn", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize({
      ...authorizeRequest(),
      lease: {
        ownerThread: "thread-from-appserver",
        scopes: [{ path: "src/app.ts", access: "write", kind: "file" }]
      } as TaskLease
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_CONFLICT
  );
  assert.equal(client.calls.some(call => call.method === "turn/start"), false);
  assert.ok(client.closed >= 1);
});

test("independent writer requests fail before acquiring a live writer scope", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  second.threadId = "thread-writer-2";
  second.threadStartResponse = { thread: { id: "thread-writer-2", parentThreadId: null } };
  const adapter1 = cliAdapter(first, () => first);
  const adapter2 = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => second
  });
  await adapter1.spawn(spawnRequest());
  await adapter2.spawn(spawnRequest());

  await Promise.all([
    assert.rejects(
      adapter1.authorize(writerAuthorizeRequest()),
      error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
    ),
    assert.rejects(
      adapter2.authorize(writerAuthorizeRequest("thread-writer-2")),
      error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
    )
  ]);
  assert.equal(first.calls.some(call => call.method === "turn/start"), false);
  assert.equal(second.calls.some(call => call.method === "turn/start"), false);
  assert.ok(first.closed >= 1);
  assert.ok(second.closed >= 1);
});

test("non-completed turn terminals fail closed without turn/interrupt", async () => {
  const client = new FakeClient();
  client.completionStatus = "failed";
  const adapter = cliAdapter(client, () => client);
  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(authorizeRequest()),
    error => error instanceof SynodError && error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED
  );
  assert.equal(client.calls.some(call => call.method === "turn/interrupt"), false);
});

test("adapter close stops the live App Server session so later authorize fails closed", async () => {
  const client = new FakeClient();
  const adapter = cliAdapter(client, () => client);
  await adapter.spawn(spawnRequest());
  assert.equal(client.closed, 0);
  await adapter.close?.();
  assert.equal(client.closed, 1);
  await assert.rejects(
    adapter.authorize(authorizeRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
      && childLossOf(error) === undefined
  );
  assert.equal(client.calls.some(call => call.method === "turn/interrupt"), false);
});

test("turn completion timeout classifies wait-never-woke and closes the child", async () => {
  const client = new FakeClient();
  client.deferCompleted = new Promise(() => {});
  const adapter = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => client,
    turnCompletionTimeoutMs: 20
  });
  await adapter.spawn(spawnRequest());
  await assert.rejects(
    adapter.authorize(authorizeRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.APP_SERVER_TIMEOUT
      && childLossOf(error) === "wait-never-woke"
  );
  assert.ok(client.closed >= 1);
  assert.equal(client.calls.some(call => call.method === "turn/interrupt"), false);
});

test("independent read-only adapters hold distinct thread UUIDs and do not share live sessions", async () => {
  const first = new FakeClient();
  first.threadId = "thread-a";
  first.threadStartResponse = { thread: { id: "thread-a" } };
  first.listResponse = {
    data: [threadRecord("thread-a", { type: "notLoaded" })],
    nextCursor: null
  };
  const second = new FakeClient();
  second.threadId = "thread-b";
  second.threadStartResponse = { thread: { id: "thread-b" } };
  second.listResponse = {
    data: [threadRecord("thread-b", { type: "notLoaded" })],
    nextCursor: null
  };
  const adapter1 = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => first
  });
  const adapter2 = createCliAppServerAdapter({
    runtime: { surface: "cli", executable: "codex" },
    profile: "synod-5.6",
    directory: "/tmp/project",
    clientFactory: () => second
  });
  const [spawned1, spawned2] = await Promise.all([
    adapter1.spawn(spawnRequest()),
    adapter2.spawn(spawnRequest())
  ]);
  assert.deepEqual(spawned1, { ownerId: "thread-a", threadId: "thread-a" });
  assert.deepEqual(spawned2, { ownerId: "thread-b", threadId: "thread-b" });
  assert.equal(first.closed, 0);
  assert.equal(second.closed, 0);
  const [authorized1, authorized2] = await Promise.all([
    adapter1.authorize(authorizeRequest("thread-a")),
    adapter2.authorize(authorizeRequest("thread-b"))
  ]);
  assert.equal((authorized1 as { threadId: string }).threadId, "thread-a");
  assert.equal((authorized2 as { threadId: string }).threadId, "thread-b");
  await adapter1.close?.();
  await adapter2.close?.();
  assert.ok(first.closed >= 1);
  assert.ok(second.closed >= 1);
  await assert.rejects(
    adapter1.authorize(authorizeRequest("thread-a")),
    error => error instanceof SynodError && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
  );
});

test("unclassified child-loss details fail closed", async () => {
  const client = new FakeClient();
  client.failStart = new SynodError(ERROR_CODES.APP_SERVER_SPAWN_FAILED, "collapsed", {
    details: { childLoss: "mystery" }
  });
  const adapter = cliAdapter(client, () => client);
  await assert.rejects(
    adapter.spawn(spawnRequest()),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.HOST_ADAPTER_INVALID
      && error.message === "child loss was not classified."
      && childLossOf(error) === "mystery"
  );
  assert.equal(client.closed, 1);
});

test("selectHostDelegationAdapter keeps injected and Desktop Path B, uses CLI App Server on CLI", () => {
  const injected: HostDelegationAdapter = {
    async spawn() { return "injected"; },
    async authorize() { return { status: "authorized" }; },
    async close() {}
  };
  const cliAdapterValue: HostDelegationAdapter = {
    async spawn() { return "cli"; },
    async authorize() { return { status: "authorized" }; },
    async close() {}
  };
  let created = 0;
  assert.deepEqual(
    selectHostDelegationAdapter({
      adapter: injected,
      runtime: { surface: "cli", resolved: true, executableSource: "PATH" },
      createCliAdapter: () => {
        created += 1;
        return cliAdapterValue;
      }
    }),
    { path: "injected", adapter: injected }
  );
  assert.equal(created, 0);
  assert.deepEqual(
    selectHostDelegationAdapter({
      runtime: { surface: "desktop", resolved: true, executableSource: "desktop-process" },
      createCliAdapter: () => {
        created += 1;
        return cliAdapterValue;
      }
    }),
    { path: "handoff" }
  );
  assert.equal(created, 0);
  const cli = selectHostDelegationAdapter({
    runtime: { surface: "cli", resolved: true, executableSource: "PATH" },
    createCliAdapter: () => {
      created += 1;
      return cliAdapterValue;
    }
  });
  assert.equal(cli.path, "cli-app-server");
  if (cli.path !== "cli-app-server") throw new Error("expected cli-app-server");
  assert.equal(cli.adapter, cliAdapterValue);
  assert.equal(created, 1);
});

test("production Path A keeps a detached owner for sequential wait", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-production-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const threadId = "11111111-2222-4333-8444-555555555555";
  await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
const threadId = ${JSON.stringify(threadId)};
const thread = () => ({ id: threadId, cliVersion: "0.148.0", cwd: process.cwd(), status: { type: "idle" }, turns: [] });
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
  else if (message.method === "thread/start") reply(message.id, { thread: { ...thread(), model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "readOnly" } } });
  else if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
    setImmediate(() => {
      notify("thread/settings/updated", { threadId, threadSettings: { approvalPolicy: "never", approvalsReviewer: "user", collaborationMode: { mode: "default", settings: { model: "gpt-5.6-luna" } }, cwd: process.cwd(), model: "gpt-5.6-luna", modelProvider: "openai", effort: "max", sandboxPolicy: { type: "readOnly" } } });
      notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed", items: [] } });
      notify("thread/tokenUsage/updated", { threadId, turnId: "turn-1", tokenUsage: { totalTokens: 1 } });
    });
  } else if (message.method === "thread/list") reply(message.id, { data: [thread()], nextCursor: null });
  else if (message.method === "thread/read") reply(message.id, { thread: thread() });
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  try {
    const adapter = createCliAppServerAdapter({
      runtime: { surface: "cli", executable: fakeCodex },
      profile: "synod-5.6",
      directory
    });
    const spawn = spawnRequest();
    spawn.directory = directory;
    const spawned = await adapter.spawn(spawn);
    assert.deepEqual(spawned, { ownerId: threadId, threadId });
    const authorize = authorizeRequest(threadId);
    authorize.directory = directory;
    const receipt = await adapter.authorize(authorize);
    assert.equal((receipt as { status: string }).status, "authorized");
    assert.equal((receipt as { waitAuthority: string }).waitAuthority, "appServer");
    assert.equal((receipt as { restartLineage: { appServerRestarted: boolean } }).restartLineage.appServerRestarted, false);

    const waitClient = findCliAppServerWaitClient(directory, threadId);
    assert.ok(waitClient, "detached owner must publish an exact-thread endpoint");
    const observed = await waitClient!.request("thread/read", { threadId });
    assert.equal((observed as { thread: { id: string } }).thread.id, threadId);
    await waitClient!.close();
    await adapter.close?.();
    assert.equal(findCliAppServerWaitClient(directory, threadId), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production runner forwards App Server RPC rejection to the originating request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-rpc-error-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const reject = id => process.stdout.write(JSON.stringify({ id, error: { code: "FAKE_RPC_REJECTION", message: "thread start rejected by fake App Server" } }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
  else if (message.method === "thread/start") reject(message.id);
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const client = createCliAppServerRunnerClient({
    codexBin: fakeCodex,
    directory,
    requestTimeoutMs: 1_000
  });
  try {
    await client.start();
    await assert.rejects(
      client.request("thread/start"),
      error => error instanceof SynodError
        && error.code === ERROR_CODES.APP_SERVER_PROTOCOL_ERROR
        && error.message === "thread start rejected by fake App Server"
        && isRecord(error.details)
        && error.details.method === "thread/start"
        && error.details.rpcCode === "FAKE_RPC_REJECTION"
    );
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production runner close acknowledgement settles without the fallback timeout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-close-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const client = createCliAppServerRunnerClient({
    codexBin: fakeCodex,
    directory,
    requestTimeoutMs: 3_000
  });
  try {
    await client.start();
    const startedAt = Date.now();
    await client.close();
    assert.ok(Date.now() - startedAt < 1_000, "close must not wait for the parent fallback timeout");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production runner cleans up when retain metadata publication fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-retain-failure-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const marker = path.join(directory, "app-server.pid");
  const threadId = "44444444-5555-4666-8777-888888888888";
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const marker = ${JSON.stringify(marker)};
const threadId = ${JSON.stringify(threadId)};
writeFileSync(marker, String(process.pid));
const stop = () => {
  try { if (existsSync(marker)) unlinkSync(marker); } catch {}
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
  else if (message.method === "thread/start") reply(message.id, { thread: { id: threadId, cliVersion: "0.148.0", cwd: process.cwd(), status: { type: "idle" }, turns: [] } });
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const client = createCliAppServerRunnerClient({
    codexBin: fakeCodex,
    directory,
    requestTimeoutMs: 1_000,
    sessionTtlMs: 100
  });
  try {
    await client.start();
    await client.request("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      model: "gpt-5.6-luna",
      sandbox: "read-only"
    });
    const paths = waitEndpointPaths(directory, threadId);
    const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as { ownerPid?: unknown };
    assert.equal(typeof metadata.ownerPid, "number");
    const ownerPid = metadata.ownerPid as number;
    const blocker = path.join(directory, "metadata-blocker");
    await mkdir(blocker);
    await rm(paths.metadataPath, { force: true });
    await symlink(blocker, paths.metadataPath);
    const startedAt = Date.now();
    await assert.rejects(client.retain(), error => error instanceof SynodError);
    assert.ok(Date.now() - startedAt < 1_000, "retain failure must not wait for the session TTL");

    const cleanupDeadline = Date.now() + 5_000;
    while (Date.now() < cleanupDeadline
      && (existsSync(paths.metadataPath)
        || existsSync(paths.socketPath)
        || existsSync(marker)
        || (() => {
          try { process.kill(ownerPid, 0); return true; } catch { return false; }
        })())) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(paths.metadataPath), false, "retain failure must remove endpoint metadata");
    assert.equal(existsSync(paths.socketPath), false, "retain failure must remove endpoint socket");
    assert.equal(existsSync(marker), false, "retain failure must close the owned App Server");
    assert.throws(() => process.kill(ownerPid, 0), /ESRCH|not found/i);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production runner cleans up after completion when control disconnects before retain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-disconnect-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const helperScript = path.join(directory, "starter.mjs");
  const marker = path.join(directory, "app-server.pid");
  const threadId = "33333333-4444-4555-8666-777777777777";
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const marker = ${JSON.stringify(marker)};
const threadId = ${JSON.stringify(threadId)};
writeFileSync(marker, String(process.pid));
const stop = () => {
  try { if (existsSync(marker)) unlinkSync(marker); } catch {}
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const thread = () => ({ id: threadId, cliVersion: "0.148.0", cwd: process.cwd(), status: { type: "idle" }, turns: [] });
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
  else if (message.method === "thread/start") reply(message.id, { thread: { ...thread(), model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "readOnly" } } });
  else if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
    setTimeout(() => notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed", items: [] } }), 10);
  }
});
`, "utf8");
  await chmod(fakeCodex, 0o755);
  await writeFile(helperScript, `import { createCliAppServerRunnerClient } from ${JSON.stringify(path.join(testRepositoryRoot, "src/cli-app-server-runner.ts"))};
const client = createCliAppServerRunnerClient({
  codexBin: ${JSON.stringify(fakeCodex)},
  directory: ${JSON.stringify(directory)},
  requestTimeoutMs: 1_000,
  sessionTtlMs: 100
});
await client.start();
await client.request("thread/start", { cwd: ${JSON.stringify(directory)}, approvalPolicy: "never", model: "gpt-5.6-luna", sandbox: "read-only" });
let completed = false;
client.subscribeEvents(event => {
  if (event.type === "notification" && event.method === "turn/completed") completed = true;
});
await client.request("turn/start", { threadId: ${JSON.stringify(threadId)}, input: [] });
const deadline = Date.now() + 1_000;
while (!completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
if (!completed) throw new Error("turn/completed was not observed");
process.stdout.write("ready\\n");
await new Promise(() => {});
`, "utf8");
  const helper = spawn(process.execPath, [...childLoaderArgv(), helperScript], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  helper.stderr?.setEncoding("utf8");
  helper.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const onData = (chunk: string) => {
        output += chunk;
        if (!output.includes("ready\n")) return;
        helper.stdout?.off("data", onData);
        helper.off("error", onError);
        helper.off("exit", onExit);
        resolve();
      };
      const onError = (error: Error) => reject(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`starter exited before disconnect (${code ?? "signal"} ${signal ?? ""}): ${stderr}`));
      };
      helper.stdout?.setEncoding("utf8");
      helper.stdout?.on("data", onData);
      helper.once("error", onError);
      helper.once("exit", onExit);
    });
    const paths = waitEndpointPaths(directory, threadId);
    const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as { ownerPid?: unknown; expiresAt?: unknown };
    assert.equal(metadata.expiresAt, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof metadata.ownerPid, "number");
    const ownerPid = metadata.ownerPid as number;
    assert.doesNotThrow(() => process.kill(ownerPid, 0));
    assert.ok(existsSync(paths.socketPath));
    assert.ok(existsSync(marker));

    helper.kill("SIGTERM");
    await new Promise<void>(resolve => helper.once("exit", () => resolve()));
    const cleanupDeadline = Date.now() + 5_000;
    while (Date.now() < cleanupDeadline
      && (existsSync(paths.metadataPath)
        || existsSync(paths.socketPath)
        || existsSync(marker)
        || (() => {
          try { process.kill(ownerPid, 0); return true; } catch { return false; }
        })())) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(paths.metadataPath), false, "control loss after completion must remove endpoint metadata");
    assert.equal(existsSync(paths.socketPath), false, "control loss after completion must remove endpoint socket");
    assert.equal(existsSync(marker), false, "control loss after completion must close the owned App Server");
    assert.throws(() => process.kill(ownerPid, 0), /ESRCH|not found/i);
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGTERM");
    if (helper.exitCode === null && helper.signalCode === null) {
      await new Promise<void>(resolve => helper.once("exit", () => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("production detached owner TTL removes endpoint, runner, and App Server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-runner-ttl-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const marker = path.join(directory, "app-server.pid");
  const threadId = "22222222-3333-4444-8555-666666666666";
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const marker = ${JSON.stringify(marker)};
const threadId = ${JSON.stringify(threadId)};
writeFileSync(marker, String(process.pid));
const stop = () => {
  try { if (existsSync(marker)) unlinkSync(marker); } catch {}
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
  const thread = () => ({ id: threadId, cliVersion: "0.148.0", cwd: process.cwd(), status: { type: "idle" }, turns: [] });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + "\\n");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, { userAgent: "codex-cli/0.148.0", codexHome: "/tmp" });
    else if (message.method === "thread/start") reply(message.id, { thread: { ...thread(), model: "gpt-5.6-luna", reasoningEffort: "max", sandbox: { type: "readOnly" } } });
    else if (message.method === "turn/start") {
      reply(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
      setTimeout(() => notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed", items: [] } }), 10);
    }
    else if (message.method === "thread/read") reply(message.id, { thread: thread() });
  });
`, "utf8");
  await chmod(fakeCodex, 0o755);
  const client = createCliAppServerRunnerClient({
    codexBin: fakeCodex,
    directory,
    requestTimeoutMs: 1_000,
    sessionTtlMs: 100
  });
  try {
    await client.start();
    const spawned = await client.request("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      model: "gpt-5.6-luna",
      sandbox: "read-only"
    });
    assert.equal((spawned as { thread: { id: string } }).thread.id, threadId);

    const paths = waitEndpointPaths(directory, threadId);
    assert.ok(existsSync(paths.metadataPath), "TTL owner must publish metadata");
    assert.ok(existsSync(paths.socketPath), "TTL owner must publish a socket");
    const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as { ownerPid?: unknown; expiresAt?: unknown };
    assert.equal(typeof metadata.ownerPid, "number");
    assert.equal(metadata.expiresAt, Number.MAX_SAFE_INTEGER);
    const ownerPid = metadata.ownerPid as number;
    assert.doesNotThrow(() => process.kill(ownerPid, 0));
    assert.ok(existsSync(marker), "the owned App Server must be live before TTL");

    let completed = false;
    const unsubscribe = client.subscribeEvents(event => {
      if (event.type === "notification" && event.method === "turn/completed") completed = true;
    });
    await client.request("turn/start", { threadId, input: [] });
    const completionDeadline = Date.now() + 1_000;
    while (!completed && Date.now() < completionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    unsubscribe();
    assert.equal(completed, true, "the production runner must observe turn/completed");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(existsSync(paths.metadataPath), "completion must not spend the observation TTL");
    assert.ok(existsSync(paths.socketPath), "completion must leave the endpoint available before retain");
    assert.doesNotThrow(() => process.kill(ownerPid, 0), "completion must not expire the runner before retain");
    assert.ok(existsSync(marker), "completion must leave the owned App Server live before retain");
    const retainedAt = Date.now();
    await client.retain();
    const retainedMetadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as { expiresAt?: unknown };
    assert.equal(typeof retainedMetadata.expiresAt, "number");
    assert.ok((retainedMetadata.expiresAt as number) >= retainedAt + 75, "retention must refresh a full observation window");

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline
      && (existsSync(paths.metadataPath)
        || existsSync(paths.socketPath)
        || existsSync(marker)
        || (() => {
          try { process.kill(ownerPid, 0); return true; } catch { return false; }
        })())) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(paths.metadataPath), false, "TTL must remove endpoint metadata");
    assert.equal(existsSync(paths.socketPath), false, "TTL must remove endpoint socket");
    assert.equal(existsSync(marker), false, "TTL must close the owned App Server");
    assert.throws(() => process.kill(ownerPid, 0), /ESRCH|not found/i);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
