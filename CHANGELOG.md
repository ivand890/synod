# Changelog

All notable changes to Synod are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-08-06

### Added

- Added a versioned JSON envelope with stable success, warning, and error codes for `init` and `usage` automation.
- Added App Server lifecycle coverage for spawn, initialize, responses, timeouts, malformed output, exits, and cleanup.
- Added a minimal `thread/list` capability probe and Codex version/platform diagnostics.
- Added installed-package smoke tests on Ubuntu, macOS, and Windows.

### Changed

- Latest-session discovery now compares active and archived root sessions deterministically.
- App Server cleanup now sends `SIGTERM`, waits for a bounded interval, and falls back to `SIGKILL` with diagnostics.
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

[Unreleased]: https://github.com/ivand890/synod/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/ivand890/synod/releases/tag/v0.3.2
[0.3.1]: https://github.com/ivand890/synod/releases/tag/v0.3.1
[0.3.0]: https://www.npmjs.com/package/@ivand890/synod/v/0.3.0
