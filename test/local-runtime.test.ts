import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ERROR_CODES, SynodError, asSynodError } from "../src/errors.js";
import { checkProject, initProject } from "../src/lifecycle.js";
import {
  LOCAL_RUNTIME_DESCRIPTOR_PATH,
  LOCAL_RUNTIME_DIRECTORY,
  inspectLocalRuntime,
  installLocalRuntime,
  prepareLocalRuntime,
  readLocalRuntimeDescriptor,
  removeLocalRuntime
} from "../src/local-runtime.js";
import type { InstallLocalRuntimeOptions, LocalRuntimeInspection } from "../src/local-runtime.js";
import { packageManager, packageName, packageVersion } from "../src/package.js";
import { isRecord } from "../src/validation.js";

const temporaryDirectories = new Set<string>();

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-local-runtime-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

async function fakePnpmInstall(
  directory: string,
  { runtimeVersion = packageVersion }: { runtimeVersion?: string } = {}
): Promise<void> {
  const packageRoot = path.join(directory, "node_modules", ...packageName.split("/"));
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: packageName,
    version: runtimeVersion,
    bin: { synod: "bin/synod.js" }
  })}\n`);
  await writeFile(path.join(packageRoot, "bin/synod.js"), "#!/usr/bin/env node\n");
  await writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
}

async function writePinnedRuntime(directory: string, version: string, packageSpec = version): Promise<void> {
  const runtimeDirectory = path.join(directory, LOCAL_RUNTIME_DIRECTORY);
  const packageRoot = path.join(runtimeDirectory, "node_modules", ...packageName.split("/"));
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(runtimeDirectory, "package.json"), `${JSON.stringify({
    name: "synod-project-runtime",
    version: "0.0.0",
    private: true,
    dependencies: { [packageName]: packageSpec }
  })}\n`);
  await writeFile(path.join(runtimeDirectory, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(runtimeDirectory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: packageName,
    version,
    bin: { synod: "bin/synod.js" }
  })}\n`);
  await writeFile(path.join(packageRoot, "bin/synod.js"), "#!/usr/bin/env node\n");
  await writeFile(path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH), `${JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: version,
    packageSpec,
    packageName,
    packageManager: "pnpm",
    runtimeDirectory: ".synod/runtime",
    executable: `.synod/runtime/node_modules/${packageName}/bin/synod.js`
  })}\n`);
}

function fakeRuntimeInspection(targetDirectory: string): LocalRuntimeInspection {
  return {
    ready: true,
    executable: "/local/synod.js",
    packageRoot: "/local/package",
    descriptor: {
      schemaVersion: 1,
      runtimeVersion: packageVersion,
      packageSpec: packageVersion,
      packageName,
      packageManager: "pnpm",
      runtimeDirectory: LOCAL_RUNTIME_DIRECTORY,
      executable: `${LOCAL_RUNTIME_DIRECTORY}/node_modules/${packageName}/bin/synod.js`
    }
  };
}

test("installs an exact project-local runtime and deterministic descriptor", async () => {
  const directory = await temporaryProject();
  let installs = 0;
  const first = await installLocalRuntime(directory, {
    async runPnpm(stageDirectory) {
      installs += 1;
      await fakePnpmInstall(stageDirectory);
    }
  });
  const second = await installLocalRuntime(directory, {
    async runPnpm() { installs += 1; }
  });

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(installs, 1);
  assert.deepEqual(await readLocalRuntimeDescriptor(directory), {
    schemaVersion: 1,
    runtimeVersion: packageVersion,
    packageSpec: packageVersion,
    packageName,
    packageManager: "pnpm",
    runtimeDirectory: ".synod/runtime",
    executable: `.synod/runtime/node_modules/${packageName}/bin/synod.js`
  });
  const runtimePackage = JSON.parse(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "package.json"), "utf8"));
  assert.equal(runtimePackage.dependencies[packageName], packageVersion);
  assert.equal(runtimePackage.packageManager, packageManager);
  assert.equal(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, ".gitignore"), "utf8"), "node_modules/\n");
  assert.match(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "pnpm-lock.yaml"), "utf8"), /lockfileVersion/);
});

