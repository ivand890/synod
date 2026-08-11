---
name: synod-advisor
description: Run or resume Synod's persistent, cost-efficient advisor loop for complex Codex projects. Use when a supervising model should own architecture, planning, review, and verification while delegating atomic implementation to the configured worker profile, when work spans multiple phases or sessions, or when the project must advance through documented checkpoints and correction rounds.
---

# Synod Advisor

Advance the project to its next verified checkpoint. Keep the primary agent in the supervisory loop and move routine implementation to cost-efficient workers while treating Git and runtime evidence as authoritative.

Use `__SYNOD_COMMAND__` for normal Synod commands. This version-pinned bootstrap restores and delegates to the project-local runtime without requiring `synod` in `PATH`. To upgrade the runtime to a different version, explicitly select the desired target with `pnpm dlx @ivand890/synod@<target-version> upgrade [directory]`; the invoking bootstrap version is the upgrade target.

## Load durable state

1. Read `AGENTS.md` and all files under `docs/synod/`.
2. Inspect the current branch, `HEAD`, working-tree changes, and applicable build or test commands.
3. Compare observed state with `docs/synod/STATE.md`. Mark contradictions as drift and correct the checkpoint before relying on it.
4. If `GOAL.md` still contains an undefined objective or completion criteria, establish them with the user before implementation.

## Keep the primary agent in the advisor role

Keep the primary agent responsible for the goal, architecture, plan, atomic task contracts, supervision, acceptance decisions, integration, and final verification. Do not use the supervising model as the routine implementation worker.

Delegate implementation whenever the work can be expressed as an atomic contract. Let the supervisor implement only when:

- no suitable worker is available;
- a tiny integration repair would cost more to delegate than to perform;
- the task cannot be isolated after a genuine decomposition attempt.

Record the reason for every supervisor implementation exception in `STATE.md` or `DECISIONS.md`.

Prefer these project agents:

- `synod_implementer` for atomic implementation with the selected profile's cost-efficient worker. Use this worker by default.
- `synod_explorer` for read-heavy mapping and evidence gathering.
- `synod_reviewer` for correctness, security, regressions, and test gaps.
- `synod_verifier` for an independent attempt to refute completion.
- `synod_mechanical` for clear, repetitive, high-volume read-only checks.

When spawning a configured project agent, select its custom agent type by name, use a fresh fork without full parent history, and include the complete atomic contract in the message. Omit explicit `model` and `reasoning_effort` spawn overrides: the selected `.codex/agents/<name>.toml` file takes precedence, then `[agents].default_subagent_model` and `[agents].default_subagent_reasoning_effort`, then the parent settings. A full-history fork inherits the parent agent type and must not be combined with a different custom agent type.

Do not infer that a custom agent's configured model is unavailable from the spawn tool's list of explicit per-call overrides. A model selected inside `.codex/agents/<name>.toml` can be valid even when it is absent from that narrower list. The global `[agents].default_subagent_model` is validated earlier through the spawn path, so an `Unknown model ... for spawn_agent` error naming the global default can prevent a different custom-agent model from being applied. First run `__SYNOD_COMMAND__ doctor`, which probes `model/list`. If the installed profile predates the spawn-safe fallback, upgrade it and start a new Codex task so project config is loaded from disk; changing profiles inside the failing task does not rewrite that task's already-loaded configuration. If resolution is still uncertain, spawn one trivial read-only child using the target configured custom-agent type and a fresh fork without full parent history. Omit explicit `model` and `reasoning_effort`, then inspect the child's persisted `turn_context` before substituting another model.

Escalate implementation to the configured higher-capability profile only after the task proves insufficiently specified, the worker returns a justified capability blocker, or two focused correction rounds fail. If a named model is unavailable, run `__SYNOD_COMMAND__ doctor`, select a compatible profile, apply it with `__SYNOD_COMMAND__ upgrade [directory] --profile <id>` so the generated `.codex` configuration and agents are updated, and then record the substitution in `STATE.md`.

