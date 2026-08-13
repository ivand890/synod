import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import {
  isCorrectionPolicy,
  isTaskLeaseReservation,
  leaseScopesOverlap,
  normalizeLeaseScopePath,
  normalizeLeaseScopes
} from "../src/leases.js";

test("lease reservations validate as a distinct pre-bind authority", () => {
  const reservation = {
    id: "00000000-0000-4000-8000-000000000001",
    token: "00000000-0000-4000-8000-000000000002",
    generation: 1,
    taskId: "T-001",
    taskRevision: 0,
    executor: "synod_implementer",
    scopes: [{ path: "src/task.ts", access: "write", kind: "file" }],
    reservedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-13T00:05:00.000Z",
    ttlSeconds: 300,
    baseline: {
      path: ".synod/lease-baselines.json",
      snapshotContentHash: `sha256:${"a".repeat(64)}`,
      branch: "main",
      head: "b".repeat(40),
      worktreeFingerprint: `sha256:${"c".repeat(64)}`,
      lastEvent: {
        sequence: 2,
        id: "00000000-0000-4000-8000-000000000003",
        hash: `sha256:${"d".repeat(64)}`
      }
    },
    status: "RESERVED"
  };
  assert.equal(isTaskLeaseReservation(reservation), true);
  assert.equal(isTaskLeaseReservation({ ...reservation, token: "not-a-token" }), false);
  assert.equal(isTaskLeaseReservation({ ...reservation, status: "ACTIVE" }), false);
});

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
