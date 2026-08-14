import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord, parseJson } from "../src/validation.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "synod-package-smoke-"));
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const targetDirectory = path.join(consumerDirectory, "project");
const installedPackageRoot = path.join(consumerDirectory, "node_modules", "@ivand890", "synod");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const synodExecutable = path.join(
  consumerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "synod.cmd" : "synod",
);
const synodEntryPoint = path.join(
  consumerDirectory,
  "node_modules",
  "@ivand890",
  "synod",
  "bin",
  "synod.js",
);
let runtimePackageSpec: string | undefined;

function jsonRecord(text: string, label: string): Record<string, unknown> {
  const value = parseJson(text);
  if (!isRecord(value)) throw new Error(`${label} is not a JSON object.`);
  return value;
}

function nestedRecord(value: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) throw new Error(`${label}.${key} is not a JSON object.`);
  return nested;
}

type RunOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "stdio"> & {
  capture?: boolean;
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runResult(command: string, args: string[], options: RunOptions = {}): RunResult {
  const { capture: _capture, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    stdio: "pipe",
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout?.trim() || "", stderr: result.stderr?.trim() || "" };
}

function run(command: string, args: string[], options: RunOptions = {}): string {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    stdio: capture ? "pipe" : "inherit",
    ...spawnOptions,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = capture ? `\n${result.stdout}${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.${details}`);
  }

  return result.stdout?.trim();
}

function runSynod(args: string[], options: RunOptions = {}): string {
  const runtimeOptions = {
    ...options,
    env: {
      ...process.env,
      ...(runtimePackageSpec ? { SYNOD_RUNTIME_PACKAGE_SPEC: runtimePackageSpec } : {}),
      ...options.env,
    },
  };
  if (process.platform === "win32") {
    return run(process.execPath, [synodEntryPoint, ...args], runtimeOptions);
  }

  return run(synodExecutable, args, runtimeOptions);
}

function runSynodDlx(args: string[], options: RunOptions = {}): string {
  if (!runtimePackageSpec) throw new Error("Package smoke runtime spec is not initialized.");
  return run(pnpmExecutable, ["--silent", "dlx", runtimePackageSpec, ...args], {
    ...options,
    env: {
      ...process.env,
      SYNOD_RUNTIME_PACKAGE_SPEC: runtimePackageSpec,
      ...options.env,
    },
  });
}

function runSynodResult(args: string[], options: RunOptions = {}): RunResult {
  return runResult(process.execPath, [synodEntryPoint, ...args], {
    ...options,
    env: {
      ...process.env,
      ...(runtimePackageSpec ? { SYNOD_RUNTIME_PACKAGE_SPEC: runtimePackageSpec } : {}),
      ...options.env,
    },
  });
}

