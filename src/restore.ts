import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import path from "node:path";
import {
  compareCheckpointPaths,
  stableCheckpointStringify
} from "./checkpoint.js";
import type { CheckpointEntry, CheckpointIndexEntry } from "./checkpoint.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { pathType, resolveProjectPath, unsafeAncestor } from "./filesystem.js";
import {
  captureGitCheckpointSnapshot,
  withOrchestrationLock
} from "./orchestration.js";
import type { OrchestrationDependencies } from "./orchestration.js";
import type {
  BundleVerification,
  RecoveryEntry,
  RecoveryIndexEntry,
  RecoveryManifest
} from "./recovery.js";
import { verifyRecoveryBundle } from "./recovery.js";
import {
  appendAgentsBlock,
  extractManagedAgentsBlock,
  generatedConfigMarker,
  removeAgentsBlocks
} from "./templates.js";
import { errorCode, errorMessage, isRecord, parseJson } from "./validation.js";

const RESTORE_JOURNAL_SCHEMA_VERSION = 1;
const RESTORE_JOURNAL_NAME = "synod-recovery-journal.json";
const MAX_GIT_OUTPUT = 260 * 1024 * 1024;

type RestorePhase =
  | "before-index-install"
  | "after-index"
  | "before-path-install"
  | "after-path"
  | "before-verify";

export interface RestoreDependencies extends OrchestrationDependencies {
  restoreHook?: (phase: RestorePhase, relativePath?: string) => void | Promise<void>;
}

export interface BundleRestoreOptions {
  bundle: string;
  directory?: string;
}

export interface BundleRestoreResult extends BundleVerification {
  destination: string;
  baseHead: string;
  fingerprint: string;
  recoveredInterruptedRestore: boolean;
}

interface GitRunOptions {
  env?: Record<string, string>;
  input?: Buffer;
}

interface Material {
  type: "file" | "symlink" | "missing";
  mode: number | null;
  content?: Buffer;
}

interface MaterialDescriptor {
  type: Material["type"];
  mode: number | null;
  object: string | null;
}

interface RestorePathPlan {
  path: string;
  desired: Material;
}

interface JournalPath {
  path: string;
  original: MaterialDescriptor;
  desired: MaterialDescriptor;
}

interface RestoreJournal {
  schemaVersion: typeof RESTORE_JOURNAL_SCHEMA_VERSION;
  id: string;
  bundleId: string;
  baseHead: string;
  backupDirectory: string;
  indexMode: number;
  originalIndexHash: string;
  desiredIndexHash: string;
  paths: JournalPath[];
  createdDirectories: string[];
}

interface JournalContext {
  journal: RestoreJournal;
  journalPath: string;
  backupPath: string;
  indexPath: string;
}

interface BaseBlob {
  mode: string;
  content: Buffer;
}

function hashBytes(content: NodeJS.ArrayBufferView): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value: Record<string, unknown>, required: string[]): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.normalize("NFC")
    || value === "."
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || value === ".."
    || value.startsWith("../")
    || path.posix.normalize(value) !== value) return false;
  return value.split("/").every(component => {
    const stem = component.split(".")[0]!.toUpperCase();
    return !/[\u0000-\u001f<>:"|?*]/u.test(component)
      && !/[ .]$/u.test(component)
      && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
  });
}

function descriptor(value: unknown): MaterialDescriptor {
  if (!isRecord(value)
    || !exactKeys(value, ["type", "mode", "object"])
    || !["file", "symlink", "missing"].includes(String(value.type))
    || (value.mode !== null && (!Number.isSafeInteger(value.mode) || typeof value.mode !== "number" || value.mode < 0 || value.mode > 0o777))
    || (value.object !== null && !isHash(value.object))) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal contains an invalid path descriptor.");
  }
  const type = value.type as MaterialDescriptor["type"];
  if ((type === "missing") !== (value.object === null)
    || (type === "file") !== (value.mode !== null)) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal path descriptor is inconsistent.");
  }
  return { type, mode: value.mode as number | null, object: value.object as string | null };
}

