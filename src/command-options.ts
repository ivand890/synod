import process from "node:process";
import { ERROR_CODES, SynodError } from "./errors.js";
import { parseOutputViewArgs } from "./output-view.js";
import type { DelegationRole } from "./profiles.js";

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

export interface StatusOptions extends LifecycleOptions {
  taskId?: string;
  activeOnly?: boolean;
  changedSinceCheckpoint?: boolean;
}

export interface UsageOptions {
  cwd: string;
  json: boolean;
  threadId?: string;
  sinceEvent?: string;
  sinceCheckpoint?: boolean;
  taskId?: string;
  untilEvent?: string;
  priceFile?: string;
}

export interface WaitCommandOptions {
  cwd: string;
  json: boolean;
  threadIds: string[];
  taskIds: string[];
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface DelegateStartCommandOptions {
  action: "start";
  id: string;
  cwd: string;
  json: boolean;
  actor: string;
  role?: DelegationRole;
  read: string[];
  write: string[];
  readTree: string[];
  writeTree: string[];
  reservationTtlSeconds?: number;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  evidence: string[];
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface DelegateCompleteCommandOptions {
  action: "complete";
  id: string;
  cwd: string;
  json: boolean;
  actor: string;
  ownerThread: string;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  evidence: string[];
}

export type DelegateCommandOptions = DelegateStartCommandOptions | DelegateCompleteCommandOptions;

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
  includeLocalDocs?: boolean;
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
  includeLocalDocs?: boolean;
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
  observer?: true;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
}

export interface LeaseReserveCommandOptions extends LeaseCommonOptions {
  action: "reserve";
  read: string[];
  write: string[];
  readTree: string[];
  writeTree: string[];
  observer?: true;
  reservationTtlSeconds?: number;
}

interface LeaseReservationFenceCommandOptions extends LeaseCommonOptions {
  reservationToken: string;
  leaseId: string;
  generation: number;
  revision: number;
  expectedReservedAt: string;
  baselineHash: string;
}

export interface LeaseBindCommandOptions extends LeaseReservationFenceCommandOptions {
  action: "bind";
  ownerThread: string;
  ttlSeconds?: number;
  heartbeatIntervalSeconds?: number;
  evidence: string[];
}

export interface LeaseReservationEndCommandOptions extends LeaseReservationFenceCommandOptions {
  action: "cancel" | "expire";
  reason: string;
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

export type LeaseCommandOptions = LeaseAcquireCommandOptions
  | LeaseReserveCommandOptions
  | LeaseBindCommandOptions
  | LeaseReservationEndCommandOptions
  | LeaseMutationCommandOptions
  | LeaseRecoverCommandOptions;

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

export interface TaskApprovalOptions extends TaskCommonOptions {
  action: "approve";
  role: "reviewer" | "verifier";
  decision: "approved" | "rejected";
  revision: number;
  proposalBundleId: string;
  ownerThread: string;
  evidence: string[];
}

export interface TaskCorrectionOptions extends TaskCommonOptions {
  action: "correct";
  reason: string;
  revision: number;
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

export interface TaskNextOptions {
  action: "next";
  directory: string;
  json: boolean;
  actor: string;
}

export type TaskOptions = TaskAddOptions | TaskTransitionOptions | TaskApprovalOptions | TaskCorrectionOptions | TaskOverrideOptions | TaskSplitOptions | TaskNextOptions;

export interface ProposalSubmitOptions {
  action: "submit";
  id: string;
  directory: string;
  json: boolean;
  actor: string;
  evidence: string[];
}

interface BudgetCommonOptions {
  id: string;
  directory: string;
  json: boolean;
  actor: string;
}

export interface BudgetPolicyCommandOptions extends BudgetCommonOptions {
  action: "set" | "replace";
  rootSessionId: string;
  startEvent: string;
  softTotalTokens?: number;
  hardTotalTokens?: number;
  reason: string;
  evidence: string[];
  replace: boolean;
}

export interface BudgetReadCommandOptions extends BudgetCommonOptions {
  action: "report" | "observe";
}

export interface BudgetDecisionCommandOptions extends BudgetCommonOptions {
  action: "decide";
  observation: string;
  decision: "continue" | "split" | "supersede" | "rotate";
  addedAllowance?: number;
  reason: string;
  evidence: string[];
}

export type BudgetCommandOptions = BudgetPolicyCommandOptions | BudgetReadCommandOptions | BudgetDecisionCommandOptions;

interface RotationCommonOptions {
  directory: string;
  json: boolean;
  actor: string;
}

export interface RotationPolicyCommandOptions extends RotationCommonOptions {
  action: "set" | "replace";
  rootSessionId: string;
  startEvent: string;
  thresholds: {
    supervisorContextPercent?: number;
    compactions?: number;
    waitCalls?: number;
    waitDurationMs?: number;
    completedTasks?: number;
  };
  reason: string;
  evidence: string[];
  replace: boolean;
}

export interface RotationReadCommandOptions extends RotationCommonOptions {
  action: "suggest" | "report" | "prepare";
}

export interface RotationVerifyCommandOptions extends RotationCommonOptions {
  action: "verify";
  recommendation: string;
  rootSessionId: string;
}

export type RotationCommandOptions = RotationPolicyCommandOptions | RotationReadCommandOptions | RotationVerifyCommandOptions;

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

function hasHelpFlagAfterAction(args: string[]): boolean {
  return args[1] === "-h" || args[1] === "--help";
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
  args = parseOutputViewArgs(args).args;
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

export function parseStatusArgs(args: string[]): StatusOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const options: StatusOptions = { directory: ".", json: false };
  let hasDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--explain") options.explain = true;
    else if (arg === "--active-only") {
      if (options.activeOnly) {
        throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "The --active-only selector may be specified only once.", {
          details: { option: "--active-only" }
        });
      }
      options.activeOnly = true;
    } else if (arg === "--changed-since-checkpoint") {
      if (options.changedSinceCheckpoint) {
        throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "The --changed-since-checkpoint selector may be specified only once.", {
          details: { option: "--changed-since-checkpoint" }
        });
      }
      options.changedSinceCheckpoint = true;
    } else if (arg === "--task") {
      if (options.taskId !== undefined) {
        throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "The --task selector may be specified only once for status.", {
          details: { option: "--task" }
        });
      }
      options.taskId = optionValue(args, index, arg).trim().toUpperCase();
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
  const selectorCount = Number(options.taskId !== undefined) + Number(Boolean(options.activeOnly))
    + Number(Boolean(options.changedSinceCheckpoint));
  if (selectorCount > 1) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Status selectors are mutually exclusive.", {
      details: {
        selectors: [
          ...(options.taskId === undefined ? [] : ["--task"]),
          ...(options.activeOnly ? ["--active-only"] : []),
          ...(options.changedSinceCheckpoint ? ["--changed-since-checkpoint"] : [])
        ]
      }
    });
  }
  if (selectorCount > 0 && options.explain) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Status selectors cannot be combined with --explain.", {
      details: { option: "--explain" }
    });
  }
  return options;
}

