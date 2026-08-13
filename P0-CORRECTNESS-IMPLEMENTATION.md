# Synod P0 Correctness Implementation Backlog

Prepared: 2026-08-13

Baseline: `v0.9.0` (`919e51c7d397c1ffd13e3b254de7c659f36357cc`)

Evidence session: EventPass root
`019fe6df-9c89-71b0-8738-5c610b7ece86`

Scope: eliminate the pre-lease writer window and correct the released `usage`
semantics before task budgets or coordination outcomes are treated as reliable.

## Readiness decision

The P0 work is ready to implement from the released `v0.9.0` baseline. The
current code confirms both reported root causes:

- `lease acquire` requires the worker's `ownerThread`, but Codex reveals that
  identity only after `spawn_agent` has started the worker;
- `usage --task` resolves a canonical task interval, then independently selects
  the newest root session in the project when `--session` is absent;
- the coordination parser maps any `timed_out:true` output to failure before it
  knows that the call was a normal `wait_agent` no-change result;
- `total.threads` counts every selected descendant even when only a subset has
  an in-range token delta;
- a call that starts before a closed canonical end but completes after it is
  retained as an output-less call, making a causally terminal interval appear
  incomplete.

No production dependency is required. Do not combine this P0 with adaptive
waiting, automatic rotation, typed MCP commands, or event-log compaction.

## Fixed decisions

### 1. Use an explicit reservation, not relaxed fencing

Add a two-phase protocol:

1. `lease reserve <task>` reserves paths and captures the immutable baseline
   before spawning a worker. It returns an opaque reservation token plus the
   exact lease ID, generation, task revision, reservation timestamp, and
   expiry.
2. The initial worker contract contains the reservation handle and a hard
   instruction to remain read-only until the supervisor confirms binding.
3. `lease bind <task> --reservation-token ... --owner-thread ...` validates the
   exact reservation and atomically binds the spawned thread while moving the
   task to `ACTIVE`.
4. `lease cancel` removes an unbound reservation after a failed spawn. An
   expired reservation is removed without creating abandoned-worker recovery,
   because it never authorized a writer.

Keep `lease acquire` for callers that already have an owner thread. Do not make
`ownerThread` nullable and do not use a synthetic owner inside an ordinary
active lease. A reservation is a distinct canonical type and never grants
write authority.

Persisting that distinction requires the next orchestration schema. Use schema
4 for the P0 reservation field and preserve the complete schema-3 event prefix
byte for byte. The previously proposed delta event log is deferred and must use
a later schema; safe ownership semantics take precedence over reserving a
version number for a P2 optimization.

### 2. Fail closed for task reports without a session

Until a task has a canonical root-session binding, `usage --task <id>` requires
`--session <root-or-descendant-id>`. Do not silently choose the latest project
session, even when only one happens to be visible at capture time.

This is intentionally narrower than adding task/session persistence. Budgets
and rotations already carry explicit root-session identities. A future atomic
delegation surface may persist a task execution session, but the P0 correction
does not invent or backfill one.

### 3. Make coordination outcomes tool-aware

Replace the internal boolean-only result with a normalized outcome taxonomy:

- `succeeded`: explicit successful output;
- `no-change`: a valid `wait_agent` result with `timed_out:true`;
- `timed-out`: a real timeout from a tool for which timeout is failure;
- `failed`: explicit error, non-zero exit, failure status, or a plain-text
  validation error from a coordination tool;
- `unknown`: the persisted output does not carry enough evidence.

Keep the released additive `failed` count, but count only actual failures in
it. Add the other observed outcome counts without retaining output text. A
plain `wait_agent` output such as `timeout_ms must be at least 10000` is a
failure; the structured `{"message":"Wait timed out.","timed_out":true}` result
is no-change.

### 4. Separate discovered and contributing threads

Report both:

- `discoveredThreads`: descendants whose creation time makes them part of the
  selected session interval;
