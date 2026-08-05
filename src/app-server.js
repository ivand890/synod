import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { packageVersion } from "./package.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export class CodexAppServerClient {
  constructor({
    codexBin = process.env.SYNOD_CODEX_BIN || "codex",
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    spawnProcess = spawn
  } = {}) {
    this.codexBin = codexBin;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
  }

  async start() {
    if (this.child) return;

    this.child = this.spawnProcess(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    this.child.stdin.on("error", error => this.rejectAll(error));

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", line => this.handleLine(line));
    this.child.on("error", error => this.rejectAll(error));
    this.child.on("exit", code => {
      if (this.pending.size > 0) {
        const detail = this.stderr.trim();
        this.rejectAll(new Error(`Codex App Server exited with code ${code}.${detail ? ` ${detail}` : ""}`));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "synod_cli",
        title: "Synod CLI",
        version: packageVersion
      },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server is not running."));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timed out while calling ${method}.`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
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

  async close() {
    if (!this.child) return;
    this.rejectAll(new Error("Codex App Server connection closed."));
    this.lines?.close();
    if (!this.child.killed) this.child.kill();
    this.child = undefined;
  }
}
