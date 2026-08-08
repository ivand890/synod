import process from "node:process";
import { errorEnvelope, successEnvelope } from "./contracts.js";
import { doctorProject } from "./doctor.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "./lifecycle.js";
import { packageVersion } from "./package.js";
import { listProfiles } from "./profiles.js";
import { collectUsage, formatUsageReport } from "./usage.js";

const HELP = `Synod ${packageVersion}

Install and operate a persistent, reviewed advisor loop for Codex projects.

Usage:
  synod init [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod upgrade [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod check [directory] [--json]
  synod doctor [directory] [--json]
  synod uninstall [directory] [--dry-run] [--force] [--json]
  synod profiles [--json]
  synod usage [--session <thread-id>] [--cwd <directory>] [--by-model] [--json]
  synod --help
  synod --version

Commands:
  init        Transactionally install Synod files and an ownership manifest.
  upgrade     Migrate and update a managed project; --dry-run previews the plan.
  check       Verify managed-file hashes, ownership, and local project integrity.
  doctor      Probe Codex version, App Server, model, and reasoning capabilities.
  uninstall   Remove unchanged Synod-owned content and preserve user-owned state.
  profiles    List built-in model profiles and their requirements.
  usage       Report token consumption for a Codex session tree, grouped by model.

Options:
  --profile   Select a built-in model profile for init or upgrade.
  --dry-run   Show the complete lifecycle plan without writing files.
  --force     Replace or remove modified Synod-owned files; never removes user-owned state.
  --session   Select any thread in a session tree. Defaults to the latest session in --cwd.
  --cwd       Select the project directory used to find the latest session.
  --by-model  Group consumption by model (the default and currently supported view).
  --json      Print a versioned machine-readable success, warning, or error envelope.
  -h, --help  Show help.
  -v, --version
              Show the installed version.
`;

function missingValue(option) {
  return new SynodError(ERROR_CODES.MISSING_OPTION_VALUE, `Missing value for ${option}.`, {
    details: { option }
  });
}

function parseLifecycleArgs(args, { allowDryRun = false, allowForce = false, allowProfile = false } = {}) {
  const options = { directory: ".", json: false };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--dry-run" && allowDryRun) options.dryRun = true;
    else if (arg === "--force" && allowForce) options.force = true;
    else if (arg === "--profile" && allowProfile) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw missingValue(arg);
      options.profile = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else if (hasDirectory) {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, {
        details: { argument: arg }
      });
    } else {
      options.directory = arg;
      hasDirectory = true;
    }
  }
  return options;
}

function parseUsageArgs(args) {
  const options = { cwd: process.cwd(), json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--by-model") continue;
    else if (arg === "--session" || arg === "--cwd") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw missingValue(arg);
      options[arg === "--session" ? "threadId" : "cwd"] = value;
      index += 1;
    } else {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    }
  }
  return options;
}

function printWarnings(warnings, output) {
  for (const item of warnings || []) output.warn(`Warning [${item.code}]: ${item.message}`);
}

function printLifecycleResult(command, result, output) {
  const future = result.dryRun ? "Would " : "";
  for (const path of result.created || []) output.log(`${future}create ${path}`);
  for (const path of result.updated || []) output.log(`${future}update ${path}`);
  for (const path of result.removed || []) output.log(`${future}remove ${path}`);
  for (const path of result.preserved || []) output.log(`Preserved ${path}`);
  for (const path of result.unchanged || []) output.log(`Unchanged ${path}`);
  printWarnings(result.warnings, output);
  if (result.conflicts.length > 0) {
    output.error(`Synod ${command} found conflicts and made no changes:`);
    for (const path of result.conflicts) output.error(`  - ${path}`);
    output.error("Resolve the paths or use --force for Synod-owned content.");
    return;
  }
  output.log(`Synod ${result.dryRun ? `${command} plan is valid` : `${command} completed`} in ${result.targetDirectory}`);
}

function textCheck(result) {
  const lines = [`Synod project check: ${result.healthy ? "healthy" : "failed"}`];
  lines.push(`Template: ${result.templateVersion} (manifest schema ${result.manifestSchemaVersion})`);
  lines.push(`Profile: ${result.profile}`);
  for (const item of result.checks) lines.push(`${item.status.padEnd(13)} ${item.ownership.padEnd(6)} ${item.path}`);
  return lines.join("\n");
}

function textDoctor(result) {
  const lines = [`Synod doctor: ${result.healthy ? "healthy" : "attention required"}`];
  lines.push(`Node: ${result.node.version} (${result.node.supported ? "supported" : "unsupported"})`);
  lines.push(`Codex: ${result.codex.version || "unavailable"} (${result.codex.status})`);
  lines.push(`Supported Codex: ${result.codex.range}`);
  lines.push(`Known-good Codex: ${result.codex.knownGood.join(", ")}`);
  lines.push(`Recommended profile: ${result.recommendedProfile || "none"}`);
  for (const profile of result.profiles) lines.push(`Profile ${profile.id}: ${profile.compatible ? "compatible" : "unavailable"}`);
  for (const issue of result.issues) lines.push(`Error [${issue.code}]: ${issue.message}`);
  return lines.join("\n");
}

