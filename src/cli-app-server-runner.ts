import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAppServerClient,
  type AppServerDiagnostics,
  type AppServerEvent
} from "./app-server.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { isRecord } from "./validation.js";

/**
 * The production CLI Path A owner.  It is intentionally a separate process:
 * the short-lived `synod delegate start` process owns only this control
 * connection, while this process owns the App Server and its exact-thread
 * wait endpoint until the bounded endpoint lifetime ends or a caller closes
 * it.
 */

const RUNNER_MARKER = "--synod-cli-app-server-runner";
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const UNARMED_ENDPOINT_EXPIRY = Number.MAX_SAFE_INTEGER;

export interface CliAppServerRunnerClientOptions {
  codexBin: string;
  directory: string;
  requestTimeoutMs?: number;
  sessionTtlMs?: number;
}

export interface CliAppServerRunnerClient {
  start(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  getDiagnostics(): AppServerDiagnostics;
  close(): Promise<unknown>;
  subscribeEvents(listener: (event: AppServerEvent) => void): () => void;
  retain(): Promise<void>;
  detach(): void;
}

interface ControlRequest {
  id: number;
  token: string;
  method: string;
  params?: Record<string, unknown>;
}

interface ControlResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface ControlEvent {
  event: AppServerEvent;
}

interface EndpointMetadata {
  version: 1;
  threadId: string;
  directory: string;
  token: string;
  expiresAt: number;
  socketPath: string;
  ownerPid: number;
}

interface EndpointRequest {
  version: 1;
  threadId: string;
  token: string;
  method: "thread/read" | "close";
  params?: Record<string, unknown>;
}

type EndpointResponse =
  | { ok: true; result?: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

interface RunnerArguments {
  socketPath: string;
  token: string;
  directory: string;
  codexBin: string;
  sessionTtlMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function endpointRoot(): string {
  return path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "synod-cli-app-server");
}

/** Kept in one module so the detached owner and parent derive identical paths. */
export function cliAppServerEndpointPaths(directory: string, threadId: string): {
  metadataPath: string;
  socketPath: string;
} {
  const identity = createHash("sha256")
    .update(`${process.getuid?.() ?? "unknown"}\0${path.resolve(directory)}\0${threadId}`)
    .digest("hex");
  return {
    metadataPath: path.join(endpointRoot(), `${identity.slice(0, 32)}.json`),
    socketPath: path.join(endpointRoot(), `${identity.slice(0, 32)}.sock`)
  };
}

function controlPath(): { directory: string; socketPath: string; metadataPath: string } {
  const directory = path.join(endpointRoot(), "control");
  const id = randomUUID().replaceAll("-", "");
  return {
    directory,
    socketPath: path.join(directory, `${id}.sock`),
    metadataPath: path.join(directory, `${id}.json`)
  };
}

function errorRecord(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof SynodError) {
    return {
      code: error.code,
      message: error.message,
      ...(isRecord(error.details) ? { details: error.details } : {})
    };
  }
  return {
    code: ERROR_CODES.APP_SERVER_EXITED,
    message: error instanceof Error ? error.message : String(error)
  };
}

function errorFromRecord(value: unknown): SynodError {
  const record = isRecord(value) ? value : {};
  const code = typeof record.code === "string" ? record.code : ERROR_CODES.APP_SERVER_EXITED;
  const message = typeof record.message === "string" ? record.message : "CLI App Server runner failed.";
  return new SynodError(code as typeof ERROR_CODES[keyof typeof ERROR_CODES], message, {
    details: isRecord(record.details) ? record.details : undefined
  });
}

function writeLine(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function writeLineFlushed(socket: Socket, value: unknown): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve();
    };
    const onError = () => finish();
    const onClose = () => finish();
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      socket.write(`${JSON.stringify(value)}\n`, finish);
    } catch {
      finish();
    }
  });
}

function threadIdFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined;
  return asString(value.thread.id) ?? asString(value.thread.threadId);
}