- `contributingThreads`: selected threads with at least one non-zero token
  delta in the interval.

Keep `total.threads` as a deprecated compatibility alias for
`contributingThreads`, matching the already released per-model and per-role
thread-count semantics. Retain zero-token thread rows for rollout provenance
and coordination attribution. Text output must show both named counts instead
of one ambiguous total.

### 5. Exclude unprovable cross-boundary calls explicitly

For an exact canonical interval, include a tool call in duration and outcome
metrics only when both its start and paired output fall inside `(start,end]`.
Report calls that cross either boundary under
`coordination.boundary.crossingCalls`; do not strip the output and then label
the call missing. When the paired output occurs after the canonical end, retain
a separate content hash and byte prefix through that output as boundary
evidence. The canonical interval prefix remains unchanged, while the extra
identity makes the exclusion reproducible without counting post-end activity.

A closed interval with fully parsed crossing calls may remain complete because
the exclusion rule is explicit. Those calls are not assigned to either
adjacent exact interval, so summing interval call counts is not guaranteed to
equal a whole-session report. Causal attribution can replace this rule only
after Synod has a persisted event-to-tool-call identity; timestamp proximity is
not enough.

## Safety invariants

- A reservation reserves write scopes against active leases, other
  reservations, pending recovery generations, and sealed proposals.
- A reserved worker has no command path that can heartbeat, create a worktree,
  deliver a proposal, or transition to `ACTIVE` before a successful bind.
- Bind is one-shot and fenced by reservation token, lease ID, generation, task
  revision, expected reservation timestamp, expiry, and current reservation
  identity.
- Bind rechecks dependencies, correction allowance, token-budget authority,
  checkpoint identity, path safety, and reservation expiry under the existing
  orchestration lock.
- Bind preserves the reservation's baseline, lease ID, and generation; it
  resets the heartbeat/expiry clock for the active lease and records one
  hash-chained `lease.bound` event.
- Bind performs the current correction transition effects atomically: correction
  usage increments where applicable, prior acceptance/verification resets, and
  a stale proposal cannot survive reactivation.
- Cancel or pre-bind expiry removes the reservation and its unneeded baseline
  without creating a proposal, recovery decision, correction round, or task
  state change.
- Revocation/expiry after bind retain the released abandoned-worker recovery
  semantics.
- Usage remains read-only and never mutates canonical state, Git, rollouts, or
  Codex threads.
- Usage facts and reports never retain prompts, messages, reasoning, tool
  arguments, tool outputs, or error strings.
- Exact reports continue to fail closed on malformed records, duplicate call
  identities, negative durations, missing rollouts, timestamp regressions, and
  ambiguous thread identities.
- No command stages, commits, pushes, deploys, publishes, spends provider
  quota, or adds a dependency implicitly.

## Executable backlog

### P0-A1: Add schema-4 lease reservations

Depends on: `v0.9.0`

Primary files:

- `src/leases.ts`
- `src/orchestration.ts`
- `src/errors.ts`
- `test/leases.test.ts`
- `test/orchestration.test.ts`
- `test/lifecycle.test.ts`

Implementation:

- Add a validated `TaskLeaseReservation` carrying a random token, lease
  identity/generation, task revision, executor, normalized scopes, reservation
  timestamps, expiry, and the same immutable baseline reference required by an
  active lease.
- Add optional `leaseReservation` to schema-4 tasks and enforce mutual
  exclusion with `lease`, proposal-preserving recovery, and ineligible states.
- Migrate schema 3 to 4 by appending one `orchestration.migrated` event; create
  no reservation and rewrite no prior event byte.
- Include reservations in path collision detection, baseline retention,
  status, handoff, `check`, upgrade, uninstall preservation, and pending
  mutation recovery.
- Distinguish active lease expiry candidates from unbound reservation expiry
  candidates in text and JSON.

Acceptance:

