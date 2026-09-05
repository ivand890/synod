# Synod Roadmap History

This document preserves the delivered-release record that formerly lived in
[ROADMAP.md](../ROADMAP.md). It is historical evidence, not a forward
commitment. The active roadmap is intentionally concise and outcome-led; use
this file when auditing what shipped and which release-specific task gates
were used.

The chronology below retains the v0.6 through v0.12 release sections and task
tables from the prior roadmap. Historical task IDs and acceptance gates are
not current work items. Release evidence remains separate from forward
commitments: a historical claim is supported by the closeout record named in
the relevant section, while a future horizon is accepted only by its own
measurable gate.

## v0.6 — Delivered foundation

The prior roadmap recorded the following v0.6 delivery before the detailed
v0.6.3 migration table: v0.6.0–v0.6.2 shipped the project-local pinned
runtime, protected release parity, Desktop-aware diagnostics, and corrected
GPT-5.6 custom-agent routing.

The following sections are retained from the prior roadmap.

## Pre-v0.7 foundation — TypeScript 7 source migration

Goal: migrate Synod's JavaScript implementation to strict TypeScript 7 without
changing its CLI, runtime, package, security, or orchestration behavior. The
migration is a prerequisite for new roadmap features, not a feature delivery of
its own.

Status: delivered in `v0.6.3`.

The v0.6.3 migration historically supported Node 20/22/24.
The v0.9.5 release required Node `>=22` and removed Node 20 support. The delivered package
published compiled ESM JavaScript and kept a minimal JavaScript `bin/synod.js`
shim; consumers did not need TypeScript, and the release added no production
dependency. Source imports kept their explicit `.js` specifiers under
`module: NodeNext`.

The migration acceptance rows below retain their historical Node 20/22/24
runtime gates; they describe the delivered v0.6.x foundation, not the current
release runtime requirement.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-069A | Establish the TS 7 checking baseline | `v0.6.2` | Pin TypeScript 7 and Node 20 types as development dependencies; add an ES2022/NodeNext config with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and explicit `types: ["node"]`; run `allowJs` + `checkJs` + `noEmit` over the existing JavaScript before renaming files; current tests, JSON envelopes, exit codes, and package smoke remain unchanged. |
| SYN-069B | Migrate contracts and leaf modules | SYN-069A | Convert package metadata helpers, errors, envelopes, compatibility, profiles, command options, filesystem, manifest, templates, and migrations first; public data structures use explicit types or discriminated unions; no unchecked cast substitutes for runtime validation. |
| SYN-069C | Migrate integration and lifecycle modules | SYN-069B | Convert App Server, usage, doctor, Codex runtime, local runtime, and lifecycle modules; external process output and parsed JSON enter as `unknown` and pass existing or stronger validators; timeout, cleanup, rollback, symlink, and cross-platform behavior remains equivalent. |
| SYN-069D | Migrate orchestration, CLI, tests, and scripts | SYN-069C | Convert canonical state/events, recovery transactions, CLI routing, tests, and release scripts; state transitions and events are exhaustively typed; enable `exactOptionalPropertyTypes` only after the initial strict migration is green and resolve every intentional absent-versus-`undefined` distinction explicitly. |
| SYN-069E | Switch the installed package to compiled output | SYN-069D | Compile TypeScript sources into a clean `dist` tree, retain only a stable JavaScript executable shim, and build before packing; audit the current deep-import/package surface before changing paths; an installed tarball passes every CLI contract on Node 20/22/24 and package smoke on Ubuntu, macOS, and Windows without shipping or loading TypeScript at runtime. |

Foundation gate required the compiled package to be behaviorally
indistinguishable from the `v0.6.2` baseline for supported commands, text/JSON
output, exit status, filesystem mutations, recovery, and installed runtime
delegation. The migration landed separately from `v0.7` product behavior, and
each slice kept the full regression suite and `git diff --check` green.

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

