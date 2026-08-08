import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, readlink, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ERROR_CODES, SynodError } from "./errors.js";
import {
  applyTransaction,
  contentHash,
  inspectPath,
  pathType,
  resolveProjectPath,
  unsafeAncestor
} from "./filesystem.js";
import { packageVersion } from "./package.js";

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const ORCHESTRATION_STATE_PATH = ".synod/state.json";
export const ORCHESTRATION_EVENTS_PATH = ".synod/events.jsonl";
export const ORCHESTRATION_STATUS_PATH = "docs/synod/STATUS.md";
const ORCHESTRATION_LOCK_PATH = ".synod/orchestration.lock";
const ORCHESTRATION_PENDING_PATH = ".synod/pending-mutation.json";

export const TASK_STATES = Object.freeze([
  "PLANNED",
  "READY",
  "ACTIVE",
  "REVIEW",
  "ACCEPTED",
  "VERIFIED",
  "DONE",
  "BLOCKED",
  "SUPERSEDED"
]);

const TERMINAL_STATES = new Set(["DONE", "SUPERSEDED"]);
const TRANSITIONS = Object.freeze({
  PLANNED: new Set(["READY", "BLOCKED", "SUPERSEDED"]),
  READY: new Set(["ACTIVE", "BLOCKED", "SUPERSEDED"]),
  ACTIVE: new Set(["REVIEW", "BLOCKED", "SUPERSEDED"]),
  REVIEW: new Set(["ACTIVE", "ACCEPTED", "BLOCKED", "SUPERSEDED"]),
  ACCEPTED: new Set(["ACTIVE", "VERIFIED", "BLOCKED", "SUPERSEDED"]),
  VERIFIED: new Set(["ACTIVE", "DONE", "BLOCKED", "SUPERSEDED"]),
  BLOCKED: new Set(["PLANNED", "READY", "ACTIVE", "REVIEW", "ACCEPTED", "VERIFIED", "SUPERSEDED"]),
  DONE: new Set(),
  SUPERSEDED: new Set()
});

const execFileAsync = promisify(execFile);

function nowIso(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("Synod clock returned an invalid date.");
  return date.toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stateCore(state) {
  const { lastEvent: _lastEvent, ...core } = state;
  return core;
}

function isIgnoredCheckpointPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized === "AGENTS.md"
    || normalized === ".codex/config.toml"
    || normalized.startsWith(".synod/")
    || normalized === ORCHESTRATION_STATUS_PATH
    || normalized.startsWith(".codex/agents/synod-")
    || normalized.startsWith(".agents/skills/synod-advisor/");
}

async function defaultGitRunner(directory, args) {
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return result.stdout;
}

async function optionalGit(gitRunner, directory, args) {
  try {
    return (await gitRunner(directory, args)).trim();
  } catch {
    return null;
  }
}

async function checkpointPath(directory, relativePath, gitRunner) {
  const absolutePath = path.resolve(directory, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return { type: "symlink", contentHash: sha256Bytes(await readlink(absolutePath, { encoding: "buffer" })) };
    }
    if (stats.isDirectory()) {
      const nested = await captureGitCheckpoint(absolutePath, { gitRunner });
      return {
        type: "directory",
        ...(nested.head ? { gitHead: nested.head } : {}),
        ...(nested.available ? { worktreeFingerprint: nested.worktree.fingerprint } : {})
      };
    }
    if (!stats.isFile()) return { type: "other" };
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    const handle = await open(absolutePath, flags);
    try {
      if (!(await handle.stat()).isFile()) return { type: "other" };
      return { type: "file", contentHash: sha256Bytes(await handle.readFile()) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return { type: "missing" };
    throw error;
  }
}

function indexRecords(indexOutput) {
  const records = new Map();
  for (const field of indexOutput.split("\0")) {
    if (!field) continue;
    const separator = field.indexOf("\t");
    if (separator < 0) continue;
    const [mode, objectId, stage] = field.slice(0, separator).split(" ");
    const relativePath = field.slice(separator + 1);
    const entries = records.get(relativePath) || [];
    entries.push({ mode, objectId, stage: Number(stage) });
    records.set(relativePath, entries);
  }
  return records;
}

async function worktreeRecords(directory, porcelain, indexOutput, overlay, gitRunner) {
  const stagedIndex = indexRecords(indexOutput);
  const fields = porcelain.split("\0");
  const records = [];
  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    const field = fields[cursor];
    if (!field) continue;
    const status = field.slice(0, 2);
    const relativePath = field.slice(3);
    let sourcePath;
    if (status.includes("R") || status.includes("C")) sourcePath = fields[++cursor] || undefined;
    if (isIgnoredCheckpointPath(relativePath) && (!sourcePath || isIgnoredCheckpointPath(sourcePath))) continue;

    const inspected = isIgnoredCheckpointPath(relativePath)
      ? { type: "ignored" }
      : await checkpointPath(directory, relativePath, gitRunner);
    records.push({
      status,
      path: relativePath,
      ...(sourcePath ? { sourcePath } : {}),
      type: inspected.type,
      ...(inspected.contentHash ? { contentHash: inspected.contentHash } : {}),
      ...(inspected.gitHead ? { gitHead: inspected.gitHead } : {}),
      ...(inspected.worktreeFingerprint ? { worktreeFingerprint: inspected.worktreeFingerprint } : {}),
      ...(stagedIndex.has(relativePath) ? { index: stagedIndex.get(relativePath) } : {})
    });
  }
  const recordedPaths = new Set(records.map(record => record.path));
  for (const [relativePath, content] of overlay) {
    if (isIgnoredCheckpointPath(relativePath) || recordedPaths.has(relativePath)) continue;
    if (await pathType(path.resolve(directory, relativePath)) !== "missing") continue;
    records.push({
      status: "??",
      path: relativePath,
      type: "file",
      contentHash: sha256Bytes(Buffer.from(content, "utf8"))
    });
  }
  return records.sort((left, right) => `${left.path}\0${left.sourcePath || ""}`.localeCompare(`${right.path}\0${right.sourcePath || ""}`));
}

