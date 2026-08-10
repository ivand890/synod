import process from "node:process";
import { ERROR_CODES, SynodError } from "./errors.js";

export interface HelpOptions {
  help: true;
}

export interface LifecycleOptions {
  directory: string;
  json: boolean;
  dryRun?: boolean;
  force?: boolean;
  profile?: string;
  explain?: boolean;
}

export interface UsageOptions {
  cwd: string;
  json: boolean;
  threadId?: string;
}

export interface CheckpointOptions {
  directory: string;
  json: boolean;
  actor: string;
  message?: string;
}

export interface BundleExportCommandOptions {
  action: "export";
  directory: string;
  destination: string;
  includeUntracked: boolean;
  json: boolean;
}

export interface BundleVerifyCommandOptions {
  action: "verify";
  bundle: string;
  json: boolean;
}

export interface BundleRestoreCommandOptions {
  action: "restore";
  bundle: string;
  directory: string;
  json: boolean;
}

export type BundleCommandOptions = BundleExportCommandOptions | BundleVerifyCommandOptions | BundleRestoreCommandOptions;

interface TaskCommonOptions {
  id: string;
  directory: string;
  json: boolean;
  actor: string;
}

export interface TaskAddOptions extends TaskCommonOptions {
  action: "add";
  objective?: string | undefined;
  executor?: string | undefined;
  acceptance: string[];
  verification: string[];
  dependsOn: string[];
}

export interface TaskTransitionOptions extends TaskCommonOptions {
  action: "transition";
  to: string;
  reason?: string | undefined;
  revision?: number | undefined;
  evidence: string[];
}

export type TaskOptions = TaskAddOptions | TaskTransitionOptions;

function missingValue(option: string): SynodError {
  return new SynodError(ERROR_CODES.MISSING_OPTION_VALUE, `Missing value for ${option}.`, {
    details: { option }
  });
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw missingValue(option);
  return value;
}

export function parseLifecycleArgs(
  args: string[],
  { allowDryRun = false, allowForce = false, allowProfile = false, allowExplain = false }: {
    allowDryRun?: boolean;
    allowForce?: boolean;
    allowProfile?: boolean;
    allowExplain?: boolean;
  } = {}
): LifecycleOptions | HelpOptions {
  const options: LifecycleOptions = { directory: ".", json: false };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--dry-run" && allowDryRun) options.dryRun = true;
    else if (arg === "--force" && allowForce) options.force = true;
    else if (arg === "--explain" && allowExplain) options.explain = true;
    else if (arg === "--profile" && allowProfile) {
      options.profile = optionValue(args, index, arg);
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

export function parseUsageArgs(
  args: string[],
  { cwd = process.cwd() }: { cwd?: string } = {}
): UsageOptions | HelpOptions {
  const options: UsageOptions = { cwd, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--by-model") continue;
    else if (arg === "--session" || arg === "--cwd") {
      const value = optionValue(args, index, arg);
      if (arg === "--session") options.threadId = value;
      else options.cwd = value;
      index += 1;
    } else {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    }
  }
  return options;
}

export function parseCheckpointArgs(args: string[]): CheckpointOptions | HelpOptions {
  const options: CheckpointOptions = { directory: ".", json: false, actor: "supervisor" };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--actor" || arg === "--message" || arg === "--cwd") {
      const value = optionValue(args, index, arg);
      if (arg === "--actor") options.actor = value;
      else if (arg === "--message") options.message = value;
      else options.directory = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else if (hasDirectory || options.directory !== ".") {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    } else {
      options.directory = arg;
      hasDirectory = true;
    }
  }
  return options;
}

export function parseBundleArgs(args: string[]): BundleCommandOptions | HelpOptions {
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (action !== "export" && action !== "verify" && action !== "restore") {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown bundle action: ${action}`, { details: { action } });
  }
  const positional = args[1];
  if (!positional || positional.startsWith("-")) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Bundle ${action} is missing its required path.`);
  }
  let directory = ".";
  let json = false;
  let includeUntracked = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (arg === "--include-untracked" && action === "export") includeUntracked = true;
    else if (arg === "--cwd" && (action === "export" || action === "restore")) {
      directory = optionValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }
  if (action === "export") return { action, directory, destination: positional, includeUntracked, json };
  if (action === "restore") return { action, bundle: positional, directory, json };
  return { action, bundle: positional, json };
}

export function parseTaskArgs(args: string[]): TaskOptions | HelpOptions {
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (action !== "add" && action !== "transition") {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown task action: ${action}`, { details: { action } });
  }
  const id = args[1];
  const to = action === "transition" ? args[2] : undefined;
  if (!id || id.startsWith("-") || (action === "transition" && (!to || to.startsWith("-")))) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Task ${action} is missing required positional arguments.`);
  }

  let directory = ".";
  let json = false;
  let actor = "supervisor";
  let objective: string | undefined;
  let executor: string | undefined;
  let reason: string | undefined;
  let revision: number | undefined;
  const acceptance: string[] = [];
  const verification: string[] = [];
  const dependsOn: string[] = [];
  const evidence: string[] = [];
  const start = action === "add" ? 2 : 3;

  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const valueOptions = [
      "--cwd", "--objective", "--executor", "--actor", "--reason",
      "--acceptance", "--verification", "--depends-on", "--evidence", "--revision"
    ];
    if (valueOptions.includes(arg)) {
      const value = optionValue(args, index, arg);
      if (arg === "--cwd") directory = value;
      else if (arg === "--objective") objective = value;
      else if (arg === "--executor") executor = value;
      else if (arg === "--actor") actor = value;
      else if (arg === "--reason") reason = value;
      else if (arg === "--acceptance") acceptance.push(value);
      else if (arg === "--verification") verification.push(value);
      else if (arg === "--depends-on") dependsOn.push(value);
      else if (arg === "--evidence") evidence.push(value);
      else revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }

  if (action === "add") {
    if (revision !== undefined || evidence.length > 0 || reason !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task add received a transition-only option.");
    }
    return { action, id, directory, json, actor, objective, executor, acceptance, verification, dependsOn };
  }
  if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0 || dependsOn.length > 0) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task transition received a task-definition option.");
  }
  if (!to) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Task transition is missing a target state.");
  return { action, id, to, directory, json, actor, reason, revision, evidence };
}
