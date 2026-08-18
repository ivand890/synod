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

For every delegated task record its objective, non-goals, allowed paths, permission boundary, acceptance criteria, verification commands, and required evidence before `delegate start`. On Codex without an injected adapter, `delegate start` reserves and returns `hostSpawnRequired`; call `spawn_agent` with the returned `readOnlyContract`, then `delegate complete --owner-thread`. On Desktop, do not start a child App Server. Use `task next` for the next complete command. Use `synod_implementer` with the selected profile by default. Record any escalation or exceptional implementation performed directly by the supervisor.