export function parseUsageArgs(
  args: string[],
  { cwd = process.cwd() }: { cwd?: string } = {}
): UsageOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
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
    } else if (["--session", "--cwd", "--since-event", "--task", "--until-event", "--price-file"].includes(arg)) {
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
      } else if (arg === "--until-event") {
        if (options.untilEvent !== undefined) {
          throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "Usage selectors cannot be repeated.");
        }
        options.untilEvent = value;
      } else {
        if (options.priceFile !== undefined) throw new SynodError(ERROR_CODES.COST_PRICE_INVALID, "Usage price files cannot be repeated.");
        options.priceFile = value;
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
  if (options.untilEvent !== undefined && selectors === 0) {
    throw new SynodError(ERROR_CODES.USAGE_INTERVAL_INVALID, "--until-event requires one usage start selector.");
  }
  return options;
}

export function parseWaitArgs(
  args: string[],
  { cwd = process.cwd() }: { cwd?: string } = {}
): WaitCommandOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const options: WaitCommandOptions = {
    cwd,
    json: false,
    threadIds: [],
    taskIds: [],
    timeoutMs: 5 * 60_000,
    pollIntervalMs: 1_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") options.json = true;
    else if (["--thread", "--task", "--cwd", "--timeout-seconds", "--poll-interval-ms"].includes(arg)) {
      const value = optionValue(args, index, arg);
      if (arg === "--thread") options.threadIds.push(value);
      else if (arg === "--task") options.taskIds.push(value);
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
  options.taskIds = [...new Set(options.taskIds.map(value => value.trim().toUpperCase()).filter(Boolean))];
  if (options.threadIds.length === 0 && options.taskIds.length === 0) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Wait requires at least one --task <task-id> or --thread <thread-id>.");
  }
  return options;
}

