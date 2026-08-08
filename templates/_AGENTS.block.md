<!-- synod:start -->
## Synod advisor loop

Use the project skill `$synod-advisor` for multi-phase, delegated, or cross-session work.

- Treat Git and observed runtime behavior as technical truth.
- Treat `.synod/state.json` as canonical orchestration state and `.synod/events.jsonl` as its append-only audit log. Read `docs/synod/STATUS.md` as the generated durable human view.
- Treat `docs/synod/GOAL.md` and `DECISIONS.md` as supporting human-owned context, not as substitutes for canonical task state.
- At session start, run `synod status`; stop and reconcile or checkpoint any reported branch, `HEAD`, or working-tree drift before continuing.
- Keep the primary advisor responsible for architecture, planning, atomic task contracts, supervision, review, integration, and final verification.
- Delegate routine implementation to `synod_implementer`; use the configured explorer and reviewer agents for analysis and escalation.
- Do not use the supervising model as the default implementation worker. It may make only a minimal integration repair when delegation would cost more than the change, and must record the exception.
- Create tasks through `synod task add` with an ID, executor, acceptance criteria, and verification commands. Move them only through `synod task transition`.
- Treat every implementation result as a proposal: the supervisor must inspect its diff, record delivery evidence for the exact task revision, and send corrections back to the same worker before acceptance.
- Record acceptance and verification separately for the same exact revision. A task may reach `DONE` only after both are recorded.
- Maintain one active writer per worktree. Use exclusive paths or separate worktrees for parallel delegated writes.
- Run `synod checkpoint` only after intentionally accepting the current Git/worktree state. Update the canonical record before stopping, pausing, compacting, or handing off.
<!-- synod:end -->
