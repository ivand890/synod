<!-- synod:start -->
## Synod advisor loop

Use the project skill `$synod-advisor` for multi-phase, delegated, or cross-session work.

- Treat Git and observed runtime behavior as technical truth.
- Treat `docs/synod/GOAL.md`, `PLAN.md`, `STATE.md`, and `DECISIONS.md` as the durable operational record.
- At session start, load that record and verify it against the current branch, `HEAD`, working tree, and relevant tests.
- Keep the primary advisor responsible for architecture, planning, atomic task contracts, supervision, review, integration, and final verification.
- Delegate routine implementation to `synod_implementer`; use the configured explorer and reviewer agents for analysis and escalation.
- Do not use the supervising model as the default implementation worker. It may make only a minimal integration repair when delegation would cost more than the change, and must record the exception.
- Treat every implementation result as a proposal: the supervisor must inspect its diff, run the relevant checks, and send corrections back to the same worker before acceptance.
- Maintain one active writer per worktree. Use exclusive paths or separate worktrees for parallel delegated writes.
- Update the durable record before stopping, pausing, compacting, or handing off.
<!-- synod:end -->
