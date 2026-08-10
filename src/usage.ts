import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CodexAppServerClient } from "./app-server.js";
import type { AppServerDiagnostics } from "./app-server.js";
import type { Warning } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { isRecord, parseJson } from "./validation.js";

const ALL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

const INTERACTIVE_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];

const TOKEN_FIELDS = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
  total_tokens: "totalTokens"
} as const;

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadRecord {
  id: string;
  parentThreadId: string | null;
  path?: string;
  cwd?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UsageModelRow extends TokenUsage {
  model: string;
  threads: number;
}

export interface UsageReport {
  session: {
    threadId: string;
    cwd?: string | undefined;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  capturedAt: string;
  models: UsageModelRow[];
  total: TokenUsage & { threads: number };
  warnings: Warning[];
  diagnostics: AppServerDiagnostics | Record<string, unknown>;
}

export interface UsageClient {
  start(): Promise<void>;
  close(): Promise<unknown>;
  request?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  probeCapabilities?(): Promise<unknown>;
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
  getWarnings?(): Warning[];
}

function requestClient(
  client: UsageClient,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!client.request) {
    throw new SynodError(ERROR_CODES.APP_SERVER_PROTOCOL_ERROR, "Codex App Server client does not support requests.", {
      details: { method }
    });
  }
  return client.request(method, params);
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.parentThreadId === null || typeof value.parentThreadId === "string")
    && (value.path === undefined || typeof value.path === "string")
    && (value.cwd === undefined || typeof value.cwd === "string");
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  for (const field of Object.values(TOKEN_FIELDS)) target[field] += usage[field];
}

function normalizeUsage(raw: Record<string, unknown> = {}): TokenUsage {
  const usage = emptyUsage();
  for (const [source, target] of Object.entries(TOKEN_FIELDS)) {
    const value = Number(raw[source]);
    usage[target] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return usage;
}

function usageDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const reset = current.totalTokens < previous.totalTokens;
  const delta = emptyUsage();
  for (const field of Object.values(TOKEN_FIELDS)) {
    delta[field] = reset ? current[field] : Math.max(0, current[field] - previous[field]);
  }
  return delta;
}

function reroutedModel(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.type === "model_rerouted") {
    if (typeof payload.to_model === "string") return payload.to_model;
    if (typeof payload.toModel === "string") return payload.toModel;
  }
  if (payload.type === "model/rerouted") {
    if (typeof payload.toModel === "string") return payload.toModel;
    if (typeof payload.to_model === "string") return payload.to_model;
  }
  return undefined;
}

export async function readRolloutUsage(
  rolloutPath: string,
  { openStream = createReadStream }: {
    openStream?: (path: string, options: { encoding: BufferEncoding }) => NodeJS.ReadableStream;
  } = {}
): Promise<Map<string, TokenUsage>> {
  const byModel = new Map<string, TokenUsage>();
  let activeModel = "unknown";
  let previous = emptyUsage();

  const lines = readline.createInterface({
    input: openStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    let event: unknown;
    try {
      event = parseJson(line);
    } catch {
      continue;
    }

    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : undefined;

    if (event.type === "turn_context" && typeof payload?.model === "string") {
      activeModel = payload.model;
      continue;
    }

    const reroute = reroutedModel(payload);
    if (reroute) {
      activeModel = reroute;
      continue;
    }

    if (event.type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = isRecord(payload.info) ? payload.info : undefined;
    const raw = isRecord(info?.total_token_usage) ? info.total_token_usage : undefined;
    if (!raw) continue;

    const current = normalizeUsage(raw);
    const delta = usageDelta(current, previous);
    previous = current;

    if (delta.totalTokens === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) continue;
    const usage = byModel.get(activeModel) || emptyUsage();
    addUsage(usage, delta);
    byModel.set(activeModel, usage);
  }

  return byModel;
}

async function listPages(client: UsageClient, params: Record<string, unknown>): Promise<ThreadRecord[]> {
  const threads: ThreadRecord[] = [];
  let cursor: string | undefined;
  do {
    const response: unknown = await requestClient(client, "thread/list", { ...params, cursor, limit: 100 });
    if (
      !isRecord(response)
      || !Array.isArray(response.data)
      || !response.data.every(isThreadRecord)
      || (response.nextCursor !== undefined && response.nextCursor !== null && typeof response.nextCursor !== "string")
    ) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server returned an invalid thread/list response.",
        { details: { capability: "thread/list" } }
      );
    }
    threads.push(...response.data);
    cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0
      ? response.nextCursor
      : undefined;
  } while (cursor);
  return threads;
}

async function findLatestRoot(client: UsageClient, cwd: string): Promise<ThreadRecord | undefined> {
  const query = {
    cwd,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: INTERACTIVE_SOURCE_KINDS
  };
  const [active, archived] = await Promise.all([
    listPages(client, { ...query, archived: false }),
    listPages(client, { ...query, archived: true })
  ]);
  const roots = new Map();
  for (const thread of [...active, ...archived]) {
    if (thread.parentThreadId == null) roots.set(thread.id, thread);
  }

  return [...roots.values()].sort((left, right) => {
    const updated = comparableTime(right.updatedAt) - comparableTime(left.updatedAt);
    if (updated !== 0) return updated;
    const created = comparableTime(right.createdAt) - comparableTime(left.createdAt);
    if (created !== 0) return created;
    return String(left.id).localeCompare(String(right.id));
  })[0];
}