test("refuses to adopt an unmanaged runtime directory", async () => {
  const directory = await temporaryProject();
  await mkdir(path.join(directory, LOCAL_RUNTIME_DIRECTORY), { recursive: true });
  await writeFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "owned.txt"), "user\n");

  await assert.rejects(
    installLocalRuntime(directory, { runPnpm: fakePnpmInstall }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_CONFLICT
  );
  assert.equal(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "owned.txt"), "utf8"), "user\n");
});

test("init bootstraps and delegates while dry-run remains non-mutating", async () => {
  const directory = await temporaryProject();
  let installed = 0;
  let delegated = 0;
  const preview = await prepareLocalRuntime(["init", directory, "--dry-run"], {
    cwd: directory,
    installer: async () => { installed += 1; throw new Error("Dry-run invoked its installer."); },
    executor: () => { delegated += 1; throw new Error("Dry-run invoked its executor."); },
    currentRuntime: async () => false
  });
  const applied = await prepareLocalRuntime(["init", directory], {
    cwd: directory,
    installer: async targetDirectory => {
      installed += 1;
      return fakeRuntimeInspection(targetDirectory);
    },
    executor(localRuntime, args, execution) {
      delegated += 1;
      assert.equal(localRuntime.executable, "/local/synod.js");
      assert.deepEqual(args, ["init", directory]);
      assert.equal(execution?.runtimeAction, "install");
      return 0;
    },
    currentRuntime: async () => false
  });

  assert.equal(preview.action, "current");
  assert.equal(applied.action, "delegate");
  assert.equal(installed, 1);
  assert.equal(delegated, 1);
});

test("a global command delegates to the pinned local version", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  let delegated;

  const result = await prepareLocalRuntime(["check", directory, "--json"], {
    cwd: directory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args };
      return 7;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.status, 7);
  assert.deepEqual(delegated, { version: packageVersion, args: ["check", directory, "--json"] });
});

test("status explain selects and delegates to the pinned project runtime", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;

  const result = await prepareLocalRuntime(["status", projectDirectory, "--explain", "--json"], {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, {
    version: packageVersion,
    args: ["status", projectDirectory, "--explain", "--json"]
  });
});

test("handoff selects and delegates to the pinned project runtime", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  const bundle = path.join(callerDirectory, "handoff.bundle");
  let delegated;

  const result = await prepareLocalRuntime(["handoff", projectDirectory, "--bundle", bundle, "--json"], {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, {
    version: packageVersion,
    args: ["handoff", projectDirectory, "--bundle", bundle, "--json"]
  });
});

test("project-scoped commands without directory arguments still delegate locally", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  let delegated;

  const result = await prepareLocalRuntime(["profiles", "--json"], {
    cwd: directory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.deepEqual(delegated, { version: packageVersion, args: ["profiles", "--json"] });
});

test("lease commands select the pinned runtime from their explicit project", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;

  const args = [
    "lease", "acquire", "T-001",
    "--owner-thread", "thread:runtime",
    "--write", "src/task.ts",
    "--cwd", projectDirectory,
    "--json"
  ];
  const result = await prepareLocalRuntime(args, {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, delegatedArgs) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args: delegatedArgs };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, { version: packageVersion, args });
});

test("budget commands select the pinned runtime from their explicit project", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;
  const args = ["budget", "report", "T-001", "--cwd", projectDirectory, "--json"];

  const result = await prepareLocalRuntime(args, {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, delegatedArgs) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args: delegatedArgs };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, { version: packageVersion, args });
});

test("rotation commands select the pinned runtime from their explicit project", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;
  const args = ["rotation", "report", "--cwd", projectDirectory, "--json"];

  const result = await prepareLocalRuntime(args, {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, delegatedArgs) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args: delegatedArgs };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, { version: packageVersion, args });
});

test("worktree commands select the pinned runtime from their control project", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;
  const args = ["worktree", "status", "T-001", "--cwd", projectDirectory, "--json"];

  const result = await prepareLocalRuntime(args, {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, delegatedArgs) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args: delegatedArgs };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, { version: packageVersion, args });
});

test("wait selects the pinned runtime from its explicit project", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;
  const args = ["wait", "--thread", "thread:runtime", "--cwd", projectDirectory, "--json"];

  const result = await prepareLocalRuntime(args, {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, delegatedArgs) {
      delegated = { version: localRuntime.descriptor.runtimeVersion, args: delegatedArgs };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, { version: packageVersion, args });
});

