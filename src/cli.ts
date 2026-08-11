import { errorEnvelope, successEnvelope } from "./contracts.js";
import type { Warning } from "./contracts.js";
import { parseBundleArgs, parseCheckpointArgs, parseHandoffArgs, parseLeaseArgs, parseLifecycleArgs, parseTaskArgs, parseUsageArgs, parseWaitArgs } from "./command-options.js";
import type { HelpOptions, LifecycleOptions } from "./command-options.js";
import { doctorProject } from "./doctor.js";
import type { DoctorClient, DoctorDependencies } from "./doctor.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "./lifecycle.js";
import type { LifecycleDependencies, LifecycleResult } from "./lifecycle.js";
import { packageVersion } from "./package.js";
import { listProfiles } from "./profiles.js";
import { collectUsage, formatUsageReport } from "./usage.js";
import {
  addTask,
  acquireTaskLease,
  expireTaskLease,
  formatOrchestrationStatus,
  heartbeatTaskLease,
  orchestrationStatus,
  recordCheckpoint,
  recoverTaskLease,
  releaseTaskLease,
  revokeTaskLease,
  overrideCorrectionPolicy,
  splitTask,
  transitionTask
} from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import type { UsageClient } from "./usage.js";
import { isRecord } from "./validation.js";
import { exportRecoveryBundle, verifyRecoveryBundle } from "./recovery.js";
import { restoreRecoveryBundle } from "./restore.js";
import { formatHandoff, generateHandoff } from "./handoff.js";
import { formatWaitReport, waitForThreads } from "./wait.js";
import type { ThreadStatusAdapter, WaitClient } from "./wait.js";

const HELP = `Synod ${packageVersion}

Install and operate a persistent, reviewed advisor loop for Codex projects.

Usage:
  synod init [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod upgrade [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod check [directory] [--json]
  synod status [directory] [--explain] [--json]
  synod handoff [directory] [--bundle <bundle>] [--json]
  synod checkpoint [directory] [--actor <id>] [--message <text>] [--json]
  synod bundle export <destination> [--cwd <directory>] [--include-untracked] [--json]
  synod bundle verify <bundle> [--json]
  synod bundle restore <bundle> --cwd <directory> [--json]
  synod task add <task-id> --objective <text> --executor <id> --acceptance <criterion> --verification <command> [--depends-on <task-id>] [--correction-limit <n>] [--cwd <directory>] [--json]
  synod task transition <task-id> <state> --revision <n> [--evidence <reference>] [--reason <text>] [--actor <id>] [--cwd <directory>] [--json]
  synod task override <task-id> --additional-rounds <n> --approver <id> --reference <ref> --reason <text> --evidence <ref> [--cwd <directory>] [--json]
  synod task split <task-id> --replacement <task-id> --replacement <task-id> --reason <text> --evidence <ref> [--cwd <directory>] [--json]
  synod lease acquire <task-id> --owner-thread <thread-id> [--write <path>] [--write-tree <path>] [--read <path>] [--read-tree <path>] [--ttl-seconds <n>] [--heartbeat-seconds <n>] [--cwd <directory>] [--json]
  synod lease heartbeat <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod lease release <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod lease expire <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --reason <text> [--cwd <directory>] [--json]
  synod lease revoke <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --reason <text> [--cwd <directory>] [--json]
  synod lease recover <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --decision <resume|reassign|supersede> --reason <text> [--owner-thread <thread-id>] [--cwd <directory>] [--json]
  synod doctor [directory] [--json]
  synod uninstall [directory] [--dry-run] [--force] [--json]
  synod profiles [--json]
  synod usage [--session <thread-id>] [--cwd <directory>] [--by-model] [--json]
  synod wait --thread <thread-id> [--thread <thread-id>] [--timeout-seconds <n>] [--poll-interval-ms <n>] [--cwd <directory>] [--json]
  synod --help
  synod --version

Commands:
  init        Install a project-local runtime, Synod files, and an ownership manifest.
  upgrade     Update the selected local runtime and migrate managed project content.
  check       Verify managed-file hashes, ownership, and local project integrity.
  status      Read canonical orchestration state and detect checkpoint drift.
  handoff     Generate read-only continuation context from canonical state.
  checkpoint  Accept the current Git/worktree checkpoint in canonical state.
  bundle      Export, verify, or transactionally restore a recovery bundle.
  task        Add tasks and apply validated, revision-aware state transitions.
  lease       Acquire and mutate fenced durable writer leases.
  doctor      Probe Codex version, App Server, model, and reasoning capabilities.
  uninstall   Remove the local runtime and unchanged managed content; preserve durable state.
  profiles    List built-in model profiles and their requirements.
  usage       Report token consumption for a Codex session tree, grouped by model.
  wait        Observe child thread status changes without renewing worker leases.

Options:
  --profile   Select a built-in model profile for init or upgrade.
  --dry-run   Show the complete lifecycle plan without writing files.
  --force     Replace or remove modified Synod-owned files; never removes user-owned state.
  --session   Select any thread in a session tree. Defaults to the latest session in --cwd.
  --cwd       Select the project directory used to find the latest session.
  --by-model  Group consumption by model (the default and currently supported view).
  --thread    Add a Codex thread ID to a bounded status wait.
  --revision  Require the exact task revision for a transition.
  --evidence  Attach evidence to the exact task revision and current checkpoint.
  --owner-thread
              Bind a writer lease to one opaque Codex thread ID.
  --write     Add a repository-relative writer scope to a lease.
  --read      Add a repository-relative read scope to a lease.
  --write-tree
              Add a repository-relative writer scope covering a directory tree.
  --read-tree Add a repository-relative read scope covering a directory tree.
  --explain   Include a read-only path-level delta from the acknowledged checkpoint.
  --include-untracked
              Include acknowledged untracked files in a recovery bundle.
  --bundle    Verify and bind a recovery bundle to a canonical handoff.
  --json      Print a versioned machine-readable success, warning, or error envelope.
  -h, --help  Show help.
  -v, --version
              Show the installed version.
`;