export async function captureGitCheckpoint(directory, {
  clock,
  gitRunner = defaultGitRunner,
  checkpointOverlay = new Map()
} = {}) {
  const capturedAt = nowIso(clock);
  const inside = await optionalGit(gitRunner, directory, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    return {
      capturedAt,
      available: false,
      branch: null,
      head: null,
      worktree: { clean: true, entries: 0, fingerprint: sha256("[]") }
    };
  }

  const [head, branch, porcelain, index] = await Promise.all([
    optionalGit(gitRunner, directory, ["rev-parse", "HEAD"]),
    optionalGit(gitRunner, directory, ["symbolic-ref", "--short", "-q", "HEAD"]),
    gitRunner(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    gitRunner(directory, ["ls-files", "--stage", "-z", "--", "."])
  ]);
  const records = await worktreeRecords(directory, porcelain, index, checkpointOverlay, gitRunner);
  return {
    capturedAt,
    available: true,
    branch,
    head,
    worktree: {
      clean: records.length === 0,
      entries: records.length,
      fingerprint: sha256(stableStringify(records))
    }
  };
}

export function checkpointDrift(expected, actual) {
  const reasons = [];
  if (expected.available !== actual.available) {
    reasons.push({ field: "git.available", expected: expected.available, actual: actual.available });
  }
  if (expected.branch !== actual.branch) {
    reasons.push({ field: "git.branch", expected: expected.branch, actual: actual.branch });
  }
  if (expected.head !== actual.head) {
    reasons.push({ field: "git.head", expected: expected.head, actual: actual.head });
  }
  if (expected.worktree.fingerprint !== actual.worktree.fingerprint) {
    reasons.push({
      field: "git.worktree",
      expected: expected.worktree.fingerprint,
      actual: actual.worktree.fingerprint,
      expectedEntries: expected.worktree.entries,
      actualEntries: actual.worktree.entries
    });
  }
  return { detected: reasons.length > 0, reasons };
}

function eventHash(event) {
  const { eventHash: _eventHash, ...unsigned } = event;
  return sha256(stableStringify(unsigned));
}

function buildEvent(previousState, nextCore, type, metadata) {
  const sequence = (previousState?.lastEvent.sequence || 0) + 1;
  const event = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence,
    id: randomUUID(),
    timestamp: nextCore.updatedAt,
    type,
    actor: metadata.actor,
    ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
    ...(metadata.fromState ? { fromState: metadata.fromState } : {}),
    ...(metadata.toState ? { toState: metadata.toState } : {}),
    ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}),
    checkpoint: metadata.checkpoint || nextCore.checkpoint,
    payload: metadata.payload || {},
    previousHash: previousState?.lastEvent.hash || null,
    state: nextCore
  };
  event.eventHash = eventHash(event);
  const state = {
    ...nextCore,
    lastEvent: { sequence, id: event.id, hash: event.eventHash }
  };
  return { event, state };
}

function initialState(checkpoint, timestamp) {
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    templateVersion: packageVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoint,
    taskOrder: [],
    tasks: {},
    evidenceCounter: 0
  };
}

function taskList(state) {
  return state.taskOrder.map(id => state.tasks[id]);
}

function markdownCell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ");
}

function checkpointLabel(checkpoint) {
  if (!checkpoint.available) return "Git unavailable";
  return `${checkpoint.branch || "detached"} @ ${checkpoint.head || "unborn"}; ${checkpoint.worktree.clean ? "clean" : `${checkpoint.worktree.entries} changed path(s)`}`;
}

