import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import {
  collectLiveGitHubRelease,
  createPublicApiEnvironment,
  PublicReleaseVerificationError,
  publicApiEnvironment,
} from "../scripts/verify-public-release-closeout.js";

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
