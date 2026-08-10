import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, SynodError, asSynodError } from "./errors.js";
import { errorCode, errorMessage } from "./validation.js";

export type PathType = "file" | "directory" | "symlink" | "other" | "missing";

type NonFilePathInspection = {
  [Kind in Exclude<PathType, "file">]: { type: Kind }
}[Exclude<PathType, "file">];

export type PathInspection =
  | { type: "file"; content: string; hash: string; mode: number }
  | NonFilePathInspection;

export interface ExpectedPath {
  type: PathType;
  hash?: string;
}

interface OperationBase {
  path: string;
  expected?: ExpectedPath;
}

export interface WriteOperation extends OperationBase {
  action: "write";
  content: string | Uint8Array;
}

export interface DeleteOperation extends OperationBase {
  action: "delete";
}

export type TransactionOperation = WriteOperation | DeleteOperation;

export interface TransactionHooks {
  beforeMutationHook?: (operation: TransactionOperation, index: number) => void | Promise<void>;
  transactionHook?: (operation: TransactionOperation, index: number) => void | Promise<void>;
}

interface JournalEntry {
  relativePath: string;
  targetPath: string;
  backupPath?: string;
  temporaryPath?: string;
  targetMutated: boolean;
  appliedExpected?: ExpectedPath;
}

export interface CleanupFailure {
  path: string;
  message: string;
  expected?: ExpectedPath | undefined;
  actual?: { type: PathType; hash?: string };
}

export function normalizeText(content: unknown): string {
  return String(content).replaceAll("\r\n", "\n");
}

export function contentHash(content: unknown): string {
  return `sha256:${createHash("sha256").update(normalizeText(content), "utf8").digest("hex")}`;
}

export async function pathType(candidate: string): Promise<PathType> {
  try {
    const value = await lstat(candidate);
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    if (value.isSymbolicLink()) return "symlink";
    return "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

export async function inspectPath(candidate: string): Promise<PathInspection> {
  const type = await pathType(candidate);
  if (type !== "file") return { type };
  const [content, stats] = await Promise.all([readFile(candidate, "utf8"), lstat(candidate)]);
  return { type, content, hash: contentHash(content), mode: stats.mode };
}

export function resolveProjectPath(targetDirectory: string, relativePath: string): string {
  const targetPath = path.resolve(targetDirectory, ...relativePath.split("/"));
  const relative = path.relative(targetDirectory, targetPath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Managed path escapes the project: ${relativePath}`, {
      details: { path: relativePath }
    });
  }
  return targetPath;
}

export async function unsafeAncestor(targetDirectory: string, targetPath: string): Promise<string | undefined> {
  const relativePath = path.relative(targetDirectory, targetPath);
  if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Generated path escapes the target directory: ${targetPath}`);
  }

  const segments = relativePath.split(path.sep).filter(Boolean).slice(0, -1);
  let currentPath = targetDirectory;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const type = await pathType(currentPath);
    if (type !== "missing" && type !== "directory") {
      return path.relative(targetDirectory, currentPath).split(path.sep).join("/");
    }
  }
  return undefined;
}

function matchesExpected(actual: PathInspection, expected?: ExpectedPath): boolean {
  if (!expected) return true;
  if (actual.type !== expected.type) return false;
  return expected.hash === undefined || (actual.type === "file" && actual.hash === expected.hash);
}

function inspectionSummary(actual: PathInspection): { type: PathType; hash?: string } {
  return actual.type === "file" ? { type: actual.type, hash: actual.hash } : { type: actual.type };
}

async function writeTemporary(targetPath: string, content: string | Uint8Array, mode?: number): Promise<string> {
  const temporaryPath = path.join(path.dirname(targetPath), `.synod-tmp-${randomUUID()}`);
  const handle = await open(temporaryPath, "wx", mode ?? 0o666);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await chmod(temporaryPath, mode);
  return temporaryPath;
}

async function rollbackJournal(journal: JournalEntry[], createdDirectories: Set<string>): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.targetMutated) {
        const actual = await inspectPath(entry.targetPath);
        const alreadyRemoved = !entry.backupPath
          && entry.appliedExpected?.type === "file"
          && actual.type === "missing";
        if (!alreadyRemoved && !matchesExpected(actual, entry.appliedExpected)) {
          failures.push({
            path: entry.relativePath,
            message: "Destination changed after Synod mutated it; concurrent content was preserved.",
            expected: entry.appliedExpected,
            actual: inspectionSummary(actual)
          });
        } else {
          if (actual.type === "file") await unlink(entry.targetPath);
          if (entry.backupPath && await pathType(entry.backupPath) === "file") {
            await rename(entry.backupPath, entry.targetPath);
          }
        }
      }
      if (entry.temporaryPath && await pathType(entry.temporaryPath) === "file") {
        await unlink(entry.temporaryPath);
      }
    } catch (error) {
      failures.push({ path: entry.relativePath, message: errorMessage(error) });
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") {
        failures.push({ path: directory, message: errorMessage(error) });
      }
    }
  }
  return failures;
}

