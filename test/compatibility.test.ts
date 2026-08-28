import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexVersion, CODEX_COMPATIBILITY, compareVersions, parseVersion } from "../src/compatibility.js";

test("classifies the supported disjoint minor lines and rejects gaps", () => {
  assert.equal(
    CODEX_COMPATIBILITY.supported,
    ">=0.148.0-0 <0.149.0 || >=0.150.0-0 <0.151.0 (all 0.148.x and 0.150.x variants)"
  );
  assert.equal(classifyCodexVersion("0.148.0-alpha.9").status, "known-good");
  assert.equal(classifyCodexVersion("0.148.0-alpha.9+ci.1").status, "known-good");
  assert.deepEqual(classifyCodexVersion("0.148.0-alpha.1"), {
    status: "supported",
    reason: "preview_inside_supported_range"
  });
  assert.deepEqual(classifyCodexVersion("0.148.0"), {
    status: "supported",
    reason: "inside_supported_range"
  });
  assert.deepEqual(classifyCodexVersion("0.148.1+ci.1"), {
    status: "supported",
    reason: "inside_supported_range"
  });
  assert.equal(classifyCodexVersion("0.148.10-alpha.6.5").status, "supported");
  assert.deepEqual(classifyCodexVersion("0.150.0-alpha.1"), {
    status: "supported",
    reason: "preview_inside_supported_range"
  });
  assert.deepEqual(classifyCodexVersion("0.150.0"), {
    status: "supported",
    reason: "inside_supported_range"
  });
  assert.deepEqual(classifyCodexVersion("0.150.1+ci.1"), {
    status: "supported",
    reason: "inside_supported_range"
  });
  assert.equal(classifyCodexVersion("0.150.10-alpha.6.5+ci.1").status, "supported");
  assert.equal(classifyCodexVersion("0.147.999").status, "unsupported");
  assert.equal(classifyCodexVersion("0.147.999-alpha.1").status, "unsupported");
  assert.equal(classifyCodexVersion("0.149.0").status, "unsupported");
  assert.equal(classifyCodexVersion("0.149.0-alpha.1").status, "unsupported");
  assert.equal(classifyCodexVersion("0.149.0+ci.1").status, "unsupported");
  assert.equal(classifyCodexVersion("0.149.1").status, "unsupported");
  assert.equal(classifyCodexVersion("0.151.0").status, "unsupported");
  assert.equal(classifyCodexVersion("1.0.0").status, "unsupported");
  assert.equal(classifyCodexVersion("0.148").status, "unsupported");
  assert.equal(classifyCodexVersion("0.148.0-01").status, "unsupported");
  assert.equal(compareVersions("0.147.0", "0.142.0"), 1);
});

test("uses full semantic-version precedence", () => {
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2"), 1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(parseVersion("1.0.0-01"), undefined);
});
