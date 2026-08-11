import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import process from "node:process";
import readline from "node:readline";
import { WARNING_CODES, warning } from "./contracts.js";
import type { Warning } from "./contracts.js";
import { compareVersions, parseVersion } from "./compatibility.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { packageVersion } from "./package.js";
import type { ModelCapability } from "./profiles.js";
import { errorMessage, isRecord, parseJson } from "./validation.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000;

export type CodexSurface = "cli" | "desktop" | "unknown";

export interface AppServerChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal: NodeJS.Signals): boolean;
  unref?(): void;
}

export type SpawnAppServer = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] }
) => AppServerChild;

export interface AppServerCleanup {
  signal?: NodeJS.Signals;
  forced: boolean;
  exitConfirmed: boolean;
  signalErrors?: Array<{ signal: NodeJS.Signals; message: string }>;
  detached?: boolean;
  detachErrors?: Array<{ stream: string; message: string }>;
  code?: number | undefined;
  exitSignal?: NodeJS.Signals | undefined;
}

export interface AppServerDiagnostics extends Record<string, unknown> {
  codexExecutable: string;
  codexHome?: string | null | undefined;
  codexSurface?: CodexSurface | undefined;
  codexVersion?: string | null | undefined;
  codexUserAgent?: string | undefined;
  appServer: {
    platformFamily?: unknown;
    platformOs?: unknown;
    capabilities: {
      initialize: boolean;
      threadList: boolean;
      modelList: boolean;
    };
    cleanup?: AppServerCleanup | undefined;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  method: string;
}

export type AppServerEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "failure"; error: SynodError };

interface InitializeResponse extends Record<string, unknown> {
  userAgent: string;
  codexHome?: string;
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  return isRecord(value)
    && typeof value.userAgent === "string"
    && (value.codexHome === undefined || typeof value.codexHome === "string");
}

function isModelCapability(value: unknown): value is ModelCapability {
  if (!isRecord(value)) return false;
  if (value.id !== undefined && typeof value.id !== "string") return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (value.id === undefined && value.model === undefined) return false;
  return value.supportedReasoningEfforts === undefined || (
    Array.isArray(value.supportedReasoningEfforts)
    && value.supportedReasoningEfforts.every(item =>
      typeof item === "string" || (isRecord(item) && typeof item.reasoningEffort === "string")
    )
  );
}

function isModelPage(value: unknown): value is { data: ModelCapability[]; nextCursor: string | null } {
  return isRecord(value)
    && Array.isArray(value.data)
    && value.data.every(isModelCapability)
    && (value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length > 0));
}

export function codexVersionFrom(userAgent: unknown): string | undefined {
  if (typeof userAgent !== "string") return undefined;
  const codexVersion = userAgent.match(/codex[^/ ]*[ /]v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
  return codexVersion?.[1] || userAgent.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1];
}

export function codexSurfaceFrom(userAgent: unknown): CodexSurface {
  if (typeof userAgent !== "string") return "unknown";
  const product = userAgent.split("/", 1)[0]?.trim().toLowerCase() || "";
  if (product.includes("desktop")) return "desktop";
  if (/^(?:codex(?:[-_ ]?cli(?:_rs)?)?|synod_cli)$/.test(product)) return "cli";
  return "unknown";
}