function validateJournal(value: unknown): RestoreJournal {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "id", "bundleId", "baseHead", "backupDirectory",
      "indexMode", "originalIndexHash", "desiredIndexHash", "paths", "createdDirectories"
    ])
    || value.schemaVersion !== RESTORE_JOURNAL_SCHEMA_VERSION
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
    || !isHash(value.bundleId)
    || typeof value.baseHead !== "string"
    || !/^[0-9a-f]{40,64}$/.test(value.baseHead)
    || value.backupDirectory !== `synod-recovery-${value.id}`
    || typeof value.indexMode !== "number"
    || !Number.isSafeInteger(value.indexMode)
    || value.indexMode < 0
    || value.indexMode > 0o777
    || !isHash(value.originalIndexHash)
    || !isHash(value.desiredIndexHash)
    || !Array.isArray(value.paths)
    || !Array.isArray(value.createdDirectories)) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal is invalid.");
  }
  const paths = value.paths.map(item => {
    if (!isRecord(item)
      || !exactKeys(item, ["path", "original", "desired"])
      || !isSafeRelativePath(item.path)) {
      throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal contains an unsafe path.");
    }
    return { path: item.path, original: descriptor(item.original), desired: descriptor(item.desired) };
  });
  const sorted = [...paths].sort((left, right) => compareCheckpointPaths(left.path, right.path));
  const createdDirectories = value.createdDirectories as string[];
  const sortedDirectories = [...createdDirectories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareCheckpointPaths(left, right);
  });
  if (new Set(paths.map(item => item.path)).size !== paths.length
    || stableCheckpointStringify(paths) !== stableCheckpointStringify(sorted)
    || createdDirectories.some(item => !isSafeRelativePath(item))
    || new Set(createdDirectories).size !== createdDirectories.length
    || stableCheckpointStringify(createdDirectories) !== stableCheckpointStringify(sortedDirectories)
    || createdDirectories.some(directory => !paths.some(item => item.path.startsWith(`${directory}/`)))) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal path inventory is invalid.");
  }
  return {
    schemaVersion: RESTORE_JOURNAL_SCHEMA_VERSION,
    id: value.id,
    bundleId: value.bundleId,
    baseHead: value.baseHead,
    backupDirectory: value.backupDirectory,
    indexMode: value.indexMode,
    originalIndexHash: value.originalIndexHash,
    desiredIndexHash: value.desiredIndexHash,
    paths,
    createdDirectories
  };
}

