import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { WARNING_CODES, warning } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { packageVersion } from "./package.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000;

export function codexVersionFrom(userAgent) {
  if (typeof userAgent !== "string") return undefined;
  const codexVersion = userAgent.match(/codex[^/ ]*[ /]v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
  return codexVersion?.[1] || userAgent.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1];
}

export function codexSurfaceFrom(userAgent) {
  if (typeof userAgent !== "string") return "unknown";
  const product = userAgent.split("/", 1)[0].trim().toLowerCase();
  if (product.includes("desktop")) return "desktop";
  if (/^(?:codex(?:[-_ ]?cli(?:_rs)?)?|synod_cli)$/.test(product)) return "cli";
  return "unknown";
}

function boundedLine(line) {
  const value = String(line).replaceAll(/[\r\n]/g, " ");
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

export class CodexAppServerClient {
  constructor({
    codexBin = process.env.SYNOD_CODEX_BIN || "codex",
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
    spawnProcess = spawn
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
        `Could not spawn Codex App Server: ${error.message}`,
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
    child.stderr.on("data", chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    child.stdin.on("error", error => {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_PROTOCOL_ERROR,
        `Codex App Server stdin failed: ${error.message}`,
        { cause: error }
      ));
    });

    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", line => this.handleLine(line));
    child.on("error", error => {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_SPAWN_FAILED,
        `Codex App Server failed to start: ${error.message}`,
        { cause: error, details: { codexBin: this.codexBin } }
      ));
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      if (this.pending.size === 0) return;
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
    if (!initialized || typeof initialized !== "object" || typeof initialized.userAgent !== "string") {
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

  async probeCapabilities() {
    const response = await this.request("thread/list", { archived: false, limit: 1 });
    if (!response || !Array.isArray(response.data)) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server does not expose the required thread/list response contract.",
        { details: { capability: "thread/list" } }
      );
    }
    this.diagnostics.appServer.capabilities.threadList = true;
    return this.diagnostics.appServer.capabilities;
  }

  async listModels() {
    const models = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const response = await this.request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      if (
        !response
        || !Array.isArray(response.data)
        || (response.nextCursor !== null && typeof response.nextCursor !== "string")
        || response.nextCursor === ""
      ) {
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

  request(method, params = {}) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.child?.stdin?.writable || this.exitInfo) {
      return Promise.reject(new SynodError(
        ERROR_CODES.APP_SERVER_NOT_RUNNING,
        "Codex App Server is not running.",
        { details: { method } }
      ));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
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

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    if (this.fatalError) throw this.fatalError;
    if (!this.child?.stdin?.writable || this.exitInfo) {
      throw new SynodError(ERROR_CODES.APP_SERVER_NOT_RUNNING, "Codex App Server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new SynodError(
        ERROR_CODES.APP_SERVER_MALFORMED_OUTPUT,
        "Codex App Server emitted malformed JSON output.",
        { cause: error, details: { output: boundedLine(line) } }
      ));
      return;
    }

    if (!message || typeof message !== "object" || message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new SynodError(
        ERROR_CODES.APP_SERVER_PROTOCOL_ERROR,
        message.error.message || JSON.stringify(message.error),
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

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  fail(error) {
    this.fatalError = error;
    this.rejectAll(error);
  }

  waitForExit(child, timeoutMs) {
    if (this.exitInfo || child.exitCode != null || child.signalCode != null) {
      return Promise.resolve(true);
    }

    return new Promise(resolve => {
      let timeout;
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

  async close() {
    const child = this.child;
    if (!child) return this.diagnostics.appServer.cleanup;

    this.rejectAll(new SynodError(
      ERROR_CODES.APP_SERVER_NOT_RUNNING,
      "Codex App Server connection closed."
    ));
    this.lines?.close();

    const cleanup = {
      signal: undefined,
      forced: false,
      exitConfirmed: Boolean(this.exitInfo || child.exitCode != null || child.signalCode != null),
      signalErrors: []
    };
    const sendSignal = signal => {
      try {
        return child.kill(signal);
      } catch (error) {
        cleanup.signalErrors.push({ signal, message: error.message });
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
      cleanup.detachErrors = [];
      for (const [name, stream] of [
        ["stdin", child.stdin],
        ["stdout", child.stdout],
        ["stderr", child.stderr]
      ]) {
        try {
          stream?.destroy?.();
        } catch (error) {
          cleanup.detachErrors.push({ stream: name, message: error.message });
        }
      }
      try {
        child.unref?.();
      } catch (error) {
        cleanup.detachErrors.push({ stream: "process", message: error.message });
      }
      if (cleanup.detachErrors.length === 0) delete cleanup.detachErrors;
    }

    cleanup.code = this.exitInfo?.code ?? child.exitCode ?? undefined;
    cleanup.exitSignal = this.exitInfo?.signal ?? child.signalCode ?? undefined;
    if (cleanup.signalErrors.length === 0) delete cleanup.signalErrors;
    this.diagnostics.appServer.cleanup = cleanup;
    this.child = undefined;
    return cleanup;
  }

  getDiagnostics() {
    return structuredClone(this.diagnostics);
  }

  getWarnings() {
    return structuredClone(this.warnings);
  }
}
