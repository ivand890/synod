# Codex compatibility: current and previous minor lines

Unreleased source policy, reviewed 2026-09-05. Published Synod `0.12.2` retains
its original compatibility contract. `0.153.x` and `0.152.x` are minor lines;
the semantic major is still `0`.

## Supported execution window

| Surface | Current line: 0.153 | Previous line: 0.152 |
| --- | --- | --- |
| CLI | Exact `0.153.4` | Exact `0.152.1` |
| Desktop | Exact `0.153.4` bundled executable | Not validated; not admitted |

Maintain two lines, admitting only tested patches within them. New patches,
previews, custom builds, unknown surfaces, and versions outside this window
are unsupported. A successful CLI probe cannot admit a Desktop build.
`doctor` reports the policy, active surface, executable, version, and validated
patches separately from model/effort availability. Synod-owned CLI execution
rejects an unvalidated runtime before creating a worker thread. Read-only
diagnostics and historical usage/recovery parsing remain available.

On promotion to `0.154`, maintain `0.154` and `0.153` and remove `0.152` from the
execution allowlist in the same change. Keep historical rollout readers and
fixtures: execution support and the ability to read old evidence are separate
contracts. Model availability is still capability-probed on every installation.

## Features adopted from the latest releases

- **Astra advisor:** `gpt-6-astra/high`, planning `xhigh`; Luna and Terra retain
  bounded implementation and evidence work. See [advisor policy](ASTRA-MIGRATION.md).
- **Durable usage:** prefer `token_usage_record.usage` for each response and
  suppress the matching legacy cumulative event in either order. Response IDs
  deduplicate repeated durable records; thread IDs prevent charging child records
  to a parent. Adjacent matching response counters also identify mirrors when
  legacy cumulative totals diverge after compaction. Preserve old cumulative
  history, model attribution, counter epochs,
  context snapshots, and already-closed report boundaries. Conflicts, malformed
  counters, and coverage gaps mark evidence incomplete rather than invent totals.
- **Restart metadata:** compare the current line's `Thread.model` and
  `Thread.reasoningEffort` with the installed worker profile after a worker turn.
  Null, missing, or mismatched values fail the check. The previous line has no such
  fields and reports `profileValidation: unavailable`; it still requires the
  existing live effective-settings validation. These fields describe configuration,
  not proof of task completion or per-response execution telemetry. No
  `thread/resume` is used to inspect a worker. The receipt identifies its source:
  unloaded threads use persisted turn context; a retained, loaded owner exposes
  current settings. Synod does not restart that owner just to obtain metadata.
- **Host clarification:** use async clarification when the host exposes it.
  Templates do not assume that every runtime has the tool.

Experimental context management remains off by default in Codex; Synod does not
enable it in this change. Persisted approvals, larger MCP output controls, and
thread shell timeouts may benefit the hosting Codex runtime, but this increment
does not add Synod controls or infer new execution authority from them. Raw usage
metadata does not make the current price schema an accurate Astra bill estimate.

Source: [official Codex changelog](https://learn.chatgpt.com/docs/changelog),
entries for `0.152.1`, `0.153.0`, and `0.153.4`, plus the generated schemas from
the exact binaries below. The `0.153.4` entry includes Astra picker/default fixes.

## Validation and promotion

The CLI CI matrix runs exact `0.152.1` and `0.153.4` packages on Linux and macOS.
It passes an absolute `SYNOD_CODEX_BIN` so nested package-manager PATH changes
cannot silently test a different installed binary. Each probe uses temporary
Codex state without credentials and performs initialize, model/list, thread/list,
schema generation, thread/start, loaded thread/read, and a metadata-only read
after restarting the App Server. It never invokes turn/start or model generation.
A named task with no executed turn has null persisted profile fields on `0.153`;
the probe asserts this distinction instead of treating requested settings as proof.

Run the same probe against an actual Desktop bundle with
`SYNOD_EXPECTED_CODEX_SURFACE=desktop`; this is a separate manual gate because
GitHub-hosted CLI jobs do not contain the actual Desktop bundle. Preserve
the host's Desktop originator for that probe. For an isolated CLI probe launched
from Desktop, unset `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` for that command only.

```bash
env -u CODEX_INTERNAL_ORIGINATOR_OVERRIDE \
  SYNOD_CODEX_BIN=/absolute/path/to/codex \
  SYNOD_EXPECTED_CODEX_VERSION=0.153.4 \
  SYNOD_EXPECTED_CODEX_STATUS=known-good \
  SYNOD_EXPECTED_DOCTOR_HEALTHY=true \
  pnpm test:codex-compatibility
```

Local probes on 2026-09-05 use isolated npm CLI packages for both admitted
versions and `/Applications/ChatGPT.app/Contents/Resources/codex` for Desktop
`0.153.4`. Unit tests cover metadata matches/mismatches, previous-line absence,
unvalidated execution rejection, and Desktop host handoff without constructing
a worker App Server. Usage tests use a sanitized observed durable record shape.
The packed migration checks preserve canonical state and worker routing.

Local validation passed: all 545 tests (`pnpm test`, including build/typecheck),
`pnpm test:package`, and the three exact-version protocol probes above. A frozen
real session-log snapshot reconciled all 98 durable response observations to
Codex's thread total with no invalid token records, including shifted legacy
totals after compaction. No session contents or account metadata are committed.

Before admitting another patch, review its official notes and generated schema,
update the exact surface allowlist and CI matrix, then pass the relevant adapter,
usage, host-handoff, full-suite, and package checks. Actual Desktop evidence is
required for a Desktop pin. No live Astra quality/cost comparison, completed
model-generated worker pilot, publication, or hosted CI result is claimed by
these local protocol checks.
