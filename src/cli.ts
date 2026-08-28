import { errorEnvelope, successEnvelope, WARNING_CODES, warning } from "./contracts.js";
import type { Warning } from "./contracts.js";
import { parseBudgetArgs, parseBundleArgs, parseCheckpointArgs, parseDelegateArgs, parseHandoffArgs, parseLeaseArgs, parseLifecycleArgs, parseProposalArgs, parseRotationArgs, parseStatusArgs, parseTaskArgs, parseUsageArgs, parseWaitArgs, parseWorktreeArgs } from "./command-options.js";
import type { HelpOptions, LifecycleOptions } from "./command-options.js";
import { doctorProject } from "./doctor.js";
import type { DoctorClient, DoctorDependencies } from "./doctor.js";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { checkProject, initProject, uninstallProject, upgradeProject } from "./lifecycle.js";
import type { LifecycleDependencies, LifecycleResult } from "./lifecycle.js";
import { packageVersion } from "./package.js";
import { FALLBACK_PROFILE, listProfiles, PREFERRED_PROFILE } from "./profiles.js";
import type { ProfileSelection } from "./profiles.js";
import { readManifest } from "./manifest.js";
import { collectUsage, formatUsageReport } from "./usage.js";
import { effectiveHardTotalTokens } from "./budgets.js";
import { isLegacyHostOwnerThread, isValidCodexThreadId } from "./leases.js";
import {
  addTask,
  acquireTaskLease,
  bindTaskLease,
  cancelTaskLeaseReservation,
  expireTaskLease,
  expireTaskLeaseReservation,
  formatOrchestrationStatus,
  heartbeatTaskLease,
  recordCheckpoint,
  recordTaskApproval,
  recordTaskCorrection,
  recoverTaskLease,
  releaseTaskLease,
  reserveTaskLease,
  refreshTaskBudget,
  revokeTaskLease,
  overrideCorrectionPolicy,
  splitTask,
  decideTaskBudget,
  formatTaskBudgetReport,
  observeTaskBudget,
  nextTaskGuidance,
  prepareProjectRotation,
  reportProjectRotation,
  suggestProjectRotation,
  reportTaskBudget,
  setRotationPolicy,
  setTaskBudgetPolicy,
  submitTaskProposal,
  transitionTask,
  orchestrationStatusWithArtifacts,
  verifyProjectRotation
} from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import type { UsageClient } from "./usage.js";
import { isRecord } from "./validation.js";
import { exportRecoveryBundle, verifyRecoveryBundle } from "./recovery.js";
import { restoreRecoveryBundle } from "./restore.js";
import { formatHandoff, generateHandoff } from "./handoff.js";
import { formatWaitReport, resolveWaitSelection, waitForThreads, type WaitChildLoss } from "./wait.js";
import type { ThreadStatusAdapter, WaitClient, WaitRuntime, WaitSelection } from "./wait.js";
import { cleanupTaskWorktree, createTaskWorktree, integrateTaskWorktreeProposal, sealTaskWorktreeProposal, taskWorktreeStatus } from "./worktrees.js";
import type { TaskWorktreeDependencies } from "./worktrees.js";
import { formatRotationReport, formatRotationSuggestion } from "./rotation.js";
import { formatCostReport, projectUsageCost, readPriceFile } from "./costs.js";
import { parseOutputViewArgs, projectJsonEnvelope } from "./output-view.js";
import type { JsonEnvelopeLike, OutputView } from "./output-view.js";
import { resolveCodexRuntime } from "./codex-runtime.js";
import {
  completeHostDelegation,
  isCodexHostOperator,
  resolveHostDelegationAdapter,
  selectHostDelegationAdapter,
  startHostDelegation,
  startHostDelegationHandoff
} from "./host-delegation.js";
import type { HostDelegationAdapter } from "./host-delegation.js";
import { createCliAppServerAdapter, disposeCliAppServerOwner, findCliAppServerWaitClient } from "./cli-app-server-adapter.js";
import type { CliAppServerAdapterOptions } from "./cli-app-server-adapter.js";

function shellQuoteDisplayArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatHostHandoffCommand(command: { argv: string[]; requirements: string[] }): string {
  const missing = new Set(command.requirements);
  const rendered = command.argv.flatMap(argument => {
    const requirement = argument.startsWith("--") ? argument.slice(2) : undefined;
    return [
      shellQuoteDisplayArgument(argument),
      ...(requirement && missing.has(requirement) ? [`<${requirement}>`] : [])
    ];
  });
  return ["synod", ...rendered].join(" ");
}

