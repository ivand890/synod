import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  CodexAppServerClient,
  type AppServerDiagnostics,
  type AppServerEvent
} from "./app-server.js";
import { createCliAppServerRunnerClient } from "./cli-app-server-runner.js";
import type { ResolvedCodexRuntime } from "./codex-runtime.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import {
  isChildLossMode,
  unclassifiedChildLossError,
  withChildLoss,
  type HostAuthorizationReceipt,
  type HostDelegationAdapter,
  type HostDelegationAuthorizeRequest,
  type HostDelegationSpawnRequest,
  type HostDelegationSpawnResult
} from "./host-delegation.js";
import { normalizeLeaseScopePath, type LeaseScope } from "./leases.js";
import { isDelegationRole, resolveDelegationProfile, type DelegationProfile, type DelegationRole } from "./profiles.js";
import { isRecord } from "./validation.js";
import type { WaitLossCause } from "./wait.js";

const activeWriterScopes = new Set<string>();

export const CLI_APP_SERVER_FEATURE_MULTI_AGENT_V2 = "multi_agent_v2" as const;
export const DEFAULT_CLI_APP_SERVER_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_APP_SERVER_EXECUTOR = "synod_implementer" as const;
const CLI_APP_SERVER_WAIT_SESSION_TTL_MS = DEFAULT_CLI_APP_SERVER_TURN_TIMEOUT_MS;
const CLI_APP_SERVER_OWNER_DISPOSAL_TIMEOUT_MS = 2_000;

export type CliAppServerTokenAttribution = "available" | "partial" | "unavailable";
export type CliAppServerRuntimeStatus = "loaded" | "notLoaded" | "unknown";

export interface CliAppServerClient {
  start(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  getDiagnostics(): AppServerDiagnostics;
  close(): Promise<unknown>;
  subscribeEvents?(listener: (event: AppServerEvent) => void): () => void;
  /** Production detached owners must not keep the short-lived starter alive. */
  detach?(): void;
  /** Retain the detached owner while releasing this process's control transport. */
  retain?(): Promise<void>;
}

export type CliAppServerClientFactory = () => CliAppServerClient;

export interface CliAppServerAdapterOptions {
  runtime: Pick<ResolvedCodexRuntime, "surface" | "executable">;
  /** Profile recorded by the installed Synod manifest. */
  profile?: string | undefined;
  role?: DelegationRole;
  directory?: string;
  clientFactory?: CliAppServerClientFactory;
  turnCompletionTimeoutMs?: number;
  sessionTtlMs?: number;
}

export interface CliAppServerTurnEvidence {
  threadId: string;
  turnId: string;
  role?: DelegationRole;
  turnStatus: "completed";
  waitAuthority: "appServer";
  /** A completed transport turn is not a canonical delivery until its exact proposal is sealed. */
  completion: "incomplete";
  proposalRequired: boolean;
  sandbox: "read-only" | "workspace-write";
  model: string;
  reasoningEffort: string;
  runtimeWorkspaceRoots: string[];
  tokenAttribution: CliAppServerTokenAttribution;
  restartLineage: {
    appServerRestarted: boolean;
    queryMethod: "thread/list";
    usedThreadResume: false;
    completion: "not-claimed";
    status: CliAppServerRuntimeStatus;
  };
}

interface LiveSession {
  client: CliAppServerClient;
  ownerThread: string;
  implementer: DelegationProfile;
  directory: string;
  threadStartResponse: unknown;
  contract: HostDelegationSpawnRequest["readOnlyContract"];
  authorized: boolean;
  closed: boolean;
  endpointServer?: Server | undefined;
  endpointSocket?: Socket | undefined;
  endpointSocketPath?: string | undefined;
  endpointMetadataPath?: string | undefined;
  endpointToken?: string | undefined;
  endpointTimer?: ReturnType<typeof setTimeout> | undefined;
  retainForObservation?: boolean | undefined;
}

function launchedArgv(diagnostics: AppServerDiagnostics): string[] {
  const top = diagnostics.launchedArgv;
  if (Array.isArray(top) && top.every(item => typeof item === "string")) return [...top];
  const appServer: unknown = diagnostics.appServer;
  const nested = isRecord(appServer) ? appServer.launchedArgv : undefined;
  if (Array.isArray(nested) && nested.every(item => typeof item === "string")) return [...nested];
  return [];
}

function hasMultiAgentV2(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--enable" && argv[index + 1] === CLI_APP_SERVER_FEATURE_MULTI_AGENT_V2) {
      return true;
    }
    if (argv[index] === `--enable=${CLI_APP_SERVER_FEATURE_MULTI_AGENT_V2}`) return true;
  }
  return false;
}

function hasExplicitMultiAgentV2Disable(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--disable" && argv[index + 1] === CLI_APP_SERVER_FEATURE_MULTI_AGENT_V2) return true;
    if (argv[index] === `--disable=${CLI_APP_SERVER_FEATURE_MULTI_AGENT_V2}`) return true;
  }
  return false;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPathLikeThreadIdentity(value: string): boolean {
  return value === "."
    || value === ".."
    || value.startsWith("./")
    || value.startsWith("../")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value);
}

function threadIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const thread = isRecord(value.thread) ? value.thread : value;
  return asString(thread.threadId) ?? asString(thread.id) ?? asString(value.threadId);
}

function threadStartIdentity(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined;
  const identity = asString(value.thread.id);
  // Codex-generated thread IDs are UUIDs. A cwd/path here is malformed input,
  // not an opaque owner, and would make the later thread/read call fail with a
  // protocol error after an invalid lease had already been bound.
  return identity && !isPathLikeThreadIdentity(identity) ? identity : undefined;
}

function turnStartIdentity(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.turn)) return undefined;
  return asString(value.turn.id);
}

function normalizeSandbox(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    if (value === "readOnly") return "read-only";
    return value.trim();
  }
  if (isRecord(value) && typeof value.type === "string") {
    if (value.type === "readOnly") return "read-only";
    if (value.type === "workspaceWrite") return "workspace-write";
    if (value.type === "dangerFullAccess") return "danger-full-access";
    return value.type;
  }
  return undefined;
}

function normalizeRoots(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw adapterError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "runtime workspace roots were malformed.");
  }
  return [...value];
}

function policyMetadata(value: unknown): {
  sandbox?: string;
  runtimeWorkspaceRoots?: string[];
} {
  if (!isRecord(value)) return {};
  if (!["readOnly", "workspaceWrite", "externalSandbox", "dangerFullAccess"].includes(String(value.type))) return {};
  const sandbox = normalizeSandbox(value);
  const roots = value.type === "readOnly"
    ? []
    : normalizeRoots(value.writableRoots);
  return {
    ...(sandbox ? { sandbox } : {}),
    ...(roots === undefined ? {} : { runtimeWorkspaceRoots: roots })
  };
}

function normalizeRuntimeStatus(value: unknown): CliAppServerRuntimeStatus {
  if (!isRecord(value) || typeof value.type !== "string") return "unknown";
  return value.type === "notLoaded" ? "notLoaded" : "loaded";
}

function numericTokenValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasNumericTokenUsage(value: unknown, seen = new Set<unknown>()): boolean {
  if (numericTokenValue(value)) return true;
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => hasNumericTokenUsage(item, seen));
}

function classifyTokenAttribution(values: unknown[]): CliAppServerTokenAttribution {
  const present = values.filter(value => value !== undefined);
  if (present.length === 0) return "unavailable";
  if (present.every(value => hasNumericTokenUsage(value))) return "available";
  if (present.some(value => hasNumericTokenUsage(value))) return "partial";
  return "unavailable";
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const thread = isRecord(value.thread) ? value.thread : {};
  const turn = isRecord(value.turn) ? value.turn : {};
  return { ...thread, ...turn, ...value };
}

function completedNotification(value: unknown): {
  threadId?: string | undefined;
  turnId?: string | undefined;
  status?: string | undefined;
} {
  if (!isRecord(value) || !isRecord(value.turn)) return {};
  const source = value.turn;
  return {
    threadId: asString(value.threadId),
    turnId: asString(source.id),
    status: asString(source.status)
  };
}

function adapterError(
  code: typeof ERROR_CODES[keyof typeof ERROR_CODES],
  message: string,
  details: Record<string, unknown> = {}
): SynodError {
  if (Object.hasOwn(details, "childLoss") && !isChildLossMode(details.childLoss)) {
    return unclassifiedChildLossError(details.childLoss);
  }
  return new SynodError(code, message, {
    details: { adapter: "cli-app-server", constructedAppServer: details.constructedAppServer ?? false, ...details }
  });
}

function classifySpawnFailure(error: unknown): unknown {
  if (!(error instanceof SynodError)) return error;
  if (isRecord(error.details) && Object.hasOwn(error.details, "childLoss")) {
    return isChildLossMode(error.details.childLoss)
      ? error
      : unclassifiedChildLossError(error.details.childLoss, error);
  }
  if (error.code === ERROR_CODES.HOST_OWNER_MISSING) {
    return withChildLoss(error, "spawn-invoked-no-owner");
  }
  if (
    error.code === ERROR_CODES.APP_SERVER_EXITED
    || error.code === ERROR_CODES.APP_SERVER_NOT_RUNNING
    || error.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED
    || error.code === ERROR_CODES.APP_SERVER_TIMEOUT
  ) {
    return withChildLoss(error, "spawn-invoked-no-owner");
  }
  return error;
}

function classifyAuthorizeFailure(error: unknown): unknown {
  if (!(error instanceof SynodError)) return error;
  if (isRecord(error.details) && Object.hasOwn(error.details, "childLoss")) {
    return isChildLossMode(error.details.childLoss)
      ? error
      : unclassifiedChildLossError(error.details.childLoss, error);
  }
  if (error.code === ERROR_CODES.APP_SERVER_TIMEOUT) {
    return withChildLoss(error, "wait-never-woke");
  }
  if (
    error.code === ERROR_CODES.APP_SERVER_EXITED
    || error.code === ERROR_CODES.APP_SERVER_NOT_RUNNING
    || error.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED
  ) {
    return withChildLoss(error, "child-dead-lease-live");
  }
  if (error.code === ERROR_CODES.HOST_OWNER_MISSING) {
    return withChildLoss(error, "spawn-invoked-no-owner");
  }
  return error;
}

async function closeClient(client: CliAppServerClient | undefined): Promise<void> {
  if (!client) return;
  await client.close().catch(() => undefined);
}

interface WaitEndpointMetadata {
  version: 1;
  threadId: string;
  directory: string;
  token: string;
  expiresAt: number;
  socketPath: string;
}

interface WaitEndpointRequest {
  version: 1;
  threadId: string;
  token: string;
  method: "thread/read" | "close";
  params?: Record<string, unknown>;
}

type WaitEndpointResponse = {
  ok: true;
  result?: unknown;
} | {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
};

function endpointPaths(directory: string, ownerThread: string): { metadataPath: string; socketPath: string } {
  const identity = createHash("sha256")
    .update(`${process.getuid?.() ?? "unknown"}\0${path.resolve(directory)}\0${ownerThread}`)
    .digest("hex");
  // macOS exposes a long per-user os.tmpdir() path; AF_UNIX paths are capped
  // at roughly 104 bytes, so use the short system temp alias there.
  const root = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "synod-cli-app-server");
  return {
    metadataPath: path.join(root, `${identity.slice(0, 32)}.json`),
    socketPath: path.join(root, `${identity.slice(0, 32)}.sock`)
  };
}

function endpointError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof SynodError) {
    return {
      code: error.code,
      message: error.message,
      ...(isRecord(error.details) ? { details: error.details } : {})
    };
  }
  return { code: ERROR_CODES.APP_SERVER_EXITED, message: error instanceof Error ? error.message : String(error) };
}

async function removeEndpointFiles(session: LiveSession): Promise<void> {
  await Promise.all([
    session.endpointSocketPath ? unlink(session.endpointSocketPath).catch(() => undefined) : Promise.resolve(),
    session.endpointMetadataPath ? unlink(session.endpointMetadataPath).catch(() => undefined) : Promise.resolve()
  ]);
  session.endpointSocketPath = undefined;
  session.endpointMetadataPath = undefined;
  session.endpointToken = undefined;
}

async function releaseSession(session: LiveSession): Promise<void> {
  if (session.endpointTimer !== undefined) {
    clearTimeout(session.endpointTimer);
    session.endpointTimer = undefined;
  }
  if (session.closed) return;
  if (session.retainForObservation && session.client.retain) {
    try {
      await session.client.retain();
      session.closed = true;
      return;
    } catch {
      // If the owner cannot acknowledge retention, fail closed by closing it.
    }
  }
  session.closed = true;
  const socket = session.endpointSocket;
  session.endpointSocket = undefined;
  socket?.destroy();
  const server = session.endpointServer;
  session.endpointServer = undefined;
  if (server) {
    try { server.close(); } catch { /* already closed */ }
  }
  await removeEndpointFiles(session);
  await closeClient(session.client);
}

function sendEndpointResponse(socket: Socket, response: WaitEndpointResponse): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

