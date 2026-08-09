# Changelog

All notable changes to Synod are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-08-08

### Fixed

- Documented and generated the correct custom-agent spawn contract so Luna resolves from the agent file or `[agents]` defaults instead of being incorrectly rejected from the narrower explicit-override list.
- Accepted preview Codex builds whose numeric base remains inside the supported range when their required App Server and model capability probes pass, while keeping them distinct from known-good CI versions.
- Made generated project guidance invoke the exact Synod version through `pnpm dlx`, so a project-local installation no longer implies that a bare `synod` executable exists in `PATH`.

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

[Unreleased]: https://github.com/ivand890/synod/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/ivand890/synod/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ivand890/synod/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/ivand890/synod/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ivand890/synod/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ivand890/synod/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/ivand890/synod/releases/tag/v0.3.2
[0.3.1]: https://github.com/ivand890/synod/releases/tag/v0.3.1
[0.3.0]: https://www.npmjs.com/package/@ivand890/synod/v/0.3.0
