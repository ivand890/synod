import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseCheckpointArgs, parseLifecycleArgs, parseTaskArgs, parseUsageArgs } from "./command-options.js";
import { compareVersions, parseVersion } from "./compatibility.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import { inspectPath, pathType, resolveProjectPath, unsafeAncestor } from "./filesystem.js";
import { packageManager, packageName, packageVersion } from "./package.js";

export const LOCAL_RUNTIME_SCHEMA_VERSION = 1;
export const LOCAL_RUNTIME_DESCRIPTOR_PATH = ".synod/runtime.json";
export const LOCAL_RUNTIME_DIRECTORY = ".synod/runtime";
export const LOCAL_RUNTIME_EXECUTABLE = `${LOCAL_RUNTIME_DIRECTORY}/node_modules/${packageName}/bin/synod.js`;

const currentPackageRoot = fileURLToPath(new URL("..", import.meta.url));
const lifecycleCommands = new Set(["init", "upgrade", "check", "status", "doctor", "uninstall"]);
const LOCAL_RUNTIME_INSTALL_LOCK_PATH = ".synod/runtime-install.lock";
const LOCAL_RUNTIME_INSTALL_LOCK_TIMEOUT_MS = 130_000;
const LOCAL_RUNTIME_INSTALL_LOCK_RETRY_MS = 25;

function boundedOutput(value) {
  const output = String(value || "").trim();
  return output.length <= 2_000 ? output : `${output.slice(0, 1_997)}...`;
}

function runtimePaths(targetDirectory) {
  return {
    synodDirectory: resolveProjectPath(targetDirectory, ".synod"),
    descriptor: resolveProjectPath(targetDirectory, LOCAL_RUNTIME_DESCRIPTOR_PATH),
    installLock: resolveProjectPath(targetDirectory, LOCAL_RUNTIME_INSTALL_LOCK_PATH),
    runtime: resolveProjectPath(targetDirectory, LOCAL_RUNTIME_DIRECTORY),
    executable: resolveProjectPath(targetDirectory, LOCAL_RUNTIME_EXECUTABLE),
    packageRoot: resolveProjectPath(targetDirectory, `${LOCAL_RUNTIME_DIRECTORY}/node_modules/${packageName}`)
  };
}

function serializeRuntimeDescriptor(runtimeVersion, packageSpec) {
  return `${JSON.stringify({
    schemaVersion: LOCAL_RUNTIME_SCHEMA_VERSION,
    runtimeVersion,
    packageSpec,
    packageName,
    packageManager: "pnpm",
    runtimeDirectory: LOCAL_RUNTIME_DIRECTORY,
    executable: LOCAL_RUNTIME_EXECUTABLE
  }, null, 2)}\n`;
}

function validateRuntimeDescriptor(descriptor) {
  if (
    !descriptor
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || descriptor.schemaVersion !== LOCAL_RUNTIME_SCHEMA_VERSION
    || !parseVersion(descriptor.runtimeVersion)
    || typeof descriptor.packageSpec !== "string"
    || descriptor.packageSpec.length === 0
    || descriptor.packageName !== packageName
    || descriptor.packageManager !== "pnpm"
    || descriptor.runtimeDirectory !== LOCAL_RUNTIME_DIRECTORY
    || descriptor.executable !== LOCAL_RUNTIME_EXECUTABLE
  ) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The Synod local runtime descriptor is invalid.", {
      details: { path: LOCAL_RUNTIME_DESCRIPTOR_PATH }
    });
  }
  return descriptor;
}