async function handleEndpointRequest(
  session: LiveSession,
  metadata: WaitEndpointMetadata,
  socket: Socket,
  value: unknown
): Promise<void> {
  if (!isRecord(value)
    || value.version !== 1
    || value.threadId !== session.ownerThread
    || value.token !== metadata.token
    || (value.method !== "thread/read" && value.method !== "close")) {
    sendEndpointResponse(socket, {
      ok: false,
      error: {
        code: ERROR_CODES.HOST_ADAPTER_INVALID,
        message: "CLI App Server wait endpoint rejected a mismatched request.",
        details: { expectedThreadId: session.ownerThread }
      }
    });
    socket.destroy();
    return;
  }
  if (value.method === "close") {
    sendEndpointResponse(socket, { ok: true });
    socket.end();
    return;
  }
  const params = isRecord(value.params) ? value.params : {};
  if (params.threadId !== session.ownerThread) {
    sendEndpointResponse(socket, {
      ok: false,
      error: {
        code: ERROR_CODES.APP_SERVER_UNSUPPORTED,
        message: "CLI App Server wait endpoint requires the exact owning thread UUID.",
        details: { expectedThreadId: session.ownerThread, observedThreadId: params.threadId }
      }
    });
    socket.destroy();
    return;
  }
  try {
    const result = await session.client.request("thread/read", {
      threadId: session.ownerThread,
      includeTurns: false
    });
    sendEndpointResponse(socket, { ok: true, result });
  } catch (error) {
    sendEndpointResponse(socket, { ok: false, error: endpointError(error) });
    socket.end();
    await releaseSession(session);
  }
}

async function startWaitEndpoint(session: LiveSession, keepProcessAlive: boolean): Promise<void> {
  const paths = endpointPaths(session.directory, session.ownerThread);
  await mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(paths.socketPath) || existsSync(paths.metadataPath)) {
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "an exact-thread CLI App Server wait endpoint is already present.",
      { threadId: session.ownerThread, socketPath: paths.socketPath, constructedAppServer: true }
    );
  }
  const metadata: WaitEndpointMetadata = {
    version: 1,
    threadId: session.ownerThread,
    directory: session.directory,
    token: randomUUID(),
    expiresAt: Date.now() + CLI_APP_SERVER_WAIT_SESSION_TTL_MS,
    socketPath: paths.socketPath
  };
  await writeFile(paths.metadataPath, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
  session.endpointSocketPath = paths.socketPath;
  session.endpointMetadataPath = paths.metadataPath;
  session.endpointToken = metadata.token;
  const server = createServer(socket => {
    if (session.closed || session.endpointSocket) {
      socket.destroy();
      return;
    }
    session.endpointSocket = socket;
    let buffered = "";
    let chain = Promise.resolve();
    socket.setEncoding("utf8");
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
            await handleEndpointRequest(session, metadata, socket, JSON.parse(line));
          } catch (error) {
            sendEndpointResponse(socket, { ok: false, error: endpointError(error) });
            socket.destroy();
          }
        });
      }
    });
    socket.on("close", () => {
      if (session.endpointSocket !== socket) return;
      session.endpointSocket = undefined;
      void releaseSession(session);
    });
  });
  session.endpointServer = server;
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
  }).catch(async error => {
    session.endpointServer = undefined;
    await removeEndpointFiles(session);
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "CLI App Server wait endpoint could not be bound.",
      { socketPath: paths.socketPath, cause: endpointError(error), constructedAppServer: true }
    );
  });
  if (!keepProcessAlive) server.unref();
  const timer = setTimeout(() => { void releaseSession(session); }, CLI_APP_SERVER_WAIT_SESSION_TTL_MS);
  timer.unref?.();
  session.endpointTimer = timer;
}

function readEndpointMetadata(directory: string, ownerThread: string): WaitEndpointMetadata | undefined {
  const paths = endpointPaths(directory, ownerThread);
  if (!existsSync(paths.metadataPath)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(paths.metadataPath, "utf8"));
    if (!isRecord(value)
      || value.version !== 1
      || value.threadId !== ownerThread
      || value.directory !== path.resolve(directory)
      || typeof value.token !== "string"
      || !value.token
      || typeof value.expiresAt !== "number"
      || !Number.isFinite(value.expiresAt)
      || value.socketPath !== paths.socketPath) return undefined;
    return value as unknown as WaitEndpointMetadata;
  } catch {
    return undefined;
  }
}

function disconnectedWaitResult(ownerThread: string): unknown {
  // A disconnected endpoint proves only that this observer lost its
  // authority. It does not prove that the exact worker thread terminated.
  return { thread: { id: ownerThread, status: { type: "notLoaded" } } };
}

/**
 * Find the owner endpoint for an exact thread UUID. This is deliberately
 * cross-process: no module-level session registry is used for authority.
 */