export function parseDelegateArgs(args: string[]): DelegateCommandOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (action !== "start" && action !== "complete") {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown delegate action: ${action}`, { details: { action } });
  }
  if (hasHelpFlagAfterAction(args)) return { help: true };
  const id = args[1];
  if (!id || id.startsWith("-")) {
    throw new SynodError(
      ERROR_CODES.UNEXPECTED_ARGUMENT,
      action === "complete" ? "Delegate complete requires a task ID." : "Delegate start requires a task ID."
    );
  }
  if (action === "complete") {
    const options: DelegateCompleteCommandOptions = {
      action: "complete",
      id,
      cwd: ".",
      json: false,
      actor: "supervisor",
      ownerThread: "",
      evidence: []
    };
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg) continue;
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--json") { options.json = true; continue; }
      const valueOptions = ["--cwd", "--actor", "--owner-thread", "--evidence", "--ttl-seconds", "--heartbeat-seconds"];
      if (!valueOptions.includes(arg)) {
        if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
        throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
      }
      const value = optionValue(args, index, arg);
      if (arg === "--cwd") options.cwd = value;
      else if (arg === "--actor") options.actor = value;
      else if (arg === "--owner-thread") options.ownerThread = value;
      else if (arg === "--evidence") options.evidence.push(value);
      else if (arg === "--ttl-seconds") options.ttlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      else options.heartbeatIntervalSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      index += 1;
    }
    if (!options.ownerThread.trim()) {
      throw new SynodError(ERROR_CODES.HOST_OWNER_MISSING, "Delegate complete requires --owner-thread.");
    }
    for (const [name, value] of [
      ["--ttl-seconds", options.ttlSeconds],
      ["--heartbeat-seconds", options.heartbeatIntervalSeconds]
    ] as const) {
      if (value !== undefined && Number.isNaN(value)) {
        throw new SynodError(ERROR_CODES.LEASE_INVALID, `Delegate complete requires an integer value for ${name}.`, { details: { option: name } });
      }
    }
    return { ...options, ownerThread: options.ownerThread.trim(), evidence: [...new Set(options.evidence)] };
  }
  const options: DelegateStartCommandOptions = {
    action: "start",
    id,
    cwd: ".",
    json: false,
    actor: "supervisor",
    read: [],
    write: [],
    readTree: [],
    writeTree: [],
    evidence: [],
    wait: false,
    timeoutMs: 5 * 60_000,
    pollIntervalMs: 1_000
  };
  let role: DelegationRole | undefined;
  let timeoutSpecified = false;
  let pollIntervalSpecified = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--wait") { options.wait = true; continue; }
    const valueOptions = [
      "--cwd", "--actor", "--role", "--read", "--write", "--read-tree", "--write-tree", "--evidence",
      "--reservation-ttl-seconds", "--ttl-seconds", "--heartbeat-seconds", "--timeout-seconds", "--poll-interval-ms"
    ];
    if (!valueOptions.includes(arg)) {
      if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    const value = optionValue(args, index, arg);
    if (arg === "--cwd") options.cwd = value;
    else if (arg === "--actor") options.actor = value;
    else if (arg === "--role") {
      if (value !== "implementer" && value !== "reviewer" && value !== "verifier") {
        throw new SynodError(ERROR_CODES.DELEGATION_ROLE_INVALID, `Delegate start role must be implementer, reviewer, or verifier.`, {
          details: { role: value, allowed: ["implementer", "reviewer", "verifier"] }
        });
      }
      role = value;
    }
    else if (arg === "--read") options.read.push(value);
    else if (arg === "--write") options.write.push(value);
    else if (arg === "--read-tree") options.readTree.push(value);
    else if (arg === "--write-tree") options.writeTree.push(value);
    else if (arg === "--evidence") options.evidence.push(value);
    else if (arg === "--reservation-ttl-seconds") options.reservationTtlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--ttl-seconds") options.ttlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--heartbeat-seconds") options.heartbeatIntervalSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--timeout-seconds") {
      timeoutSpecified = true;
      const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3_600) {
        throw new SynodError(ERROR_CODES.WAIT_INVALID, "Delegate wait timeout must be an integer from 1 through 3600 seconds.");
      }
      options.timeoutMs = seconds * 1_000;
    } else {
      pollIntervalSpecified = true;
      const interval = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(interval) || interval < 100 || interval > 5_000) {
        throw new SynodError(ERROR_CODES.WAIT_INVALID, "Delegate wait poll interval must be an integer from 100 through 5000 milliseconds.");
      }
      options.pollIntervalMs = interval;
    }
    index += 1;
  }
  if (!options.wait && (timeoutSpecified || pollIntervalSpecified)) {
    throw new SynodError(ERROR_CODES.WAIT_INVALID, "Delegate wait timeout and poll options require --wait.");
  }
  for (const [name, value] of [
    ["--reservation-ttl-seconds", options.reservationTtlSeconds],
    ["--ttl-seconds", options.ttlSeconds],
    ["--heartbeat-seconds", options.heartbeatIntervalSeconds]
  ] as const) {
    if (value !== undefined && Number.isNaN(value)) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Delegate start requires an integer value for ${name}.`, { details: { option: name } });
    }
  }
  return { ...options, ...(role === undefined ? {} : { role }), evidence: [...new Set(options.evidence)] };
}