export async function applyTransaction(
  targetDirectory: string,
  operations: TransactionOperation[],
  { beforeMutationHook, transactionHook }: TransactionHooks = {}
): Promise<{ cleanupFailures: CleanupFailure[] }> {
  const journal: JournalEntry[] = [];
  const createdDirectories = new Set<string>();
  try {
    for (const [index, operation] of operations.entries()) {
      const targetPath = resolveProjectPath(targetDirectory, operation.path);
      const unsafe = await unsafeAncestor(targetDirectory, targetPath);
      if (unsafe) {
        throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to write through unsafe path: ${unsafe}`, {
          details: { path: operation.path, unsafeAncestor: unsafe }
        });
      }

      if (operation.action === "write") {
        const parent = path.dirname(targetPath);
        const missing: string[] = [];
        let current = parent;
        while (current !== targetDirectory && current.startsWith(`${targetDirectory}${path.sep}`)) {
          if (await pathType(current) === "missing") missing.push(current);
          current = path.dirname(current);
        }
        await mkdir(parent, { recursive: true });
        for (const directory of missing.reverse()) createdDirectories.add(directory);
      }
      const unsafeAfterMkdir = await unsafeAncestor(targetDirectory, targetPath);
      if (unsafeAfterMkdir) {
        throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to write through unsafe path: ${unsafeAfterMkdir}`);
      }

      const actual = await inspectPath(targetPath);
      if (!matchesExpected(actual, operation.expected)) {
        throw new SynodError(
          ERROR_CODES.DESTINATION_CHANGED,
          `Managed destination changed while applying the transaction: ${operation.path}`,
          { details: { path: operation.path, expected: operation.expected, actual: inspectionSummary(actual) } }
        );
      }

      const entry: JournalEntry = {
        relativePath: operation.path,
        targetPath,
        targetMutated: false,
      };

      if (operation.action === "write") {
        entry.temporaryPath = await writeTemporary(
          targetPath,
          operation.content,
          actual.type === "file" ? actual.mode : undefined
        );
        journal.push(entry);
        await beforeMutationHook?.(operation, index);
        const beforeMutation = await inspectPath(targetPath);
        if (!matchesExpected(beforeMutation, operation.expected)) {
          throw new SynodError(
            ERROR_CODES.DESTINATION_CHANGED,
            `Managed destination changed immediately before mutation: ${operation.path}`,
            { details: { path: operation.path, expected: operation.expected, actual: inspectionSummary(beforeMutation) } }
          );
        }
        if (beforeMutation.type === "file") {
          if (actual.type === "file" && beforeMutation.mode !== actual.mode) await chmod(entry.temporaryPath, beforeMutation.mode);
          entry.backupPath = path.join(path.dirname(targetPath), `.synod-backup-${randomUUID()}`);
          await rename(targetPath, entry.backupPath);
          entry.targetMutated = true;
          entry.appliedExpected = { type: "missing" };
        }
        await rename(entry.temporaryPath, targetPath);
        entry.targetMutated = true;
        entry.appliedExpected = { type: "file", hash: contentHash(operation.content) };
        delete entry.temporaryPath;
      } else if (operation.action === "delete") {
        if (actual.type !== "file") {
          throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, `Cannot delete non-file path: ${operation.path}`);
        }
        journal.push(entry);
        entry.backupPath = path.join(path.dirname(targetPath), `.synod-backup-${randomUUID()}`);
        await rename(targetPath, entry.backupPath);
        entry.targetMutated = true;
        entry.appliedExpected = { type: "missing" };
      }

      await transactionHook?.(operation, index);
    }
  } catch (error) {
    const rollbackFailures = await rollbackJournal(journal, createdDirectories);
    if (rollbackFailures.length > 0) {
      throw new SynodError(
        ERROR_CODES.ROLLBACK_FAILED,
        "Synod could not fully roll back a failed filesystem transaction.",
        { cause: error, details: { originalError: errorMessage(error), rollbackFailures } }
      );
    }
    throw new SynodError(
      ERROR_CODES.TRANSACTION_FAILED,
      `Synod rolled back a failed filesystem transaction: ${errorMessage(error)}`,
      { cause: asSynodError(error), details: { originalCode: errorCode(error) } }
    );
  }

  const cleanupFailures: CleanupFailure[] = [];
  for (const entry of journal) {
    if (!entry.backupPath) continue;
    try {
      if (await pathType(entry.backupPath) === "file") await unlink(entry.backupPath);
    } catch (error) {
      cleanupFailures.push({ path: entry.relativePath, message: errorMessage(error) });
    }
  }
  return { cleanupFailures };
}

export async function pruneEmptyDirectories(targetDirectory: string, relativePaths: string[]): Promise<void> {
  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    let current = path.dirname(resolveProjectPath(targetDirectory, relativePath));
    while (current !== targetDirectory && current.startsWith(`${targetDirectory}${path.sep}`)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
    }
  }
}
