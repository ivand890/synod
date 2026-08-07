import process from "node:process";
import { errorEnvelope, successEnvelope } from "./contracts.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { initProject } from "./init.js";
import { packageVersion } from "./package.js";
import { collectUsage, formatUsageReport } from "./usage.js";

const HELP = `Synod ${packageVersion}

Install and operate a persistent, reviewed advisor loop for Codex projects.

Usage:
  synod init [directory] [--dry-run] [--force] [--json]
  synod usage [--session <thread-id>] [--cwd <directory>] [--by-model] [--json]
  synod --help
  synod --version

Commands:
  init        Install Synod files in a project. Defaults to the current directory.
  usage       Report token consumption for a Codex session tree, grouped by model.

Options:
  --dry-run   Show the planned changes without writing files.
  --force     Replace conflicting Synod-managed files. User-owned Codex config is preserved.
  --session   Select any thread in a session tree. Defaults to the latest session in --cwd.
  --cwd       Select the project directory used to find the latest session.
  --by-model  Group consumption by model (the default and currently supported view).
  --json      Print a versioned machine-readable success, warning, or error envelope.
  -h, --help  Show help.
  -v, --version
              Show the installed version.
`;

function parseInitArgs(args) {
  let directory = ".";
  let hasDirectory = false;
  let dryRun = false;
  let force = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, {
        details: { option: arg }
      });
    } else if (hasDirectory) {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, {
        details: { argument: arg }
      });
    } else {
      directory = arg;
      hasDirectory = true;
    }
  }

  return { directory, dryRun, force, json };
}

function parseUsageArgs(args) {
  const options = { cwd: process.cwd(), json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--by-model") {
      continue;
    } else if (arg === "--session" || arg === "--cwd") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new SynodError(ERROR_CODES.MISSING_OPTION_VALUE, `Missing value for ${arg}.`, {
          details: { option: arg }
        });
      }
      options[arg === "--session" ? "threadId" : "cwd"] = value;
      index += 1;
    } else {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, {
        details: { option: arg }
      });
    }
  }

  return options;
}

function printInitResult(result, output) {
  const prefix = result.dryRun ? "Would" : "";

  for (const path of result.created) output.log(`${prefix || "Created"}${prefix ? " create" : ""} ${path}`);
  for (const path of result.updated) output.log(`${prefix || "Updated"}${prefix ? " update" : ""} ${path}`);
  for (const path of result.unchanged) output.log(`Unchanged ${path}`);
  for (const item of result.warnings) output.warn(`Warning [${item.code}]: ${item.message}`);

  if (result.conflicts.length > 0) {
    output.error("Synod found conflicting files and made no changes:");
    for (const path of result.conflicts) output.error(`  - ${path}`);
    output.error("Run with --force to replace Synod-managed conflicts, or resolve them manually.");
    return;
  }

  const action = result.dryRun ? "plan is valid" : "initialized";
  output.log(`Synod ${action} in ${result.targetDirectory}`);
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

    if (args[0] === "usage") {
      const options = parseUsageArgs(args.slice(1));
      if (options.help) {
        output.log(HELP);
        return 0;
      }

      const report = await collectUsage({ ...options, clientFactory: dependencies.clientFactory });
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        output.log(JSON.stringify(successEnvelope("usage", data, { warnings, diagnostics }), null, 2));
      } else {
        output.log(formatUsageReport(report));
      }
      return 0;
    }

    if (args[0] !== "init") {
      throw new SynodError(ERROR_CODES.UNKNOWN_COMMAND, `Unknown command: ${args[0]}`, {
        details: { command: args[0] }
      });
    }

    const options = parseInitArgs(args.slice(1));
    if (options.help) {
      output.log(HELP);
      return 0;
    }

    const result = await initProject(options);
    if (options.json) {
      const { warnings, ...data } = result;
      if (result.conflicts.length > 0) {
        const error = new SynodError(
          ERROR_CODES.INIT_CONFLICT,
          "Synod found conflicting files and made no changes.",
          { details: { paths: result.conflicts } }
        );
        output.log(JSON.stringify(errorEnvelope("init", error, { warnings }), null, 2));
        return 1;
      }
      output.log(JSON.stringify(successEnvelope("init", data, { warnings }), null, 2));
      return 0;
    }
    printInitResult(result, output);
    return result.conflicts.length > 0 ? 1 : 0;
  } catch (error) {
    const synodError = asSynodError(error);
    if (jsonRequested) {
      output.log(JSON.stringify(errorEnvelope(command, synodError, {
        warnings: synodError.warnings,
        diagnostics: synodError.diagnostics
      }), null, 2));
      return 1;
    }
    output.error(`Error [${synodError.code}]: ${synodError.message}`);
    output.error("Run `synod --help` for usage.");
    return 1;
  }
}