export function renderStatusMarkdown(state, drift = { detected: false, reasons: [] }) {
  const lines = [
    "# Synod Status",
    "",
    "> Generated from `.synod/state.json`. Do not edit this file directly.",
    "",
    `Updated: ${state.updatedAt}`,
    `Last event: ${state.lastEvent.sequence} (${state.lastEvent.hash})`,
    `Checkpoint: ${checkpointLabel(state.checkpoint)}`,
    `Live drift: ${drift.detected ? "DETECTED" : "run synod status to compare the recorded checkpoint with the current worktree"}`,
    "",
    "## Tasks",
    "",
    "| ID | State | Revision | Executor | Correction round | Acceptance | Verification | Objective |",
    "|---|---|---:|---|---:|---|---|---|"
  ];
  for (const task of taskList(state)) {
    lines.push(`| ${markdownCell(task.id)} | ${task.state} | ${task.revision} | ${markdownCell(task.executor)} | ${task.correctionRound} | ${task.acceptance.status}${task.acceptance.revision === null ? "" : ` @ r${task.acceptance.revision}`} | ${task.verification.status}${task.verification.revision === null ? "" : ` @ r${task.verification.revision}`} | ${markdownCell(task.objective)} |`);
  }
  if (state.taskOrder.length === 0) lines.push("| — | — | — | — | — | — | — | No tasks recorded. |");

  lines.push("", "## Task contracts", "");
  if (state.taskOrder.length === 0) {
    lines.push("No task contracts recorded.");
  } else {
    for (const task of taskList(state)) {
      lines.push(
        `### ${markdownCell(task.id)} — ${markdownCell(task.objective)}`,
        "",
        `- Executor: ${markdownCell(task.executor)}`,
        `- Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.map(markdownCell).join(", ") : "—"}`,
        `- Revision: ${task.revision}`,
        `- Correction round: ${task.correctionRound}`,
        "- Acceptance criteria:"
      );
      for (const criterion of task.acceptance.criteria) lines.push(`  - ${markdownCell(criterion)}`);
      lines.push("- Verification commands:");
      for (const command of task.verification.commands) lines.push(`  - ${markdownCell(command)}`);
      lines.push("");
    }
  }

  lines.push("", "## Evidence", "");
  const evidence = taskList(state).flatMap(task => task.evidence.map(item => ({ taskId: task.id, ...item })));
  if (evidence.length === 0) {
    lines.push("No evidence recorded.");
  } else {
    lines.push("| ID | Task | Kind | Revision | Git HEAD | Worktree | Reference |", "|---|---|---|---:|---|---|---|");
    for (const item of evidence) {
      lines.push(`| ${item.id} | ${item.taskId} | ${item.kind} | ${item.revision} | ${markdownCell(item.checkpoint.head)} | ${item.checkpoint.worktreeFingerprint} | ${markdownCell(item.reference)} |`);
    }
  }
  if (drift.detected) {
    lines.push("", "## Detected drift", "");
    for (const reason of drift.reasons) lines.push(`- ${reason.field}: expected \`${reason.expected}\`, actual \`${reason.actual}\`.`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function createInitialOrchestrationFiles(targetDirectory, dependencies = {}) {
  const timestamp = nowIso(dependencies.clock);
  const checkpoint = await captureGitCheckpoint(targetDirectory, dependencies);
  const core = initialState(checkpoint, timestamp);
  const { event, state } = buildEvent(undefined, core, "project.initialized", {
    actor: "synod",
    payload: { templateVersion: packageVersion }
  });
  return new Map([
    [ORCHESTRATION_STATE_PATH, serializeJson(state)],
    [ORCHESTRATION_EVENTS_PATH, `${JSON.stringify(event)}\n`],
    [ORCHESTRATION_STATUS_PATH, renderStatusMarkdown(state)]
  ]);
}

function invalidState(message, details) {
  throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, message, { details });
}

function validateEvidence(item, task) {
  if (
    !item || typeof item !== "object" || typeof item.id !== "string"
    || !["delivery", "correction", "acceptance", "verification"].includes(item.kind)
    || !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision > task.revision
    || typeof item.reference !== "string" || item.reference.length === 0
    || typeof item.actor !== "string" || typeof item.recordedAt !== "string"
    || !item.checkpoint || typeof item.checkpoint.worktreeFingerprint !== "string"
  ) invalidState(`Task ${task.id} contains invalid evidence.`, { taskId: task.id, evidenceId: item?.id });
}

export function validateOrchestrationState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) invalidState("Synod state must be a JSON object.");
  if (state.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
    invalidState(`Unsupported orchestration state schema: ${state.schemaVersion}`, { supported: ORCHESTRATION_SCHEMA_VERSION });
  }
  if (
    typeof state.templateVersion !== "string" || typeof state.createdAt !== "string" || typeof state.updatedAt !== "string"
    || !state.checkpoint || typeof state.checkpoint !== "object"
    || typeof state.checkpoint.capturedAt !== "string" || typeof state.checkpoint.available !== "boolean"
    || (state.checkpoint.branch !== null && typeof state.checkpoint.branch !== "string")
    || (state.checkpoint.head !== null && typeof state.checkpoint.head !== "string")
    || !state.checkpoint.worktree || typeof state.checkpoint.worktree.clean !== "boolean"
    || !Number.isSafeInteger(state.checkpoint.worktree.entries) || state.checkpoint.worktree.entries < 0
    || typeof state.checkpoint.worktree.fingerprint !== "string"
    || !Array.isArray(state.taskOrder) || !state.tasks || typeof state.tasks !== "object" || Array.isArray(state.tasks)
    || !Number.isSafeInteger(state.evidenceCounter) || state.evidenceCounter < 0
    || !state.lastEvent || !Number.isSafeInteger(state.lastEvent.sequence) || typeof state.lastEvent.hash !== "string"
  ) invalidState("Synod state is missing required canonical fields.");

  if (new Set(state.taskOrder).size !== state.taskOrder.length || Object.keys(state.tasks).length !== state.taskOrder.length) {
    invalidState("Task order and task map do not describe the same unique tasks.");
  }
  const allEvidenceIds = new Set();
  let maximumEvidenceCounter = 0;
  for (const id of state.taskOrder) {
    const task = state.tasks[id];
    if (
      !task || task.id !== id || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(id)
      || typeof task.objective !== "string" || task.objective.length === 0
      || typeof task.executor !== "string" || task.executor.length === 0
      || !TASK_STATES.includes(task.state) || !Number.isSafeInteger(task.revision) || task.revision < 0
      || !Number.isSafeInteger(task.correctionRound) || task.correctionRound < 0
      || !Array.isArray(task.dependsOn) || !Array.isArray(task.evidence)
      || !task.acceptance || !Array.isArray(task.acceptance.criteria) || !Array.isArray(task.acceptance.evidenceIds)
      || task.acceptance.criteria.length === 0 || task.acceptance.criteria.some(value => typeof value !== "string" || value.length === 0)
      || !["pending", "accepted"].includes(task.acceptance.status)
      || !task.verification || !Array.isArray(task.verification.commands) || !Array.isArray(task.verification.evidenceIds)
      || task.verification.commands.length === 0 || task.verification.commands.some(value => typeof value !== "string" || value.length === 0)
      || !["pending", "passed"].includes(task.verification.status)
    ) invalidState(`Task ${id} is invalid.`, { taskId: id });
    if (task.state === "BLOCKED" && !TASK_STATES.includes(task.blockedFrom)) {
      invalidState(`Blocked task ${id} is missing its prior state.`, { taskId: id });
    }
    for (const dependency of task.dependsOn) {
      if (!state.tasks[dependency] || dependency === id) invalidState(`Task ${id} has an invalid dependency.`, { taskId: id, dependency });
    }
    for (const item of task.evidence) validateEvidence(item, task);
    const evidenceById = new Map(task.evidence.map(item => [item.id, item]));
    if (evidenceById.size !== task.evidence.length) invalidState(`Task ${id} contains duplicate evidence IDs.`, { taskId: id });
    for (const evidenceId of evidenceById.keys()) {
      if (allEvidenceIds.has(evidenceId) || !/^E-\d{6}$/.test(evidenceId)) {
        invalidState(`Task ${id} contains an invalid or globally duplicate evidence ID.`, { taskId: id, evidenceId });
      }
      allEvidenceIds.add(evidenceId);
      maximumEvidenceCounter = Math.max(maximumEvidenceCounter, Number(evidenceId.slice(2)));
    }
    if (task.acceptance.status === "pending" && (task.acceptance.revision !== null || task.acceptance.evidenceIds.length > 0)) {
      invalidState(`Task ${id} has evidence on pending acceptance.`, { taskId: id });
    }
    if (task.acceptance.status === "accepted" && task.acceptance.revision !== task.revision) {
      invalidState(`Task ${id} acceptance is not tied to its exact revision.`, { taskId: id });
    }
    if (task.acceptance.status === "accepted" && (
      task.acceptance.evidenceIds.length === 0
      || task.acceptance.evidenceIds.some(evidenceId => {
        const item = evidenceById.get(evidenceId);
        return !item || item.kind !== "acceptance" || item.revision !== task.revision;
      })
    )) invalidState(`Task ${id} acceptance evidence is invalid.`, { taskId: id });
    if (task.verification.status === "passed" && task.verification.revision !== task.revision) {
      invalidState(`Task ${id} verification is not tied to its exact revision.`, { taskId: id });
    }
    if (task.verification.status === "pending" && (task.verification.revision !== null || task.verification.evidenceIds.length > 0)) {
      invalidState(`Task ${id} has evidence on pending verification.`, { taskId: id });
    }
    if (task.verification.status === "passed" && (
      task.verification.evidenceIds.length === 0
      || task.verification.evidenceIds.some(evidenceId => {
        const item = evidenceById.get(evidenceId);
        return !item || item.kind !== "verification" || item.revision !== task.revision;
      })
    )) invalidState(`Task ${id} verification evidence is invalid.`, { taskId: id });
    if (["ACCEPTED", "VERIFIED", "DONE"].includes(task.state) && task.acceptance.status !== "accepted") {
      invalidState(`Task ${id} state requires exact-revision acceptance.`, { taskId: id });
    }
    if (["VERIFIED", "DONE"].includes(task.state) && task.verification.status !== "passed") {
      invalidState(`Task ${id} state requires exact-revision verification.`, { taskId: id });
    }
    if (["REVIEW", "ACCEPTED", "VERIFIED", "DONE"].includes(task.state) && !task.evidence.some(item => item.kind === "delivery" && item.revision === task.revision)) {
      invalidState(`Task ${id} state requires delivery evidence for its exact revision.`, { taskId: id });
    }
  }
  if (maximumEvidenceCounter !== state.evidenceCounter) {
    invalidState("Evidence counter does not match canonical evidence IDs.", {
      expected: maximumEvidenceCounter,
      actual: state.evidenceCounter
    });
  }
  return state;
}