async function runGit(directory: string, args: string[], options: GitRunOptions = {}): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", directory, "-c", "core.fsmonitor=false", ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", chunk => {
      const value = Buffer.from(chunk);
      size += value.byteLength;
      if (size > MAX_GIT_OUTPUT) child.kill();
      else stdout.push(value);
    });
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 && size <= MAX_GIT_OUTPUT) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git exited with status ${code}.`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function gitPath(directory: string, name: string): Promise<string> {
  const output = (await runGit(directory, ["rev-parse", "--git-path", name])).toString("utf8").trim();
  return path.isAbsolute(output) ? path.normalize(output) : path.resolve(directory, output);
}

async function regularFileBytes(filePath: string, label: string): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    if (!(await handle.stat()).isFile()) throw new Error(`${label} is not a regular file.`);
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeDurable(filePath: string, content: Buffer | string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBundleObjects(verification: BundleVerification): Promise<Map<string, Buffer>> {
  const objects = new Map<string, Buffer>();
  for (const item of verification.manifest.objects) {
    const objectPath = path.join(verification.bundle, "objects", item.hash.slice("sha256:".length));
    const content = await regularFileBytes(objectPath, "Recovery object");
    if (content.byteLength !== item.size || hashBytes(content) !== item.hash) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_CORRUPT, "A recovery object changed after bundle verification.", {
        details: { hash: item.hash }
      });
    }
    objects.set(item.hash, content);
  }
  return objects;
}

function gitObjectId(content: Buffer, format: string): string {
  if (format !== "sha1" && format !== "sha256") {
    throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, `Unsupported Git object format: ${format}`);
  }
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash(format).update(header).update(content).digest("hex");
}

async function baseBlob(directory: string, head: string, relativePath: string): Promise<BaseBlob> {
  let output: Buffer;
  try {
    output = await runGit(directory, ["ls-tree", "-z", head, "--", relativePath]);
  } catch (error) {
    throw new SynodError(ERROR_CODES.CHECKPOINT_BASE_UNAVAILABLE, "The recovery base tree is unavailable.", { cause: error });
  }
  const record = output.toString("utf8").split("\0").find(Boolean);
  if (!record) {
    throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Filtered recovery material has no base-tree file.", {
      details: { path: relativePath }
    });
  }
  const separator = record.indexOf("\t");
  const [mode, type, objectId] = record.slice(0, separator).split(" ");
  const returnedPath = record.slice(separator + 1);
  if (returnedPath !== relativePath || type !== "blob" || !mode || !objectId || !["100644", "100755", "120000"].includes(mode)) {
    throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Filtered recovery material does not resolve to a supported base blob.", {
      details: { path: relativePath }
    });
  }
  return { mode, content: await runGit(directory, ["cat-file", "blob", objectId]) };
}

function mergeFiltered(relativePath: string, material: Buffer | undefined, base: BaseBlob): Buffer {
  if (!material) return base.content;
  if (relativePath === "AGENTS.md") {
    const user = material.toString("utf8");
    if (!Buffer.from(user, "utf8").equals(material) || removeAgentsBlocks(user) !== user) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Filtered AGENTS.md recovery material is not canonical UTF-8 user content.");
    }
    const managed = extractManagedAgentsBlock(base.content.toString("utf8"));
    if (managed.blocks.length !== 1 || !managed.content) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "The recovery base does not contain one managed AGENTS.md block.");
    }
    return Buffer.from(appendAgentsBlock(user, managed.content), "utf8");
  }
  if (relativePath === ".codex/config.toml") {
    if (material.toString("utf8").startsWith(generatedConfigMarker)) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Generated config material must not be embedded in a recovery object.");
    }
    return material;
  }
  return material;
}

async function fullMaterial(
  directory: string,
  head: string,
  entry: RecoveryEntry,
  objectHash: string | null,
  objects: Map<string, Buffer>
): Promise<{ content: Buffer; base?: BaseBlob }> {
  const object = objectHash ? objects.get(objectHash) : undefined;
  if (objectHash && !object) {
    throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_CORRUPT, "Recovery material is missing after verification.", {
      details: { hash: objectHash }
    });
  }
  if (!entry.filtered) {
    if (!object) throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "A regular recovery entry is missing material.");
    return { content: object };
  }
  const base = await baseBlob(directory, head, entry.path);
  return { content: mergeFiltered(entry.path, object, base), base };
}

function expectedIndex(entry: RecoveryEntry, items: RecoveryIndexEntry[], objectIds: string[]): CheckpointIndexEntry[] | undefined {
  if (items.length === 0) return undefined;
  return items.map((item, index) => entry.filtered
    ? {
        mode: item.mode,
        stage: item.stage,
        ...(item.object ? { type: "file" as const, contentHash: item.object } : { type: "ignored" as const })
      }
    : { mode: item.mode, stage: item.stage, objectId: objectIds[index]! });
}

function expectedCheckpointEntries(
  manifest: RecoveryManifest,
  objectIds: Map<string, string[]>
): CheckpointEntry[] {
  return manifest.entries.map(entry => ({
    status: entry.status,
    path: entry.path,
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
    type: entry.worktree.type,
    ...(entry.worktree.object ? { contentHash: entry.worktree.object } : {}),
    ...(entry.binary ? { binary: true } : {}),
    ...(expectedIndex(entry, entry.index, objectIds.get(entry.path) || [])
      ? { index: expectedIndex(entry, entry.index, objectIds.get(entry.path) || [])! }
      : {})
  })).sort((left, right) => compareCheckpointPaths(`${left.path}\0${left.sourcePath || ""}`, `${right.path}\0${right.sourcePath || ""}`));
}

function fingerprint(entries: CheckpointEntry[]): string {
  return hashBytes(Buffer.from(stableCheckpointStringify(entries), "utf8"));
}

function modeNumber(mode: string): number {
  if (mode === "100755") return 0o755;
  if (mode === "100644") return 0o644;
  if (mode === "120000") return 0o777;
  throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, `Unsupported recovery mode: ${mode}`);
}

async function buildPlans(
  directory: string,
  manifest: RecoveryManifest,
  objects: Map<string, Buffer>,
  objectFormat: string
): Promise<{ paths: RestorePathPlan[]; indexObjectIds: Map<string, string[]>; indexMaterials: Map<string, Buffer> }> {
  const plans = new Map<string, Material>();
  const indexObjectIds = new Map<string, string[]>();
  const indexMaterials = new Map<string, Buffer>();
  const addPlan = (relativePath: string, desired: Material): void => {
    const prior = plans.get(relativePath);
    if (prior && stableCheckpointStringify(materialDescriptor(prior)) !== stableCheckpointStringify(materialDescriptor(desired))) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Recovery paths require conflicting filesystem outcomes.", {
        details: { path: relativePath }
      });
    }
    plans.set(relativePath, desired);
  };

  for (const entry of manifest.entries) {
    const ids: string[] = [];
    for (const item of entry.index) {
      const full = await fullMaterial(directory, manifest.source.head!, entry, item.object, objects);
      const objectId = gitObjectId(full.content, objectFormat);
      ids.push(objectId);
      indexMaterials.set(objectId, full.content);
    }
    indexObjectIds.set(entry.path, ids);

    if (entry.worktree.type === "missing") addPlan(entry.path, { type: "missing", mode: null });
    else if (entry.worktree.type === "ignored") {
      const base = await baseBlob(directory, manifest.source.head!, entry.path);
      addPlan(entry.path, {
        type: base.mode === "120000" ? "symlink" : "file",
        mode: modeNumber(base.mode),
        content: base.content
      });
    } else {
      const full = await fullMaterial(directory, manifest.source.head!, entry, entry.worktree.object, objects);
      addPlan(entry.path, {
        type: entry.worktree.type,
        mode: modeNumber(entry.worktree.mode!),
        content: full.content
      });
    }
    if (entry.sourcePath && entry.status.includes("R")) addPlan(entry.sourcePath, { type: "missing", mode: null });
  }
  return {
    paths: [...plans.entries()].map(([relativePath, desired]) => ({ path: relativePath, desired }))
      .sort((left, right) => compareCheckpointPaths(left.path, right.path)),
    indexObjectIds,
    indexMaterials
  };
}

function materialDescriptor(material: Material): MaterialDescriptor {
  return {
    type: material.type,
    mode: material.type === "file" ? material.mode : null,
    object: material.content ? hashBytes(material.content) : null
  };
}

async function inspectMaterial(directory: string, relativePath: string): Promise<Material> {
  const absolutePath = resolveProjectPath(directory, relativePath);
  const unsafe = await unsafeAncestor(directory, absolutePath);
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path has an unsafe ancestor.", {
      details: { path: relativePath, unsafeAncestor: unsafe }
    });
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { type: "missing", mode: null };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { type: "symlink", mode: stats.mode & 0o777, content: await readlink(absolutePath, { encoding: "buffer" }) };
  }
  if (stats.isFile()) {
    return { type: "file", mode: stats.mode & 0o777, content: await regularFileBytes(absolutePath, "Recovery destination") };
  }
  throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "Recovery cannot replace a directory or special filesystem path.", {
    details: { path: relativePath }
  });
}

function descriptorMatches(material: Material, expected: MaterialDescriptor): boolean {
  return stableCheckpointStringify(materialDescriptor(material)) === stableCheckpointStringify(expected);
}

async function anticipatedDirectories(directory: string, plans: RestorePathPlan[]): Promise<string[]> {
  const missing = new Set<string>();
  for (const plan of plans) {
    if (plan.desired.type === "missing") continue;
    let parent = path.posix.dirname(plan.path);
    while (parent !== ".") {
      const absolute = resolveProjectPath(directory, parent);
      const type = await pathType(absolute);
      if (type === "missing") missing.add(parent);
      else if (type !== "directory") {
        throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path has a non-directory ancestor.", {
          details: { path: plan.path, unsafeAncestor: parent }
        });
      }
      parent = path.posix.dirname(parent);
    }
  }
  return [...missing].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareCheckpointPaths(left, right);
  });
}

async function buildTemporaryIndex(
  directory: string,
  manifest: RecoveryManifest,
  objectIds: Map<string, string[]>,
  indexPath: string,
  objectFormat: string
): Promise<{ path: string; bytes: Buffer }> {
  const temporary = path.join(path.dirname(indexPath), `synod-recovery-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: temporary };
  await runGit(directory, ["read-tree", manifest.source.head!], { env });
  const zero = "0".repeat(objectFormat === "sha256" ? 64 : 40);
  const records: string[] = [];
  for (const entry of manifest.entries) {
    records.push(`0 ${zero}\t${entry.path}\0`);
    if (entry.sourcePath && entry.status[0] === "R") records.push(`0 ${zero}\t${entry.sourcePath}\0`);
    const ids = objectIds.get(entry.path) || [];
    for (const [position, item] of entry.index.entries()) {
      records.push(item.stage === 0
        ? `${item.mode} ${ids[position]}\t${entry.path}\0`
        : `${item.mode} ${ids[position]} ${item.stage}\t${entry.path}\0`);
    }
  }
  try {
    await runGit(directory, ["update-index", "--info-only", "-z", "--index-info"], {
      env,
      input: Buffer.from(records.join(""), "utf8")
    });
    return { path: temporary, bytes: await regularFileBytes(temporary, "Temporary recovery index") };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `${label} must be a real directory.`);
  }
}

