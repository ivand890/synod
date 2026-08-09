import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProfile, getProfile } from "../src/profiles.js";

function model(id, efforts) {
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