- Fresh schema-4 state and migrated schema-3 state validate deterministically.
- Downgrade, skipped/duplicate migration boundaries, schema-3 events after the
  boundary, tampered tokens, and state/log mismatches fail closed.
- Migration preserves the exact schema-3 event prefix and does not invent
  ownership or change any task state.
- Two overlapping reservations cannot commit concurrently; disjoint
  reservations can coexist.

### P0-A2: Implement reserve, bind, cancel, and pre-bind expiry

Depends on: P0-A1

Primary files:

- `src/orchestration.ts`
- `src/leases.ts`
- `src/command-options.ts`
- `src/cli.ts`
- `src/local-runtime.ts`
- `test/leases.test.ts`
- `test/cli.test.ts`
- `test/local-runtime.test.ts`

Implementation:

- Add `lease reserve`, accepting the existing read/write file/tree scopes plus
  a bounded reservation TTL. Reuse the current snapshot, pre-existing drift,
  collision, correction, and budget checks.
- Return a stable JSON handle containing `writeAuthorized:false`, the token,
  lease ID, generation, task revision, reservation timestamp, baseline
  identity, and expiry.
- Add `lease bind`, requiring the complete reservation fence and owner thread.
  Accept active lease TTL/heartbeat policy at bind time and transition the task
  to `ACTIVE` in the same canonical mutation.
- Return `writeAuthorized:true`, the active lease fence, and the resulting task
  state. A second bind, wrong token, stale reservation timestamp, task
  revision, generation, expired reservation, or moved task fails without
  mutation.
- Add `lease cancel` for failed spawn and define `lease expire` on an unbound
  reservation as cleanup rather than abandoned-worker recovery. Reject
  `heartbeat`, `release`, `revoke`, worktree creation, proposal delivery, and a
  direct `task transition ... ACTIVE` while only a reservation exists.
- Preserve `lease acquire` and current post-bind recovery behavior.

Acceptance:

- The worker can be spawned only after scopes are durably reserved, and no
  Synod mutation authorizes it to write until bind has committed.
- Spawn failure has a deterministic cleanup path with no false recovery task.
- Interruption before or during reserve/bind/cancel recovers through the
  existing pending-mutation journal without duplicating a generation or losing
  a baseline.
- Bind from `READY`, and bounded correction bind from `REVIEW`, `ACCEPTED`, or
  `VERIFIED`, reproduce the released transition semantics exactly.
- A budget hard-decision appearing between reserve and bind prevents bind.

### P0-A3: Change the generated delegation protocol

Depends on: P0-A2

Primary files:

- `templates/_AGENTS.block.md`
- `templates/.agents/skills/synod-advisor/SKILL.md`
- `templates/docs/synod/PLAN.md`
- `README.md`
- `CHANGELOG.md`
- `test/init.test.ts`
- `test/lifecycle.test.ts`
- `scripts/package-smoke.ts`

Implementation:

- Replace acquire-after-spawn guidance with the exact reserve, spawn, bind,
  authorize sequence.
- Require the initial child contract to say that analysis may begin but writes,
  worktrees, and implementation commands must wait for the supervisor's bind
  confirmation.
- Document cancel/expiry recovery for a spawn that never returns an owner ID.
- Document that Synod CLI cannot invoke Codex `spawn_agent`; `delegate start`
  remains deferred until a typed integration can perform both sides of the
  handshake.
- Update generated-file hashes and lifecycle migrations through the normal
  template machinery.

Acceptance:

- Fresh installs and upgrades render the new protocol without replacing
  unrelated user guidance.
- Installed package smoke demonstrates reserve before a simulated spawn, bind
  to the returned owner, active work, delivery, and cleanup.
- Existing explicit `lease acquire` documentation remains available for an
  already-known worker identity.

### P0-B1: Normalize tool-aware outcomes

Depends on: `v0.9.0`; independent of P0-A

Primary files:

- `src/coordination.ts`
- `src/usage.ts`
- `test/coordination.test.ts`
- `test/usage.test.ts`