export function parseCheckpointArgs(args: string[]): CheckpointOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
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
  args = parseOutputViewArgs(args).args;
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
  args = parseOutputViewArgs(args).args;
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
  let includeLocalDocs = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (arg === "--include-untracked" && action === "export") includeUntracked = true;
    else if (arg === "--include-local-docs" && (action === "export" || action === "restore")) includeLocalDocs = true;
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
  if (action === "export") return {
    action,
    directory,
    destination: positional,
    includeUntracked,
    ...(includeLocalDocs ? { includeLocalDocs: true } : {}),
    json
  };
  if (action === "restore") {
    if (!hasDirectory) {
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Bundle restore requires --cwd <directory>.", {
        details: { option: "--cwd" }
      });
    }
    return {
      action,
      bundle: positional,
      directory,
      ...(includeLocalDocs ? { includeLocalDocs: true } : {}),
      json
    };
  }
  return { action, bundle: positional, json };
}

export function parseLeaseArgs(args: string[]): LeaseCommandOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["reserve", "bind", "cancel", "acquire", "heartbeat", "release", "expire", "revoke", "recover"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown lease action: ${action}`, { details: { action } });
  }
  if (hasHelpFlagAfterAction(args)) return { help: true };
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
  let reservationToken: string | undefined;
  let expectedReservedAt: string | undefined;
  let baselineHash: string | undefined;
  let ttlSeconds: number | undefined;
  let reservationTtlSeconds: number | undefined;
  let heartbeatIntervalSeconds: number | undefined;
  let reason: string | undefined;
  let decision: "resume" | "reassign" | "supersede" | undefined;
  const read: string[] = [];
  const write: string[] = [];
  const readTree: string[] = [];
  const writeTree: string[] = [];
  const evidence: string[] = [];
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
      "--reservation-token", "--expected-reserved-at", "--baseline-hash", "--ttl-seconds", "--reservation-ttl-seconds",
      "--heartbeat-seconds", "--reason", "--decision", "--read", "--write", "--read-tree", "--write-tree", "--evidence"
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
    else if (arg === "--reservation-token") reservationToken = value;
    else if (arg === "--expected-reserved-at") expectedReservedAt = value;
    else if (arg === "--baseline-hash") baselineHash = value;
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
    else if (arg === "--evidence") evidence.push(value);
    else if (arg === "--generation") generation = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--revision") revision = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--ttl-seconds") ttlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--reservation-ttl-seconds") reservationTtlSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else heartbeatIntervalSeconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    index += 1;
  }
  for (const [option, value] of [
    ["--generation", generation],
    ["--revision", revision],
    ["--ttl-seconds", ttlSeconds],
    ["--reservation-ttl-seconds", reservationTtlSeconds],
    ["--heartbeat-seconds", heartbeatIntervalSeconds]
  ] as const) {
    if (value !== undefined && Number.isNaN(value)) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} requires an integer value for ${option}.`, {
        details: { option }
      });
    }
  }
  const hasReservationFence = reservationToken !== undefined || expectedReservedAt !== undefined || baselineHash !== undefined;
  const reservationFenceComplete = reservationToken !== undefined
    && leaseId !== undefined
    && generation !== undefined
    && revision !== undefined
    && expectedReservedAt !== undefined
    && baselineHash !== undefined;
  if (action === "acquire") {
    if (leaseId !== undefined || generation !== undefined || revision !== undefined || expectedHeartbeatAt !== undefined
      || hasReservationFence || reservationTtlSeconds !== undefined || evidence.length > 0 || reason !== undefined || decision !== undefined) {
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
      ...(write.length === 0 && writeTree.length === 0 ? { observer: true as const } : {}),
      ...(ownerThread === undefined ? {} : { ownerThread }),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds })
    };
  }
  if (action === "reserve") {
    if (ownerThread !== undefined || leaseId !== undefined || generation !== undefined || revision !== undefined
      || expectedHeartbeatAt !== undefined || hasReservationFence || ttlSeconds !== undefined
      || heartbeatIntervalSeconds !== undefined || evidence.length > 0 || reason !== undefined || decision !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Lease reserve received a bind- or mutation-only option.");
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
      ...(write.length === 0 && writeTree.length === 0 ? { observer: true as const } : {}),
      ...(reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds })
    };
  }
  if (action === "bind") {
    if (read.length > 0 || write.length > 0 || readTree.length > 0 || writeTree.length > 0
      || reservationTtlSeconds !== undefined || expectedHeartbeatAt !== undefined || reason !== undefined || decision !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Lease bind received a reserve- or active-mutation-only option.");
    }
    if (!reservationFenceComplete || !ownerThread) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, "Lease bind requires the complete reservation fence and --owner-thread.");
    }
    return {
      action,
      id,
      directory,
      json,
      actor,
      reservationToken: reservationToken!,
      leaseId: leaseId!,
      generation: generation!,
      revision: revision!,
      expectedReservedAt: expectedReservedAt!,
      baselineHash: baselineHash!,
      ownerThread,
      evidence,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      ...(heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds })
    };
  }
  if (action === "cancel" || (action === "expire" && hasReservationFence)) {
    if (read.length > 0 || write.length > 0 || readTree.length > 0 || writeTree.length > 0
      || reservationTtlSeconds !== undefined || ttlSeconds !== undefined || heartbeatIntervalSeconds !== undefined
      || expectedHeartbeatAt !== undefined || ownerThread !== undefined || evidence.length > 0 || decision !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Lease ${action} reservation cleanup received an incompatible option.`);
    }
    if (!reservationFenceComplete || !reason) {
      throw new SynodError(ERROR_CODES.LEASE_INVALID, `Lease ${action} reservation cleanup requires the complete reservation fence and --reason.`);
    }
    return {
      action,
      id,
      directory,
      json,
      actor,
      reservationToken: reservationToken!,
      leaseId: leaseId!,
      generation: generation!,
      revision: revision!,
      expectedReservedAt: expectedReservedAt!,
      baselineHash: baselineHash!,
      reason
    };
  }
  if (read.length > 0 || write.length > 0 || readTree.length > 0 || writeTree.length > 0
    || ttlSeconds !== undefined || reservationTtlSeconds !== undefined || heartbeatIntervalSeconds !== undefined
    || hasReservationFence || evidence.length > 0) {
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
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["create", "seal", "integrate", "cleanup", "status"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown worktree action: ${action}`, { details: { action } });
  }
  if (hasHelpFlagAfterAction(args)) return { help: true };
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
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["add", "transition", "approve", "approval", "record-approval", "correct", "override", "split", "next"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown task action: ${action}`, { details: { action } });
  }
  if (hasHelpFlagAfterAction(args)) return { help: true };
  if (action === "next") {
    let directory = ".";
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--json") json = true;
      else if (arg === "--cwd") { directory = optionValue(args, index, arg); index += 1; }
      else if (arg?.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      else throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    return { action, directory, json, actor: "supervisor" };
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
  let role: "reviewer" | "verifier" | undefined;
  let decision: "approved" | "rejected" | undefined;
  let proposalBundleId: string | undefined;
  let ownerThread: string | undefined;
  const acceptance: string[] = [];
  const verification: string[] = [];
  const dependsOn: string[] = [];
  const evidence: string[] = [];
  const replacements: string[] = [];
  const start = action === "transition" ? 3 : 2;

  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    const valueOptions = [
      "--cwd", "--objective", "--executor", "--actor", "--reason",
      "--acceptance", "--verification", "--depends-on", "--evidence", "--revision",
      "--correction-limit", "--additional-rounds", "--approver", "--reference", "--replacement",
      "--role", "--decision", "--proposal-bundle-id", "--owner-thread"
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
      else if (arg === "--role") {
        if (value !== "reviewer" && value !== "verifier") {
          throw new SynodError(ERROR_CODES.APPROVAL_INVALID, "Task approval role must be reviewer or verifier.", { details: { role: value } });
        }
        role = value;
      }
      else if (arg === "--decision") {
        if (value !== "approved" && value !== "rejected") {
          throw new SynodError(ERROR_CODES.APPROVAL_INVALID, "Task approval decision must be approved or rejected.", { details: { decision: value } });
        }
        decision = value;
      }
      else if (arg === "--proposal-bundle-id") proposalBundleId = value;
      else if (arg === "--owner-thread") ownerThread = value;
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
      || approver !== undefined || reference !== undefined || replacements.length > 0
      || role !== undefined || decision !== undefined || proposalBundleId !== undefined || ownerThread !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task add received a transition-only option.");
    }
    if (correctionLimit !== undefined && Number.isNaN(correctionLimit)) throw new SynodError(ERROR_CODES.TASK_INVALID, "Task add requires an integer --correction-limit.");
    return { action, id, directory, json, actor, objective, executor, acceptance, verification, dependsOn, ...(correctionLimit === undefined ? {} : { correctionLimit }) };
  }
  if (action === "approve" || action === "approval" || action === "record-approval") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || correctionLimit !== undefined || additionalRounds !== undefined
      || approver !== undefined || reference !== undefined || replacements.length > 0 || reason !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task approval received an unrelated task option.");
    }
    if (!role || !decision || revision === undefined || !Number.isSafeInteger(revision) || revision < 0
      || !proposalBundleId || !ownerThread || evidence.length === 0) {
      throw new SynodError(ERROR_CODES.APPROVAL_INVALID, "Task approval requires --role, --decision, --revision, --proposal-bundle-id, --owner-thread, and --evidence.");
    }
    return {
      action: "approve",
      id,
      directory,
      json,
      actor,
      role,
      decision,
      revision,
      proposalBundleId,
      ownerThread,
      evidence: [...new Set(evidence)]
    };
  }
  if (action === "override") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || revision !== undefined || correctionLimit !== undefined || replacements.length > 0
      || role !== undefined || decision !== undefined || proposalBundleId !== undefined || ownerThread !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task override received an unrelated task option.");
    }
    if (!additionalRounds || Number.isNaN(additionalRounds) || !approver || !reference || !reason || evidence.length === 0) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, "Task override requires --additional-rounds, --approver, --reference, --reason, and --evidence.");
    }
    return { action, id, directory, json, actor, additionalRounds, approver, reference, reason, evidence };
  }
  if (action === "correct") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || correctionLimit !== undefined || additionalRounds !== undefined
      || approver !== undefined || reference !== undefined || replacements.length > 0
      || role !== undefined || decision !== undefined || proposalBundleId !== undefined || ownerThread !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task correct received an unrelated task option.");
    }
    if (!reason || evidence.length === 0 || revision === undefined || !Number.isSafeInteger(revision) || revision < 0) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, "Task correct requires --revision, --reason, and --evidence.");
    }
    return { action, id, directory, json, actor, reason, revision, evidence: [...new Set(evidence)] };
  }
  if (action === "split") {
    if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0
      || dependsOn.length > 0 || revision !== undefined || correctionLimit !== undefined || additionalRounds !== undefined
      || approver !== undefined || reference !== undefined || role !== undefined || decision !== undefined
      || proposalBundleId !== undefined || ownerThread !== undefined) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task split received an unrelated task option.");
    }
    if (replacements.length < 2 || !reason || evidence.length === 0) {
      throw new SynodError(ERROR_CODES.TASK_INVALID, "Task split requires at least two --replacement values, --reason, and --evidence.");
    }
    return { action, id, directory, json, actor, replacements, reason, evidence };
  }
  if (objective !== undefined || executor !== undefined || acceptance.length > 0 || verification.length > 0 || dependsOn.length > 0
    || correctionLimit !== undefined || additionalRounds !== undefined || approver !== undefined || reference !== undefined || replacements.length > 0
    || role !== undefined || decision !== undefined || proposalBundleId !== undefined || ownerThread !== undefined) {
    throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, "Task transition received a task-definition option.");
  }
  if (!to) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Task transition is missing a target state.");
  return { action: "transition", id, to, directory, json, actor, reason, revision, evidence };
}

export function parseProposalArgs(args: string[]): ProposalSubmitOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (action !== "submit") throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown proposal action: ${action}`, { details: { action } });
  if (hasHelpFlagAfterAction(args)) return { help: true };
  const id = args[1];
  if (!id || id.startsWith("-")) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, "Proposal submit requires a task ID.");
  let directory = ".";
  let json = false;
  let actor = "supervisor";
  const evidence: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (["--cwd", "--actor", "--evidence"].includes(String(arg))) {
      const value = optionValue(args, index, String(arg));
      if (arg === "--cwd") directory = value;
      else if (arg === "--actor") actor = value;
      else evidence.push(value);
      index += 1;
    } else if (arg?.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
    else throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
  }
  if (evidence.length === 0) throw new SynodError(ERROR_CODES.EVIDENCE_REQUIRED, "Proposal submit requires at least one --evidence reference.");
  return { action, id, directory, json, actor, evidence: [...new Set(evidence)] };
}

