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
  sinceEvent?: string;
  sinceCheckpoint?: boolean;
  taskId?: string;
  untilEvent?: string;
}

export interface WaitCommandOptions {
  cwd: string;
  json: boolean;
  threadIds: string[];
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface CheckpointOptions {
  directory: string;
  json: boolean;
  actor: string;
  message?: string;
}

export interface HandoffCommandOptions {
  directory: string;
  json: boolean;
  bundle?: string;
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

interface LeaseCommonOptions {
  id: string;
  directory: string;
  json: boolean;
  actor: string;
}

export interface LeaseAcquireCommandOptions extends LeaseCommonOptions {
  action: "acquire";
  ownerThread?: string;
  read: string[];
  write: string[];
  readTree: string[];
  writeTree: string[];
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
}

export interface LeaseMutationCommandOptions extends LeaseCommonOptions {
  action: "heartbeat" | "release" | "expire" | "revoke";
  leaseId: string;
  generation: number;
  revision: number;
  expectedHeartbeatAt: string;
  ownerThread?: string;
  reason?: string;
}

export interface LeaseRecoverCommandOptions extends LeaseCommonOptions {
  action: "recover";
  leaseId: string;
  generation: number;
  revision: number;
  expectedHeartbeatAt: string;
  decision: "resume" | "reassign" | "supersede";
  ownerThread?: string;
  reason: string;
}

export type LeaseCommandOptions = LeaseAcquireCommandOptions | LeaseMutationCommandOptions | LeaseRecoverCommandOptions;

export interface WorktreeCreateCommandOptions {
  action: "create";
  id: string;
  directory: string;
  destination: string;
  leaseId: string;
  generation: number;
  revision: number;
  expectedHeartbeatAt: string;
  ownerThread: string;
  json: boolean;
}

export interface WorktreeFencedCommandOptions {
  action: "seal" | "integrate";
  id: string;
  directory: string;
  leaseId: string;
  generation: number;
  revision: number;
  expectedHeartbeatAt: string;
  ownerThread: string;
  json: boolean;
}

export interface WorktreeStatusCommandOptions {
  action: "status" | "cleanup";
  id: string;
  directory: string;
  json: boolean;
}

export type WorktreeCommandOptions = WorktreeCreateCommandOptions | WorktreeFencedCommandOptions | WorktreeStatusCommandOptions;

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
  correctionLimit?: number;
}

export interface TaskTransitionOptions extends TaskCommonOptions {
  action: "transition";
  to: string;
  reason?: string | undefined;
  revision?: number | undefined;
  evidence: string[];
}

export interface TaskOverrideOptions extends TaskCommonOptions {
  action: "override";
  additionalRounds: number;
  approver: string;
  reference: string;
  reason: string;
  evidence: string[];
}

export interface TaskSplitOptions extends TaskCommonOptions {
  action: "split";
  replacements: string[];
  reason: string;
  evidence: string[];
}

export type TaskOptions = TaskAddOptions | TaskTransitionOptions | TaskOverrideOptions | TaskSplitOptions;

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
    else if (arg === "--since-checkpoint") {
      if (options.sinceCheckpoint) {
        throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage selectors cannot be repeated.");
      }
      options.sinceCheckpoint = true;
    } else if (["--session", "--cwd", "--since-event", "--task", "--until-event"].includes(arg)) {
      const value = optionValue(args, index, arg);
      if (arg === "--session") options.threadId = value;
      else if (arg === "--cwd") options.cwd = value;
      else if (arg === "--since-event") {
        if (options.sinceEvent !== undefined) {
          throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage selectors cannot be repeated.");
        }
        options.sinceEvent = value;
      } else if (arg === "--task") {
        if (options.taskId !== undefined) {
          throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage selectors cannot be repeated.");
        }
        options.taskId = value;
      } else {
        if (options.untilEvent !== undefined) {
          throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage selectors cannot be repeated.");
        }
        options.untilEvent = value;
      }
      index += 1;
    } else {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    }
  }
  const selectors = [options.sinceEvent !== undefined, options.sinceCheckpoint === true, options.taskId !== undefined]
    .filter(Boolean).length;
  if (selectors > 1) {
    throw new SynodError(
      ERROR_CODES.USAGE_INTERVAL_INVALID,
      "Usage accepts exactly one of --since-event, --since-checkpoint, or --task."
    );
  }
  if (options.untilEvent && selectors === 0) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "--until-event requires one usage start selector.");
  }
  return options;
}

