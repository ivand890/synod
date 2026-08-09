import assert from "node:assert/strict";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { doctorProject } from "../src/doctor.js";
import { ERROR_CODES } from "../src/errors.js";

function model(id, efforts) {
  return { id, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) };
}

function fakeClient(version, models, { surface = "cli", executable = "codex", home = "/tmp/codex" } = {}) {
  const diagnostics = {
    codexExecutable: executable,
    codexHome: home,
    codexSurface: surface,
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

function runtime(surface = "cli", executable = "/usr/local/bin/codex") {
  return {
    surface,
    executable,
    executableSource: surface === "desktop" ? "desktop-process" : "PATH",
    resolved: true
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
    { clientFactory: () => fakeClient("0.147.0", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, true);
  assert.equal(result.codex.surface, "cli");
  assert.equal(result.codex.label, "Codex CLI");
  assert.equal(result.codex.executable, "codex");
  assert.equal(result.codex.executableSource, "PATH");
  assert.equal(result.codex.home, "/tmp/codex");
  assert.equal(result.codex.status, "known-good");
  assert.equal(result.recommendedProfile, "synod-5.6");
  assert.equal(result.profiles.find(item => item.id === "synod-5.6").compatible, true);
});

test("doctor keeps Desktop and CLI versions scoped to their detected surface", async () => {
  let desktopClientOptions;
  const cli = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.147.0", models56), runtimeResolver: () => runtime() }
  );
  const desktop = await doctorProject(
    { project: false },
    {
      clientFactory: options => {
        desktopClientOptions = options;
        return fakeClient("0.145.2", models56, {
          surface: "desktop",
          executable: options.codexBin
        });
      },
      runtimeResolver: () => runtime("desktop", "/Applications/ChatGPT.app/Contents/Resources/codex")
    }
  );

  assert.deepEqual(
    { surface: cli.codex.surface, version: cli.codex.version, label: cli.codex.label },
    { surface: "cli", version: "0.147.0", label: "Codex CLI" }
  );
  assert.deepEqual(
    { surface: desktop.codex.surface, version: desktop.codex.version, label: desktop.codex.label },
    { surface: "desktop", version: "0.145.2", label: "Codex Desktop" }
  );
  assert.deepEqual(desktopClientOptions, {
    codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
});

test("doctor fails closed when Desktop is detected but its executable is ambiguous", async () => {
  const result = await doctorProject(
    { project: false },
    {
      clientFactory: () => fakeClient("0.147.0", models56, { surface: "desktop" }),
      runtimeResolver: () => ({
        surface: "desktop",
        executable: "codex",
        executableSource: "PATH-fallback",
        resolved: false
      })
    }
  );

  assert.equal(result.healthy, false);
  assert.ok(result.issues.some(issue => issue.code === ERROR_CODES.CODEX_RUNTIME_AMBIGUOUS));
});

test("doctor fails closed above the tested Codex range", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.148.0", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "above_tested_range");
  assert.equal(result.recommendedProfile, null);
  assert.ok(result.profiles.every(profile => profile.compatible === false));
  assert.ok(result.warnings.some(item => item.code === WARNING_CODES.CODEX_VERSION_UNSUPPORTED));
});

test("doctor reports an unparseable Codex version without throwing", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("development", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "invalid_or_prerelease");
});
