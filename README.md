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

The generated `docs/synod/` files are the durable project record. Git and runtime evidence remain authoritative when a checkpoint is stale.

## Token usage by model

Report the latest Codex session tree for the current project, including every delegated subagent:

```bash
synod usage --by-model
```

Select a particular session using either its root thread id or any descendant thread id, or emit stable JSON for automation:

```bash
synod usage --session 019f... --by-model
synod usage --json
```

Synod reads Codex's local session metadata through the App Server and reconstructs deltas from the persisted rollout counters. Input includes cached input, and output includes reasoning output; the total therefore does not add those subsets twice. This command requires a locally installed `codex` executable with App Server support.

For a session that is still running, the report is a persisted snapshot: the active request appears after Codex emits its next token counter update.

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

Every change lands through a pull request with required CI. Releases are published from protected `vX.Y.Z` tags using npm trusted publishing; see [RELEASING.md](RELEASING.md).