export function parseWaitArgs(
  args: string[],
  { cwd = process.cwd() }: { cwd?: string } = {}
): WaitCommandOptions | HelpOptions {
  const options: WaitCommandOptions = {
    cwd,
    json: false,
    threadIds: [],
    timeoutMs: 5 * 60_000,
    pollIntervalMs: 1_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (["--thread", "--cwd", "--timeout-seconds", "--poll-interval-ms"].includes(arg)) {
      const value = optionValue(args, index, arg);
      if (arg === "--thread") options.threadIds.push(value);
      else if (arg === "--cwd") options.cwd = value;
      else if (arg === "--timeout-seconds") {
        const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
        if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3_600) {
          throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait timeout must be an integer from 1 through 3600 seconds.");
        }
        options.timeoutMs = seconds * 1_000;
      } else {
        const interval = /^\d+$/.test(value) ? Number(value) : Number.NaN;
        if (!Number.isSafeInteger(interval) || interval < 100 || interval > 5_000) {
          throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait poll interval must be an integer from 100 through 5000 milliseconds.");
        }
        options.pollIntervalMs = interval;
      }
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }
  options.threadIds = [...new Set(options.threadIds.map(value => value.trim()).filter(Boolean))];
  if (options.threadIds.length === 0) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait requires at least one --thread <thread-id>.");
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

export function parseHandoffArgs(args: string[]): HandoffCommandOptions | HelpOptions {
  const options: HandoffCommandOptions = { directory: ".", json: false };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--bundle" || arg === "--cwd") {
      const value = optionValue(args, index, arg);
      if (arg === "--bundle") options.bundle = value;
      else {
        if (hasDirectory) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Handoff received more than one project directory.");
        options.directory = value;
        hasDirectory = true;
      }
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else if (hasDirectory) {
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
  let hasDirectory = false;
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
      hasDirectory = true;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }
  if (action === "export") return { action, directory, destination: positional, includeUntracked, json };
  if (action === "restore") {
    if (!hasDirectory) {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Bundle restore requires --cwd <directory>.", {
        details: { option: "--cwd" }
      });
    }
    return { action, bundle: positional, directory, json };
  }
  return { action, bundle: positional, json };
}