export async function readLocalRuntimeDescriptor(targetDirectory, { required = false } = {}) {
  const paths = runtimePaths(targetDirectory);
  const unsafe = await unsafeAncestor(targetDirectory, paths.descriptor);
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to read the local runtime through unsafe path: ${unsafe}.`, {
      details: { path: LOCAL_RUNTIME_DESCRIPTOR_PATH, unsafeAncestor: unsafe }
    });
  }
  const inspected = await inspectPath(paths.descriptor);
  if (inspected.type === "missing") {
    if (!required) return undefined;
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The Synod local runtime descriptor is missing.", {
      details: { path: LOCAL_RUNTIME_DESCRIPTOR_PATH }
    });
  }
  if (inspected.type !== "file") {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The Synod local runtime descriptor is not a regular file.", {
      details: { path: LOCAL_RUNTIME_DESCRIPTOR_PATH, actualType: inspected.type }
    });
  }
  try {
    return validateRuntimeDescriptor(JSON.parse(inspected.content));
  } catch (error) {
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, `Could not parse ${LOCAL_RUNTIME_DESCRIPTOR_PATH}: ${error.message}`, {
      cause: error
    });
  }
}

export async function inspectLocalRuntime(targetDirectory, descriptor) {
  const value = descriptor || await readLocalRuntimeDescriptor(targetDirectory, { required: true });
  const paths = runtimePaths(targetDirectory);
  const unsafe = await unsafeAncestor(targetDirectory, path.join(paths.runtime, "runtime-placeholder"));
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to execute the local runtime through unsafe path: ${unsafe}.`, {
      details: { path: LOCAL_RUNTIME_DIRECTORY, unsafeAncestor: unsafe }
    });
  }
  const runtimeType = await pathType(paths.runtime);
  if (runtimeType === "missing") {
    return { descriptor: value, ready: false, executable: paths.executable, packageRoot: paths.packageRoot };
  }
  if (runtimeType !== "directory") {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The Synod local runtime is not a directory.", {
      details: { path: LOCAL_RUNTIME_DIRECTORY, actualType: runtimeType }
    });
  }
  let resolvedRuntime;
  let resolvedPackageRoot;
  try {
    [resolvedRuntime, resolvedPackageRoot] = await Promise.all([
      realpath(paths.runtime),
      realpath(paths.packageRoot)
    ]);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { descriptor: value, ready: false, executable: paths.executable, packageRoot: paths.packageRoot };
    }
    throw error;
  }
  const relativePackageRoot = path.relative(resolvedRuntime, resolvedPackageRoot);
  if (
    path.isAbsolute(relativePackageRoot)
    || relativePackageRoot === ".."
    || relativePackageRoot.startsWith(`..${path.sep}`)
  ) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, "The pnpm-linked Synod package escapes the local runtime directory.", {
      details: { path: LOCAL_RUNTIME_EXECUTABLE }
    });
  }
  const resolvedExecutable = path.join(resolvedPackageRoot, "bin", "synod.js");
  const [executableType, packageInspection, runtimePackageInspection, gitignoreInspection, lockfileInspection] = await Promise.all([
    pathType(resolvedExecutable),
    inspectPath(path.join(resolvedPackageRoot, "package.json")),
    inspectPath(path.join(paths.runtime, "package.json")),
    inspectPath(path.join(paths.runtime, ".gitignore")),
    inspectPath(path.join(paths.runtime, "pnpm-lock.yaml"))
  ]);
  if (
    executableType !== "file"
    || packageInspection.type !== "file"
    || runtimePackageInspection.type !== "file"
    || gitignoreInspection.type !== "file"
    || lockfileInspection.type !== "file"
  ) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The Synod local runtime installation is incomplete.", {
      details: {
        executableType,
        packageType: packageInspection.type,
        runtimePackageType: runtimePackageInspection.type,
        gitignoreType: gitignoreInspection.type,
        lockfileType: lockfileInspection.type
      }
    });
  }
  let installedPackage;
  let runtimePackage;
  try {
    installedPackage = JSON.parse(packageInspection.content);
    runtimePackage = JSON.parse(runtimePackageInspection.content);
  } catch (error) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The installed Synod package metadata is invalid.", {
      cause: error
    });
  }
  if (
    installedPackage.name !== packageName
    || installedPackage.version !== value.runtimeVersion
    || installedPackage.bin?.synod !== "bin/synod.js"
    || runtimePackage.name !== "synod-project-runtime"
    || runtimePackage.private !== true
    || runtimePackage.dependencies?.[packageName] !== value.packageSpec
    || gitignoreInspection.content !== "node_modules/\n"
  ) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The installed Synod package does not match its local runtime descriptor.", {
      details: {
        expectedPackage: packageName,
        expectedVersion: value.runtimeVersion,
        actualPackage: installedPackage.name,
        actualVersion: installedPackage.version,
        runtimePackageSpec: runtimePackage.dependencies?.[packageName]
      }
    });
  }
  return { descriptor: value, ready: true, executable: paths.executable, packageRoot: paths.packageRoot };
}

async function isCurrentLocalRuntime(localRuntime) {
  if (!localRuntime?.ready) return false;
  try {
    const [current, installed] = await Promise.all([
      realpath(currentPackageRoot),
      realpath(localRuntime.packageRoot)
    ]);
    return current === installed;
  } catch {
    return false;
  }
}