export function parseBudgetArgs(args: string[]): BudgetCommandOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["set", "replace", "report", "observe", "decide"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown budget action: ${action}`, { details: { action } });
  }
  const id = args[1];
  if (!id || id.startsWith("-")) throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Budget ${action} requires a task ID.`);
  let directory = ".";
  let json = false;
  let actor = "supervisor";
  let rootSessionId: string | undefined;
  let startEvent: string | undefined;
  let softTotalTokens: number | undefined;
  let hardTotalTokens: number | undefined;
  let observation: string | undefined;
  let decision: BudgetDecisionCommandOptions["decision"] | undefined;
  let addedAllowance: number | undefined;
  let reason: string | undefined;
  const evidence: string[] = [];
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--json") { json = true; continue; }
    const valueOptions = [
      "--cwd", "--actor", "--session", "--since-event", "--soft-tokens", "--hard-tokens",
      "--observation", "--decision", "--additional-tokens", "--reason", "--evidence"
    ];
    if (!valueOptions.includes(arg)) {
      if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    if (arg !== "--evidence" && seen.has(arg)) {
      throw new SynodError(ERROR_CODES.BUDGET_INVALID, `Budget option cannot be repeated: ${arg}.`, { details: { option: arg } });
    }
    seen.add(arg);
    const value = optionValue(args, index, arg);
    if (arg === "--cwd") directory = value;
    else if (arg === "--actor") actor = value;
    else if (arg === "--session") rootSessionId = value;
    else if (arg === "--since-event") startEvent = value;
    else if (arg === "--soft-tokens") softTotalTokens = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--hard-tokens") hardTotalTokens = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--observation") observation = value;
    else if (arg === "--decision") decision = value as BudgetDecisionCommandOptions["decision"];
    else if (arg === "--additional-tokens") addedAllowance = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    else if (arg === "--reason") reason = value;
    else evidence.push(value);
    index += 1;
  }
  const common = { id, directory, json, actor };
  if (action === "report" || action === "observe") {
    if (rootSessionId !== undefined || startEvent !== undefined || softTotalTokens !== undefined || hardTotalTokens !== undefined
      || observation !== undefined || decision !== undefined || addedAllowance !== undefined || reason !== undefined || evidence.length > 0) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Budget ${action} received a mutation-only option.`);
    }
    return { action, ...common };
  }
  if (action === "set" || action === "replace") {
    if (!rootSessionId || !startEvent || (softTotalTokens === undefined && hardTotalTokens === undefined)
      || Number.isNaN(softTotalTokens) || Number.isNaN(hardTotalTokens) || !reason || evidence.length === 0
      || observation !== undefined || decision !== undefined || addedAllowance !== undefined) {
      throw new SynodError(ERROR_CODES.BUDGET_INVALID, `Budget ${action} requires --session, --since-event, a soft or hard token limit, --reason, and --evidence.`);
    }
    return {
      action,
      ...common,
      rootSessionId,
      startEvent,
      ...(softTotalTokens === undefined ? {} : { softTotalTokens }),
      ...(hardTotalTokens === undefined ? {} : { hardTotalTokens }),
      reason,
      evidence,
      replace: action === "replace"
    };
  }
  if (!observation || !decision || !(["continue", "split", "supersede", "rotate"] as string[]).includes(decision)
    || !reason || evidence.length === 0 || (decision === "continue" ? !addedAllowance || Number.isNaN(addedAllowance) : addedAllowance !== undefined)
    || rootSessionId !== undefined || startEvent !== undefined || softTotalTokens !== undefined || hardTotalTokens !== undefined) {
    throw new SynodError(ERROR_CODES.BUDGET_INVALID, "Budget decide requires --observation, --decision, --reason, --evidence, and --additional-tokens only for continue.");
  }
  return { action: "decide", ...common, observation, decision, ...(addedAllowance === undefined ? {} : { addedAllowance }), reason, evidence };
}

export function parseRotationArgs(args: string[]): RotationCommandOptions | HelpOptions {
  args = parseOutputViewArgs(args).args;
  const action = args[0];
  if (!action || action === "-h" || action === "--help") return { help: true };
  if (!["set", "replace", "suggest", "report", "prepare", "verify"].includes(action)) {
    throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unknown rotation action: ${action}`, { details: { action } });
  }
  let directory = ".";
  let json = false;
  let actor = "supervisor";
  let rootSessionId: string | undefined;
  let startEvent: string | undefined;
  let recommendation: string | undefined;
  let reason: string | undefined;
  const evidence: string[] = [];
  const thresholds: RotationPolicyCommandOptions["thresholds"] = {};
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--json") { json = true; continue; }
    const valueOptions = [
      "--cwd", "--actor", "--session", "--since-event", "--recommendation", "--reason", "--evidence",
      "--context-percent", "--compactions", "--wait-calls", "--wait-duration-ms", "--completed-tasks"
    ];
    if (!valueOptions.includes(arg)) {
      if (arg.startsWith("-")) throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Unknown option: ${arg}`, { details: { option: arg } });
      throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${arg}`, { details: { argument: arg } });
    }
    if (arg !== "--evidence" && seen.has(arg)) {
      throw new SynodError(ERROR_CODES.ROTATION_INVALID, `Rotation option cannot be repeated: ${arg}.`, { details: { option: arg } });
    }
    seen.add(arg);
    const value = optionValue(args, index, arg);
    if (arg === "--cwd") directory = value;
    else if (arg === "--actor") actor = value;
    else if (arg === "--session") rootSessionId = value;
    else if (arg === "--since-event") startEvent = value;
    else if (arg === "--recommendation") recommendation = value;
    else if (arg === "--reason") reason = value;
    else if (arg === "--evidence") evidence.push(value);
    else {
      const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (arg === "--context-percent") thresholds.supervisorContextPercent = numeric;
      else if (arg === "--compactions") thresholds.compactions = numeric;
      else if (arg === "--wait-calls") thresholds.waitCalls = numeric;
      else if (arg === "--wait-duration-ms") thresholds.waitDurationMs = numeric;
      else thresholds.completedTasks = numeric;
    }
    index += 1;
  }
  const common = { directory, json, actor };
  if (action === "suggest" || action === "report" || action === "prepare") {
    if (rootSessionId !== undefined || startEvent !== undefined || recommendation !== undefined || reason !== undefined
      || evidence.length > 0 || Object.keys(thresholds).length > 0) {
      throw new SynodError(ERROR_CODES.UNKNOWN_OPTION, `Rotation ${action} received a mutation-only option.`);
    }
    return { action, ...common };
  }
  if (action === "verify") {
    if (!recommendation || !rootSessionId || startEvent !== undefined || reason !== undefined || evidence.length > 0 || Object.keys(thresholds).length > 0) {
      throw new SynodError(ERROR_CODES.ROTATION_INVALID, "Rotation verify requires --recommendation and --session only.");
    }
    return { action, ...common, recommendation, rootSessionId };
  }
  if (!rootSessionId || !startEvent || !reason || evidence.length === 0 || Object.keys(thresholds).length === 0
    || Object.values(thresholds).some(value => !Number.isSafeInteger(value) || value <= 0)
    || (thresholds.supervisorContextPercent !== undefined && thresholds.supervisorContextPercent > 100)
    || recommendation !== undefined) {
    throw new SynodError(ERROR_CODES.ROTATION_INVALID, `Rotation ${action} requires --session, --since-event, at least one positive threshold, --reason, and --evidence.`);
  }
  return { action: action as "set" | "replace", ...common, rootSessionId, startEvent, thresholds, reason, evidence, replace: action === "replace" };
}
