---
name: synod-advisor
description: Run or resume Synod's persistent, cost-efficient advisor loop for complex Codex projects. Use when Sol should supervise architecture, planning, review, and verification while delegating atomic implementation to Luna Max or another cheaper worker, when work spans multiple phases or sessions, or when the project must advance through documented checkpoints and correction rounds.
---

# Synod Advisor

Advance the project to its next verified checkpoint. Keep Sol in the supervisory loop and move routine implementation to cost-efficient workers while treating Git and runtime evidence as authoritative.

## Load durable state

1. Read `AGENTS.md` and all files under `docs/synod/`.
2. Inspect the current branch, `HEAD`, working-tree changes, and applicable build or test commands.
3. Compare observed state with `docs/synod/STATE.md`. Mark contradictions as drift and correct the checkpoint before relying on it.
4. If `GOAL.md` still contains an undefined objective or completion criteria, establish them with the user before implementation.

## Keep Sol in the advisor role

Keep the primary Sol agent responsible for the goal, architecture, plan, atomic task contracts, supervision, acceptance decisions, integration, and final verification. Do not use Sol as the routine implementation worker.

Delegate implementation whenever the work can be expressed as an atomic contract. Let Sol implement only when:

- no suitable worker is available;
- a tiny integration repair would cost more to delegate than to perform;
- the task cannot be isolated after a genuine decomposition attempt.

Record the reason for every Sol implementation exception in `STATE.md` or `DECISIONS.md`.

Prefer these project agents:

- `synod_implementer` for atomic implementation with Luna Max. Use this worker by default.
- `synod_explorer` for read-heavy mapping and evidence gathering.
- `synod_reviewer` for correctness, security, regressions, and test gaps.
- `synod_verifier` for an independent attempt to refute completion.
- `synod_mechanical` for clear, repetitive, high-volume read-only checks.

Escalate implementation from Luna Max to Terra High only after the task proves insufficiently specified, Luna returns a justified capability blocker, or two focused correction rounds fail. If a named agent or model is unavailable, use the closest cost-efficient agent with the same permission boundary and record the substitution in `STATE.md`.

## Delegate with a contract

Before any implementation, give the worker a stable task ID from `PLAN.md` and include:

- objective and non-goals;
- dependencies and allowed paths;
- permission boundary;
- acceptance criteria;
- exact verification commands;
- required evidence and output format;
- instruction not to expand scope or declare the parent goal complete.

Use at most three concurrent subagents. Maintain one active writer per worktree. For parallel implementation, use separate worktrees and disjoint write scopes. While `synod_implementer` is editing a worktree, Sol must supervise rather than edit the same files.

## Review in a closed loop

Treat implementation output as a proposal, never as acceptance.

1. Let Luna Max implement the atomic task and return changed paths, diff summary, tests, and uncertainties.
2. Have Sol inspect the actual diff against the contract and check for unrelated changes.
3. Have Sol run or reproduce the relevant deterministic verification instead of trusting the worker's claim.
4. If incomplete, send only the missing delta to the same worker.
5. Allow at most two correction rounds. Then split the task, escalate to Terra, or mark it blocked.
6. Let Sol accept and integrate only after the implementation and evidence satisfy the contract.
7. Move tasks through `PLANNED`, `READY`, `ACTIVE`, `REVIEW`, `ACCEPTED`, `VERIFIED`, and `DONE`. Only Sol changes acceptance states.

After integration, use `synod_verifier` when an independent pass materially reduces risk. Sol adjudicates its `PASS`, `FAIL`, or `INCONCLUSIVE` result and performs the final deterministic checks directly.

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