test("a positional checkpoint directory selects that project's pinned runtime", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  let delegated;

  const result = await prepareLocalRuntime([
    "checkpoint",
    projectDirectory,
    "--message", "Accept reviewed state"
  ], {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { targetDirectory: projectDirectory, version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, {
    targetDirectory: projectDirectory,
    version: packageVersion,
    args: ["checkpoint", projectDirectory, "--message", "Accept reviewed state"]
  });
});

test("bundle export selects the source project's pinned runtime", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  const destination = path.join(callerDirectory, "recovery.bundle");
  let delegated;

  const result = await prepareLocalRuntime([
    "bundle", "export", destination, "--cwd", projectDirectory, "--include-untracked", "--json"
  ], {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { targetDirectory: projectDirectory, version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, {
    targetDirectory: projectDirectory,
    version: packageVersion,
    args: ["bundle", "export", destination, "--cwd", projectDirectory, "--include-untracked", "--json"]
  });
});

test("bundle restore selects the destination project's pinned runtime", async () => {
  const callerDirectory = await temporaryProject();
  const projectDirectory = await temporaryProject();
  await installLocalRuntime(projectDirectory, { runPnpm: fakePnpmInstall });
  const bundle = path.join(callerDirectory, "recovery.bundle");
  let delegated;

  const result = await prepareLocalRuntime([
    "bundle", "restore", bundle, "--cwd", projectDirectory, "--json"
  ], {
    cwd: callerDirectory,
    currentRuntime: async () => false,
    executor(localRuntime, args) {
      delegated = { targetDirectory: projectDirectory, version: localRuntime.descriptor.runtimeVersion, args };
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.targetDirectory, projectDirectory);
  assert.deepEqual(delegated, {
    targetDirectory: projectDirectory,
    version: packageVersion,
    args: ["bundle", "restore", bundle, "--cwd", projectDirectory, "--json"]
  });
});

test("repairs a missing cache at its pinned version before delegation", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");
  await rm(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules"), { recursive: true });
  let installs = 0;
  let delegatedVersion;

  const result = await prepareLocalRuntime(["check", directory], {
    cwd: directory,
    currentRuntime: async () => false,
    installer: (targetDirectory, options) => installLocalRuntime(targetDirectory, {
      ...options,
      async runPnpm(stageDirectory, context) {
        installs += 1;
        await fakePnpmInstall(stageDirectory, context);
      }
    }),
    executor(localRuntime) {
      delegatedVersion = localRuntime.descriptor.runtimeVersion;
      return 0;
    }
  });

  assert.equal(result.action, "delegate");
  assert.equal(installs, 1);
  assert.equal(delegatedVersion, "0.4.0");
  assert.equal((await inspectLocalRuntime(directory)).ready, true);
});

test("reads a persisted non-version source but requires matching opt-in before repair", async () => {
  const directory = await temporaryProject();
  const packageSpec = path.join(directory, "synod-package.tgz");
  await writePinnedRuntime(directory, packageVersion, packageSpec);
  await rm(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules"), { recursive: true });
  let repairOptions;

  await assert.rejects(
    prepareLocalRuntime(["check", directory], {
      cwd: directory,
      env: {},
      currentRuntime: async () => false,
      installer: (targetDirectory, options) => installLocalRuntime(targetDirectory, {
        ...options,
        runPnpm: fakePnpmInstall
      }),
      executor: () => 0
    }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
      && isRecord(error.details)
      && error.details.requiredOptIn === "SYNOD_RUNTIME_PACKAGE_SPEC"
  );
  assert.equal((await readLocalRuntimeDescriptor(directory))?.packageSpec, packageSpec);

  const result = await prepareLocalRuntime(["check", directory], {
    cwd: directory,
    env: { SYNOD_RUNTIME_PACKAGE_SPEC: packageSpec },
    currentRuntime: async () => false,
    installer: (targetDirectory, options) => {
      repairOptions = options;
      return installLocalRuntime(targetDirectory, {
        ...options,
        trustedPackageSpec: packageSpec,
        runPnpm: fakePnpmInstall
      });
    },
    executor: () => 0
  });

  assert.equal(result.action, "delegate");
  assert.deepEqual(repairOptions, { runtimeVersion: packageVersion, packageSpec });
  assert.equal((await readLocalRuntimeDescriptor(directory))?.packageSpec, packageSpec);
  assert.equal((await inspectLocalRuntime(directory)).ready, true);
});

test("the active-runtime marker prevents recursive delegation when paths cannot", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  let delegated = false;

  const result = await prepareLocalRuntime(["check", directory], {
    cwd: directory,
    env: { SYNOD_LOCAL_RUNTIME_ACTIVE: packageVersion },
    currentRuntime: async () => false,
    executor: () => { delegated = true; return 0; }
  });

  assert.equal(result.action, "current");
  assert.equal(result.local, true);
  assert.equal(delegated, false);
});

test("init and uninstall dry-runs never repair a missing runtime cache", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  await rm(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules"), { recursive: true });
  let installs = 0;

  for (const command of ["init", "uninstall"]) {
    await assert.rejects(
      prepareLocalRuntime([command, directory, "--dry-run"], {
        cwd: directory,
        installer: async () => { installs += 1; throw new Error("Dry-run invoked its installer."); },
        currentRuntime: async () => false
      }),
      error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
    );
  }

  assert.equal(installs, 0);
  await assert.rejects(
    readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules", packageName, "package.json"), "utf8"),
    { code: "ENOENT" }
  );
});

test("invalid init options fail before the runtime installer can mutate a project", async () => {
  const directory = await temporaryProject();
  let installerCalled = false;

  await assert.rejects(
    prepareLocalRuntime(["init", "--cwd", directory], {
      cwd: directory,
      installer: async () => { installerCalled = true; throw new Error("Invalid input invoked its installer."); }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.UNKNOWN_OPTION
  );
  assert.equal(installerCalled, false);
  await assert.rejects(readFile(path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH), "utf8"), { code: "ENOENT" });
});

test("invalid task options fail before selecting or repairing a project runtime", async () => {
  const directory = await temporaryProject();
  let installerCalled = false;

  await assert.rejects(
    prepareLocalRuntime([
      "task", "add", "T-001",
      "--objective", "--cwd", directory
    ], {
      cwd: directory,
      installer: async () => { installerCalled = true; throw new Error("Invalid input invoked its installer."); }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.MISSING_OPTION_VALUE
  );
  assert.equal(installerCalled, false);
  await assert.rejects(readFile(path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH), "utf8"), { code: "ENOENT" });
});

test("upgrade dry-run does not replace or delegate the pinned runtime", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  let installerCalled = false;
  let executorCalled = false;

  const result = await prepareLocalRuntime(["upgrade", directory, "--dry-run"], {
    cwd: directory,
    installer: async () => { installerCalled = true; throw new Error("Dry-run invoked its installer."); },
    executor: () => { executorCalled = true; throw new Error("Dry-run invoked its executor."); },
    currentRuntime: async () => false
  });

  assert.equal(result.action, "current");
  assert.deepEqual(result.runtimePlan, {
    action: "unchanged",
    fromRuntimeVersion: packageVersion,
    runtimeVersion: packageVersion,
    packageManager: "pnpm"
  });
  assert.equal(installerCalled, false);
  assert.equal(executorCalled, false);
});

test("upgrade atomically replaces an older runtime before delegating", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");
  let execution;

  const result = await prepareLocalRuntime(["upgrade", directory], {
    cwd: directory,
    installer: targetDirectory => installLocalRuntime(targetDirectory, { runPnpm: fakePnpmInstall }),
    executor(localRuntime, args, options) {
      execution = { version: localRuntime.descriptor.runtimeVersion, args, options };
      return 0;
    },
    currentRuntime: async () => false
  });

  assert.equal(result.action, "delegate");
  assert.deepEqual(execution, {
    version: packageVersion,
    args: ["upgrade", directory],
    options: { runtimeAction: "update" }
  });
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, packageVersion);
});

test("concurrent cross-version installs cannot commit a downgrade", async () => {
  const directory = await temporaryProject();
  let releaseNewer: () => void = () => {};
  let reportNewerStarted: () => void = () => {};
  let olderInstallerStarted = false;
  const newerStarted = new Promise<void>(resolve => { reportNewerStarted = resolve; });
  const holdNewer = new Promise<void>(resolve => { releaseNewer = resolve; });

  const newer = installLocalRuntime(directory, {
    runtimeVersion: "0.7.0",
    packageSpec: "0.7.0",
    async runPnpm(stageDirectory, context) {
      await fakePnpmInstall(stageDirectory, context);
      reportNewerStarted();
      await holdNewer;
    }
  });
  await newerStarted;

  const older: Promise<{ value: LocalRuntimeInspection } | { error: SynodError }> = installLocalRuntime(directory, {
    runtimeVersion: "0.6.0",
    packageSpec: "0.6.0",
    async runPnpm(stageDirectory, context) {
      olderInstallerStarted = true;
      await fakePnpmInstall(stageDirectory, context);
    }
  }).then(
    value => ({ value }),
    error => ({ error: asSynodError(error) })
  );

  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(olderInstallerStarted, false);
  releaseNewer();
  await newer;
  const olderResult = await older;

  assert.ok("error" in olderResult);
  assert.equal(olderResult.error.code, ERROR_CODES.DOWNGRADE_UNSUPPORTED);
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, "0.7.0");
  assert.equal((await inspectLocalRuntime(directory)).descriptor.runtimeVersion, "0.7.0");
});

test("a stale runtime install lock fails closed without mutating the project", async () => {
  const directory = await temporaryProject();
  const lockPath = path.join(directory, ".synod/runtime-install.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lockContent = `${JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-runtime-owner",
    createdAt: new Date(0).toISOString()
  })}\n`;
  await writeFile(lockPath, lockContent);

  await assert.rejects(
    installLocalRuntime(directory, { runPnpm: fakePnpmInstall }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.LOCAL_RUNTIME_CONFLICT
      && isRecord(error.details)
      && error.details.stale === true
  );
  assert.equal(await readFile(lockPath, "utf8"), lockContent);
  await assert.rejects(readFile(path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH), "utf8"), { code: "ENOENT" });
});

test("refuses to downgrade a newer pinned runtime", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "9.9.9");
  let installerCalled = false;
  let executorCalled = false;

  await assert.rejects(
    prepareLocalRuntime(["upgrade", directory, "--dry-run"], {
      cwd: directory,
      installer: async () => { installerCalled = true; throw new Error("Downgrade invoked its installer."); },
      executor: () => { executorCalled = true; return 0; },
      currentRuntime: async () => false
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.DOWNGRADE_UNSUPPORTED
  );

  await assert.rejects(
    installLocalRuntime(directory, { runPnpm: fakePnpmInstall }),
    error => error instanceof SynodError && error.code === ERROR_CODES.DOWNGRADE_UNSUPPORTED
  );
  assert.equal(installerCalled, false);
  assert.equal(executorCalled, false);
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, "9.9.9");
});

test("a failed staged upgrade preserves the prior runtime", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");

  await assert.rejects(
    installLocalRuntime(directory, {
      async runPnpm() { throw new Error("injected pnpm failure"); }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED
  );
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, "0.4.0");
  assert.equal((await inspectLocalRuntime(directory)).descriptor.runtimeVersion, "0.4.0");
});

test("a commit-stage failure restores both the prior runtime and descriptor", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");
  const descriptorPath = path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH);
  let injected = false;

  await assert.rejects(
    installLocalRuntime(directory, {
      runPnpm: fakePnpmInstall,
      async renamePath(source, destination) {
        const sourceName = path.basename(source);
        if (
          !injected
          && destination === descriptorPath
          && sourceName.startsWith(".runtime-descriptor-")
          && !sourceName.startsWith(".runtime-descriptor-backup-")
        ) {
          injected = true;
          throw new Error("injected descriptor commit failure");
        }
        return rename(source, destination);
      }
    }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED
  );

  assert.equal(injected, true);
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, "0.4.0");
  assert.equal((await inspectLocalRuntime(directory)).descriptor.runtimeVersion, "0.4.0");
});

test("a failed runtime rollback reports every restoration failure", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");
  const descriptorPath = path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH);

  await assert.rejects(
    installLocalRuntime(directory, {
      runPnpm: fakePnpmInstall,
      async renamePath(source, destination) {
        const sourceName = path.basename(source);
        if (
          destination === descriptorPath
          && sourceName.startsWith(".runtime-descriptor-")
        ) {
          throw new Error(sourceName.startsWith(".runtime-descriptor-backup-")
            ? "injected descriptor restore failure"
            : "injected descriptor commit failure");
        }
        return rename(source, destination);
      }
    }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.ROLLBACK_FAILED
      && isRecord(error.details)
      && error.details.originalCode === ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED
      && Array.isArray(error.details.rollbackFailures)
      && error.details.rollbackFailures.some(item => isRecord(item) && item.operation === "restore-descriptor")
  );

  assert.equal((await inspectLocalRuntime(directory, {
    schemaVersion: 1,
    runtimeVersion: "0.4.0",
    packageSpec: "0.4.0",
    packageName,
    packageManager: "pnpm",
    runtimeDirectory: LOCAL_RUNTIME_DIRECTORY,
    executable: `${LOCAL_RUNTIME_DIRECTORY}/node_modules/${packageName}/bin/synod.js`
  })).ready, true);
});

test("removes only a validated local runtime installation", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });

  assert.equal(await removeLocalRuntime(directory), true);
  assert.equal(await readLocalRuntimeDescriptor(directory), undefined);
  await assert.rejects(readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "package.json"), "utf8"), { code: "ENOENT" });
  assert.equal(await removeLocalRuntime(directory), false);
});

test("refuses to remove a runtime whose managed installation is incomplete", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  await rm(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules"), { recursive: true });

  await assert.rejects(
    removeLocalRuntime(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
  );
  assert.equal((await readLocalRuntimeDescriptor(directory))?.runtimeVersion, packageVersion);
  assert.equal(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "package.json"), "utf8").then(Boolean), true);
});

test("detects descriptor and installed-package version divergence", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  const packagePath = path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules", ...packageName.split("/"), "package.json");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  metadata.version = "9.9.9";
  await writeFile(packagePath, `${JSON.stringify(metadata)}\n`);

  await assert.rejects(
    inspectLocalRuntime(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
  );
});

test("check reports an invalid local runtime while preserving the remaining checks", async () => {
  const directory = await temporaryProject();
  await installLocalRuntime(directory, { runPnpm: fakePnpmInstall });
  await initProject({ directory });
  const packagePath = path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules", ...packageName.split("/"), "package.json");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  metadata.version = "9.9.9";
  await writeFile(packagePath, `${JSON.stringify(metadata)}\n`);

  const result = await checkProject({ directory });
  const runtimeCheck = result.checks.find(item => item.path === ".synod/runtime");
  assert.ok(runtimeCheck);

  assert.equal(result.healthy, false);
  assert.equal(runtimeCheck.status, "invalid");
  assert.equal(runtimeCheck.severity, "error");
  assert.equal(runtimeCheck.code, ERROR_CODES.LOCAL_RUNTIME_INVALID);
  assert.ok(result.checks.some(item => item.path === "AGENTS.md"));
});

test("rejects a malformed runtime descriptor without touching it", async () => {
  const directory = await temporaryProject();
  const descriptorPath = path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH);
  await mkdir(path.dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, "{}\n");

  await assert.rejects(
    readLocalRuntimeDescriptor(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
  );
  assert.equal(await readFile(descriptorPath, "utf8"), "{}\n");
});

test("rejects a pnpm package link that escapes the isolated runtime", async () => {
  const directory = await temporaryProject();
  const outside = await temporaryProject();
  await writePinnedRuntime(directory, packageVersion);
  const packageRoot = path.join(directory, LOCAL_RUNTIME_DIRECTORY, "node_modules", ...packageName.split("/"));
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(path.join(outside, "bin"), { recursive: true });
  await writeFile(path.join(outside, "package.json"), `${JSON.stringify({
    name: packageName,
    version: packageVersion,
    bin: { synod: "bin/synod.js" }
  })}\n`);
  await writeFile(path.join(outside, "bin/synod.js"), "#!/usr/bin/env node\n");
  await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    inspectLocalRuntime(directory),
    error => error instanceof SynodError && error.code === ERROR_CODES.UNSAFE_PATH
  );
});
