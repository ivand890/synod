import assert from "node:assert/strict";
import { doctorProject } from "../src/doctor.js";

const expectedVersion = process.env.SYNOD_EXPECTED_CODEX_VERSION;
const expectedStatus = process.env.SYNOD_EXPECTED_CODEX_STATUS;
const expectedHealthy = process.env.SYNOD_EXPECTED_DOCTOR_HEALTHY === "true";

if (!expectedVersion || !expectedStatus || !process.env.SYNOD_EXPECTED_DOCTOR_HEALTHY) {
  throw new Error("Codex compatibility smoke expectations are required.");
}

const result = await doctorProject({ project: false });

assert.equal(result.codex.version, expectedVersion);
assert.equal(result.codex.status, expectedStatus);
assert.equal(result.healthy, expectedHealthy);
assert.equal(result.capabilities.appServer.initialize, true);
assert.equal(result.capabilities.appServer.threadList, true);
assert.equal(result.capabilities.appServer.modelList, true);

console.log(
  `Codex ${result.codex.version}: ${result.codex.status}, doctor ${result.healthy ? "healthy" : "fail-closed"}.`
);
