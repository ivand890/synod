# Changelog

All notable changes to Synod are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.3] - 2026-08-14

### Added

- Added explicit runtime, installed-template, and orchestration-state version
  truths as `runtimeVersion`, `installedTemplateVersion`, and
  `stateTemplateVersion`; the legacy `templateVersion` field remains a
  documented output-specific compatibility alias.
- Added `WaitAuthority` values `host`, `appServer`, and `canonical`, kept
  separate from transport/mode; Desktop waits now hand off to the host with
  positive `hostWaitRequired` and `hostWaitThreadIds` fields while retaining
  the legacy `hostFallbackRequired` and `hostFallbackThreadIds` aliases.
- Added strict schema-1 durable `JobHandle` and `JobEvent` contracts as a
  dormant, validation-only public surface. No execution plane is activated.

### Changed

- Documented that canonical task selection is read-only identity resolution,
  not runtime observation or completion, and that no thread/resume observer is
  provided.
- Extended installed-package smoke coverage for version truth, wait authority
  and host handoff, and dormant job-contract validation.

## [0.9.2] - 2026-08-13

### Added

- Added repeatable `wait --task` selectors that resolve active canonical writer leases, preserve exact task/revision/lease/generation/owner identity, and wait mixed task/thread sets in one bounded operation.
- Added read-only `rotation suggest` preflight with deterministic thresholds and typed actions for unconfigured phases, plus the current legal next action for configured phases.
- Added typed `task next --json` and `proposal submit` façades over the canonical task/proposal state machine, deriving the active revision and bound lease internally.

### Changed

- Added an opt-in `--view summary` JSON projection while keeping full output as the default; summary output retains canonical lifecycle state and exact next-operation fences while reducing historical bulk.
- Updated advisor guidance, generated templates, and package smoke to use task-aware completion, adaptive rotation preflight, typed delivery, and the summary view.
- Extended wait/runtime routing to select the active Codex surface and report explicit host fallback when a separate App Server returns `notLoaded`.

### Fixed

- Fixed canonical task guidance to suppress invalid transitions for unbound or expired reservations and leases, returning the exact bind, expire, or recover action instead.
- Fixed bind receipts to derive activation from the existing `lease.bound` event, include the exact event identity and required follow-up wait, and state that supervisor notification remains unobserved.
- Fixed nested subcommand help to render before required positional validation while preserving unknown-action and unknown-option errors.
- Fixed usage and canonical-action routing to keep `--view` CLI-only and reject stale, repeated, or ambiguous selectors before mutation or Codex discovery.

### Security

- Preserved strict fencing and read-only behavior for task waits, rotation suggestions, task guidance, and summary projections; exact mutation fences remain available for the next legal operation.
- Bind activation never claims that Codex notification, receipt, or execution was observed, and its response does not repeat the opaque reservation token.
- Expired, unbound, or stale lease/reservation state cannot authorize task waiting, delivery, or a misleading legal transition.

## [0.9.1] - 2026-08-13

### Added

- Added schema-4 pre-spawn lease reservations with exact reserve, bind, cancel, and pre-bind expiry fencing, preserving the immutable scoped baseline until a returned Codex thread is atomically authorized.
- Added explicit discovered/contributing thread totals, tool-aware coordination outcomes, and reproducible cross-boundary call evidence to usage reports.

### Changed

- Task-scoped usage now requires an explicit root or descendant `--session`; it no longer guesses the newest project session.
- Generated advisor guidance now reserves scopes before spawn, keeps the initial child read-only, and grants write authority only after the complete reservation is bound to the returned owner thread.

### Security

- Reservations collide with active ownership and other durable claims, cannot authorize heartbeat, worktree, delivery, or `ACTIVE` transitions before bind, and clean up failed/unreturned spawns without creating false abandoned-worker recovery.
- Reservation capability tokens are returned only by the initial reserve command and are redacted from stale-fence diagnostics and canonical handoffs.
- Coordination parsing retains only non-content signals, distinguishes normal wait expiry from actual failure, and excludes unprovable boundary-crossing calls without counting post-interval activity.
- Closed reports validate the complete ordered rollout prefix through any post-boundary evidence before treating crossing calls as reproducibly excluded.

