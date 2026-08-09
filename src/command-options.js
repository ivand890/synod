import process from "node:process";
import { ERROR_CODES, SynodError } from "./errors.js";

function missingValue(option) {
  return new SynodError(ERROR_CODES.MISSING_OPTION_VALUE, `Missing value for ${option}.`, {
    details: { option }
  });
}

export function parseLifecycleArgs(args, { allowDryRun = false, allowForce = false, allowProfile = false } = {}) {
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

export function parseUsageArgs(args, { cwd = process.cwd() } = {}) {
  const options = { cwd, json: false };
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

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw missingValue(option);
  return value;
}

export function parseCheckpointArgs(args) {
  const options = { directory: ".", json: false, actor: "supervisor" };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (["--actor", "--message", "--cwd"].includes(arg)) {
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

const TASK_FIELD_OPTIONS = Object.freeze({
  "--cwd": "directory",
  "--objective": "objective",
  "--executor": "executor",
  "--actor": "actor",
  "--reason": "reason"
});

const TASK_LIST_OPTIONS = Object.freeze({
  "--acceptance": "acceptance",
  "--verification": "verification",
  "--depends-on": "dependsOn",
  "--evidence": "evidence"
});

export function parseTaskArgs(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") return { help: true };
  const action = args[0];
  if (!["add", "transition"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown task action: ${action}`, { details: { action } });
  }
  const requiredPositionals = action === "add" ? 2 : 3;
  if (args.length < requiredPositionals || args.slice(0, requiredPositionals).some(value => value.startsWith("-"))) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Task ${action} is missing required positional arguments.`);
  }
  const options = {
    action,
    id: args[1],
    ...(action === "transition" ? { to: args[2] } : {}),
    directory: ".",
    json: false,
    actor: "supervisor",
    acceptance: [],
    verification: [],
    dependsOn: [],
    evidence: []
  };
  const start = requiredPositionals;
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (Object.hasOwn(TASK_FIELD_OPTIONS, arg)) {
      options[TASK_FIELD_OPTIONS[arg]] = optionValue(args, index, arg);
      index += 1;
    } else if (Object.hasOwn(TASK_LIST_OPTIONS, arg)) {
      options[TASK_LIST_OPTIONS[arg]].push(optionValue(args, index, arg));
      index += 1;
    } else if (arg === "--revision") {
      const value = optionValue(args, index, arg);
      options.revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }
  if (action === "add" && (options.revision !== undefined || options.evidence.length > 0 || options.reason !== undefined)) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task add received a transition-only option.");
  }
  if (action === "transition" && (
    options.objective !== undefined || options.executor !== undefined || options.acceptance.length > 0
    || options.verification.length > 0 || options.dependsOn.length > 0
  )) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task transition received a task-definition option.");
  }
  return options;
}