function boundedLine(line: unknown): string {
  const value = String(line).replaceAll(/[\r\n]/g, " ");
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

export class CodexAppServerClient {
  private readonly codexBin: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;
  private readonly spawnProcess: SpawnAppServer;
  private nextId: number;
  private readonly pending: Map<number, PendingRequest>;
  private stderr: string;
  private readonly warnings: Warning[];
  private readonly diagnostics: AppServerDiagnostics;
  private child: AppServerChild | undefined;
  private lines?: readline.Interface;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private fatalError: SynodError | undefined;
  private readonly eventListeners: Set<(event: AppServerEvent) => void>;

  constructor({
    codexBin = process.env.SYNOD_CODEX_BIN || "codex",
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
    spawnProcess = (command, args, options) => spawn(command, args, options)
  }: {
    codexBin?: string;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    forceKillTimeoutMs?: number;
    spawnProcess?: SpawnAppServer;
  } = {}) {
    this.codexBin = codexBin;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.forceKillTimeoutMs = forceKillTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.warnings = [];
    this.eventListeners = new Set();
    this.diagnostics = {
      codexExecutable: this.codexBin,
      codexHome: undefined,
      codexSurface: undefined,
      codexVersion: undefined,
      codexUserAgent: undefined,
      appServer: {
        platformFamily: undefined,
        platformOs: undefined,
        capabilities: {
          initialize: false,
          threadList: false,
          modelList: false
        },
        cleanup: undefined
      }
    };
  }

  async start() {
    if (this.child) return;

    try {
      this.child = this.spawnProcess(this.codexBin, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_SPAWN_FAILED,
        `Could not spawn Codex App Server: ${errorMessage(error)}`,
        { cause: error, details: { codexBin: this.codexBin } }
      );
    }

    const child = this.child;
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      this.child = undefined;
      throw new SynodError(
        ERROR_CODES.APP_SERVER_SPAWN_FAILED,
        "Codex App Server did not expose the required stdio streams.",
        { details: { codexBin: this.codexBin } }
      );
    }

    this.exitInfo = undefined;
    this.fatalError = undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    child.stdin.on("error", (error: Error) => {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_PROTOCOL_ERROR,
        `Codex App Server stdin failed: ${error.message}`,
        { cause: error }
      ));
    });

    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line: string) => this.handleLine(line));
    child.on("error", (error: Error) => {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_SPAWN_FAILED,
        `Codex App Server failed to start: ${error.message}`,
        { cause: error, details: { codexBin: this.codexBin } }
      ));
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitInfo = { code, signal };
      const detail = this.stderr.trim();
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_EXITED,
        `Codex App Server exited with ${signal ? `signal ${signal}` : `code ${code}`}.${detail ? ` ${detail}` : ""}`,
        { details: { code, signal } }
      ));
    });

    const initialized = await this.request("initialize", {
      clientInfo: {
        name: "synod_cli",
        title: "Synod CLI",
        version: packageVersion
      },
      capabilities: { experimentalApi: true }
    });
    if (!isInitializeResponse(initialized)) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server returned an invalid initialize response."
      );
    }

    this.diagnostics.codexHome = typeof initialized.codexHome === "string" ? initialized.codexHome : null;
    this.diagnostics.codexSurface = codexSurfaceFrom(initialized.userAgent);
    this.diagnostics.codexUserAgent = initialized.userAgent;
    this.diagnostics.codexVersion = codexVersionFrom(initialized.userAgent) || null;
    this.diagnostics.appServer.platformFamily = initialized.platformFamily;
    this.diagnostics.appServer.platformOs = initialized.platformOs;
    this.diagnostics.appServer.capabilities.initialize = true;
    this.notify("initialized", {});
  }

  async probeCapabilities(): Promise<AppServerDiagnostics["appServer"]["capabilities"]> {
    const response = await this.request("thread/list", { archived: false, limit: 1 });
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server does not expose the required thread/list response contract.",
        { details: { capability: "thread/list" } }
      );
    }
    this.diagnostics.appServer.capabilities.threadList = true;
    return this.diagnostics.appServer.capabilities;
  }

  async listModels(): Promise<ModelCapability[]> {
    const models: ModelCapability[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const response = await this.request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      if (!isModelPage(response)) {
        throw new SynodError(
          ERROR_CODES.APP_SERVER_UNSUPPORTED,
          "Codex App Server does not expose the required model/list response contract.",
          { details: { capability: "model/list", reason: "malformed_page" } }
        );
      }
      models.push(...response.data);
      cursor = response.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new SynodError(
            ERROR_CODES.APP_SERVER_UNSUPPORTED,
            "Codex App Server repeated a model/list cursor.",
            { details: { capability: "model/list", reason: "repeated_cursor", cursor } }
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    this.diagnostics.appServer.capabilities.modelList = true;
    return models;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.child?.stdin?.writable || this.exitInfo) {
      return Promise.reject(new SynodError(
        ERROR_CODES.APP_SERVER_NOT_RUNNING,
        "Codex App Server is not running.",
        { details: { method } }
      ));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new SynodError(
          ERROR_CODES.APP_SERVER_TIMEOUT,
          `Codex App Server timed out while calling ${method}.`,
          { details: { method, timeoutMs: this.requestTimeoutMs } }
        ));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(asSynodError(error, ERROR_CODES.APP_SERVER_PROTOCOL_ERROR));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    if (!this.child?.stdin?.writable || this.exitInfo) {
      throw new SynodError(ERROR_CODES.APP_SERVER_NOT_RUNNING, "Codex App Server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string): void {
    let message: unknown;
    try {
      message = parseJson(line);
    } catch (error) {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT,
        "Codex App Server emitted malformed JSON output.",
        { cause: error, details: { output: boundedLine(line) } }
      ));
      return;
    }

    if (!isRecord(message)) return;
    if (typeof message.id !== "number") {
      if (typeof message.method === "string") {
        this.emitEvent({ type: "notification", method: message.method, params: message.params });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(new SynodError(
        ERROR_CODES.APP_SERVER_PROTOCOL_ERROR,
        typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error),
        { details: { method: pending.method, rpcCode: message.error.code } }
      ));
    } else if (!Object.hasOwn(message, "result")) {
      pending.reject(new SynodError(
        ERROR_CODES.APP_SERVER_PROTOCOL_ERROR,
        `Codex App Server returned a response without result or error for ${pending.method}.`,
        { details: { method: pending.method } }
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  fail(error: unknown): void {
    this.fatalError = asSynodError(error);
    this.rejectAll(this.fatalError);
    this.emitEvent({ type: "failure", error: this.fatalError });
  }

  emitEvent(event: AppServerEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch {}
    }
  }

  subscribeEvents(listener: (event: AppServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    if (this.fatalError) queueMicrotask(() => {
      if (this.eventListeners.has(listener)) listener({ type: "failure", error: this.fatalError! });
    });
    return () => this.eventListeners.delete(listener);
  }

  supportsThreadStatusNotifications(): boolean {
    const version = this.diagnostics.codexVersion;
    const parsed = parseVersion(version);
    return Boolean(parsed && compareVersions({ ...parsed, prerelease: undefined }, "0.147.0") >= 0);
  }

  waitForExit(child: AppServerChild, timeoutMs: number): Promise<boolean> {
    if (this.exitInfo || child.exitCode != null || child.signalCode != null) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
      let timeout: NodeJS.Timeout;
      const exited = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", exited);
      timeout = setTimeout(() => {
        child.removeListener("exit", exited);
        resolve(false);
      }, timeoutMs);
    });
  }

  async close(): Promise<AppServerCleanup | undefined> {
    const child = this.child;
    if (!child) return this.diagnostics.appServer.cleanup;

    this.rejectAll(new SynodError(
      ERROR_CODES.APP_SERVER_NOT_RUNNING,
      "Codex App Server connection closed."
    ));
    this.lines?.close();

    const signalErrors: Array<{ signal: NodeJS.Signals; message: string }> = [];
    const cleanup: AppServerCleanup = {
      forced: false,
      exitConfirmed: Boolean(this.exitInfo || child.exitCode != null || child.signalCode != null)
    };
    const sendSignal = (signal: NodeJS.Signals): boolean => {
      try {
        return child.kill(signal);
      } catch (error) {
        signalErrors.push({ signal, message: errorMessage(error) });
        return false;
      }
    };

    if (!cleanup.exitConfirmed) {
      cleanup.signal = "SIGTERM";
      sendSignal("SIGTERM");
      cleanup.exitConfirmed = await this.waitForExit(child, this.shutdownTimeoutMs);
    }

    if (!cleanup.exitConfirmed) {
      cleanup.signal = "SIGKILL";
      cleanup.forced = true;
      this.warnings.push(warning(
        WARNING_CODES.APP_SERVER_FORCE_KILLED,
        "Codex App Server did not exit after SIGTERM and required SIGKILL.",
        { shutdownTimeoutMs: this.shutdownTimeoutMs }
      ));
      sendSignal("SIGKILL");
      cleanup.exitConfirmed = await this.waitForExit(child, this.forceKillTimeoutMs);
    }

    if (!cleanup.exitConfirmed) {
      this.warnings.push(warning(
        WARNING_CODES.APP_SERVER_EXIT_UNCONFIRMED,
        "Codex App Server exit could not be confirmed after SIGKILL.",
        { forceKillTimeoutMs: this.forceKillTimeoutMs }
      ));
      cleanup.detached = true;
      const detachErrors: Array<{ stream: string; message: string }> = [];
      const streams: Array<[string, Readable | Writable]> = [
        ["stdin", child.stdin],
        ["stdout", child.stdout],
        ["stderr", child.stderr]
      ];
      for (const [name, stream] of streams) {
        try {
          stream?.destroy?.();
        } catch (error) {
          detachErrors.push({ stream: name, message: errorMessage(error) });
        }
      }
      try {
        child.unref?.();
      } catch (error) {
        detachErrors.push({ stream: "process", message: errorMessage(error) });
      }
      if (detachErrors.length > 0) cleanup.detachErrors = detachErrors;
    }

    cleanup.code = this.exitInfo?.code ?? child.exitCode ?? undefined;
    cleanup.exitSignal = this.exitInfo?.signal ?? child.signalCode ?? undefined;
    if (signalErrors.length > 0) cleanup.signalErrors = signalErrors;
    this.diagnostics.appServer.cleanup = cleanup;
    this.child = undefined;
    return cleanup;
  }

  getDiagnostics(): AppServerDiagnostics {
    return structuredClone(this.diagnostics);
  }

  getWarnings(): Warning[] {
    return structuredClone(this.warnings);
  }
}
