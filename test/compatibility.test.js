import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexVersion, compareVersions } from "../src/compatibility.js";

test("classifies known-good, supported, and unsupported Codex versions", () => {
  assert.equal(classifyCodexVersion("0.142.0").status, "known-good");
  assert.equal(classifyCodexVersion("0.147.0").status, "known-good");
  assert.equal(classifyCodexVersion("0.145.1").status, "supported");
  assert.equal(classifyCodexVersion("0.141.9").status, "unsupported");
  assert.equal(classifyCodexVersion("0.148.0").status, "unsupported");
  assert.equal(classifyCodexVersion("0.147.0-alpha.1").status, "unsupported");
  assert.equal(compareVersions("0.147.0", "0.142.0"), 1);
});