async function emitLifecycle(command, options, output, action, dependencies) {
  const result = await action(options, dependencies);
  if (options.json) {
    const { warnings, ...data } = result;
    if (result.conflicts.length > 0) {
      const error = new SynodError(
        command === "init" ? ERROR_CODES.INIT_CONFLICT : ERROR_CODES.LIFECYCLE_CONFLICT,
        `Synod ${command} found conflicts and made no changes.`,
        { details: { paths: result.conflicts } }
      );
      output.log(JSON.stringify(errorEnvelope(command, error, { warnings }), null, 2));
      return 1;
    }
    output.log(JSON.stringify(successEnvelope(command, data, { warnings }), null, 2));
  } else {
    printLifecycleResult(command, result, output);
  }
  return result.conflicts.length > 0 ? 1 : 0;
}

export async function run(args, output = console, dependencies = {}) {
  const jsonRequested = args.includes("--json");
  const command = args[0] && !args[0].startsWith("-") ? args[0] : null;
  try {
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
      output.log(HELP);
      return 0;
    }
    if (args[0] === "-v" || args[0] === "--version") {
      output.log(packageVersion);
      return 0;
    }

    if (command === "usage") {
      const options = parseUsageArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      const report = await collectUsage({ ...options, clientFactory: dependencies.clientFactory });
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        output.log(JSON.stringify(successEnvelope("usage", data, { warnings, diagnostics }), null, 2));
      } else {
        output.log(formatUsageReport(report));
        printWarnings(report.warnings, output);
      }
      return 0;
    }

    if (command === "profiles") {
      const options = parseLifecycleArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      if (options.directory !== ".") {
        throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${options.directory}`);
      }
      const profiles = listProfiles();
      if (options.json) output.log(JSON.stringify(successEnvelope("profiles", { profiles }), null, 2));
      else for (const profile of profiles) output.log(`${profile.id}: ${profile.description} (Codex >=${profile.minimumCodexVersion})`);
      return 0;
    }

    if (command === "init") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true, allowProfile: true });
      if (options.help) { output.log(HELP); return 0; }
      return emitLifecycle("init", options, output, initProject, dependencies);
    }
    if (command === "upgrade") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true, allowProfile: true });
      if (options.help) { output.log(HELP); return 0; }
      return emitLifecycle("upgrade", options, output, upgradeProject, dependencies);
    }
    if (command === "uninstall") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true });
      if (options.help) { output.log(HELP); return 0; }
      return emitLifecycle("uninstall", options, output, uninstallProject, dependencies);
    }
    if (command === "check") {
      const options = parseLifecycleArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      const result = await checkProject(options);
      if (options.json) {
        const { warnings, ...data } = result;
        const envelope = result.healthy
          ? successEnvelope("check", data, { warnings })
          : errorEnvelope("check", new SynodError(
              ERROR_CODES.CHECK_FAILED,
              "Synod project integrity check failed.",
              { details: data }
            ), { warnings });
        output.log(JSON.stringify(envelope, null, 2));
      } else {
        output.log(textCheck(result));
        printWarnings(result.warnings, output);
      }
      return result.healthy ? 0 : 1;
    }
    if (command === "doctor") {
      const options = parseLifecycleArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      const result = await doctorProject(options, { clientFactory: dependencies.doctorClientFactory || dependencies.clientFactory });
      if (options.json) {
        const { warnings, diagnostics, ...data } = result;
        const envelope = result.healthy
          ? successEnvelope("doctor", data, { warnings, diagnostics })
          : errorEnvelope("doctor", new SynodError(
              ERROR_CODES.DOCTOR_FAILED,
              "Synod doctor found an unsupported or unhealthy runtime.",
              { details: data }
            ), { warnings, diagnostics });
        output.log(JSON.stringify(envelope, null, 2));
      } else {
        output.log(textDoctor(result));
        printWarnings(result.warnings, output);
      }
      return result.healthy ? 0 : 1;
    }

    throw new SynodError(ERROR_CODES.UNKNOWN_COMMAND, `Unknown command: ${args[0]}`, {
      details: { command: args[0] }
    });
  } catch (error) {
    const synodError = asSynodError(error);
    if (jsonRequested) {
      output.log(JSON.stringify(errorEnvelope(command, synodError, {
        warnings: synodError.warnings,
        diagnostics: synodError.diagnostics
      }), null, 2));
      return 1;
    }
    printWarnings(synodError.warnings || [], output);
    output.error(`Error [${synodError.code}]: ${synodError.message}`);
    output.error("Run `synod --help` for usage.");
    return 1;
  }
}