function diagnosticsIsCli(value: AppServerDiagnostics): boolean {
  return value.codexSurface === "cli"
    && !value.appServer.launchedArgv?.some((item, index, argv) =>
      item === "--enable" && argv[index + 1] === "multi_agent_v2"
        || item === "--enable=multi_agent_v2");
}

function endpointError(error: unknown): EndpointResponse {
  return { ok: false, error: errorRecord(error) };
}

function ownerProcessIsAlive(ownerPid: number): boolean {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

async function removeEndpoint(metadata: EndpointMetadata | undefined): Promise<void> {
  if (!metadata) return;
  await Promise.all([
    unlink(metadata.socketPath).catch(() => undefined),
    unlink(cliAppServerEndpointPaths(metadata.directory, metadata.threadId).metadataPath).catch(() => undefined)
  ]);
}

class DetachedRunnerOwner {
  private readonly args: RunnerArguments;
  private readonly client: CodexAppServerClient;
  private readonly controlServer: Server;
  private controlSocket: Socket | undefined;
  private endpointServer: Server | undefined;
  private endpointSocket: Socket | undefined;
  private endpointMetadata: EndpointMetadata | undefined;
  private endpointTimer: ReturnType<typeof setTimeout> | undefined;
  private ready: Promise<void>;
  private readyFailure: SynodError | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private retained = false;
  private currentTurnThread: string | undefined;

  constructor(args: RunnerArguments) {
    this.args = args;
    this.client = new CodexAppServerClient({ codexBin: args.codexBin, cwd: args.directory });
    this.controlServer = createServer(socket => this.acceptControl(socket));
    this.ready = this.initialize();
    this.client.subscribeEvents(event => this.forwardEvent(event));
  }

  async run(): Promise<void> {
    await mkdir(path.dirname(this.args.socketPath), { recursive: true, mode: 0o700 });
    await this.controlServer.listen(this.args.socketPath);
    try {
      await this.ready;
    } catch (error) {
      this.readyFailure = error instanceof SynodError ? error : new SynodError(
        ERROR_CODES.APP_SERVER_SPAWN_FAILED,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async initialize(): Promise<void> {
    await this.client.start();
    const diagnostics = this.client.getDiagnostics();
    if (!diagnosticsIsCli(diagnostics)) {
      throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "CLI App Server runner received a non-CLI surface.", {
        details: { surface: diagnostics.codexSurface ?? null }
      });
    }
  }

  private acceptControl(socket: Socket): void {
    if (this.closed || this.controlSocket) {
      socket.destroy();
      return;
    }
    this.controlSocket = socket;
    socket.setEncoding("utf8");
    let buffered = "";
    let chain = Promise.resolve();
    socket.on("data", chunk => {
      buffered += chunk;
      if (buffered.length > 1_000_000) {
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.trim()) continue;
        chain = chain.then(async () => {
          let requestId = -1;
          try {
            const request: unknown = JSON.parse(line);
            if (isRecord(request) && typeof request.id === "number") requestId = request.id;
            await this.handleControl(socket, request);
          } catch (error) {
            writeLine(socket, { id: requestId, ok: false, error: errorRecord(error) } satisfies ControlResponse);
          }
        });
      }
    });
    socket.on("close", () => {
      if (this.controlSocket !== socket) return;
      this.controlSocket = undefined;
      // The starter remains authoritative until it explicitly retains the
      // owner. A completed turn alone must not turn a lost control handoff
      // into an unbounded runner.
      if (!this.retained) void this.close();
      else {
        try { this.controlServer.close(); } catch { /* already closed */ }
        void unlink(this.args.socketPath).catch(() => undefined);
      }
    });
  }

  private forwardEvent(event: AppServerEvent): void {
    if (this.controlSocket) writeLine(this.controlSocket, { event } satisfies ControlEvent);
    if (event.type === "failure" && !this.retained) void this.close();
  }

  private async handleControl(socket: Socket, value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.id !== "number" || typeof value.token !== "string" || typeof value.method !== "string") {
      throw new SynodError(ERROR_CODES.APP_SERVER_PROTOCOL_ERROR, "CLI App Server runner received malformed control data.");
    }
    const request = value as unknown as ControlRequest;
    if (request.token !== this.args.token) {
      writeLine(socket, {
        id: request.id,
        ok: false,
        error: {
          code: ERROR_CODES.HOST_ADAPTER_INVALID,
          message: "CLI App Server runner rejected an unauthenticated control request."
        }
      } satisfies ControlResponse);
      socket.destroy();
      return;
    }
    if (request.method === "close") {
      await this.close(false);
      await writeLineFlushed(socket, { id: request.id, ok: true } satisfies ControlResponse);
      socket.end();
      setImmediate(() => process.exit(0));
      return;
    }
    try {
      await this.ready;
    } catch (error) {
      writeLine(socket, { id: request.id, ok: false, error: errorRecord(error) } satisfies ControlResponse);
      await this.close();
      return;
    }
    if (this.readyFailure) {
      writeLine(socket, { id: request.id, ok: false, error: errorRecord(this.readyFailure) } satisfies ControlResponse);
      await this.close();
      return;
    }
    if (request.method === "runner/ping") {
      writeLine(socket, { id: request.id, ok: true, result: { diagnostics: this.client.getDiagnostics() } } satisfies ControlResponse);
      return;
    }
    if (request.method === "runner/retain") {
      if (!this.endpointMetadata || !this.currentTurnThread) {
        throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "CLI App Server runner cannot retain before thread/start.");
      }
      this.retained = true;
      try {
        await this.armEndpointObservation();
      } catch (error) {
        this.retained = false;
        // A failed metadata publication must not leave an unarmed endpoint
        // with an effectively infinite lifetime while control remains open.
        void this.close();
        throw error;
      }
      writeLine(socket, { id: request.id, ok: true, result: { threadId: this.currentTurnThread } } satisfies ControlResponse);
      return;
    }
    const result = await this.client.request(request.method, isRecord(request.params) ? request.params : {});
    if (request.method === "thread/start") {
      const threadId = threadIdFrom(result);
      if (!threadId) throw new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "thread/start did not return a thread identity.");
      this.currentTurnThread = threadId;
      await this.startWaitEndpoint(threadId);
    }
    if (request.method === "turn/start") {
      const params = isRecord(request.params) ? request.params : {};
      this.currentTurnThread = asString(params.threadId) ?? this.currentTurnThread;
    }
    writeLine(socket, { id: request.id, ok: true, result } satisfies ControlResponse);
  }

  private async startWaitEndpoint(threadId: string): Promise<void> {
    const paths = cliAppServerEndpointPaths(this.args.directory, threadId);
    await mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(paths.metadataPath) || existsSync(paths.socketPath)) {
      const stale = this.readEndpointMetadata(paths.metadataPath);
      if (!stale || (stale.expiresAt > Date.now() && ownerProcessIsAlive(stale.ownerPid))) {
        throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "an exact-thread CLI App Server wait endpoint is already present.", {
          details: { threadId, socketPath: paths.socketPath }
        });
      }
      await rm(paths.metadataPath, { force: true });
      await rm(paths.socketPath, { force: true });
    }
    const metadata: EndpointMetadata = {
      version: 1,
      threadId,
      directory: path.resolve(this.args.directory),
      token: randomUUID(),
      // Keep the endpoint discoverable while the starter runs its bounded
      // turn, but do not spend the observation TTL before retention succeeds.
      // Control loss still closes an unretained owner immediately.
      expiresAt: UNARMED_ENDPOINT_EXPIRY,
      socketPath: paths.socketPath,
      ownerPid: process.pid
    };
    await writeFile(paths.metadataPath, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
    this.endpointMetadata = metadata;
    this.endpointServer = createServer(socket => this.acceptEndpoint(socket, metadata));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.endpointServer?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.endpointServer?.off("error", onError);
        resolve();
      };
      this.endpointServer?.once("error", onError);
      this.endpointServer?.once("listening", onListening);
      this.endpointServer?.listen(paths.socketPath);
    }).catch(async error => {
      await removeEndpoint(metadata);
      throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "CLI App Server wait endpoint could not be bound.", {
        cause: error,
        details: { socketPath: paths.socketPath }
      });
    });
  }

  private async armEndpointObservation(): Promise<void> {
    const current = this.endpointMetadata;
    if (this.closed || !current) return;
    if (this.endpointTimer !== undefined) clearTimeout(this.endpointTimer);
    this.endpointTimer = undefined;
    const metadata: EndpointMetadata = {
      ...current,
      expiresAt: Date.now() + this.args.sessionTtlMs
    };
    this.endpointMetadata = metadata;
    const metadataPath = cliAppServerEndpointPaths(metadata.directory, metadata.threadId).metadataPath;
    writeFileSync(metadataPath, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
    const timer = setTimeout(() => { void this.close(); }, this.args.sessionTtlMs);
    timer.unref?.();
    this.endpointTimer = timer;
  }

  private readEndpointMetadata(metadataPath: string): EndpointMetadata | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (!isRecord(value) || value.version !== 1 || typeof value.threadId !== "string"
        || typeof value.directory !== "string" || typeof value.token !== "string"
        || typeof value.expiresAt !== "number" || typeof value.socketPath !== "string"
        || typeof value.ownerPid !== "number") return undefined;
      return value as unknown as EndpointMetadata;
    } catch {
      return undefined;
    }
  }

  private acceptEndpoint(socket: Socket, metadata: EndpointMetadata): void {
    if (this.closed || this.endpointSocket) {
      socket.destroy();
      return;
    }
    this.endpointSocket = socket;
    socket.setEncoding("utf8");
    let buffered = "";
    let chain = Promise.resolve();
    socket.on("data", chunk => {
      buffered += chunk;
      if (buffered.length > 1_000_000) {
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.trim()) continue;
        chain = chain.then(async () => {
          try {
            await this.handleEndpoint(socket, metadata, JSON.parse(line));
          } catch (error) {
            writeLine(socket, endpointError(error));
            socket.destroy();
          }
        });
      }
    });
    socket.on("close", () => {
      if (this.endpointSocket !== socket) return;
      this.endpointSocket = undefined;
      if (!this.closed) void this.close();
    });
  }

  private async handleEndpoint(socket: Socket, metadata: EndpointMetadata, value: unknown): Promise<void> {
    if (!isRecord(value) || value.version !== 1 || value.threadId !== metadata.threadId
      || value.token !== metadata.token || (value.method !== "thread/read" && value.method !== "close")) {
      writeLine(socket, {
        ok: false,
        error: {
          code: ERROR_CODES.HOST_ADAPTER_INVALID,
          message: "CLI App Server wait endpoint rejected a mismatched request.",
          details: { expectedThreadId: metadata.threadId }
        }
      } satisfies EndpointResponse);
      socket.destroy();
      return;
    }
    if (value.method === "close") {
      writeLine(socket, { ok: true } satisfies EndpointResponse);
      socket.end();
      return;
    }
    const params = isRecord(value.params) ? value.params : {};
    if (params.threadId !== metadata.threadId) {
      writeLine(socket, {
        ok: false,
        error: {
          code: ERROR_CODES.APP_SERVER_UNSUPPORTED,
          message: "CLI App Server wait endpoint requires the exact owning thread UUID.",
          details: { expectedThreadId: metadata.threadId, observedThreadId: params.threadId }
        }
      } satisfies EndpointResponse);
      socket.destroy();
      return;
    }
    try {
      const result = await this.client.request("thread/read", { threadId: metadata.threadId, includeTurns: false });
      writeLine(socket, { ok: true, result } satisfies EndpointResponse);
    } catch (error) {
      writeLine(socket, endpointError(error));
      socket.end();
      await this.close();
    }
  }

  private close(exit = true): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal(exit);
    return this.closing;
  }

  private async closeInternal(exit: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.endpointTimer !== undefined) clearTimeout(this.endpointTimer);
    this.endpointTimer = undefined;
    const endpointSocket = this.endpointSocket;
    this.endpointSocket = undefined;
    endpointSocket?.destroy();
    const endpointServer = this.endpointServer;
    this.endpointServer = undefined;
    try { endpointServer?.close(); } catch { /* already closed */ }
    await removeEndpoint(this.endpointMetadata);
    this.endpointMetadata = undefined;
    try { this.controlServer.close(); } catch { /* already closed */ }
    await unlink(this.args.socketPath).catch(() => undefined);
    await this.client.close().catch(() => undefined);
    this.controlSocket = undefined;
    if (exit) setImmediate(() => process.exit(0));
  }
}

