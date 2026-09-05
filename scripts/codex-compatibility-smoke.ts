import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/app-server.js";
import { doctorProject } from "../src/doctor.js";
import { isRecord } from "../src/validation.js";

const expectedVersion = process.env.SYNOD_EXPECTED_CODEX_VERSION;
const expectedStatus = process.env.SYNOD_EXPECTED_CODEX_STATUS;
const expectedHealthy = process.env.SYNOD_EXPECTED_DOCTOR_HEALTHY === "true";
const expectedSurface = process.env.SYNOD_EXPECTED_CODEX_SURFACE || "cli";
const executable = process.env.SYNOD_CODEX_BIN;

if (!expectedVersion || !expectedStatus || !process.env.SYNOD_EXPECTED_DOCTOR_HEALTHY) {
  throw new Error("Codex compatibility smoke expectations are required.");
}
assert.ok(executable && path.isAbsolute(executable), "Pin SYNOD_CODEX_BIN to the exact absolute executable under test.");
assert.ok(expectedSurface === "cli" || expectedSurface === "desktop");

// A metadata-only probe: no turn/start, model generation, or project install.
// Isolate Codex state so this also runs without account credentials in CI.
const scratch = await mkdtemp(path.join(os.tmpdir(), "synod-codex-compatibility-"));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(scratch, "home");
await mkdir(process.env.CODEX_HOME);
let client = new CodexAppServerClient({ codexBin: executable, cwd: scratch });
try {
  const result = await doctorProject({ project: false });
  assert.equal(result.codex.version, expectedVersion);
  assert.equal(result.codex.surface, expectedSurface);
  assert.equal(result.codex.executable, executable);
  assert.equal(result.codex.status, expectedStatus);
  assert.equal(result.healthy, expectedHealthy);
  assert.ok(isRecord(result.capabilities.appServer));
  assert.equal(result.capabilities.appServer.initialize, true);
  assert.equal(result.capabilities.appServer.threadList, true);
  assert.equal(result.capabilities.appServer.modelList, true);
  const schemaDirectory = path.join(scratch, "schema");
  execFileSync(executable, ["app-server", "generate-ts", "--out", schemaDirectory], { timeout: 30_000, stdio: "pipe" });
  const schema = await readFile(path.join(schemaDirectory, "v2", "Thread.ts"), "utf8");
  const currentLine = expectedVersion.startsWith("0.153.");
  assert.equal(/model: string \| null/.test(schema), currentLine);
  assert.equal(/reasoningEffort: ReasoningEffort \| null/.test(schema), currentLine);
  await client.start();
  const started = await client.request("thread/start", {
    cwd: scratch, model: "gpt-5.6-luna", config: { model_reasoning_effort: "max" },
    approvalPolicy: "never", sandbox: "read-only", ephemeral: false
  });
  assert.ok(isRecord(started) && isRecord(started.thread));
  assert.equal(started.model, "gpt-5.6-luna");
  assert.equal(started.reasoningEffort, "max");
  const threadId = started.thread.id;
  assert.equal(typeof threadId, "string");
  const loaded = await client.request("thread/read", { threadId, includeTurns: false });
  assert.ok(isRecord(loaded) && isRecord(loaded.thread));
  if (currentLine) {
    assert.equal(loaded.thread.model, "gpt-5.6-luna");
    assert.equal(loaded.thread.reasoningEffort, "max");
  }
  // Naming persists the no-turn thread's index entry. No turn context exists,
  // so its unloaded profile is correctly null, not the requested live settings.
  await client.request("thread/name/set", { threadId, name: "Synod metadata-only compatibility probe" });
  await client.close();
  client = new CodexAppServerClient({ codexBin: executable, cwd: scratch });
  await client.start();
  const read = await client.request("thread/read", { threadId, includeTurns: false });
  assert.ok(isRecord(read) && isRecord(read.thread));
  assert.equal(read.thread.id, threadId);
  if (currentLine) {
    assert.equal(read.thread.model, null);
    assert.equal(read.thread.reasoningEffort, null);
  } else {
    assert.equal(read.thread.model, undefined);
    assert.equal(read.thread.reasoningEffort, undefined);
  }
  console.log(
    `Codex ${expectedSurface} ${result.codex.version}: ${result.codex.status}, doctor ${result.healthy ? "healthy" : "fail-closed"}; schema, loaded profile, and nullable unloaded metadata verified (${executable}).`
  );
} finally {
  await client.close();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  // Codex plugin checkout writes can briefly outlive App Server shutdown.
  // Retry transient directory races, but still fail if cleanup cannot finish.
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