Implementation:

- Preserve only non-content outcome signals while parsing output records, then
  classify them after pairing with the call name/category.
- Recognize the valid structured `wait_agent` no-change shape separately from
  genuine tool timeout or failure signals.
- Recognize validated, content-free success shapes for each coordination tool.
  Treat plain output as failure only for tools whose valid results are
  structured (including `wait_agent`); historical plain acknowledgements from
  `followup_task` and `send_message` remain `unknown` because their content is
  not retained and cannot prove success or failure.
- Add succeeded, no-change, timed-out, failed, unknown, observed, and missing
  counts with the existing availability status.
- Keep duration and retry availability independent from outcome availability.

Acceptance:

- The sanitized pilot fixtures classify normal wait expiry as no-change and
  `timeout_ms must be at least 10000` as failed.
- The 534 valid EventPass no-change waits no longer appear in `failed`.
- The seven invalid wait timeout arguments appear as failures.
- No normalized fact, JSON report, text report, warning, diagnostic, or hash
  contains the original output text.

### P0-B2: Require task session identity and split thread counts

Depends on: P0-B1

Primary files:

- `src/usage.ts`
- `src/command-options.ts`
- `src/cli.ts`
- `src/errors.ts`
- `src/budgets.ts`
- `src/costs.ts`
- `src/rotation.ts`
- `test/usage.test.ts`
- `test/cli.test.ts`
- `test/budgets.test.ts`
- `test/costs.test.ts`
- `test/rotation.test.ts`

Implementation:

- Reject `--task` without `--session` using one stable usage-specific error and
  a message that names the required remediation.
- Continue accepting a descendant session selector by resolving it to its root;
  preserve the selected root in report provenance.
- Add `discoveredThreads` and `contributingThreads`; set the deprecated
  `total.threads` alias to the latter.
- Keep all selected thread rows and rollout-prefix identities, including rows
  with zero in-range token deltas.
- Update text formatting, usage report hashing, cost validation, budgets, and
  rotation fixtures for the additive fields and corrected alias.

Acceptance:

- With multiple roots in one project, `usage --task` without `--session` fails
  before measuring the latest root.
- With the EventPass root explicitly selected, the R1-06 task report does not
  resolve to the later Synod upgrade session.
- The R1-05 regression reports 38 discovered threads and 3 contributing
  threads rather than presenting 38 as token contributors.
- Whole-session `usage` without a task selector retains the released latest-root
  behavior and remains explicitly incomplete.
- Budget and rotation collectors remain valid because they already pass an
  explicit root session.

### P0-B3: Define exact coordination boundary exclusion

Depends on: P0-B1

Primary files:

- `src/coordination.ts`
- `src/usage.ts`
- `test/coordination.test.ts`
- `test/usage.test.ts`

Implementation:

- Pair complete rollout calls first, then include only pairs fully contained in
  a closed exact interval.
- Count starts-before/ends-after cases in additive boundary metrics by thread,
  role, and total without retaining arguments or outputs.
- Do not mark a fully observed crossing call as output-missing.
- Preserve the canonical-end rollout prefix hash and add a separate boundary
  evidence byte length/SHA-256 through any post-end output used to prove an
  exclusion. Post-end tokens and calls remain outside interval activity.
- Include the boundary evidence identity in report hashing. If a crossing call
  has no paired output in the observed rollout, keep the report incomplete.
- Document that whole-session calls are not necessarily the sum of adjacent
  exact intervals until causal event/call identities exist.

Acceptance:

- A terminal Synod mutation whose shell/tool output arrives after the `DONE`
  event yields a complete closed task report with one explicit crossing call,
  not `tool-call-output-missing`.
- A genuinely missing output inside the interval still makes the report
  incomplete.
- Duplicate outputs, cross-thread pairs, negative durations, and malformed
  prefix records still fail closed.
