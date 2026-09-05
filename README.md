# Synod

Synod is a local trust layer for consequential agent work. It helps a human operator turn a natural-language outcome into bounded, reviewable work in a Codex-compatible harness, then distinguish verified local delivery from an external result.

## Start with an outcome

Use a Codex-compatible harness that can keep a project conversation and run
the installed project instructions. The first interaction is deliberately
small:

1. **Initialize once.** Ask the harness to initialize Synod in the project.
2. **Restart if required.** Reload the project instructions if the harness
   asks for a restart.
3. **Ask naturally.** State the outcome in your own words: “Make the checkout
   pass its API tests,” “Prepare this bounded migration,” or another concrete
   result.
4. **Let the advisor drive.** It turns the outcome into scoped work and emits
   the next legal action. You do not need to learn protocol mechanics.
5. **Supervise the boundaries.** Review scope and evidence, answer requested
   questions, and decide whether any external action should happen.

The human's desired outcome is not an execution grant. Initialization, worker
writes, review, and external actions each have a separate boundary. Synod does
not manufacture an observation just to make the conversation feel finished.

## Who is responsible for what

| Layer | Responsibility | Not implied |
| --- | --- | --- |
| Human intent | State the outcome, scope, approvals, and external decisions. | A request is not permission to spend, publish, deploy, or mutate production. |
| Harness | Carry intent between turns, invoke supervision, own host-only primitives, and report observations. | A restart, receipt, or generated message is not proof that a worker ran. |
| Synod | Validate local task state, authority, evidence, and legal transitions. | Local selection is not runtime observation or external approval. |
| Worker | Act only within current, explicitly granted scope and authority. | A thread label or stale instruction authorizes no write. |
| External system | Own Git hosting, registries, deployment, and paid-provider actions. | `DONE` is not a commit, push, PR, deploy, spend, or production mutation. |

`DONE` records only Synod's local delivery, acceptance, and verification for one task revision. External outcomes need their own evidence.

## When work is interrupted

Interruption is an expected supervision path. After a restart, worker stop,
expired authorization, stale state, or timeout, ask the advisor to inspect the
canonical handoff and choose the legal recovery. A hard budget, approval,
CAPTCHA, payment, or other user-input boundary stops until the operator makes
the decision.

Useful read-only views are:

```bash
synod status --json --view summary
synod handoff --json --view summary
synod task next --json --view summary
```

Recovery decisions such as resume, reassign, and supersede are distinct. They
preserve proposals and event evidence; they do not silently accept work or
turn a timeout into success. Follow the exact action emitted by the advisor,
not a command reconstructed from chat.

## Install and upgrade

For a reproducible project, use the pinned bootstrap from the project root:

```bash
pnpm dlx @ivand890/synod@0.12.2 init
```

The project-local runtime is pinned independently of the checkout's disposable
`node_modules/` cache. A global installation is optional:

```bash
pnpm add --global @ivand890/synod
```

Preview and apply a project-runtime upgrade with an explicitly selected
bootstrap version:

```bash
pnpm dlx @ivand890/synod@<version> upgrade --dry-run
pnpm dlx @ivand890/synod@<version> upgrade
```

The dry run does not install or replace the local runtime. Synod refuses an
older replacement over a newer one, applies managed files atomically, and
preserves user-owned context and canonical records. Use `--force` only when
replacing a modified Synod-managed file is intentional. Upgrade and uninstall
are not release, deployment, or production operations.

To remove the managed installation while retaining local records and user
content:

```bash
synod uninstall --dry-run
synod uninstall
```

## The supervised loop

The operator states an outcome; the advisor scopes it; a worker acts only
after authority is explicit; delivery enters review; independent verification
follows; and only then can the local task be marked `DONE`:

```text
outcome → scope → authorize → work → deliver → review → verify → DONE
```

The advisor emits exact next actions and keeps acceptance separate from
verification. Read-only analysis may precede write authorization, but no stale
message, copied value, or chat label can authorize a write. Local completion
never implies a commit, push, PR, deployment, spending, or production result.