function defaultRunPnpm(directory) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, [
    "install",
    "--ignore-workspace",
    "--ignore-scripts",
    "--prod"
  ], {
    cwd: directory,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED, "pnpm could not install the Synod project runtime.", {
      cause: result.error,
      details: {
        command: "pnpm install",
        status: result.status,
        output: boundedOutput(`${result.stdout || ""}\n${result.stderr || ""}`)
      }
    });
  }
}

async function verifyStagedRuntime(stageDirectory, runtimeVersion) {
  const packageRoot = path.join(stageDirectory, "node_modules", ...packageName.split("/"));
  const executable = path.join(packageRoot, "bin", "synod.js");
  const packageInspection = await inspectPath(path.join(packageRoot, "package.json"));
  if (packageInspection.type !== "file" || await pathType(executable) !== "file") {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED, "pnpm completed without creating a usable Synod executable.");
  }
  const installed = JSON.parse(packageInspection.content);
  if (installed.name !== packageName || installed.version !== runtimeVersion || installed.bin?.synod !== "bin/synod.js") {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED, "pnpm installed a Synod package that does not match the bootstrap version.", {
      details: { expected: runtimeVersion, actual: installed.version }
    });
  }
}

async function commitStagedRuntime(targetDirectory, stageDirectory, descriptorContent, { renamePath = rename } = {}) {
  const paths = runtimePaths(targetDirectory);
  const token = randomUUID();
  const runtimeBackup = path.join(paths.synodDirectory, `.runtime-backup-${token}`);
  const descriptorBackup = path.join(paths.synodDirectory, `.runtime-descriptor-backup-${token}`);
  const descriptorTemporary = path.join(paths.synodDirectory, `.runtime-descriptor-${token}`);
  let runtimeBackedUp = false;
  let descriptorBackedUp = false;
  let runtimeCommitted = false;
  let descriptorCommitted = false;
  await writeFile(descriptorTemporary, descriptorContent, { flag: "wx" });
  try {
    const runtimeType = await pathType(paths.runtime);
    if (!["missing", "directory"].includes(runtimeType)) {
      throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "The local runtime destination is not a directory.", {
        details: { path: LOCAL_RUNTIME_DIRECTORY, actualType: runtimeType }
      });
    }
    if (runtimeType === "directory") {
      await renamePath(paths.runtime, runtimeBackup);
      runtimeBackedUp = true;
    }
    await renamePath(stageDirectory, paths.runtime);
    runtimeCommitted = true;

    const descriptorType = await pathType(paths.descriptor);
    if (!["missing", "file"].includes(descriptorType)) {
      throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "The local runtime descriptor destination is not a file.", {
        details: { path: LOCAL_RUNTIME_DESCRIPTOR_PATH, actualType: descriptorType }
      });
    }
    if (descriptorType === "file") {
      await renamePath(paths.descriptor, descriptorBackup);
      descriptorBackedUp = true;
    }
    await renamePath(descriptorTemporary, paths.descriptor);
    descriptorCommitted = true;
  } catch (error) {
    const rollbackFailures = [];
    const rollback = async (operation, target, action) => {
      try {
        await action();
      } catch (rollbackError) {
        rollbackFailures.push({
          operation,
          target,
          code: rollbackError.code,
          message: rollbackError.message
        });
      }
    };
    if (descriptorCommitted) {
      await rollback("remove-new-descriptor", LOCAL_RUNTIME_DESCRIPTOR_PATH, () => unlink(paths.descriptor));
    }
    if (descriptorBackedUp) {
      await rollback("restore-descriptor", LOCAL_RUNTIME_DESCRIPTOR_PATH, () => renamePath(descriptorBackup, paths.descriptor));
    }
    if (runtimeCommitted) {
      await rollback("remove-new-runtime", LOCAL_RUNTIME_DIRECTORY, () => rm(paths.runtime, { recursive: true, force: true }));
    }
    if (runtimeBackedUp) {
      await rollback("restore-runtime", LOCAL_RUNTIME_DIRECTORY, () => renamePath(runtimeBackup, paths.runtime));
    }
    if (rollbackFailures.length > 0) {
      throw new SynodError(ERROR_CODES.ROLLBACK_FAILED, "Synod could not fully restore the previous project runtime.", {
        cause: error,
        details: {
          originalCode: error.code || ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED,
          rollbackFailures
        }
      });
    }
    throw error instanceof SynodError ? error : new SynodError(
      ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED,
      `Synod could not commit the project runtime: ${error.message}`,
      { cause: error }
    );
  } finally {
    await unlink(descriptorTemporary).catch(() => {});
  }
  if (runtimeBackedUp) await rm(runtimeBackup, { recursive: true, force: true }).catch(() => {});
  if (descriptorBackedUp) await unlink(descriptorBackup).catch(() => {});
}

function liveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function runtimeInstallLockOwner(content) {
  try {
    const value = JSON.parse(content);
    return value
      && Number.isInteger(value.pid)
      && typeof value.token === "string"
      && value.token.length > 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function acquireRuntimeInstallLock(paths, {
  timeoutMs = LOCAL_RUNTIME_INSTALL_LOCK_TIMEOUT_MS,
  retryMs = LOCAL_RUNTIME_INSTALL_LOCK_RETRY_MS,
  now = Date.now
} = {}) {
  const startedAt = now();
  while (true) {
    const token = randomUUID();
    const content = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date(now()).toISOString() })}\n`;
    let handle;
    try {
      handle = await open(paths.installLock, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.close();
      return async () => {
        const current = await inspectPath(paths.installLock);
        if (current.type === "missing") return;
        if (current.type !== "file" || current.content !== content) {
          throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "The Synod runtime install lock changed ownership unexpectedly.", {
            details: { path: LOCAL_RUNTIME_INSTALL_LOCK_PATH }
          });
        }
        await unlink(paths.installLock);
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") {
        if (handle) await unlink(paths.installLock).catch(() => {});
        throw error;
      }
      const existing = await inspectPath(paths.installLock);
      if (existing.type === "missing") continue;
      if (existing.type !== "file") {
        throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "The Synod runtime install lock is not a regular file.", {
          details: { path: LOCAL_RUNTIME_INSTALL_LOCK_PATH, actualType: existing.type }
        });
      }
      const owner = runtimeInstallLockOwner(existing.content);
      if (!owner || !liveProcess(owner.pid)) {
        throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "A stale or invalid Synod runtime install lock requires explicit cleanup.", {
          details: {
            path: LOCAL_RUNTIME_INSTALL_LOCK_PATH,
            stale: true,
            ...(owner ? { pid: owner.pid } : {})
          }
        });
      }
      if (now() - startedAt >= timeoutMs) {
        throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "Another Synod runtime installation holds the project lock.", {
          details: { path: LOCAL_RUNTIME_INSTALL_LOCK_PATH, pid: owner.pid }
        });
      }
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

export async function installLocalRuntime(targetDirectory, {
  runtimeVersion = packageVersion,
  packageSpec = process.env.SYNOD_RUNTIME_PACKAGE_SPEC || runtimeVersion,
  trustedPackageSpec = process.env.SYNOD_RUNTIME_PACKAGE_SPEC,
  runPnpm = defaultRunPnpm,
  renamePath = rename,
  lockOptions
} = {}) {
  if (
    !parseVersion(runtimeVersion)
    || typeof packageSpec !== "string"
    || packageSpec.length === 0
    || (packageSpec !== runtimeVersion && packageSpec !== trustedPackageSpec)
  ) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "The requested Synod local runtime version or package source is invalid.", {
      details: {
        runtimeVersion,
        ...(packageSpec !== runtimeVersion ? {
          packageSpec,
          requiredOptIn: "SYNOD_RUNTIME_PACKAGE_SPEC"
        } : {})
      }
    });
  }
  const targetType = await pathType(targetDirectory);
  if (targetType !== "directory") {
    throw new SynodError(ERROR_CODES.TARGET_NOT_DIRECTORY, "The local runtime target must be an existing project directory.", {
      details: { targetDirectory, actualType: targetType }
    });
  }
  const paths = runtimePaths(targetDirectory);
  const unsafe = await unsafeAncestor(targetDirectory, path.join(paths.synodDirectory, "runtime-placeholder"));
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to install the local runtime through unsafe path: ${unsafe}.`);
  }
  const createdSynodDirectory = await pathType(paths.synodDirectory) === "missing";
  await mkdir(paths.synodDirectory, { recursive: true });
  let releaseLock;
  let stageDirectory;
  try {
    releaseLock = await acquireRuntimeInstallLock(paths, lockOptions);
    const existingDescriptor = await readLocalRuntimeDescriptor(targetDirectory);
    const runtimeType = await pathType(paths.runtime);
    if (!existingDescriptor && runtimeType !== "missing") {
      throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "An unmanaged .synod/runtime directory already exists.", {
        details: { path: LOCAL_RUNTIME_DIRECTORY, actualType: runtimeType }
      });
    }
    if (existingDescriptor && compareVersions(existingDescriptor.runtimeVersion, runtimeVersion) > 0) {
      throw new SynodError(ERROR_CODES.DOWNGRADE_UNSUPPORTED, "Refusing to replace a newer local Synod runtime with an older version.", {
        details: { installed: existingDescriptor.runtimeVersion, requested: runtimeVersion }
      });
    }
    if (existingDescriptor?.runtimeVersion === runtimeVersion) {
      const existing = await inspectLocalRuntime(targetDirectory, existingDescriptor);
      if (existing.ready) return existing;
    }

    stageDirectory = path.join(paths.synodDirectory, `.runtime-stage-${randomUUID()}`);
    await mkdir(stageDirectory, { recursive: false });
    await writeFile(path.join(stageDirectory, "package.json"), `${JSON.stringify({
      name: "synod-project-runtime",
      version: "0.0.0",
      private: true,
      description: "Project-local Synod runtime. Managed by Synod.",
      dependencies: { [packageName]: packageSpec }
    }, null, 2)}\n`, { flag: "wx" });
    await writeFile(path.join(stageDirectory, ".gitignore"), "node_modules/\n", { flag: "wx" });
    await runPnpm(stageDirectory, { packageSpec, runtimeVersion, packageName, packageManager });
    await verifyStagedRuntime(stageDirectory, runtimeVersion);
    await commitStagedRuntime(targetDirectory, stageDirectory, serializeRuntimeDescriptor(runtimeVersion, packageSpec), { renamePath });
    stageDirectory = undefined;
    return inspectLocalRuntime(targetDirectory);
  } catch (error) {
    if (stageDirectory) await rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof SynodError) throw error;
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED, `Could not install the Synod project runtime: ${error.message}`, {
      cause: error
    });
  } finally {
    await releaseLock?.();
    if (createdSynodDirectory) await rmdir(paths.synodDirectory).catch(() => {});
  }
}

