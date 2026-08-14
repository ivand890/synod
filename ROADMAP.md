# Synod Roadmap

Last updated: 2026-08-14
Current source release: `v0.9.3`
Last verified public release at this update: `v0.9.2`

This roadmap converts the advisor loop's remaining operational risks into
versioned, testable increments. Entries at or below the last verified public
release are delivered. Later increments describe intended outcomes, not shipped
commands. Exact CLI spelling remains provisional until an increment is
implemented and released. The current source version may be ahead of the last
verified public package; this roadmap does not claim publication for that
source version.

The `v0.9.1` release delivered pre-spawn lease reservations and corrected
task-session, thread-count, coordination-outcome, and exact-boundary usage
semantics. The `v0.9.1` release is publicly delivered. The `v0.9.2` release
includes the supervisor-efficiency P1—task-aware waiting, adaptive rotation
preflight, and typed task/proposal commands—plus bounded summary output,
activation-handoff, and nested-help hardening. Its reviewed merge, signed tag,
npm/GitHub publication, installed-package proof, and CLI proof are verified.

## Evidence behind this revision

A production-scale, multi-phase pilot validated Synod's review model while also
exposing the next constraints:

- Independent review and exact-revision verification caught real isolation,
  privacy, atomicity, concurrency, and browser-integration defects before tasks
  reached `DONE`.
- Canonical checkpoints preserved the accepted content identity across a long
  dirty worktree, but the accepted work remained on an unchanged Git `HEAD`.
  A fingerprint proves what was reviewed; it does not by itself provide a
  portable recovery artifact.
- A 23-thread snapshot reported 329.8 million cumulative tokens, of which 97.6%
  of input was cached. The tree also accumulated 329 supervisor wait calls and
  14 context compactions. These are observability signals, not billing
  estimates, and show that marginal task usage and coordination overhead matter
  more than another aggregate total.
- User-owned state notes lagged the canonical task state after a phase change.
  Generated handoff context must come from `.synod/state.json` and the event
  log, rather than depending on manually synchronized prose.
- The single-writer convention prevented overlapping mutations, but ownership,
  interruption recovery, and correction-round limits were still enforced by
  agent instructions rather than durable leases.

The resulting order was: a behavior-preserving TypeScript 7 foundation,
recoverability, concurrency control, and then economics/adaptive orchestration.

## Product principles

1. Prefer observable and recoverable contracts over adding agent roles.
2. Keep Git and observed runtime behavior as technical truth.
3. Never interpret `DONE` as committed, pushed, deployed, or operationally
   approved unless separate evidence proves those states.
4. Keep orchestration local-first. No checkpoint, lease, or usage command may
   stage, commit, push, deploy, or transmit telemetry implicitly.
5. Fail closed on corrupted state, unsafe paths, ambiguous ownership, stale
   revisions, and incomplete recovery material.
6. Treat usage as measured token activity. Monetary estimates remain optional,
   dated, and explicitly configured.

## Pre-v0.7 foundation — TypeScript 7 source migration

Goal: migrate Synod's JavaScript implementation to strict TypeScript 7 without
changing its CLI, runtime, package, security, or orchestration behavior. The
migration is a prerequisite for new roadmap features, not a feature delivery of
its own.

Status: delivered in `v0.6.3`.

The supported runtime remains Node 20/22/24. Synod will publish compiled ESM
JavaScript and keep a minimal JavaScript `bin/synod.js` shim; consumers will not
need TypeScript and no production dependency will be added. Source imports keep
their explicit `.js` specifiers under `module: NodeNext`.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-069A | Establish the TS 7 checking baseline | `v0.6.2` | Pin TypeScript 7 and Node 20 types as development dependencies; add an ES2022/NodeNext config with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and explicit `types: ["node"]`; run `allowJs` + `checkJs` + `noEmit` over the existing JavaScript before renaming files; current tests, JSON envelopes, exit codes, and package smoke remain unchanged. |
| SYN-069B | Migrate contracts and leaf modules | SYN-069A | Convert package metadata helpers, errors, envelopes, compatibility, profiles, command options, filesystem, manifest, templates, and migrations first; public data structures use explicit types or discriminated unions; no unchecked cast substitutes for runtime validation. |
| SYN-069C | Migrate integration and lifecycle modules | SYN-069B | Convert App Server, usage, doctor, Codex runtime, local runtime, and lifecycle modules; external process output and parsed JSON enter as `unknown` and pass existing or stronger validators; timeout, cleanup, rollback, symlink, and cross-platform behavior remains equivalent. |
| SYN-069D | Migrate orchestration, CLI, tests, and scripts | SYN-069C | Convert canonical state/events, recovery transactions, CLI routing, tests, and release scripts; state transitions and events are exhaustively typed; enable `exactOptionalPropertyTypes` only after the initial strict migration is green and resolve every intentional absent-versus-`undefined` distinction explicitly. |
| SYN-069E | Switch the installed package to compiled output | SYN-069D | Compile TypeScript sources into a clean `dist` tree, retain only a stable JavaScript executable shim, and build before packing; audit the current deep-import/package surface before changing paths; an installed tarball passes every CLI contract on Node 20/22/24 and package smoke on Ubuntu, macOS, and Windows without shipping or loading TypeScript at runtime. |