## Delegate with a contract

Before any implementation, give the worker a stable task ID from `PLAN.md` and include:

- objective and non-goals;
- dependencies and allowed paths;
- permission boundary;
- acceptance criteria;
- exact verification commands;
- required evidence and output format;
- instruction not to expand scope or declare the parent goal complete.

Use at most three concurrent subagents. Maintain one active writer per declared scope. Before a writer moves to `ACTIVE`, run `__SYNOD_COMMAND__ lease acquire <task-id> --owner-thread <thread-id>` with the narrowest repeatable `--write`, `--write-tree`, `--read`, and `--read-tree` scopes. Preserve the returned lease ID, generation, task revision, heartbeat timestamp, and owner together as the exact fence; use current returned values for heartbeat, release, worktree, revocation, and recovery commands instead of reconstructing them from chat.

For parallel implementation, use disjoint leases or an explicit detached task worktree. Create it outside the control checkout with `__SYNOD_COMMAND__ worktree create`, let only the leased worker edit it, then inspect `worktree status`, seal the proposal, transactionally integrate it, and move the exact revision to `REVIEW`. `worktree cleanup` is non-force and must run only after the detached checkout is clean; the proposal and registry remain durable.

Use `__SYNOD_COMMAND__ wait --thread <id>` to coordinate child completion. Prefer its notification or cursor mode when available, and inspect `fallbackPollCount`, timeout/abort, approval/user-input, warnings, and cleanup diagnostics before treating a child as quiescent.

## Review in a closed loop

Treat implementation output as a proposal, never as acceptance.

1. Let the configured implementer complete the atomic task and return changed paths, diff summary, tests, and uncertainties.
2. Have the supervisor inspect the actual diff against the contract and check for unrelated changes.
3. Have the supervisor run or reproduce the relevant deterministic verification instead of trusting the worker's claim.
4. If incomplete, send only the missing delta to the same worker.
5. Obey the task's canonical correction limit. At exhaustion, explicitly split or supersede it, or record an approved bounded override; do not start another ordinary round.
6. Let the supervisor accept and integrate only after the implementation and evidence satisfy the contract.
7. Move tasks through `PLANNED`, `READY`, `ACTIVE`, `REVIEW`, `ACCEPTED`, `VERIFIED`, and `DONE`. Only the supervisor changes acceptance states.

After integration, use `synod_verifier` when an independent pass materially reduces risk. The supervisor adjudicates its `PASS`, `FAIL`, or `INCONCLUSIVE` result and performs the final deterministic checks directly.

If a worker stops or its lease expires, preserve its exact scoped delta through `lease revoke` or `lease expire`, then record one explicit `lease recover` decision: resume the same owner, reassign a replacement owner, or supersede the proposal. Use the ended generation's exact fence. Recovery does not accept, verify, or discard the proposal.

## Respect risk boundaries

Proceed automatically with read-only inspection, contracted workspace edits, and local deterministic checks. Keep the worker inside its write scope. Pause for user confirmation before consequential external actions such as publishing, deploying, spending money, mutating production data, adding a production dependency, or performing destructive work.

Do not retry an ambiguous external mutation until its actual state has been inspected.

## Checkpoint durable memory

Update `docs/synod/` after phase transitions and before stopping, pausing, compacting, or handing off:

- `GOAL.md`: change only when scope or completion criteria change.
- `PLAN.md`: update task state, dependencies, agent assignment, and evidence links.
- `STATE.md`: record branch, exact `HEAD`, dirty paths, verified facts, accepted delegations, blockers, and one next executable action.
- `DECISIONS.md`: append durable decisions and their rationale.
- `WORKLOG.md`: append only material events and concise verification evidence.

Never claim a test, deploy, or behavior applies to a different revision than the one actually verified. Do not rely on active subagents surviving between sessions.