## Source-only capabilities

Unreleased: `synod-astra` adds an Astra advisor with GPT-5.6 workers. See the [migration, advisor policy, and instruction/hook audit](docs/ASTRA-MIGRATION.md) for activation and compatibility limits.

The current repeatable `--blocked-by` dispatch and post-bind worktree
continuation are source-only behavior. They are not present in the pinned
public `@ivand890/synod@0.12.2`; they must be published in a pinned
`@ivand890/synod@0.13.0` package before a pilot can rely on them. Source
checkout behavior alone is not pilot evidence. Until a release contains these
capabilities, follow only actions emitted by the installed runtime.

## Recovery and local evidence

Canonical orchestration state is local `.synod/state.json`, with its event
stream, checkpoint, leases, worktree history, and sealed proposals. The
generated `docs/synod/STATUS.md` is a human view; supporting notes remain
user-owned. Do not hand-edit canonical records or treat chat history as
authority.

Export, verify, or restore a local recovery bundle without changing the source
checkout:

```bash
synod bundle export ../project-recovery.bundle
synod bundle export ../project-recovery.bundle --include-untracked
synod bundle export ../project-recovery.bundle --include-local-docs
synod bundle verify ../project-recovery.bundle --json
synod bundle restore ../project-recovery.bundle --cwd ../restored-project
```

`--include-local-docs` is an explicit opt-in for the five human-owned notes;
generated status and ignored files remain excluded. Bundles can contain source,
secrets, binaries, and symlink targets, so inspect and protect them like the
checkout. Restore requires the exact base revision and a clean destination.

## Usage and JSON

Usage reports are read-only snapshots of a selected session tree or canonical
interval. They are evidence, not billing data, and do not write canonical
state, Git, or telemetry:

```bash
synod usage --by-model
synod usage --session <thread-id> --by-model
synod usage --since-event 12 --until-event 18 --json
synod usage --since-checkpoint
```

Closed intervals use `(start, end]`; incomplete live snapshots say so. An
optional dated, caller-owned price file can produce a local estimate. Synod
does not fetch prices, convert currency, apply tax or credits, or contact a
billing provider.

Every `--json` command emits a versioned envelope. Summary output is for
routine supervision; full output retains evidence needed for recovery. Failure
output is explicit, uses a stable error code, and returns a non-zero exit
status. Summary receipts do not repeat reservation secrets.

## Compatibility

Check the installed project and the available Codex surface with:

```bash
synod doctor --json
synod check --json
synod profiles --json
```

The pinned v0.12.2 release requires Node.js `>=22` (Node 20 is unsupported) and supports Codex numeric minor lines `0.148.x` and `0.150.x`. The untested `0.149.x` gap fails closed; `0.148.0-alpha.9` is known-good and exercised in CI. The harness and model probes determine profile compatibility at runtime.

Unreleased source supports validated patches on the current and previous Codex minor lines: CLI `0.153.4` / `0.152.1`, Desktop `0.153.4`. See [compatibility policy and validation](docs/CODEX-COMPATIBILITY.md); other patches fail closed for Synod-owned execution.

## Release proof route

The public and pinned `@ivand890/synod@0.12.2` is verified at signed tag commit
`0ae623f4537daaa62278e70ae077b3231578a88e`; its matching GitHub Release is
externally immutable (`isImmutable: true`).

Prepared source: [RELEASE-CLOSEOUT.json](RELEASE-CLOSEOUT.json); verified public record:
[release-closeouts/v0.12.2.json](release-closeouts/v0.12.2.json).

Local tarball smoke (`pnpm test:package`), a local build, green tests, or `DONE`
are source-preparation evidence only; they do not prove external publication.

See [RELEASING.md](RELEASING.md) for the protected release procedure.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:package
pnpm test:codex-compatibility
pnpm pack --pack-destination dist
```

Source uses strict TypeScript and compiles to `dist`; published consumers execute the compiled JavaScript. Changes land through the repository's required pull request and CI checks. Release details live in [RELEASING.md](RELEASING.md).
