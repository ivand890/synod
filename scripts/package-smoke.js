import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "synod-package-smoke-"));
const consumerDirectory = path.join(temporaryDirectory, "consumer");
const targetDirectory = path.join(consumerDirectory, "project");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const synodExecutable = path.join(
  consumerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "synod.cmd" : "synod",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
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

try {
  const packOutput = run(
    npmExecutable,
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    { cwd: repositoryRoot, capture: true },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarballPath = path.join(temporaryDirectory, filename);

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

  const initOutput = run(synodExecutable, ["init", targetDirectory, "--profile", "portable", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const envelope = JSON.parse(initOutput);
  if (envelope.schemaVersion !== 1 || envelope.ok !== true || envelope.command !== "init") {
    throw new Error(`Installed CLI returned an invalid JSON contract: ${initOutput}`);
  }
  const checkOutput = run(synodExecutable, ["check", targetDirectory, "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const checkEnvelope = JSON.parse(checkOutput);
  if (checkEnvelope.ok !== true || checkEnvelope.data.healthy !== true) {
    throw new Error(`Installed CLI failed its project check: ${checkOutput}`);
  }
  const upgradeOutput = run(synodExecutable, ["upgrade", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const upgradeEnvelope = JSON.parse(upgradeOutput);
  if (upgradeEnvelope.ok !== true || upgradeEnvelope.data.conflicts.length !== 0) {
    throw new Error(`Installed CLI returned an invalid upgrade plan: ${upgradeOutput}`);
  }
  const uninstallOutput = run(synodExecutable, ["uninstall", targetDirectory, "--dry-run", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const uninstallEnvelope = JSON.parse(uninstallOutput);
  if (uninstallEnvelope.ok !== true || !uninstallEnvelope.data.preserved.includes("docs/synod/GOAL.md")) {
    throw new Error(`Installed CLI returned an invalid uninstall plan: ${uninstallOutput}`);
  }
  console.log(`Package smoke test passed for @ivand890/synod@${expectedVersion}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