export function parseLeaseArgs(args: string[]): LeaseCommandOptions | HelpOptions {
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["acquire", "heartbeat", "release", "expire", "revoke", "recover"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown lease action: ${action}`, { details: { action } });
  }
  const id = args[1];
  if (!id || id.startsWith("-")) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Lease ${action} is missing its task ID.`);
  }
  let directory = ".";
  let json = false;
  let actor = "supervisor";
  let ownerThread: string | undefined;
  let leaseId: string | undefined;
  let generation: number | undefined;
  let revision: number | undefined;
  let expectedHeartbeatAt: string | undefined;
  let ttlSeconds: number | undefined;
  let heartbeatIntervalSeconds: number | undefined;
  let reason: string | undefined;
  let decision: "resume" | "reassign" | "supersede" | undefined;
  const read: string[] = [];
  const write: string[] = [];
  const readTree: string[] = [];
  const writeTree: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    const valueOptions = [
      "--cwd", "--actor", "--owner-thread", "--lease-id", "--generation", "--revision", "--expected-heartbeat-at",
      "--ttl-seconds", "--heartbeat-seconds", "--reason", "--decision", "--read", "--write", "--read-tree", "--write-tree"
    ];
    if (!valueOptions.includes(arg)) {
      if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    const value = optionValue(args, index, arg);
    if (arg === "--cwd") directory = value;
    else if (arg === "--actor") actor = value;
    else if (arg === "--owner-thread") ownerThread = value;
    else if (arg === "--lease-id") leaseId = value;
    else if (arg === "--expected-heartbeat-at") expectedHeartbeatAt = value;
    else if (arg === "--reason") reason = value;
    else if (arg === "--decision") {
      if (!["resume", "reassign", "supersede"].includes(value)) {
        throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease recover decision must be resume, reassign, or supersede.");
      }
      decision = value as "resume" | "reassign" | "supersede";
    }
    else if (arg === "--read") read.push(value);
    else if (arg === "--write") write.push(value);
    else if (arg === "--read-tree") readTree.push(value);
    else if (arg === "--write-tree") writeTree.push(value);
    else if (arg === "--generation") generation = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--revision") revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--ttl-seconds") ttlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else heartbeatIntervalSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    index += 1;
  }
  for (const [option, value] of [
    ["--generation", generation],
    ["--revision", revision],
    ["--ttl-seconds", ttlSeconds],
    ["--heartbeat-seconds", heartbeatIntervalSeconds]
  ] as const) {
    if (value !== undefined && Number.isNaN(value)) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires an integer value for ${option}.`, {
        details: { option }
      });
    }
  }
  if (action === "acquire") {
    if (leaseId !== undefined || generation !== undefined || revision !== undefined || expectedHeartbeatAt !== undefined || reason !== undefined || decision !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Lease acquire received a mutation-only option.");
    }
    return {
      action,
      id,
      directory,
      json,
      actor,
      read,
      write,
      readTree,
      writeTree,
      ...(ownerThread === undefined ? {} : { ownerThread }),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds })
    };
  }
  if (read.length > 0 || write.length > 0 || readTree.length > 0 || writeTree.length > 0
    || ttlSeconds !== undefined || heartbeatIntervalSeconds !== undefined) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Lease ${action} received an acquire-only option.`);
  }
  if (action !== "recover" && decision !== undefined) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Lease ${action} received a recovery-only option.`);
  }
  if (leaseId === undefined || generation === undefined || revision === undefined || expectedHeartbeatAt === undefined) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires --lease-id, --generation, --revision, and --expected-heartbeat-at.`);
  }
  if ((action === "heartbeat" || action === "release") && ownerThread === undefined) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires --owner-thread.`);
  }
  if ((action === "expire" || action === "revoke") && reason === undefined) {
    throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires --reason.`);
  }
  if (action === "recover") {
    if (!decision || !reason) throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease recover requires --decision and --reason.");
    if (decision === "reassign" && !ownerThread) throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease reassign recovery requires --owner-thread.");
    if (decision === "supersede" && ownerThread) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Lease supersede recovery does not accept --owner-thread.");
    return { action, id, directory, json, actor, leaseId, generation, revision, expectedHeartbeatAt, decision, reason, ...(ownerThread ? { ownerThread } : {}) };
  }
  return {
    action: action as LeaseMutationCommandOptions["action"],
    id,
    directory,
    json,
    actor,
    ...(ownerThread === undefined ? {} : { ownerThread }),
    leaseId,
    generation,
    revision,
    expectedHeartbeatAt,
    ...(reason === undefined ? {} : { reason })
  };
}

export function parseWorktreeArgs(args: string[]): WorktreeCommandOptions | HelpOptions {
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["create", "seal", "integrate", "cleanup", "status"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown worktree action: ${action}`, { details: { action } });
  }
  const id = args[1];
  if (!id || id.startsWith("-")) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Worktree ${action} is missing its task ID.`);
  }

  let directory = ".";
  let destination: string | undefined;
  let leaseId: string | undefined;
  let generation: number | undefined;
  let revision: number | undefined;
  let expectedHeartbeatAt: string | undefined;
  let ownerThread: string | undefined;
  let json = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    const valueOptions = [
      "--cwd", "--destination", "--lease-id", "--generation", "--revision",
      "--expected-heartbeat-at", "--owner-thread"
    ];
    if (!valueOptions.includes(arg)) {
      if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    const value = optionValue(args, index, arg);
    if (arg === "--cwd") directory = value;
    else if (arg === "--destination") destination = value;
    else if (arg === "--lease-id") leaseId = value;
    else if (arg === "--generation") generation = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--revision") revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--expected-heartbeat-at") expectedHeartbeatAt = value;
    else ownerThread = value;
    index += 1;
  }

  if (action === "status" || action === "cleanup") {
    const unsupported = [
      ["--destination", destination],
      ["--lease-id", leaseId],
      ["--generation", generation],
      ["--revision", revision],
      ["--expected-heartbeat-at", expectedHeartbeatAt],
      ["--owner-thread", ownerThread]
    ].find(([, value]) => value !== undefined);
    if (unsupported) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Worktree ${action} does not accept creation or lease-fencing options.`, {
        details: { action, option: unsupported[0] }
      });
    }
    return { action: action as WorktreeStatusCommandOptions["action"], id, directory, json };
  }
  if (action !== "create" && destination !== undefined) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Worktree ${action} does not accept --destination.`);
  }
  if ((action === "create" && !destination)
    || !leaseId || generation === undefined || revision === undefined || !expectedHeartbeatAt || !ownerThread) {
    throw new SynodError(
      ERROR_CODES.WORKTREE_INVALID,
      `Worktree ${action} requires ${action === "create" ? "--destination, " : ""}--lease-id, --generation, --revision, --expected-heartbeat-at, and --owner-thread.`
    );
  }
  if (!Number.isSafeInteger(generation) || generation <= 0 || !Number.isSafeInteger(revision) || revision < 0) {
    throw new SynodError(ERROR_CODES.WORKTREE_INVALID, "Worktree generation must be positive and revision must be non-negative integers.");
  }
  if (Number.isNaN(Date.parse(expectedHeartbeatAt))) {
    throw new SynodError(ERROR_CODES.WORKTREE_INVALID, "Worktree expected heartbeat must be an ISO timestamp.");
  }
  const fenced = { id, directory, leaseId, generation, revision, expectedHeartbeatAt, ownerThread, json };
  return action === "create"
    ? { action, destination: destination!, ...fenced }
    : { action: action as WorktreeFencedCommandOptions["action"], ...fenced };
}

