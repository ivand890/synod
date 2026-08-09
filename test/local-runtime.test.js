import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import {
  LOCAL_RUNTIME_DESCRIPTOR_PATH,
  LOCAL_RUNTIME_DIRECTORY,
  inspectLocalRuntime,
  installLocalRuntime,
  prepareLocalRuntime,
  readLocalRuntimeDescriptor,
  removeLocalRuntime
} from "../src/local-runtime.js";
import { packageName, packageVersion } from "../src/package.js";

const temporaryDirectories = new Set();

async function temporaryProject() {
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

async function fakePnpmInstall(directory, { runtimeVersion = packageVersion } = {}) {
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

async function writePinnedRuntime(directory, version, packageSpec = version) {
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
  assert.equal(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, ".gitignore"), "utf8"), "node_modules/\n");
  assert.match(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "pnpm-lock.yaml"), "utf8"), /lockfileVersion/);
});

test("refuses to adopt an unmanaged runtime directory", async () => {
  const directory = await temporaryProject();
  await mkdir(path.join(directory, LOCAL_RUNTIME_DIRECTORY), { recursive: true });
  await writeFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "owned.txt"), "user\n");

  await assert.rejects(
    installLocalRuntime(directory, { runPnpm: fakePnpmInstall }),
    error => error.code === ERROR_CODES.LOCAL_RUNTIME_CONFLICT
  );
  assert.equal(await readFile(path.join(directory, LOCAL_RUNTIME_DIRECTORY, "owned.txt"), "utf8"), "user\n");
});

test("init bootstraps and delegates while dry-run remains non-mutating", async () => {
  const directory = await temporaryProject();
  let installed = 0;
  let delegated = 0;
  const preview = await prepareLocalRuntime(["init", directory, "--dry-run"], {
    cwd: directory,
    installer: async () => { installed += 1; },
    executor: () => { delegated += 1; },
    currentRuntime: async () => false
  });
  const applied = await prepareLocalRuntime(["init", directory], {
    cwd: directory,
    installer: async targetDirectory => {
      installed += 1;
      return {
        ready: true,
        executable: "/local/synod.js",
        packageRoot: "/local/package",
        descriptor: { runtimeVersion: packageVersion, targetDirectory }
      };
    },
    executor(localRuntime, args, execution) {
      delegated += 1;
      assert.equal(localRuntime.executable, "/local/synod.js");
      assert.deepEqual(args, ["init", directory]);
      assert.equal(execution.runtimeAction, "install");
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

test("invalid init options fail before the runtime installer can mutate a project", async () => {
  const directory = await temporaryProject();
  let installerCalled = false;

  await assert.rejects(
    prepareLocalRuntime(["init", "--cwd", directory], {
      cwd: directory,
      installer: async () => { installerCalled = true; }
    }),
    error => error.code === ERROR_CODES.UNKNOWN_OPTION
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
    installer: async () => { installerCalled = true; },
    executor: () => { executorCalled = true; },
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
  assert.equal((await readLocalRuntimeDescriptor(directory)).runtimeVersion, packageVersion);
});

test("refuses to downgrade a newer pinned runtime", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "9.9.9");

  await assert.rejects(
    installLocalRuntime(directory, { runPnpm: fakePnpmInstall }),
    error => error.code === ERROR_CODES.DOWNGRADE_UNSUPPORTED
  );
  assert.equal((await readLocalRuntimeDescriptor(directory)).runtimeVersion, "9.9.9");
});

test("a failed staged upgrade preserves the prior runtime", async () => {
  const directory = await temporaryProject();
  await writePinnedRuntime(directory, "0.4.0");

  await assert.rejects(
    installLocalRuntime(directory, {
      async runPnpm() { throw new Error("injected pnpm failure"); }
    }),
    error => error.code === ERROR_CODES.LOCAL_RUNTIME_INSTALL_FAILED
  );
  assert.equal((await readLocalRuntimeDescriptor(directory)).runtimeVersion, "0.4.0");
  assert.equal((await inspectLocalRuntime(directory)).descriptor.runtimeVersion, "0.4.0");
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
    error => error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
  );
  assert.equal((await readLocalRuntimeDescriptor(directory)).runtimeVersion, packageVersion);
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
    error => error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
  );
});

test("rejects a malformed runtime descriptor without touching it", async () => {
  const directory = await temporaryProject();
  const descriptorPath = path.join(directory, LOCAL_RUNTIME_DESCRIPTOR_PATH);
  await mkdir(path.dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, "{}\n");

  await assert.rejects(
    readLocalRuntimeDescriptor(directory),
    error => error.code === ERROR_CODES.LOCAL_RUNTIME_INVALID
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
    error => error.code === ERROR_CODES.UNSAFE_PATH
  );
});