Status: delivered and publicly verified. The exact tag SHA and post-publication
npm/GitHub, registry-installed package, and public CLI facts are verified in the
versioned v0.9.3 closeout archive. The local tarball smoke remained source-preparation evidence only.

| ID | Outcome | Acceptance gate |
|---|---|---|
| SYN-093-VERSIONS-001 | Lifecycle output distinguishes `runtimeVersion`, `installedTemplateVersion`, and `stateTemplateVersion` while preserving the legacy `templateVersion` alias. | Installed-package smoke and release assertions preserve all three truths and alias behavior without lockfile or dependency drift. |
| SYN-093-WAIT-002 | Wait authority is explicit (`host`, `appServer`, or `canonical`) and remains separate from transport/mode; Desktop handoff uses positive host fields and legacy aliases. | Host-owned waits never construct a child App Server; canonical task selection remains read-only identity resolution rather than observation. |
| SYN-093-JOBS-003 | Schema-1 `JobHandle`/`JobEvent` contracts validate strict durable observations without persistence, commands, runners, or a thread/resume observer. | Source and installed-package checks validate the dormant public contract and reject unknown fields. |
| SYN-093-RELEASE-004 | Package metadata, changelog, documentation, release instructions, and smoke fixtures describe the public `v0.9.3` contract. | Deterministic release/doc assertions, installed-package smoke, and the full required test commands pass on the verified release checkout. |

Release gate: source preparation is satisfied by the protected workflow and
exact signed release tag, including the local tarball smoke; public
verification is satisfied only by the exact npm `gitHead`, GitHub Release
state, registry-installed package integrity/attestation/provenance and clean
consumer check, and public CLI parity recorded in versioned
`release-closeouts/v0.9.3.json`.

## v0.9.4 — Review, host, status, and recovery surfaces

Goal: make the next review, host, status, recovery, and release surfaces
explicit while preserving the public release's fail-closed boundaries.

Status: delivered and publicly verified. These surfaces are available to
public and pinned `v0.9.4` runtimes. The public/pinned `v0.9.4` `doctor`
support expression is
`>=0.148.0-0 <0.149.0 (all 0.148.x variants)`. Every valid semantic version
whose numeric major/minor is exactly `0.148` is accepted, including any patch,
prerelease, stable, and build metadata; `0.148.0-alpha.9` is known-good.
Valid versions below `0.148`, valid versions at or above `0.149`, and invalid
semantic versions remain unsupported.
The package engine and doctor range are Node `>=22`; Node 20 is unsupported.
CI retains Ubuntu Node 22/24 tests and package smoke,
plus Node 24 smoke on macOS and Windows.

| ID | Outcome | Acceptance boundary |
|---|---|---|
| SYN-094-REVIEW-001 | Record pre-proposal corrections and expose exact per-path Git-lane provenance for sealed proposals. | Correction budget is consumed while `ACTIVE`; `proposalAdded`, `gitTracked`, `staged`, and `committed` remain independent facts and drift fails closed. |
| SYN-094-HOST-002 | Add an injected host delegation adapter for spawn identity, bind authorization, wait observation, and lease liveness. | The host owns execution; an unadapted CLI/Desktop path remains an explicit incomplete handoff and never claims execution ownership. |
| SYN-094-STATUS-003 | Add bounded task, active-only, and changed-since-checkpoint status selectors without changing default status compatibility. | Text/JSON selectors are mutually exclusive, bounded, read-only, and fail closed for unknown tasks or incompatible options. |
| SYN-094-SURFACES-004 | Make release closeout, dependency-free GIF generation, and local-versus-portable documentation policy reproducible. | Closeout evidence, 1120×622 GIF validation, and opt-in hash-verified local docs are reproducible public release surfaces. |
| SYN-094-PACKAGE-CLEANUP-005 | Remove supervisor-generated npm-init metadata without changing the package contract. | `package.json` is byte-identical to the released contract and no unrelated path changes. |
| SYN-094-DOC-VERSION-006 | Separate the public `0.9.4` runtime truth from source-only future changes across product documentation. | README, PRODUCT, and ROADMAP describe the released commands; standalone host delegation fails closed. |
| SYN-094-RELEASE-011 | Prepare the accepted increment as a realizable fail-closed `v0.9.4` source release. | The protected workflow authenticates tag/package/main identity, runs tests and package smoke before strict closeout validation, and records exact post-publication evidence. |