function runnerArgs(argv: readonly string[]): RunnerArguments {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    const result = index >= 0 ? argv[index + 1] : undefined;
    if (!result) throw new Error(`missing runner argument ${name}`);
    return result;
  };
  const ttl = Number(value("--session-ttl-ms"));
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("invalid runner session TTL");
  return {
    socketPath: value("--control-socket"),
    token: value("--control-token"),
    directory: path.resolve(value("--directory")),
    codexBin: value("--codex-bin"),
    sessionTtlMs: ttl
  };
}

async function runnerMain(): Promise<void> {
  const args = runnerArgs(process.argv);
  // The token is deliberately passed in the argv only to let the parent prove
  // it connected to the owner it launched; the one-shot control socket is
  // inaccessible to other users through its 0700 parent directory.
  if (!args.token) throw new Error("missing runner control token");
  const owner = new DetachedRunnerOwner(args);
  await owner.run();
}

function loaderArgvValue(flag: string, specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("://") || specifier.startsWith("node:")) {
    return specifier;
  }
  try {
    const resolved = import.meta.resolve(specifier);
    return flag === "--require" ? fileURLToPath(resolved) : resolved;
  } catch {
    return specifier;
  }
}

function sourceLoaderArgv(): string[] {
  const result: string[] = [];
  const argv = process.execArgv;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === undefined) continue;
    if (item === "--require" || item === "--import") {
      const next = argv[index + 1];
      if (next) result.push(item, loaderArgvValue(item, next));
      index += 1;
    } else if (item.startsWith("--require=") || item.startsWith("--import=")) {
      const separator = item.indexOf("=");
      result.push(`${item.slice(0, separator + 1)}${loaderArgvValue(item.slice(0, separator), item.slice(separator + 1))}`);
    }
  }
  return result;
}