export function findCliAppServerWaitClient(directory: string | undefined, threadId: string): CliAppServerClient | undefined {
  const ownerThread = asString(threadId);
  if (!ownerThread) return undefined;
  const resolvedDirectory = path.resolve(directory || ".");
  const paths = endpointPaths(resolvedDirectory, ownerThread);
  if (!existsSync(paths.metadataPath)) return undefined;
  const metadata = readEndpointMetadata(resolvedDirectory, ownerThread);
  let socket: Socket | undefined;
  let connecting: Promise<void> | undefined;
  let pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | undefined;
  let buffered = "";
  let closed = false;
  const expired = Boolean(metadata && metadata.expiresAt <= Date.now());
  let lossCause: WaitLossCause | undefined = !metadata
    ? "authority-lost"
    : expired
      ? "endpoint-expired"
      : undefined;
  let directEvidence = false;
  let observedAuthority = false;
  let connected = false;
  const failPending = (cause?: WaitLossCause) => {
    if (cause && !lossCause) lossCause = cause;
    const current = pending;
    pending = undefined;
    current?.resolve(disconnectedWaitResult(ownerThread));
  };
  const connect = async (allowExpired = false): Promise<void> => {
    if ((!allowExpired && expired) || !metadata || (!allowExpired && metadata.expiresAt <= Date.now())) {
      if (!lossCause) lossCause = "endpoint-expired";
      return;
    }
    if (socket && !socket.destroyed) return;
    if (connecting) return connecting;
    connecting = new Promise<void>((resolve, reject) => {
      const next = createConnection(metadata!.socketPath);
      socket = next;
      next.setEncoding("utf8");
      next.on("data", chunk => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (!line.trim()) continue;
          try {
            const value: unknown = JSON.parse(line);
            const current = pending;
            pending = undefined;
            if (!current) continue;
            if (!isRecord(value) || value.ok !== true && value.ok !== false) {
              if (!lossCause) lossCause = "authority-lost";
              current.reject(new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "CLI App Server wait endpoint returned malformed data."));
            } else if (value.ok === false) {
              const failure = isRecord(value.error) ? value.error : {};
              if (!lossCause) lossCause = failure.code === ERROR_CODES.APP_SERVER_EXITED
                || failure.code === ERROR_CODES.APP_SERVER_NOT_RUNNING
                || failure.code === ERROR_CODES.APP_SERVER_SPAWN_FAILED
                ? "endpoint-owner-exited"
                : "authority-lost";
              current.reject(new SynodError(
                typeof failure.code === "string" ? failure.code as typeof ERROR_CODES[keyof typeof ERROR_CODES] : ERROR_CODES.APP_SERVER_EXITED,
                typeof failure.message === "string" ? failure.message : "CLI App Server wait endpoint failed.",
                { details: isRecord(failure.details) ? failure.details : {} }
              ));
            } else {
              const result = value.result;
              const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
              const status = thread && isRecord(thread.status) ? thread.status.type : undefined;
              observedAuthority = true;
              if (status === "systemError") {
                lossCause = "child-terminated";
                directEvidence = true;
              } else {
                lossCause = undefined;
                directEvidence = false;
              }
              current.resolve(result);
            }
          } catch (error) {
            if (!lossCause) lossCause = "authority-lost";
            pending?.reject(error);
            pending = undefined;
          }
        }
      });
      next.once("connect", () => {
        connected = true;
        connecting = undefined;
        resolve();
      });
      next.once("error", error => {
        connecting = undefined;
        if (!lossCause) lossCause = connected ? "endpoint-owner-exited" : "endpoint-unreachable";
        failPending(lossCause);
        reject(error);
      });
      next.once("close", () => {
        socket = undefined;
        connecting = undefined;
        if (!lossCause) lossCause = connected ? "endpoint-owner-exited" : "endpoint-unreachable";
        failPending(lossCause);
      });
    });
    return connecting;
  };
  return {
    async start() {},
    async request(method, params) {
      if (closed) return disconnectedWaitResult(ownerThread);
      if (method !== "thread/read" && method !== "close") {
        throw new SynodError(ERROR_CODES.HOST_ADAPTER_INVALID, "CLI App Server wait supports only thread/read or close.");
      }
      if (params?.threadId !== ownerThread) {
        throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "CLI App Server wait requires the exact owning thread UUID.", {
          details: { expectedThreadId: ownerThread, observedThreadId: params?.threadId }
        });
      }
      const allowExpired = method === "close";
      if ((!allowExpired && expired) || !metadata || (!allowExpired && metadata.expiresAt <= Date.now())) {
        if (!lossCause) lossCause = "endpoint-expired";
        return disconnectedWaitResult(ownerThread);
      }
      try {
        await connect(allowExpired);
        if (!socket || socket.destroyed) return disconnectedWaitResult(ownerThread);
        return await new Promise<unknown>((resolve, reject) => {
          if (pending) {
            reject(new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "CLI App Server wait endpoint received concurrent requests."));
            return;
          }
          pending = { resolve, reject };
          socket!.write(JSON.stringify({ version: 1, threadId: ownerThread, token: metadata!.token, method, params }) + "\n", error => {
            if (!error) return;
            pending = undefined;
            if (!lossCause) lossCause = connected ? "endpoint-owner-exited" : "endpoint-unreachable";
            resolve(disconnectedWaitResult(ownerThread));
          });
        });
      } catch {
        if (!lossCause) lossCause = connected ? "endpoint-owner-exited" : "endpoint-unreachable";
        return disconnectedWaitResult(ownerThread);
      }
    },
    getDiagnostics: () => ({
      codexSurface: "cli",
      codexExecutable: "codex",
      appServer: {
        capabilities: { initialize: true, threadList: true, modelList: false },
        waitAuthority: "appServer",
        threadId: ownerThread,
        endpoint: paths.socketPath,
        observedAuthority,
        ...(lossCause ? {
          lossCause,
          waitLoss: {
            cause: lossCause,
            authority: "appServer",
            ...(lossCause === "child-terminated" ? { threadId: ownerThread } : {}),
            directEvidence
          }
        } : {})
      }
    } as unknown as AppServerDiagnostics),
    async close() {
      closed = true;
      const current = socket;
      socket = undefined;
      if (current && !current.destroyed) current.end();
    }
  };
}

/**
 * Dispose an exact detached owner from a canonical lease mutation. This path
 * deliberately talks to the owner endpoint directly; it does not require a
 * preceding wait observer or an in-process App Server client.
 */
export async function disposeCliAppServerOwner(
  directory: string | undefined,
  threadId: string,
  timeoutMs = CLI_APP_SERVER_OWNER_DISPOSAL_TIMEOUT_MS
): Promise<{ status: "closed" | "not-found" | "timeout" }> {
  const ownerThread = asString(threadId);
  if (!ownerThread) return { status: "not-found" };
  const resolvedDirectory = path.resolve(directory || ".");
  const paths = endpointPaths(resolvedDirectory, ownerThread);
  const client = findCliAppServerWaitClient(resolvedDirectory, ownerThread);
  if (!client) {
    await Promise.all([
      unlink(paths.metadataPath).catch(() => undefined),
      unlink(paths.socketPath).catch(() => undefined)
    ]);
    return { status: "not-found" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closeRequest = client.request("close", { threadId: ownerThread });
    await Promise.race([
      closeRequest,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SynodError(
          ERROR_CODES.APP_SERVER_TIMEOUT,
          "CLI App Server owner disposal timed out.",
          { details: { threadId: ownerThread, timeoutMs } }
        )), timeoutMs);
      })
    ]);
    return { status: "closed" };
  } catch {
    return { status: "timeout" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.close().catch(() => undefined);
    await Promise.all([
      unlink(paths.metadataPath).catch(() => undefined),
      unlink(paths.socketPath).catch(() => undefined)
    ]);
  }
}

function assertCliSurface(diagnostics: AppServerDiagnostics, constructed: boolean): void {
  if (diagnostics.codexSurface === "desktop") {
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "App Server reported Desktop; closing without creating a thread.",
      { surface: diagnostics.codexSurface, constructedAppServer: constructed }
    );
  }
  if (diagnostics.codexSurface !== "cli") {
    throw adapterError(
      ERROR_CODES.APP_SERVER_UNSUPPORTED,
      "App Server surface was not Codex CLI.",
      { surface: diagnostics.codexSurface ?? null, constructedAppServer: constructed }
    );
  }
  const argv = launchedArgv(diagnostics);
  if (hasMultiAgentV2(argv)) {
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "multi_agent_v2 must stay off for the CLI App Server runner.",
      { launchedArgv: argv, constructedAppServer: constructed }
    );
  }
  if (argv.length > 0 && !hasExplicitMultiAgentV2Disable(argv)) {
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "CLI App Server must launch with an explicit --disable multi_agent_v2 flag.",
      { launchedArgv: argv, constructedAppServer: constructed }
    );
  }
}