interface CliOutput {
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface CliDependencies extends LifecycleDependencies, OrchestrationDependencies {
  clientFactory?: (options?: { codexBin: string }) => UsageClient;
  doctorClientFactory?: NonNullable<DoctorDependencies["clientFactory"]>;
  doctorRuntimeResolver?: NonNullable<DoctorDependencies["runtimeResolver"]>;
  waitClientFactory?: (options?: { cwd?: string }) => WaitClient;
  waitAdapterFactory?: () => ThreadStatusAdapter;
}

type CheckResult = Awaited<ReturnType<typeof checkProject>>;
type DoctorResult = Awaited<ReturnType<typeof doctorProject>>;
type LifecycleAction = (
  options: LifecycleOptions,
  dependencies: LifecycleDependencies
) => Promise<LifecycleResult>;

function isHelpOptions(options: object): options is HelpOptions {
  return "help" in options;
}

function isDoctorClient(value: unknown): value is DoctorClient {
  if (!isRecord(value)) return false;
  return typeof value.start === "function"
    && typeof value.probeCapabilities === "function"
    && typeof value.listModels === "function"
    && typeof value.close === "function";
}

function printWarnings(warnings: Warning[] | undefined, output: CliOutput): void {
  for (const item of warnings || []) output.warn(`Warning [${item.code}]: ${item.message}`);
}

function printLifecycleResult(command: string, result: LifecycleResult, output: CliOutput): void {
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

function textCheck(result: CheckResult): string {
  const lines = [`Synod project check: ${result.healthy ? "healthy" : "failed"}`];
  lines.push(`Runtime: ${result.runtimeVersion || "external"}`);
  lines.push(`Template: ${result.templateVersion} (manifest schema ${result.manifestSchemaVersion})`);
  lines.push(`Profile: ${result.profile}`);
  for (const item of result.checks) lines.push(`${item.status.padEnd(13)} ${item.ownership.padEnd(6)} ${item.path}`);
  return lines.join("\n");
}

function textDoctor(result: DoctorResult): string {
  const lines = [`Synod doctor: ${result.healthy ? "healthy" : "attention required"}`];
  lines.push(`Node: ${result.node.version} (${result.node.supported ? "supported" : "unsupported"})`);
  lines.push(`${result.codex.label}: ${result.codex.version || "unavailable"} (${result.codex.status}; ${result.codex.surface || "unknown surface"})`);
  lines.push(`Codex executable: ${result.codex.executable || "unavailable"} (${result.codex.executableSource || "unknown source"})`);
  lines.push(`Codex home: ${result.codex.home || "unavailable"}`);
  lines.push(`Supported Codex: ${result.codex.range}`);
  lines.push(`Known-good Codex: ${result.codex.knownGood.join(", ")}`);
  lines.push(`Recommended profile: ${result.recommendedProfile || "none"}`);
  for (const profile of result.profiles) {
    const status = profile.compatible
      ? "compatible"
      : profile.modelCompatible
        ? "Codex version ineligible"
        : "model unavailable";
    lines.push(`Profile ${profile.id}: ${status}`);
  }
  for (const issue of result.issues) lines.push(`Error [${issue.code}]: ${issue.message}`);
  return lines.join("\n");
}

async function emitLifecycle(
  command: "init" | "upgrade" | "uninstall",
  options: LifecycleOptions,
  output: CliOutput,
  action: LifecycleAction,
  dependencies: LifecycleDependencies
): Promise<number> {
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

export async function run(
  args: string[],
  output: CliOutput = console,
  dependencies: CliDependencies = {}
): Promise<number> {
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
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const report = await collectUsage({
        ...options,
        ...(dependencies.clientFactory ? { clientFactory: dependencies.clientFactory } : {})
      });
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        output.log(JSON.stringify(successEnvelope("usage", data, { warnings, diagnostics }), null, 2));
      } else {
        output.log(formatUsageReport(report));
        printWarnings(report.warnings, output);
      }
      return 0;
    }

    if (command === "wait") {
      const options = parseWaitArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const report = await waitForThreads(options, {
        ...(dependencies.waitClientFactory ? { clientFactory: dependencies.waitClientFactory } : {}),
        ...(dependencies.waitAdapterFactory ? { adapterFactory: dependencies.waitAdapterFactory } : {})
      });
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        output.log(JSON.stringify(successEnvelope("wait", data, { warnings, diagnostics }), null, 2));
      } else {
        output.log(formatWaitReport(report));
        printWarnings(report.warnings, output);
      }
      return report.incomplete ? 1 : 0;
    }