function runSynodAsync(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [synodEntryPoint, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(runtimePackageSpec ? { SYNOD_RUNTIME_PACKAGE_SPEC: runtimePackageSpec } : {}),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function exactFence(lease: Record<string, unknown>): string[] {
  for (const key of ["id", "generation", "taskRevision", "heartbeatAt", "ownerThread"]) {
    if ((typeof lease[key] !== "string" && typeof lease[key] !== "number") || lease[key] === "") {
      throw new Error(`Lease is missing exact fence field ${key}.`);
    }
  }
  return [
    "--lease-id", String(lease.id),
    "--generation", String(lease.generation),
    "--revision", String(lease.taskRevision),
    "--expected-heartbeat-at", String(lease.heartbeatAt),
    "--owner-thread", String(lease.ownerThread),
  ];
}

function exactReservationFence(reservation: Record<string, unknown>): string[] {
  const baseline = nestedRecord(reservation, "baseline", "lease reservation");
  for (const key of ["id", "token", "generation", "taskRevision", "reservedAt"]) {
    if ((typeof reservation[key] !== "string" && typeof reservation[key] !== "number") || reservation[key] === "") {
      throw new Error(`Lease reservation is missing exact fence field ${key}.`);
    }
  }
  if (typeof baseline.snapshotContentHash !== "string" || baseline.snapshotContentHash === "") {
    throw new Error("Lease reservation is missing its baseline hash.");
  }
  return [
    "--reservation-token", String(reservation.token),
    "--lease-id", String(reservation.id),
    "--generation", String(reservation.generation),
    "--revision", String(reservation.taskRevision),
    "--expected-reserved-at", String(reservation.reservedAt),
    "--baseline-hash", baseline.snapshotContentHash,
  ];
}

function addReadyTask(directory: string, id: string): void {
  runSynod([
    "task", "add", id,
    "--objective", `Installed package drill ${id}`,
    "--executor", "synod_implementer",
    "--acceptance", "The installed package drill passes",
    "--verification", "pnpm test:package",
    "--cwd", directory,
    "--json",
  ], { capture: true });
  runSynod(["task", "transition", id, "READY", "--revision", "0", "--cwd", directory, "--json"], { capture: true });
}

async function runV09ProductionFixture(
  directory: string,
  consumer: string,
): Promise<void> {
  const installedExports = path.join(consumer, "v0.9-installed-exports.mjs");
  writeFileSync(installedExports, [
    'export * as usageModule from "@ivand890/synod/src/usage.js";',
    'export * as costsModule from "@ivand890/synod/src/costs.js";',
    'export * as orchestrationModule from "@ivand890/synod/src/orchestration.js";',
    'export * as handoffModule from "@ivand890/synod/src/handoff.js";',
    "",
  ].join("\n"), "utf8");
  const { usageModule, costsModule, orchestrationModule, handoffModule } = await import(
    pathToFileURL(installedExports).href
  );
  const canonical = await orchestrationModule.readOrchestration(directory);
  const startEvent = canonical.events[0];
  const endEvent = canonical.events.at(-1);
  if (!startEvent || !endEvent || endEvent.sequence <= startEvent.sequence) {
    throw new Error("v0.9 production fixture requires a non-empty canonical interval.");
  }
  const startMs = Date.parse(startEvent.timestamp);
  const endMs = Date.parse(endEvent.timestamp);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 24) {
    throw new Error("v0.9 production fixture requires an ordered canonical time interval.");
  }
  const at = (position: number): string => new Date(
    Math.min(endMs, startMs + Math.max(1, Math.floor(((endMs - startMs) * position) / 24))),
  ).toISOString();
  const captureAt = new Date(endMs + 1_000).toISOString();
  const timed = (timestamp: string, type: string, payload: unknown): string => JSON.stringify({ timestamp, type, payload });
  const call = (timestamp: string, callId: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string => timed(timestamp, "response_item", {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    ...extra,
  });
  const output = (timestamp: string, callId: string, value: unknown): string => timed(timestamp, "response_item", {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(value),
  });
  const token = (
    timestamp: string,
    total: { input: number; cached: number; output: number; reasoning: number; total: number },
    context?: { input: number; window: number },
  ): string => timed(timestamp, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
        reasoning_output_tokens: total.reasoning,
        total_tokens: total.total,
      },
      ...(context ? {
        last_token_usage: { input_tokens: context.input },
        model_context_window: context.window,
      } : {}),
    },
  });
  const writeRollout = (name: string, records: string[]): string => {
    const rolloutDirectory = path.join(consumer, "v0.9-production-rollouts");
    mkdirSync(rolloutDirectory, { recursive: true });
    const filename = path.join(rolloutDirectory, `${name}.jsonl`);
    writeFileSync(filename, `${records.join("\n")}\n`, "utf8");
    return filename;
  };

  const rootPath = writeRollout("supervisor", [
    timed(startEvent.timestamp, "session_meta", { source: "cli", agent_role: "supervisor" }),
    timed(startEvent.timestamp, "turn_context", { model: "gpt-5.6-sol" }),
    token(startEvent.timestamp, { input: 80, cached: 40, output: 20, reasoning: 5, total: 100 }, { input: 20, window: 1_000 }),
    token(at(2), { input: 200, cached: 80, output: 40, reasoning: 10, total: 240 }, { input: 700, window: 1_000 }),
    call(at(3), "spawn-1", "spawn_agent", { message: "fixture implementer" }),
    output(at(4), "spawn-1", { ok: true }),
    call(at(5), "wait-1", "wait_agent", { timeout_ms: 30_000 }),
    output(at(7), "wait-1", { status: "completed" }),
    timed(at(8), "event_msg", { type: "context_compacted" }),
    call(at(9), "exec-failed", "exec", { command: "fixture" }),
    output(at(10), "exec-failed", { exit_code: 1 }),
    call(at(11), "exec-retry", "exec", { command: "fixture" }, { retry_of: "exec-failed" }),
    output(at(12), "exec-retry", { exit_code: 0 }),
    timed(at(13), "turn_context", { model: "gpt-5.6-luna" }),
    token(at(14), { input: 300, cached: 120, output: 60, reasoning: 18, total: 360 }, { input: 850, window: 1_000 }),
    timed(at(15), "event_msg", { type: "context_compacted" }),
    token(at(16), { input: 24, cached: 8, output: 6, reasoning: 2, total: 30 }, { input: 120, window: 1_000 }),
    token(endEvent.timestamp, { input: 40, cached: 12, output: 10, reasoning: 3, total: 50 }, { input: 180, window: 1_000 }),
    token(new Date(endMs + 500).toISOString(), { input: 136, cached: 44, output: 34, reasoning: 9, total: 170 }, { input: 820, window: 1_000 }),
  ]);
  const implementerPath = writeRollout("implementer", [
    timed(at(5), "session_meta", { source: { subagent: { thread_spawn: { agent_role: "synod_implementer" } } } }),
    timed(at(6), "turn_context", { model: "gpt-5.6-luna" }),
    call(at(7), "impl-exec", "exec", { command: "fixture implementation" }),
    output(at(8), "impl-exec", { exit_code: 0 }),
    token(at(9), { input: 160, cached: 80, output: 40, reasoning: 12, total: 200 }),
  ]);
  const reviewerPath = writeRollout("reviewer-archived", [
    timed(at(10), "session_meta", { source: { subagent: { thread_spawn: { agent_role: "synod_reviewer" } } } }),
    timed(at(11), "turn_context", { model: "gpt-5.6-terra" }),
    call(at(12), "review-message", "send_message", { message: "fixture correction" }),
    output(at(13), "review-message", { ok: true }),
    token(at(14), { input: 64, cached: 32, output: 16, reasoning: 4, total: 80 }),
  ]);
  const root = {
    id: "thread:package-smoke",
    parentThreadId: null,
    path: rootPath,
    cwd: directory,
    createdAt: new Date(startMs - 1_000).toISOString(),
    updatedAt: captureAt,
  };
  const implementer = {
    id: "thread:package-implementer",
    parentThreadId: root.id,
    path: implementerPath,
    cwd: directory,
    createdAt: at(5),
    updatedAt: endEvent.timestamp,
  };
  const reviewer = {
    id: "thread:package-reviewer",
    parentThreadId: root.id,
    path: reviewerPath,
    cwd: directory,
    createdAt: at(10),
    updatedAt: endEvent.timestamp,
  };
  const records = new Map([root, implementer, reviewer].map(item => [item.id, item]));
  const clientFactory = () => ({
    async start() {},
    async close() {},
    async request(method: string, params: Record<string, unknown> = {}) {
      if (method === "thread/read") return { thread: records.get(String(params.threadId)) };
      if (method !== "thread/list") throw new Error(`Unexpected App Server method: ${method}`);
      if (params.parentThreadId === root.id) {
        return { data: params.archived ? [reviewer] : [implementer], nextCursor: null };
      }
      return { data: [], nextCursor: null };
    },
    getWarnings() { return []; },
    getDiagnostics() { return { fixture: "v0.9-production" }; },
  });
  const usageCollector = (options: Record<string, unknown> = {}) => usageModule.collectUsage({
    ...options,
    clientFactory,
  });

  const completeUsage = await usageModule.collectUsage({
    cwd: directory,
    threadId: root.id,
    sinceEvent: startEvent.id,
    untilEvent: endEvent.id,
    clientFactory,
    clock: () => endEvent.timestamp,
  });
  const roles = new Set(completeUsage.roles.map((item: Record<string, unknown>) => item.role));
  if (
    completeUsage.completeness.status !== "complete"
    || completeUsage.interval?.complete !== true
    || completeUsage.threads.length !== 3
    || !completeUsage.threads.some((item: Record<string, unknown>) => item.threadId === reviewer.id)
    || !roles.has("supervisor")
    || !roles.has("synod_implementer")
    || !roles.has("synod_reviewer")
    || completeUsage.models.length !== 3
    || completeUsage.tokenCounters.resets !== 1
    || completeUsage.coordination.total.counts.spawn !== 1
    || completeUsage.coordination.total.counts.wait !== 1
    || completeUsage.coordination.total.counts.compactions !== 2
    || completeUsage.coordination.total.outcomes.failed !== 1
    || completeUsage.coordination.total.retries.count !== 1
  ) {
    throw new Error(`Installed v0.9 usage fixture was not production-shaped: ${JSON.stringify(completeUsage)}`);
  }

  const usageDate = endEvent.timestamp.slice(0, 10);
  const cost = costsModule.projectUsageCost(completeUsage, costsModule.validatePriceFile({
    schemaVersion: 1,
    currency: "USD",
    asOf: usageDate,
    validUntil: usageDate,
    source: "package-smoke:v0.9-production",
    models: {
      "gpt-5.6-sol": { uncachedInputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
      "gpt-5.6-luna": { uncachedInputPerMillion: 1, cachedInputPerMillion: 0.25, outputPerMillion: 4 },
      "gpt-5.6-terra": { uncachedInputPerMillion: 1.5, cachedInputPerMillion: 0.4, outputPerMillion: 6 },
    },
  }));
  if (cost.status !== "complete" || typeof cost.total !== "number" || cost.total <= 0 || cost.rows.length !== 3) {
    throw new Error(`Installed v0.9 cost fixture was invalid: ${JSON.stringify(cost)}`);
  }

  const rotationDependencies = { clock: () => captureAt, usageCollector };
  const statePath = path.join(directory, ".synod", "state.json");
  const eventsPath = path.join(directory, ".synod", "events.jsonl");
  const beforeReadOnly = [readFileSync(statePath), readFileSync(eventsPath)];
  const firstRotation = await orchestrationModule.reportProjectRotation({ directory }, rotationDependencies);
  const secondRotation = await orchestrationModule.reportProjectRotation({ directory }, rotationDependencies);
  const handoff = await handoffModule.generateHandoff({ directory }, rotationDependencies);
  const afterReadOnly = [readFileSync(statePath), readFileSync(eventsPath)];
  if (
    firstRotation.reportHash !== secondRotation.reportHash
    || !firstRotation.recommended
    || !firstRotation.reasons.includes("compactions")
    || firstRotation.usage.completeness.status !== "incomplete"
    || !firstRotation.completedTaskIds.includes("T-WORKTREE")
    || handoff.rotation?.reportHash !== firstRotation.reportHash
    || !beforeReadOnly.every((value, index) => value.equals(afterReadOnly[index]!))
  ) {
    throw new Error(`Installed v0.9 rotation report was invalid or mutated state: ${JSON.stringify(firstRotation)}`);
  }

  const priorPolicyRevision = canonical.state.tasks["T-001"]?.budget?.policy.revision;
  if (typeof priorPolicyRevision !== "number") {
    throw new Error("Installed v0.9 budget fixture requires its initial policy.");
  }
  const postResetPolicy = await orchestrationModule.setTaskBudgetPolicy({
    directory,
    id: "T-001",
    rootSessionId: root.id,
    startEvent: endEvent.id,
    hardTotalTokens: 100,
    reason: "Measure the installed fixture after its intentional counter reset",
    evidence: ["package-smoke:v0.9-post-reset"],
    replace: true,
  }, { clock: () => new Date(endMs + 1_500).toISOString() });
  if (postResetPolicy.policy.revision !== priorPolicyRevision + 1) {
    throw new Error("Installed v0.9 budget did not rebind after reset.");
  }
  const observed = await orchestrationModule.observeTaskBudget({ directory, id: "T-001" }, {
    clock: () => new Date(endMs + 2_000).toISOString(),
    usageCollector,
  });
  if (observed.observation.thresholdStatus !== "decision-required") {
    throw new Error(`Installed v0.9 budget fixture did not cross its hard limit: ${JSON.stringify(observed)}`);
  }
  const decided = await orchestrationModule.decideTaskBudget({
    directory,
    id: "T-001",
    observation: observed.observation.event.id,
    action: "rotate",
    reason: "Continue the installed fixture in a fresh root",
    evidence: ["package-smoke:v0.9-budget-rotation"],
  }, { clock: () => new Date(endMs + 3_000).toISOString() });
  if (decided.decision.action !== "rotate") throw new Error("Installed v0.9 budget decision was not preserved.");

  const prepared = await orchestrationModule.prepareProjectRotation({ directory }, {
    clock: () => new Date(endMs + 4_000).toISOString(),
    usageCollector,
  });
  const preparedCanonical = await orchestrationModule.readOrchestration(directory);
  const preparedEvent = preparedCanonical.events.at(-1);
  if (!preparedEvent || preparedEvent.id !== prepared.recommendation.event.id) {
    throw new Error("Installed v0.9 rotation prepare did not bind the canonical event.");
  }
  const newRootCreatedAt = new Date(Date.parse(preparedEvent.timestamp) + 1_000).toISOString();
  const verified = await orchestrationModule.verifyProjectRotation({
    directory,
    recommendation: prepared.recommendation.event.id,
    rootSessionId: "thread:package-smoke-next",
  }, {
    clock: () => new Date(Date.parse(preparedEvent.timestamp) + 2_000).toISOString(),
    usageSessionResolver: async () => ({
      threadId: "thread:package-smoke-next",
      cwd: directory,
      createdAt: newRootCreatedAt,
      warnings: [],
      diagnostics: { fixture: "v0.9-production" },
    }),
  });
  const replacement = await orchestrationModule.setTaskBudgetPolicy({
    directory,
    id: "T-001",
    rootSessionId: verified.verification.newRootSessionId,
    startEvent: verified.verification.event.id,
    hardTotalTokens: 100,
    reason: "Bind the verified installed fixture phase",
    evidence: ["package-smoke:v0.9-verified-root"],
    replace: true,
  }, { clock: () => new Date(Date.parse(preparedEvent.timestamp) + 3_000).toISOString() });
  if (
    verified.verification.newRootSessionId !== "thread:package-smoke-next"
    || replacement.policy.revision !== postResetPolicy.policy.revision + 1
    || replacement.task.budget?.thresholdStatus !== "within"
    || replacement.task.budget?.observations.length !== 1
    || replacement.task.budget?.decisions.length !== 1
  ) {
    throw new Error("Installed v0.9 rotation/budget handshake did not close exactly.");
  }
}