function effectiveMetadata(threadStartResponse: unknown, settingsNotifications: unknown[]): {
  sandbox?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  runtimeWorkspaceRoots?: string[] | undefined;
} {
  const start = isRecord(threadStartResponse) ? threadStartResponse : {};
  const startPolicy = policyMetadata(start.sandbox);
  const metadata: {
    sandbox?: string;
    model?: string;
    reasoningEffort?: string;
    runtimeWorkspaceRoots?: string[];
  } = {
    ...(startPolicy.sandbox ? { sandbox: startPolicy.sandbox } : {}),
    ...(asString(start.model) ? { model: asString(start.model)! } : {}),
    ...(asString(start.reasoningEffort) ? { reasoningEffort: asString(start.reasoningEffort)! } : {}),
    ...(startPolicy.runtimeWorkspaceRoots === undefined
      ? {}
      : { runtimeWorkspaceRoots: startPolicy.runtimeWorkspaceRoots })
  };
  for (const notification of settingsNotifications) {
    if (!isRecord(notification) || !isRecord(notification.threadSettings)) {
      throw adapterError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "thread/settings/updated notification did not match the Codex 0.148 schema.",
        { constructedAppServer: true }
      );
    }
    const settings = notification.threadSettings;
    if (!asString(settings.model) || !asString(settings.modelProvider)
      || typeof settings.cwd !== "string"
      || !Object.hasOwn(settings, "approvalPolicy")
      || !Object.hasOwn(settings, "approvalsReviewer")
      || !Object.hasOwn(settings, "collaborationMode")
      || !isRecord(settings.sandboxPolicy)
      || !["readOnly", "workspaceWrite", "externalSandbox", "dangerFullAccess"].includes(String(settings.sandboxPolicy.type))) {
      throw adapterError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "thread/settings/updated notification did not match the Codex 0.148 ThreadSettings schema.",
        { constructedAppServer: true }
      );
    }
    const policy = policyMetadata(settings.sandboxPolicy);
    if (policy.sandbox) metadata.sandbox = policy.sandbox;
    if (policy.runtimeWorkspaceRoots !== undefined) metadata.runtimeWorkspaceRoots = policy.runtimeWorkspaceRoots;
    else if (settings.sandboxPolicy.type === "workspaceWrite") delete metadata.runtimeWorkspaceRoots;
    const model = asString(settings.model);
    const effort = asString(settings.effort);
    if (model) metadata.model = model;
    if (effort) metadata.reasoningEffort = effort;
  }
  return metadata;
}

async function waitForTurnCompleted(
  notifications: unknown[],
  wake: { value: (() => void) | undefined; failure?: SynodError },
  threadId: string,
  turnId: string,
  timeoutMs: number
): Promise<unknown> {
  const match = (): unknown | undefined => {
    for (const notification of notifications) {
      const ids = completedNotification(notification);
      if (ids.threadId === threadId && ids.turnId === turnId) return notification;
    }
    return undefined;
  };
  const malformed = (): boolean => notifications.some(notification => {
    if (!isRecord(notification) || notification.threadId !== threadId) return false;
    if (!isRecord(notification.turn)) return true;
    return notification.turn.id === turnId && (
      typeof notification.turn.status !== "string"
      || !["completed", "interrupted", "failed", "inProgress"].includes(notification.turn.status)
    );
  });
  const deadline = Date.now() + timeoutMs;
  let notification = match();
  while (!notification) {
    if (wake.failure) throw classifyAuthorizeFailure(wake.failure);
    if (malformed()) {
      throw adapterError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "turn/completed notification did not match the Codex 0.148 schema.",
        { threadId, turnId, constructedAppServer: true }
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw adapterError(
        ERROR_CODES.APP_SERVER_TIMEOUT,
        "matching turn/completed notification was not observed before timeout.",
        { threadId, turnId, timeoutMs, constructedAppServer: true, childLoss: "wait-never-woke" }
      );
    }
    await new Promise<void>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (wake.value === notify) wake.value = undefined;
        resolve();
      }, remaining);
      const notify = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (wake.value === notify) wake.value = undefined;
        resolve();
      };
      wake.value = notify;
    });
    if (wake.failure) throw classifyAuthorizeFailure(wake.failure);
    if (malformed()) {
      throw adapterError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "turn/completed notification did not match the Codex 0.148 schema.",
        { threadId, turnId, constructedAppServer: true }
      );
    }
    notification = match();
  }
  const ids = completedNotification(notification);
  if (!ids.threadId || !ids.turnId || !ids.status) {
    throw adapterError(
      ERROR_CODES.APP_SERVER_UNSUPPORTED,
      "turn/completed notification did not match the Codex 0.148 schema.",
      { threadId, turnId, constructedAppServer: true }
    );
  }
  if (ids.status !== "completed") {
    throw adapterError(
      ERROR_CODES.APP_SERVER_UNSUPPORTED,
      "matching turn/completed notification did not report terminal status completed.",
      { threadId, turnId, terminalStatus: ids.status ?? null, constructedAppServer: true }
    );
  }
  return notification;
}

function threadRows(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.data)) return value.data;
  if (Array.isArray(value)) return value;
  return [];
}

function writeScopes(scopes: readonly LeaseScope[] | undefined): LeaseScope[] {
  return (scopes ?? []).filter(scope => scope.access === "write");
}

function validatedScopes(value: unknown): LeaseScope[] {
  if (!Array.isArray(value) || !value.every(scope => isRecord(scope)
    && (scope.access === "read" || scope.access === "write")
    && (scope.kind === "file" || scope.kind === "tree")
    && typeof scope.path === "string" && scope.path.length > 0
    && (() => {
      try {
        return normalizeLeaseScopePath(scope.path) === scope.path;
      } catch {
        return false;
      }
    })())) {
    throw adapterError(
      ERROR_CODES.LEASE_CONFLICT,
      "CLI Path A cannot enforce an unverifiable lease scope.",
      { scopes: value, constructedAppServer: true }
    );
  }
  return value as LeaseScope[];
}

function writerScopeKey(directory: string, scopePath: string): string {
  return `${path.resolve(directory)}::${path.resolve(directory, scopePath)}`;
}

function acquireWriterScope(key: string): void {
  if (activeWriterScopes.has(key)) {
    throw adapterError(
      ERROR_CODES.LEASE_CONFLICT,
      "a second writer is already active in the same scope.",
      { scopeKey: key, constructedAppServer: true }
    );
  }
  activeWriterScopes.add(key);
}

function releaseWriterScope(key: string | undefined): void {
  if (key) activeWriterScopes.delete(key);
}

function sameRoots(observed: string[] | undefined, expected: string[]): boolean {
  if (!observed || observed.length !== expected.length) return false;
  const wanted = expected.map(item => path.resolve(item));
  const got = observed.map(item => path.resolve(item));
  return wanted.every((item, index) => item === got[index]);
}

interface TurnFence {
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  sandboxPolicy: { type: "readOnly" } | { type: "workspaceWrite"; writableRoots: string[] };
  runtimeWorkspaceRoots: string[];
  prompt: string;
  writerKey?: string;
}

function taskPrompt(
  contract: HostDelegationSpawnRequest["readOnlyContract"],
  execution: string
): string {
  const acceptance = contract.acceptance.length > 0
    ? contract.acceptance.map(item => `- ${item}`).join("\n")
    : "- (none recorded)";
  const verification = contract.verification.length > 0
    ? contract.verification.map(item => `- ${item}`).join("\n")
    : "- (none recorded)";
  const scopes = contract.scopes.length > 0
    ? contract.scopes.map(scope => `- ${scope.access} ${scope.kind}: ${scope.path}`).join("\n")
    : "- (none recorded)";
  return [
    `Task ID: ${contract.taskId}`,
    `Task revision: ${contract.taskRevision}`,
    ...(contract.role ? [`Delegation role: ${contract.role}`] : []),
    `Objective: ${contract.objective}`,
    "Acceptance criteria:",
    acceptance,
    "Verification commands:",
    verification,
    "Authorized repository scopes:",
    scopes,
    ...(contract.proposalBundleId ? [
      `Sealed proposal bundle: ${contract.proposalBundleId}`,
      `Sealed proposal revision: ${contract.proposalRevision ?? contract.taskRevision}`,
      `Proposal-owned paths: ${(contract.ownedPaths || []).join(", ") || "(none)"}`
    ] : []),
    execution,
    `Worker-only proposal guidance: ${contract.proposalGuidance}`
  ].join("\n");
}

