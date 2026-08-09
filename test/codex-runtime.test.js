import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexRuntime } from "../src/codex-runtime.js";

test("uses the PATH Codex executable for CLI execution", () => {
  assert.deepEqual(resolveCodexRuntime({
    env: { PATH: "/usr/local/bin:/usr/bin" },
    platform: "linux",
    parentPid: 10,
    inspect: () => undefined,
    findExecutable: () => "/usr/local/bin/codex"
  }), {
    surface: "cli",
    executable: "/usr/local/bin/codex",
    executableSource: "PATH",
    resolved: true
  });
});

test("uses the active Codex CLI process instead of another PATH installation", () => {
  const processes = new Map([
    [30, { parentPid: 20, executable: "/bin/zsh" }],
    [20, { parentPid: 10, executable: "/opt/tools/codex-0.146/bin/codex" }]
  ]);
  const result = resolveCodexRuntime({
    env: { PATH: "/usr/local/bin:/usr/bin" },
    platform: "darwin",
    parentPid: 30,
    inspect: pid => processes.get(pid),
    findExecutable: () => "/usr/local/bin/codex"
  });

  assert.deepEqual(result, {
    surface: "cli",
    executable: "/opt/tools/codex-0.146/bin/codex",
    executableSource: "cli-process",
    resolved: true
  });
});

test("uses the Codex process ancestor for Desktop execution", () => {
  const processes = new Map([
    [30, { parentPid: 20, executable: "/bin/zsh" }],
    [20, { parentPid: 10, executable: "/Applications/ChatGPT.app/Contents/Resources/codex" }]
  ]);
  const result = resolveCodexRuntime({
    env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    platform: "darwin",
    parentPid: 30,
    inspect: pid => processes.get(pid)
  });

  assert.deepEqual(result, {
    surface: "desktop",
    executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
    executableSource: "desktop-process",
    resolved: true
  });
});

test("prefers the Desktop host over a nested CLI process when Desktop is the originator", () => {
  const processes = new Map([
    [40, { parentPid: 30, executable: "/bin/zsh" }],
    [30, { parentPid: 20, executable: "/opt/homebrew/bin/codex" }],
    [20, { parentPid: 10, executable: "/Applications/ChatGPT.app/Contents/Resources/codex" }]
  ]);
  const result = resolveCodexRuntime({
    env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    platform: "darwin",
    parentPid: 40,
    inspect: pid => processes.get(pid)
  });

  assert.equal(result.surface, "desktop");
  assert.equal(result.executable, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(result.executableSource, "desktop-process");
});

test("keeps an explicit executable override scoped to the detected surface", () => {
  assert.deepEqual(resolveCodexRuntime({
    env: {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
      SYNOD_CODEX_BIN: "/custom/codex"
    },
    parentPid: 30,
    inspect: () => undefined
  }), {
    surface: "desktop",
    executable: "/custom/codex",
    executableSource: "SYNOD_CODEX_BIN",
    resolved: true
  });
});

test("marks an unresolved Desktop executable instead of silently treating PATH as Desktop", () => {
  assert.deepEqual(resolveCodexRuntime({
    env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    platform: "darwin",
    parentPid: 30,
    inspect: () => undefined
  }), {
    surface: "desktop",
    executable: "codex",
    executableSource: "PATH-fallback",
    resolved: false
  });
});