try {
  const packOutput = run(
    npmExecutable,
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    { cwd: repositoryRoot, capture: true },
  );
  const packJsonStart = packOutput.search(/^\[/m);
  if (packJsonStart < 0) throw new Error("npm pack did not emit its JSON result.");
  const packResults = parseJson(packOutput.slice(packJsonStart));
  const packResult = Array.isArray(packResults) ? packResults[0] : undefined;
  if (!isRecord(packResult) || typeof packResult.filename !== "string" || !Array.isArray(packResult.files)) {
    throw new Error("npm pack returned an invalid JSON result.");
  }
  const filename = packResult.filename;
  const shippedPaths = packResult.files
    .filter(isRecord)
    .map(file => file.path)
    .filter((filePath): filePath is string => typeof filePath === "string");
  if (
    shippedPaths.some(filePath => filePath.endsWith(".ts") && !filePath.endsWith(".d.ts"))
    || shippedPaths.some(filePath => filePath.startsWith("src/") || filePath.startsWith("test/") || filePath.startsWith("scripts/"))
  ) {
    throw new Error("Packed package contains TypeScript source, tests, or release scripts.");
  }
  if (!shippedPaths.includes("dist/cli.js") || !shippedPaths.includes("bin/synod.js")) {
    throw new Error("Packed package is missing its compiled CLI or executable shim.");
  }
  const tarballPath = path.join(temporaryDirectory, filename);
  runtimePackageSpec = tarballPath;

  const repositoryPackage = jsonRecord(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"), "repository package");
  const expectedVersion = repositoryPackage.version;
  const packageManager = repositoryPackage.packageManager;
  if (typeof expectedVersion !== "string" || typeof packageManager !== "string") {
    throw new Error("Repository package version or package manager is invalid.");
  }

  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({ private: true, packageManager })}\n`,
  );
  run(
    npmExecutable,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: consumerDirectory },
  );

  const installedVersion = run(synodExecutable, ["--version"], {
    cwd: consumerDirectory,
    capture: true,
  });

  if (installedVersion !== expectedVersion) {
    throw new Error(`Expected version ${expectedVersion}, received ${installedVersion}.`);
  }

  const v07Directory = path.join(consumerDirectory, "v0.7-project");
  mkdirSync(v07Directory, { recursive: true });
  const releasedEnvironment = { ...process.env };
  delete releasedEnvironment.SYNOD_RUNTIME_PACKAGE_SPEC;
  const v07InitOutput = run(
    pnpmExecutable,
    ["--silent", "dlx", "@ivand890/synod@0.7.0", "init", v07Directory, "--profile", "portable", "--json"],
    { cwd: consumerDirectory, capture: true, env: releasedEnvironment },
  );
  if (jsonRecord(v07InitOutput, "v0.7 init envelope").ok !== true) {
    throw new Error(`Released v0.7 package failed to initialize its upgrade fixture: ${v07InitOutput}`);
  }
  const v08UpgradeOutput = runSynodDlx(["upgrade", v07Directory, "--profile", "portable", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const v08UpgradeEnvelope = jsonRecord(v08UpgradeOutput, "v0.8 upgrade envelope");
  const v08UpgradeData = nestedRecord(v08UpgradeEnvelope, "data", "v0.8 upgrade envelope");
  const upgradedManifest = jsonRecord(
    readFileSync(path.join(v07Directory, ".synod", "manifest.json"), "utf8"),
    "upgraded v0.8 manifest",
  );
  const upgradedRuntime = jsonRecord(
    readFileSync(path.join(v07Directory, ".synod", "runtime.json"), "utf8"),
    "upgraded v0.8 runtime",
  );
  const upgradedState = jsonRecord(
    readFileSync(path.join(v07Directory, ".synod", "state.json"), "utf8"),
    "upgraded v0.8 orchestration state",
  );
  const upgradedLeaseBaselines = jsonRecord(
    readFileSync(path.join(v07Directory, ".synod", "lease-baselines.json"), "utf8"),
    "upgraded v0.8 lease baselines",
  );
  const upgradedWorktrees = jsonRecord(
    readFileSync(path.join(v07Directory, ".synod", "task-worktrees.json"), "utf8"),
    "upgraded v0.8 task worktrees",
  );
  if (
    v08UpgradeEnvelope.ok !== true
    || v08UpgradeData.templateVersion !== expectedVersion
    || upgradedManifest.templateVersion !== expectedVersion
    || upgradedRuntime.runtimeVersion !== expectedVersion
    || upgradedState.schemaVersion !== 4
    || upgradedLeaseBaselines.schemaVersion !== 1
    || upgradedWorktrees.schemaVersion !== 1
  ) {
    throw new Error(`Released v0.7 project did not upgrade completely to ${expectedVersion}: ${v08UpgradeOutput}`);
  }
  const downgrade = runResult(
    pnpmExecutable,
    ["--silent", "dlx", "@ivand890/synod@0.7.0", "upgrade", v07Directory, "--profile", "portable", "--json"],
    { cwd: consumerDirectory, env: releasedEnvironment },
  );
  const downgradeEnvelope = jsonRecord(downgrade.stdout, "v0.7 downgrade rejection envelope");
  const downgradeError = nestedRecord(downgradeEnvelope, "error", "v0.7 downgrade rejection envelope");
  if (downgrade.status === 0 || downgradeEnvelope.ok !== false || downgradeError.code !== "SYNOD_DOWNGRADE_UNSUPPORTED") {
    throw new Error(`Released v0.7 CLI did not reject a v0.8 downgrade: ${downgrade.stdout}${downgrade.stderr}`);
  }

  const initOutput = runSynodDlx(["init", targetDirectory, "--profile", "portable", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const envelope = jsonRecord(initOutput, "init envelope");
  const initData = nestedRecord(envelope, "data", "init envelope");
  if (
    envelope.schemaVersion !== 1
    || envelope.ok !== true
    || envelope.command !== "init"
    || initData.runtimeVersion !== expectedVersion
    || initData.runtimeAction !== "install"
  ) {
    throw new Error(`Installed CLI returned an invalid JSON contract: ${initOutput}`);
  }
  const runtimeDescriptor = jsonRecord(readFileSync(path.join(targetDirectory, ".synod", "runtime.json"), "utf8"), "runtime descriptor");
  const localPackage = jsonRecord(readFileSync(path.join(
    targetDirectory,
    ".synod",
    "runtime",
    "node_modules",
    "@ivand890",
    "synod",
    "package.json",
  ), "utf8"), "local runtime package");
  if (
    runtimeDescriptor.runtimeVersion !== expectedVersion
    || runtimeDescriptor.packageSpec !== tarballPath
    || runtimeDescriptor.packageManager !== "pnpm"
    || localPackage.version !== expectedVersion
    || !existsSync(path.join(targetDirectory, ".synod", "runtime", "pnpm-lock.yaml"))
    || readFileSync(path.join(targetDirectory, ".synod", "runtime", ".gitignore"), "utf8") !== "node_modules/\n"
  ) {
    throw new Error("Init did not pin the installed package as the project-local Synod runtime.");
  }
  if (
    existsSync(path.join(installedPackageRoot, "src"))
    || existsSync(path.join(installedPackageRoot, "tsconfig.json"))
    || !existsSync(path.join(installedPackageRoot, "dist", "cli.js"))
  ) {
    throw new Error("Installed package did not preserve the compiled-only runtime shape.");
  }
  const deepImportVersion = run(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { compareVersions } from '@ivand890/synod/src/compatibility.js'; process.stdout.write(String(compareVersions('1.0.0', '0.9.0')));"
  ], { cwd: consumerDirectory, capture: true });
  if (deepImportVersion !== "1") throw new Error("Legacy source deep imports no longer resolve to compiled output.");
  const waitDrill = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { waitForThreads } from '@ivand890/synod/src/wait.js';
const active = { threadId: 'thread:package', status: { type: 'active', activeFlags: [] } };
const idle = { threadId: 'thread:package', status: { type: 'idle' } };
let notificationReads = 0;
let listener;
const notification = await waitForThreads({ threadIds: ['thread:package'], timeoutMs: 100 }, { adapterFactory: () => ({
  async start() {}, capabilities: () => ({ notification: true, cursor: false }),
  async read() { if (notificationReads++ === 0) { queueMicrotask(() => listener(idle)); return { statuses: [active] }; } return { statuses: [idle] }; },
  subscribe(next) { listener = next; return () => {}; }, async close() {}, getWarnings: () => [], getDiagnostics: () => ({ installed: true })
}) });
let pollReads = 0;
const poll = await waitForThreads({ threadIds: ['thread:package'], timeoutMs: 100, pollIntervalMs: 1 }, { adapterFactory: () => ({
  async start() {}, capabilities: () => ({ notification: false, cursor: false }),
  async read() { return { statuses: [pollReads++ === 0 ? active : idle] }; }, async close() {}, getWarnings: () => [], getDiagnostics: () => ({ installed: true })
}) });
let hostClientCreated = false;
const host = await waitForThreads({ threadIds: ['thread:desktop'] }, {
  runtimeResolver: () => ({ surface: 'desktop', executable: '/tmp/codex-desktop', executableSource: 'test', resolved: true }),
  clientFactory: () => { hostClientCreated = true; throw new Error('Desktop host handoff must not create a child client'); }
});
if (notification.mode !== 'notification' || notification.waitAuthority !== 'appServer' || notification.wakeCount !== 1 || notification.incomplete || poll.mode !== 'poll' || poll.waitAuthority !== 'appServer' || poll.fallbackPollCount !== 1 || poll.incomplete || hostClientCreated || host.mode !== 'handoff' || host.waitAuthority !== 'host' || !host.incomplete || !host.hostWaitRequired || host.hostWaitThreadIds.join(',') !== 'thread:desktop') process.exit(2);
process.stdout.write(JSON.stringify({ notification: notification.mode, fallbackPolls: poll.fallbackPollCount, hostAuthority: host.waitAuthority, hostMode: host.mode, hostWaitThreadIds: host.hostWaitThreadIds }));`,
  ], { cwd: consumerDirectory, capture: true });
  const waitDrillResult = jsonRecord(waitDrill, "installed wait drill");
  if (waitDrillResult.notification !== "notification" || waitDrillResult.fallbackPolls !== 1 || waitDrillResult.hostAuthority !== "host" || waitDrillResult.hostMode !== "handoff" || !Array.isArray(waitDrillResult.hostWaitThreadIds) || waitDrillResult.hostWaitThreadIds.join(",") !== "thread:desktop") {
    throw new Error(`Installed wait drill returned invalid observability: ${waitDrill}`);
  }
  const jobsDrill = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { validateJobHandle, validateJobEventSequence } from '@ivand890/synod/src/jobs.js';
