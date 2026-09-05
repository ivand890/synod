---
name: synod-advisor
description: Run or resume Synod's persistent, cost-efficient advisor loop for complex Codex projects. Use when a supervising model should own architecture, planning, review, and verification while delegating atomic implementation to the configured worker profile, when work spans multiple phases or sessions, or when the project must advance through documented checkpoints and correction rounds.
---

# Synod Advisor

The operator is the supervising agent. A human asks for work; you run Synod.

Use `__SYNOD_COMMAND__` for normal commands. This version-pinned bootstrap restores the project-local runtime. To upgrade, use `pnpm dlx @ivand890/synod@<target-version> upgrade [directory]`.

## Session start

1. Run `__SYNOD_COMMAND__ status`. Reconcile or checkpoint any reported branch, `HEAD`, or working-tree drift before continuing.
2. In a fresh root session run `__SYNOD_COMMAND__ handoff --json --view summary`, then run `__SYNOD_COMMAND__ task next --json --view summary` and execute the returned `argv`. Do not load `STATE.md`.
3. Do not load README, PRODUCT, ROADMAP, STATE notes, or closeout archives by default. Canonical state is `.synod/state.json`. `docs/synod/STATUS.md` is the generated human view if needed.

## Golden path

```text
task add → delegate start → wait --task → proposal submit
        → ACCEPTED → VERIFIED → DONE
```

Use the current receipt's complete next action; when it has none, or after a state change invalidates it, run `__SYNOD_COMMAND__ task next --json --view summary`. Execute the returned `argv`. Do not reconstruct reservation tokens, generations, reserved-at timestamps, or baseline hashes from chat. Stale fences fail closed.

- READY: `delegate start` with the narrowest `--write` / `--read` scopes.
- Writer `delegate start` without an injected adapter returns `hostSpawnRequired`. Call `spawn_agent` with the returned read-only contract, then `delegate complete --owner-thread <id>`. Desktop and Codex CLI writers stay host-owned. CLI Path A is read-only.
- After `delegate complete` succeeds, call `followup_task` for the exact returned `ownerThread` with explicit bind authorization before `wait --task`. `followup_task` is required because it wakes an idle worker; a bind receipt or queued message does not prove the worker resumed.
- On Desktop without an injected adapter, that incomplete host handoff is expected. Do not start a child App Server.
- After bind: `wait --task <id>`. If `hostWaitRequired` is true, call `wait_agent` only for the exact `hostWaitHandles` (or legacy `hostWaitThreadIds`) returned. Keep `hostFallbackRequired` / `hostFallbackThreadIds` as compatibility aliases.
- Submit with `proposal submit --evidence` only when there is an in-scope owned delta. Empty delivery fails closed: `task.correct` or recover. Do not implement the worker's task yourself.
- If wait reports a dead owner while the lease is live, run the returned `lease.revoke` argv, then one typed `resume` / `reassign` / `supersede` recover action. Recovery does not accept or discard the sealed proposal.

## Advisor role

The selected advisor is `__SYNOD_SUPERVISOR_MODEL__` at `__SYNOD_SUPERVISOR_EFFORT__` effort (`__SYNOD_PLAN_EFFORT__` for planning). Keep architecture, contracts, review decisions, and final evidence assessment. Delegate routine implementation to `synod_implementer` with the selected profile, a complete atomic contract, and a fresh no-history fork. Omit explicit `model` and `reasoning_effort` spawn overrides. A full-history fork inherits the parent agent type. For a small, undelegated change, work locally when dispatch and review would cost more; record the exception before writing. Never take over a live worker's scope. If spawn model resolution fails, run `__SYNOD_COMMAND__ doctor` and explicitly select a compatible profile; do not silently substitute a model.

Use at most three concurrent subagents and one active writer per scope.

## Efficient supervision

- Wake for delivery, failure, a changed contract, or a required decision. Use change-driven waits and the current host handles; an ordinary no-change timeout is not a worker failure. Keep human progress updates brief without rereading unchanged state.
- Give each worker only its objective, bounded paths, acceptance criteria, verification command, and relevant evidence. Use explorer, reviewer, verifier, and mechanical roles for independent evidence work when it reduces elapsed work; avoid duplicate investigations and extra advisors for routine dispatch.
- Inspect summary receipts first; open full evidence only for the decision at hand. Return a concise decision, evidence references, unresolved risks, and next action instead of copying logs or restating the plan.
- Preserve the selected reasoning efforts as the migration baseline. Propose lower effort only after comparing representative outcomes; escalate for a specific unresolved risk, not every follow-up. Respect configured token budgets and rotation gates. Propose missing limits rather than inventing a cap or silently rotating.
- Complete authorized work using reasonable implementation choices. Ask only when missing information changes scope or correctness, or an action lacks required authorization. User instructions take precedence over skill guidance; if a skill forces a pause, link the exact file and quote the instruction.

## Review

Inspect the actual diff. Record delivery, acceptance, and verification separately. Use independent reviewer/verifier evidence where the contract requires it; the advisor's assessment cannot stand in for an independent actor's evidence. Run the contract's required checks and risk-relevant tests. Repeat or broaden checks only for changed code, failures, or unresolved risk. Obey the correction limit; at exhaustion split, supersede, or record an approved override. Recovery is a typed next action and does not accept or discard the proposal.

## Risk and checkpoint

Require user authorization for publish, deploy, spend, production mutation, or a new production dependency. Honor authorization already given for the same action and scope; when it is missing, finish authorized preparation before asking for the final action. Run `__SYNOD_COMMAND__ checkpoint` only after intentionally accepting the current Git/worktree state.
