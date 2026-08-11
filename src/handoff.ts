import { ERROR_CODES, SynodError } from "./errors.js";
import { formatCheckpointDelta } from "./checkpoint.js";
import type { CheckpointDelta } from "./checkpoint.js";
import {
  legalTaskTransitions,
  orchestrationStatus
} from "./orchestration.js";
import type {
  GitCheckpoint,
  OrchestrationDependencies,
  OrchestrationLastEvent,
  OrchestrationTask,
  TaskEvidence,
  TaskState
} from "./orchestration.js";
import { verifyRecoveryBundle } from "./recovery.js";

export interface HandoffOptions {
  directory?: string;
  bundle?: string | undefined;
}

export interface HandoffTaskEvidence {
  delivery: TaskEvidence[];
  correction: TaskEvidence[];
  acceptance: TaskEvidence[];
  verification: TaskEvidence[];
}

export interface HandoffTask {
  id: string;
  objective: string;
  state: TaskState;
  revision: number;
  executor: string;
  dependencies: Array<{ id: string; state: TaskState; complete: boolean }>;
  incompleteDependencies: string[];
  blocker: string | null;
  lease: OrchestrationTask["lease"] | null;
  proposal: OrchestrationTask["proposal"] | null;
  acceptance: OrchestrationTask["acceptance"] & { unresolved: boolean };
  verification: OrchestrationTask["verification"] & { unresolved: boolean };
  evidence: HandoffTaskEvidence;
  legalNextTransitions: TaskState[];
}

export type HandoffRecoveryBundle =
  | { status: "not-supplied" }
  | {
      status: "verified";
      path: string;
      bundleId: string;
      checkpointFingerprint: string;
      snapshotHash: string;
      event: { sequence: number; hash: string };
      eventMatchesCanonical: boolean;
      entries: number;
      objects: number;
      bytes: number;
    };

export interface HandoffResult {
  targetDirectory: string;
  lastEvent: OrchestrationLastEvent;
  checkpoint: {
    acknowledged: GitCheckpoint;
    current: GitCheckpoint;
    drift: { detected: boolean; reasons: unknown[] };
    delta: CheckpointDelta;
  };
  focusTaskIds: string[];
  tasks: HandoffTask[];
  recoveryBundle: HandoffRecoveryBundle;
}

function gateEvidence(task: OrchestrationTask, evidenceIds: readonly string[]): TaskEvidence[] {
  const byId = new Map(task.evidence.map(item => [item.id, item]));
  return evidenceIds.map(id => byId.get(id)!);
}

function currentProposalEvidence(task: OrchestrationTask): Pick<HandoffTaskEvidence, "delivery" | "correction"> {
  const current = task.evidence.filter(item => item.revision === task.revision);
  const correction = current.filter(item => item.kind === "correction");
  let latestDelivery = -1;
  let latestCorrection = -1;
  for (const [index, item] of current.entries()) {
    if (item.kind === "delivery") latestDelivery = index;
    if (item.kind === "correction") latestCorrection = index;
  }
  return {
    delivery: latestCorrection > latestDelivery ? [] : current.filter(item => item.kind === "delivery"),
    correction
  };
}

function handoffTask(
  task: OrchestrationTask,
  tasks: Readonly<Record<string, OrchestrationTask>>
): HandoffTask {
  const dependencies = task.dependsOn.map(id => ({
    id,
    state: tasks[id]!.state,
    complete: tasks[id]!.state === "DONE"
  }));
  const proposalEvidence = currentProposalEvidence(task);
  return {
    id: task.id,
    objective: task.objective,
    state: task.state,
    revision: task.revision,
    executor: task.executor,
    dependencies,
    incompleteDependencies: dependencies.filter(item => !item.complete).map(item => item.id),
    blocker: task.blocker || null,
    lease: task.lease || null,
    proposal: task.proposal || null,
    acceptance: { ...task.acceptance, unresolved: task.acceptance.status !== "accepted" },
    verification: { ...task.verification, unresolved: task.verification.status !== "passed" },
    evidence: {
      ...proposalEvidence,
      acceptance: gateEvidence(task, task.acceptance.evidenceIds),
      verification: gateEvidence(task, task.verification.evidenceIds)
    },
    legalNextTransitions: legalTaskTransitions(task, tasks)
  };
}

function verifiedBundleMatches(
  verification: Awaited<ReturnType<typeof verifyRecoveryBundle>>,
  checkpoint: GitCheckpoint,
  lastEvent: OrchestrationLastEvent
): HandoffRecoveryBundle {
  const snapshotHash = checkpoint.worktree.snapshot?.contentHash;
  const manifest = verification.manifest;
  if (!snapshotHash
    || manifest.checkpoint.fingerprint !== checkpoint.worktree.fingerprint
    || manifest.checkpoint.snapshotHash !== snapshotHash) {
    throw new SynodError(
      ERROR_CODES.RECOVERY_BUNDLE_INVALID,
      "The verified recovery bundle does not match the canonical handoff checkpoint.",
      {
        details: {
          bundleId: manifest.bundleId,
          expected: {
            fingerprint: checkpoint.worktree.fingerprint,
            snapshotHash,
            event: { sequence: lastEvent.sequence, hash: lastEvent.hash }
          },
          actual: {
            fingerprint: manifest.checkpoint.fingerprint,
            snapshotHash: manifest.checkpoint.snapshotHash,
            event: manifest.event
          }
        }
      }
    );
  }
  return {
    status: "verified",
    path: verification.bundle,
    bundleId: verification.bundleId,
    checkpointFingerprint: manifest.checkpoint.fingerprint,
    snapshotHash: manifest.checkpoint.snapshotHash,
    event: manifest.event,
    eventMatchesCanonical: manifest.event.sequence === lastEvent.sequence && manifest.event.hash === lastEvent.hash,
    entries: verification.entries,
    objects: verification.objects,
    bytes: verification.bytes
  };
}