Foundation gate: the compiled package must be behaviorally indistinguishable
from the `v0.6.2` baseline for supported commands, text/JSON output, exit status,
filesystem mutations, recovery, and installed runtime delegation. The migration
must land separately from `v0.7` product behavior, and each slice must keep the
full regression suite and `git diff --check` green.

## v0.7 — Recoverable phase boundaries

Goal: make every accepted phase portable and independently verifiable without
requiring the original chat transcript or mutable working directory.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-070 | Explain checkpoint delta | SYN-069E | Text and JSON distinguish staged, unstaged, untracked, deleted, renamed, and binary paths since the acknowledged checkpoint without changing Git or Synod state. |
| SYN-071 | Export a local recovery bundle | SYN-070 | An explicit export captures the base branch/HEAD, state/event identity, tracked patch material, and opt-in untracked files; ignored files and unsafe path traversal fail closed; Git index, commits, refs, and remotes remain untouched. |
| SYN-072 | Verify and restore a bundle | SYN-071 | A fresh checkout can verify hashes and reconstruct the exported relevant-worktree fingerprint. Missing, extra, corrupted, conflicting, or wrong-base material is rejected before mutation, and a failed restore rolls back. |
| SYN-073 | Generate a canonical handoff | SYN-070 | A generated text/JSON handoff reports the latest checkpoint, live drift, active task, last accepted revision/evidence, unresolved approval gates, legal next transitions, and recovery-bundle reference using canonical state rather than user-owned notes. |
| SYN-074 | Cross-platform recovery contract | SYN-071, SYN-072, SYN-073 | Fixtures cover mixed staged/unstaged/untracked changes, renames, deletions, binary files, unsafe symlinks, interruption, and corruption on Node 20/22/24 plus installed-package smoke on Ubuntu, macOS, and Windows. |

Release gate: a deliberately dirty fixture can be exported, removed, restored
in a fresh checkout, and matched to the exact recorded fingerprint without an
implicit Git or network mutation.

## v0.8 — Durable ownership and interruption recovery

Goal: enforce the one-writer rule and make delegated execution recoverable
across worker failure, supervisor interruption, and optional isolated
worktrees.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-080 | Durable writer leases | v0.7 | A task lease records task revision, owner thread, allowed paths, acquisition time, heartbeat/expiry policy, and release/revocation events. A second writer is rejected deterministically. |
| SYN-081 | Path ownership enforcement | SYN-080 | Overlapping write scopes are detected before delegation; read-only scopes may coexist; writes outside the lease are reported as drift and cannot be accepted silently. |
| SYN-082 | Abandoned-worker recovery | SYN-080, SYN-073 | A resumed supervisor can inspect an expired owner's exact delta, choose resume/reassign/supersede, and preserve the proposal without accepting or discarding it implicitly. Clock skew and stale-owner races are tested. |
| SYN-083 | Enforced correction policy | SYN-080 | Configurable correction limits live in canonical task state. Exhaustion requires an explicit split, supersede, or approved override event instead of another silent round. |
| SYN-084 | Change-driven waiting | SYN-080 | Where Codex exposes status cursors, coordination waits for a child-state change instead of busy polling; bounded fallback remains available and wait count/duration are observable. No process handle survives cleanup. |
| SYN-085 | Optional isolated worktrees | SYN-081, SYN-082 | Explicit task worktrees preserve branch/base identity, refuse ambiguous dirty-base integration, and return reviewed changes through a verifiable integration step. Creation and cleanup are recoverable and never delete user work. |
| SYN-086 | State and event migration | SYN-080–SYN-085 | Existing schema-1 projects migrate explicitly; downgrade is rejected; lock, lease, recovery, and worktree events remain hash-chain validated and uninstall-preserved. |