async function journalLocations(directory: string): Promise<{ journalPath: string; indexPath: string }> {
  const [journalPath, indexPath] = await Promise.all([
    gitPath(directory, RESTORE_JOURNAL_NAME),
    gitPath(directory, "index")
  ]);
  await ensureRealDirectory(path.dirname(journalPath), "Recovery Git directory");
  if (path.dirname(indexPath) !== path.dirname(journalPath)) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "Recovery journal and index must share a private Git directory.");
  }
  return { journalPath, indexPath };
}

async function createJournal(
  directory: string,
  manifest: RecoveryManifest,
  plans: RestorePathPlan[],
  desiredIndex: Buffer,
  locations: { journalPath: string; indexPath: string }
): Promise<JournalContext> {
  if (await pathType(locations.journalPath) !== "missing") {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "An interrupted recovery journal already exists.");
  }
  const id = randomUUID();
  const backupDirectory = `synod-recovery-${id}`;
  const backupPath = path.join(path.dirname(locations.journalPath), backupDirectory);
  await mkdir(backupPath, { mode: 0o700 });
  await mkdir(path.join(backupPath, "objects"), { mode: 0o700 });
  const originalIndex = await regularFileBytes(locations.indexPath, "Git index");
  const indexStats = await lstat(locations.indexPath);
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) {
    throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "The Git index must be a real regular file.");
  }
  await writeDurable(path.join(backupPath, "index"), originalIndex);
  const journalPaths: JournalPath[] = [];
  const written = new Set<string>();
  for (const plan of plans) {
    const original = await inspectMaterial(directory, plan.path);
    const originalDescriptor = materialDescriptor(original);
    if (original.content && originalDescriptor.object && !written.has(originalDescriptor.object)) {
      await writeDurable(path.join(backupPath, "objects", originalDescriptor.object.slice("sha256:".length)), original.content);
      written.add(originalDescriptor.object);
    }
    journalPaths.push({ path: plan.path, original: originalDescriptor, desired: materialDescriptor(plan.desired) });
  }
  const journal: RestoreJournal = {
    schemaVersion: RESTORE_JOURNAL_SCHEMA_VERSION,
    id,
    bundleId: manifest.bundleId,
    baseHead: manifest.source.head!,
    backupDirectory,
    indexMode: indexStats.mode & 0o777,
    originalIndexHash: hashBytes(originalIndex),
    desiredIndexHash: hashBytes(desiredIndex),
    paths: journalPaths,
    createdDirectories: await anticipatedDirectories(directory, plans)
  };
  const temporary = path.join(path.dirname(locations.journalPath), `.${RESTORE_JOURNAL_NAME}.${id}`);
  try {
    await writeDurable(temporary, serialize(journal));
    await link(temporary, locations.journalPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { journal, journalPath: locations.journalPath, backupPath, indexPath: locations.indexPath };
}

async function atomicFile(
  filePath: string,
  content: Buffer,
  mode: number,
  beforeInstall?: (() => void | Promise<void>) | undefined
): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.synod-restore-${randomUUID()}`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  try {
    await beforeInstall?.();
    // rename-over-existing is atomic for supported local filesystems: a kill
    // leaves either the journaled original or the complete replacement.
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function ensureSafeParent(directory: string, absolutePath: string): Promise<void> {
  const relativeParent = path.relative(directory, path.dirname(absolutePath));
  let current = directory;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path has a non-directory ancestor.", {
        details: { unsafeAncestor: path.relative(directory, current).split(path.sep).join("/") }
      });
    }
  }
  const canonicalParent = await realpath(path.dirname(absolutePath));
  const relativeCanonical = path.relative(directory, canonicalParent);
  if (path.isAbsolute(relativeCanonical) || relativeCanonical === ".." || relativeCanonical.startsWith(`..${path.sep}`)) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path parent escapes the destination checkout.");
  }
}

async function mutatePath(
  directory: string,
  relativePath: string,
  material: Material,
  beforeInstall?: (() => void | Promise<void>) | undefined
): Promise<void> {
  const absolute = resolveProjectPath(directory, relativePath);
  const unsafe = await unsafeAncestor(directory, absolute);
  if (unsafe) throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path acquired an unsafe ancestor.", { details: { path: relativePath, unsafeAncestor: unsafe } });
  if (material.type !== "missing") {
    await ensureSafeParent(directory, absolute);
    const unsafeAfterCreate = await unsafeAncestor(directory, absolute);
    if (unsafeAfterCreate) {
      throw new SynodError(ERROR_CODES.UNSAFE_PATH, "Recovery path acquired an unsafe ancestor.", {
        details: { path: relativePath, unsafeAncestor: unsafeAfterCreate }
      });
    }
  }
  const current = await pathType(absolute);
  if (current === "directory" || current === "other") {
    throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "Recovery leaf changed to an unsupported path type.", { details: { path: relativePath } });
  }
  if (material.type === "missing") {
    await beforeInstall?.();
    if (current !== "missing") await unlink(absolute);
    return;
  }
  if (!material.content) throw new TypeError("Recovery material is incomplete.");
  if (material.type === "file") {
    if (material.mode === null) throw new TypeError("Recovery file mode is incomplete.");
    await atomicFile(absolute, material.content, material.mode, beforeInstall);
    return;
  }
  const temporary = path.join(path.dirname(absolute), `.synod-restore-link-${randomUUID()}`);
  await symlink(material.content.toString("utf8"), temporary);
  try {
    await beforeInstall?.();
    await rename(temporary, absolute);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function materialFromDescriptor(backupPath: string, value: MaterialDescriptor): Promise<Material> {
  if (value.type === "missing") return { type: "missing", mode: null };
  const content = await regularFileBytes(path.join(backupPath, "objects", value.object!.slice("sha256:".length)), "Recovery backup object");
  if (hashBytes(content) !== value.object) {
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "An interrupted recovery backup object is corrupt.", {
      details: { hash: value.object }
    });
  }
  return { type: value.type, mode: value.mode, content };
}

async function rollbackJournal(directory: string, context: JournalContext): Promise<void> {
  const index = await regularFileBytes(context.indexPath, "Git index");
  const currentIndexHash = hashBytes(index);
  if (currentIndexHash !== context.journal.originalIndexHash && currentIndexHash !== context.journal.desiredIndexHash) {
    throw new SynodError(ERROR_CODES.RECOVERY_ROLLBACK_FAILED, "The Git index changed outside Synod; interrupted recovery was preserved.");
  }
  const states = new Map<string, "original" | "desired">();
  for (const entry of context.journal.paths) {
    const current = await inspectMaterial(directory, entry.path);
    if (descriptorMatches(current, entry.original)) states.set(entry.path, "original");
    else if (descriptorMatches(current, entry.desired)) states.set(entry.path, "desired");
    else {
      throw new SynodError(ERROR_CODES.RECOVERY_ROLLBACK_FAILED, "A recovery path changed outside Synod; interrupted recovery was preserved.", {
        details: { path: entry.path }
      });
    }
  }
  for (const entry of [...context.journal.paths].reverse()) {
    if (states.get(entry.path) === "original") continue;
    const current = await inspectMaterial(directory, entry.path);
    if (!descriptorMatches(current, entry.desired)) {
      throw new SynodError(ERROR_CODES.RECOVERY_ROLLBACK_FAILED, "A recovery path raced rollback; interrupted recovery was preserved.", {
        details: { path: entry.path }
      });
    }
    await mutatePath(directory, entry.path, await materialFromDescriptor(context.backupPath, entry.original));
  }
  const indexAfterPaths = await regularFileBytes(context.indexPath, "Git index");
  if (hashBytes(indexAfterPaths) === context.journal.desiredIndexHash) {
    const originalIndex = await regularFileBytes(path.join(context.backupPath, "index"), "Recovery index backup");
    if (hashBytes(originalIndex) !== context.journal.originalIndexHash) {
      throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery index backup is corrupt.");
    }
    await atomicFile(context.indexPath, originalIndex, context.journal.indexMode);
  }
  for (const relativePath of [...context.journal.createdDirectories].reverse()) {
    await rmdir(resolveProjectPath(directory, relativePath)).catch(error => {
      if (!["ENOENT", "ENOTEMPTY"].includes(errorCode(error) || "")) throw error;
    });
  }
  await unlink(context.journalPath);
  await rm(context.backupPath, { recursive: true, force: true }).catch(() => {});
}

async function readJournal(directory: string, locations: { journalPath: string; indexPath: string }): Promise<JournalContext | undefined> {
  const type = await pathType(locations.journalPath);
  if (type === "missing") return undefined;
  if (type !== "file") throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, "The interrupted recovery journal is not a regular file.");
  let journal: RestoreJournal;
  try {
    journal = validateJournal(parseJson((await regularFileBytes(locations.journalPath, "Recovery journal")).toString("utf8")));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.RECOVERY_JOURNAL_INVALID, `The interrupted recovery journal could not be parsed: ${errorMessage(error)}`);
  }
  const backupPath = path.join(path.dirname(locations.journalPath), journal.backupDirectory);
  await ensureRealDirectory(backupPath, "Recovery backup directory");
  return { journal, journalPath: locations.journalPath, backupPath, indexPath: locations.indexPath };
}

async function maybeWithOrchestrationLock<Result>(directory: string, action: () => Promise<Result>): Promise<Result> {
  const synodPath = resolveProjectPath(directory, ".synod");
  const type = await pathType(synodPath);
  if (type === "missing") return await action();
  if (type !== "directory") throw new SynodError(ERROR_CODES.UNSAFE_PATH, "The destination .synod path is unsafe.");
  return await withOrchestrationLock(directory, action);
}

async function assertCleanBase(directory: string, head: string, dependencies: OrchestrationDependencies): Promise<void> {
  const captured = await captureGitCheckpointSnapshot(directory, dependencies);
  if (!captured.checkpoint.available || captured.checkpoint.head !== head) {
    throw new SynodError(ERROR_CODES.RECOVERY_BASE_MISMATCH, "Recovery destination HEAD does not match the bundle base.", {
      details: { expected: head, actual: captured.checkpoint.head }
    });
  }
  if (!captured.checkpoint.worktree.clean) {
    throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "Recovery requires an otherwise clean destination checkout.", {
      details: { fingerprint: captured.checkpoint.worktree.fingerprint, paths: captured.snapshot.entries.map(entry => entry.path) }
    });
  }
}

async function writeGitObjects(directory: string, materials: Map<string, Buffer>, format: string): Promise<void> {
  for (const [expected, content] of materials) {
    const actual = (await runGit(directory, ["hash-object", "-w", "--stdin"], { input: content })).toString("utf8").trim();
    if (actual !== expected || gitObjectId(content, format) !== expected) {
      throw new SynodError(ERROR_CODES.RECOVERY_RESTORE_FAILED, "Git wrote an unexpected recovery object ID.", {
        details: { expected, actual }
      });
    }
  }
}

export async function restoreRecoveryBundle(
  { bundle, directory = "." }: BundleRestoreOptions,
  dependencies: RestoreDependencies = {}
): Promise<BundleRestoreResult> {
  const verification = await verifyRecoveryBundle({ bundle });
  const manifest = verification.manifest;
  if (!manifest.source.head) {
    throw new SynodError(ERROR_CODES.RECOVERY_BASE_MISMATCH, "Recovery bundles without a Git base cannot be restored.");
  }
  const targetDirectory = await realpath(path.resolve(directory));
  return await maybeWithOrchestrationLock(targetDirectory, async () => {
    const locations = await journalLocations(targetDirectory);
    const interrupted = await readJournal(targetDirectory, locations);
    let recoveredInterruptedRestore = false;
    if (interrupted) {
      await rollbackJournal(targetDirectory, interrupted);
      recoveredInterruptedRestore = true;
    }
    await assertCleanBase(targetDirectory, manifest.source.head!, dependencies);
    const objectFormat = (await runGit(targetDirectory, ["rev-parse", "--show-object-format"])).toString("utf8").trim();
    const objects = await readBundleObjects(verification);
    const plans = await buildPlans(targetDirectory, manifest, objects, objectFormat);
    const expectedEntries = expectedCheckpointEntries(manifest, plans.indexObjectIds);
    const expectedFingerprint = fingerprint(expectedEntries);
    if (expectedFingerprint !== manifest.checkpoint.fingerprint) {
      throw new SynodError(ERROR_CODES.RECOVERY_BUNDLE_INVALID, "Recovery manifest cannot reproduce its declared checkpoint fingerprint.", {
        details: { expected: manifest.checkpoint.fingerprint, actual: expectedFingerprint }
      });
    }
    const temporaryIndex = await buildTemporaryIndex(
      targetDirectory,
      manifest,
      plans.indexObjectIds,
      locations.indexPath,
      objectFormat
    );
    let context: JournalContext | undefined;
    try {
      context = await createJournal(targetDirectory, manifest, plans.paths, temporaryIndex.bytes, locations);
      await assertCleanBase(targetDirectory, manifest.source.head!, dependencies);
      const liveIndex = await regularFileBytes(locations.indexPath, "Git index");
      if (hashBytes(liveIndex) !== context.journal.originalIndexHash) {
        throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "The destination index changed before recovery mutation.");
      }
      await writeGitObjects(targetDirectory, plans.indexMaterials, objectFormat);
      await atomicFile(
        locations.indexPath,
        temporaryIndex.bytes,
        context.journal.indexMode,
        () => dependencies.restoreHook?.("before-index-install")
      );
      await dependencies.restoreHook?.("after-index");
      for (const plan of plans.paths) {
        const journalPath = context.journal.paths.find(item => item.path === plan.path)!;
        const current = await inspectMaterial(targetDirectory, plan.path);
        if (!descriptorMatches(current, journalPath.original)) {
          throw new SynodError(ERROR_CODES.RECOVERY_DESTINATION_DIRTY, "A destination path changed before recovery mutation.", {
            details: { path: plan.path }
          });
        }
        await mutatePath(
          targetDirectory,
          plan.path,
          plan.desired,
          () => dependencies.restoreHook?.("before-path-install", plan.path)
        );
        await dependencies.restoreHook?.("after-path", plan.path);
      }
      await dependencies.restoreHook?.("before-verify");
      const restored = await captureGitCheckpointSnapshot(targetDirectory, dependencies);
      if (restored.checkpoint.head !== manifest.source.head
        || restored.checkpoint.worktree.fingerprint !== manifest.checkpoint.fingerprint
        || stableCheckpointStringify(restored.snapshot.entries) !== stableCheckpointStringify(expectedEntries)) {
        throw new SynodError(ERROR_CODES.RECOVERY_RESTORE_FAILED, "Restored checkout did not reproduce the bundled checkpoint exactly.", {
          details: {
            expectedHead: manifest.source.head,
            actualHead: restored.checkpoint.head,
            expectedFingerprint: manifest.checkpoint.fingerprint,
            actualFingerprint: restored.checkpoint.worktree.fingerprint
          }
        });
      }
      const committed = context;
      await unlink(committed.journalPath);
      context = undefined;
      await rm(committed.backupPath, { recursive: true, force: true }).catch(() => {});
      return {
        ...verification,
        destination: targetDirectory,
        baseHead: manifest.source.head!,
        fingerprint: manifest.checkpoint.fingerprint,
        recoveredInterruptedRestore
      };
    } catch (error) {
      if (context) {
        try {
          await rollbackJournal(targetDirectory, context);
        } catch (rollbackError) {
          if (rollbackError instanceof SynodError && rollbackError.code === ERROR_CODES.RECOVERY_ROLLBACK_FAILED) throw rollbackError;
          throw new SynodError(ERROR_CODES.RECOVERY_ROLLBACK_FAILED, "Synod could not fully roll back the failed recovery restore.", {
            cause: rollbackError,
            details: { originalError: errorMessage(error), rollbackError: errorMessage(rollbackError) }
          });
        }
      }
      if (error instanceof SynodError && [
        ERROR_CODES.RECOVERY_BASE_MISMATCH,
        ERROR_CODES.RECOVERY_DESTINATION_DIRTY,
        ERROR_CODES.RECOVERY_BUNDLE_INVALID,
        ERROR_CODES.RECOVERY_BUNDLE_CORRUPT
      ].includes(error.code as never)) throw error;
      throw new SynodError(ERROR_CODES.RECOVERY_RESTORE_FAILED, `Synod rolled back a failed recovery restore: ${errorMessage(error)}`, {
        cause: error
      });
    } finally {
      await unlink(temporaryIndex.path).catch(() => {});
    }
  });
}
