import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { compareCheckpointPaths } from "./checkpoint.js";
import type { CheckpointEntry } from "./checkpoint.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { captureGitCheckpointSnapshot, checkpointDrift, withValidatedCheckpointSource } from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import { packageVersion } from "./package.js";
import { generatedConfigMarker, removeAgentsBlocks } from "./templates.js";
import { errorCode, errorMessage, isRecord, parseJson } from "./validation.js";
import { normalizeText } from "./filesystem.js";

export const RECOVERY_BUNDLE_SCHEMA_VERSION = 1;
export const RECOVERY_MANIFEST_PATH = "manifest.json";
export const RECOVERY_OBJECTS_PATH = "objects";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

type RawGitRunner = (directory: string, args: string[]) => Promise<Buffer>;

export interface RecoveryDependencies extends OrchestrationDependencies {
  rawGitRunner?: RawGitRunner;
}

export interface BundleExportOptions {
  directory?: string;
  destination: string;
  includeUntracked?: boolean;
}

export interface BundleVerifyOptions {
  bundle: string;
}

export interface RecoveryObject {
  hash: string;
  size: number;
}

export interface RecoveryIndexEntry {
  mode: string;
  stage: number;
  object: string | null;
}

export interface RecoveryWorktreeEntry {
  type: "file" | "symlink" | "missing" | "ignored";
  mode: string | null;
  object: string | null;
}

export interface RecoveryEntry {
  path: string;
  sourcePath?: string;
  status: string;
  binary: boolean;
  filtered: boolean;
  index: RecoveryIndexEntry[];
  worktree: RecoveryWorktreeEntry;
}

export interface RecoveryManifestPayload {
  schemaVersion: typeof RECOVERY_BUNDLE_SCHEMA_VERSION;
  synodVersion: string;
  createdAt: string;
  source: { branch: string | null; head: string | null };
  checkpoint: { fingerprint: string; snapshotHash: string };
  event: { sequence: number; hash: string };
  includeUntracked: boolean;
  entries: RecoveryEntry[];
  objects: RecoveryObject[];
}

export interface RecoveryManifest extends RecoveryManifestPayload {
  bundleId: string;
}

export interface BundleVerification {
  bundle: string;
  bundleId: string;
  manifest: RecoveryManifest;
  entries: number;
  objects: number;
  bytes: number;
}

export interface BundleExportResult extends BundleVerification {
  destination: string;
}

interface RawIndexEntry {
  mode: string;
  objectId: string;
  stage: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function serializeManifest(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function hashBytes(value: NodeJS.ArrayBufferView): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function payloadHash(value: RecoveryManifestPayload): string {
  return hashBytes(Buffer.from(stableStringify(value), "utf8"));
}

function isFilteredPath(relativePath: string): boolean {
  return relativePath === "AGENTS.md" || relativePath === ".codex/config.toml";
}

function filteredMaterial(relativePath: string, content: Buffer): Buffer | undefined {
  if (relativePath === "AGENTS.md") {
    const userContent = normalizeText(removeAgentsBlocks(content.toString("utf8"))).replace(/\n+$/u, "");
    return userContent.length === 0 ? undefined : Buffer.from(`${userContent}\n`, "utf8");
  }
  if (relativePath === ".codex/config.toml") {
    const text = content.toString("utf8");
    return text.startsWith(generatedConfigMarker) ? undefined : content;
  }
  return content;
}

function recoveryMaterial(relativePath: string, content: Buffer): Buffer | undefined {
  return isFilteredPath(relativePath) ? filteredMaterial(relativePath, content) : content;
}

function invalid(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, message, { details });
}

function corrupt(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_CORRUPT, message, { details });
}

function sourceChanged(message: string, details?: unknown): never {
  throw new SynodError(ERROR_CODES.CHECKPOINT_DRIFT, message, { details });
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isSafePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && !value.includes("\0")
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && value !== ".."
    && !value.startsWith("../")
    && path.posix.normalize(value) === value;
}

