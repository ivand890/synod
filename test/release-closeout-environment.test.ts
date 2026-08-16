import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import {
  collectLiveNpmPublication,
  collectLiveGitHubRelease,
  createPublicApiEnvironment,
  createPublicPackageCommandEnvironment,
  PublicReleaseVerificationError,
  publicApiEnvironment,
  verifyExactRegistryInstall,
  verifyPublicDlx,
} from "../scripts/verify-public-release-closeout.js";

const PUBLIC_REGISTRY = "https://registry.npmjs.org";

function assertCleanPackageEnvironment(environment: NodeJS.ProcessEnv, cwd: string): void {
  assert.deepEqual(Object.keys(environment).sort(), [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "npm_config_cache",
  ]);
  assert.equal(environment.NPM_CONFIG_REGISTRY, undefined);
  assert.equal(environment.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(environment.NPM_TOKEN, undefined);
  assert.equal(environment.NODE_AUTH_TOKEN, undefined);
  assert.equal(environment.SYNOD_SECRET_SENTINEL, undefined);
  assert.ok(path.relative(process.cwd(), cwd).startsWith(".."));
  assert.ok(path.relative(process.cwd(), environment.HOME as string).startsWith(".."));
  assert.ok(path.relative(process.cwd(), environment.XDG_STATE_HOME as string).startsWith(".."));
  assert.ok(path.relative(process.cwd(), environment.XDG_CONFIG_HOME as string).startsWith(".."));
  assert.ok(path.relative(process.cwd(), environment.npm_config_cache as string).startsWith(".."));
  assert.equal(existsSync(cwd), true);
  assert.equal(existsSync(environment.HOME as string), true);
  assert.equal(existsSync(environment.XDG_STATE_HOME as string), true);
  assert.equal(existsSync(environment.XDG_CONFIG_HOME as string), true);
  assert.equal(existsSync(environment.npm_config_cache as string), true);
}

function withHostileNpmEnvironment<T>(callback: () => T): T {
  const keys = [
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_USERCONFIG",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "SYNOD_SECRET_SENTINEL",
  ] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.NPM_CONFIG_REGISTRY = "https://attacker.invalid/registry";
  process.env.NPM_CONFIG_USERCONFIG = "/checkout/attacker.npmrc";
  process.env.NPM_TOKEN = "npm-secret-sentinel";
  process.env.NODE_AUTH_TOKEN = "node-secret-sentinel";
  process.env.SYNOD_SECRET_SENTINEL = "must-not-cross-package-boundary";
  try {
    return callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("public GitHub commands receive only the repaired PATH and API credentials", () => {
  const environment = publicApiEnvironment({
    PATH: "/supervisor/bin",
    GH_TOKEN: "read-only-token",
    GH_HOST: "github.example.test",
    NPM_TOKEN: "unrelated-secret",
    SYNOD_SECRET_SENTINEL: "must-not-cross-the-public-api-boundary",
  });
  assert.deepEqual(environment, {
    PATH: "/supervisor/bin",
    GH_TOKEN: "read-only-token",
    GH_HOST: "github.example.test",
  });
  assert.equal("SYNOD_SECRET_SENTINEL" in environment, false);

  assert.deepEqual(publicApiEnvironment({
    PATH: "/supervisor/bin",
    GH_TOKEN: "read-only-token",
  }), {
    PATH: "/supervisor/bin",
    GH_TOKEN: "read-only-token",
  });
});

test("public GitHub command environment fails closed without GH_TOKEN", () => {
  assert.throws(
    () => publicApiEnvironment({
      PATH: "/supervisor/bin",
      SYNOD_SECRET_SENTINEL: "must-not-cross-the-public-api-boundary",
    }),
    error => error instanceof PublicReleaseVerificationError
      && error.code === "SYNOD_PUBLIC_RELEASE_CLOSEOUT_INVALID"
      && /GH_TOKEN is required/.test(error.message),
  );
  assert.throws(
    () => createPublicApiEnvironment({
      PATH: "/supervisor/bin",
      NPM_TOKEN: "unrelated-secret",
      SYNOD_SECRET_SENTINEL: "must-not-cross-the-public-api-boundary",
    }),
    /GH_TOKEN is required/,
  );
});

test("public npm metadata uses only a fresh executable environment and the public registry", () => {
  const repoLocal = path.join(process.cwd(), ".local");
  const repoLocalBefore = existsSync(repoLocal);
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  let observedCwd: string | undefined;
  let observedArgs: readonly string[] | undefined;
  const publication = withHostileNpmEnvironment(() => collectLiveNpmPublication(
    "@ivand890/synod",
    "0.9.4",
    (command, args, options) => {
      assert.equal(command, "npm");
      observedEnvironment = options?.env;
      observedCwd = options?.cwd;
      observedArgs = args;
      assert.ok(options?.env);
      assert.ok(options?.cwd);
      assertCleanPackageEnvironment(options.env, options.cwd);
      assert.deepEqual(args.slice(-2), ["--registry", PUBLIC_REGISTRY]);
      return JSON.stringify({
        version: "0.9.4",
        gitHead: "a".repeat(40),
        "dist-tags.latest": "0.9.4",
        "dist.integrity": "sha512-integrity",
        "dist.attestations": {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/0.9.4",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      });
    },
  ));
  assert.equal(publication.version, "0.9.4");
  assert.equal(observedArgs?.includes(PUBLIC_REGISTRY), true);
  assert.ok(observedEnvironment);
  assert.ok(observedCwd);
  assert.equal(existsSync(observedCwd), false);
  assert.equal(existsSync(observedEnvironment.HOME as string), false);
  assert.equal(existsSync(observedEnvironment.XDG_CONFIG_HOME as string), false);
  assert.equal(existsSync(observedEnvironment.npm_config_cache as string), false);
  assert.equal(existsSync(repoLocal), repoLocalBefore);
});

test("public npm metadata cleans its isolated environment after command failure", () => {
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  let observedCwd: string | undefined;
  assert.throws(
    () => withHostileNpmEnvironment(() => collectLiveNpmPublication(
      "@ivand890/synod",
      "0.9.4",
      (_command, _args, options) => {
        observedEnvironment = options?.env;
        observedCwd = options?.cwd;
        assert.ok(options?.env);
        assert.ok(options?.cwd);
        assertCleanPackageEnvironment(options.env, options.cwd);
        throw new Error("simulated npm view failure");
      },
    )),
    /simulated npm view failure/,
  );
  assert.ok(observedEnvironment);
  assert.ok(observedCwd);
  assert.equal(existsSync(observedCwd), false);
  assert.equal(existsSync(observedEnvironment.HOME as string), false);
  assert.equal(existsSync(observedEnvironment.XDG_STATE_HOME as string), false);
  assert.equal(existsSync(observedEnvironment.XDG_CONFIG_HOME as string), false);
  assert.equal(existsSync(observedEnvironment.npm_config_cache as string), false);
});

test("package install and dlx use isolated environments, forced public registry, and cleanup on success/failure", () => {
  const observed: Array<{ command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  withHostileNpmEnvironment(() => {
    const installed = verifyExactRegistryInstall(
      "@ivand890/synod@0.9.4",
      "0.9.4",
      (command, args, options) => {
        observed.push({
          command,
          args,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: options.env }),
        });
        assert.equal(command, "pnpm");
        assert.ok(options?.env);
        assert.ok(options?.cwd);
        assertCleanPackageEnvironment(options.env, options.cwd);
        if (args[0] === "add") {
          assert.deepEqual(args.slice(0, 5), ["add", "--ignore-scripts", "--save-exact", "--registry", PUBLIC_REGISTRY]);
          return "";
        }
        assert.deepEqual(args, ["exec", "synod", "--version"]);
        return "0.9.4\n";
      },
    );
    assert.equal(installed, "0.9.4");
    const installedEnvironment = observed[0]?.env;
    const installedCwd = observed[0]?.cwd;
    assert.ok(installedEnvironment);
    assert.ok(installedCwd);
    assert.equal(existsSync(installedCwd), false);
    assert.equal(existsSync(installedEnvironment.HOME as string), false);
    assert.equal(existsSync(installedEnvironment.npm_config_cache as string), false);

    const dlx = verifyPublicDlx(
      "@ivand890/synod@0.9.4",
      "0.9.4",
      (command, args, options) => {
        assert.equal(command, "pnpm");
        assert.deepEqual(args, ["dlx", `--config.registry=${PUBLIC_REGISTRY}`, "@ivand890/synod@0.9.4", "--version"]);
        assert.ok(options?.env);
        assert.ok(options?.cwd);
        assertCleanPackageEnvironment(options.env, options.cwd);
        return "0.9.4\n";
      },
    );
    assert.equal(dlx, "0.9.4");
  });
  assert.equal(observed.length, 2);

  let failedEnvironment: NodeJS.ProcessEnv | undefined;
  let failedCwd: string | undefined;
  assert.throws(
    () => verifyPublicDlx("@ivand890/synod@0.9.4", "0.9.4", (_command, _args, options) => {
      failedEnvironment = options?.env;
      failedCwd = options?.cwd;
      assert.ok(options?.env);
      assert.ok(options?.cwd);
      throw new Error("simulated pnpm dlx failure");
    }),
    /simulated pnpm dlx failure/,
  );
  assert.ok(failedEnvironment);
  assert.ok(failedCwd);
  assert.equal(existsSync(failedCwd), false);
  assert.equal(existsSync(failedEnvironment.HOME as string), false);
  assert.equal(existsSync(failedEnvironment.XDG_CONFIG_HOME as string), false);
  assert.equal(existsSync(failedEnvironment.npm_config_cache as string), false);
});

test("pnpm dlx public registry option is accepted by the local CLI parser", () => {
  const parsed = spawnSync(
    "pnpm",
    ["dlx", `--config.registry=${PUBLIC_REGISTRY}`, "--help"],
    { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /Usage: pnpm dlx/);
  assert.doesNotMatch(parsed.stderr, /Unknown option/);

  const invalid = spawnSync(
    "pnpm",
    ["dlx", "--registry", PUBLIC_REGISTRY, "--version"],
    { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown options?: ['"]registry/);
});

test("registry install cleans both temporary roots when pnpm add fails", () => {
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  let observedConsumer: string | undefined;
  assert.throws(
    () => withHostileNpmEnvironment(() => verifyExactRegistryInstall(
      "@ivand890/synod@0.9.4",
      "0.9.4",
      (_command, args, options) => {
        assert.deepEqual(args.slice(0, 5), ["add", "--ignore-scripts", "--save-exact", "--registry", PUBLIC_REGISTRY]);
        observedEnvironment = options?.env;
        observedConsumer = options?.cwd;
        assert.ok(options?.env);
        assert.ok(options?.cwd);
        assertCleanPackageEnvironment(options.env, options.cwd);
        throw new Error("simulated pnpm add failure");
      },
    )),
    /simulated pnpm add failure/,
  );
  assert.ok(observedEnvironment);
  assert.ok(observedConsumer);
  assert.equal(existsSync(observedConsumer), false);
  assert.equal(existsSync(observedEnvironment.HOME as string), false);
  assert.equal(existsSync(observedEnvironment.XDG_STATE_HOME as string), false);
  assert.equal(existsSync(observedEnvironment.XDG_CONFIG_HOME as string), false);
  assert.equal(existsSync(observedEnvironment.npm_config_cache as string), false);
});

test("public package environment allocates and cleans fresh homes without forwarding input configuration", () => {
  const scope = withHostileNpmEnvironment(() => createPublicPackageCommandEnvironment({
    PATH: "/supervisor/bin",
    NPM_CONFIG_REGISTRY: "https://attacker.invalid/registry",
    NPM_CONFIG_USERCONFIG: "/attacker.npmrc",
    NPM_TOKEN: "secret",
    SYNOD_SECRET_SENTINEL: "must-not-cross",
  }));
  try {
    assertCleanPackageEnvironment(scope.environment, scope.cwd);
    assert.equal(scope.environment.PATH, "/supervisor/bin");
  } finally {
    scope.cleanup();
  }
  assert.equal(existsSync(scope.cwd), false);
  assert.equal(existsSync(scope.environment.HOME as string), false);
});

test("GitHub API reads use isolated XDG homes and clean them after success", () => {
  const originalToken = process.env.GH_TOKEN;
  const originalHost = process.env.GH_HOST;
  const repoLocal = path.join(process.cwd(), ".local");
  const repoLocalBefore = existsSync(repoLocal);
  process.env.GH_TOKEN = "read-only-token";
  delete process.env.GH_HOST;
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  let calls = 0;
  const commandRunner = (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): string => {
    assert.equal(command, "gh");
    assert.ok(options?.env);
    if (observedEnvironment === undefined) observedEnvironment = options.env;
    else assert.equal(options.env, observedEnvironment);
    const environment = options.env;
    assert.deepEqual(Object.keys(environment).sort(), ["GH_TOKEN", "PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]);
    assert.equal(environment.GH_TOKEN, "read-only-token");
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal(environment.GH_HOST, undefined);
    assert.equal(typeof environment.XDG_STATE_HOME, "string");
    assert.equal(typeof environment.XDG_CONFIG_HOME, "string");
    assert.ok(path.relative(process.cwd(), environment.XDG_STATE_HOME as string).startsWith(".."));
    assert.ok(path.relative(process.cwd(), environment.XDG_CONFIG_HOME as string).startsWith(".."));
    assert.equal(existsSync(environment.XDG_STATE_HOME as string), true);
    assert.equal(existsSync(environment.XDG_CONFIG_HOME as string), true);
    calls += 1;
    if (args[1] === "repos/ivand890/synod/releases/latest") return JSON.stringify({ tag_name: "v0.9.3" });
    return JSON.stringify({
      tag_name: "v0.9.3",
      html_url: "https://github.com/ivand890/synod/releases/tag/v0.9.3",
      published_at: "2026-08-14T19:29:39Z",
      draft: false,
      prerelease: false,
      immutable: true,
    });
  };
  try {
    const release = collectLiveGitHubRelease("ivand890/synod", "v0.9.3", commandRunner);
    assert.equal(release.isLatest, true);
    assert.equal(calls, 2);
    assert.ok(observedEnvironment);
    assert.equal(existsSync(observedEnvironment.XDG_STATE_HOME as string), false);
    assert.equal(existsSync(observedEnvironment.XDG_CONFIG_HOME as string), false);
    assert.equal(existsSync(repoLocal), repoLocalBefore);
  } finally {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = originalHost;
  }
});

test("GitHub API XDG homes are cleaned when a read fails", () => {
  const originalToken = process.env.GH_TOKEN;
  const originalHost = process.env.GH_HOST;
  const repoLocal = path.join(process.cwd(), ".local");
  const repoLocalBefore = existsSync(repoLocal);
  process.env.GH_TOKEN = "read-only-token";
  delete process.env.GH_HOST;
  let observedEnvironment: NodeJS.ProcessEnv | undefined;
  let calls = 0;
  const commandRunner = (_command: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): string => {
    assert.ok(options?.env);
    observedEnvironment = options.env;
    calls += 1;
    if (calls === 1) {
      assert.equal(existsSync(options.env.XDG_STATE_HOME as string), true);
      assert.equal(existsSync(options.env.XDG_CONFIG_HOME as string), true);
      return JSON.stringify({
        tag_name: "v0.9.3",
        html_url: "https://github.com/ivand890/synod/releases/tag/v0.9.3",
        published_at: "2026-08-14T19:29:39Z",
        draft: false,
        prerelease: false,
        immutable: true,
      });
    }
    throw new Error("simulated latest-release read failure");
  };
  try {
    assert.throws(
      () => collectLiveGitHubRelease("ivand890/synod", "v0.9.3", commandRunner),
      /simulated latest-release read failure/,
    );
    assert.equal(calls, 2);
    assert.ok(observedEnvironment);
    assert.equal(existsSync(observedEnvironment.XDG_STATE_HOME as string), false);
    assert.equal(existsSync(observedEnvironment.XDG_CONFIG_HOME as string), false);
    assert.equal(existsSync(repoLocal), repoLocalBefore);
  } finally {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = originalHost;
  }
});
