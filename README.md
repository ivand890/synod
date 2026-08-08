# Synod

Synod installs a persistent, reviewed advisor loop for Codex projects. The selected model profile assigns supervision, atomic implementation, exploration, review, verification, and mechanical work while keeping the primary agent responsible for integration and final evidence.

## Install

Install from npm:

```bash
pnpm add --global @ivand890/synod
```

Or run it without a global installation:

```bash
pnpm dlx @ivand890/synod init
```

You can also install directly from the public GitHub repository:

```bash
pnpm add --global github:ivand890/synod
```

## Initialize a project

```bash
cd your-project
synod init
```

Fresh installs default to the conservative `portable` profile. Run `synod doctor` before opting into `synod-5.6` so the exact model and reasoning capabilities are verified for the installed Codex runtime and account.

Select a model profile, preview changes first, or replace conflicting Synod-managed files:

```bash
synod init --profile synod-5.6
synod init --profile portable
synod init --dry-run
synod init --force
```

Synod preserves an existing user-owned `.codex/config.toml`. It reports the file so you can merge the recommended model and agent defaults deliberately. It also never overwrites the durable project memory under `docs/synod/`, even with `--force`.

If `AGENTS.md` contains multiple complete Synod managed blocks, initialization stops without writing. `synod init --force` consolidates those blocks into one canonical block and preserves surrounding user content. Incomplete, nested, or orphaned Synod markers are always rejected because their ownership boundary cannot be repaired safely.

The generated `docs/synod/` files are the durable project record. They are user-owned after creation: upgrades and uninstall preserve them. Git and runtime evidence remain authoritative when a checkpoint is stale.

## Safe project lifecycle

Every installation records `.synod/manifest.json` schema 2 with the template version, selected profile, ownership, and a normalized SHA-256 hash for each managed path. Synod owns its generated infrastructure, shares ownership of only the marked block in `AGENTS.md`, and treats durable project state as user-owned.

Verify project integrity and runtime capabilities:

```bash
synod check
synod doctor
synod check --json
synod doctor --json
```

Preview and apply a versioned migration or profile change:

```bash
synod upgrade --dry-run
synod upgrade
synod upgrade --profile portable --dry-run
synod upgrade --profile portable
```

Initialization, upgrade, and uninstall recheck every destination immediately before mutation, replace files atomically, and roll back already-applied operations when a later operation fails. Modified Synod-owned files are conflicts; `--force` is required to replace or remove them. User-owned files are preserved even under `--force`.

Uninstall the managed infrastructure while retaining `docs/synod/` and surrounding user content in `AGENTS.md`:

```bash
synod uninstall --dry-run
synod uninstall
```

Schema 1 manifests from v0.3.0 through v0.3.2 migrate through an explicit `1 → 2` migration. Their published template hashes are used as baselines so drift is detected before upgrade.

## Token usage by model

Report the latest Codex session tree for the current project, including every delegated subagent. Synod compares active and archived root sessions and selects the one with the newest `updatedAt` value:

```bash
synod usage --by-model
```

Select a particular session using either its root thread id or any descendant thread id, or emit stable JSON for automation:

```bash
synod usage --session 019f... --by-model
synod usage --json
```

Synod reads Codex's local session metadata through the App Server and reconstructs deltas from the persisted rollout counters. Input includes cached input, and output includes reasoning output; the total therefore does not add those subsets twice. This command requires a locally installed `codex` executable with App Server support. Startup performs a minimal `thread/list` capability probe. Cleanup sends `SIGTERM`, waits up to two seconds, uses a bounded `SIGKILL` fallback, and detaches unresponsive process handles when exit still cannot be confirmed.

For a session that is still running, the report is a persisted snapshot: the active request appears after Codex emits its next token counter update.

## JSON contract

Every command with `--json` emits exactly one JSON document. Envelope schema version 1 has this top-level shape:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "usage",
  "data": {},
  "warnings": [],
  "diagnostics": {
    "synodVersion": "0.4.0",
    "nodeVersion": "24.12.0",
    "platform": "darwin",
    "codexVersion": "0.142.0"
  }
}
```

Failures set `ok` to `false`, omit `data`, include `error: { code, message, details? }`, and return a non-zero exit status. Warnings use `{ code, message, details? }`. Codes are stable within schema version 1.

Lifecycle errors include stable codes for invalid/unsupported manifests, required upgrades, conflicts, unsafe paths, destination races, transaction rollback, and unsupported downgrades. Existing command, App Server, session, and JSON codes remain stable within envelope schema version 1.

Warnings identify preserved user state, available upgrades, missing user-owned files, incompatible profiles, unsupported Codex versions, and bounded App Server cleanup fallbacks.

## Model profiles and Codex compatibility

List the built-in profiles:

```bash
synod profiles
synod profiles --json
```

- `synod-5.6` uses Sol for supervision, Luna for cost-efficient implementation/mechanical work, and Terra for exploration/review/verification. It requires Codex 0.147.0 or newer within the supported range and verifies each model and reasoning effort through `model/list`.
- `portable` uses GPT-5.5 at role-specific reasoning efforts. It is the conservative fallback verified across both known-good Codex versions and account-specific model catalogs.

`synod doctor` classifies the installed Codex binary independently from model availability:

- Supported: `>=0.142.0 <0.148.0`.
- Known-good and exercised in CI: `0.142.0`, `0.147.0`.
- Unsupported: versions below the range, prereleases, and versions at or above `0.148.0` until the CI contract is deliberately expanded.

Inside the supported range, unlisted patch/minor versions are reported as `supported`; only matrix-tested versions are `known-good`. A supported binary can still lack a selected model profile, which `doctor` reports separately.

## Advisor routing

- The configured supervisor plans, decomposes, supervises, reviews, integrates, and verifies.
- The configured implementer completes atomic tasks with explicit write scope and acceptance criteria.
- Explorer, reviewer, verifier, and mechanical roles use the selected profile's declared models and reasoning efforts.

The supervisor does not perform routine implementation. It may make only a minimal integration repair when delegating that repair would cost more than the change, and must record the exception.

## Development

```bash
pnpm test
pnpm test:package
pnpm test:codex-compatibility # requires explicit SYNOD_EXPECTED_* environment values
pnpm pack --pack-destination dist
```

CI runs the installed-package smoke on Ubuntu, macOS, and Windows.

Every change lands through a pull request with required CI. Releases are published from protected `vX.Y.Z` tags using npm trusted publishing; see [RELEASING.md](RELEASING.md).
