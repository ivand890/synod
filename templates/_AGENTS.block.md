<!-- synod:start -->
## Synod advisor loop

Use the project skill `$synod-advisor` for multi-phase, delegated, or cross-session work.

- Treat Git and observed runtime behavior as technical truth.
- Treat `.synod/state.json` as canonical orchestration state and `.synod/events.jsonl` as its append-only audit log. Read `docs/synod/STATUS.md` as the generated durable human view.
- Treat `docs/synod/GOAL.md` and `DECISIONS.md` as supporting human-owned context, not as substitutes for canonical task state.
- Invoke normal Synod commands through the version-pinned bootstrap `__SYNOD_COMMAND__`; do not require a global `synod` command or execute a cached `node_modules` path directly. For a runtime version upgrade, explicitly select the target with `pnpm dlx @ivand890/synod@<target-version> upgrade [directory]` instead of reusing the installed version.
- At session start, run `__SYNOD_COMMAND__ status`; stop and reconcile or checkpoint any reported branch, `HEAD`, or working-tree drift before continuing.
- Keep the primary advisor responsible for architecture, planning, atomic task contracts, supervision, review, integration, and final verification.
- Delegate routine implementation to `synod_implementer`; use the configured explorer and reviewer agents for analysis and escalation.
- Select configured custom agents by name with a fresh, no-history fork and a complete task contract. Omit explicit model and reasoning overrides so the custom agent file or `[agents]` defaults resolve them. Do not treat the explicit override list as the complete custom-agent catalog, but keep the global default on a spawn-supported model because Codex validates it before applying the custom-agent layer.
- Do not use the supervising model as the default implementation worker. It may make only a minimal integration repair when delegation would cost more than the change, and must record the exception.
- Create tasks through `__SYNOD_COMMAND__ task add` with an ID, executor, acceptance criteria, and verification commands. Move them only through `__SYNOD_COMMAND__ task transition`.
- Before any writer moves to `ACTIVE`, acquire a canonical task lease with the narrowest exact path/tree scopes and the worker's thread ID. Use the returned lease ID, generation, task revision, heartbeat timestamp, and owner as one exact fence for every heartbeat, release, worktree, or review mutation; never reconstruct stale values.
- Treat every implementation result as a proposal: the supervisor must inspect its diff, record delivery evidence for the exact task revision, and send corrections back to the same worker before acceptance. Obey the task's canonical correction allowance; at exhaustion, explicitly supersede, split, or record an approved bounded override instead of starting another ordinary round.
- If a writer stops, revoke or expire its exact lease and explicitly resume, reassign, or supersede the sealed proposal. Do not discard the delta, advance acceptance, or start an unfenced replacement implicitly.
- Record acceptance and verification separately for the same exact revision. A task may reach `DONE` only after both are recorded.
- Maintain one active writer per scope. Use disjoint leases or `worktree create` for parallel writes; seal and transactionally integrate the task proposal before review, and use non-force `worktree cleanup` only after the detached checkout is clean.
- Use `__SYNOD_COMMAND__ wait` for delegated thread completion. Prefer its notification/cursor result and inspect bounded polling, timeout, approval, user-input, and cleanup diagnostics before continuing.
- Run `__SYNOD_COMMAND__ checkpoint` only after intentionally accepting the current Git/worktree state. Update the canonical record before stopping, pausing, compacting, or handing off.
<!-- synod:end -->