function lifecycleOptions(command, args) {
  const lifecycleArgs = args.slice(1);
  if (command === "init" || command === "upgrade") {
    return parseLifecycleArgs(lifecycleArgs, { allowDryRun: true, allowForce: true, allowProfile: true });
  }
  if (command === "uninstall") {
    return parseLifecycleArgs(lifecycleArgs, { allowDryRun: true, allowForce: true });
  }
  return parseLifecycleArgs(lifecycleArgs);
}

function directoryArgument(args, cwd) {
  const command = args[0];
  if (lifecycleCommands.has(command)) {
    return path.resolve(cwd, lifecycleOptions(command, args).directory || ".");
  }
  if (command === "profiles") return path.resolve(cwd);
  if (command === "checkpoint") {
    return path.resolve(cwd, parseCheckpointArgs(args.slice(1)).directory || ".");
  }
  if (command === "task") {
    return path.resolve(cwd, parseTaskArgs(args.slice(1)).directory || ".");
  }
  if (command === "usage") {
    return path.resolve(cwd, parseUsageArgs(args.slice(1), { cwd }).cwd || ".");
  }
  return path.resolve(cwd);
}

function executeLocalRuntime(localRuntime, args, { runtimeAction } = {}) {
  const result = spawnSync(process.execPath, [localRuntime.executable, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      SYNOD_LOCAL_RUNTIME_ACTIVE: localRuntime.descriptor.runtimeVersion,
      ...(runtimeAction ? { SYNOD_LOCAL_RUNTIME_ACTION: runtimeAction } : {})
    }
  });
  if (result.error || result.status === null) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_EXEC_FAILED, "Could not execute the project-local Synod runtime.", {
      cause: result.error,
      details: { signal: result.signal }
    });
  }
  return result.status;
}

