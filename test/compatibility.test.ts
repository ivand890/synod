import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexVersion, CODEX_COMPATIBILITY, compareVersions, parseVersion } from "../src/compatibility.js";

test("maintains two minor lines with exact surface-specific validated patches", () => {
  assert.equal(CODEX_COMPATIBILITY.policy, "current-and-previous-validated");
  assert.equal(CODEX_COMPATIBILITY.currentLine, "0.153");
  assert.equal(CODEX_COMPATIBILITY.previousLine, "0.152");
  for (const version of ["0.153.4", "0.152.1"]) {
    assert.deepEqual(classifyCodexVersion(version, "cli"), { status: "known-good", reason: "validated_patch" });
  }
  assert.equal(classifyCodexVersion("0.153.4", "desktop").status, "known-good");
  assert.equal(classifyCodexVersion("0.152.1", "desktop").reason, "surface_version_unvalidated");
  assert.equal(classifyCodexVersion("0.153.4", "unknown").reason, "surface_unavailable");
  for (const version of ["0.148.0-alpha.9", "0.150.0", "0.151.999", "0.152.0", "0.152.2", "0.153.0", "0.153.3", "0.153.5", "0.154.0", "1.0.0", "0.153.4-alpha.1", "0.153.4+custom", "0.153", "0.153.4-01"]) {
    assert.equal(classifyCodexVersion(version).status, "unsupported", version);
  }
});

test("uses full semantic-version precedence", () => {
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2"), 1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(parseVersion("1.0.0-01"), undefined);
});