Release gate: two attempted writers cannot mutate the same scope, and a killed
worker can be recovered or reassigned without losing its proposal or advancing
task acceptance.

## v0.9 — Marginal economics and adaptive orchestration

Goal: show where a task spends context and coordination, then use that evidence
to recommend smaller phases without conflating token counts with money.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-090 | Usage since event/checkpoint/task | v0.8 | Usage reports marginal input, cached input, output, reasoning, and totals by thread/model/role for an exact canonical interval; counter resets and model reroutes cannot double count. |
| SYN-091 | Coordination overhead report | SYN-090 | Reports spawn, follow-up, wait, tool-call, retry, and compaction counts/durations separately from implementation activity. Active-session snapshots are labelled incomplete. |
| SYN-092 | Local task budgets | SYN-090 | Optional soft limits warn and hard limits require an explicit supervisor decision. Limits never forge `BLOCKED`, acceptance, verification, or completion state. |
| SYN-093 | Phase-rotation recommendation | SYN-073, SYN-091 | Configurable thresholds for supervisor context, compactions, waits, and completed tasks produce a canonical handoff recommendation; rotation is explicit and the new session verifies state before continuing. |
| SYN-094 | Optional cost estimates | SYN-090 | Estimates are disabled by default, require dated user-supplied prices, preserve raw token evidence, and clearly separate cached/input/output assumptions. |

Release gate: a multi-task fixture can attribute marginal usage and coordination
overhead without double counting, then produce a reproducible phase-handoff
recommendation while leaving orchestration state unchanged.

## v0.9.2 — Supervisor-efficiency P1 and bounded hardening

Goal: reduce routine supervisor coordination while preserving exact canonical
state, independent review, and strict lease fencing.

Status: delivered; reviewed merge, signed tag, npm/GitHub publication,
installed-package proof, and CLI proof are verified.

| ID | Outcome | Acceptance gate |
|---|---|---|
| SYN-P1-WAIT-001 | Task-aware repeatable waiting resolves canonical bound owners, preserves exact lease identity, and reports honest host fallback. | Mixed task/thread waits remain bounded, read-only, and compatible with explicit thread selectors. |
| SYN-P1-ROTATE-002 | Read-only adaptive rotation preflight returns deterministic thresholds and typed actions without configuring or preparing rotation. | Configured and unconfigured projects return the legal next action without changing canonical state. |
| SYN-P1-TYPED-003 | `task next --json` and `proposal submit` expose canonical legal actions and reuse the existing ACTIVE-to-REVIEW proposal transition. | Guidance never advertises stale or invalid lease/reservation transitions and proposal submission derives the current fence. |
| SYN-092-OUTPUT-001 | Opt-in summary JSON materially reduces routine output while full JSON remains the default and exact fences are retained. | Status, mutation, wait, handoff, and usage views remain schema-compatible and read-only. |
| SYN-092-ACTIVATE-002 | Bind returns an activation handoff tied to the existing `lease.bound` event without claiming supervisor notification. | The receipt exposes a typed task-aware wait follow-up and no reservation token. |
| SYN-092-HELP-003 | Recognized nested command help succeeds before positional validation. | Unknown actions and options continue to fail deterministically. |
| SYN-092-WAITVIEW-005 | Summary wait output preserves task selector identity and exact lease fields. | Every resolved task retains task ID, state, revision, lease ID, generation, and owner thread. |

Release gate: focused and full deterministic tests, installed-package smoke, and
Codex compatibility checks pass on the exact release checkout; documentation
and generated advisor guidance match the shipped CLI behavior.

## v0.9.3 — Version truth, host wait handoff, and dormant job contracts

Goal: make runtime/version identity and wait ownership explicit while shipping a
strict, validation-only durable job contract with no execution plane.

Status: source prepared; the last verified public package remains `v0.9.2`.
This entry is a release contract and documentation boundary, not publication
evidence.