export async function prepareLocalRuntime(args, {
  cwd = process.cwd(),
  installer = installLocalRuntime,
  executor = executeLocalRuntime,
  currentRuntime = isCurrentLocalRuntime,
  env = process.env
} = {}) {
  const targetDirectory = directoryArgument(args, cwd);
  if (!targetDirectory) return { action: "current", targetDirectory: undefined, local: false };
  const command = args[0];
  const dryRun = args.includes("--dry-run");
  const helpRequested = args.includes("--help") || args.includes("-h");
  if (helpRequested) return { action: "current", targetDirectory, local: false };
  const descriptor = await readLocalRuntimeDescriptor(targetDirectory);
  let localRuntime = descriptor ? await inspectLocalRuntime(targetDirectory, descriptor) : undefined;
  const activeLocal = Boolean(
    localRuntime?.ready
    && env.SYNOD_LOCAL_RUNTIME_ACTIVE
    && env.SYNOD_LOCAL_RUNTIME_ACTIVE === descriptor.runtimeVersion
  );
  const currentLocal = activeLocal || await currentRuntime(localRuntime);
  if (currentLocal) return {
    action: "current",
    targetDirectory,
    local: true,
    localRuntime,
    runtimePlan: {
      action: env.SYNOD_LOCAL_RUNTIME_ACTION || "unchanged",
      runtimeVersion: descriptor.runtimeVersion,
      packageManager: "pnpm"
    }
  };

  if (command === "upgrade" && dryRun) {
    if (descriptor && compareVersions(descriptor.runtimeVersion, packageVersion) > 0) {
      throw new SynodError(ERROR_CODES.DOWNGRADE_UNSUPPORTED, "Refusing to replace a newer local Synod runtime with an older version.", {
        details: { installed: descriptor.runtimeVersion, requested: packageVersion }
      });
    }
    return {
      action: "current",
      targetDirectory,
      local: false,
      localRuntime,
      runtimePlan: {
        action: descriptor ? (descriptor.runtimeVersion === packageVersion ? "unchanged" : "update") : "install",
        ...(descriptor ? { fromRuntimeVersion: descriptor.runtimeVersion } : {}),
        runtimeVersion: packageVersion,
        packageManager: "pnpm"
      }
    };
  }

  if (dryRun && descriptor && !localRuntime.ready) {
    throw new SynodError(
      ERROR_CODES.LOCAL_RUNTIME_INVALID,
      "Dry-run will not restore a missing project-local Synod runtime cache.",
      { details: { runtimeVersion: descriptor.runtimeVersion, path: LOCAL_RUNTIME_DIRECTORY } }
    );
  }

  if (command === "upgrade" && !dryRun) {
    const runtimeAction = descriptor
      ? (descriptor.runtimeVersion === packageVersion ? "unchanged" : "update")
      : "install";
    localRuntime = await installer(targetDirectory);
    return {
      action: "delegate",
      targetDirectory,
      local: true,
      localRuntime,
      status: executor(localRuntime, args, { runtimeAction })
    };
  }
  if (descriptor) {
    if (!localRuntime.ready) {
      localRuntime = await installer(targetDirectory, {
        runtimeVersion: descriptor.runtimeVersion,
        packageSpec: descriptor.packageSpec
      });
    }
    const runtimeAction = command === "uninstall" ? "remove" : undefined;
    return {
      action: "delegate",
      targetDirectory,
      local: true,
      localRuntime,
      status: executor(localRuntime, args, { runtimeAction })
    };
  }
  if (command === "init" && !dryRun) {
    localRuntime = await installer(targetDirectory);
    return {
      action: "delegate",
      targetDirectory,
      local: true,
      localRuntime,
      status: executor(localRuntime, args, { runtimeAction: "install" })
    };
  }
  if (command === "init" && dryRun) {
    return {
      action: "current",
      targetDirectory,
      local: false,
      runtimePlan: { action: "install", runtimeVersion: packageVersion, packageManager: "pnpm" }
    };
  }
  return { action: "current", targetDirectory, local: false };
}

export async function removeLocalRuntime(targetDirectory) {
  const descriptor = await readLocalRuntimeDescriptor(targetDirectory);
  if (!descriptor) return false;
  const paths = runtimePaths(targetDirectory);
  const unsafe = await unsafeAncestor(targetDirectory, path.join(paths.runtime, "runtime-placeholder"));
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to remove the local runtime through unsafe path: ${unsafe}.`);
  }
  const runtimeType = await pathType(paths.runtime);
  if (!["missing", "directory"].includes(runtimeType)) {
    throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_CONFLICT, "The local runtime destination is not a directory.", {
      details: { actualType: runtimeType }
    });
  }
  if (runtimeType === "directory") {
    const localRuntime = await inspectLocalRuntime(targetDirectory, descriptor);
    if (!localRuntime.ready) {
      throw new SynodError(ERROR_CODES.LOCAL_RUNTIME_INVALID, "Refusing to remove an incomplete local runtime directory.", {
        details: { path: LOCAL_RUNTIME_DIRECTORY }
      });
    }
    await rm(paths.runtime, { recursive: true, force: false });
  }
  await unlink(paths.descriptor);
  return true;
}