function validatePathSet(entries: RecoveryEntry[]): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  for (const entry of entries) {
    if (exact.has(entry.path)) invalid("Recovery bundle paths must be unique.", { path: entry.path });
    exact.add(entry.path);
    const key = entry.path.normalize("NFC").toLowerCase();
    const prior = folded.get(key);
    if (prior && prior !== entry.path) {
      invalid("Recovery bundle paths collide under case-insensitive normalization.", { paths: [prior, entry.path] });
    }
    folded.set(key, entry.path);
  }
  const sorted = [...exact].sort(compareCheckpointPaths);
  for (const relativePath of sorted) {
    let parent = path.posix.dirname(relativePath);
    while (parent !== ".") {
      if (exact.has(parent)) invalid("Recovery bundle contains a parent/child file collision.", { parent, path: relativePath });
      parent = path.posix.dirname(parent);
    }
  }
}

function validateIndexEntry(value: unknown): RecoveryIndexEntry {
  if (!isRecord(value)
    || !exactKeys(value, ["mode", "stage", "object"])
    || typeof value.mode !== "string"
    || !/^[0-7]{6}$/.test(value.mode)
    || typeof value.stage !== "number"
    || !Number.isSafeInteger(value.stage)
    || value.stage < 0
    || (value.object !== null && !isHash(value.object))) {
    invalid("Recovery bundle contains an invalid index entry.");
  }
  return { mode: value.mode, stage: value.stage, object: value.object as string | null };
}

function validateWorktreeEntry(value: unknown): RecoveryWorktreeEntry {
  if (!isRecord(value)
    || !exactKeys(value, ["type", "mode", "object"])
    || !["file", "symlink", "missing", "ignored"].includes(String(value.type))
    || (value.mode !== null && (typeof value.mode !== "string" || !/^[0-7]{6}$/.test(value.mode)))
    || (value.object !== null && !isHash(value.object))) {
    invalid("Recovery bundle contains an invalid worktree entry.");
  }
  const type = value.type as RecoveryWorktreeEntry["type"];
  if ((type === "file" || type === "symlink") !== (value.object !== null)) {
    invalid("Recovery worktree material does not match its path type.");
  }
  if ((type === "missing" || type === "ignored") && value.mode !== null) {
    invalid("Absent or ignored recovery paths cannot declare a mode.");
  }
  return { type, mode: value.mode as string | null, object: value.object as string | null };
}

function validateEntry(value: unknown): RecoveryEntry {
  if (!isRecord(value)
    || !exactKeys(value, ["path", "status", "binary", "filtered", "index", "worktree"], ["sourcePath"])
    || !isSafePath(value.path)
    || (value.sourcePath !== undefined && (!isSafePath(value.sourcePath) || value.sourcePath === value.path))
    || typeof value.status !== "string"
    || !/^[ MADRCUT?!]{2}$/.test(value.status)
    || typeof value.binary !== "boolean"
    || typeof value.filtered !== "boolean"
    || !Array.isArray(value.index)) {
    invalid("Recovery bundle contains an invalid path entry.");
  }
  if (value.filtered !== isFilteredPath(value.path)) {
    invalid("Recovery bundle path filtering metadata is inconsistent.", { path: value.path });
  }
  const index = value.index.map(validateIndexEntry);
  const stages = new Set(index.map(item => item.stage));
  if (stages.size !== index.length || index.some((item, position) => position > 0 && index[position - 1]!.stage >= item.stage)) {
    invalid("Recovery index stages must be unique and sorted.", { path: value.path });
  }
  return {
    path: value.path,
    ...(value.sourcePath === undefined ? {} : { sourcePath: value.sourcePath as string }),
    status: value.status,
    binary: value.binary,
    filtered: value.filtered,
    index,
    worktree: validateWorktreeEntry(value.worktree)
  };
}

