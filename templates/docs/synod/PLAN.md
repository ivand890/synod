# Synod Execution Plan

Allowed states: `PLANNED`, `READY`, `ACTIVE`, `REVIEW`, `ACCEPTED`, `VERIFIED`, `DONE`, `BLOCKED`, `SUPERSEDED`.

Only the primary advisor changes acceptance states. An implementation agent may report delivery but cannot mark its task accepted, verified, or done.

## Phases

1. Define the goal and run capability preflight.
2. The supervisor decomposes work into atomic implementation contracts and dependencies.
3. The configured worker implements by default; the supervisor reviews, corrects, integrates, and verifies.
4. Complete the goal against the original criteria.

## Tasks

| ID | Objective | Depends on | Advisor | Executor | Write scope | State | Revision | Evidence |
|---|---|---|---|---|---|---|---:|---|
| T-001 | Define the first atomic implementation contract | — | supervisor | — | read-only | PLANNED | 0 | — |

## Delegation contract

For every delegated task record its objective, non-goals, allowed paths, permission boundary, acceptance criteria, verification commands, and required evidence before spawning an agent. Use `synod_implementer` with the selected profile by default. Record any escalation or exceptional implementation performed directly by the supervisor.