function comparableTime(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function findRoot(client: UsageClient, threadId: string): Promise<ThreadRecord> {
  let response: unknown = await requestClient(client, "thread/read", { threadId, includeTurns: false });
  if (!isRecord(response) || !isThreadRecord(response.thread)) {
    throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Codex App Server returned an invalid thread/read response.");
  }
  let thread = response.thread;
  const visited = new Set<string>();

  while (thread.parentThreadId) {
    if (visited.has(thread.id)) {
      throw new SynodError(ERROR_CODES.SESSION_CYCLE, `Cycle detected in Codex thread tree at ${thread.id}.`, {
        details: { threadId: thread.id }
      });
    }
    visited.add(thread.id);
    response = await requestClient(client, "thread/read", {
      threadId: thread.parentThreadId,
      includeTurns: false
    });
    if (!isRecord(response) || !isThreadRecord(response.thread)) {
      throw new SynodError(ERROR_CODES.APP_SERVER_UNSUPPORTED, "Codex App Server returned an invalid thread/read response.");
    }
    thread = response.thread;
  }

  return thread;
}

async function findDescendants(client: UsageClient, root: ThreadRecord): Promise<ThreadRecord[]> {
  const threads = [root];
  const queue = [root.id];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const parentThreadId = queue.shift();
    const childQuery = {
      parentThreadId,
      sourceKinds: ALL_SOURCE_KINDS,
      sortKey: "created_at",
      sortDirection: "asc"
    };
    const [activeChildren, archivedChildren] = await Promise.all([
      listPages(client, { ...childQuery, archived: false }),
      listPages(client, { ...childQuery, archived: true })
    ]);
    const children = [...activeChildren, ...archivedChildren];

    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      threads.push(child);
      queue.push(child.id);
    }
  }

  return threads;
}

export async function collectUsage({
  cwd = process.cwd(),
  threadId,
  clientFactory = () => new CodexAppServerClient()
}: {
  cwd?: string;
  threadId?: string;
  clientFactory?: () => UsageClient;
} = {}): Promise<UsageReport> {
  const client = clientFactory();
  let report: Omit<UsageReport, "warnings" | "diagnostics"> | undefined;
  let failure: SynodError | undefined;
  try {
    await client.start();
    if (typeof client.probeCapabilities === "function") await client.probeCapabilities();
    const resolvedCwd = path.resolve(cwd);
    const root = threadId
      ? await findRoot(client, threadId)
      : await findLatestRoot(client, resolvedCwd);

    if (!root) {
      throw new SynodError(
        ERROR_CODES.SESSION_NOT_FOUND,
        `No Codex session found for ${resolvedCwd}. Use --session <thread-id> to select one.`,
        { details: { cwd: resolvedCwd } }
      );
    }

    const threads = await findDescendants(client, root);
    const aggregate = new Map<string, TokenUsage & { model: string; threads: Set<string> }>();

    for (const thread of threads) {
      if (!thread.path) {
        throw new SynodError(
          ERROR_CODES.ROLLOUT_PATH_MISSING,
          `Codex did not expose a rollout path for thread ${thread.id}.`,
          { details: { threadId: thread.id } }
        );
      }

      const threadUsage = await readRolloutUsage(thread.path);
      for (const [model, usage] of threadUsage) {
        const row = aggregate.get(model) || { model, threads: new Set(), ...emptyUsage() };
        row.threads.add(thread.id);
        addUsage(row, usage);
        aggregate.set(model, row);
      }
    }

    const models = [...aggregate.values()]
      .map(row => ({ ...row, threads: row.threads.size }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
    const total = { threads: threads.length, ...emptyUsage() };
    for (const row of models) addUsage(total, row);

    report = {
      session: {
        threadId: root.id,
        cwd: root.cwd,
        createdAt: root.createdAt,
        updatedAt: root.updatedAt
      },
      capturedAt: new Date().toISOString(),
      models,
      total
    };
  } catch (error) {
    failure = asSynodError(error);
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (!failure) failure = asSynodError(error);
    }
  }

  const diagnostics = typeof client.getDiagnostics === "function" ? client.getDiagnostics() : {};
  const warnings = typeof client.getWarnings === "function" ? client.getWarnings() : [];
  if (failure) {
    failure.diagnostics = diagnostics;
    failure.warnings = warnings;
    throw failure;
  }

  if (!report) throw new SynodError(ERROR_CODES.INTERNAL, "Usage collection completed without a report.");
  return { ...report, warnings, diagnostics };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatUsageReport(report: UsageReport): string {
  const rows = report.models.map(row => [
    row.model,
    String(row.threads),
    formatNumber(row.inputTokens),
    formatNumber(row.cachedInputTokens),
    formatNumber(row.outputTokens),
    formatNumber(row.reasoningOutputTokens),
    formatNumber(row.totalTokens)
  ]);
  rows.push([
    "TOTAL",
    String(report.total.threads),
    formatNumber(report.total.inputTokens),
    formatNumber(report.total.cachedInputTokens),
    formatNumber(report.total.outputTokens),
    formatNumber(report.total.reasoningOutputTokens),
    formatNumber(report.total.totalTokens)
  ]);

  const headers = ["Model", "Threads", "Input", "Cached", "Output", "Reasoning", "Total"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0))
  );
  const render = (row: string[]) => row.map((cell, index) => {
    const width = widths[index] ?? cell.length;
    return index < 2 ? cell.padEnd(width) : cell.padStart(width);
  }
  ).join("  ");

  return [
    `Session: ${report.session.threadId}`,
    `Directory: ${report.session.cwd}`,
    "",
    render(headers),
    widths.map(width => "-".repeat(width)).join("  "),
    ...rows.map(render),
    "",
    "Cached tokens are included in Input; reasoning tokens are included in Output."
  ].join("\n");
}
