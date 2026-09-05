import assert from "node:assert/strict";
import test from "node:test";
import { WARNING_CODES } from "../src/contracts.js";
import { doctorProject } from "../src/doctor.js";
import type { DoctorClient, DoctorRuntime } from "../src/doctor.js";
import { ERROR_CODES } from "../src/errors.js";
import type { ModelCapability } from "../src/profiles.js";

function model(id: string, efforts: string[]): ModelCapability {
  return { id, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) };
}

function fakeClient(version: string, models: ModelCapability[], {
  surface = "cli",
  executable = "codex",
  home = "/tmp/codex"
}: { surface?: string; executable?: string; home?: string } = {}): DoctorClient {
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

function runtime(surface = "cli", executable = "/usr/local/bin/codex"): DoctorRuntime {
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

test("doctor prefers Astra only when its model and required efforts are available", async () => {
  for (const [efforts, expected] of [
    [["low", "medium", "high", "xhigh", "max"], "synod-astra"],
    [["high"], "synod-5.6"],
    [["xhigh"], "synod-5.6"]
  ] as const) {
    const result = await doctorProject({ project: false }, {
      clientFactory: () => fakeClient("0.153.4", [...models56, model("gpt-6-astra", [...efforts])]),
      runtimeResolver: () => runtime()
    });
    assert.equal(result.healthy, true);
    assert.equal(result.recommendedProfile, expected);
  }
});

test("doctor detects a known-good Codex runtime and compatible model profile", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.153.4", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, true);
  assert.equal(result.codex.surface, "cli");
  assert.equal(result.codex.label, "Codex CLI");
  assert.equal(result.codex.executable, "codex");
  assert.equal(result.codex.executableSource, "PATH");
  assert.equal(result.codex.home, "/tmp/codex");
  assert.equal(result.codex.status, "known-good");
  assert.equal(result.recommendedProfile, "synod-5.6");
  assert.equal(result.profiles.find(item => item.id === "synod-5.6")?.compatible, true);
});

test("doctor enforces the Node 22 minimum independently of the host runtime", async () => {
  const results = [];
  for (const nodeVersion of ["20.19.0", "21.9.0", "22.x", "22.0.bad", "22.0.0", "24.12.0"]) {
    results.push(await doctorProject(
      { project: false },
      {
        nodeVersion,
        clientFactory: () => fakeClient("0.153.4", models56),
        runtimeResolver: () => runtime()
      }
    ));
  }

  assert.deepEqual(
    results.map(result => ({
      version: result.node.version,
      supported: result.node.supported,
      range: result.node.range,
      healthy: result.healthy
    })),
    [
      { version: "20.19.0", supported: false, range: ">=22", healthy: false },
      { version: "21.9.0", supported: false, range: ">=22", healthy: false },
      { version: "22.x", supported: false, range: ">=22", healthy: false },
      { version: "22.0.bad", supported: false, range: ">=22", healthy: false },
      { version: "22.0.0", supported: true, range: ">=22", healthy: true },
      { version: "24.12.0", supported: true, range: ">=22", healthy: true }
    ]
  );
});

test("doctor keeps Desktop and CLI versions scoped to their detected surface", async () => {
  let desktopClientOptions: { codexBin: string } | undefined;
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

test("doctor reports validated patches independently for each surface", async () => {
  for (const [version, surface, healthy, reason] of [
    ["0.153.4", "cli", true, "validated_patch"],
    ["0.152.1", "cli", true, "validated_patch"],
    ["0.153.4", "desktop", true, "validated_patch"],
    ["0.152.1", "desktop", false, "surface_version_unvalidated"],
    ["0.153.5", "cli", false, "unvalidated_patch"],
    ["0.153.4-alpha.1", "desktop", false, "unvalidated_patch"],
    ["0.151.0", "cli", false, "below_supported_range"]
  ] as const) {
    const result = await doctorProject({ project: false }, {
      clientFactory: () => fakeClient(version, models56, { surface }),
      runtimeResolver: () => runtime(surface)
    });
    assert.equal(result.healthy, healthy, `${surface} ${version}`);
    assert.equal(result.codex.reason, reason);
    assert.equal(result.codex.policy, "current-and-previous-validated");
    assert.equal(result.profiles.find(item => item.id === "synod-5.6")?.modelCompatible, true);
    assert.equal(result.recommendedProfile, healthy ? "synod-5.6" : null);
  }
});

test("doctor prefers the surface confirmed by the initialized App Server", async () => {
  const result = await doctorProject(
    { project: false },
    {
      clientFactory: () => fakeClient("0.147.0", models56, {
        surface: "desktop",
        executable: "/Applications/ChatGPT.app/Contents/Resources/codex"
      }),
      runtimeResolver: () => runtime("cli", "/Applications/ChatGPT.app/Contents/Resources/codex")
    }
  );

  assert.equal(result.codex.surface, "desktop");
  assert.equal(result.codex.label, "Codex Desktop");
  assert.equal(result.codex.version, "0.147.0");
});

test("doctor fails closed when Desktop is detected but its executable is ambiguous", async () => {
  let clientCreated = false;
  const result = await doctorProject(
    { project: false },
    {
      clientFactory: () => {
        clientCreated = true;
        throw new Error("The PATH fallback must not start");
      },
      runtimeResolver: () => ({
        surface: "desktop",
        executable: "codex",
        executableSource: "PATH-fallback",
        resolved: false
      })
    }
  );

  assert.equal(result.healthy, false);
  assert.equal(clientCreated, false);
  assert.equal(result.codex.version, null);
  assert.equal(result.codex.executable, null);
  assert.ok(result.issues.some(issue => issue.code === ERROR_CODES.CODEX_RUNTIME_AMBIGUOUS));
});

test("doctor fails closed above the tested Codex range", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("0.154.0", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "above_tested_range");
  assert.equal(result.recommendedProfile, null);
  assert.ok(result.profiles.every(profile => profile.compatible === false));
  assert.equal(result.profiles.find(profile => profile.id === "synod-5.6")?.modelCompatible, true);
  assert.ok(result.warnings.some(item => item.code === WARNING_CODES.CODEX_VERSION_UNSUPPORTED));
});

test("doctor reports an unparseable Codex version without throwing", async () => {
  const result = await doctorProject(
    { project: false },
    { clientFactory: () => fakeClient("development", models56), runtimeResolver: () => runtime() }
  );

  assert.equal(result.healthy, false);
  assert.equal(result.codex.reason, "invalid_version");
});
