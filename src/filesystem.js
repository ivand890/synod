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

export function normalizeText(content) {
  return String(content).replaceAll("\r\n", "\n");
}

export function contentHash(content) {
  return `sha256:${createHash("sha256").update(normalizeText(content), "utf8").digest("hex")}`;
}

export async function pathType(candidate) {
  try {
    const value = await lstat(candidate);
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    if (value.isSymbolicLink()) return "symlink";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function inspectPath(candidate) {
  const type = await pathType(candidate);
  if (type !== "file") return { type };
  const [content, stats] = await Promise.all([readFile(candidate, "utf8"), lstat(candidate)]);
  return { type, content, hash: contentHash(content), mode: stats.mode };
}

export function resolveProjectPath(targetDirectory, relativePath) {
  const targetPath = path.resolve(targetDirectory, ...relativePath.split("/"));
  const relative = path.relative(targetDirectory, targetPath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Managed path escapes the project: ${relativePath}`, {
      details: { path: relativePath }
    });
  }
  return targetPath;
}

export async function unsafeAncestor(targetDirectory, targetPath) {
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

function matchesExpected(actual, expected) {
  if (!expected) return true;
  if (actual.type !== expected.type) return false;
  return expected.hash === undefined || actual.hash === expected.hash;
}

async function writeTemporary(targetPath, content, mode) {
  const temporaryPath = path.join(path.dirname(targetPath), `.synod-tmp-${randomUUID()}`);
  const handle = await open(temporaryPath, "wx", mode ?? 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await chmod(temporaryPath, mode);
  return temporaryPath;
}

async function rollbackJournal(journal, createdDirectories) {
  const failures = [];
  for (const entry of [...journal].reverse()) {
    try {
      const targetType = await pathType(entry.targetPath);
      if (entry.targetMutated && targetType === "file") await unlink(entry.targetPath);
      if (entry.backupPath && await pathType(entry.backupPath) === "file") {
        await rename(entry.backupPath, entry.targetPath);
      }
      if (entry.temporaryPath && await pathType(entry.temporaryPath) === "file") {
        await unlink(entry.temporaryPath);
      }
    } catch (error) {
      failures.push({ path: entry.relativePath, message: error.message });
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
        failures.push({ path: directory, message: error.message });
      }
    }
  }
  return failures;
}

export async function applyTransaction(targetDirectory, operations, { beforeMutationHook, transactionHook } = {}) {
  const journal = [];
  const createdDirectories = new Set();
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
        const missing = [];
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
          { details: { path: operation.path, expected: operation.expected, actual: { type: actual.type, hash: actual.hash } } }
        );
      }

      const entry = {
        relativePath: operation.path,
        targetPath,
        backupPath: undefined,
        temporaryPath: undefined,
        targetMutated: false
      };

      if (operation.action === "write") {
        entry.temporaryPath = await writeTemporary(targetPath, operation.content, actual.mode);
        journal.push(entry);
        await beforeMutationHook?.(operation, index);
        const beforeMutation = await inspectPath(targetPath);
        if (!matchesExpected(beforeMutation, operation.expected)) {
          throw new SynodError(
            ERROR_CODES.DESTINATION_CHANGED,
            `Managed destination changed immediately before mutation: ${operation.path}`,
            { details: { path: operation.path, expected: operation.expected, actual: { type: beforeMutation.type, hash: beforeMutation.hash } } }
          );
        }
        if (actual.type === "file") {
          entry.backupPath = path.join(path.dirname(targetPath), `.synod-backup-${randomUUID()}`);
          await rename(targetPath, entry.backupPath);
          entry.targetMutated = true;
        }
        await rename(entry.temporaryPath, targetPath);
        entry.targetMutated = true;
        entry.temporaryPath = undefined;
      } else if (operation.action === "delete") {
        if (actual.type !== "file") {
          throw new SynodError(ERROR_CODES.DESTINATION_CHANGED, `Cannot delete non-file path: ${operation.path}`);
        }
        journal.push(entry);
        entry.backupPath = path.join(path.dirname(targetPath), `.synod-backup-${randomUUID()}`);
        await rename(targetPath, entry.backupPath);
        entry.targetMutated = true;
      } else {
        throw new TypeError(`Unknown transaction action: ${operation.action}`);
      }

      await transactionHook?.(operation, index);
    }
  } catch (error) {
    const rollbackFailures = await rollbackJournal(journal, createdDirectories);
    if (rollbackFailures.length > 0) {
      throw new SynodError(
        ERROR_CODES.ROLLBACK_FAILED,
        "Synod could not fully roll back a failed filesystem transaction.",
        { cause: error, details: { originalError: error.message, rollbackFailures } }
      );
    }
    throw new SynodError(
      ERROR_CODES.TRANSACTION_FAILED,
      `Synod rolled back a failed filesystem transaction: ${error.message}`,
      { cause: asSynodError(error), details: { originalCode: error.code } }
    );
  }

  for (const entry of journal) {
    if (entry.backupPath && await pathType(entry.backupPath) === "file") await unlink(entry.backupPath);
  }
}

export async function pruneEmptyDirectories(targetDirectory, relativePaths) {
  const directories = new Set();
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
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    }
  }
}