function turnFenceFor(
  request: HostDelegationAuthorizeRequest,
  directory: string,
  contract: HostDelegationSpawnRequest["readOnlyContract"]
): TurnFence {
  const directoryRoot = path.resolve(directory);
  const scopes = validatedScopes(request.lease?.scopes ?? request.reservation.scopes ?? []);
  // Activation runs after bind. Carry the bound lease scopes into the worker
  // prompt so a stale spawn contract cannot widen the fence.
  const boundContract = { ...contract, scopes };
  const writes = writeScopes(scopes);
  if (writes.length > 1) {
    throw adapterError(
      ERROR_CODES.LEASE_CONFLICT,
      "CLI Path A allows exactly one writer scope.",
      { writeScopeCount: writes.length, constructedAppServer: true }
    );
  }
  const write = writes[0];
  if (write) {
    if (request.writeAuthorized !== true) {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "workspace-write requires bind authorization.",
        { constructedAppServer: true }
      );
    }
    if (write.kind !== "tree" || typeof write.path !== "string" || write.path.length === 0) {
      throw adapterError(
        ERROR_CODES.LEASE_CONFLICT,
        "CLI Path A writer fencing requires exactly one verifiable tree scope.",
        { scope: write, constructedAppServer: true }
      );
    }
    try {
      if (normalizeLeaseScopePath(write.path) !== write.path) throw new Error("scope is not normalized");
    } catch {
      throw adapterError(
        ERROR_CODES.LEASE_CONFLICT,
        "CLI Path A writer scope is not a verifiable repository-relative path.",
        { scopePath: write.path, constructedAppServer: true }
      );
    }
    const scopePath = write.path;
    const root = path.resolve(directory, scopePath);
    if (root === directoryRoot || !root.startsWith(`${directoryRoot}${path.sep}`)) {
      throw adapterError(
        ERROR_CODES.LEASE_CONFLICT,
        "CLI Path A writer scope must resolve to one repository-relative tree below cwd.",
        { scopePath, cwd: directoryRoot, constructedAppServer: true }
      );
    }
    return {
      cwd: root,
      sandbox: "workspace-write",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root] },
      runtimeWorkspaceRoots: [root],
      prompt: taskPrompt(boundContract, `Complete this single fenced writer turn. Write only within ${scopePath}. Do not expand the sandbox or open a second writer.`),
      writerKey: writerScopeKey(directory, scopePath)
    };
  }
  return {
    cwd: directoryRoot,
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly" },
    runtimeWorkspaceRoots: [],
    prompt: taskPrompt(boundContract, "Complete this single read-only turn. Do not write files, request a writer role, or change the sandbox.")
  };
}

function rowStatus(rows: unknown[], threadId: string): CliAppServerRuntimeStatus {
  for (const row of rows) {
    if (threadIdentity(row) !== threadId) continue;
    const record = recordFrom(row);
    return normalizeRuntimeStatus(record.status);
  }
  return "unknown";
}

/**
 * CLI Path A adapter: Synod owns one App Server, creates one thread without a
 * turn, authorizes, then binds that UUID only after authorize succeeds. A
 * workspace-write turn still requires an authoritative pre-turn writable
 * boundary; without one, authorize fails closed and must not leave ACTIVE.
 * Desktop must not construct.
 */
