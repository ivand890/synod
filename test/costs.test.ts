import assert from "node:assert/strict";
import test from "node:test";
import { formatCostReport, projectUsageCost, validatePriceFile } from "../src/costs.js";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import { parseUsageArgs } from "../src/command-options.js";
import { formatUsageReport } from "../src/usage.js";
import type { UsageReport } from "../src/usage.js";

function usage(): UsageReport {
  const zeroCoordination = {
    counts: { totalCalls: 0, coordinationCalls: 0, implementationCalls: 0, spawn: 0, followUp: 0, message: 0, followUpOrMessage: 0, wait: 0, listAgents: 0, interruptAgent: 0, supervision: 0, compactions: 0 },
    tools: [],
    callDuration: { status: "unavailable" as const, observed: 0, missing: 0 },
    waitDuration: { status: "unavailable" as const, observed: 0, missing: 0 },
    requestedWaitDuration: { status: "unavailable" as const, observed: 0, missing: 0 },
    outcomes: { status: "unavailable" as const, observed: 0, missing: 0 },
    retries: { available: false }
  };
  return {
    session: { threadId: "root", cwd: "/project" },
    capturedAt: "2026-08-12T12:00:00.000Z",
    models: [
      { model: "model-a", threads: 1, inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 100_000, reasoningOutputTokens: 40_000, totalTokens: 1_100_000 },
      { model: "model-b", threads: 1, inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 50_000, reasoningOutputTokens: 10_000, totalTokens: 550_000 }
    ],
    roles: [],
    attribution: [],
    threads: [],
    total: { threads: 2, inputTokens: 1_500_000, cachedInputTokens: 250_000, outputTokens: 150_000, reasoningOutputTokens: 50_000, totalTokens: 1_650_000 },
    tokenCounters: { resets: 0 },
    completeness: { status: "complete", reasons: [] },
    coordination: { total: zeroCoordination, roles: [], threads: [], completeness: { status: "complete", reasons: [] } },
    interval: {
      inclusion: "(start,end]",
      start: { kind: "event", timestamp: "2026-08-12T10:00:00.000Z", event: { sequence: 1, id: "start", hash: "sha256:start", type: "orchestration.initialized" } },
      end: { kind: "event", timestamp: "2026-08-12T12:00:00.000Z", event: { sequence: 2, id: "end", hash: "sha256:end", type: "checkpoint.recorded" } },
      complete: true
    },
    warnings: [],
    diagnostics: {}
  };
}

const completePrices = {
  schemaVersion: 1 as const,
  currency: "USD",
  asOf: "2026-08-01",
  validUntil: "2026-08-31",
  source: "caller fixture",
  models: {
    "model-a": { uncachedInputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
    "model-b": { uncachedInputPerMillion: 1, cachedInputPerMillion: 0.25, outputPerMillion: 4 }
  }
};

test("projects exact dated multi-model prices without charging reasoning twice", () => {
  const report = projectUsageCost(usage(), validatePriceFile(completePrices));

  assert.equal(report.status, "complete");
  assert.equal(report.rows[0]?.uncachedInputTokens, 750_000);
  assert.deepEqual(report.rows[0]?.estimate, { uncachedInput: 1.5, cachedInput: 0.125, output: 0.8, total: 2.425 });
  assert.equal(report.rows[0]?.reasoningOutputTokens, 40_000);
  assert.equal(report.total, 3.125);
  assert.match(formatCostReport(report), /reasoning=40000/);
  assert.match(formatCostReport(report), /already included in output/);
});

test("unknown exact model names remain raw, partial, and suppress the grand total", () => {
  const prices = validatePriceFile({ ...completePrices, models: { "model-a": completePrices.models["model-a"] } });
  const report = projectUsageCost(usage(), prices);

  assert.equal(report.status, "partial");
  assert.deepEqual(report.unpricedModels, ["model-b"]);
  assert.equal(report.rows[1]?.priced, false);
  assert.equal(report.rows[1]?.inputTokens, 500_000);
  assert.equal(report.total, undefined);
});

test("invalid currencies, stale validity, incomplete reports, and inconsistent inclusive counters fail closed", () => {
  assert.throws(
    () => validatePriceFile({ ...completePrices, currency: "ZZZ" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_PRICE_INVALID
  );
  assert.throws(
    () => validatePriceFile({ ...completePrices, asOf: "2026-02-31" }),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_PRICE_INVALID
  );
  assert.throws(
    () => projectUsageCost(usage(), validatePriceFile({ ...completePrices, validUntil: "2026-08-11" })),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_PRICE_STALE
  );
  const incomplete = usage();
  incomplete.completeness = { status: "incomplete", reasons: ["active-session-tree"] };
  assert.throws(
    () => projectUsageCost(incomplete, validatePriceFile(completePrices)),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_REPORT_INCOMPLETE
  );
  const open = usage();
  open.interval = {
    ...open.interval!,
    end: { kind: "capture", timestamp: open.capturedAt },
    complete: false
  };
  assert.throws(
    () => projectUsageCost(open, validatePriceFile(completePrices)),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_REPORT_INCOMPLETE
  );
  const inconsistent = usage();
  inconsistent.models[0]!.cachedInputTokens = inconsistent.models[0]!.inputTokens + 1;
  assert.throws(
    () => projectUsageCost(inconsistent, validatePriceFile(completePrices)),
    error => error instanceof SynodError && error.code === ERROR_CODES.COST_USAGE_INVALID
  );
});

test("model prices match own exact keys rather than inherited object names", () => {
  const inheritedName = usage();
  inheritedName.models = [{ ...inheritedName.models[0]!, model: "toString" }];
  const report = projectUsageCost(inheritedName, validatePriceFile(completePrices));

  assert.equal(report.status, "partial");
  assert.deepEqual(report.unpricedModels, ["toString"]);
  assert.equal(report.total, undefined);
});

test("ordinary usage text and JSON-shaped data remain monetary-free by default", () => {
  const report = usage();
  const { warnings: _warnings, diagnostics: _diagnostics, ...data } = report;

  assert.equal("cost" in data, false);
  assert.doesNotMatch(formatUsageReport(report), /cost|currency|USD/i);
  assert.equal("priceFile" in parseUsageArgs(["--since-event", "1"]), false);
  const priced = parseUsageArgs(["--price-file", "prices.json"]);
  assert.equal("help" in priced ? undefined : priced.priceFile, "prices.json");
});
