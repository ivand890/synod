import { createHash } from "node:crypto";
import path from "node:path";
import { ERROR_CODES, SynodError } from "./errors.js";
import { isRecord } from "./validation.js";

export const CHECKPOINT_SNAPSHOT_SCHEMA_VERSION = 1;
export const CHECKPOINT_SNAPSHOT_PATH = ".synod/checkpoint.json";

export type CheckpointPathType = "file" | "symlink" | "directory" | "other" | "ignored" | "missing";

export interface CheckpointIndexEntry {
  mode: string;
  stage: number;
  objectId?: string;
  type?: "file" | "ignored";
  contentHash?: string;
}

export interface CheckpointEntry {
  status: string;
  path: string;
  sourcePath?: string;
  type: CheckpointPathType;
  contentHash?: string;
  gitHead?: string;
  worktreeFingerprint?: string;
  binary?: boolean;
  index?: CheckpointIndexEntry[];
}

export interface CheckpointSnapshotPayload {
  schemaVersion: typeof CHECKPOINT_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  available: boolean;
  branch: string | null;
  head: string | null;
  worktreeFingerprint: string;
  entries: CheckpointEntry[];
}

export interface CheckpointSnapshot extends CheckpointSnapshotPayload {
  contentHash: string;
}

export interface CheckpointSnapshotReference {
  path: typeof CHECKPOINT_SNAPSHOT_PATH;
  contentHash: string;
}

export type DeltaChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged";

export interface CheckpointDeltaPath {
  path: string;
  sourcePath?: string;
  staged?: DeltaChangeKind;
  unstaged?: DeltaChangeKind;
  committed?: DeltaChangeKind;
  untracked: boolean;
  binary: boolean;
  resolved: boolean;
  checkpoint?: CheckpointEntry;
  current?: CheckpointEntry;
}

export interface CheckpointDelta {
  changed: boolean;
  paths: CheckpointDeltaPath[];
  counts: {
    staged: number;
    unstaged: number;
    committed: number;
    untracked: number;
    resolved: number;
    binary: number;
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableCheckpointStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function compareCheckpointPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function checkpointSnapshotHash(payload: CheckpointSnapshotPayload): string {
  return sha256(stableCheckpointStringify(payload));
}

export function createCheckpointSnapshot(payload: Omit<CheckpointSnapshotPayload, "schemaVersion">): CheckpointSnapshot {
  const normalized: CheckpointSnapshotPayload = {
    schemaVersion: CHECKPOINT_SNAPSHOT_SCHEMA_VERSION,
    ...payload,
    entries: [...payload.entries].sort((left, right) => compareCheckpointPaths(
      `${left.path}\0${left.sourcePath || ""}`,
      `${right.path}\0${right.sourcePath || ""}`
    ))
  };
  return { ...normalized, contentHash: checkpointSnapshotHash(normalized) };
}

export function serializeCheckpointSnapshot(snapshot: CheckpointSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIndexEntry(value: unknown): value is CheckpointIndexEntry {
  return isRecord(value)
    && typeof value.mode === "string"
    && /^[0-7]{6}$/.test(value.mode)
    && Number.isSafeInteger(value.stage)
    && typeof value.stage === "number"
    && value.stage >= 0
    && (value.objectId === undefined || (typeof value.objectId === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.objectId)))
    && (value.type === undefined || value.type === "file" || value.type === "ignored")
    && (value.contentHash === undefined || isHash(value.contentHash));
}

function isCheckpointPathType(value: unknown): value is CheckpointPathType {
  return value === "file" || value === "symlink" || value === "directory" || value === "other"
    || value === "ignored" || value === "missing";
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && !value.includes("\0")
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== ".."
    && !value.startsWith("../");
}

function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  return isRecord(value)
    && typeof value.status === "string"
    && value.status.length === 2
    && /^[ MADRCUT?!]{2}$/.test(value.status)
    && isSafeRelativePath(value.path)
    && (value.sourcePath === undefined || isSafeRelativePath(value.sourcePath))
    && value.sourcePath !== value.path
    && isCheckpointPathType(value.type)
    && (value.contentHash === undefined || isHash(value.contentHash))
    && (value.gitHead === undefined || typeof value.gitHead === "string")
    && (value.worktreeFingerprint === undefined || isHash(value.worktreeFingerprint))
    && (value.binary === undefined || typeof value.binary === "boolean")
    && (value.index === undefined || (Array.isArray(value.index) && value.index.every(isIndexEntry)));
}

export function validateCheckpointSnapshot(value: unknown): CheckpointSnapshot {
  if (
    !isRecord(value)
    || value.schemaVersion !== CHECKPOINT_SNAPSHOT_SCHEMA_VERSION
    || typeof value.capturedAt !== "string"
    || typeof value.available !== "boolean"
    || !isNullableString(value.branch)
    || !isNullableString(value.head)
    || !isHash(value.worktreeFingerprint)
    || !Array.isArray(value.entries)
    || !value.entries.every(isCheckpointEntry)
    || !isHash(value.contentHash)
  ) {
    throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "The canonical checkpoint snapshot is invalid.", {
      details: { path: CHECKPOINT_SNAPSHOT_PATH }
    });
  }
  const snapshot: CheckpointSnapshot = {
    schemaVersion: CHECKPOINT_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: value.capturedAt,
    available: value.available,
    branch: value.branch,
    head: value.head,
    worktreeFingerprint: value.worktreeFingerprint,
    entries: value.entries,
    contentHash: value.contentHash
  };
  const sorted = [...snapshot.entries].sort((left, right) => compareCheckpointPaths(
    `${left.path}\0${left.sourcePath || ""}`,
    `${right.path}\0${right.sourcePath || ""}`
  ));
  const unique = new Set(sorted.map(entry => entry.path));
  if (
    unique.size !== sorted.length
    || stableCheckpointStringify(sorted) !== stableCheckpointStringify(snapshot.entries)
    || checkpointSnapshotHash({
      schemaVersion: snapshot.schemaVersion,
      capturedAt: snapshot.capturedAt,
      available: snapshot.available,
      branch: snapshot.branch,
      head: snapshot.head,
      worktreeFingerprint: snapshot.worktreeFingerprint,
      entries: snapshot.entries
    }) !== snapshot.contentHash
  ) {
    throw new SynodError(ERROR_CODES.CHECKPOINT_SNAPSHOT_INVALID, "The canonical checkpoint snapshot failed ordering or hash validation.", {
      details: { path: CHECKPOINT_SNAPSHOT_PATH }
    });
  }
  return snapshot;
}