- Re-reading unchanged closed rollouts produces the same interval, counts,
  boundary metrics, prefix bytes, and hashes.

### P0-C: Integrated regression and release closure

Depends on: P0-A3, P0-B2, P0-B3

Primary files:

- `README.md`
- `CHANGELOG.md`
- `ROADMAP.md`
- `scripts/package-smoke.ts`
- `.github/workflows/*` only if an existing matrix requires adjustment

Implementation:

- Add sanitized regression fixtures derived from the EventPass records rather
  than copying prompts, tool arguments, or project content.
- Run the built local package against the immutable audited session with an
  explicit EventPass root and compare only the named P0 semantics.
- Exercise schema-3 to schema-4 upgrade and reserve/bind through an installed
  tarball on the supported Node/platform matrix.
- Update the roadmap only after implementation fixes the exact contracts; do
  not mark the increment delivered before merge and release proof.

Acceptance gates:

1. `pnpm test`
2. `pnpm test:package`
3. `pnpm test:codex-compatibility` in the existing CI matrix with all required
   `SYNOD_EXPECTED_*` values
4. `git diff --check`
5. Installed schema-3 upgrade preserves prior event bytes and produces valid
   schema-4 state, status, handoff, recovery, and uninstall behavior.
6. A concurrency fixture proves that a worker cannot obtain active write
   authority before bind and that only one overlapping reservation commits.
7. EventPass replay proves normal wait expiry, invalid wait failure, explicit
   task session selection, discovered/contributing counts, and closed-boundary
   behavior without writing to EventPass canonical state.
8. No production dependency is added.
9. If a PR targets the production branch, request Codex review and address its
   actionable comments, with at most three review turns.
10. Release proof, if separately authorized, follows reviewed merge, signed
    immutable tag, protected npm publication approval, npm/GitHub `gitHead`,
    provenance, Latest release, and public installed CLI smoke.

## Delivery order

1. Land P0-A1/A2 with schema migration and orchestration tests.
2. Land P0-A3 so newly generated projects use the safe handshake.
3. Land P0-B1/B3 together because boundary completeness depends on the new
   outcome model.
4. Land P0-B2 and update budget/cost/rotation compatibility projections.
5. Run P0-C as one independent regression and release-readiness pass.

Lease and usage work may be reviewed as separate PRs, but do not publish a
release that contains only the new delegation instructions without the runtime
reserve/bind commands. The usage fixes may ship independently if their complete
regression and compatibility gates pass.

## Explicit non-goals

- Changing explorer, implementer, reviewer, verifier, or supervisor models.
- Implementing `delegate start` without a typed Codex integration capable of
  spawning and returning an owner thread.
- Replacing `synod wait` or automatically suppressing supervisor wakeups.
- Enabling budgets or rotation policies silently in existing projects.
- Adding an MCP server or other production dependency.
- Changing correction limits or weakening lease/path/revision fencing.
- Persisting task root-session identity or backfilling it from historical chat.
- Rewriting the event log as deltas, changing checkpoint identity, or deleting
  historical event bytes.
- Treating token activity as a provider invoice or claiming savings from these
  correctness fixes alone.
- Starting implementation, opening a PR, publishing, or deploying as part of
  this preparation artifact.

## Baseline verification recorded during preparation

- `pnpm test`: passed on `v0.9.0` at `919e51c`.
- `pnpm test:package`: passed, including installed-package initialization,
  local runtime delegation, recovery restore, and package smoke.
- Standalone `pnpm test:codex-compatibility`: intentionally refused to run
  without the CI-provided `SYNOD_EXPECTED_CODEX_VERSION`,
  `SYNOD_EXPECTED_CODEX_STATUS`, and `SYNOD_EXPECTED_DOCTOR_HEALTHY` values; the
  implementation gate above requires the configured matrix invocation.
- Worktree before preparation: `main` matched `origin/main`; the pre-existing
  untracked `V0.8-IMPLEMENTATION.md` was left untouched.
