import assert from "node:assert/strict";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { doctorProject } from "../src/doctor.js";

function model(id, efforts) {
  return { id, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) };
}

function fakeClient(version, models) {
  const diagnostics = {
    codexVersion: version,
    appServer: { capabilities: { initialize: true, threadList: true, modelList: true } }
  };
  return {
    async start() {},
    async probeCapabilities() {},
    async listModels() { return models; },
    async close() {},
    getDiagnostics() { return diagnostics; },
    getWarnings() { return []; }
  };
}

const all56Efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const models56 = [
  model("gpt-5.6-sol", all56Efforts),
  model("gpt-5.6-terra", all56Efforts),
  model("gpt-5.6-luna", all56Efforts.filter(item => item !== "ultra"))
];

test("doctor detects a known-good Codex runtime and compatible model profile", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.147.0", models56) }
  );

  assert.equal(result.healthy, true);
  assert.equal(result.codex.status, "known-good");
  assert.equal(result.recommendedProfile, "synod-5.6");
  assert.equal(result.profiles.find(item => item.id === "synod-5.6").compatible, true);
});

test("doctor fails closed above the tested Codex range", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.148.0", models56) }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "above_tested_range");
  assert.ok(result.warnings.some(item => item.code === WARNING_CODES.CODEX_VERSION_UNSUPPORTED));
});

test("doctor reports an unparseable Codex version without throwing", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("development", models56) }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "invalid_or_prerelease");
});