    if (command === "status") {
      const options = parseLifecycleArgs(args.slice(1), { allowExplain: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
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

    if (command === "handoff") {
      const options = parseHandoffArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await generateHandoff(options, dependencies);
      if (options.json) output.log(JSON.stringify(successEnvelope("handoff", result), null, 2));
      else output.log(formatHandoff(result));
      return 0;
    }

    if (command === "checkpoint") {
      const options = parseCheckpointArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await recordCheckpoint(options, dependencies);
      const data = { checkpoint: result.checkpoint, lastEvent: result.state.lastEvent };
      if (options.json) output.log(JSON.stringify(successEnvelope("checkpoint", data), null, 2));
      else output.log(`Recorded checkpoint ${result.state.lastEvent.sequence}: ${result.checkpoint.head || "no Git HEAD"}`);
      return 0;
    }

    if (command === "bundle") {
      const options = parseBundleArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      if (options.action === "export") {
        const result = await exportRecoveryBundle(options, dependencies);
        const data = {
          destination: result.destination,
          bundleId: result.bundleId,
          source: result.manifest.source,
          checkpoint: result.manifest.checkpoint,
          includeUntracked: result.manifest.includeUntracked,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) output.log(JSON.stringify(successEnvelope("bundle", { action: "export", ...data }), null, 2));
        else {
          const base = `${result.manifest.source.branch || "detached"}@${result.manifest.source.head || "no HEAD"}`;
          output.log(`Exported recovery bundle ${result.bundleId} to ${result.destination} (${result.entries} paths, ${result.objects} objects; base ${base}; fingerprint ${result.manifest.checkpoint.fingerprint}; untracked ${result.manifest.includeUntracked ? "included" : "excluded"}).`);
        }
      } else if (options.action === "verify") {
        const result = await verifyRecoveryBundle(options);
        const data = {
          bundle: result.bundle,
          bundleId: result.bundleId,
          source: result.manifest.source,
          checkpoint: result.manifest.checkpoint,
          includeUntracked: result.manifest.includeUntracked,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) output.log(JSON.stringify(successEnvelope("bundle", { action: "verify", ...data }), null, 2));
        else output.log(`Verified recovery bundle ${result.bundleId} (${result.entries} paths, ${result.objects} objects, ${result.bytes} bytes).`);
      } else {
        const result = await restoreRecoveryBundle(options, dependencies);
        const data = {
          bundle: result.bundle,
          destination: result.destination,
          bundleId: result.bundleId,
          baseHead: result.baseHead,
          fingerprint: result.fingerprint,
          recoveredInterruptedRestore: result.recoveredInterruptedRestore,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) output.log(JSON.stringify(successEnvelope("bundle", { action: "restore", ...data }), null, 2));
        else output.log(`Restored recovery bundle ${result.bundleId} into ${result.destination} (${result.entries} paths; base ${result.baseHead}; fingerprint ${result.fingerprint}).`);
      }
      return 0;
    }

    if (command === "task") {
      const options = parseTaskArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      if (options.action === "add") {
        const result = await addTask(options, dependencies);
        const data = { task: result.task, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "add", ...data }), null, 2));
        else output.log(`Added ${result.task.id} in ${result.task.state} at revision ${result.task.revision}.`);
      } else if (options.action === "transition") {
        const result = await transitionTask(options, dependencies);
        const data = { task: result.task, evidence: result.evidence, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "transition", ...data }), null, 2));
        else {
          output.log(`Transitioned ${result.task.id} to ${result.task.state} at revision ${result.task.revision}.`);
          for (const item of result.evidence) output.log(`Recorded evidence ${item.id}: ${item.kind} @ revision ${item.revision}.`);
        }
      } else if (options.action === "override") {
        const result = await overrideCorrectionPolicy(options, dependencies);
        const data = { task: result.task, override: result.override, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "override", ...data }), null, 2));
        else output.log(`Added ${result.override.added} correction round(s) to ${result.task.id}; limit ${result.task.correctionPolicy.limit}.`);
      } else {
        const result = await splitTask(options, dependencies);
        const data = { task: result.task, replacements: result.replacements, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) output.log(JSON.stringify(successEnvelope("task", { action: "split", ...data }), null, 2));
        else output.log(`Split ${result.task.id} into ${result.replacements.map(item => item.id).join(", ")}.`);
      }
      return 0;
    }

    if (command === "lease") {
      const options = parseLeaseArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = options.action === "acquire"
        ? await acquireTaskLease(options, dependencies)
        : options.action === "heartbeat"
          ? await heartbeatTaskLease(options, dependencies)
          : options.action === "release"
            ? await releaseTaskLease(options, dependencies)
            : options.action === "expire"
              ? await expireTaskLease(options, dependencies)
              : options.action === "revoke"
                ? await revokeTaskLease(options, dependencies)
                : await recoverTaskLease(options, dependencies);
      const data = {
        action: options.action,
        task: result.task,
        lease: result.lease,
        checkpoint: result.state.checkpoint,
        lastEvent: result.state.lastEvent
      };
      if (options.json) output.log(JSON.stringify(successEnvelope("lease", data), null, 2));
      else output.log(`Lease ${options.action} for ${result.task.id}: ${result.lease.id} generation ${result.lease.generation}.`);
      return 0;
    }

    if (command === "profiles") {
      const options = parseLifecycleArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
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
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      return emitLifecycle("init", options, output, initProject, dependencies);
    }
    if (command === "upgrade") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true, allowProfile: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      return emitLifecycle("upgrade", options, output, upgradeProject, dependencies);
    }
    if (command === "uninstall") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      return emitLifecycle("uninstall", options, output, uninstallProject, dependencies);
    }
    if (command === "check") {
      const options = parseLifecycleArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
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
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const usageClientFactory = dependencies.clientFactory;
      const doctorClientFactory = dependencies.doctorClientFactory || (usageClientFactory
        ? options => {
            const client: unknown = usageClientFactory(options);
            if (!isDoctorClient(client)) {
              throw new SynodError(ERROR_CODES.INTERNAL, "The shared CLI client factory did not return a doctor-compatible client.");
            }
            return client;
          }
        : undefined);
      const result = await doctorProject(options, {
        ...(doctorClientFactory ? { clientFactory: doctorClientFactory } : {}),
        ...(dependencies.doctorRuntimeResolver ? { runtimeResolver: dependencies.doctorRuntimeResolver } : {})
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
        ...(synodError.warnings ? { warnings: synodError.warnings } : {}),
        ...(synodError.diagnostics ? { diagnostics: synodError.diagnostics } : {})
      }), null, 2));
      return 1;
    }
    printWarnings(synodError.warnings || [], output);
    output.error(`Error [${synodError.code}]: ${synodError.message}`);
    output.error("Run `synod --help` for usage.");
    return 1;
  }
}
