# Synod State Notes

Canonical machine-readable state is `.synod/state.json`. Its append-only audit log is `.synod/events.jsonl`, and `STATUS.md` is the generated human view. Do not use this notes file to override task state, acceptance, verification, or checkpoints.

## Initial objective

Initialize the durable project goal and execution plan.

## Capability preflight

- Project instructions: unchecked
- Build command: unknown
- Test command: unknown
- Required tools and services: unchecked
- Configured implementation worker: unchecked
- External credentials: unverified
- Pre-existing user changes: unchecked

## Verified facts

- Synod project files were initialized at template version __SYNOD_VERSION__.
- The selected model profile is __SYNOD_PROFILE__; the primary agent supervises atomic implementation.

## Active delegations

None.

## Drift policy

Run `synod status`. Reconcile unexpected drift or explicitly accept the current branch, `HEAD`, and working-tree fingerprint with `synod checkpoint`.

## Blockers

The project goal and completion criteria are not defined.

## Next executable action

Read the repository instructions, inspect Git state, and replace the draft sections in `GOAL.md` with an agreed objective and measurable completion criteria.

## Notes

Keep only contextual notes here. Record exact revision evidence through validated task transitions.