const handle = {
  schemaVersion: 1,
  kind: 'task',
  jobId: 'job:package',
  registeredAt: '2026-08-14T17:01:00.000Z',
  waitAuthority: 'appServer',
  threadId: 'thread:package',
  taskId: 'T-PACKAGE-JOB',
  taskRevision: 0,
  leaseId: 'lease:package',
  leaseGeneration: 1,
  ownerThread: 'thread:package'
};
const event = (sequence, eventId, previousEventId, observedAt, sourceTimestamp, status, outcome) => ({
  schemaVersion: 1,
  jobId: handle.jobId,
  kind: 'task',
  threadId: handle.threadId,
  taskId: handle.taskId,
  taskRevision: handle.taskRevision,
  leaseId: handle.leaseId,
  leaseGeneration: handle.leaseGeneration,
  ownerThread: handle.ownerThread,
  observation: { sequence, eventId, previousEventId },
  observedAt,
  sourceTimestamp,
  status,
  outcome,
  waitAuthority: 'appServer',
  provenance: { authority: 'appServer', sourceId: 'server:package', transport: 'poll' }
});
const events = [
  event(1, 'event:package:1', null, '2026-08-14T17:01:01.000Z', '2026-08-14T17:01:00.500Z', { type: 'active', activeFlags: [] }, 'active'),
  event(2, 'event:package:2', 'event:package:1', '2026-08-14T17:01:02.000Z', null, { type: 'idle' }, 'quiescent')
];
validateJobHandle(JSON.parse(JSON.stringify(handle)));
const validated = validateJobEventSequence(handle, JSON.parse(JSON.stringify(events)));
let rejectedExtra = false;
try { validateJobHandle({ ...handle, unexpected: true }); } catch { rejectedExtra = true; }
if (validated.length !== 2 || validated[1].outcome !== 'quiescent' || !rejectedExtra) process.exit(2);
process.stdout.write(JSON.stringify({ events: validated.length, rejectedExtra }));`,
  ], { cwd: consumerDirectory, capture: true });
  const jobsDrillResult = jsonRecord(jobsDrill, "installed jobs drill");
  if (jobsDrillResult.events !== 2 || jobsDrillResult.rejectedExtra !== true) {
    throw new Error(`Installed jobs contract deep import returned invalid validation: ${jobsDrill}`);
  }
  rmSync(path.join(targetDirectory, ".synod", "runtime", "node_modules"), { recursive: true });
  const delegatedVersion = runSynod(["--version"], { cwd: targetDirectory, capture: true });
  if (
    delegatedVersion !== expectedVersion
    || !existsSync(path.join(targetDirectory, ".synod", "runtime", "node_modules", "@ivand890", "synod"))
  ) {
    throw new Error(`Global entry point did not restore and delegate to local Synod ${expectedVersion}.`);
  }
  const checkOutput = runSynod(["check", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const checkEnvelope = jsonRecord(checkOutput, "check envelope");
  const checkData = nestedRecord(checkEnvelope, "data", "check envelope");
  if (
    checkEnvelope.ok !== true
    || checkData.healthy !== true
    || checkData.runtimeVersion !== expectedVersion
    || !Array.isArray(checkData.checks)
    || !checkData.checks.some(item => isRecord(item) && item.path === ".synod/runtime" && item.status === "ready")
    || !checkData.checks.some(item => isRecord(item) && item.path === ".synod/proposals" && item.status === "valid")
    || !checkData.checks.some(item => isRecord(item) && item.path === ".synod/task-worktrees" && item.status === "valid")
  ) {
    throw new Error(`Installed CLI failed its project check: ${checkOutput}`);
  }

  const divergentManifestPath = path.join(targetDirectory, ".synod", "manifest.json");
  const divergentStatePath = path.join(targetDirectory, ".synod", "state.json");
  const divergentRuntimePath = path.join(targetDirectory, ".synod", "runtime.json");
  const divergentManifestContent = readFileSync(divergentManifestPath, "utf8");
  const divergentManifest = jsonRecord(readFileSync(divergentManifestPath, "utf8"), "divergent manifest");
  const divergentState = jsonRecord(readFileSync(divergentStatePath, "utf8"), "divergent state");
  const divergentRuntimeContent = readFileSync(divergentRuntimePath, "utf8");
  const divergentRuntime = jsonRecord(divergentRuntimeContent, "divergent runtime");
  const installedTemplateVersion = expectedVersion === "0.9.3" ? "0.9.2" : "0.0.1";
  const divergentRuntimeVersion = expectedVersion === "0.9.3" ? "0.9.4" : "0.0.2";
  try {
    divergentManifest.templateVersion = installedTemplateVersion;
    divergentRuntime.runtimeVersion = divergentRuntimeVersion;
    writeFileSync(divergentManifestPath, `${JSON.stringify(divergentManifest, null, 2)}\n`);
    writeFileSync(divergentRuntimePath, `${JSON.stringify(divergentRuntime, null, 2)}\n`);
    const directCliModule = pathToFileURL(path.join(installedPackageRoot, "dist", "cli.js")).href;
    const runInstalledCliDirect = (args: string[]): RunResult => runResult(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { run } from ${JSON.stringify(directCliModule)}; process.exitCode = await run(${JSON.stringify(args)});`
    ], { cwd: consumerDirectory, capture: true });
    const divergentCheckResult = runInstalledCliDirect(["check", targetDirectory, "--json"]);
    const divergentCheckOutput = divergentCheckResult.stdout;
    const divergentCheckEnvelope = jsonRecord(divergentCheckOutput, "divergent check envelope");
    const divergentCheckContainer = nestedRecord(
      divergentCheckEnvelope,
      divergentCheckEnvelope.ok === true ? "data" : "error",
      "divergent check envelope",
    );
    const divergentCheckData = divergentCheckEnvelope.ok === true
      ? divergentCheckContainer
      : nestedRecord(divergentCheckContainer, "details", "divergent check error");
    if (
      typeof divergentCheckEnvelope.ok !== "boolean"
      || divergentCheckData.runtimeVersion !== divergentRuntimeVersion
      || divergentCheckData.installedTemplateVersion !== installedTemplateVersion
      || divergentCheckData.stateTemplateVersion !== divergentState.templateVersion
      || divergentCheckData.templateVersion !== installedTemplateVersion
      || divergentCheckData.upgradeAvailable !== true
    ) {
      throw new Error(`Installed CLI lost divergent project version truth: ${divergentCheckOutput}`);
    }
    const divergentStatusResult = runInstalledCliDirect(["status", targetDirectory, "--json", "--view", "summary"]);
    const divergentStatusOutput = divergentStatusResult.stdout;
    const divergentStatusEnvelope = jsonRecord(divergentStatusOutput, "divergent status envelope");
    const divergentStatusContainer = nestedRecord(
      divergentStatusEnvelope,
      divergentStatusEnvelope.ok === true ? "data" : "error",
      "divergent status envelope",
    );
    const divergentStatusData = divergentStatusEnvelope.ok === true
      ? divergentStatusContainer
      : nestedRecord(divergentStatusContainer, "details", "divergent status error");
    if (
      typeof divergentStatusEnvelope.ok !== "boolean"
      || divergentStatusData.runtimeVersion !== divergentRuntimeVersion
      || divergentStatusData.installedTemplateVersion !== installedTemplateVersion
      || divergentStatusData.stateTemplateVersion !== divergentState.templateVersion
      || divergentStatusData.templateVersion !== divergentState.templateVersion
    ) {
      throw new Error(`Installed CLI status did not preserve divergent project version truth: ${divergentStatusOutput}`);
    }
  } finally {
    writeFileSync(divergentManifestPath, divergentManifestContent);
    writeFileSync(divergentRuntimePath, divergentRuntimeContent);
  }
  writeFileSync(path.join(targetDirectory, "package-recovery.txt"), "base\n");
  writeFileSync(path.join(targetDirectory, "package-worktree.txt"), "base\n");
  writeFileSync(path.join(targetDirectory, "package-reservation.txt"), "base\n");
  run("git", ["-C", targetDirectory, "init"]);
  run("git", ["-C", targetDirectory, "config", "user.name", "Synod Package Smoke"]);
  run("git", ["-C", targetDirectory, "config", "user.email", "synod@example.invalid"]);
  run("git", ["-C", targetDirectory, "config", "commit.gpgsign", "false"]);
  run("git", ["-C", targetDirectory, "add", "."]);
  run("git", ["-C", targetDirectory, "commit", "-m", "package smoke base"]);

  addReadyTask(targetDirectory, "T-RESERVE-BIND");
  const reservationOutput = runSynod([
    "lease", "reserve", "T-RESERVE-BIND", "--write", "package-reservation.txt",
    "--reservation-ttl-seconds", "300", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const reservationData = nestedRecord(jsonRecord(reservationOutput, "reservation envelope"), "data", "reservation envelope");
  const reservation = nestedRecord(reservationData, "reservation", "reservation envelope.data");
  if (reservationData.writeAuthorized !== false) {
    throw new Error(`Installed reservation granted premature write authority: ${reservationOutput}`);
  }
  const boundOutput = runSynod([
    "lease", "bind", "T-RESERVE-BIND", ...exactReservationFence(reservation),
    "--owner-thread", "thread:simulated-spawn", "--ttl-seconds", "300", "--heartbeat-seconds", "60",
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const boundData = nestedRecord(jsonRecord(boundOutput, "bind envelope"), "data", "bind envelope");
  const boundLease = nestedRecord(boundData, "lease", "bind envelope.data");
  const boundTask = nestedRecord(boundData, "task", "bind envelope.data");
  const activation = nestedRecord(boundData, "activation", "bind envelope.data");
  const activationEvent = nestedRecord(activation, "event", "bind envelope.data.activation");
  const activationNotification = nestedRecord(activation, "supervisorNotification", "bind envelope.data.activation");
  const activationFollowUp = nestedRecord(activation, "followUp", "bind envelope.data.activation");
  const activationArguments = nestedRecord(activationFollowUp, "arguments", "bind envelope.data.activation.followUp");
  const boundLastEvent = nestedRecord(boundData, "lastEvent", "bind envelope.data");
  if (
    boundData.writeAuthorized !== true
    || boundTask.state !== "ACTIVE"
    || boundLease.id !== reservation.id
    || boundLease.ownerThread !== "thread:simulated-spawn"
    || activation.taskId !== "T-RESERVE-BIND"
    || activation.revision !== boundTask.revision
    || activation.leaseId !== boundLease.id
    || activation.generation !== boundLease.generation
    || activation.ownerThread !== boundLease.ownerThread
    || activation.boundAt !== boundLease.acquiredAt
    || activation.writeAuthorized !== true
    || activationNotification.status !== "required-not-observed"
    || activationEvent.sequence !== boundLastEvent.sequence
    || activationEvent.id !== boundLastEvent.id
    || activationEvent.hash !== boundLastEvent.hash
    || activationFollowUp.operation !== "wait"
    || !Array.isArray(activationArguments.taskIds)
    || activationArguments.taskIds.length !== 1
    || activationArguments.taskIds[0] !== "T-RESERVE-BIND"
    || !Array.isArray(activationFollowUp.requirements)
    || boundOutput.includes(String(reservation.token))
  ) {
    throw new Error(`Installed reservation did not bind atomically: ${boundOutput}`);
  }
  writeFileSync(path.join(targetDirectory, "package-reservation.txt"), "written only after bind\n");
  const reservedDeliveryOutput = runSynod([
    "task", "transition", "T-RESERVE-BIND", "REVIEW", "--revision", "1",
    "--evidence", "package-smoke:reserved-bound-delivery", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const reservedDeliveryData = nestedRecord(jsonRecord(reservedDeliveryOutput, "reserved delivery envelope"), "data", "reserved delivery envelope");
  const reservedReviewTask = nestedRecord(reservedDeliveryData, "task", "reserved delivery envelope.data");
  if (reservedReviewTask.state !== "REVIEW" || "lease" in reservedReviewTask || "leaseReservation" in reservedReviewTask) {
    throw new Error(`Installed reserved delivery did not clean up ownership: ${reservedDeliveryOutput}`);
  }

  addReadyTask(targetDirectory, "T-RESERVE-CANCEL");
  const cancelledReservationOutput = runSynod([
    "lease", "reserve", "T-RESERVE-CANCEL", "--write-tree", "cancelled-spawn",
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const cancelledReservationData = nestedRecord(jsonRecord(cancelledReservationOutput, "cancel reservation envelope"), "data", "cancel reservation envelope");
  const cancelledReservation = nestedRecord(cancelledReservationData, "reservation", "cancel reservation envelope.data");
  const cancelOutput = runSynod([
    "lease", "cancel", "T-RESERVE-CANCEL", ...exactReservationFence(cancelledReservation),
    "--reason", "simulated spawn failed", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const cancelData = nestedRecord(jsonRecord(cancelOutput, "reservation cancel envelope"), "data", "reservation cancel envelope");
  const cancelledTask = nestedRecord(cancelData, "task", "reservation cancel envelope.data");
  if (cancelData.writeAuthorized !== false || cancelledTask.state !== "READY" || "recovery" in cancelledTask) {
    throw new Error(`Installed reservation cancellation created false execution state: ${cancelOutput}`);
  }

  addReadyTask(targetDirectory, "T-CONCURRENT-A");
  addReadyTask(targetDirectory, "T-CONCURRENT-B");
  const concurrentCommands = [
    [
      "lease", "acquire", "T-CONCURRENT-A", "--owner-thread", "thread:concurrent-a",
      "--write-tree", "concurrent", "--cwd", targetDirectory, "--json",
    ],
    [
      "lease", "acquire", "T-CONCURRENT-B", "--owner-thread", "thread:concurrent-b",
      "--write-tree", "concurrent", "--cwd", targetDirectory, "--json",
    ],
  ];
  const concurrentResults = await Promise.all(concurrentCommands.map(command =>
    runSynodAsync(command, { cwd: consumerDirectory })));
  const successfulAcquire = concurrentResults.find(result => result.status === 0);
  const initialRejectedIndex = concurrentResults.findIndex(result => result.status !== 0);
  let rejectedAcquire = initialRejectedIndex >= 0 ? concurrentResults[initialRejectedIndex] : undefined;
  if (!successfulAcquire || !rejectedAcquire) {
    throw new Error(`Concurrent writers did not produce exactly one winner: ${JSON.stringify(concurrentResults)}`);
  }
  const successfulAcquireEnvelope = jsonRecord(successfulAcquire.stdout, "concurrent lease winner envelope");
  const successfulAcquireData = nestedRecord(successfulAcquireEnvelope, "data", "concurrent lease winner envelope");
  const successfulLease = nestedRecord(successfulAcquireData, "lease", "concurrent lease winner envelope.data");
  let rejectedAcquireEnvelope = jsonRecord(rejectedAcquire.stdout, "concurrent lease rejection envelope");
  let rejectedAcquireError = nestedRecord(rejectedAcquireEnvelope, "error", "concurrent lease rejection envelope");
  if (rejectedAcquireError.code === "SYNOD_ORCHESTRATION_LOCKED") {
    rejectedAcquire = runSynodResult(concurrentCommands[initialRejectedIndex]!, { cwd: consumerDirectory });
    rejectedAcquireEnvelope = jsonRecord(rejectedAcquire.stdout, "serialized concurrent lease rejection envelope");
    rejectedAcquireError = nestedRecord(rejectedAcquireEnvelope, "error", "serialized concurrent lease rejection envelope");
  }
  if (successfulAcquireEnvelope.ok !== true || rejectedAcquireError.code !== "SYNOD_LEASE_CONFLICT") {
    throw new Error(`Concurrent writer fencing returned an invalid result: ${JSON.stringify(concurrentResults)}`);
  }
  const winningTask = successfulAcquireData.task;
  if (!isRecord(winningTask) || typeof winningTask.id !== "string") throw new Error("Concurrent lease winner omitted its task.");
  runSynod([
    "lease", "release", winningTask.id,
    ...exactFence(successfulLease),
    "--cwd", targetDirectory,
    "--json",
  ], { cwd: consumerDirectory, capture: true });

  addReadyTask(targetDirectory, "T-WORKTREE");
  const worktreeAcquireOutput = runSynod([
    "lease", "acquire", "T-WORKTREE", "--owner-thread", "thread:worktree",
    "--write", "package-worktree.txt", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const worktreeAcquireData = nestedRecord(jsonRecord(worktreeAcquireOutput, "worktree lease envelope"), "data", "worktree lease envelope");
  const worktreeLease = nestedRecord(worktreeAcquireData, "lease", "worktree lease envelope.data");
  const taskWorktreeDirectory = path.join(consumerDirectory, "task-worktree");
  const worktreeCreateOutput = runSynod([
    "worktree", "create", "T-WORKTREE", "--destination", taskWorktreeDirectory,
    ...exactFence(worktreeLease), "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  if (jsonRecord(worktreeCreateOutput, "worktree create envelope").ok !== true) {
    throw new Error(`Installed worktree creation failed: ${worktreeCreateOutput}`);
  }
  runSynod([
    "task", "transition", "T-WORKTREE", "ACTIVE", "--revision", "0",
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  writeFileSync(path.join(taskWorktreeDirectory, "package-worktree.txt"), "integrated by installed package\n");
  const worktreeSealOutput = runSynod([
    "worktree", "seal", "T-WORKTREE", ...exactFence(worktreeLease),
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  if (jsonRecord(worktreeSealOutput, "worktree seal envelope").ok !== true) {
    throw new Error(`Installed worktree sealing failed: ${worktreeSealOutput}`);
  }
  const worktreeIntegrateOutput = runSynod([
    "worktree", "integrate", "T-WORKTREE", ...exactFence(worktreeLease),
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  if (
    jsonRecord(worktreeIntegrateOutput, "worktree integrate envelope").ok !== true
    || readFileSync(path.join(targetDirectory, "package-worktree.txt"), "utf8") !== "integrated by installed package\n"
  ) {
    throw new Error(`Installed worktree integration failed: ${worktreeIntegrateOutput}`);
  }
  runSynod([
    "task", "transition", "T-WORKTREE", "REVIEW", "--revision", "1",
    "--evidence", "package-smoke:worktree-integrated", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  run("git", ["-C", taskWorktreeDirectory, "reset", "--hard", "HEAD"]);
  const worktreeCleanupOutput = runSynod([
    "worktree", "cleanup", "T-WORKTREE", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  if (
    jsonRecord(worktreeCleanupOutput, "worktree cleanup envelope").ok !== true
    || existsSync(taskWorktreeDirectory)
    || !existsSync(path.join(targetDirectory, ".synod", "worktree-proposals"))
  ) {
    throw new Error(`Installed worktree cleanup failed or removed durable proposals: ${worktreeCleanupOutput}`);
  }
  runSynod([
    "task", "transition", "T-WORKTREE", "ACCEPTED", "--revision", "1",
    "--evidence", "package-smoke:accepted", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  runSynod([
    "task", "transition", "T-WORKTREE", "VERIFIED", "--revision", "1",
    "--evidence", "package-smoke:verified", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  runSynod([
    "task", "transition", "T-WORKTREE", "DONE", "--revision", "1",
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });

  addReadyTask(targetDirectory, "T-RECOVER");
  const recoveryAcquireOutput = runSynod([
    "lease", "acquire", "T-RECOVER", "--owner-thread", "thread:killed-worker",
    "--write", "package-recovery.txt", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const recoveryAcquireData = nestedRecord(jsonRecord(recoveryAcquireOutput, "recovery lease envelope"), "data", "recovery lease envelope");
  const recoveryLease = nestedRecord(recoveryAcquireData, "lease", "recovery lease envelope.data");
  runSynod([
    "task", "transition", "T-RECOVER", "ACTIVE", "--revision", "0",
    "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  writeFileSync(path.join(targetDirectory, "package-recovery.txt"), "abandoned worker proposal\n");
  const endedFence = exactFence(recoveryLease).slice(0, -2);
  const recoveryRevokeOutput = runSynod([
    "lease", "revoke", "T-RECOVER", ...endedFence,
    "--reason", "installed worker was killed", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const recoveryRevokeData = nestedRecord(jsonRecord(recoveryRevokeOutput, "recovery revoke envelope"), "data", "recovery revoke envelope");
  const revokedTask = nestedRecord(recoveryRevokeData, "task", "recovery revoke envelope.data");
  const revokedRecovery = nestedRecord(revokedTask, "recovery", "recovery revoke envelope.data.task");
  if (revokedRecovery.status !== "PENDING") throw new Error(`Killed-worker revocation did not enter recovery: ${recoveryRevokeOutput}`);
  const recoveryOutput = runSynod([
    "lease", "recover", "T-RECOVER", ...endedFence,
    "--decision", "reassign", "--owner-thread", "thread:replacement",
    "--reason", "continue preserved installed proposal", "--cwd", targetDirectory, "--json",
  ], { cwd: consumerDirectory, capture: true });
  const recoveryData = nestedRecord(jsonRecord(recoveryOutput, "recovery envelope"), "data", "recovery envelope");
  const replacementLease = nestedRecord(recoveryData, "lease", "recovery envelope.data");
  const recoveredTask = nestedRecord(recoveryData, "task", "recovery envelope.data");
  const recoveredRecovery = nestedRecord(recoveredTask, "recovery", "recovery envelope.data.task");
  const recoveredProposal = nestedRecord(recoveredRecovery, "proposal", "recovery envelope.data.task.recovery");
  if (
    replacementLease.generation !== 2
    || replacementLease.ownerThread !== "thread:replacement"
    || recoveredRecovery.status !== "REASSIGNED"
    || typeof recoveredProposal.bundleId !== "string"
  ) {
    throw new Error(`Installed killed-worker recovery did not preserve and reassign the proposal: ${recoveryOutput}`);
  }
  writeFileSync(path.join(targetDirectory, "package-recovery.txt"), "acknowledged dirty bytes\n");
  const checkpointOutput = runSynod(["checkpoint", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const checkpointEnvelope = jsonRecord(checkpointOutput, "checkpoint envelope");
  if (checkpointEnvelope.ok !== true) throw new Error(`Installed CLI failed its checkpoint smoke: ${checkpointOutput}`);
  const bundleDirectory = path.join(consumerDirectory, "package-recovery.bundle");
  const exportOutput = runSynod(["bundle", "export", bundleDirectory, "--cwd", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const exportEnvelope = jsonRecord(exportOutput, "bundle export envelope");
  const exportData = nestedRecord(exportEnvelope, "data", "bundle export envelope");
  if (exportEnvelope.ok !== true || exportData.action !== "export" || typeof exportData.bundleId !== "string") {
    throw new Error(`Installed CLI failed its bundle export smoke: ${exportOutput}`);
  }
  const verifyOutput = runSynod(["bundle", "verify", bundleDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const verifyEnvelope = jsonRecord(verifyOutput, "bundle verify envelope");
  const verifyData = nestedRecord(verifyEnvelope, "data", "bundle verify envelope");
  if (verifyEnvelope.ok !== true || verifyData.action !== "verify" || verifyData.bundleId !== exportData.bundleId) {
    throw new Error(`Installed CLI failed its bundle verification smoke: ${verifyOutput}`);
  }
  const restoreDirectory = path.join(consumerDirectory, "restored-project");
  run("git", ["clone", "--no-local", targetDirectory, restoreDirectory]);
  const restoreOutput = runSynod(["bundle", "restore", bundleDirectory, "--cwd", restoreDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const restoreEnvelope = jsonRecord(restoreOutput, "bundle restore envelope");
  const restoreData = nestedRecord(restoreEnvelope, "data", "bundle restore envelope");
  if (
    restoreEnvelope.ok !== true
    || restoreData.action !== "restore"
    || restoreData.bundleId !== exportData.bundleId
    || readFileSync(path.join(restoreDirectory, "package-recovery.txt"), "utf8") !== "acknowledged dirty bytes\n"
  ) {
    throw new Error(`Installed CLI failed its bundle restore smoke: ${restoreOutput}`);
  }
  const handoffOutput = runSynod(["handoff", targetDirectory, "--bundle", bundleDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const handoffEnvelope = jsonRecord(handoffOutput, "handoff envelope");
  const handoffData = nestedRecord(handoffEnvelope, "data", "handoff envelope");
  const handoffCheckpoint = nestedRecord(handoffData, "checkpoint", "handoff envelope.data");
  const handoffDrift = nestedRecord(handoffCheckpoint, "drift", "handoff envelope.data.checkpoint");
  const handoffBundle = nestedRecord(handoffData, "recoveryBundle", "handoff envelope.data");
  const handoffArtifacts = nestedRecord(handoffData, "artifacts", "handoff envelope.data");
  const handoffProposals = nestedRecord(handoffArtifacts, "proposals", "handoff envelope.data.artifacts");
  const handoffWorktrees = nestedRecord(handoffArtifacts, "worktrees", "handoff envelope.data.artifacts");
  if (
    handoffEnvelope.ok !== true
    || handoffDrift.detected !== false
    || handoffBundle.status !== "verified"
    || handoffBundle.bundleId !== exportData.bundleId
    || typeof handoffProposals.verifiedBundles !== "number"
    || handoffWorktrees.records !== 1
    || handoffWorktrees.sealedProposals !== 1
  ) {
    throw new Error(`Installed CLI failed its canonical handoff smoke: ${handoffOutput}`);
  }
  const statusOutput = runSynod(["status", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const statusEnvelope = jsonRecord(statusOutput, "status envelope");
  const statusData = nestedRecord(statusEnvelope, "data", "status envelope");
  const statusArtifacts = nestedRecord(statusData, "artifacts", "status envelope.data");
  const statusProposals = nestedRecord(statusArtifacts, "proposals", "status envelope.data.artifacts");
  const statusWorktrees = nestedRecord(statusArtifacts, "worktrees", "status envelope.data.artifacts");
  if (
    statusEnvelope.ok !== true
    || statusData.healthy !== true
    || typeof statusData.eventCount !== "number"
    || statusData.eventCount < 2
    || typeof statusProposals.verifiedBundles !== "number"
    || statusWorktrees.records !== 1
    || statusWorktrees.sealedProposals !== 1
  ) {
    throw new Error(`Installed CLI returned an invalid orchestration status: ${statusOutput}`);
  }
  const summaryStatusOutput = runSynod(["status", targetDirectory, "--json", "--view", "summary"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const summaryStatusEnvelope = jsonRecord(summaryStatusOutput, "summary status envelope");
  const summaryStatusData = nestedRecord(summaryStatusEnvelope, "data", "summary status envelope");
  const summaryTasks = summaryStatusData.tasks;
  if (
    summaryStatusEnvelope.ok !== true
    || summaryStatusData.healthy !== true
    || typeof summaryStatusData.eventCount !== "number"
    || !Array.isArray(summaryTasks)
    || (summaryTasks.length > 0 && isRecord(summaryTasks[0]) && Object.hasOwn(summaryTasks[0], "evidence"))
    || !isRecord(summaryStatusData.lastEvent)
  ) {
    throw new Error(`Installed CLI returned an invalid summary orchestration status: ${summaryStatusOutput}`);
  }
  const explainedStatusOutput = runSynod(["status", targetDirectory, "--explain", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const explainedStatusEnvelope = jsonRecord(explainedStatusOutput, "explained status envelope");
  const explainedStatusData = nestedRecord(explainedStatusEnvelope, "data", "explained status envelope");
  const delta = nestedRecord(explainedStatusData, "delta", "explained status envelope.data");
  if (explainedStatusEnvelope.ok !== true || delta.changed !== false || !Array.isArray(delta.paths) || delta.paths.length !== 0) {
    throw new Error(`Installed CLI returned an invalid checkpoint delta: ${explainedStatusOutput}`);
  }
  const taskOutput = runSynod([
    "task", "add", "T-001",
    "--objective", "Package smoke task",
    "--executor", "synod_implementer",
    "--acceptance", "Canonical task is persisted",
    "--verification", "synod status",
    "--cwd", targetDirectory,
    "--json",
  ], { cwd: consumerDirectory, capture: true });
  const taskEnvelope = jsonRecord(taskOutput, "task envelope");
  const taskData = nestedRecord(taskEnvelope, "data", "task envelope");
  const task = nestedRecord(taskData, "task", "task envelope.data");
  const taskLastEvent = nestedRecord(taskData, "lastEvent", "task envelope.data");
  if (
    taskEnvelope.ok !== true
    || task.id !== "T-001"
    || typeof taskLastEvent.sequence !== "number"
    || taskLastEvent.sequence < 3
  ) {
    throw new Error(`Installed CLI failed its orchestration task smoke: ${taskOutput}`);
  }
  const budgetOutput = runSynod([
    "budget", "set", "T-001",
    "--session", "thread:package-smoke",
    "--since-event", "1",
    "--hard-tokens", "100",
    "--reason", "Installed budget smoke",
    "--evidence", "package:smoke",
    "--cwd", targetDirectory,
    "--json",
  ], { cwd: consumerDirectory, capture: true });
  const budgetEnvelope = jsonRecord(budgetOutput, "budget envelope");
  const budgetData = nestedRecord(budgetEnvelope, "data", "budget envelope");
  const budgetPolicy = nestedRecord(budgetData, "policy", "budget envelope.data");
  if (budgetEnvelope.ok !== true || budgetData.action !== "set" || budgetPolicy.revision !== 1) {
    throw new Error(`Installed CLI failed its task-budget smoke: ${budgetOutput}`);
  }
  const rotationOutput = runSynod([
    "rotation", "set",
    "--session", "thread:package-smoke",
    "--since-event", "1",
    "--compactions", "2",
    "--reason", "Installed rotation smoke",
    "--evidence", "package:smoke",
    "--cwd", targetDirectory,
    "--json",
  ], { cwd: consumerDirectory, capture: true });
  const rotationEnvelope = jsonRecord(rotationOutput, "rotation envelope");
  const rotationData = nestedRecord(rotationEnvelope, "data", "rotation envelope");
  const rotationPolicy = nestedRecord(rotationData, "policy", "rotation envelope.data");
  if (rotationEnvelope.ok !== true || rotationData.action !== "set" || rotationPolicy.revision !== 1) {
    throw new Error(`Installed CLI failed its phase-rotation smoke: ${rotationOutput}`);
  }
  await runV09ProductionFixture(targetDirectory, consumerDirectory);
  const upgradeOutput = runSynod(["upgrade", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const upgradeEnvelope = jsonRecord(upgradeOutput, "upgrade envelope");
  const upgradeData = nestedRecord(upgradeEnvelope, "data", "upgrade envelope");
  if (upgradeEnvelope.ok !== true || !Array.isArray(upgradeData.conflicts) || upgradeData.conflicts.length !== 0) {
    throw new Error(`Installed CLI returned an invalid upgrade plan: ${upgradeOutput}`);
  }
  const uninstallOutput = runSynod(["uninstall", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const uninstallEnvelope = jsonRecord(uninstallOutput, "uninstall envelope");
  const uninstallData = nestedRecord(uninstallEnvelope, "data", "uninstall envelope");
  if (
    uninstallEnvelope.ok !== true
    || uninstallData.runtimeVersion !== expectedVersion
    || uninstallData.runtimeAction !== "remove"
    || !Array.isArray(uninstallData.preserved)
    || !uninstallData.preserved.includes("docs/synod/GOAL.md")
    || !uninstallData.preserved.includes(".synod/task-worktrees.json")
    || !uninstallData.preserved.includes(".synod/proposals")
    || !uninstallData.preserved.includes(".synod/worktree-proposals")
  ) {
    throw new Error(`Installed CLI returned an invalid uninstall plan: ${uninstallOutput}`);
  }
  runSynod(["uninstall", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  if (existsSync(path.join(targetDirectory, ".synod", "runtime.json")) || existsSync(path.join(targetDirectory, ".synod", "runtime"))) {
    throw new Error("Uninstall left the project-local Synod runtime behind.");
  }
  if (
    !existsSync(path.join(targetDirectory, ".synod", "task-worktrees.json"))
    || !existsSync(path.join(targetDirectory, ".synod", "proposals"))
    || !existsSync(path.join(targetDirectory, ".synod", "worktree-proposals"))
  ) {
    throw new Error("Uninstall removed v0.8 durable proposal or worktree records.");
  }
  console.log(`Package smoke test passed for @ivand890/synod@${expectedVersion}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
