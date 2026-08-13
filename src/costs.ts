import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ERROR_CODES, SynodError } from "./errors.js";
import type { TokenUsage, UsageReport } from "./usage.js";
import { isRecord, parseJson } from "./validation.js";

export interface ModelPrice {
  uncachedInputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface PriceFile {
  schemaVersion: 1;
  currency: string;
  asOf: string;
  validUntil?: string;
  source: string;
  models: Record<string, ModelPrice>;
}

export interface CostRow extends TokenUsage {
  model: string;
  uncachedInputTokens: number;
  priced: boolean;
  rates?: ModelPrice;
  estimate?: {
    uncachedInput: number;
    cachedInput: number;
    output: number;
    total: number;
  };
}

export interface CostReport {
  status: "complete" | "partial";
  currency: string;
  asOf: string;
  validUntil?: string;
  source: string;
  usageCapturedAt: string;
  rows: CostRow[];
  unpricedModels: string[];
  total?: number;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isModelPrice(value: unknown): value is ModelPrice {
  return isRecord(value)
    && Object.keys(value).length === 3
    && isRate(value.uncachedInputPerMillion)
    && isRate(value.cachedInputPerMillion)
    && isRate(value.outputPerMillion);
}

export function validatePriceFile(value: unknown): PriceFile {
  if (!isRecord(value)
    || Object.keys(value).some(key => !["schemaVersion", "currency", "asOf", "validUntil", "source", "models"].includes(key))
    || value.schemaVersion !== 1
    || typeof value.currency !== "string"
    || !/^[A-Z]{3}$/.test(value.currency)
    || !Intl.supportedValuesOf("currency").includes(value.currency)
    || !isDate(value.asOf)
    || (value.validUntil !== undefined && !isDate(value.validUntil))
    || (typeof value.validUntil === "string" && value.validUntil < value.asOf)
    || typeof value.source !== "string"
    || value.source.trim().length === 0
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0
    || Object.keys(value.models).some(model => model.trim().length === 0)
    || !Object.values(value.models).every(isModelPrice)) {
    throw new SynodError(ERROR_CODES.COST_PRICE_INVALID, "Price file must use schema 1 with a dated currency and exact non-negative per-million model rates.");
  }
  return value as unknown as PriceFile;
}

export async function readPriceFile(filename: string, cwd = process.cwd()): Promise<PriceFile> {
  const absolute = path.resolve(cwd, filename);
  try {
    return validatePriceFile(parseJson(await readFile(absolute, "utf8")));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.COST_PRICE_INVALID, `Could not read price file: ${absolute}.`, { cause: error, details: { path: absolute } });
  }
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

export function projectUsageCost(usage: UsageReport, prices: PriceFile): CostReport {
  if (usage.completeness.status !== "complete" || !usage.interval?.complete || usage.interval.end.kind === "capture") {
    throw new SynodError(ERROR_CODES.COST_REPORT_INCOMPLETE, "Cost projection requires a complete closed usage report.", {
      details: { completeness: usage.completeness, interval: usage.interval }
    });
  }
  const usageDate = usage.capturedAt.slice(0, 10);
  if (usageDate < prices.asOf || (prices.validUntil !== undefined && usageDate > prices.validUntil)) {
    throw new SynodError(ERROR_CODES.COST_PRICE_STALE, "The price file is not valid for the usage capture date.", {
      details: { usageDate, asOf: prices.asOf, validUntil: prices.validUntil }
    });
  }
  const rows: CostRow[] = usage.models.map(model => {
    if (model.cachedInputTokens > model.inputTokens || model.reasoningOutputTokens > model.outputTokens) {
      throw new SynodError(ERROR_CODES.COST_USAGE_INVALID, `Usage counters for ${model.model} violate inclusive token semantics.`, {
        details: { model: model.model, inputTokens: model.inputTokens, cachedInputTokens: model.cachedInputTokens, outputTokens: model.outputTokens, reasoningOutputTokens: model.reasoningOutputTokens }
      });
    }
    const uncachedInputTokens = model.inputTokens - model.cachedInputTokens;
    const rates = Object.hasOwn(prices.models, model.model) ? prices.models[model.model] : undefined;
    if (!rates) return { ...model, uncachedInputTokens, priced: false };
    const uncachedInput = money((uncachedInputTokens * rates.uncachedInputPerMillion) / 1_000_000);
    const cachedInput = money((model.cachedInputTokens * rates.cachedInputPerMillion) / 1_000_000);
    const output = money((model.outputTokens * rates.outputPerMillion) / 1_000_000);
    return {
      ...model,
      uncachedInputTokens,
      priced: true,
      rates,
      estimate: { uncachedInput, cachedInput, output, total: money(uncachedInput + cachedInput + output) }
    };
  });
  const unpricedModels = rows.filter(row => !row.priced).map(row => row.model).sort();
  return {
    status: unpricedModels.length === 0 ? "complete" : "partial",
    currency: prices.currency,
    asOf: prices.asOf,
    ...(prices.validUntil ? { validUntil: prices.validUntil } : {}),
    source: prices.source,
    usageCapturedAt: usage.capturedAt,
    rows,
    unpricedModels,
    ...(unpricedModels.length === 0 ? { total: money(rows.reduce((sum, row) => sum + (row.estimate?.total || 0), 0)) } : {})
  };
}

export function formatCostReport(report: CostReport): string {
  return [
    `Cost estimate: ${report.status}`,
    `Prices: ${report.currency} as of ${report.asOf}${report.validUntil ? ` through ${report.validUntil}` : ""} (${report.source})`,
    ...report.rows.map(row => `- ${row.model}: input=${row.inputTokens} cached=${row.cachedInputTokens} uncached=${row.uncachedInputTokens} output=${row.outputTokens} reasoning=${row.reasoningOutputTokens}; ${row.priced ? `${report.currency} ${row.estimate!.total.toFixed(6)}` : "unpriced"}`),
    `Total: ${report.total === undefined ? "unavailable because one or more models are unpriced" : `${report.currency} ${report.total.toFixed(6)}`}`,
    "Reasoning tokens are evidence only and are already included in output."
  ].join("\n");
}
