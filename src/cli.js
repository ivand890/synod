import { errorEnvelope, successEnvelope } from "./contracts.js";
import { parseCheckpointArgs, parseLifecycleArgs, parseTaskArgs, parseUsageArgs } from "./command-options.js";
import { doctorProject } from "./doctor.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "./lifecycle.js";
import { packageVersion } from "./package.js";
import { listProfiles } from "./profiles.js";
import { collectUsage, formatUsageReport } from "./usage.js";
import {
  addTask,
  formatOrchestrationStatus,
  orchestrationStatus,
  recordCheckpoint,
  transitionTask
} from "./orchestration.js";

const HELP = `Synod ${packageVersion}

Install and operate a persistent, reviewed advisor loop for Codex projects.

Usage:
  synod init [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod upgrade [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod check [directory] [--json]
  synod status [directory] [--json]
  synod checkpoint [directory] [--actor <id>] [--message <text>] [--json]
  synod task add <task-id> --objective <text> --executor <id> --acceptance <criterion> --verification <command> [--depends-on <task-id>] [--cwd <directory>] [--json]
  synod task transition <task-id> <state> --revision <n> [--evidence <reference>] [--reason <text>] [--actor <id>] [--cwd <directory>] [--json]
  synod doctor [directory] [--json]
  synod uninstall [directory] [--dry-run] [--force] [--json]
  synod profiles [--json]
  synod usage [--session <thread-id>] [--cwd <directory>] [--by-model] [--json]
  synod --help
  synod --version

Commands:
  init        Install a project-local runtime, Synod files, and an ownership manifest.
  upgrade     Update the selected local runtime and migrate managed project content.
  check       Verify managed-file hashes, ownership, and local project integrity.
  status      Read canonical orchestration state and detect checkpoint drift.
  checkpoint  Accept the current Git/worktree checkpoint in canonical state.
  task        Add tasks and apply validated, revision-aware state transitions.
  doctor      Probe Codex version, App Server, model, and reasoning capabilities.
  uninstall   Remove the local runtime and unchanged managed content; preserve durable state.
  profiles    List built-in model profiles and their requirements.
  usage       Report token consumption for a Codex session tree, grouped by model.

Options:
  --profile   Select a built-in model profile for init or upgrade.
  --dry-run   Show the complete lifecycle plan without writing files.
  --force     Replace or remove modified Synod-owned files; never removes user-owned state.
  --session   Select any thread in a session tree. Defaults to the latest session in --cwd.
  --cwd       Select the project directory used to find the latest session.
  --by-model  Group consumption by model (the default and currently supported view).
  --revision  Require the exact task revision for a transition.
  --evidence  Attach evidence to the exact task revision and current checkpoint.
  --json      Print a versioned machine-readable success, warning, or error envelope.
  -h, --help  Show help.
  -v, --version
              Show the installed version.
`;

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
  if (result.runtimeVersion) output.log(`Runtime: ${result.runtimeVersion} (${result.runtimeAction || "project-local"})`);
  output.log(`Synod ${result.dryRun ? `${command} plan is valid` : `${command} completed`} in ${result.targetDirectory}`);
}

function textCheck(result) {
  const lines = [`Synod project check: ${result.healthy ? "healthy" : "failed"}`];
  lines.push(`Runtime: ${result.runtimeVersion || "external"}`);
  lines.push(`Template: ${result.templateVersion} (manifest schema ${result.manifestSchemaVersion})`);
  lines.push(`Profile: ${result.profile}`);
  for (const item of result.checks) lines.push(`${item.status.padEnd(13)} ${item.ownership.padEnd(6)} ${item.path}`);
  return lines.join("\n");
}

function textDoctor(result) {
  const lines = [`Synod doctor: ${result.healthy ? "healthy" : "attention required"}`];
  lines.push(`Node: ${result.node.version} (${result.node.supported ? "supported" : "unsupported"})`);
  lines.push(`${result.codex.label}: ${result.codex.version || "unavailable"} (${result.codex.status}; ${result.codex.surface || "unknown surface"})`);
  lines.push(`Codex executable: ${result.codex.executable || "unavailable"} (${result.codex.executableSource || "unknown source"})`);
  lines.push(`Codex home: ${result.codex.home || "unavailable"}`);
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

    if (command === "status") {
      const options = parseLifecycleArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      const result = await orchestrationStatus(options, dependencies);
      if (options.json) {
        const envelope = result.healthy
          ? successEnvelope("status", result)
          : errorEnvelope("status", new SynodError(
              ERROR_CODES.CHECKPOINT_DRIFT,
              "Synod checkpoint drift was detected.",
              { details: result }
            ));
        output.log(JSON.stringify(envelope, null, 2));
      } else {
        output.log(formatOrchestrationStatus(result));
      }
      return result.healthy ? 0 : 1;
    }

    if (command === "checkpoint") {
      const options = parseCheckpointArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      const result = await recordCheckpoint(options, dependencies);
      const data = { checkpoint: result.checkpoint, lastEvent: result.state.lastEvent };
      if (options.json) output.log(JSON.stringify(successEnvelope("checkpoint", data), null, 2));
      else output.log(`Recorded checkpoint ${result.state.lastEvent.sequence}: ${result.checkpoint.head || "no Git HEAD"}`);
      return 0;
    }

    if (command === "task") {
      const options = parseTaskArgs(args.slice(1));
      if (options.help) { output.log(HELP); return 0; }
      if (options.action === "add") {
        const result = await addTask(options, dependencies);
        const data = { task: result.task, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "add", ...data }), null, 2));
        else output.log(`Added ${result.task.id} in ${result.task.state} at revision ${result.task.revision}.`);
      } else {
        const result = await transitionTask(options, dependencies);
        const data = { task: result.task, evidence: result.evidence, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "transition", ...data }), null, 2));
        else {
          output.log(`Transitioned ${result.task.id} to ${result.task.state} at revision ${result.task.revision}.`);
          for (const item of result.evidence) output.log(`Recorded evidence ${item.id}: ${item.kind} @ revision ${item.revision}.`);
        }
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
      const result = await doctorProject(options, {
        clientFactory: dependencies.doctorClientFactory || dependencies.clientFactory,
        runtimeResolver: dependencies.doctorRuntimeResolver
      });
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
