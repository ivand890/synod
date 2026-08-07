# Synod

Synod installs a persistent, reviewed advisor loop for Codex projects. Sol owns architecture, task decomposition, supervision, review, integration, and final verification. Atomic implementation is delegated by default to the cost-efficient Luna Max worker, with Terra available for escalation or specialized analysis.

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

Preview changes first or replace conflicting Synod-managed files:

```bash
synod init --dry-run
synod init --force
```

Synod preserves an existing user-owned `.codex/config.toml`. It reports the file so you can merge the recommended model and agent defaults deliberately. It also never overwrites the durable project memory under `docs/synod/`, even with `--force`.

If `AGENTS.md` contains multiple complete Synod managed blocks, initialization stops without writing. `synod init --force` consolidates those blocks into one canonical block and preserves surrounding user content. Incomplete, nested, or orphaned Synod markers are always rejected because their ownership boundary cannot be repaired safely.

The generated `docs/synod/` files are the durable project record. Git and runtime evidence remain authoritative when a checkpoint is stale.

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

Both `synod init --json` and `synod usage --json` emit exactly one JSON document. Schema version 1 has this top-level shape:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "usage",
  "data": {},
  "warnings": [],
  "diagnostics": {
    "synodVersion": "0.3.2",
    "nodeVersion": "24.12.0",
    "platform": "darwin",
    "codexVersion": "0.142.0"
  }
}
```

Failures set `ok` to `false`, omit `data`, include `error: { code, message, details? }`, and return a non-zero exit status. Warnings use `{ code, message, details? }`. Codes are stable within schema version 1.

Error codes: `SYNOD_UNKNOWN_COMMAND`, `SYNOD_UNKNOWN_OPTION`, `SYNOD_MISSING_OPTION_VALUE`, `SYNOD_UNEXPECTED_ARGUMENT`, `SYNOD_TARGET_NOT_FOUND`, `SYNOD_TARGET_NOT_DIRECTORY`, `SYNOD_INIT_CONFLICT`, `SYNOD_AGENTS_BLOCK_MALFORMED`, `SYNOD_SESSION_NOT_FOUND`, `SYNOD_SESSION_CYCLE`, `SYNOD_ROLLOUT_PATH_MISSING`, `SYNOD_APP_SERVER_NOT_RUNNING`, `SYNOD_APP_SERVER_SPAWN_FAILED`, `SYNOD_APP_SERVER_TIMEOUT`, `SYNOD_APP_SERVER_EXITED`, `SYNOD_APP_SERVER_MALFORMED_OUTPUT`, `SYNOD_APP_SERVER_PROTOCOL_ERROR`, `SYNOD_APP_SERVER_UNSUPPORTED`, and `SYNOD_INTERNAL_ERROR`.

Warning codes: `SYNOD_DURABLE_STATE_PRESERVED`, `SYNOD_USER_CONFIG_PRESERVED`, `SYNOD_AGENTS_BLOCK_DUPLICATES_REPAIRED`, `SYNOD_APP_SERVER_FORCE_KILLED`, and `SYNOD_APP_SERVER_EXIT_UNCONFIRMED`.

## Model routing

- Sol High or Extra High: plan, decompose, supervise, review, integrate, and verify.
- Luna Max: implement atomic tasks with explicit write scope and acceptance criteria.
- Terra Medium or High: exploration, difficult analysis, review, or fallback when Luna cannot complete a task reliably.

Sol does not perform routine implementation. It may make only a minimal integration repair when delegating that repair would cost more than the change, and must record the exception.

## Development

```bash
pnpm test
pnpm test:package
pnpm pack --pack-destination dist
```

CI runs the installed-package smoke on Ubuntu, macOS, and Windows.

Every change lands through a pull request with required CI. Releases are published from protected `vX.Y.Z` tags using npm trusted publishing; see [RELEASING.md](RELEASING.md).