| ID | Outcome | Acceptance gate |
|---|---|---|
| SYN-093-VERSIONS-001 | Lifecycle output distinguishes `runtimeVersion`, `installedTemplateVersion`, and `stateTemplateVersion` while preserving the legacy `templateVersion` alias. | Installed-package smoke and release assertions preserve all three truths and alias behavior without lockfile or dependency drift. |
| SYN-093-WAIT-002 | Wait authority is explicit (`host`, `appServer`, or `canonical`) and remains separate from transport/mode; Desktop handoff uses positive host fields and legacy aliases. | Host-owned waits never construct a child App Server; canonical task selection remains read-only identity resolution rather than observation. |
| SYN-093-JOBS-003 | Schema-1 `JobHandle`/`JobEvent` contracts validate strict durable observations without persistence, commands, runners, or a thread/resume observer. | Source and installed-package checks validate the dormant public contract and reject unknown fields. |
| SYN-093-RELEASE-004 | Package metadata, changelog, documentation, release instructions, and smoke fixtures describe the source `v0.9.3` contract. | Deterministic release/doc assertions and the full required test commands pass while public verification remains `v0.9.2`. |

Release gate: publish only through the protected workflow after this source
contract is independently reviewed and the exact release checkout has its
required CI, npm, and GitHub evidence. No publication is implied by this
source-preparation entry.

## v1.0 readiness criteria

Synod reaches a 1.0 candidate only after all of the following are demonstrated:

- Two independent, production-shaped pilots complete interruption and recovery
  drills using released package artifacts.
- A reviewed dirty checkpoint is recoverable in a clean checkout and its
  reconstructed fingerprint matches exactly.
- Concurrent-writer, stale-lease, corrupted-bundle, hash-chain, unsafe-path,
  and partial-transaction adversarial tests fail closed.
- Usage and coordination reports remain stable across supported Codex versions,
  model reroutes, archived descendants, and counter resets.
- Lifecycle migrations, uninstall preservation, installed-package behavior,
  security review, and cross-platform CI are green on the exact release commit.
- Public documentation distinguishes local completion, Git integration,
  external approval, deployment, and operational verification.

## Explicit non-goals

- Autonomous merge, push, deployment, secret mutation, or provider spending.
- Replacing Git hosting, CI, code review, or protected release workflows.
- Uploading project state or telemetry to a Synod service by default.
- Treating raw token totals as invoices or promising savings without a measured
  baseline.
- Accepting user-owned Markdown as canonical orchestration state.

## Delivered foundation

- `v0.3.2`: correctness, stable JSON envelopes, archived-session discovery,
  App Server lifecycle, and cross-platform package smoke.
- `v0.4`: ownership manifests, transactional lifecycle, migrations,
  `check`/`doctor`, safe upgrade/uninstall, profiles, and compatibility gates.
- `v0.5`: canonical task state, validated transitions, revision-linked evidence,
  hash-chained events, checkpoint drift, and generated status.
- `v0.6.0`–`v0.6.2`: project-local pinned runtime, protected release parity,
  Desktop-aware diagnostics, and corrected GPT-5.6 custom-agent routing.
- `v0.6.3`: behavior-preserving strict TypeScript 7 migration, compiled ESM
  package output, stable JavaScript executable shim, and preserved deep-import
  compatibility.
- `v0.7.0`: hash-bound checkpoint snapshots and path deltas, deterministic
  local recovery bundles, transactional fresh-checkout restore, and canonical
  text/JSON handoff context with installed cross-platform recovery smoke.
- `v0.8.0`: exact-fenced writer leases and ownership scopes, abandoned-worker
  proposal recovery, enforced correction policy, change-driven waiting,
  verifiable detached task worktrees, and explicit schema migration with
  installed concurrency, interruption, upgrade, and cleanup drills.
- `v0.9.0`: exact marginal usage and coordination attribution, opt-in task
  budgets, deterministic phase-rotation handoffs, and optional dated local
  cost estimates, with installed production-shaped reset, reroute, archived
  thread, incomplete-session, and schema-migration drills.
- `v0.9.1`: schema-4 pre-spawn lease reservations, exact bind/cancel/expiry
  fencing, and corrected task-session, thread-count, coordination-outcome, and
  exact-boundary usage semantics.
- `v0.9.2`: task-aware waiting, read-only adaptive rotation suggestions, typed
  task/proposal commands, summary JSON output, truthful bind activation
  handoffs, nested-help routing, and the corresponding canonical-fence and
  package compatibility hardening. The reviewed merge, signed tag, npm/GitHub
  publication, installed-package proof, and CLI proof are verified.

The worktrees/leases and economics originally associated with `v0.6` were not
discarded. They are deliberately sequenced after recoverable phase boundaries
because the pilot showed that exact local identity must become portable before
Synod safely adds more concurrency or autonomous adaptation.
