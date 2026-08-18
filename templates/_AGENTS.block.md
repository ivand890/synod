<!-- synod:start -->
## Synod advisor loop

Use the project skill `$synod-advisor` for multi-phase, delegated, or cross-session work.

- Treat Git and observed runtime behavior as technical truth. Canonical state is `.synod/state.json`; `docs/synod/STATUS.md` is the generated human view.
- Invoke normal Synod commands through the version-pinned bootstrap `__SYNOD_COMMAND__`. Upgrade with `pnpm dlx @ivand890/synod@<target-version> upgrade [directory]`.
- At session start, run `__SYNOD_COMMAND__ status`; reconcile or checkpoint any reported branch, `HEAD`, or working-tree drift before continuing.
- A new root session continues with `__SYNOD_COMMAND__ handoff --json --view summary`, then `__SYNOD_COMMAND__ task next --json --view summary`, and executes the returned `argv`. Do not load `STATE.md`.
- Do not load README, PRODUCT, ROADMAP, STATE notes, or closeout archives by default.
- Keep the primary advisor responsible for architecture, planning, review, and verification. Delegate routine implementation to `synod_implementer` with the selected profile. Do not use the supervising model as the default implementation worker.
- Golden path: `task add` → `delegate start` → `wait --task` → `proposal submit` → `ACCEPTED` → `VERIFIED` → `DONE`.
- Run `__SYNOD_COMMAND__ task next --json --view summary` and execute the returned `argv`. Do not reconstruct fences from chat.
- If `hostSpawnRequired` is true, call `spawn_agent` with the returned `readOnlyContract`, then `delegate complete --owner-thread <id>`. On Desktop without an injected adapter, do not start a child App Server.
- If `hostWaitRequired` is true, call `wait_agent` only for the exact `hostWaitThreadIds`. Keep `hostFallbackRequired`/`hostFallbackThreadIds` as compatibility aliases.
- Empty delivery cannot be submitted. If wait returns `lease.revoke`, apply it and then a typed recover (`resume`, `reassign`, or `supersede`). Recovery does not accept the proposal.
- Submit delivery with `__SYNOD_COMMAND__ proposal submit <task-id> --evidence <ref> --json --view summary`. The proposal summary returns a typed exact-revision acceptance action. Acceptance and verification are separate.
- Run `__SYNOD_COMMAND__ checkpoint` only after intentionally accepting the current Git/worktree state.
<!-- synod:end -->