const HELP = `Synod ${packageVersion}

Install and operate a persistent, reviewed advisor loop for Codex projects.

Usage:
  synod init [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod upgrade [directory] [--profile <id>] [--dry-run] [--force] [--json]
  synod check [directory] [--json]
  synod status [directory] [--task <task-id> | --active-only | --changed-since-checkpoint] [--explain] [--json]
  synod handoff [directory] [--bundle <bundle>] [--json]
  synod checkpoint [directory] [--actor <id>] [--message <text>] [--json]
  synod bundle export <destination> [--cwd <directory>] [--include-untracked] [--include-local-docs] [--json]
  synod bundle verify <bundle> [--json]
  synod bundle restore <bundle> --cwd <directory> [--include-local-docs] [--json]
  synod task add <task-id> --objective <text> --executor <id> --acceptance <criterion> --verification <command> [--depends-on <task-id>] [--planned-read <path>] [--planned-write <path>] [--planned-read-tree <path>] [--planned-write-tree <path>] [--correction-limit <n>] [--cwd <directory>] [--json]
  synod task transition <task-id> <state> --revision <n> [--evidence <reference>] [--reason <text>] [--actor <id>] [--cwd <directory>] [--json]
  synod task approve <task-id> --role <reviewer|verifier> --decision <approved|rejected> --revision <n> --proposal-bundle-id <bundle> --owner-thread <thread-id> --evidence <reference> [--actor <id>] [--cwd <directory>] [--json]
  synod task correct <task-id> --revision <n> --reason <text> --evidence <reference> [--actor <id>] [--cwd <directory>] [--json]
  synod task override <task-id> --additional-rounds <n> --approver <id> --reference <ref> --reason <text> --evidence <ref> [--cwd <directory>] [--json]
  synod task split <task-id> --replacement <task-id> --replacement <task-id> --reason <text> --evidence <ref> [--cwd <directory>] [--json]
  synod task next [--cwd <directory>] [--json]
  synod proposal submit <task-id> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod budget set <task-id> --session <thread-id> --since-event <sequence|id> [--soft-tokens <n>] [--hard-tokens <n>] --reason <text> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod budget replace <task-id> --session <thread-id> --since-event <sequence|id> [--soft-tokens <n>] [--hard-tokens <n>] --reason <text> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod budget report <task-id> [--cwd <directory>] [--json]
  synod budget observe <task-id> [--actor <id>] [--cwd <directory>] [--json]
  synod budget decide <task-id> --observation <sequence|id> --decision <continue|split|supersede|rotate> [--additional-tokens <n>] --reason <text> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod rotation set --session <thread-id> --since-event <sequence|id> [--context-percent <n>] [--compactions <n>] [--wait-calls <n>] [--wait-duration-ms <n>] [--completed-tasks <n>] --reason <text> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod rotation replace --session <thread-id> --since-event <sequence|id> [thresholds...] --reason <text> --evidence <ref> [--actor <id>] [--cwd <directory>] [--json]
  synod rotation suggest [--cwd <directory>] [--json]
  synod rotation report [--cwd <directory>] [--json]
  synod rotation prepare [--actor <id>] [--cwd <directory>] [--json]
  synod rotation verify --recommendation <sequence|id> --session <new-root-thread-id> [--actor <id>] [--cwd <directory>] [--json]
  synod lease acquire <task-id> --owner-thread <thread-id> [--write <path>] [--write-tree <path>] [--read <path>] [--read-tree <path>] [--ttl-seconds <n>] [--heartbeat-seconds <n>] [--cwd <directory>] [--json]
  synod lease reserve <task-id> [--write <path>] [--write-tree <path>] [--read <path>] [--read-tree <path>] [--reservation-ttl-seconds <n>] [--cwd <directory>] [--json]
  synod lease bind <task-id> --reservation-token <uuid> --lease-id <uuid> --generation <n> --revision <n> --expected-reserved-at <iso> --baseline-hash <sha256> (--owner-thread <id> | --host-handle <handle>) [--thread-id <thread-id>] [--evidence <reference>] [--ttl-seconds <n>] [--heartbeat-seconds <n>] [--cwd <directory>] [--json]
  synod lease cancel <task-id> --reservation-token <uuid> --lease-id <uuid> --generation <n> --revision <n> --expected-reserved-at <iso> --baseline-hash <sha256> --reason <text> [--cwd <directory>] [--json]
  synod lease heartbeat <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod lease release <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod lease expire <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --reason <text> [--cwd <directory>] [--json]
  synod lease expire <task-id> --reservation-token <uuid> --lease-id <uuid> --generation <n> --revision <n> --expected-reserved-at <iso> --baseline-hash <sha256> --reason <text> [--cwd <directory>] [--json]
  synod lease revoke <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --reason <text> [--cwd <directory>] [--json]
  synod lease recover <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --decision <resume|reassign|supersede> --reason <text> [--owner-thread <thread-id>] [--cwd <directory>] [--json]
  synod worktree create <task-id> --destination <path> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod worktree seal <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod worktree integrate <task-id> --lease-id <uuid> --generation <n> --revision <n> --expected-heartbeat-at <iso> --owner-thread <thread-id> [--cwd <directory>] [--json]
  synod worktree cleanup <task-id> [--cwd <directory>] [--json]
  synod worktree status <task-id> [--cwd <directory>] [--json]
  synod doctor [directory] [--json]
  synod uninstall [directory] [--dry-run] [--force] [--json]
  synod profiles [--json]
  synod usage [--session <thread-id>] [--cwd <directory>] [--since-event <sequence|id> | --since-checkpoint | --task <task-id>] [--until-event <sequence|id>] [--price-file <path>] [--by-model] [--json]
  synod wait (--task <task-id> | --thread <thread-id>) [--task <task-id>] [--thread <thread-id>] [--timeout-seconds <n>] [--poll-interval-ms <n>] [--cwd <directory>] [--json]
  synod delegate start <task-id> [--role <implementer|reviewer|verifier>] [--write <path>] [--write-tree <path>] [--read <path>] [--read-tree <path>] [--actor <id>] [--evidence <reference>] [--reservation-ttl-seconds <n>] [--ttl-seconds <n>] [--heartbeat-seconds <n>] [--wait] [--timeout-seconds <n>] [--poll-interval-ms <n>] [--cwd <directory>] [--json]
  synod delegate complete <task-id> (--owner-thread <id> | --host-handle <handle>) [--thread-id <thread-id>] [--wait-authority <host|appServer>] [--actor <id>] [--evidence <reference>] [--ttl-seconds <n>] [--heartbeat-seconds <n>] [--cwd <directory>] [--json]
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
  budget      Report and enforce explicit task-local raw-token budgets.
  rotation    Recommend, prepare, and verify explicit root-session phase rotation.
  lease       Reserve, bind, acquire, and mutate fenced durable writer leases.
  worktree    Create and inspect explicit detached task worktrees at an exact lease base.
  doctor      Probe Codex version, App Server, model, and reasoning capabilities.
  uninstall   Remove the local runtime and unchanged managed content; preserve durable state.
  profiles    List built-in model profiles and their requirements.
  usage       Report attributable token and coordination activity for a session tree or canonical interval.
  wait        Observe child thread status changes without renewing worker leases.
  delegate    Start a host-owned delegation, or complete a reserved host handoff.

Options:
  --profile   Select a built-in model profile for init or upgrade.
  --dry-run   Show the complete lifecycle plan without writing files.
  --force     Replace or remove modified Synod-owned files; never removes user-owned state.
  --session   Select any thread in a session tree. Defaults to the latest session in --cwd.
  --cwd       Select the project directory used to find the latest session.
  --by-model  Group consumption by model (the default and currently supported view).
  --since-event
              Start marginal usage immediately after an exact canonical event.
  --since-checkpoint
              Start marginal usage after the acknowledged canonical checkpoint.
  --task      Select the canonical lifetime of one task.
  --until-event
              Close a marginal interval at an exact canonical event.
  --soft-tokens
              Warn when a task's recorded raw total reaches this positive limit.
  --hard-tokens
              Require an exact supervisor decision at this positive raw-token limit.
  --observation
              Select the exact canonical budget observation being decided.
  --additional-tokens
              Add a bounded hard allowance for a continue decision.
  --price-file
              Project a complete usage report using an explicit dated local price file.
  --thread    Add an explicit Codex thread ID to a bounded status wait.
  --task      Select one exact status task, or resolve a canonical active task for a bounded wait.
  --revision  Require the exact task revision for a transition or correction.
  --evidence  Attach evidence to the exact task revision and current checkpoint.
  --owner-thread
              Compatibility alias for the lease owner identity.
  --host-handle
              Bind host authority to the exact opaque handle returned by the host.
  --thread-id
              Preserve the exact Codex App Server thread ID independently of a host handle.
  --write     Add a repository-relative writer scope to a lease.
  --read      Add a repository-relative read scope to a lease;
              lease acquire/reserve with only read scopes acquires an
              observer lease that never conflicts and never submits proposals.
  --write-tree
              Add a repository-relative writer scope covering a directory tree.
  --read-tree Add a repository-relative read scope covering a directory tree.
  --planned-read
              Add a read-file lane to a task's persisted delegation plan.
  --planned-write
              Add a write-file lane to a task's persisted delegation plan.
  --planned-read-tree
              Add a read-tree lane to a task's persisted delegation plan.
  --planned-write-tree
              Add a write-tree lane to a task's persisted delegation plan.
  --explain   Include a read-only path-level delta from the acknowledged checkpoint.
  --active-only
              Show operationally open, nonterminal tasks only.
  --changed-since-checkpoint
              Show a bounded path delta and counts from the acknowledged checkpoint.
              Status selectors are mutually exclusive and cannot be combined with --explain.
  --include-untracked
              Include acknowledged untracked files in a recovery bundle.
  --include-local-docs
              Explicitly include or restore bounded human-owned docs/synod notes;
              generated STATUS.md and other ignored files remain excluded.
  Delegate start options:
    --actor <id>                   Record the supervisor or host actor identity.
    --role <role>                  Select implementer, reviewer, or verifier (default implementer).
    --evidence <reference>         Attach scoped evidence to a correction bind.
    --reservation-ttl-seconds <n>  Bound the pre-bind reservation lifetime.
    --ttl-seconds <n>              Bound the post-bind writer lease lifetime.
    --heartbeat-seconds <n>        Set the post-bind lease heartbeat interval.
    --timeout-seconds <n>          Bound delegated waiting; requires --wait.
    --poll-interval-ms <n>         Set delegated polling; requires --wait.
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
  waitClientFactory?: (options?: { cwd?: string; codexBin?: string }) => WaitClient;
  waitAdapterFactory?: () => ThreadStatusAdapter;
  hostWaitAdapter?: import("./wait.js").HostWaitAdapter;
  hostDelegationAdapter?: HostDelegationAdapter;
  hostDelegationAdapterFactory?: () => HostDelegationAdapter;
  cliAppServerAdapterFactory?: (options?: CliAppServerAdapterOptions) => HostDelegationAdapter;
  hostRuntimeResolver?: () => import("./codex-runtime.js").ResolvedCodexRuntime;
  hostAdapterEnv?: NodeJS.ProcessEnv;
  waitRuntimeResolver?: () => WaitRuntime;
  waitSelectionResolver?: typeof resolveWaitSelection;
  refreshBudget?: typeof refreshTaskBudget;
  worktreeDependencies?: TaskWorktreeDependencies;
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

function doctorDependenciesForCli(dependencies: CliDependencies): DoctorDependencies {
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
  return {
    ...(doctorClientFactory ? { clientFactory: doctorClientFactory } : {}),
    ...(dependencies.doctorRuntimeResolver ? { runtimeResolver: dependencies.doctorRuntimeResolver } : {})
  };
}

function profileFallbackSelection(
  reason: string,
  details: Record<string, unknown>
): ProfileSelection {
  return {
    profile: FALLBACK_PROFILE,
    source: "fallback",
    reason,
    details: {
      preferredProfile: PREFERRED_PROFILE,
      fallbackProfile: FALLBACK_PROFILE,
      ...details
    },
    warning: warning(
      WARNING_CODES.PROFILE_FALLBACK,
      `Could not confirm ${PREFERRED_PROFILE} model capabilities; using ${FALLBACK_PROFILE}.`,
      {
        preferredProfile: PREFERRED_PROFILE,
        fallbackProfile: FALLBACK_PROFILE,
        reason,
        ...details
      }
    )
  };
}

function createInitProfileSelector(
  dependencies: CliDependencies
): NonNullable<LifecycleDependencies["profileSelector"]> {
  return async ({ directory }) => {
    try {
      const result = await doctorProject(
        { directory, project: false },
        doctorDependenciesForCli(dependencies)
      );
      const preferred = result.profiles.find(item => item.id === PREFERRED_PROFILE);
      if (preferred?.modelCompatible) {
        return {
          profile: PREFERRED_PROFILE,
          source: "capability",
          reason: "model-compatible",
          details: {
            modelCompatible: true,
            codexStatus: result.codex.status,
            codexVersion: result.codex.version
          }
        };
      }
      return profileFallbackSelection(
        preferred ? "model-capabilities-unavailable" : "profile-capability-not-reported",
        {
          modelCompatible: preferred?.modelCompatible ?? null,
          missing: preferred?.missing || [],
          codexStatus: result.codex.status,
          codexVersion: result.codex.version
        }
      );
    } catch (error) {
      const value = asSynodError(error);
      return profileFallbackSelection("capability-discovery-failed", {
        errorCode: value.code,
        errorMessage: value.message
      });
    }
  };
}

function printWarnings(warnings: Warning[] | undefined, output: CliOutput): void {
  for (const item of warnings || []) output.warn(`Warning [${item.code}]: ${item.message}`);
}

function printJsonEnvelope(
  envelope: JsonEnvelopeLike,
  output: CliOutput,
  view: OutputView
): void {
  output.log(JSON.stringify(projectJsonEnvelope(envelope, view), null, 2));
}

function observedOwnerStopped(
  report: { incomplete: boolean; timedOut: boolean; aborted: boolean; hostWaitRequired: boolean; statuses: Array<{ threadId: string; status: { type: string } }> },
  ownerThread: string
): string | undefined {
  if (report.hostWaitRequired || report.timedOut || report.aborted || !isValidCodexThreadId(ownerThread)) return undefined;
  const status = report.statuses.find(item => item.threadId === ownerThread)?.status.type;
  if (status === "systemError") return "worker-stopped";
  return undefined;
}

function waitRecoveryNextCommand(
  selection: WaitSelection,
  report: {
    incomplete: boolean;
    timedOut: boolean;
    aborted: boolean;
    hostWaitRequired: boolean;
    childLoss?: WaitChildLoss;
    statuses: Array<{ threadId: string; status: { type: string } }>;
  }
): Record<string, unknown> | undefined {
  const selected = selection.tasks.find(task => observedOwnerStopped(report, task.ownerThread));
  if (!selected) return undefined;
  const reason = observedOwnerStopped(report, selected.ownerThread);
  if (!reason) return undefined;
  return {
    operation: "lease.revoke",
    argv: [
      "lease", "revoke", selected.taskId,
      "--lease-id", selected.leaseId,
      "--generation", String(selected.generation),
      "--revision", String(selected.revision),
      "--expected-heartbeat-at", selected.expectedHeartbeatAt,
      "--reason", reason
    ],
    fence: {
      leaseId: selected.leaseId,
      generation: selected.generation,
      revision: selected.revision,
      expectedHeartbeatAt: selected.expectedHeartbeatAt,
      ownerThread: selected.ownerThread
    },
    childLoss: report.childLoss,
    requirements: []
  };
}

type WaitBudgetRefresh = NonNullable<Awaited<ReturnType<typeof refreshTaskBudget>>>;

function waitBudgetData(refresh: WaitBudgetRefresh): Record<string, unknown> {
  const budget = refresh.task.budget;
  const observation = refresh.observation;
  return {
    taskId: refresh.task.id,
    policyRevision: budget?.policy.revision,
    thresholdStatus: budget?.thresholdStatus,
    decisionRequired: budget?.thresholdStatus === "decision-required",
    ...(budget ? { effectiveHardTotalTokens: effectiveHardTotalTokens(budget) } : {}),
    ...(observation ? {
      totalTokens: observation.totalTokens,
      observation: observation.event
    } : {}),
    ...(refresh.report ? {
      reportHash: refresh.report.reportHash,
      warnings: refresh.report.warnings
    } : {})
  };
}

function waitBudgetDecisionNextCommand(refresh: WaitBudgetRefresh | undefined): Record<string, unknown> | undefined {
  if (!refresh) return undefined;
  const observation = refresh.observation;
  if (refresh.task.budget?.thresholdStatus !== "decision-required" || !observation) return undefined;
  return {
    operation: "budget.decide",
    argv: ["budget", "decide", refresh.task.id, "--observation", observation.event.id, "--decision"],
    requirements: ["decision", "reason", "evidence"]
  };
}

async function refreshWaitBudgets(
  selection: WaitSelection,
  directory: string,
  dependencies: CliDependencies
): Promise<WaitBudgetRefresh[]> {
  const refreshes: WaitBudgetRefresh[] = [];
  const refresh = dependencies.refreshBudget || refreshTaskBudget;
  for (const selectedTask of selection.tasks) {
    if (!selectedTask.budget) continue;
    const refreshed = await refresh({ directory, id: selectedTask.taskId }, dependencies);
    if (refreshed?.task.budget) refreshes.push(refreshed);
  }
  return refreshes;
}

function waitBudgetWarnings(refresh: WaitBudgetRefresh): Warning[] {
  if (refresh.report) return refresh.report.warnings;
  const status = refresh.task.budget?.thresholdStatus;
  if (status === "decision-required") {
    return [warning(WARNING_CODES.BUDGET_HARD_EXCEEDED, `Task ${refresh.task.id} reached its hard token budget.`)];
  }
  if (status === "soft-exceeded") {
    return [warning(WARNING_CODES.BUDGET_SOFT_EXCEEDED, `Task ${refresh.task.id} reached its soft token budget.`)];
  }
  return [];
}

function budgetPreflightWaitReport(selection: WaitSelection): Awaited<ReturnType<typeof waitForThreads>> {
  return {
    mode: "poll",
    waitAuthority: "canonical",
    threadIds: selection.threadIds,
    wakeCount: 0,
    fallbackPollCount: 0,
    elapsedMs: 0,
    timedOut: false,
    aborted: false,
    incomplete: true,
    approvalNeeded: false,
    userInputNeeded: false,
    hostWaitRequired: false,
    hostWaitThreadIds: [],
    hostWaitHandles: selection.hostWaitHandles || [],
    hostFallbackRequired: false,
    hostFallbackThreadIds: [],
    statuses: [],
    warnings: [],
    diagnostics: {
      waitAuthority: "canonical",
      observation: "budget-preflight"
    }
  };
}

function canonicalOwnerThreadForDisposal(result: unknown, action: string, decision: unknown): string | undefined {
  const appServerOwner = (lease: unknown): string | undefined => {
    if (!isRecord(lease)) return undefined;
    if (lease.waitAuthority === "host") return undefined;
    if (lease.waitAuthority === "appServer") {
      return typeof lease.threadId === "string" && isValidCodexThreadId(lease.threadId) ? lease.threadId : undefined;
    }
    return typeof lease.ownerThread === "string"
      && lease.ownerThread.trim()
      && !isLegacyHostOwnerThread(lease.ownerThread)
      ? lease.ownerThread
      : undefined;
  };
  if (!isRecord(result)) return undefined;
  if (action === "revoke") {
    const lease = isRecord(result.lease) ? result.lease : undefined;
    return appServerOwner(lease);
  }
  if (action !== "recover" || decision === "resume") return undefined;
  const task = isRecord(result.task) ? result.task : undefined;
  const recovery = isRecord(result.recovery)
    ? result.recovery
    : task && isRecord(task.recovery)
      ? task.recovery
      : undefined;
  const recordedDecision = recovery && isRecord(recovery.decision) ? recovery.decision : undefined;
  const endedLease = recovery && isRecord(recovery.endedLease) ? recovery.endedLease : undefined;
  return appServerOwner(endedLease)
    || (endedLease && endedLease.waitAuthority === undefined
      && typeof recordedDecision?.priorOwnerThread === "string" && recordedDecision.priorOwnerThread.trim()
      && !isLegacyHostOwnerThread(recordedDecision.priorOwnerThread)
      ? recordedDecision.priorOwnerThread
      : undefined);
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
  lines.push(`Installed template: ${result.installedTemplateVersion} (manifest schema ${result.manifestSchemaVersion})`);
  lines.push(`State template: ${result.stateTemplateVersion || "unavailable"}`);
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
  if (result.project) {
    lines.push(`Project runtime: ${result.project.runtimeVersion || "external"}`);
    lines.push(`Project installed template: ${result.project.installedTemplateVersion} (manifest schema ${result.project.manifestSchemaVersion})`);
    lines.push(`Project state template: ${result.project.stateTemplateVersion || "unavailable"}`);
  }
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
  dependencies: LifecycleDependencies,
  view: OutputView
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
      printJsonEnvelope(errorEnvelope(command, error, { warnings }), output, view);
      return 1;
    }
    printJsonEnvelope(successEnvelope(command, data, { warnings }), output, view);
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
  let view: OutputView = "full";
  let command: string | null = args[0] && !args[0].startsWith("-") ? args[0] : null;
  try {
    const parsedOutputView = parseOutputViewArgs(args);
    args = parsedOutputView.args;
    view = parsedOutputView.view;
    command = args[0] && !args[0].startsWith("-") ? args[0] : null;
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
      const { priceFile, ...usageOptions } = options;
      const report = await collectUsage({
        ...usageOptions,
        ...(dependencies.clientFactory ? { clientFactory: dependencies.clientFactory } : {})
      });
      const cost = priceFile ? projectUsageCost(report, await readPriceFile(priceFile, options.cwd)) : undefined;
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        printJsonEnvelope(successEnvelope("usage", { ...data, ...(cost ? { cost } : {}) }, { warnings, diagnostics }), output, view);
      } else {
        output.log(`${formatUsageReport(report)}${cost ? `\n\n${formatCostReport(cost)}` : ""}`);
        printWarnings(report.warnings, output);
      }
      return 0;
    }

    if (command === "budget") {
      const options = parseBudgetArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const budgetDependencies: OrchestrationDependencies = {
        ...dependencies,
        ...(dependencies.clientFactory ? { usageClientFactory: () => dependencies.clientFactory!() } : {})
      };
      if (options.action === "set" || options.action === "replace") {
        const result = await setTaskBudgetPolicy(options, budgetDependencies);
        const data = { action: options.action, task: result.task, policy: result.policy, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("budget", data), output, view);
        else output.log(`${options.action === "set" ? "Set" : "Replaced"} token budget for ${result.task.id} at policy revision ${result.policy.revision}.`);
      } else if (options.action === "report") {
        const report = await reportTaskBudget(options, budgetDependencies);
        const warnings: Warning[] = [...report.usage.warnings, ...report.warnings];
        if (options.json) printJsonEnvelope(successEnvelope("budget", { action: "report", report }, { warnings, diagnostics: report.usage.diagnostics }), output, view);
        else { output.log(formatTaskBudgetReport(report)); printWarnings(warnings, output); }
      } else if (options.action === "observe") {
        const result = await observeTaskBudget(options, budgetDependencies);
        const warnings: Warning[] = [...result.report.usage.warnings, ...result.report.warnings];
        const data = { action: "observe", task: result.task, observation: result.observation, report: result.report, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("budget", data, { warnings, diagnostics: result.report.usage.diagnostics }), output, view);
        else { output.log(`Observed ${result.observation.totalTokens} raw tokens for ${result.task.id}: ${result.observation.thresholdStatus}.`); printWarnings(warnings, output); }
      } else if (options.action === "decide") {
        const result = await decideTaskBudget({
          ...options,
          action: options.decision
        }, budgetDependencies);
        const data = { action: "decide", task: result.task, decision: result.decision, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("budget", data), output, view);
        else output.log(`Recorded ${result.decision.action} for ${result.task.id} observation ${result.decision.observation.sequence}.`);
      } else throw new SynodError(ERROR_CODES.INTERNAL, "Budget action was not parsed.");
      return 0;
    }

    if (command === "rotation") {
      const options = parseRotationArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const rotationDependencies: OrchestrationDependencies = {
        ...dependencies,
        ...(dependencies.clientFactory ? { usageClientFactory: () => dependencies.clientFactory!() } : {})
      };
      if (options.action === "set" || options.action === "replace") {
        const result = await setRotationPolicy(options, rotationDependencies);
        const data = { action: options.action, policy: result.policy, rotation: result.rotation, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("rotation", data), output, view);
        else output.log(`${options.action === "set" ? "Set" : "Replaced"} phase-rotation policy revision ${result.policy.revision}.`);
      } else if (options.action === "suggest") {
        const suggestion = await suggestProjectRotation(options, rotationDependencies);
        if (options.json) {
          const warnings = suggestion.report?.usage.warnings || [];
          const diagnostics = suggestion.report?.usage.diagnostics || {};
          const report = suggestion.report
            ? (() => {
                const { warnings: _warnings, diagnostics: _diagnostics, ...usage } = suggestion.report.usage;
                return { ...suggestion.report, usage };
              })()
            : undefined;
          printJsonEnvelope(successEnvelope("rotation", {
            action: "suggest",
            suggestion: { ...suggestion, ...(report ? { report } : {}) }
          }, { warnings, diagnostics }), output, view);
        } else {
          output.log(formatRotationSuggestion(suggestion));
          if (suggestion.report) printWarnings(suggestion.report.usage.warnings, output);
        }
      } else if (options.action === "report") {
        const report = await reportProjectRotation(options, rotationDependencies);
        if (options.json) {
          const { warnings, diagnostics, ...usage } = report.usage;
          printJsonEnvelope(successEnvelope("rotation", { action: "report", report: { ...report, usage } }, { warnings, diagnostics }), output, view);
        } else { output.log(formatRotationReport(report)); printWarnings(report.usage.warnings, output); }
      } else if (options.action === "prepare") {
        const result = await prepareProjectRotation(options, rotationDependencies);
        const data = { action: "prepare", recommendation: result.recommendation, report: result.report, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("rotation", data, { warnings: result.report.usage.warnings, diagnostics: result.report.usage.diagnostics }), output, view);
        else output.log(`Prepared phase rotation ${result.recommendation.event.sequence}:${result.recommendation.event.id} for ${result.recommendation.reasons.join(", ")}.`);
      } else if (options.action === "verify") {
        const result = await verifyProjectRotation(options, rotationDependencies);
        const data = { action: "verify", verification: result.verification, session: result.session, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("rotation", data, { warnings: result.session.warnings, diagnostics: result.session.diagnostics }), output, view);
        else output.log(`Verified phase rotation from ${result.verification.oldRootSessionId} to ${result.verification.newRootSessionId}.`);
      } else throw new SynodError(ERROR_CODES.INTERNAL, "Rotation action was not parsed.");
      return 0;
    }

    if (command === "delegate") {
      const options = parseDelegateArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const injectedAdapter = resolveHostDelegationAdapter({
        ...(dependencies.hostDelegationAdapter ? { hostDelegationAdapter: dependencies.hostDelegationAdapter } : {}),
        ...(dependencies.hostDelegationAdapterFactory
          ? { hostDelegationAdapterFactory: dependencies.hostDelegationAdapterFactory }
          : {}),
        ...(dependencies.hostAdapterEnv ? { env: dependencies.hostAdapterEnv } : {})
      });
      const hostDependencies = dependencies as unknown as import("./host-delegation.js").HostDelegationDependencies;
      if (options.action === "complete") {
        const result = await completeHostDelegation({
          id: options.id,
          directory: options.cwd,
          actor: options.actor,
          ...(options.ownerThread === undefined ? {} : { ownerThread: options.ownerThread }),
          ...(options.hostHandle === undefined ? {} : { hostHandle: options.hostHandle }),
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
          ...(options.waitAuthority === undefined ? {} : { waitAuthority: options.waitAuthority }),
          evidence: options.evidence,
          ...(injectedAdapter ? { adapter: injectedAdapter } : {}),
          ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
          ...(options.heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds })
        }, hostDependencies);
        const data = {
          action: "complete",
          task: result.task,
          ownerThread: result.ownerThread,
          waitAuthority: result.waitAuthority,
          ...(result.hostHandle === undefined ? {} : { hostHandle: result.hostHandle }),
          ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
          lease: result.lease,
          authorization: result.authorization,
          hostNotificationRequired: result.authorization.hostNotificationRequired === true,
          nextCommand: {
            operation: "wait.task",
            argv: ["wait", "--task", result.task.id],
            requirements: []
          },
          checkpoint: result.bind.state.checkpoint,
          lastEvent: result.bind.state.lastEvent
        };
        if (options.json) printJsonEnvelope(successEnvelope("delegate", data), output, view);
        else {
          output.log(`Bound ${result.task.id} to ${result.ownerThread}; write ${result.authorization.status}.`);
        }
        return 0;
      }
      const runtime = dependencies.hostRuntimeResolver?.() || resolveCodexRuntime();
      const writer = (options.write?.length || 0) > 0 || (options.writeTree?.length || 0) > 0;
      if (!injectedAdapter && runtime.surface === "cli" && options.wait && !writer) {
        throw new SynodError(
          ERROR_CODES.HOST_ADAPTER_INVALID,
          "CLI App Server Path A does not treat App Server events as wait --task."
        );
      }
      let installedProfile: string | undefined;
      if (!injectedAdapter && runtime.surface === "cli") {
        const manifest = await readManifest(options.cwd || ".");
        installedProfile = manifest?.schemaVersion === 1 ? undefined : manifest?.profile;
      }
      const selected = selectHostDelegationAdapter({
        ...(injectedAdapter ? { adapter: injectedAdapter } : {}),
        runtime,
        createCliAdapter: () => dependencies.cliAppServerAdapterFactory?.({
          runtime,
          ...(installedProfile === undefined ? {} : { profile: installedProfile }),
          ...(options.role === undefined ? {} : { role: options.role }),
          ...(options.cwd === undefined ? {} : { directory: options.cwd })
        })
          ?? createCliAppServerAdapter({
            runtime,
            ...(installedProfile === undefined ? {} : { profile: installedProfile }),
            ...(options.role === undefined ? {} : { role: options.role }),
            ...(options.cwd === undefined ? {} : { directory: options.cwd })
          }),
        ...(writer ? { writer: true } : {})
      });
      if (selected.path === "handoff") {
        if (!isCodexHostOperator(runtime)) {
          throw new SynodError(ERROR_CODES.HOST_ADAPTER_REQUIRED, "Host delegation requires an injected host adapter.");
        }
        const handoff = await startHostDelegationHandoff({
          id: options.id,
          directory: options.cwd,
          actor: options.actor,
          ...(options.role === undefined ? {} : { role: options.role }),
          read: options.read,
          write: options.write,
          readTree: options.readTree,
          writeTree: options.writeTree,
          evidence: options.evidence,
          ...(options.reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds: options.reservationTtlSeconds }),
          ...(options.wait ? { wait: true } : {})
        }, {
          ...hostDependencies,
          hostRuntimeResolver: () => runtime
        });
        const data = {
          action: "start",
          task: handoff.task,
          reservation: handoff.reservation,
          reservationFence: handoff.reservationFence,
          readOnlyContract: handoff.readOnlyContract,
          hostSpawnRequired: true,
          nextCommand: handoff.nextCommand,
          probe: handoff.probe
        };
        if (options.json) printJsonEnvelope(successEnvelope("delegate", data), output, view);
        else {
          output.log(`Reserved ${handoff.task.id}; host spawn required. Next: ${formatHostHandoffCommand(handoff.nextCommand)}.`);
        }
        return 1;
      }
      if (selected.path === "cli-app-server" && options.wait) {
        throw new SynodError(
          ERROR_CODES.HOST_ADAPTER_INVALID,
          "CLI App Server Path A does not treat App Server events as wait --task."
        );
      }
      const adapter = selected.adapter;
      const result = await startHostDelegation({
        id: options.id,
        directory: options.cwd,
        actor: options.actor,
        ...(options.role === undefined ? {} : { role: options.role }),
        read: options.read,
        write: options.write,
        readTree: options.readTree,
        writeTree: options.writeTree,
        evidence: options.evidence,
        adapter,
        ...(options.reservationTtlSeconds === undefined ? {} : { reservationTtlSeconds: options.reservationTtlSeconds }),
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
        ...(options.heartbeatIntervalSeconds === undefined ? {} : { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds }),
        ...(options.wait ? { wait: { timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs } } : {})
      }, hostDependencies);
      const data = {
        action: "start",
        task: result.task,
        reservation: result.reservation,
        ownerThread: result.ownerThread,
        waitAuthority: result.waitAuthority,
        ...(result.hostHandle === undefined ? {} : { hostHandle: result.hostHandle }),
        ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
        lease: result.lease,
        authorization: result.authorization,
        ...(isRecord(result.authorization) && (result.authorization.proposalRequired === true || result.authorization.approvalRequired === true)
          ? { nextCommand: result.authorization.nextCommand }
          : {}),
        ...(result.wait ? { wait: result.wait } : {}),
        ...(result.liveness ? { liveness: result.liveness } : {}),
        checkpoint: result.bind.state.checkpoint,
        lastEvent: result.bind.state.lastEvent
      };
      if (options.json) {
        const diagnostics = result.wait?.diagnostics || {};
        printJsonEnvelope(successEnvelope("delegate", data, { diagnostics } ), output, view);
      } else {
        output.log(`Delegated ${result.task.id} to ${result.ownerThread}; write authorized ${result.authorization.status}${result.authorization.proposalRequired === true ? "; canonical proposal still required." : result.authorization.approvalRequired === true ? "; typed approval record still required." : "."}`);
        if (result.wait) output.log(formatWaitReport(result.wait));
      }
      return result.wait?.incomplete || result.authorization.proposalRequired === true || result.authorization.approvalRequired === true ? 1 : 0;
    }

    if (command === "wait") {
      const options = parseWaitArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const selection: WaitSelection = await (dependencies.waitSelectionResolver || resolveWaitSelection)({
        directory: options.cwd,
        taskIds: options.taskIds,
        threadIds: options.threadIds
      });
      const preflightBudgets = await refreshWaitBudgets(selection, options.cwd, dependencies);
      const preflightBudgetGate = preflightBudgets.find(item => item.task.budget?.thresholdStatus === "decision-required");
      if (preflightBudgetGate) {
        const report = budgetPreflightWaitReport(selection);
        const budgetRecords = preflightBudgets.map(waitBudgetData);
        const budgetWarnings = preflightBudgets.flatMap(waitBudgetWarnings);
        const nextCommand = waitBudgetDecisionNextCommand(preflightBudgetGate);
        if (options.json) {
          const { warnings, diagnostics, ...data } = report;
          printJsonEnvelope(successEnvelope("wait", {
            selection,
            ...data,
            budgets: budgetRecords,
            ...(budgetRecords.length === 1 ? { budget: budgetRecords[0] } : {}),
            ...(nextCommand ? { nextCommand } : {})
          }, { warnings: [...warnings, ...budgetWarnings], diagnostics }), output, view);
        } else {
          output.log(formatWaitReport(report, selection));
          for (const budget of budgetRecords) output.log(`Budget ${String(budget.taskId)}: ${String(budget.thresholdStatus)}.`);
          printWarnings([...report.warnings, ...budgetWarnings], output);
        }
        return 1;
      }
      const resolvedHostAdapter = dependencies.hostWaitAdapter
        || resolveHostDelegationAdapter({
          ...(dependencies.hostDelegationAdapter ? { hostDelegationAdapter: dependencies.hostDelegationAdapter } : {}),
          ...(dependencies.hostDelegationAdapterFactory
            ? { hostDelegationAdapterFactory: dependencies.hostDelegationAdapterFactory }
            : {}),
          ...(dependencies.hostAdapterEnv ? { env: dependencies.hostAdapterEnv } : {})
        }, dependencies.hostAdapterEnv ?? process.env, { allowUnsupportedChannel: true });
      // A CLI Path A delegate keeps its owning App Server behind a private,
      // exact-thread local endpoint. Connect only for a single task/thread
      // wait when no injected authority supersedes that session.
      const retainedWaitClient = !resolvedHostAdapter
        && !dependencies.waitAdapterFactory
        && !dependencies.waitClientFactory
        && selection.threadIds.length === 1
        ? findCliAppServerWaitClient(options.cwd, selection.threadIds[0]!)
        : undefined;
      const waitClientFactory = dependencies.waitClientFactory
        || (retainedWaitClient ? () => retainedWaitClient : undefined);
      let report: Awaited<ReturnType<typeof waitForThreads>>;
      try {
        report = await waitForThreads({ ...options, threadIds: selection.threadIds, ...(selection.hostWaitHandles ? { hostWaitHandles: selection.hostWaitHandles } : {}) }, {
          ...(waitClientFactory ? { clientFactory: waitClientFactory } : {}),
          ...(dependencies.waitAdapterFactory ? { adapterFactory: dependencies.waitAdapterFactory } : {}),
          ...(resolvedHostAdapter ? { hostAdapter: resolvedHostAdapter } : {}),
          ...(dependencies.waitRuntimeResolver ? { runtimeResolver: dependencies.waitRuntimeResolver } : {})
        });
      } catch (error) {
        await retainedWaitClient?.close();
        throw error;
      }
      // Refresh again after runtime observation so usage produced during the wait is durably recorded.
      const budgetRefreshes = await refreshWaitBudgets(selection, options.cwd, dependencies);
      const budgetRecords = budgetRefreshes.map(waitBudgetData);
      const budgetGate = budgetRefreshes.find(item => item.task.budget?.thresholdStatus === "decision-required");
      const nextCommand = waitBudgetDecisionNextCommand(budgetGate)
        || waitRecoveryNextCommand(selection, report);
      const budgetWarnings = budgetRefreshes.flatMap(waitBudgetWarnings);
      const budgetDecisionRequired = budgetRefreshes.some(item => item.task.budget?.thresholdStatus === "decision-required");
      if (options.json) {
        const { warnings, diagnostics, ...data } = report;
        printJsonEnvelope(successEnvelope("wait", {
          selection,
          ...data,
          ...(budgetRecords.length > 0 ? {
            budgets: budgetRecords,
            ...(budgetRecords.length === 1 ? { budget: budgetRecords[0] } : {})
          } : {}),
          ...(nextCommand ? { nextCommand } : {})
        }, { warnings: [...warnings, ...budgetWarnings], diagnostics }), output, view);
      } else {
        output.log(formatWaitReport(report, selection));
        for (const budget of budgetRecords) {
          output.log(`Budget ${String(budget.taskId)}: ${String(budget.thresholdStatus)}.`);
        }
        printWarnings([...report.warnings, ...budgetWarnings], output);
      }
      return report.incomplete || budgetDecisionRequired ? 1 : 0;
    }

    if (command === "status") {
      const options = parseStatusArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await orchestrationStatusWithArtifacts(options, dependencies);
      if (options.json) {
        const envelope = result.healthy
          ? successEnvelope("status", result)
          : errorEnvelope("status", new SynodError(
              ERROR_CODES.CHECKPOINT_DRIFT,
              "Synod checkpoint drift was detected.",
              { details: result }
            ));
        printJsonEnvelope(envelope, output, view);
      } else {
        output.log(formatOrchestrationStatus(result));
      }
      return result.healthy ? 0 : 1;
    }

    if (command === "handoff") {
      const options = parseHandoffArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await generateHandoff(options, dependencies);
      if (options.json) printJsonEnvelope(successEnvelope("handoff", result), output, view);
      else output.log(formatHandoff(result));
      return 0;
    }

    if (command === "checkpoint") {
      const options = parseCheckpointArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await recordCheckpoint(options, dependencies);
      const data = { checkpoint: result.checkpoint, lastEvent: result.state.lastEvent };
      if (options.json) printJsonEnvelope(successEnvelope("checkpoint", data), output, view);
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
          includeLocalDocs: Boolean(result.manifest.supplemental),
          supplemental: result.manifest.supplemental,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) printJsonEnvelope(successEnvelope("bundle", { action: "export", ...data }), output, view);
        else {
          const base = `${result.manifest.source.branch || "detached"}@${result.manifest.source.head || "no HEAD"}`;
          output.log(`Exported recovery bundle ${result.bundleId} to ${result.destination} (${result.entries} paths, ${result.objects} objects; base ${base}; fingerprint ${result.manifest.checkpoint.fingerprint}; untracked ${result.manifest.includeUntracked ? "included" : "excluded"}; local docs ${result.manifest.supplemental ? "included" : "excluded"}).`);
        }
      } else if (options.action === "verify") {
        const result = await verifyRecoveryBundle(options);
        const data = {
          bundle: result.bundle,
          bundleId: result.bundleId,
          source: result.manifest.source,
          checkpoint: result.manifest.checkpoint,
          includeUntracked: result.manifest.includeUntracked,
          includeLocalDocs: Boolean(result.manifest.supplemental),
          supplemental: result.manifest.supplemental,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) printJsonEnvelope(successEnvelope("bundle", { action: "verify", ...data }), output, view);
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
          localDocsRestored: result.localDocsRestored,
          entries: result.entries,
          objects: result.objects,
          bytes: result.bytes,
          manifest: result.manifest
        };
        if (options.json) printJsonEnvelope(successEnvelope("bundle", { action: "restore", ...data }), output, view);
        else output.log(`Restored recovery bundle ${result.bundleId} into ${result.destination} (${result.entries} paths; base ${result.baseHead}; fingerprint ${result.fingerprint}; local docs ${result.localDocsRestored > 0 ? `${result.localDocsRestored} restored` : "not selected"}).`);
      }
      return 0;
    }

    if (command === "task") {
      const options = parseTaskArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      if (options.action === "next") {
        const guidance = await nextTaskGuidance(options);
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "next", guidance }), output, view);
        else output.log(guidance.recommendedTaskId
          ? `Next task: ${guidance.recommendedTaskId}`
          : "No actionable canonical task.");
      } else if (options.action === "add") {
        const result = await addTask(options, dependencies);
        const data = { task: result.task, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "add", ...data }), output, view);
        else output.log(`Added ${result.task.id} in ${result.task.state} at revision ${result.task.revision}.`);
      } else if (options.action === "transition") {
        const result = await transitionTask(options, dependencies);
        const data = { task: result.task, evidence: result.evidence, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "transition", ...data }), output, view);
        else {
          output.log(`Transitioned ${result.task.id} to ${result.task.state} at revision ${result.task.revision}.`);
          for (const item of result.evidence) output.log(`Recorded evidence ${item.id}: ${item.kind} @ revision ${item.revision}.`);
        }
      } else if (options.action === "approve") {
        const result = await recordTaskApproval(options, dependencies);
        const data = { task: result.task, approval: result.approval, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "approve", ...data }), output, view);
        else output.log(`Recorded ${result.approval.role} ${result.approval.decision} approval for ${result.task.id} revision ${result.approval.revision}.`);
      } else if (options.action === "correct") {
        const result = await recordTaskCorrection(options, dependencies);
        const data = { task: result.task, correction: result.correction, evidence: result.evidence, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "correct", ...data }), output, view);
        else {
          output.log(`Recorded correction ${result.correction.round} for ${result.task.id} at revision ${result.task.revision}.`);
          for (const item of result.evidence) output.log(`Recorded evidence ${item.id}: ${item.kind} @ revision ${item.revision}.`);
        }
      } else if (options.action === "override") {
        const result = await overrideCorrectionPolicy(options, dependencies);
        const data = { task: result.task, override: result.override, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "override", ...data }), output, view);
        else output.log(`Added ${result.override.added} correction round(s) to ${result.task.id}; limit ${result.task.correctionPolicy.limit}.`);
      } else {
        const result = await splitTask(options, dependencies);
        const data = { task: result.task, replacements: result.replacements, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
        if (options.json) printJsonEnvelope(successEnvelope("task", { action: "split", ...data }), output, view);
        else output.log(`Split ${result.task.id} into ${result.replacements.map(item => item.id).join(", ")}.`);
      }
      return 0;
    }

    if (command === "proposal") {
      const options = parseProposalArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await submitTaskProposal(options, dependencies);
      const data = { task: result.task, proposal: result.task.proposal, evidence: result.evidence, checkpoint: result.state.checkpoint, lastEvent: result.state.lastEvent };
      if (options.json) printJsonEnvelope(successEnvelope("proposal", { action: "submit", ...data }), output, view);
      else output.log(`Submitted ${result.task.id} proposal revision ${result.task.revision} for review.`);
      return 0;
    }

    if (command === "lease") {
      const options = parseLeaseArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = options.action === "reserve"
        ? await reserveTaskLease(options, dependencies)
        : options.action === "bind"
          ? await bindTaskLease(options, dependencies)
          : options.action === "cancel"
            ? await cancelTaskLeaseReservation(options, dependencies)
            : options.action === "acquire"
              ? await acquireTaskLease(options, dependencies)
        : options.action === "heartbeat"
          ? await heartbeatTaskLease(options, dependencies)
          : options.action === "release"
            ? await releaseTaskLease(options, dependencies)
            : options.action === "expire"
              ? "reservationToken" in options
                ? await expireTaskLeaseReservation(options, dependencies)
                : await expireTaskLease(options, dependencies)
              : options.action === "revoke"
                ? await revokeTaskLease(options, dependencies)
                : await recoverTaskLease(options, dependencies);
      const ownerThread = canonicalOwnerThreadForDisposal(result, options.action, "decision" in options ? options.decision : undefined);
      const ownerCleanup = ownerThread
        ? await disposeCliAppServerOwner(options.directory, ownerThread)
        : undefined;
      const activationWriteAuthorized = "writeAuthorized" in result ? result.writeAuthorized : true;
      const data = {
        action: options.action,
        task: result.task,
        ...("lease" in result ? { lease: result.lease } : { reservation: result.reservation }),
        ...(ownerCleanup ? { ownerCleanup: { ownerThread, ...ownerCleanup } } : {}),
        ...("writeAuthorized" in result ? { writeAuthorized: result.writeAuthorized } : {}),
        ...(options.action === "bind" && "lease" in result ? {
          activation: {
            taskId: result.task.id,
            revision: result.task.revision,
            leaseId: result.lease.id,
            generation: result.lease.generation,
            ownerThread: result.lease.ownerThread,
            boundAt: result.lease.acquiredAt,
            event: result.state.lastEvent,
            writeAuthorized: activationWriteAuthorized,
            supervisorNotification: { status: "required-not-observed" as const },
            followUp: activationWriteAuthorized
              ? {
                  operation: "wait",
                  arguments: { taskIds: [result.task.id] },
                  requirements: []
                }
              : {
                  operation: "lease.release",
                  arguments: {
                    taskId: result.task.id,
                    leaseId: result.lease.id,
                    generation: result.lease.generation,
                    revision: result.lease.taskRevision,
                    expectedHeartbeatAt: result.lease.heartbeatAt,
                    ownerThread: result.lease.ownerThread
                  },
                  requirements: []
                }
          }
        } : {}),
        ...("evidence" in result ? { evidence: result.evidence } : {}),
        checkpoint: result.state.checkpoint,
        lastEvent: result.state.lastEvent
      };
      if (options.json) printJsonEnvelope(successEnvelope("lease", data), output, view);
      else {
        const authority = "lease" in result ? result.lease : result.reservation;
        const authorization = "writeAuthorized" in result
          ? `; write authorized ${result.writeAuthorized ? "yes" : "no"}`
          : "";
        output.log(`Lease ${options.action} for ${result.task.id}: ${authority.id} generation ${authority.generation}${authorization}.`);
        if ("evidence" in result && Array.isArray(result.evidence)) {
          for (const item of result.evidence) output.log(`Recorded evidence ${item.id}: ${item.kind} @ revision ${item.revision}.`);
        }
      }
      return 0;
    }

    if (command === "worktree") {
      const options = parseWorktreeArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      let result;
      if (options.action === "status") {
        result = await taskWorktreeStatus({ directory: options.directory, taskId: options.id }, dependencies.worktreeDependencies);
      } else if (options.action === "cleanup") {
        result = { record: await cleanupTaskWorktree({ directory: options.directory, taskId: options.id }, dependencies.worktreeDependencies), reconciliation: "complete" as const, reasons: [] };
      } else {
        if (!("leaseId" in options)) throw new SynodError(ERROR_CODES.INTERNAL, "Fenced worktree options were not parsed.");
        const fenced = {
          directory: options.directory,
          taskId: options.id,
          leaseId: options.leaseId,
          generation: options.generation,
          revision: options.revision,
          expectedHeartbeatAt: options.expectedHeartbeatAt,
          ownerThread: options.ownerThread
        };
        result = options.action === "create"
          ? await createTaskWorktree({ ...fenced, destination: options.destination }, dependencies.worktreeDependencies)
          : {
              record: await (options.action === "seal" ? sealTaskWorktreeProposal : integrateTaskWorktreeProposal)(fenced, dependencies.worktreeDependencies),
              reconciliation: "complete" as const,
              reasons: []
            };
      }
      const data = { action: options.action, ...result };
      if (options.json) printJsonEnvelope(successEnvelope("worktree", data), output, view);
      else if (options.action === "create") {
        output.log(`Created detached worktree for ${result.record.taskId} at ${result.record.worktreePath} (${result.record.baseHead}).`);
      } else if (options.action === "seal") {
        output.log(`Sealed worktree proposal ${result.record.proposal?.bundleId} for ${result.record.taskId}.`);
      } else if (options.action === "integrate") {
        output.log(`Integrated worktree proposal for ${result.record.taskId} (${result.record.integration.fingerprint}).`);
      } else if (options.action === "cleanup") {
        output.log(`Cleaned task worktree for ${result.record.taskId} at ${result.record.worktreePath}.`);
      } else {
        output.log(`Task worktree ${result.record.taskId}: ${result.reconciliation} at ${result.record.worktreePath}.`);
        for (const reason of result.reasons) output.log(`  - ${reason}`);
      }
      return result.reconciliation === "manual_reconciliation" ? 1 : 0;
    }

    if (command === "profiles") {
      const options = parseLifecycleArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      if (options.directory !== ".") {
        throw new SynodError(ERROR_CODES.UNEXPECTED_ARGUMENT, `Unexpected argument: ${options.directory}`);
      }
      const profiles = listProfiles();
      if (options.json) printJsonEnvelope(successEnvelope("profiles", { profiles }), output, view);
      else for (const profile of profiles) output.log(`${profile.id}: ${profile.description} (Codex >=${profile.minimumCodexVersion})`);
      return 0;
    }

    if (command === "init") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true, allowProfile: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const initDependencies = options.profile === undefined
        ? { ...dependencies, profileSelector: createInitProfileSelector(dependencies) }
        : dependencies;
      return emitLifecycle("init", options, output, initProject, initDependencies, view);
    }
    if (command === "upgrade") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true, allowProfile: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      return emitLifecycle("upgrade", options, output, upgradeProject, dependencies, view);
    }
    if (command === "uninstall") {
      const options = parseLifecycleArgs(args.slice(1), { allowDryRun: true, allowForce: true });
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      return emitLifecycle("uninstall", options, output, uninstallProject, dependencies, view);
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
        printJsonEnvelope(envelope, output, view);
      } else {
        output.log(textCheck(result));
        printWarnings(result.warnings, output);
      }
      return result.healthy ? 0 : 1;
    }
    if (command === "doctor") {
      const options = parseLifecycleArgs(args.slice(1));
      if (isHelpOptions(options)) { output.log(HELP); return 0; }
      const result = await doctorProject(options, doctorDependenciesForCli(dependencies));
      if (options.json) {
        const { warnings, diagnostics, ...data } = result;
        const envelope = result.healthy
          ? successEnvelope("doctor", data, { warnings, diagnostics })
          : errorEnvelope("doctor", new SynodError(
              ERROR_CODES.DOCTOR_FAILED,
              "Synod doctor found an unsupported or unhealthy runtime.",
              { details: data }
            ), { warnings, diagnostics });
        printJsonEnvelope(envelope, output, view);
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
      printJsonEnvelope(errorEnvelope(command, synodError, {
        ...(synodError.warnings ? { warnings: synodError.warnings } : {}),
        ...(synodError.diagnostics ? { diagnostics: synodError.diagnostics } : {})
      }), output, view);
      return 1;
    }
    printWarnings(synodError.warnings || [], output);
    output.error(`Error [${synodError.code}]: ${synodError.message}`);
    output.error("Run `synod --help` for usage.");
    return 1;
  }
}
