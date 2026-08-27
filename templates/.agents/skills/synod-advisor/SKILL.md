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

On every step run `__SYNOD_COMMAND__ task next --json --view summary` and execute the returned `argv`. Do not reconstruct reservation tokens, generations, reserved-at timestamps, or baseline hashes from chat. Stale fences fail closed.

- READY: `delegate start` with the narrowest `--write` / `--read` scopes.
- Writer `delegate start` without an injected adapter returns `hostSpawnRequired`. Call `spawn_agent` with the returned read-only contract, then `delegate complete --owner-thread <id>`. Desktop and Codex CLI writers stay host-owned. CLI Path A is read-only.
- After `delegate complete` succeeds, if `hostNotificationRequired` is true, call `send_message` or `followup_task` for the exact returned `ownerThread` with explicit bind authorization before `wait --task`. A bind receipt does not prove the worker was notified.
- On Desktop without an injected adapter, that incomplete host handoff is expected. Do not start a child App Server.
- After bind: `wait --task <id>`. If `hostWaitRequired` is true, call `wait_agent` only for the exact `hostWaitThreadIds`. Keep `hostFallbackRequired` / `hostFallbackThreadIds` as compatibility aliases.
- Submit with `proposal submit --evidence` only when there is an in-scope owned delta. Empty delivery fails closed: `task.correct` or recover. Do not implement the worker's task yourself.
- If wait reports a dead owner while the lease is live, run the returned `lease.revoke` argv, then one typed `resume` / `reassign` / `supersede` recover action. Recovery does not accept or discard the sealed proposal.

## Advisor role

Keep architecture, contracts, review, and verification. Delegate routine implementation to `synod_implementer` with the selected profile, a complete atomic contract, and a fresh no-history fork. Omit explicit `model` and `reasoning_effort` spawn overrides. A full-history fork inherits the parent agent type. Do not use the supervising model as the routine implementation worker except when delegation would cost more than the change; record that exception. If spawn model resolution fails, run `__SYNOD_COMMAND__ doctor` and upgrade the profile.

Use at most three concurrent subagents and one active writer per scope.

## Review

Inspect the actual diff. Record delivery, acceptance, and verification separately. Obey the correction limit; at exhaustion split, supersede, or record an approved override. Recovery is a typed next action and does not accept or discard the proposal.

## Risk and checkpoint

Pause for user confirmation before publish, deploy, spend, production mutation, or a new production dependency. Run `__SYNOD_COMMAND__ checkpoint` only after intentionally accepting the current Git/worktree state.