export function validateRecoveryManifest(value: unknown): RecoveryManifest {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "bundleId", "synodVersion", "createdAt", "source", "checkpoint",
      "event", "includeUntracked", "entries", "objects"
    ])
    || value.schemaVersion !== RECOVERY_BUNDLE_SCHEMA_VERSION
    || !isHash(value.bundleId)
    || typeof value.synodVersion !== "string"
    || typeof value.createdAt !== "string"
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.includeUntracked !== "boolean"
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_ENTRIES
    || !Array.isArray(value.objects)
    || value.objects.length > MAX_ENTRIES * 3
    || !isRecord(value.source)
    || !exactKeys(value.source, ["branch", "head"])
    || (value.source.branch !== null && typeof value.source.branch !== "string")
    || (value.source.head !== null && (typeof value.source.head !== "string" || !/^[0-9a-f]{40,64}$/.test(value.source.head)))
    || !isRecord(value.checkpoint)
    || !exactKeys(value.checkpoint, ["fingerprint", "snapshotHash"])
    || !isHash(value.checkpoint.fingerprint)
    || !isHash(value.checkpoint.snapshotHash)
    || !isRecord(value.event)
    || !exactKeys(value.event, ["sequence", "hash"])
    || typeof value.event.sequence !== "number"
    || !Number.isSafeInteger(value.event.sequence)
    || value.event.sequence < 1
    || !isHash(value.event.hash)) {
    invalid("Recovery bundle manifest schema is invalid.");
  }
  const entries = value.entries.map(validateEntry);
  const sortedEntries = [...entries].sort((left, right) => compareCheckpointPaths(
    `${left.path}\0${left.sourcePath || ""}`,
    `${right.path}\0${right.sourcePath || ""}`
  ));
  if (stableStringify(entries) !== stableStringify(sortedEntries)) invalid("Recovery bundle entries are not sorted.");
  validatePathSet(entries);

  const objects: RecoveryObject[] = value.objects.map(item => {
    if (!isRecord(item)
      || !exactKeys(item, ["hash", "size"])
      || !isHash(item.hash)
      || typeof item.size !== "number"
      || !Number.isSafeInteger(item.size)
      || item.size < 0
      || item.size > MAX_OBJECT_BYTES) {
      invalid("Recovery bundle contains an invalid object descriptor.");
    }
    return { hash: item.hash, size: item.size };
  });
  const sortedObjects = [...objects].sort((left, right) => compareCheckpointPaths(left.hash, right.hash));
  if (stableStringify(objects) !== stableStringify(sortedObjects)
    || new Set(objects.map(item => item.hash)).size !== objects.length) {
    invalid("Recovery bundle objects must be unique and sorted.");
  }
  const references = new Set<string>();
  for (const entry of entries) {
    for (const item of entry.index) if (item.object) references.add(item.object);
    if (entry.worktree.object) references.add(entry.worktree.object);
  }
  if (stableStringify([...references].sort(compareCheckpointPaths)) !== stableStringify(objects.map(item => item.hash))) {
    invalid("Recovery bundle object declarations do not exactly match referenced material.");
  }
  if (!value.includeUntracked && entries.some(entry => entry.status === "??")) {
    invalid("Recovery bundle contains untracked material without an opt-in declaration.");
  }
  const payload: RecoveryManifestPayload = {
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
    synodVersion: value.synodVersion,
    createdAt: value.createdAt,
    source: { branch: value.source.branch as string | null, head: value.source.head as string | null },
    checkpoint: {
      fingerprint: value.checkpoint.fingerprint as string,
      snapshotHash: value.checkpoint.snapshotHash as string
    },
    event: { sequence: value.event.sequence, hash: value.event.hash as string },
    includeUntracked: value.includeUntracked,
    entries,
    objects
  };
  if (payloadHash(payload) !== value.bundleId) corrupt("Recovery bundle ID does not match its manifest payload.");
  return { ...payload, bundleId: value.bundleId };
}