export function createCliAppServerAdapter(
  options: CliAppServerAdapterOptions
): HostDelegationAdapter {
  const detachedOwner = options.clientFactory === undefined;
  const createClient = options.clientFactory ?? (() => createCliAppServerRunnerClient({
    codexBin: options.runtime.executable || process.env.SYNOD_CODEX_BIN || "codex",
    directory: path.resolve(options.directory || "."),
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs })
  }));
  const turnCompletionTimeoutMs = options.turnCompletionTimeoutMs ?? DEFAULT_CLI_APP_SERVER_TURN_TIMEOUT_MS;
  if (!Number.isFinite(turnCompletionTimeoutMs) || turnCompletionTimeoutMs <= 0) {
    throw adapterError(
      ERROR_CODES.HOST_ADAPTER_INVALID,
      "turn completion timeout must be a positive finite number of milliseconds.",
      { timeoutMs: turnCompletionTimeoutMs }
    );
  }

  let live: LiveSession | undefined;

  const release = async (): Promise<void> => {
    const session = live;
    live = undefined;
    if (session) await releaseSession(session);
  };

  const spawn = async (request: HostDelegationSpawnRequest): Promise<HostDelegationSpawnResult> => {
    if (options.runtime.surface === "desktop") {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "Desktop must not construct a Synod-owned App Server.",
        { surface: "desktop", constructedAppServer: false }
      );
    }
    if (options.runtime.surface !== "cli") {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "The Synod-owned App Server adapter accepts only the Codex CLI surface.",
        { surface: options.runtime.surface, constructedAppServer: false }
      );
    }
    if (request.reservation.executor !== CLI_APP_SERVER_EXECUTOR) {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "The CLI App Server adapter is bounded to the synod_implementer executor profile.",
        {
          expectedExecutor: CLI_APP_SERVER_EXECUTOR,
          observedExecutor: request.reservation.executor,
          constructedAppServer: false
        }
      );
    }

    const roleCandidates: unknown[] = [options.role, request.role, request.readOnlyContract.role, request.reservation.role]
      .filter(candidate => candidate !== undefined);
    const role = roleCandidates[0] ?? "implementer";
    if (!isDelegationRole(role)) {
      throw adapterError(ERROR_CODES.DELEGATION_ROLE_INVALID, "The CLI App Server adapter received an unsupported delegation role.", {
        role,
        constructedAppServer: false
      });
    }
    if (roleCandidates.some(candidate => candidate !== role)) {
      throw adapterError(ERROR_CODES.DELEGATION_INVALID, "CLI delegation role metadata did not agree across the reservation and role contract.", {
        roles: roleCandidates,
        constructedAppServer: false
      });
    }
    if (role !== "implementer" && (request.reservation.observer !== true
      || request.reservation.scopes.some(scope => scope.access === "write")
      || request.writeAuthorized !== false)) {
      throw adapterError(ERROR_CODES.DELEGATION_INVALID, `${role} CLI delegation requires an observer-only reservation.`, {
        role,
        constructedAppServer: false
      });
    }
    if (request.readOnlyContract.taskId !== request.taskId
      || request.readOnlyContract.taskRevision !== request.reservation.taskRevision) {
      throw adapterError(ERROR_CODES.DELEGATION_INVALID, "CLI delegation contract identity did not match the reservation fence.", {
        taskId: request.taskId,
        contractTaskId: request.readOnlyContract.taskId,
        contractRevision: request.readOnlyContract.taskRevision,
        reservationRevision: request.reservation.taskRevision,
        constructedAppServer: false
      });
    }
    if (role !== "implementer") {
      let proposalPaths: string[] = [];
      let contractPaths: string[] = [];
      try {
        proposalPaths = request.reservation.scopes
          .filter(scope => scope.access === "read" && scope.kind === "file")
          .map(scope => normalizeLeaseScopePath(scope.path))
          .sort();
        contractPaths = (request.readOnlyContract.ownedPaths || [])
          .map(scopePath => normalizeLeaseScopePath(scopePath))
          .sort();
      } catch {
        throw adapterError(ERROR_CODES.DELEGATION_INVALID, `${role} CLI delegation contains an unsafe proposal path contract.`, {
          role,
          constructedAppServer: false
        });
      }
      if (typeof request.readOnlyContract.proposalBundleId !== "string"
        || request.readOnlyContract.proposalBundleId.trim().length === 0
        || request.readOnlyContract.proposalRevision !== request.reservation.taskRevision
        || proposalPaths.length !== contractPaths.length
        || proposalPaths.some((item, index) => item !== contractPaths[index])) {
        throw adapterError(ERROR_CODES.DELEGATION_INVALID, `${role} CLI delegation requires the exact sealed proposal identity and owned paths.`, {
          role,
          proposalBundleId: request.readOnlyContract.proposalBundleId ?? null,
          proposalRevision: request.readOnlyContract.proposalRevision ?? null,
          reservationRevision: request.reservation.taskRevision,
          proposalPaths,
          contractPaths,
          constructedAppServer: false
        });
      }
    }
    // Resolve once before starting the App Server. The same exact profile
    // result is carried by the live session into both protocol requests and
    // effective-settings verification below.
    let implementer: DelegationProfile;
    try {
      implementer = resolveDelegationProfile(options.profile, role);
    } catch (error) {
      if (error instanceof SynodError) {
        error.details = {
          ...(isRecord(error.details) ? error.details : {}),
          constructedAppServer: false
        };
      }
      throw error;
    }

    await release();
    const client = createClient();
    try {
      await client.start();
      assertCliSurface(client.getDiagnostics(), true);

      const response = await client.request("thread/start", {
        cwd: path.resolve(request.directory || options.directory || "."),
        approvalPolicy: "never",
        model: implementer.model,
        sandbox: "read-only"
      });
      if (!isRecord(response) || response.turn !== undefined || response.turnId !== undefined) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "thread/start response did not match the Codex 0.148 ThreadStartResponse schema.",
          { constructedAppServer: true }
        );
      }
      const ownerThread = threadStartIdentity(response);
      if (!ownerThread) {
        throw adapterError(
          ERROR_CODES.HOST_OWNER_MISSING,
          "thread/start did not return a thread identity.",
          { constructedAppServer: true, childLoss: "spawn-invoked-no-owner" }
        );
      }
      live = {
        client,
        ownerThread,
        implementer,
        directory: path.resolve(request.directory || options.directory || "."),
        threadStartResponse: response,
        contract: request.readOnlyContract,
        authorized: false,
        closed: false
      };
      return { ownerId: ownerThread, threadId: ownerThread };
    } catch (error) {
      await closeClient(client);
      live = undefined;
      throw classifySpawnFailure(error);
    }
  };

  const authorize = async (
    request: HostDelegationAuthorizeRequest
  ): Promise<HostAuthorizationReceipt> => {
    const session = live;
    if (!session || session.authorized || session.closed) {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "authorize requires one unconsumed live Synod-owned App Server session from spawn."
      );
    }
    if (request.ownerThread !== session.ownerThread) {
      throw adapterError(
        ERROR_CODES.HOST_OWNER_MISSING,
        "authorize owner thread did not match the spawned App Server thread.",
        {
          expected: session.ownerThread,
          observed: request.ownerThread,
          constructedAppServer: true,
          childLoss: "spawn-invoked-no-owner"
        }
      );
    }
    if (request.phase === "preflight") {
      if (request.writeAuthorized !== false || request.lease !== undefined || request.leaseFence !== undefined) {
        throw adapterError(
          ERROR_CODES.HOST_ADAPTER_INVALID,
          "preflight must remain non-executing and cannot carry active lease authority.",
          { constructedAppServer: true }
        );
      }
      if (writeScopes(request.reservation.scopes).length > 0) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "CLI Path A cannot authorize workspace-write without an authoritative effective boundary before turn/start.",
          {
            phase: "before-turn/start",
            authority: "effective-writable-boundary",
            observed: false,
            constructedAppServer: true
          }
        );
      }
      return { status: "accepted", phase: "preflight" };
    }
    if (request.phase !== "activate" || !request.lease || !request.leaseFence) {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "activation requires the exact bound lease and lease fence.",
        { constructedAppServer: true }
      );
    }
    const completedNotifications: unknown[] = [];
    const settingsNotifications: unknown[] = [];
    const tokenUsageByThread = new Map<string, unknown>();
    const wake: { value: (() => void) | undefined; failure?: SynodError } = { value: undefined };
    const cwd = path.resolve(request.directory || options.directory || ".");
    let unsubscribe = (): void => {};
    let heldWriterKey: string | undefined;
    let retainForWait = false;

    try {
      const fence = turnFenceFor(request, cwd, session.contract);
      if (fence.writerKey !== undefined) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "CLI Path A cannot authorize workspace-write without an authoritative effective boundary before turn/start.",
          {
            phase: "before-turn/start",
            authority: "effective-writable-boundary",
            observed: false,
            constructedAppServer: true
          }
        );
      }
      if (!session.client.subscribeEvents) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "App Server notifications are required to observe turn completion.",
          { constructedAppServer: true }
        );
      }
      const subscribeEvents = session.client.subscribeEvents.bind(session.client);
      unsubscribe = subscribeEvents(event => {
        if (event.type === "failure") {
          wake.failure = event.error;
          wake.value?.();
          return;
        }
        if (event.method === "turn/completed") {
          const params = isRecord(event.params) ? event.params : undefined;
          if (params?.threadId === session.ownerThread) {
            completedNotifications.push(event.params);
            wake.value?.();
          }
        }
        if (event.method === "thread/settings/updated") {
          const params = isRecord(event.params) ? event.params : undefined;
          if (params?.threadId === session.ownerThread) {
            settingsNotifications.push(event.params);
          }
        }
        if (event.method === "thread/tokenUsage/updated") {
          const params = isRecord(event.params) ? event.params : undefined;
          const threadId = asString(params?.threadId);
          const turnId = asString(params?.turnId);
          if (threadId === session.ownerThread && turnId && params && params.tokenUsage !== undefined) {
            tokenUsageByThread.set(`${threadId}:${turnId}`, params.tokenUsage);
          }
        }
      });
      const turnStartRequest: Record<string, unknown> = {
        threadId: session.ownerThread,
        cwd: fence.cwd,
        model: session.implementer.model,
        effort: session.implementer.effort,
        input: [{
          type: "text",
          text: fence.prompt
        }],
        approvalPolicy: "never",
        sandboxPolicy: fence.sandboxPolicy
      };
      const turnResponse = await session.client.request("turn/start", turnStartRequest);
      if (!isRecord(turnResponse) || !isRecord(turnResponse.turn)
        || Object.keys(turnResponse).some(key => key !== "turn")) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "turn/start response did not match the Codex 0.148 TurnStartResponse schema.",
          { constructedAppServer: true }
        );
      }
      const turnId = turnStartIdentity(turnResponse);
      if (!turnId) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "turn/start did not return a turn identity.",
          { constructedAppServer: true }
        );
      }
      const completion = await waitForTurnCompleted(
        completedNotifications,
        wake,
        session.ownerThread,
        turnId,
        turnCompletionTimeoutMs
      );
      const metadata = effectiveMetadata(session.threadStartResponse, settingsNotifications);
      if (metadata.sandbox !== fence.sandbox) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "effective sandbox did not match the post-bind fence.",
          {
            expectedSandbox: fence.sandbox,
            observedSandbox: metadata.sandbox ?? null,
            constructedAppServer: true
          }
        );
      }
      if (metadata.model !== session.implementer.model) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          `effective model did not match the synod ${session.implementer.role} profile.`,
          { expectedModel: session.implementer.model, role: session.implementer.role, observedModel: metadata.model ?? null, constructedAppServer: true }
        );
      }
      if (metadata.reasoningEffort !== session.implementer.effort) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          `effective reasoning effort did not match the synod ${session.implementer.role} profile.`,
          { expectedReasoningEffort: session.implementer.effort, role: session.implementer.role, observedReasoningEffort: metadata.reasoningEffort ?? null, constructedAppServer: true }
        );
      }
      const fencedRoot = fence.runtimeWorkspaceRoots.length === 1
        ? fence.runtimeWorkspaceRoots[0]
        : undefined;
      const requestedTurnCwd = typeof turnStartRequest.cwd === "string" && turnStartRequest.cwd.length > 0
        ? turnStartRequest.cwd
        : undefined;
      if (fence.sandbox === "workspace-write"
        && fencedRoot !== undefined
        && requestedTurnCwd !== fencedRoot) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "post-bind turn/start cwd did not match the exact fenced writer root.",
          {
            expectedCwd: fencedRoot,
            observedCwd: requestedTurnCwd ?? null,
            constructedAppServer: true
          }
        );
      }
      if (!sameRoots(metadata.runtimeWorkspaceRoots, fence.runtimeWorkspaceRoots)) {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "effective runtime workspace roots did not match the post-bind fence.",
          {
            expectedRoots: fence.runtimeWorkspaceRoots,
            observedRoots: metadata.runtimeWorkspaceRoots ?? null,
            constructedAppServer: true
          }
        );
      }

      const attribution = classifyTokenAttribution([
        tokenUsageByThread.get(`${session.ownerThread}:${turnId}`)
      ]);

      let restartStatus: CliAppServerRuntimeStatus = "unknown";
      if (detachedOwner) {
        // The detached owner is already the authoritative App Server. Starting
        // a second owner here would lose the exact thread identity and create
        // an unbounded orphan. Query the retained owner directly instead.
        const listed = await session.client.request("thread/list", {
          archived: false,
          limit: 100,
          cwd
        });
        restartStatus = rowStatus(threadRows(listed), session.ownerThread);
        if (restartStatus === "unknown") {
          const unscoped = await session.client.request("thread/list", { archived: false, limit: 100 });
          restartStatus = rowStatus(threadRows(unscoped), session.ownerThread);
        }
      } else {
        const restarted = createClient();
        try {
          await restarted.start();
          assertCliSurface(restarted.getDiagnostics(), true);
          const listed = await restarted.request("thread/list", {
            archived: false,
            limit: 100,
            cwd
          });
          restartStatus = rowStatus(threadRows(listed), session.ownerThread);
          if (restartStatus === "unknown") {
            const unscoped = await restarted.request("thread/list", { archived: false, limit: 100 });
            restartStatus = rowStatus(threadRows(unscoped), session.ownerThread);
          }
        } finally {
          await closeClient(restarted);
        }
      }
      if (restartStatus === "unknown") {
        throw adapterError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "thread/list did not return the spawned thread identity.",
          { threadId: session.ownerThread, constructedAppServer: true }
        );
      }

      const evidence: CliAppServerTurnEvidence = {
        threadId: session.ownerThread,
        turnId,
        role: session.implementer.role,
        turnStatus: "completed",
        waitAuthority: "appServer",
        completion: "incomplete",
        proposalRequired: session.implementer.role === "implementer",
        sandbox: fence.sandbox,
        model: metadata.model,
        reasoningEffort: metadata.reasoningEffort,
        runtimeWorkspaceRoots: [...(metadata.runtimeWorkspaceRoots ?? [])],
        tokenAttribution: attribution,
        restartLineage: {
          appServerRestarted: !detachedOwner,
          queryMethod: "thread/list",
          usedThreadResume: false,
          completion: "not-claimed",
          status: restartStatus
        }
      };
      if (!detachedOwner) await startWaitEndpoint(session, false);
      session.client.detach?.();
      session.authorized = true;
      retainForWait = true;
      const nextCommand = session.implementer.role === "implementer"
        ? {
            operation: "proposal.submit",
            argv: ["proposal", "submit", request.taskId, "--evidence", `app-server:${session.ownerThread}:${turnId}`],
            requirements: ["exact-sealed-proposal"]
          }
        : {
            operation: "task.approval",
            argv: [
              "task", "approve", request.taskId,
              "--role", session.implementer.role,
              "--revision", String(session.contract.proposalRevision ?? request.reservation.taskRevision),
              "--proposal-bundle-id", session.contract.proposalBundleId || "<sealed-proposal-bundle>",
              "--owner-thread", session.ownerThread,
              "--evidence", `app-server:${session.ownerThread}:${turnId}`
            ],
            requirements: ["decision", "evidence", "exact-sealed-proposal"]
          };
      return {
        status: "authorized",
        ...evidence,
        ...(session.implementer.role === "implementer" ? {} : { approvalRequired: true }),
        nextCommand
      };
    } catch (error) {
      throw classifyAuthorizeFailure(error);
    } finally {
      unsubscribe();
      releaseWriterScope(heldWriterKey);
      if (!retainForWait && !session.retainForObservation) await release();
    }
  };

  return {
    spawn,
    authorize,
    async wait() {
      throw adapterError(
        ERROR_CODES.HOST_ADAPTER_INVALID,
        "CLI App Server Path A does not treat App Server events as wait --task."
      );
    },
    async close() {
      await release();
    }
  };
}
