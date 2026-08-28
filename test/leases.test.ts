import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES, SynodError } from "../src/errors.js";
import {
  isCorrectionPolicy,
  isPathLikeLegacyOwnerThread,
  isPlannedLeaseScopes,
  isValidCodexThreadId,
  isTaskLease,
  isTaskLeaseReservation,
  leaseScopesOverlap,
  normalizeLeaseScopePath,
  normalizeLeaseScopes,
  normalizePlannedLeaseScopes
} from "../src/leases.js";
import { bindTaskLease } from "../src/orchestration.js";

test("structured Codex thread IDs require UUIDs while legacy owner labels remain distinguishable", () => {
  const v4 = "11111111-2222-4333-8444-555555555555";
  const v7 = "018f0c5e-7b4a-7abc-8def-0123456789ab";
  assert.equal(isValidCodexThreadId(v4), true);
  assert.equal(isValidCodexThreadId(v7), true);
  assert.equal(isValidCodexThreadId("thread:legacy"), false);
  assert.equal(isValidCodexThreadId("/root/syn_price_sample_impl"), false);
  assert.equal(isPathLikeLegacyOwnerThread("/root/syn_price_sample_impl"), true);
  assert.equal(isPathLikeLegacyOwnerThread("thread:legacy"), false);
});

test("invalid structured thread IDs fail before lease bind mutation", async () => {
  await assert.rejects(
    bindTaskLease({ id: "T-INVALID", threadId: "/root/syn_price_sample_impl" }),
    error => error instanceof SynodError
      && error.code === ERROR_CODES.DELEGATION_INVALID
      && error.message === "Delegation threadId must be an exact Codex thread identifier, not a host label or filesystem path."
  );
});

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

const leaseBaseline = {
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
};

function writerLeaseFixture() {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    generation: 1,
    taskId: "T-001",
    taskRevision: 0,
    ownerThread: "thread:one",
    executor: "synod_implementer",
    scopes: [{ path: "src/task.ts", access: "write", kind: "file" }],
    acquiredAt: "2026-08-13T00:00:00.000Z",
    heartbeatAt: "2026-08-13T00:01:00.000Z",
    expiresAt: "2026-08-13T00:30:00.000Z",
    heartbeatIntervalSeconds: 300,
    ttlSeconds: 1_800,
    baseline: leaseBaseline,
    status: "ACTIVE"
  };
}

test("observer leases validate only with all-read scopes and fail closed otherwise", () => {
  const writer = writerLeaseFixture();
  assert.equal(isTaskLease(writer), true);

  const observer = {
    ...writer,
    id: "00000000-0000-4000-8000-000000000012",
    scopes: [{ path: "src/input.ts", access: "read", kind: "file" }],
    observer: true as const
  };
  assert.equal(isTaskLease(observer), true);
  assert.equal(isTaskLease({ ...observer, observer: undefined }), false);
  assert.equal(isTaskLease({ ...writer, observer: false }), false);
  assert.equal(isTaskLease({ ...writer, observer: "true" }), false);
  assert.equal(isTaskLease({
    ...observer,
    scopes: [...observer.scopes, { path: "src/task.ts", access: "write", kind: "file" }]
  }), false);
});

test("observer reservations follow the same fail-closed validator matrix", () => {
  const reservation = {
    id: "00000000-0000-4000-8000-000000000001",
    token: "00000000-0000-4000-8000-000000000002",
    generation: 1,
    taskId: "T-001",
    taskRevision: 0,
    executor: "synod_implementer",
    scopes: [{ path: "src/input.ts", access: "read", kind: "file" }, { path: "src/docs", access: "read", kind: "tree" }],
    observer: true as const,
    reservedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-13T00:05:00.000Z",
    ttlSeconds: 300,
    baseline: leaseBaseline,
    status: "RESERVED"
  };
  assert.equal(isTaskLeaseReservation(reservation), true);
  assert.equal(isTaskLeaseReservation({
    ...reservation,
    scopes: [{ path: "src/input.ts", access: "read", kind: "file" }],
    observer: undefined
  }), false);
  assert.equal(isTaskLeaseReservation({
    ...reservation,
    scopes: [{ path: "src/task.ts", access: "write", kind: "file" }]
  }), false);
  assert.equal(isTaskLeaseReservation({ ...reservation, observer: false }), false);
  assert.equal(isTaskLeaseReservation({ ...reservation, observer: 1 }), false);
});

test("observer scope normalization accepts all-read sets only when explicitly requested", () => {
  assert.deepEqual(normalizeLeaseScopes(
    { read: ["src/b.ts"], readTree: ["src/a"] },
    { observer: true }
  ), [
    { path: "src/a", access: "read", kind: "tree" },
    { path: "src/b.ts", access: "read", kind: "file" }
  ]);
  for (const candidate of [
    () => normalizeLeaseScopes({ read: ["src/a.ts"], write: ["src/b.ts"] }, { observer: true }),
    () => normalizeLeaseScopes({ writeTree: ["src"] }, { observer: true }),
    () => normalizeLeaseScopes({}, { observer: true }),
    () => normalizeLeaseScopes({ read: ["README.md"] })
  ]) {
    assert.throws(candidate, error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID);
  }
});

test("planned implementer scopes reuse lease normalization and require a writer lane", () => {
  assert.deepEqual(normalizePlannedLeaseScopes([
    { path: "src/read.ts", access: "read", kind: "file" },
    { path: "src/write", access: "write", kind: "tree" }
  ]), [
    { path: "src/read.ts", access: "read", kind: "file" },
    { path: "src/write", access: "write", kind: "tree" }
  ]);
  const readOnly = [{ path: "docs", access: "read", kind: "tree" }];
  assert.throws(
    () => normalizePlannedLeaseScopes(readOnly),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
  );
  assert.equal(isPlannedLeaseScopes(readOnly), false);
  assert.equal(isPlannedLeaseScopes([]), false);
  assert.equal(isPlannedLeaseScopes([
    { path: "src", access: "write", kind: "tree" },
    { path: "src/file.ts", access: "write", kind: "file" }
  ]), false);
  assert.throws(
    () => normalizePlannedLeaseScopes([{ path: "../outside", access: "write", kind: "file" }]),
    error => error instanceof SynodError && error.code === ERROR_CODES.LEASE_INVALID
  );
});