## [0.9.0] - 2026-08-12

### Added

- Added exact marginal usage reports for canonical event, checkpoint, and task intervals, split by thread, model, and role with raw input, cached input, output, reasoning, and total token evidence.
- Added coordination reporting for spawns, follow-ups, waits, tool calls, retries, failures, compactions, and durations, while marking active or otherwise incomplete session trees explicitly.
- Added opt-in canonical task budgets with soft warnings, hard decision gates, and explicit continue, split, or phase-rotation decisions without forging task lifecycle state.
- Added deterministic phase-rotation reports and canonical prepare/verify events that bind handoff evidence to a newly created root session before work continues.
- Added optional dated local USD price files and cached/input/output cost projections that retain the underlying token evidence and remain disabled unless configured.

### Changed

- Canonical orchestration state migrates explicitly from schema 2 to schema 3, preserving historical state and the hash-chained event prefix while adding budgets and phase-rotation records.
- Generated handoff context now includes the same deterministic phase-rotation recommendation used by the standalone report.
- Installed-package smoke now exercises a production-shaped supervisor, implementer, and archived reviewer tree with model reroutes, counter resets, compactions, waits, failures, retries, budgets, rotation, costs, and schema upgrade/downgrade behavior.

### Security

- Usage and cost projections fail closed on incomplete bounded intervals, missing rollout prefixes, counter-reset ambiguity, unknown models, inherited price entries, and prices outside their declared validity window.
- Budget and rotation mutations reject stale observations, recommendations, task revisions, pre-recommendation sessions, and inconsistent root-session bindings; read-only reports remain byte-for-byte non-mutating.

## [0.8.0] - 2026-08-10

### Added

- Added durable exact-revision writer leases with path/tree read and write scopes, heartbeat and expiry policy, deterministic overlap rejection, exact fencing, and append-only acquisition, heartbeat, release, revocation, and recovery events.
- Added abandoned-worker recovery that seals the ended owner's exact scoped proposal and requires an explicit resume, reassign, or supersede decision before execution can continue.
- Added canonical correction limits with explicit approved overrides and task splitting when ordinary correction rounds are exhausted.
- Added change-driven thread waiting through App Server notifications or status cursors, with bounded polling fallback and observable wake, fallback, duration, timeout, approval, and user-input state.
- Added explicit detached task worktrees with durable creation, sealing, integration, reconciliation, and non-force cleanup records. Sealed proposals remain independently verifiable after cleanup and uninstall.

### Changed

- Canonical orchestration state migrates explicitly from schema 1 to schema 2, preserving the hash-chained event history while adding lease baselines and recovery, correction, split, and proposal state.
- `status`, `check`, and `handoff` now validate canonical proposal bundles, lease baselines, the task-worktree registry, and sealed worktree proposals before reporting healthy state.
- Generated advisor guidance now requires an acquired lease before `ACTIVE`, exact fence values for mutations, explicit recovery and correction decisions, and isolated-worktree integration when parallel writers are needed.

### Security

- Lease mutations fail closed on stale IDs, generations, task revisions, heartbeat timestamps, owners, expiry, scope drift, and concurrent writers; recovery never advances acceptance or discards an abandoned proposal implicitly.
- Worktree creation and integration bind the exact control branch, `HEAD`, lease baseline, scope, and proposal fingerprint; ambiguous control drift, changed proposals, dirty cleanup, unsafe destinations, and interrupted transactions require reconciliation instead of forceful deletion.
- Upgrades preserve v0.7 durable records and reject attempts by an older CLI to replace or reinterpret a v0.8 runtime or template.

## [0.7.0] - 2026-08-10

### Added

