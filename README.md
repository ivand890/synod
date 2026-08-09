# Synod

Synod installs a persistent, reviewed advisor loop for Codex projects. The selected model profile assigns supervision, atomic implementation, exploration, review, verification, and mechanical work while keeping the primary agent responsible for integration and final evidence.

## Install

The default and supported bootstrap path is `pnpm dlx`:

```bash
pnpm dlx @ivand890/synod init
```

This installs the exact Synod version selected by `pnpm dlx` into `.synod/runtime` in the project. Each project therefore keeps an independent runtime and can upgrade on its own schedule. The project-local installation deliberately does not add a bare `synod` command to the repository's `PATH`; generated project instructions use the version-pinned `pnpm dlx @ivand890/synod@<version>` bootstrap, which restores and delegates to the local runtime. A global installation remains optional:

```bash
pnpm add --global @ivand890/synod
```

When a global or `pnpm dlx` entry point runs inside an initialized project, it delegates to that project's pinned local runtime. `pnpm` is the only bootstrap package manager exercised and supported for this initial implementation.

The local `node_modules/` directory is a disposable cache. After cloning a project, invoking Synod through `pnpm dlx` or an optional global installation reconstructs the exact version in `.synod/runtime.json` before delegating.

## Initialize a project

```bash
cd your-project
pnpm dlx @ivand890/synod init
```

Fresh installs default to the conservative `portable` profile. Run `pnpm dlx @ivand890/synod doctor` (or `synod doctor` with the optional global installation) before opting into `synod-5.6` so the exact model and reasoning capabilities are verified for the installed Codex runtime and account.

The examples below use the shorter `synod` form, which requires the optional global installation. Without it, prefix each command with `pnpm dlx @ivand890/synod`, for example `pnpm dlx @ivand890/synod doctor`.

Select a model profile, preview changes first, or replace conflicting Synod-managed files:

```bash
synod init --profile synod-5.6
synod init --profile portable
synod init --dry-run
synod init --force
```

Synod preserves an existing user-owned `.codex/config.toml`. It reports the file so you can merge the recommended model and agent defaults deliberately. It also never overwrites the user-owned goal, plan, state notes, decisions, or worklog under `docs/synod/`, even with `--force`; only the generated `STATUS.md` record is updated by orchestration commands. When an upgrade finds operational guidance in `DECISIONS.md`, `PLAN.md`, or `STATE.md` that differs from the current templates, it emits `SYNOD_DURABLE_STATE_PRESERVED`. Review the current managed instructions in `AGENTS.md` and `.agents/skills/synod-advisor/SKILL.md`, then update the preserved file manually if its Synod examples are stale.

If `AGENTS.md` contains multiple complete Synod managed blocks, initialization stops without writing. `synod init --force` consolidates those blocks into one canonical block and preserves surrounding user content. Incomplete, nested, or orphaned Synod markers are always rejected because their ownership boundary cannot be repaired safely.

Synod keeps canonical orchestration state in `.synod/state.json`, an append-only audit stream in `.synod/events.jsonl`, and a generated human view in `docs/synod/STATUS.md`. Goal, decision, plan, state-note, and worklog Markdown remain user-owned supporting context. Upgrades and uninstall preserve both kinds of durable records.

The bootstrap records `.synod/runtime.json` schema 1 and creates an isolated pnpm project under `.synod/runtime/`. Its `package.json` and `pnpm-lock.yaml` pin the runtime, while its `.gitignore` excludes only `node_modules/`. Runtime metadata is deliberately separate from `.synod/manifest.json`: `runtimeVersion` identifies the executable, `templateVersion` identifies installed project content, and each descriptor keeps its own `schemaVersion`.

## Safe project lifecycle

Every installation records `.synod/manifest.json` schema 3 with the template version, selected profile, ownership, and a normalized SHA-256 hash for each managed path. Synod owns its generated infrastructure, shares ownership of only the marked block in `AGENTS.md`, and classifies canonical state, its event log, and the generated status view as mutable durable records that are preserved on uninstall.

Verify project integrity and runtime capabilities:

```bash
synod check
synod doctor
synod check --json
synod doctor --json
```

Preview and apply a template migration or profile change with the pinned runtime:

```bash
synod upgrade --dry-run
synod upgrade
synod upgrade --profile portable --dry-run
synod upgrade --profile portable
```

To upgrade the project runtime, select the desired bootstrap version explicitly. The dry run reports the runtime and template plan without installing or replacing the project-local runtime or changing project files; the apply replaces the local runtime atomically before running the template migration:

```bash
pnpm dlx @ivand890/synod@<version> upgrade --dry-run
pnpm dlx @ivand890/synod@<version> upgrade
```

Synod rejects attempts to replace a newer project runtime with an older one. A failed staged install leaves the previously pinned runtime and descriptor intact.

Initialization, upgrade, and uninstall recheck every destination immediately before mutation, replace files atomically, and roll back already-applied operations when a later operation fails. Modified Synod-owned files are conflicts; `--force` is required to replace or remove them. User-owned files are preserved even under `--force`.

Uninstall the managed infrastructure and project-local runtime while retaining `docs/synod/`, canonical orchestration records, and surrounding user content in `AGENTS.md`:

```bash
synod uninstall --dry-run
synod uninstall
```

Schema 1 manifests from v0.3.0 through v0.3.2 migrate through explicit `1 → 2 → 3` migrations. Schema 2 v0.4 projects migrate through `2 → 3`. Published legacy template hashes remain the baseline so drift is detected before upgrade.

## Enforced orchestration

Create an atomic task with every field required before execution:

```bash
synod task add T-001 \
  --objective "Implement the API contract" \
  --executor synod_implementer \
  --acceptance "The documented success and failure cases pass" \
  --verification "pnpm test"
```

Acceptance criteria, verification commands, evidence, and dependencies are repeatable options. Use `--depends-on T-000` for prerequisites and `--cwd <directory>` outside the project root.

Task state follows a validated graph:

```text
PLANNED → READY → ACTIVE → REVIEW → ACCEPTED → VERIFIED → DONE
                         ↘ ACTIVE (correction)
```

Non-terminal tasks can be blocked or superseded. A blocked task can resume only its recorded prior state. Terminal tasks cannot transition.

Every transition requires an exact task revision. Submitting work from `ACTIVE` to `REVIEW` advances it by one and requires delivery evidence. Acceptance and verification each require separate evidence tied to that same revision. Returning reviewed, accepted, or verified work to `ACTIVE` increments the correction round and clears current acceptance and verification:

```bash
synod task transition T-001 READY --revision 0
synod task transition T-001 ACTIVE --revision 0
synod task transition T-001 REVIEW --revision 1 --evidence "commit:abc123"
synod task transition T-001 ACCEPTED --revision 1 --evidence "review:approved"
synod task transition T-001 VERIFIED --revision 1 --evidence "test:pnpm-test:pass"
synod task transition T-001 DONE --revision 1
```

Each evidence item also captures the Git branch, exact `HEAD`, and content-sensitive working-tree fingerprint observed for that event. State mutations hold an exclusive project lock, validate the complete event hash chain, append one event, and atomically replace state plus its Markdown projection.

Task mutations do not move the canonical checkpoint, so they cannot silently accept repository drift. Only `synod checkpoint` changes the acknowledged branch, `HEAD`, and working-tree fingerprint.

Read actual state and compare its last checkpoint with the current repository:

```bash
synod status
synod status --json
```

`status` exits non-zero with `SYNOD_CHECKPOINT_DRIFT` when branch, `HEAD`, or relevant working-tree content differs. Synod-owned infrastructure and orchestration records are excluded so Synod does not create its own drift. After investigating a deliberate change, accept it explicitly:

```bash
synod checkpoint --message "Accepted the integrated revision"
```