function changeKind(code: string | undefined): DeltaChangeKind | undefined {
  if (!code || code === " " || code === "?") return undefined;
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "T") return "type-changed";
  return "unmerged";
}

export function explainCheckpointDelta(checkpoint: CheckpointSnapshot, current: CheckpointSnapshot): CheckpointDelta {
  const before = new Map(checkpoint.entries.map(entry => [entry.path, entry]));
  const after = new Map(current.entries.map(entry => [entry.path, entry]));
  const paths: CheckpointDeltaPath[] = [];
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort(compareCheckpointPaths);
  for (const relativePath of allPaths) {
    const checkpointEntry = before.get(relativePath);
    const currentEntry = after.get(relativePath);
    if (stableCheckpointStringify(checkpointEntry) === stableCheckpointStringify(currentEntry)) continue;
    const status = currentEntry?.status;
    const untracked = status === "??";
    const staged = untracked ? undefined : changeKind(status?.[0]);
    const unstaged = untracked ? undefined : changeKind(status?.[1]);
    const sourcePath = currentEntry?.sourcePath || checkpointEntry?.sourcePath;
    paths.push({
      path: relativePath,
      ...(sourcePath ? { sourcePath } : {}),
      ...(staged ? { staged } : {}),
      ...(unstaged ? { unstaged } : {}),
      untracked,
      binary: Boolean(currentEntry?.binary || checkpointEntry?.binary),
      resolved: currentEntry === undefined,
      ...(checkpointEntry ? { checkpoint: checkpointEntry } : {}),
      ...(currentEntry ? { current: currentEntry } : {})
    });
  }
  return {
    changed: paths.length > 0 || checkpoint.branch !== current.branch || checkpoint.head !== current.head,
    paths,
    counts: {
      staged: paths.filter(item => item.staged).length,
      unstaged: paths.filter(item => item.unstaged).length,
      committed: paths.filter(item => item.committed).length,
      untracked: paths.filter(item => item.untracked).length,
      resolved: paths.filter(item => item.resolved).length,
      binary: paths.filter(item => item.binary).length
    }
  };
}

export function formatCheckpointDelta(delta: CheckpointDelta): string[] {
  if (!delta.changed) return ["Checkpoint delta: no path changes."];
  const lines = [
    `Checkpoint delta: ${delta.paths.length} path(s); ${delta.counts.committed} committed, ${delta.counts.staged} staged, ${delta.counts.unstaged} unstaged, ${delta.counts.untracked} untracked, ${delta.counts.resolved} resolved.`
  ];
  for (const item of delta.paths) {
    const labels = [
      item.staged ? `staged ${item.staged}` : undefined,
      item.unstaged ? `unstaged ${item.unstaged}` : undefined,
      item.committed ? `committed ${item.committed}` : undefined,
      item.untracked ? "untracked" : undefined,
      item.resolved ? "resolved" : undefined,
      item.binary ? "binary" : undefined
    ].filter((label): label is string => Boolean(label));
    const pathLabel = item.sourcePath ? `${item.sourcePath} -> ${item.path}` : item.path;
    lines.push(`  ${pathLabel}: ${labels.join(", ") || "changed"}`);
  }
  return lines;
}

export interface CommittedCheckpointChange {
  path: string;
  sourcePath?: string;
  kind: DeltaChangeKind;
  binary?: boolean;
}

export function addCommittedCheckpointChanges(
  delta: CheckpointDelta,
  changes: CommittedCheckpointChange[]
): CheckpointDelta {
  const paths = new Map(delta.paths.map(item => [item.path, item]));
  for (const change of changes) {
    const existing = paths.get(change.path);
    paths.set(change.path, {
      ...(existing || {
        path: change.path,
        untracked: false,
        binary: false,
        resolved: false
      }),
      ...(change.sourcePath ? { sourcePath: change.sourcePath } : {}),
      committed: change.kind,
      binary: Boolean(existing?.binary || change.binary)
    });
  }
  const values = [...paths.values()].sort((left, right) => compareCheckpointPaths(left.path, right.path));
  return {
    changed: delta.changed || changes.length > 0,
    paths: values,
    counts: {
      staged: values.filter(item => item.staged).length,
      unstaged: values.filter(item => item.unstaged).length,
      committed: values.filter(item => item.committed).length,
      untracked: values.filter(item => item.untracked).length,
      resolved: values.filter(item => item.resolved).length,
      binary: values.filter(item => item.binary).length
    }
  };
}