- Added a hash-bound canonical checkpoint snapshot and read-only `status --explain` text/JSON output for committed, staged, unstaged, untracked, deleted, renamed, resolved, and binary path changes.
- Added deterministic local recovery bundles with exact manifest/object verification, explicit untracked-file opt-in, and checkpoint-bound export.
- Added transactional recovery into fresh exact-base checkouts, including staged and unstaged content, renames, deletions, binary files, modes, symlinks, and opted-in untracked files.
- Added read-only `handoff` text/JSON output derived from canonical tasks, exact-revision evidence, blockers, approval gates, legal transitions, live checkpoint delta, and an optional verified recovery bundle.

### Security

- Checkpoint snapshot tampering, missing historical detail, and unavailable Git bases now fail closed with stable error codes; checkpoint state, event, Markdown, and snapshot updates recover through one pending transaction.
- Recovery rejects corrupt or incomplete objects, unsafe and colliding paths, wrong bases, dirty destinations, dirty submodules, intent-to-add entries, and concurrent Git index mutation before it can silently accept partial state.
- Restore journals the prior index and every affected path, holds Git's standard index lock at publication, validates the reconstructed fingerprint, and rolls back ordinary or interrupted failures without overwriting externally changed content.

## [0.6.3] - 2026-08-10

### Changed

- Migrated the CLI, lifecycle, orchestration, tests, and release tooling to strict TypeScript 7 while preserving the Node 20/22/24 runtime contract and existing command behavior.
- Packages now compile ESM into `dist` before packing, retain the JavaScript executable shim and legacy `src/*.js` deep-import surface, and ship no runtime TypeScript source.

## [0.6.2] - 2026-08-09

### Fixed

- Decoupled the GPT-5.6 global subagent fallback from the Luna implementer: generated config now uses Terra for `[agents].default_subagent_model` while the implementer and mechanical custom-agent files keep their Luna overrides. This prevents Codex 0.147 from rejecting every custom-agent spawn while validating the global fallback before it applies the selected agent file.
- Made `synod doctor` evaluate the global subagent fallback alongside every role-specific model and reasoning requirement.
- Corrected generated recovery guidance to distinguish a rejected global fallback from a custom-agent model failure or stale in-thread configuration.

## [0.6.1] - 2026-08-08

### Fixed

- Documented and generated the correct custom-agent spawn contract so Luna resolves from the agent file or `[agents]` defaults instead of being incorrectly rejected from the narrower explicit-override list.
- Accepted preview Codex builds whose numeric base remains inside the supported range when their required App Server and model capability probes pass, while reporting version eligibility separately from model compatibility and known-good CI versions.
- Made generated project guidance invoke the exact installed Synod version through `pnpm dlx`, while requiring version upgrades to select their target bootstrap explicitly, generating project/profile-aware recovery commands, and warning when preserved user-owned guidance needs manual refresh.

## [0.6.0] - 2026-08-08

### Added

- Added a per-project, version-pinned Synod runtime under `.synod/runtime`, bootstrapped through `pnpm dlx`, with delegation from external installations, atomic upgrades, dry-run planning, and validated uninstall cleanup.
- Made `synod doctor` distinguish Codex CLI from Codex Desktop, select the active surface's executable, and report its version, executable source, and shared Codex home without conflating separate installations.

### Fixed

- Made tag publishing recoverable and fail closed across npm and GitHub Releases, with draft staging, exact `gitHead` checks, a durable tag FIFO, and enforced `latest` parity.
- Hardened local-runtime routing, cache restoration, recursion prevention, rollback, uninstall reporting, and project checks while keeping Desktop diagnostics fail closed when its executable cannot be resolved.

## [0.5.1] - 2026-08-08

### Fixed

- Kept `synod init --dry-run` read-only when preserved orchestration records contain a pending recovery journal.
- Rejected inherited `Object.prototype` names as unexpected task arguments instead of interpreting them as CLI options.
- Prevented stale-lock claim cleanup failures from masking the primary reclamation result.

## [0.5.0] - 2026-08-08

### Added