Do not hand-edit `.synod/state.json`, `.synod/events.jsonl`, or `docs/synod/STATUS.md`. A broken event sequence, hash chain, state/log match, or Markdown projection fails closed.

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
    "synodVersion": "0.6.0",
    "nodeVersion": "24.12.0",
    "platform": "darwin",
    "codexVersion": "0.142.0"
  }
}
```

Failures set `ok` to `false`, omit `data`, include `error: { code, message, details? }`, and return a non-zero exit status. Warnings use `{ code, message, details? }`. Codes are stable within schema version 1.

Lifecycle errors include stable codes for invalid/unsupported manifests, invalid or conflicting local runtimes, failed runtime installation or execution, required upgrades, conflicts, unsafe paths, destination races, transaction rollback, and unsupported downgrades. Orchestration errors identify invalid state/logs, state-log mismatch, held locks, invalid tasks or transitions, stale revisions, missing evidence, and checkpoint drift. Existing command, App Server, session, and JSON codes remain stable within envelope schema version 1.

Warnings identify preserved user state, available upgrades, missing user-owned files, incompatible profiles, unsupported Codex versions, and bounded App Server cleanup fallbacks.

## Model profiles and Codex compatibility

List the built-in profiles:

```bash
synod profiles
synod profiles --json
```

- `synod-5.6` uses Sol for supervision, Luna for cost-efficient implementation/mechanical work, and Terra for exploration/review/verification. Its global subagent fallback is Terra because current Codex 0.147 validates that fallback against the narrower spawn override set before applying a selected custom-agent file; Luna remains valid inside the implementer and mechanical agent files. The profile requires Codex 0.147.0 or later within the supported range, including eligible previews such as `0.147.1-alpha.1`, and verifies the fallback plus each role model and reasoning effort through `model/list`.
- `portable` uses GPT-5.5 at role-specific reasoning efforts. It is the conservative fallback verified across both known-good Codex versions and account-specific model catalogs.

`synod doctor` identifies whether Synod is running from Codex CLI or Codex Desktop and probes that surface's own App Server executable. It resolves the active Codex process from the process ancestry, falling back to `codex` from `PATH` for a standalone CLI invocation. An explicit `SYNOD_CODEX_BIN` still takes precedence. If Desktop is detected but its executable cannot be resolved, `doctor` fails closed instead of silently reporting the CLI version as the Desktop version.

CLI and Desktop may share `~/.codex` while running different Codex versions. Inspect the `codex` object under `data` on success or `error.details` on failure—especially `surface`, `version`, `executable`, `executableSource`, and `home`—instead of assuming the two installations match.

It then classifies that surface's Codex version independently from model availability:

- Supported: `>=0.142.0 <0.148.0`.
- Known-good and exercised in CI: `0.142.0`, `0.147.0`.
- Supported but not known-good: stable or preview builds whose numeric base is inside the range. This version classification alone does not assert profile availability.
- Unsupported: versions below the range and versions at or above `0.148.0`, including previews of those versions, until the CI contract is deliberately expanded.

The numeric version range determines `codex.status` and version eligibility; only matrix-tested versions are `known-good`. Live App Server and model probes independently determine `modelCompatible` and profile compatibility. Overall health requires both an eligible version and the selected profile's required capabilities.

## Advisor routing

- The configured supervisor plans, decomposes, supervises, reviews, integrates, and verifies.
- The configured implementer completes atomic tasks with explicit write scope and acceptance criteria.
- Explorer, reviewer, verifier, and mechanical roles use the selected profile's declared models and reasoning efforts.
- Spawn a configured custom agent by its name with a fresh fork and a self-contained contract. Do not send explicit model or reasoning overrides: the custom agent file resolves first, followed by `[agents]` defaults and then the parent configuration. Full-history forks inherit the parent agent type.
- The spawn tool's explicit override list is not the complete custom-agent model catalog: a custom agent file can select Luna even when explicit per-call overrides list only Sol and Terra. The global `[agents].default_subagent_model` is different because current Codex validates it through that narrower spawn path before applying the custom-agent layer. Synod therefore keeps a Terra global fallback while role files retain their own models. `synod doctor` verifies the broader model capabilities; a controlled child `turn_context` is the final check when resolution is in doubt.

The supervisor does not perform routine implementation. It may make only a minimal integration repair when delegating that repair would cost more than the change, and must record the exception.

## Development

```bash
pnpm test
pnpm test:package
pnpm test:codex-compatibility # requires explicit SYNOD_EXPECTED_* environment values
pnpm pack --pack-destination dist
```

CI runs the installed-package smoke on Ubuntu, macOS, and Windows.

Every change lands through a pull request with required CI. Protected `vX.Y.Z` tags publish both npm and GitHub releases, with exact-commit and `latest` parity enforced before the workflow succeeds; see [RELEASING.md](RELEASING.md).