async function defaultRawGitRunner(directory: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile("git", [
      "-C", directory,
      "-c", "core.fsmonitor=false",
      "-c", "status.renames=true",
      "-c", "diff.renames=true",
      ...args
    ], {
      encoding: "buffer",
      maxBuffer: MAX_OBJECT_BYTES + 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function indexRecords(output: Buffer): Map<string, RawIndexEntry[]> {
  const records = new Map<string, RawIndexEntry[]>();
  for (const field of output.toString("utf8").split("\0")) {
    if (!field) continue;
    const separator = field.indexOf("\t");
    const metadata = separator < 0 ? [] : field.slice(0, separator).split(" ");
    const relativePath = separator < 0 ? "" : field.slice(separator + 1);
    const [mode, objectId, stageValue] = metadata;
    if (!mode || !objectId || stageValue === undefined || !isSafePath(relativePath)) {
      throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Git returned an unsafe or malformed index path.");
    }
    const entries = records.get(relativePath) || [];
    entries.push({ mode, objectId, stage: Number(stageValue) });
    records.set(relativePath, entries);
  }
  return records;
}

async function readWorktreeMaterial(
  directory: string,
  entry: CheckpointEntry
): Promise<{ descriptor: RecoveryWorktreeEntry; material?: Buffer }> {
  const absolutePath = path.resolve(directory, ...entry.path.split("/"));
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { descriptor: { type: "missing", mode: null, object: null } };
    throw error;
  }
  if (stats.isDirectory()) {
    throw new SynodError(ERROR_CODES.RECOVERY_SUBMODULE_UNSUPPORTED, "Dirty submodules are not supported by recovery bundle schema 1.", {
      details: { path: entry.path }
    });
  }
  if (stats.isSymbolicLink()) {
    const raw = await readlink(absolutePath, { encoding: "buffer" });
    return {
      descriptor: { type: "symlink", mode: "120000", object: hashBytes(raw) },
      material: raw
    };
  }
  if (!stats.isFile()) invalid("Recovery export encountered an unsupported worktree path type.", { path: entry.path });
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(absolutePath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) invalid("Recovery export path changed type while being read.", { path: entry.path });
    const raw = await handle.readFile();
    const material = recoveryMaterial(entry.path, raw);
    if (material === undefined) return { descriptor: { type: "ignored", mode: null, object: null } };
    const mode = (opened.mode & 0o111) === 0 ? "100644" : "100755";
    return { descriptor: { type: "file", mode, object: hashBytes(material) }, material };
  } finally {
    await handle.close();
  }
}

function assertEntryMaterialMatchesSnapshot(
  snapshot: CheckpointEntry,
  rawIndex: RawIndexEntry[],
  index: RecoveryIndexEntry[],
  worktree: RecoveryWorktreeEntry
): void {
  if (snapshot.contentHash && worktree.object !== snapshot.contentHash) {
    sourceChanged("Recovery export material changed while the worktree was being read.", { path: snapshot.path });
  }
  if (snapshot.type === "missing" && worktree.type !== "missing") {
    sourceChanged("Recovery export path changed while the worktree was being read.", { path: snapshot.path });
  }
  if (snapshot.type === "ignored" && worktree.type !== "ignored") {
    sourceChanged("Recovery export filtered path changed while the worktree was being read.", { path: snapshot.path });
  }
  const expected = snapshot.index || [];
  if (expected.length !== rawIndex.length || expected.length !== index.length) {
    sourceChanged("Recovery export index changed while it was being read.", { path: snapshot.path });
  }
  for (let position = 0; position < expected.length; position += 1) {
    const checkpointItem = expected[position]!;
    const rawItem = rawIndex[position]!;
    const recoveryItem = index[position]!;
    if (checkpointItem.mode !== rawItem.mode
      || checkpointItem.stage !== rawItem.stage
      || (checkpointItem.objectId && checkpointItem.objectId !== rawItem.objectId)
      || (checkpointItem.contentHash && checkpointItem.contentHash !== recoveryItem.object)
      || (checkpointItem.type === "ignored" && recoveryItem.object !== null)) {
      sourceChanged("Recovery export index material does not match the acknowledged checkpoint.", { path: snapshot.path });
    }
  }
}

async function assertSourceStillMatches(
  directory: string,
  expected: Parameters<typeof checkpointDrift>[0],
  dependencies: RecoveryDependencies
): Promise<void> {
  const current = await captureGitCheckpointSnapshot(directory, dependencies);
  const drift = checkpointDrift(expected, current.checkpoint);
  if (drift.detected) {
    throw new SynodError(ERROR_CODES.CHECKPOINT_DRIFT, "The source checkout changed during recovery export.", {
      details: { drift }
    });
  }
}

function assertSafeSymlink(entry: RecoveryEntry, content: Buffer): void {
  const target = content.toString("utf8");
  if (!Buffer.from(target, "utf8").equals(content)
    || target.length === 0
    || target.includes("\0")
    || target.includes("\\")
    || path.posix.isAbsolute(target)) {
    invalid("Recovery bundle contains an unsafe symlink target.", { path: entry.path });
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    invalid("Recovery bundle symlink escapes the checkout root.", { path: entry.path });
  }
}

async function writeDurableFile(filePath: string, content: Buffer | string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) invalid(`${label} must be a bounded regular file.`);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, `${label} could not be read safely: ${errorMessage(error)}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function requireMissingDestination(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_EXISTS, "Recovery bundle destination already exists.", {
      details: { destination }
    });
  } catch (error) {
    if (error instanceof SynodError) throw error;
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function validateDestinationParent(destination: string): Promise<void> {
  const parent = path.dirname(destination);
  let stats;
  try {
    stats = await lstat(parent);
  } catch (error) {
    invalid(`Recovery bundle parent is unavailable: ${errorMessage(error)}`, { parent });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) invalid("Recovery bundle parent must be a real directory.", { parent });
}

export async function verifyRecoveryBundle(
  { bundle }: BundleVerifyOptions
): Promise<BundleVerification> {
  const bundlePath = path.resolve(bundle);
  let rootStats;
  try {
    rootStats = await lstat(bundlePath);
  } catch (error) {
    invalid(`Recovery bundle is unavailable: ${errorMessage(error)}`, { bundle: bundlePath });
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) invalid("Recovery bundle root must be a real directory.", { bundle: bundlePath });
  const rootNames = (await readdir(bundlePath)).sort(compareCheckpointPaths);
  if (stableStringify(rootNames) !== stableStringify([RECOVERY_MANIFEST_PATH, RECOVERY_OBJECTS_PATH])) {
    invalid("Recovery bundle root must contain exactly manifest.json and objects/.", { entries: rootNames });
  }
  const manifestPath = path.join(bundlePath, RECOVERY_MANIFEST_PATH);
  const manifestStats = await lstat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) invalid("Recovery bundle manifest must be a bounded regular file.");
  const manifestBytes = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES, "Recovery bundle manifest");
  let parsed: unknown;
  try {
    parsed = parseJson(manifestBytes.toString("utf8"));
  } catch (error) {
    invalid(`Recovery bundle manifest is not valid JSON: ${errorMessage(error)}`);
  }
  const manifest = validateRecoveryManifest(parsed);
  if (!manifestBytes.equals(Buffer.from(serializeManifest(manifest), "utf8"))) {
    invalid("Recovery bundle manifest is not canonically serialized.");
  }

  const objectsPath = path.join(bundlePath, RECOVERY_OBJECTS_PATH);
  const objectsStats = await lstat(objectsPath);
  if (!objectsStats.isDirectory() || objectsStats.isSymbolicLink()) invalid("Recovery bundle objects path must be a real directory.");
  const objectNames = (await readdir(objectsPath)).sort(compareCheckpointPaths);
  const expectedNames = manifest.objects.map(item => item.hash.slice("sha256:".length));
  if (stableStringify(objectNames) !== stableStringify(expectedNames)) {
    corrupt("Recovery bundle object inventory does not match the manifest.", { expected: expectedNames, actual: objectNames });
  }
  const material = new Map<string, Buffer>();
  let bytes = 0;
  for (const object of manifest.objects) {
    const objectPath = path.join(objectsPath, object.hash.slice("sha256:".length));
    const stats = await lstat(objectPath);
    if (!stats.isFile() || stats.isSymbolicLink()) corrupt("Recovery object is not a bounded regular file.", { hash: object.hash });
    let content: Buffer;
    try {
      content = await readBoundedRegularFile(objectPath, MAX_OBJECT_BYTES, "Recovery object");
    } catch (error) {
      if (error instanceof SynodError && error.code === ERROR_CODES.RECOVERY_BUNDLE_INVALID) {
        corrupt("Recovery object could not be read safely.", { hash: object.hash });
      }
      throw error;
    }
    if (content.byteLength !== object.size || hashBytes(content) !== object.hash) {
      corrupt("Recovery object failed size or SHA-256 verification.", { hash: object.hash });
    }
    bytes += content.byteLength;
    material.set(object.hash, content);
  }
  for (const entry of manifest.entries) {
    if (entry.worktree.type === "symlink" && entry.worktree.object) {
      assertSafeSymlink(entry, material.get(entry.worktree.object)!);
    }
  }
  return {
    bundle: bundlePath,
    bundleId: manifest.bundleId,
    manifest,
    entries: manifest.entries.length,
    objects: manifest.objects.length,
    bytes
  };
}

export async function exportRecoveryBundle(
  { directory = ".", destination, includeUntracked = false }: BundleExportOptions,
  dependencies: RecoveryDependencies = {}
): Promise<BundleExportResult> {
  const targetDirectory = path.resolve(directory);
  const destinationPath = path.resolve(destination);
  const relativeDestination = path.relative(targetDirectory, destinationPath);
  if (relativeDestination === "" || (!relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== ".." && !path.isAbsolute(relativeDestination))) {
    invalid("Recovery bundle destination must be outside the source checkout.", { destination: destinationPath });
  }
  await validateDestinationParent(destinationPath);
  await requireMissingDestination(destinationPath);
  const rawGitRunner = dependencies.rawGitRunner || defaultRawGitRunner;
  return await withValidatedCheckpointSource({ directory: targetDirectory }, dependencies, async source => {
    if (!source.state.checkpoint.available || !source.state.checkpoint.head) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "Recovery export requires an acknowledged Git HEAD.", {
        details: { checkpoint: source.state.checkpoint }
      });
    }
    const untracked = source.snapshot.entries.filter(entry => entry.status === "??").map(entry => entry.path);
    if (untracked.length > 0 && !includeUntracked) {
      throw new SynodError(ERROR_CODES.RECOVERY_UNTRACKED_REQUIRED, "The checkpoint contains untracked files; export requires --include-untracked.", {
        details: { paths: untracked }
      });
    }
    let indexOutput: Buffer;
    try {
      indexOutput = await rawGitRunner(source.targetDirectory, ["ls-files", "--stage", "-z", "--", "."]);
    } catch (error) {
      throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "The Git index required for recovery export is unavailable.", {
        cause: error
      });
    }
    const index = indexRecords(indexOutput);
    const objects = new Map<string, Buffer>();
    const entries: RecoveryEntry[] = [];
    for (const snapshotEntry of source.snapshot.entries) {
      if (snapshotEntry.status === "??" && !includeUntracked) continue;
      if (snapshotEntry.type === "directory") {
        throw new SynodError(ERROR_CODES.RECOVERY_SUBMODULE_UNSUPPORTED, "Dirty submodules are not supported by recovery bundle schema 1.", {
          details: { path: snapshotEntry.path }
        });
      }
      const indexEntries: RecoveryIndexEntry[] = [];
      const rawIndexEntries = (index.get(snapshotEntry.path) || []).sort((left, right) => left.stage - right.stage);
      for (const item of rawIndexEntries) {
        let raw: Buffer;
        try {
          raw = await rawGitRunner(source.targetDirectory, ["cat-file", "blob", item.objectId]);
        } catch (error) {
          throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "A Git index object required for recovery export is unavailable.", {
            cause: error,
            details: { path: snapshotEntry.path, objectId: item.objectId }
          });
        }
        const material = recoveryMaterial(snapshotEntry.path, raw);
        if (material) objects.set(hashBytes(material), material);
        indexEntries.push({ mode: item.mode, stage: item.stage, object: material ? hashBytes(material) : null });
      }
      const worktree = await readWorktreeMaterial(source.targetDirectory, snapshotEntry);
      if (worktree.material) objects.set(hashBytes(worktree.material), worktree.material);
      assertEntryMaterialMatchesSnapshot(snapshotEntry, rawIndexEntries, indexEntries, worktree.descriptor);
      entries.push({
        path: snapshotEntry.path,
        ...(snapshotEntry.sourcePath ? { sourcePath: snapshotEntry.sourcePath } : {}),
        status: snapshotEntry.status,
        binary: Boolean(snapshotEntry.binary),
        filtered: isFilteredPath(snapshotEntry.path),
        index: indexEntries,
        worktree: worktree.descriptor
      });
    }
    entries.sort((left, right) => compareCheckpointPaths(
      `${left.path}\0${left.sourcePath || ""}`,
      `${right.path}\0${right.sourcePath || ""}`
    ));
    const objectList = [...objects.entries()]
      .sort(([left], [right]) => compareCheckpointPaths(left, right))
      .map(([hash, content]) => ({ hash, size: content.byteLength }));
    const payload: RecoveryManifestPayload = {
      schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
      synodVersion: packageVersion,
      createdAt: source.snapshot.capturedAt,
      source: { branch: source.state.checkpoint.branch, head: source.state.checkpoint.head },
      checkpoint: {
        fingerprint: source.state.checkpoint.worktree.fingerprint,
        snapshotHash: source.snapshot.contentHash
      },
      event: { sequence: source.state.lastEvent.sequence, hash: source.state.lastEvent.hash },
      includeUntracked,
      entries,
      objects: objectList
    };
    const manifest: RecoveryManifest = { ...payload, bundleId: payloadHash(payload) };
    validateRecoveryManifest(manifest);
    await assertSourceStillMatches(source.targetDirectory, source.state.checkpoint, dependencies);

    const parent = path.dirname(destinationPath);
    const temporary = await mkdtemp(path.join(parent, `.${path.basename(destinationPath)}.synod-`));
    try {
      const objectDirectory = path.join(temporary, RECOVERY_OBJECTS_PATH);
      await mkdir(objectDirectory, { mode: 0o700 });
      for (const [hash, content] of [...objects.entries()].sort(([left], [right]) => compareCheckpointPaths(left, right))) {
        await writeDurableFile(path.join(objectDirectory, hash.slice("sha256:".length)), content);
      }
      await writeDurableFile(path.join(temporary, RECOVERY_MANIFEST_PATH), serializeManifest(manifest));
      await verifyRecoveryBundle({ bundle: temporary });
      await assertSourceStillMatches(source.targetDirectory, source.state.checkpoint, dependencies);
      await requireMissingDestination(destinationPath);
      try {
        await rename(temporary, destinationPath);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error) || "")) {
          throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_EXISTS, "Recovery bundle destination already exists.", {
            details: { destination: destinationPath }
          });
        }
        throw error;
      }
      const verified = await verifyRecoveryBundle({ bundle: destinationPath });
      return { ...verified, destination: destinationPath };
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
}