Release gate: all seven SYN-094 tasks were reviewed and verified on the exact
source revision, then published and consumed through the exact public v0.9.4
package. `SYN-094-RELEASE-011` additionally required an authenticated
tag/package/main ancestry check, test and package-smoke run, and phase-strict
closeout validation before publication. Its phase-2 live verifier ran on the
protected closeout PR, not the tag workflow, and performed the read-only
registry/GitHub and public-consumer checks there.

## v0.9.5 — Status bootstrap hotfix

Goal: keep the verified v0.9.4 runtime surfaces intact while making bounded
status selectors work through the initialized project-local bootstrap.

Status: delivered and publicly verified. The public and pinned `v0.9.5`
runtime accepts `--task`, `--active-only`, and
`--changed-since-checkpoint` as mutually exclusive selectors, including when
the bootstrap delegates to an initialized local runtime; incompatible
combinations still fail closed. The release required Node `>=22` and retained
the support expression `>=0.148.0-0 <0.149.0` for every valid numeric
`0.148.x` variant, with `0.148.0-alpha.9` known-good.

| ID | Outcome | Acceptance boundary |
|---|---|---|
| SYN-095-STATUS-BOOTSTRAP-024 | Make the official project-local bootstrap accept the public status selectors without weakening selector validation. | Initialized-runtime regressions cover all three selectors and fail-closed incompatible combinations; the exact public package and CLI evidence are recorded in `release-closeouts/v0.9.5.json`. |

Release gate: the exact signed tag and immutable latest GitHub Release, npm
`gitHead`/`latest` parity, registry integrity/attestation/provenance, clean
consumer install, and public CLI parity are recorded in the root closeout and
the byte-identical versioned archive.

## v0.10 — Agent-completable golden path

Goal: stop using the supervisor as a bus between Synod and Codex. One
delegation verb, a blindly executable next action, and an in-context contract
that fits in the advisor skill.