export function parseTaskArgs(args: string[]): TaskOptions | HelpOptions {
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["add", "transition", "override", "split"].includes(action)) {
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
  let correctionLimit: number | undefined;
  let additionalRounds: number | undefined;
  let approver: string | undefined;
  let reference: string | undefined;
  const acceptance: string[] = [];
  const verification: string[] = [];
  const dependsOn: string[] = [];
  const evidence: string[] = [];
  const replacements: string[] = [];
  const start = action === "transition" ? 3 : 2;

  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const valueOptions = [
      "--cwd", "--objective", "--executor", "--actor", "--reason",
      "--acceptance", "--verification", "--depends-on", "--evidence", "--revision",
      "--correction-limit", "--additional-rounds", "--approver", "--reference", "--replacement"
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
      else if (arg === "--replacement") replacements.push(value);
      else if (arg === "--approver") approver = value;
      else if (arg === "--reference") reference = value;
      else if (arg === "--correction-limit") correctionLimit = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      else if (arg === "--additional-rounds") additionalRounds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      else revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    } else {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
  }

  if (action === "add") {
    if (revision !== undefined || evidence.length > 0 || reason !== undefined || additionalRounds !== undefined
      || approver !== undefined || reference !== undefined || replacements.length > 0) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task add received a transition-only option.");
    }
    if (correctionLimit !== undefined && Number.isNaN(correctionLimit)) throw new SynodError(ERROR_CODES.TASK_INVALID, "Task add requires an integer --correction-limit.");
    return { action, id, directory, json, actor, objective, executor, acceptance, verification, dependsOn, ...(correctionLimit === undefined ? {} : { correctionLimit }) };
  }
  if (action === "override") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || revision !== undefined || correctionLimit !== undefined || replacements.length > 0) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task override received an unrelated task option.");
    }
    if (!additionalRounds || Number.isNaN(additionalRounds) || !approver || !reference || !reason || evidence.length === 0) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, "Task override requires --additional-rounds, --approver, --reference, --reason, and --evidence.");
    }
    return { action, id, directory, json, actor, additionalRounds, approver, reference, reason, evidence };
  }
  if (action === "split") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || revision !== undefined || correctionLimit !== undefined || additionalRounds !== undefined
      || approver !== undefined || reference !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task split received an unrelated task option.");
    }
    if (replacements.length < 2 || !reason || evidence.length === 0) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, "Task split requires at least two --replacement values, --reason, and --evidence.");
    }
    return { action, id, directory, json, actor, replacements, reason, evidence };
  }
  if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0 || dependsOn.length > 0
    || correctionLimit !== undefined || additionalRounds !== undefined || approver !== undefined || reference !== undefined || replacements.length > 0) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task transition received a task-definition option.");
  }
  if (!to) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Task transition is missing a target state.");
  return { action: "transition", id, to, directory, json, actor, reason, revision, evidence };
}