function validateEventLog(events) {
  let previousHash = null;
  for (const [index, event] of events.entries()) {
    if (
      !event || event.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION || event.sequence !== index + 1
      || typeof event.id !== "string" || typeof event.timestamp !== "string" || typeof event.type !== "string"
      || event.previousHash !== previousHash || event.eventHash !== eventHash(event)
      || !event.state || typeof event.state !== "object"
    ) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log failed sequence or hash-chain validation.", {
        details: { sequence: event?.sequence, expectedSequence: index + 1 }
      });
    }
    validateOrchestrationState({
      ...event.state,
      lastEvent: { sequence: event.sequence, id: event.id, hash: event.eventHash }
    });
    previousHash = event.eventHash;
  }
  if (events.length === 0) throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is empty.");
  return events;
}

async function readRecord(targetDirectory, relativePath) {
  const absolutePath = resolveProjectPath(targetDirectory, relativePath);
  const unsafe = await unsafeAncestor(targetDirectory, absolutePath);
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to read orchestration state through unsafe path: ${unsafe}`, {
      details: { path: relativePath, unsafeAncestor: unsafe }
    });
  }
  if (await pathType(absolutePath) !== "file") {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, `Missing Synod orchestration record: ${relativePath}`, {
      details: { path: relativePath }
    });
  }
  return readFile(absolutePath, "utf8");
}

async function readOrchestrationRaw(targetDirectory) {
  let state;
  try {
    state = JSON.parse(await readRecord(targetDirectory, ORCHESTRATION_STATE_PATH));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, `Could not parse ${ORCHESTRATION_STATE_PATH}: ${error.message}`, { cause: error });
  }
  validateOrchestrationState(state);

  const rawEvents = await readRecord(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  const lines = rawEvents.split(/\r?\n/).filter(Boolean);
  let events;
  try {
    events = validateEventLog(lines.map(line => JSON.parse(line)));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, `Could not parse ${ORCHESTRATION_EVENTS_PATH}: ${error.message}`, { cause: error });
  }
  const last = events.at(-1);
  const expectedState = {
    ...last.state,
    lastEvent: { sequence: last.sequence, id: last.id, hash: last.eventHash }
  };
  if (stableStringify(state) !== stableStringify(expectedState)) {
    throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Canonical state does not match the last append-only event.", {
      details: { stateSequence: state.lastEvent.sequence, eventSequence: last.sequence }
    });
  }
  return { state, events };
}

export async function readOrchestration(targetDirectory) {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    return await readOrchestrationRaw(targetDirectory);
  } finally {
    await release();
  }
}

function parseLockOwner(content) {
  try {
    const parsed = JSON.parse(content);
    if (
      Number.isSafeInteger(parsed?.pid)
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {}
  const legacyPid = Number(content.trim());
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
    return { pid: legacyPid, token: null };
  }
  return undefined;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function inspectLock(lockPath) {
  try {
    return await inspectPath(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { type: "missing" };
    throw error;
  }
}

async function reclaimStaleLock(targetDirectory, lockPath, existing) {
  const claimId = sha256Bytes(Buffer.from(existing.content, "utf8")).slice("sha256:".length);
  const claimPath = resolveProjectPath(
    targetDirectory,
    `.synod/orchestration-reclaim-${claimId}.lock`
  );
  let claimed = false;
  try {
    await link(lockPath, claimPath);
    claimed = true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    if (error.code === "EEXIST") {
      try {
        const [lockStats, claimStats] = await Promise.all([
          lstat(lockPath, { bigint: true }),
          lstat(claimPath, { bigint: true })
        ]);
        claimed = lockStats.dev === claimStats.dev && lockStats.ino === claimStats.ino;
      } catch (inspectionError) {
        if (inspectionError.code === "ENOENT") return false;
        throw inspectionError;
      }
      if (!claimed) return false;
    } else {
      throw error;
    }
  }

  try {
    const [claim, current] = await Promise.all([
      inspectLock(claimPath),
      inspectLock(lockPath)
    ]);
    if (
      claim.type !== "file"
      || claim.content !== existing.content
      || current.type !== "file"
      || current.content !== existing.content
    ) return false;
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return true;
  } finally {
    if (claimed) {
      try {
        await unlink(claimPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

async function acquireLock(targetDirectory) {
  const lockPath = resolveProjectPath(targetDirectory, ORCHESTRATION_LOCK_PATH);
  const unsafe = await unsafeAncestor(targetDirectory, lockPath);
  if (unsafe) throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to lock orchestration through unsafe path: ${unsafe}`);
  const token = randomUUID();
  const lockContent = serializeJson({ pid: process.pid, token, createdAt: nowIso() });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(lockContent, "utf8");
      await handle.sync();
      await handle.close();
      return async () => {
        const current = await inspectLock(lockPath);
        if (current.type === "missing") return;
        if (current.type === "file" && current.content === lockContent) await unlink(lockPath);
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code === "ENOENT") {
        throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration is not initialized in this project.");
      }
      if (error.code !== "EEXIST") throw error;

      const existing = await inspectLock(lockPath);
      if (existing.type === "missing") continue;
      if (existing.type !== "file") {
        throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Synod orchestration lock is not a regular file.", {
          details: { path: ORCHESTRATION_LOCK_PATH, type: existing.type }
        });
      }
      const owner = parseLockOwner(existing.content);
      if (!owner || processIsAlive(owner.pid)) {
        throw new SynodError(ERROR_CODES.ORCHESTRATION_LOCKED, "Another Synod orchestration mutation holds the project lock.", {
          details: { path: ORCHESTRATION_LOCK_PATH, ...(owner ? { pid: owner.pid } : {}) }
        });
      }

      await reclaimStaleLock(targetDirectory, lockPath, existing);
    }
  }

  throw new SynodError(ERROR_CODES.ORCHESTRATION_LOCKED, "Could not safely acquire the Synod orchestration lock after stale-lock recovery.", {
    details: { path: ORCHESTRATION_LOCK_PATH }
  });
}

