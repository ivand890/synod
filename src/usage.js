import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CodexAppServerClient } from "./app-server.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";

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
};

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addUsage(target, usage) {
  for (const field of Object.values(TOKEN_FIELDS)) target[field] += usage[field];
}

function normalizeUsage(raw = {}) {
  const usage = emptyUsage();
  for (const [source, target] of Object.entries(TOKEN_FIELDS)) {
    const value = Number(raw[source]);
    usage[target] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return usage;
}

function usageDelta(current, previous) {
  const reset = current.totalTokens < previous.totalTokens;
  const delta = emptyUsage();
  for (const field of Object.values(TOKEN_FIELDS)) {
    delta[field] = reset ? current[field] : Math.max(0, current[field] - previous[field]);
  }
  return delta;
}

function reroutedModel(payload) {
  if (payload?.type === "model_rerouted") return payload.to_model || payload.toModel;
  if (payload?.type === "model/rerouted") return payload.toModel || payload.to_model;
  return undefined;
}

export async function readRolloutUsage(rolloutPath, { openStream = createReadStream } = {}) {
  const byModel = new Map();
  let activeModel = "unknown";
  let previous = emptyUsage();

  const lines = readline.createInterface({
    input: openStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "turn_context" && event.payload?.model) {
      activeModel = event.payload.model;
      continue;
    }

    const reroute = reroutedModel(event.payload);
    if (reroute) {
      activeModel = reroute;
      continue;
    }

    if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
    const raw = event.payload.info?.total_token_usage;
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

async function listPages(client, params) {
  const threads = [];
  let cursor;
  do {
    const response = await client.request("thread/list", { ...params, cursor, limit: 100 });
    if (!response || !Array.isArray(response.data)) {
      throw new SynodError(
        ERROR_CODES.APP_SERVER_UNSUPPORTED,
        "Codex App Server returned an invalid thread/list response.",
        { details: { capability: "thread/list" } }
      );
    }
    threads.push(...response.data);
    cursor = response.nextCursor || undefined;
  } while (cursor);
  return threads;
}

async function findLatestRoot(client, cwd) {
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

function comparableTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function findRoot(client, threadId) {
  let response = await client.request("thread/read", { threadId, includeTurns: false });
  let thread = response.thread;
  const visited = new Set();

  while (thread.parentThreadId) {
    if (visited.has(thread.id)) {
      throw new SynodError(ERROR_CODES.SESSION_CYCLE, `Cycle detected in Codex thread tree at ${thread.id}.`, {
        details: { threadId: thread.id }
      });
    }
    visited.add(thread.id);
    response = await client.request("thread/read", {
      threadId: thread.parentThreadId,
      includeTurns: false
    });
    thread = response.thread;
  }

  return thread;
}

async function findDescendants(client, root) {
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
} = {}) {
  const client = clientFactory();
  let report;
  let failure;
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
    const aggregate = new Map();

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

  return { ...report, warnings, diagnostics };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatUsageReport(report) {
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
    Math.max(header.length, ...rows.map(row => row[index].length))
  );
  const render = row => row.map((cell, index) =>
    index < 2 ? cell.padEnd(widths[index]) : cell.padStart(widths[index])
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