- Added canonical schema-1 orchestration state in `.synod/state.json`, a SHA-256 hash-chained append-only event log, and the generated durable `docs/synod/STATUS.md` view.
- Added `synod task add` and validated `synod task transition` commands with task IDs, executors, exact revisions, correction rounds, acceptance, verification, dependencies, and evidence.
- Added `synod status` with automatic branch, `HEAD`, and content-sensitive working-tree checkpoint drift detection, plus explicit `synod checkpoint` reconciliation.
- Added manifest schema 3 and explicit schema 2 to 3 migration for mutable, uninstall-preserved orchestration records.

### Changed

- Task delivery, correction, acceptance, verification, and completion now pass through enforced transitions instead of relying on editable Markdown state.
- Evidence records capture the exact task revision plus Git HEAD and working-tree fingerprint at the event checkpoint.
- Task mutations no longer acknowledge checkpoint drift implicitly; only `synod checkpoint` moves the canonical checkpoint.

### Security

- Orchestration mutations use an exclusive project lock, validate state against the hash-chained event log, and atomically replace canonical state and its Markdown projection.

## [0.4.0] - 2026-08-07

### Added

- Added a schema 2 ownership manifest with normalized SHA-256 hashes for Synod-owned files, the managed `AGENTS.md` block, and user-owned durable state.
- Added transactional lifecycle writes with destination rechecks, atomic replacement, and rollback on partial failure.
- Added `check`, `doctor`, versioned schema migrations, `upgrade --dry-run`, `upgrade`, and `uninstall`.
- Added `synod-5.6` and `portable` model profiles plus live App Server model/reasoning capability detection.
- Added an explicit Codex support contract: `>=0.142.0 <0.148.0`, with `0.142.0` and `0.147.0` tested as known-good in CI.

### Changed

- `init` now records ownership and hashes transactionally instead of installing a static manifest template.
- Model-specific templates are rendered from the selected profile with `--profile`.
- Fresh installs default to the conservative `portable` profile; legacy 0.3.x migrations retain `synod-5.6` unless changed explicitly.
- Durable files under `docs/synod/` remain user-owned across checks, upgrades, and uninstall.

### Security

- Upgrade and uninstall refuse to overwrite or remove drifted Synod-owned content unless `--force` is explicit.
- Legacy schema 1 projects use published v0.3.0-v0.3.2 hash baselines during migration so local modifications are not silently adopted.

## [0.3.2] - 2026-08-06

### Added

- Added a versioned JSON envelope with stable success, warning, and error codes for `init` and `usage` automation.
- Added App Server lifecycle coverage for spawn, initialize, responses, timeouts, malformed output, exits, and cleanup.
- Added a minimal `thread/list` capability probe and Codex version/platform diagnostics.
- Added installed-package smoke tests on Ubuntu, macOS, and Windows.

### Changed

- Latest-session discovery now compares active and archived root sessions deterministically.
- App Server cleanup now sends `SIGTERM`, waits for a bounded interval, falls back to `SIGKILL`, and detaches unresponsive process handles with diagnostics.
- `synod init --force` now consolidates duplicate complete managed blocks while preserving surrounding user content.

### Security

- Incomplete, nested, or orphaned Synod markers in `AGENTS.md` are rejected without writing, including under `--force`.

## [0.3.1] - 2026-08-05

### Added

- Added required CI across supported Node.js releases and an installed-package smoke test.
- Added protected tag-driven npm publishing designed for GitHub Actions trusted publishing.
- Documented the release procedure and repository ownership boundaries.

## [0.3.0] - 2026-08-05

### Added

- Published the CLI as the public npm package `@ivand890/synod` while preserving the `synod` executable name.
- Added project initialization and recursive Codex session usage reporting.

[Unreleased]: https://github.com/ivand890/synod/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/ivand890/synod/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/ivand890/synod/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/ivand890/synod/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/ivand890/synod/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ivand890/synod/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ivand890/synod/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/ivand890/synod/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/ivand890/synod/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/ivand890/synod/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ivand890/synod/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/ivand890/synod/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ivand890/synod/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ivand890/synod/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/ivand890/synod/releases/tag/v0.3.2
[0.3.1]: https://github.com/ivand890/synod/releases/tag/v0.3.1
[0.3.0]: https://www.npmjs.com/package/@ivand890/synod/v/0.3.0