async function appendEvent(targetDirectory, event) {
  const eventPath = resolveProjectPath(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  const unsafe = await unsafeAncestor(targetDirectory, eventPath);
  if (unsafe) throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to append through unsafe path: ${unsafe}`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(eventPath, flags);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, "Synod event log is not a regular file.");
    }
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPendingMutation(targetDirectory) {
  const inspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  if (inspected.type === "missing") return undefined;
  if (inspected.type !== "file") {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration mutation is not a regular file.");
  }
  let pending;
  try {
    pending = JSON.parse(inspected.content);
  } catch (error) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, `Could not parse ${ORCHESTRATION_PENDING_PATH}: ${error.message}`, { cause: error });
  }
  if (
    pending?.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION
    || pending.event?.eventHash !== eventHash(pending.event)
    || typeof pending.status !== "string"
    || typeof pending.expectedStateHash !== "string"
    || typeof pending.expectedStatusHash !== "string"
  ) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration mutation is invalid.");
  }
  const expectedState = {
    ...pending.event.state,
    lastEvent: {
      sequence: pending.event.sequence,
      id: pending.event.id,
      hash: pending.event.eventHash
    }
  };
  if (stableStringify(pending.state) !== stableStringify(expectedState)) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Pending orchestration state does not match its event.");
  }
  return { inspected, pending };
}

async function recoverPendingMutation(targetDirectory) {
  const record = await readPendingMutation(targetDirectory);
  if (!record) return false;
  const { pending } = record;
  const rawEvents = await readRecord(targetDirectory, ORCHESTRATION_EVENTS_PATH);
  let events;
  try {
    events = validateEventLog(rawEvents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.EVENT_LOG_INVALID, `Could not parse ${ORCHESTRATION_EVENTS_PATH}: ${error.message}`, { cause: error });
  }
  const last = events.at(-1);
  if (last.eventHash !== pending.event.eventHash) {
    if (
      last.eventHash !== pending.event.previousHash
      || pending.event.sequence !== last.sequence + 1
    ) {
      throw new SynodError(ERROR_CODES.STATE_LOG_MISMATCH, "Pending mutation does not continue the append-only event log.", {
        details: { eventSequence: last.sequence, pendingSequence: pending.event.sequence }
      });
    }
    await appendEvent(targetDirectory, pending.event);
  }

  const stateInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATE_PATH));
  const statusInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATUS_PATH));
  const nextStateContent = serializeJson(pending.state);
  const nextStateHash = contentHash(nextStateContent);
  const nextStatusHash = contentHash(pending.status);
  if (stateInspected.hash !== nextStateHash || statusInspected.hash !== nextStatusHash) {
    if (
      ![pending.expectedStateHash, nextStateHash].includes(stateInspected.hash)
      || ![pending.expectedStatusHash, nextStatusHash].includes(statusInspected.hash)
    ) {
      throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, "Canonical orchestration files changed while recovering a pending mutation.", {
        details: {
          state: { expected: pending.expectedStateHash, actual: stateInspected.hash },
          status: { expected: pending.expectedStatusHash, actual: statusInspected.hash }
        }
      });
    }
    await applyTransaction(targetDirectory, [
      {
        action: "write",
        path: ORCHESTRATION_STATE_PATH,
        content: nextStateContent,
        expected: { type: "file", hash: stateInspected.hash }
      },
      {
        action: "write",
        path: ORCHESTRATION_STATUS_PATH,
        content: pending.status,
        expected: { type: "file", hash: statusInspected.hash }
      }
    ]);
  }
  await unlink(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
  return true;
}

async function commitMutation(targetDirectory, type, metadata, reducer, dependencies = {}) {
  const release = await acquireLock(targetDirectory);
  try {
    await recoverPendingMutation(targetDirectory);
    const { state: current } = await readOrchestrationRaw(targetDirectory);
    const timestamp = nowIso(dependencies.clock);
    const checkpoint = await captureGitCheckpoint(targetDirectory, dependencies);
    const draft = structuredClone(current);
    const reducerResult = reducer(draft, {
      timestamp,
      checkpoint,
      nextSequence: current.lastEvent.sequence + 1
    }) || {};
    draft.updatedAt = timestamp;
    if (reducerResult.updateCheckpoint) draft.checkpoint = checkpoint;
    delete draft.lastEvent;
    validateOrchestrationState({
      ...draft,
      lastEvent: current.lastEvent
    });

    const eventMetadata = { ...metadata, ...reducerResult.metadata, checkpoint };
    const { event, state } = buildEvent(current, stateCore(draft), type, eventMetadata);
    const stateInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATE_PATH));
    const statusInspected = await inspectPath(resolveProjectPath(targetDirectory, ORCHESTRATION_STATUS_PATH));
    if (stateInspected.type !== "file" || statusInspected.type !== "file") {
      throw new SynodError(ERROR_CODES.ORCHESTRATION_NOT_INITIALIZED, "Synod orchestration state or its Markdown view is missing.");
    }

    const nextStateContent = serializeJson(state);
    const nextStatusContent = renderStatusMarkdown(state);
    const pending = {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      event,
      state,
      status: nextStatusContent,
      expectedStateHash: stateInspected.hash,
      expectedStatusHash: statusInspected.hash
    };
    await applyTransaction(targetDirectory, [{
      action: "write",
      path: ORCHESTRATION_PENDING_PATH,
      content: serializeJson(pending),
      expected: { type: "missing" }
    }], dependencies);
    try {
      await appendEvent(targetDirectory, event);
      await applyTransaction(targetDirectory, [
        {
          action: "write",
          path: ORCHESTRATION_STATE_PATH,
          content: nextStateContent,
          expected: { type: "file", hash: stateInspected.hash }
        },
        {
          action: "write",
          path: ORCHESTRATION_STATUS_PATH,
          content: nextStatusContent,
          expected: { type: "file", hash: statusInspected.hash }
        }
      ], dependencies);
      await unlink(resolveProjectPath(targetDirectory, ORCHESTRATION_PENDING_PATH));
    } catch (error) {
      try {
        await recoverPendingMutation(targetDirectory);
      } catch (recoveryError) {
        throw new SynodError(ERROR_CODES.TRANSACTION_FAILED, "Synod left a recoverable pending orchestration mutation after a commit failure.", {
          cause: error,
          details: { originalError: error.message, recoveryError: recoveryError.message }
        });
      }
    }
    return { state, event, ...reducerResult.result };
  } finally {
    await release();
  }
}

function normalizedList(values, label) {
  const result = [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
  if (result.length === 0) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, `A task requires at least one ${label}.`, { details: { field: label } });
  }
  return result;
}

export async function addTask({
  directory = ".",
  id,
  objective,
  executor,
  acceptance = [],
  verification = [],
  dependsOn = [],
  actor = "supervisor"
} = {}, dependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const taskObjective = String(objective || "").trim();
  const taskExecutor = String(executor || "").trim();
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(taskId) || !taskObjective || !taskExecutor) {
    throw new SynodError(ERROR_CODES.TASK_INVALID, "Task ID, objective, and executor are required.", {
      details: { id: taskId, objective: taskObjective, executor: taskExecutor }
    });
  }
  const criteria = normalizedList(acceptance, "acceptance criterion");
  const commands = normalizedList(verification, "verification command");
  const dependenciesList = [...new Set(dependsOn.map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  const targetDirectory = path.resolve(directory);

  return commitMutation(targetDirectory, "task.created", { actor, taskId }, (state, context) => {
    if (state.tasks[taskId]) throw new SynodError(ERROR_CODES.TASK_EXISTS, `Task ${taskId} already exists.`, { details: { taskId } });
    for (const dependency of dependenciesList) {
      if (!state.tasks[dependency] || dependency === taskId) {
        throw new SynodError(ERROR_CODES.TASK_INVALID, `Task ${taskId} has an unknown or self dependency: ${dependency}`, {
          details: { taskId, dependency }
        });
      }
    }
    const task = {
      id: taskId,
      objective: taskObjective,
      dependsOn: dependenciesList,
      state: "PLANNED",
      revision: 0,
      executor: taskExecutor,
      correctionRound: 0,
      acceptance: { criteria, status: "pending", revision: null, evidenceIds: [] },
      verification: { commands, status: "pending", revision: null, evidenceIds: [] },
      evidence: [],
      createdAt: context.timestamp,
      updatedAt: context.timestamp
    };
    state.tasks[taskId] = task;
    state.taskOrder.push(taskId);
    return {
      metadata: { revision: 0, toState: "PLANNED", payload: { task } },
      result: { task }
    };
  }, dependencies);
}

function requireRevision(task, targetState, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new SynodError(ERROR_CODES.REVISION_MISMATCH, "Every transition requires an integer --revision.", {
      details: { taskId: task.id, actual: revision }
    });
  }
  const expected = task.state === "ACTIVE" && targetState === "REVIEW" ? task.revision + 1 : task.revision;
  if (revision !== expected) {
    throw new SynodError(ERROR_CODES.REVISION_MISMATCH, `Task ${task.id} transition requires revision ${expected}, received ${revision}.`, {
      details: { taskId: task.id, expected, actual: revision, current: task.revision, targetState }
    });
  }
}

function requireEvidence(task, targetState, evidence) {
  const required = (task.state === "ACTIVE" && targetState === "REVIEW")
    || (task.state === "REVIEW" && targetState === "ACCEPTED")
    || (task.state === "ACCEPTED" && targetState === "VERIFIED")
    || (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(task.state));
  const values = [...new Set((evidence || []).map(value => String(value).trim()).filter(Boolean))];
  if (required && values.length === 0) {
    throw new SynodError(ERROR_CODES.EVIDENCE_REQUIRED, `Transitioning task ${task.id} to ${targetState} requires evidence.`, {
      details: { taskId: task.id, targetState, revision: targetState === "REVIEW" ? task.revision + 1 : task.revision }
    });
  }
  return values;
}

function evidenceKind(fromState, targetState) {
  if (fromState === "ACTIVE" && targetState === "REVIEW") return "delivery";
  if (fromState === "REVIEW" && targetState === "ACCEPTED") return "acceptance";
  if (fromState === "ACCEPTED" && targetState === "VERIFIED") return "verification";
  if (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) return "correction";
  return undefined;
}

function recordEvidence(state, task, kind, revision, references, actor, context) {
  const created = [];
  for (const reference of references) {
    state.evidenceCounter += 1;
    const item = {
      id: `E-${String(state.evidenceCounter).padStart(6, "0")}`,
      kind,
      revision,
      reference,
      actor,
      recordedAt: context.timestamp,
      checkpoint: {
        branch: context.checkpoint.branch,
        head: context.checkpoint.head,
        worktreeFingerprint: context.checkpoint.worktree.fingerprint
      }
    };
    task.evidence.push(item);
    created.push(item);
  }
  return created;
}

function resetAcceptanceAndVerification(task) {
  task.acceptance = { ...task.acceptance, status: "pending", revision: null, evidenceIds: [] };
  task.verification = { ...task.verification, status: "pending", revision: null, evidenceIds: [] };
}

export async function transitionTask({
  directory = ".",
  id,
  to,
  revision,
  evidence = [],
  actor = "supervisor",
  reason
} = {}, dependencies = {}) {
  const taskId = String(id || "").trim().toUpperCase();
  const targetState = String(to || "").trim().toUpperCase();
  if (!TASK_STATES.includes(targetState)) {
    throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Unknown task state: ${targetState}`, {
      details: { taskId, targetState, allowedStates: TASK_STATES }
    });
  }
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "task.transitioned", { actor, taskId }, (state, context) => {
    const task = state.tasks[taskId];
    if (!task) throw new SynodError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} does not exist.`, { details: { taskId } });
    if (!TRANSITIONS[task.state].has(targetState)) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} cannot transition from ${task.state} to ${targetState}.`, {
        details: { taskId, fromState: task.state, targetState, allowed: [...TRANSITIONS[task.state]] }
      });
    }
    if (task.state === "BLOCKED" && targetState !== "SUPERSEDED" && targetState !== task.blockedFrom) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Blocked task ${taskId} must resume ${task.blockedFrom}, not ${targetState}.`, {
        details: { taskId, blockedFrom: task.blockedFrom, targetState }
      });
    }
    requireRevision(task, targetState, revision);
    const references = requireEvidence(task, targetState, evidence);
    if (["BLOCKED", "SUPERSEDED"].includes(targetState) && !String(reason || "").trim()) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `${targetState} requires --reason.`, {
        details: { taskId, targetState }
      });
    }
    if (targetState === "READY") {
      const incomplete = task.dependsOn.filter(dependency => state.tasks[dependency].state !== "DONE");
      if (incomplete.length > 0) {
        throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} has incomplete dependencies.`, {
          details: { taskId, incomplete }
        });
      }
    }

    const fromState = task.state;
    if (fromState === "ACTIVE" && targetState === "REVIEW") task.revision = revision;
    const kind = evidenceKind(fromState, targetState);
    const createdEvidence = kind
      ? recordEvidence(state, task, kind, revision, references, actor, context)
      : [];

    if (targetState === "ACTIVE" && ["REVIEW", "ACCEPTED", "VERIFIED"].includes(fromState)) {
      task.correctionRound += 1;
      resetAcceptanceAndVerification(task);
    }
    if (fromState === "REVIEW" && targetState === "ACCEPTED") {
      task.acceptance = {
        ...task.acceptance,
        status: "accepted",
        revision,
        evidenceIds: createdEvidence.map(item => item.id)
      };
      task.verification = { ...task.verification, status: "pending", revision: null, evidenceIds: [] };
    }
    if (fromState === "ACCEPTED" && targetState === "VERIFIED") {
      if (task.acceptance.status !== "accepted" || task.acceptance.revision !== revision) {
        throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} has no acceptance for revision ${revision}.`, {
          details: { taskId, revision }
        });
      }
      task.verification = {
        ...task.verification,
        status: "passed",
        revision,
        evidenceIds: createdEvidence.map(item => item.id)
      };
    }
    if (targetState === "DONE" && (
      task.acceptance.status !== "accepted" || task.acceptance.revision !== revision
      || task.verification.status !== "passed" || task.verification.revision !== revision
    )) {
      throw new SynodError(ERROR_CODES.TRANSITION_INVALID, `Task ${taskId} cannot finish without acceptance and verification for revision ${revision}.`, {
        details: { taskId, revision }
      });
    }

    task.state = targetState;
    task.updatedAt = context.timestamp;
    if (targetState === "BLOCKED") {
      task.blocker = String(reason).trim();
      task.blockedFrom = fromState;
    } else {
      delete task.blocker;
      delete task.blockedFrom;
    }
    if (targetState === "SUPERSEDED") task.supersededReason = String(reason).trim();

    return {
      metadata: {
        fromState,
        toState: targetState,
        revision: task.revision,
        payload: {
          correctionRound: task.correctionRound,
          evidenceIds: createdEvidence.map(item => item.id),
          ...(reason ? { reason: String(reason).trim() } : {})
        }
      },
      result: { task, evidence: createdEvidence }
    };
  }, dependencies);
}

export async function recordCheckpoint({ directory = ".", actor = "supervisor", message } = {}, dependencies = {}) {
  const targetDirectory = path.resolve(directory);
  return commitMutation(targetDirectory, "checkpoint.recorded", { actor }, (_state, context) => ({
    updateCheckpoint: true,
    metadata: { payload: { ...(message ? { message: String(message).trim() } : {}) } },
    result: { checkpoint: context.checkpoint }
  }), dependencies);
}

export async function orchestrationStatus({ directory = "." } = {}, dependencies = {}) {
  const targetDirectory = path.resolve(directory);
  const release = await acquireLock(targetDirectory);
  let state;
  let events;
  let markdown;
  let currentCheckpoint;
  try {
    await recoverPendingMutation(targetDirectory);
    ({ state, events } = await readOrchestrationRaw(targetDirectory));
    markdown = await readRecord(targetDirectory, ORCHESTRATION_STATUS_PATH);
    currentCheckpoint = await captureGitCheckpoint(targetDirectory, dependencies);
  } finally {
    await release();
  }
  const expectedMarkdown = renderStatusMarkdown(state);
  if (contentHash(markdown) !== contentHash(expectedMarkdown)) {
    throw new SynodError(ERROR_CODES.ORCHESTRATION_STATE_INVALID, "Generated Markdown status does not match canonical orchestration state.", {
      details: {
        path: ORCHESTRATION_STATUS_PATH,
        expectedHash: contentHash(expectedMarkdown),
        actualHash: contentHash(markdown)
      }
    });
  }
  const drift = checkpointDrift(state.checkpoint, currentCheckpoint);
  const counts = Object.fromEntries(TASK_STATES.map(taskState => [taskState, 0]));
  for (const task of taskList(state)) counts[task.state] += 1;
  return {
    targetDirectory,
    healthy: !drift.detected,
    stateSchemaVersion: state.schemaVersion,
    templateVersion: state.templateVersion,
    updatedAt: state.updatedAt,
    lastEvent: state.lastEvent,
    eventCount: events.length,
    checkpoint: state.checkpoint,
    currentCheckpoint,
    drift,
    taskCounts: counts,
    tasks: taskList(state),
    markdownView: ORCHESTRATION_STATUS_PATH
  };
}

export function formatOrchestrationStatus(result) {
  const lines = [`Synod orchestration: ${result.healthy ? "in sync" : "checkpoint drift detected"}`];
  lines.push(`State schema: ${result.stateSchemaVersion}; events: ${result.eventCount}`);
  lines.push(`Checkpoint: ${checkpointLabel(result.checkpoint)}`);
  lines.push(`Current: ${checkpointLabel(result.currentCheckpoint)}`);
  for (const task of result.tasks) {
    lines.push(`${task.id.padEnd(12)} ${task.state.padEnd(10)} r${task.revision} correction ${task.correctionRound} executor ${task.executor}; acceptance ${task.acceptance.status}; verification ${task.verification.status}`);
  }
  if (result.tasks.length === 0) lines.push("No tasks recorded.");
  for (const reason of result.drift.reasons) lines.push(`Drift ${reason.field}: expected ${reason.expected}, actual ${reason.actual}`);
  return lines.join("\n");
}

export function isTerminalTaskState(state) {
  return TERMINAL_STATES.has(state);
}
