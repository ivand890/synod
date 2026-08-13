# Synod Execution Plan

Canonical tasks live in `.synod/state.json` and are changed only with `__SYNOD_COMMAND__ task add` and `__SYNOD_COMMAND__ task transition`. The generated current view is `STATUS.md`; use this file for human planning notes that have not yet become executable task contracts.

Allowed states: `PLANNED`, `READY`, `ACTIVE`, `REVIEW`, `ACCEPTED`, `VERIFIED`, `DONE`, `BLOCKED`, `SUPERSEDED`.

Only the primary advisor changes acceptance states. An implementation agent may report delivery but cannot mark its task accepted, verified, or done.

## Phases

1. Define the goal and run capability preflight.
2. The supervisor decomposes work into atomic implementation contracts and dependencies.
3. The configured worker implements by default; the supervisor reviews, corrects, integrates, and verifies.
4. Complete the goal against the original criteria.

## Candidate tasks

Record proposed decomposition here, then create each approved task in canonical state with its executor, acceptance criteria, verification commands, and dependencies.

## Delegation contract

For every delegated task record its objective, non-goals, allowed paths, permission boundary, acceptance criteria, verification commands, and required evidence before spawning an agent. Reserve the task's narrow scopes before spawn. The initial child contract must allow analysis/read-only inspection only and forbid writes, worktrees, and implementation commands until the supervisor binds the returned reservation to the new thread ID and explicitly confirms write authority. Cancel a failed spawn reservation, or expire it after its bounded TTL when no owner ID returns; unbound cleanup does not create abandoned-worker recovery. Synod cannot call Codex `spawn_agent`, so `delegate start` is intentionally deferred. Use `lease acquire` only when the owner thread is already known. Use `synod_implementer` with the selected profile by default. Record any escalation or exceptional implementation performed directly by the supervisor.
