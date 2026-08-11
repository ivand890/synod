import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import {
  isCorrectionPolicy,
  leaseScopesOverlap,
  normalizeLeaseScopePath,
  normalizeLeaseScopes
} from "../src/leases.js";

test("historical over-limit correction policies remain readable", () => {
  assert.equal(isCorrectionPolicy({ limit: 2, used: 3, overrides: [] }), true);
});

test("lease scope normalization rejects administrative and non-portable aliases", () => {
  for (const candidate of [
    "",
    ".",
    "..",
    "../outside.ts",
    "/absolute.ts",
    ".git",
    ".git/index",
    ".synod",
    ".synod/state.json",
    "src/\0.ts",
    "src/e\u0301.ts",
    "src/CON",
    "src/trailing.",
    "src/trailing ",
    "src/a:b.ts",
    "src/",
    "src\\windows.ts",
    "src/../outside.ts"
  ]) {
    assert.throws(
      () => normalizeLeaseScopePath(candidate),
      error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
    );
  }
});

test("lease scopes are deterministic and require at least one writer", () => {
  assert.deepEqual(normalizeLeaseScopes({
    read: ["README.md", "README.md"],
    write: ["src/task.ts", "src/task.ts"]
  }), [
    { path: "README.md", access: "read", kind: "file" },
    { path: "src/task.ts", access: "write", kind: "file" }
  ]);
  assert.throws(
    () => normalizeLeaseScopes({ read: ["README.md"] }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
  );
  assert.deepEqual(normalizeLeaseScopes({
    read: ["src/input.ts"],
    writeTree: ["src/output"]
  }), [
    { path: "src/input.ts", access: "read", kind: "file" },
    { path: "src/output", access: "write", kind: "tree" }
  ]);
  assert.throws(
    () => normalizeLeaseScopes({ write: ["src/Task.ts"], read: ["src/task.ts"] }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
  );
  assert.throws(
    () => normalizeLeaseScopes({ writeTree: ["src"], write: ["src/task.ts"] }),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
  );
});

test("tree collisions are component-aware while readers may overlap writers", () => {
  const tree = { path: "src/a", access: "write" as const, kind: "tree" as const };
  assert.equal(leaseScopesOverlap(tree, { path: "src/a/file.ts", access: "write", kind: "file" }), true);
  assert.equal(leaseScopesOverlap(tree, { path: "src/ab/file.ts", access: "write", kind: "file" }), false);
  assert.equal(leaseScopesOverlap(tree, { path: "src/a/file.ts", access: "read", kind: "file" }), false);
  assert.equal(leaseScopesOverlap({ path: "src/a/file.ts", access: "write", kind: "file" }, tree), true);
  assert.equal(leaseScopesOverlap(
    { path: "src/Task.ts", access: "write", kind: "file" },
    { path: "src/task.ts", access: "write", kind: "file" }
  ), true);
});
