import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  ) {
    throw new Error(`Installed CLI failed its project check: ${checkOutput}`);
  }
  const statusOutput = runSynod(["status", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const statusEnvelope = jsonRecord(statusOutput, "status envelope");
  const statusData = nestedRecord(statusEnvelope, "data", "status envelope");
  if (statusEnvelope.ok !== true || statusData.healthy !== true || statusData.eventCount !== 1) {
    throw new Error(`Installed CLI returned an invalid orchestration status: ${statusOutput}`);
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
  if (taskEnvelope.ok !== true || task.id !== "T-001" || taskLastEvent.sequence !== 2) {
    throw new Error(`Installed CLI failed its orchestration task smoke: ${taskOutput}`);
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
  console.log(`Package smoke test passed for @ivand890/synod@${expectedVersion}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
