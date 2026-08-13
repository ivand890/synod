import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    || upgradedState.schemaVersion !== 3
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
if (notification.mode !== 'notification' || notification.wakeCount !== 1 || notification.incomplete || poll.mode !== 'poll' || poll.fallbackPollCount !== 1 || poll.incomplete) process.exit(2);
process.stdout.write(JSON.stringify({ notification: notification.mode, fallbackPolls: poll.fallbackPollCount }));`,
  ], { cwd: consumerDirectory, capture: true });
  const waitDrillResult = jsonRecord(waitDrill, "installed wait drill");
  if (waitDrillResult.notification !== "notification" || waitDrillResult.fallbackPolls !== 1) {
    throw new Error(`Installed wait drill returned invalid observability: ${waitDrill}`);
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
  writeFileSync(path.join(targetDirectory, "package-recovery.txt"), "base\n");
  writeFileSync(path.join(targetDirectory, "package-worktree.txt"), "base\n");
  run("git", ["-C", targetDirectory, "init"]);
  run("git", ["-C", targetDirectory, "config", "user.name", "Synod Package Smoke"]);
  run("git", ["-C", targetDirectory, "config", "user.email", "synod@example.invalid"]);
  run("git", ["-C", targetDirectory, "config", "commit.gpgsign", "false"]);
  run("git", ["-C", targetDirectory, "add", "."]);
  run("git", ["-C", targetDirectory, "commit", "-m", "package smoke base"]);

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
    "--hard-tokens", "1000",
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
