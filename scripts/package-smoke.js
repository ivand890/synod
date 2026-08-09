import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "synod-package-smoke-"));
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const targetDirectory = path.join(consumerDirectory, "project");
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
let runtimePackageSpec;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stdout}${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.${details}`);
  }

  return result.stdout?.trim();
}

function runSynod(args, options = {}) {
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

function runSynodDlx(args, options = {}) {
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
  const [{ filename }] = JSON.parse(packOutput);
  const tarballPath = path.join(temporaryDirectory, filename);
  runtimePackageSpec = tarballPath;

  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(path.join(consumerDirectory, "package.json"), '{"private":true}\n');
  run(
    npmExecutable,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: consumerDirectory },
  );

  const expectedVersion = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ).version;
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
  const envelope = JSON.parse(initOutput);
  if (
    envelope.schemaVersion !== 1
    || envelope.ok !== true
    || envelope.command !== "init"
    || envelope.data.runtimeVersion !== expectedVersion
    || envelope.data.runtimeAction !== "install"
  ) {
    throw new Error(`Installed CLI returned an invalid JSON contract: ${initOutput}`);
  }
  const runtimeDescriptor = JSON.parse(readFileSync(path.join(targetDirectory, ".synod", "runtime.json"), "utf8"));
  const localPackage = JSON.parse(readFileSync(path.join(
    targetDirectory,
    ".synod",
    "runtime",
    "node_modules",
    "@ivand890",
    "synod",
    "package.json",
  ), "utf8"));
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
  const checkEnvelope = JSON.parse(checkOutput);
  if (
    checkEnvelope.ok !== true
    || checkEnvelope.data.healthy !== true
    || checkEnvelope.data.runtimeVersion !== expectedVersion
    || !checkEnvelope.data.checks.some(item => item.path === ".synod/runtime" && item.status === "ready")
  ) {
    throw new Error(`Installed CLI failed its project check: ${checkOutput}`);
  }
  const statusOutput = runSynod(["status", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const statusEnvelope = JSON.parse(statusOutput);
  if (statusEnvelope.ok !== true || statusEnvelope.data.healthy !== true || statusEnvelope.data.eventCount !== 1) {
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
  const taskEnvelope = JSON.parse(taskOutput);
  if (taskEnvelope.ok !== true || taskEnvelope.data.task.id !== "T-001" || taskEnvelope.data.lastEvent.sequence !== 2) {
    throw new Error(`Installed CLI failed its orchestration task smoke: ${taskOutput}`);
  }
  const upgradeOutput = runSynod(["upgrade", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const upgradeEnvelope = JSON.parse(upgradeOutput);
  if (upgradeEnvelope.ok !== true || upgradeEnvelope.data.conflicts.length !== 0) {
    throw new Error(`Installed CLI returned an invalid upgrade plan: ${upgradeOutput}`);
  }
  const uninstallOutput = runSynod(["uninstall", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const uninstallEnvelope = JSON.parse(uninstallOutput);
  if (
    uninstallEnvelope.ok !== true
    || uninstallEnvelope.data.runtimeVersion !== expectedVersion
    || uninstallEnvelope.data.runtimeAction !== "remove"
    || !uninstallEnvelope.data.preserved.includes("docs/synod/GOAL.md")
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
