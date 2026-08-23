import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import { evaluateProfile, getProfile, listProfiles, resolveImplementerProfile } from "../src/profiles.js";
import type { ModelCapability } from "../src/profiles.js";

function model(id: string, efforts: string[]): ModelCapability {
  return {
    id,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort }))
  };
}

test("keeps the GPT-5.6 spawn fallback separate from Luna role overrides", () => {
  const profile = getProfile("synod-5.6");

  assert.deepEqual(profile.defaultSubagent, { model: "gpt-5.6-terra", effort: "max" });
  assert.deepEqual(profile.roles.implementer, { model: "gpt-5.6-luna", effort: "max" });
  assert.deepEqual(profile.roles.mechanical, { model: "gpt-5.6-luna", effort: "medium" });
});

test("resolves the installed implementer role without a model or effort override", () => {
  assert.deepEqual(resolveImplementerProfile("synod-5.6"), {
    profile: "synod-5.6",
    model: "gpt-5.6-luna",
    effort: "max"
  });
  assert.deepEqual(resolveImplementerProfile("portable"), {
    profile: "portable",
    model: "gpt-5.5",
    effort: "high"
  });
});

test("fails with a typed profile error for missing, invalid, or unsupported profiles", () => {
  for (const profile of [undefined, "", "portable ", "not-a-profile"]) {
    assert.throws(
      () => resolveImplementerProfile(profile),
      error => error instanceof Error
        && "code" in error
        && (error as Error & { code?: string }).code === ERROR_CODES.PROFILE_NOT_FOUND
    );
  }
});

test("evaluates the global subagent fallback as a profile capability", () => {
  const profile = {
    id: "test",
    defaultSubagent: { model: "spawn-default", effort: "medium" },
    roles: {
      worker: { model: "worker-model", effort: "high" }
    }
  };

  const result = evaluateProfile(profile, [model("worker-model", ["high"])]);

  assert.equal(result.compatible, false);
  assert.deepEqual(result.missing, [{
    role: "default_subagent",
    model: "spawn-default",
    capability: "model"
  }]);
});

test("indexes App Server capabilities by model slug before preset ID", () => {
  const profile = {
    id: "test",
    defaultSubagent: { model: "runtime-model", effort: "high" },
    roles: {}
  };

  const result = evaluateProfile(profile, [{
    id: "display-preset",
    model: "runtime-model",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }]
  }]);

  assert.equal(result.compatible, true);
  assert.deepEqual(result.missing, []);
});

test("built-in profiles require the current supported Codex minor line", () => {
  assert.deepEqual(
    listProfiles().map(profile => ({ id: profile.id, minimumCodexVersion: profile.minimumCodexVersion })),
    [
      { id: "synod-5.6", minimumCodexVersion: "0.148.0" },
      { id: "portable", minimumCodexVersion: "0.148.0" }
    ]
  );
});