Status: delivered in public `v0.11.0` (PR #38). Not a separate `0.10.0`
package. At the `v0.11.0` delivery (2026-08-18), SYN-100–103 were still open
in the project ledger; this records historical state, not a present commitment.

The executable golden path is:

```text
task add → delegate start → wait --task → proposal submit
        → ACCEPTED → VERIFIED → DONE
```

Lease generation, heartbeat timestamps, baseline hashes, and
reservation tokens remained in JSON. The agent was not permitted to type or
reconstruct them.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-100 | Live Codex `HostDelegationAdapter` so host-owned `delegate start` can reserve, spawn, bind, and authorize | `v0.9.5` | On Codex CLI and Desktop, `delegate start <task>` performs reserve → host spawn → bind → write authorization. The owner identity is opaque and host-returned. Synod does not create the Codex process. Without an adapter, the standalone CLI still fails closed or returns an incomplete host handoff. |
| SYN-101 | Blind next-action contract | SYN-100 | `task next --json --view summary`, plus `delegate`, `wait`, and recover receipts, return the next complete command: argv and exact fence. The agent does not rebuild token, generation, `reserved-at`, or baseline hash from chat. Stale fences fail closed. Typed actions cover accept, verify, recover, cancel, and expire. |
| SYN-102 | One-page agent contract | SYN-101 | The advisor skill and the managed `AGENTS.md` block are the only in-context policy. README, PRODUCT, STATE notes, this roadmap, and closeout archives are not loaded by default. The skill names the golden path and points at `task next`. A fresh supervisor session completes a task without citing `STATE.md`. Target: policy under about 2,000 tokens. |
| SYN-103 | Host-complete wait when an adapter is present | SYN-100 | With an adapter, `wait --task` or `delegate start --wait` observes the owner thread. `hostWaitRequired` appears only when the host did not inject wait. The agent calls the platform wait primitive only for the exact IDs Synod returns. |

Release gate: a fresh supervisor with no parent history completes one atomic
task in this repository using only the skill and `task next`. Zero fences are
typed from chat. The supervisor does not implement unless the existing
minimal-integration exception applies and is recorded.

## v0.11 — Agent-recoverable interruption

Goal: worker death, empty delivery, and a new root session are typed agent
paths, not supervisor judgment.

Status: delivered and publicly verified in `v0.11.0` (PR #39).

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-110 | Recovery as a fenced next action | `v0.10` | Worker stop, lease expiry, or in-scope no-delta yields a typed `resume`, `reassign`, or `supersede` action with the ended generation's exact fence. The agent applies it. Recovery does not accept, verify, or discard the sealed proposal. |
| SYN-111 | Fresh-session handoff without prose memory | SYN-110 | A different root session runs `handoff` and `task next` and continues. Rotation prepare/verify stays opt-in. `STATE.md` is not an input. A recovery bundle remains optional, not required on the happy path. |
| SYN-112 | In-scope no-delta is evidence | SYN-110 | If the worker produces no in-scope delta, `proposal submit` fails closed or `task next` returns recover/correct. Empty delivery cannot be resolved by an undocumented supervisor implementation. |

The historical release gate required killing the worker while the task was
`ACTIVE`, starting a new root session, recovering, and finishing. The sealed
proposal remained intact. Acceptance did not advance across the crash.

## v0.12 — Independent proof

Historical goal: satisfy the existing `v1.0` readiness criteria with published
artifacts. The release also shipped bounded delegation and independent approval
surfaces; its plan sent protocol holes to `v0.12.x` patches rather than opening
a new feature series.

Status: `v0.12.2` is publicly verified. The patch adds structured host/App
Server identities, execution-boundary budget refresh, capability-driven profile
selection, Codex 0.150 compatibility, and a packaged price example to the
validated concurrency policy and CLI App Server runner, zero-write observer
leases, typed reviewer/verifier approval lanes, and bounded parallel delegation.
At the `v0.12.2` closeout, dated 2026-08-30, the broader independent-proof
milestone was still open; its unfinished SYN-120–SYN-123 gates were later
carried into the active roadmap rather than becoming a present commitment. The
dated [v0.12.2 closeout](../release-closeouts/v0.12.2.json) records the signed
tag and public npm/GitHub, registry, and CLI evidence; local tarball smoke remained source-preparation evidence.

| ID | Outcome | Depends on | Acceptance gate |
|---|---|---|---|
| SYN-120 | Pilot A: this repository on the published `v0.12.x` package | `v0.12` | A real Synod feature that is not closeout or version-truth documentation is delivered with `@ivand890/synod@0.12.x` pinned. The drill includes interruption plus restore of a reviewed dirty checkpoint. The reconstructed fingerprint matches exactly. |
| SYN-121 | Pilot B: an independent repository | SYN-120 | A different repository and domain, preferably a different person. The human only requests the work and does not explain leases. The agent reaches `DONE`. If the human had to know what a bind is, the pilot fails. |
| SYN-122 | Loop-cost evidence | SYN-120 | Canonical `usage` and coordination reports cover the pilot interval. Compare them to the historical 0.9.x dogfood snapshot (329 supervisor waits, hundreds of millions of tokens). Do not promise savings. If coordination cost does not drop clearly, do not tag `v1.0`; return to a `v0.12.x` patch or defer the release gate. |
| SYN-123 | Adversarial gap-fill | `v0.12` | Audit the existing suite and add only missing fail-closed cases: concurrent writers, stale leases, corrupted bundles, hash-chain breaks, unsafe paths, and partial transactions. Do not add a new test framework. |

Release gate: both pilots run on published packages, the recovery drill is
green, adversarial cases fail closed, and usage reports stay stable on the
supported Codex line.