function runnerModulePath(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./cli-app-server-runner${extension}`, import.meta.url));
}

function waitForConnection(socketPath: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket | undefined;
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(new SynodError(ERROR_CODES.APP_SERVER_TIMEOUT, "CLI App Server runner did not open its control endpoint."));
        return;
      }
      socket = createConnection(socketPath);
      socket.once("connect", () => {
        if (timer) clearTimeout(timer);
        resolve(socket!);
      });
      socket.once("error", () => {
        socket?.destroy();
        timer = setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

export function createCliAppServerRunnerClient(options: CliAppServerRunnerClientOptions): CliAppServerRunnerClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  let child: ChildProcess | undefined;
  let socket: Socket | undefined;
  let started = false;
  let closed = false;
  let nextId = 1;
  let buffered = "";
  let control: { directory: string; socketPath: string; token: string; metadataPath: string } | undefined;
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(event: AppServerEvent) => void>();
  let diagnostics: AppServerDiagnostics = {
    codexExecutable: options.codexBin,
    codexSurface: undefined,
    appServer: { capabilities: { initialize: false, threadList: false, modelList: false } }
  };

  const failPending = (error: unknown) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line: string) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      failPending(new SynodError(ERROR_CODES.APP_SERVER_PROTOCOL_ERROR, "CLI App Server runner emitted malformed control data."));
      return;
    }
    if (!isRecord(value)) return;
    if (isRecord(value.event)) {
      const event = value.event as AppServerEvent;
      for (const listener of listeners) listener(event);
      return;
    }
    const id = typeof value.id === "number" ? value.id : undefined;
    if (id === undefined) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (value.ok !== true) entry.reject(errorFromRecord(value.error));
    else entry.resolve(value.result);
  };

  const attachSocket = (next: Socket) => {
    socket = next;
    next.setEncoding("utf8");
    next.on("data", chunk => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim()) handleLine(line);
      }
    });
    next.on("close", () => {
      if (socket !== next) return;
      socket = undefined;
      if (!closed) failPending(new SynodError(ERROR_CODES.APP_SERVER_EXITED, "CLI App Server runner control endpoint closed."));
    });
  };

  const request = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (!socket || socket.destroyed || closed) {
      return Promise.reject(new SynodError(ERROR_CODES.APP_SERVER_NOT_RUNNING, "CLI App Server runner is not connected."));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SynodError(ERROR_CODES.APP_SERVER_TIMEOUT, `CLI App Server runner timed out while calling ${method}.`, {
          details: { method, timeoutMs: requestTimeoutMs }
        }));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket!.write(`${JSON.stringify({ id, token: control?.token, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  return {
    async start() {
      if (started) return;
      if (closed) throw new SynodError(ERROR_CODES.APP_SERVER_NOT_RUNNING, "CLI App Server runner is closed.");
      control = { ...controlPath(), token: randomUUID() };
      await mkdir(control.directory, { recursive: true, mode: 0o700 });
      child = spawn(process.execPath, [
        ...sourceLoaderArgv(),
        runnerModulePath(),
        RUNNER_MARKER,
        "--control-socket", control.socketPath,
        "--control-token", control.token,
        "--directory", path.resolve(options.directory),
        "--codex-bin", options.codexBin,
        "--session-ttl-ms", String(sessionTtlMs)
      ], {
        cwd: path.resolve(options.directory),
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      try {
        attachSocket(await waitForConnection(control.socketPath, requestTimeoutMs));
        const handshake = await request("runner/ping") as { diagnostics?: unknown };
        if (isRecord(handshake?.diagnostics)) diagnostics = handshake.diagnostics as unknown as AppServerDiagnostics;
        started = true;
      } catch (error) {
        await this.close();
        throw error;
      }
    },
    request,
    getDiagnostics() {
      return structuredClone(diagnostics);
    },
    subscribeEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async retain() {
      if (!socket || socket.destroyed || closed) return;
      await request("runner/retain");
      const current = socket;
      socket = undefined;
      current.unref();
      current.end();
    },
    detach() {
      socket?.unref();
    },
    async close() {
      if (closed) return;
      try {
        if (socket && !socket.destroyed) {
          const closeRequest = request("close");
          // Mark the transport closed only after the close request has been
          // queued; request() intentionally rejects new work while closed.
          closed = true;
          await Promise.race([
            closeRequest,
            new Promise(resolve => setTimeout(resolve, Math.min(requestTimeoutMs, 2_000)))
          ]);
        }
      } catch { /* owner may already have exited */ }
      closed = true;
      socket?.destroy();
      socket = undefined;
      failPending(new SynodError(ERROR_CODES.APP_SERVER_NOT_RUNNING, "CLI App Server runner closed."));
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      child?.unref();
      if (control) {
        await unlink(control.socketPath).catch(() => undefined);
        await unlink(control.metadataPath).catch(() => undefined);
      }
    }
  };
}

if (process.argv.includes(RUNNER_MARKER)) {
  void runnerMain().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