export async function generateHandoff(
  { directory = ".", bundle }: HandoffOptions = {},
  dependencies: OrchestrationDependencies = {}
): Promise<HandoffResult> {
  const status = await orchestrationStatus({ directory, explain: true, readOnly: true }, dependencies);
  const verification = bundle ? await verifyRecoveryBundle({ bundle }) : undefined;
  if (!status.delta) throw new TypeError("Handoff checkpoint delta is unavailable.");
  const taskMap = Object.fromEntries(status.tasks.map(task => [task.id, task]));
  const tasks = status.tasks
    .filter(task => !["DONE", "SUPERSEDED"].includes(task.state))
    .map(task => handoffTask(task, taskMap));
  const focusTaskIds = tasks
    .filter(task => ["ACTIVE", "REVIEW", "ACCEPTED", "VERIFIED", "BLOCKED"].includes(task.state))
    .map(task => task.id);
  return {
    targetDirectory: status.targetDirectory,
    lastEvent: status.lastEvent,
    checkpoint: {
      acknowledged: status.checkpoint,
      current: status.currentCheckpoint,
      drift: status.drift,
      delta: status.delta
    },
    focusTaskIds,
    tasks,
    recoveryBundle: verification
      ? verifiedBundleMatches(verification, status.checkpoint, status.lastEvent)
      : { status: "not-supplied" }
  };
}

function checkpointLabel(checkpoint: GitCheckpoint): string {
  return `${checkpoint.branch || "detached"}@${checkpoint.head || "no HEAD"}; fingerprint ${checkpoint.worktree.fingerprint}`;
}

function evidenceLabel(items: TaskEvidence[]): string {
  return items.length === 0 ? "none" : items.map(item => `${item.id}=${item.reference}`).join(", ");
}

export function formatHandoff(result: HandoffResult): string {
  const lines = ["Synod canonical handoff"];
  lines.push(`Project: ${result.targetDirectory}`);
  lines.push(`Last event: ${result.lastEvent.sequence} ${result.lastEvent.hash}`);
  lines.push(`Checkpoint: ${checkpointLabel(result.checkpoint.acknowledged)}`);
  lines.push(`Current: ${checkpointLabel(result.checkpoint.current)}`);
  lines.push(`Drift: ${result.checkpoint.drift.detected ? "detected" : "none"}`);
  lines.push(...formatCheckpointDelta(result.checkpoint.delta));
  lines.push(`Focus tasks: ${result.focusTaskIds.length > 0 ? result.focusTaskIds.join(", ") : "none"}`);
  for (const task of result.tasks) {
    lines.push(`${task.id}: ${task.state} r${task.revision}; executor ${task.executor}`);
    lines.push(`  Objective: ${task.objective}`);
    lines.push(`  Dependencies: ${task.dependencies.length === 0 ? "none" : task.dependencies.map(item => `${item.id}=${item.state}`).join(", ")}`);
    lines.push(`  Blocker: ${task.blocker || "none"}`);
    lines.push(`  Writer lease: ${task.lease ? `${task.lease.id} generation ${task.lease.generation}; owner ${task.lease.ownerThread}; expires ${task.lease.expiresAt}` : "none"}`);
    lines.push(`  Sealed proposal: ${task.proposal ? `${task.proposal.bundleId}; ${task.proposal.path}; owned paths ${task.proposal.ownedPaths.length > 0 ? task.proposal.ownedPaths.join(", ") : "none"}; excluded foreign paths ${task.proposal.excludedForeignPaths.length > 0 ? task.proposal.excludedForeignPaths.join(", ") : "none"}` : "none"}`);
    lines.push(`  Acceptance criteria: ${task.acceptance.criteria.join("; ")}`);
    lines.push(`  Acceptance: ${task.acceptance.status}; evidence ${evidenceLabel(task.evidence.acceptance)}`);
    lines.push(`  Verification commands: ${task.verification.commands.join("; ")}`);
    lines.push(`  Verification: ${task.verification.status}; evidence ${evidenceLabel(task.evidence.verification)}`);
    lines.push(`  Delivery evidence: ${evidenceLabel(task.evidence.delivery)}`);
    lines.push(`  Correction evidence: ${evidenceLabel(task.evidence.correction)}`);
    lines.push(`  Legal next transitions: ${task.legalNextTransitions.length === 0 ? "none" : task.legalNextTransitions.join(", ")}`);
  }
  if (result.recoveryBundle.status === "verified") {
    lines.push(`Recovery bundle: verified ${result.recoveryBundle.bundleId} at ${result.recoveryBundle.path}; event ${result.recoveryBundle.eventMatchesCanonical ? "current" : "older than handoff"}`);
  } else lines.push("Recovery bundle: not supplied");
  return lines.join("\n");
}
