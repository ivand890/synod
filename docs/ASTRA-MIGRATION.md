# GPT-6 Astra migration and advisor policy

Released with Synod `0.13.0`, verified 2026-09-05. Synod `0.12.2`
does not include the `synod-astra` profile.

## Model policy

| Role | Model | Reasoning effort |
| --- | --- | --- |
| Advisor / supervisor | `gpt-6-astra` | `high`; planning `xhigh` |
| Implementer | `gpt-5.6-luna` | `max` |
| Explorer | `gpt-5.6-terra` | `medium` |
| Reviewer / verifier | `gpt-5.6-terra` | `high` |
| Mechanical | `gpt-5.6-luna` | `medium` |
| Untyped subagent fallback | `gpt-5.6-terra` | `max` |

The migration changes the advisor model and preserves the previous role efforts
and worker routing. This follows OpenAI's advice to preserve effective reasoning
effort when migrating. Astra supports the selected efforts. See the
[official migration guidance](https://developers.openai.com/api/docs/guides/latest-model)
and [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra).

Fresh CLI initialization chooses `synod-astra` only when the active App Server
reports every required model and effort. Otherwise it chooses the compatible
`synod-5.6` tiered profile, then the existing `portable` fallback with a warning
when neither tiered profile can be confirmed. Explicit profile selections and
existing installations remain authoritative. `doctor` also requires a supported
Codex runtime before recommending a profile. Initialization's model selection is
not proof of runtime compatibility.

## Efficient use of the advisor

Use Astra at decision boundaries: architecture, task contracts, disputed findings,
correction decisions, integration judgment, and final assessment of evidence.
Luna performs bounded implementation; Terra gathers independent evidence.
The advisor must not substitute its own judgment for a required independent
reviewer or verifier record.

1. Read status and the canonical handoff on resume, then dispatch from the current
   exact next action. Use summary receipts and open only the evidence needed for
   a decision. Refresh actions after relevant state changes.
2. Give workers self-contained contracts with relevant paths and evidence. Avoid
   full-history forks and duplicate investigations. Keep at most three concurrent
   subagents and preserve writer ownership and path isolation.
3. Wait for changes using the correct host or App Server authority. Ordinary
   no-change timeouts need no new investigation. Keep user progress updates brief.
4. Run required and risk-relevant checks. Repeat them for changed code or unresolved
   failures. Require actual delivery and separate acceptance and verification.
5. Respect configured budget, correction, and rotation gates. Use the existing
   `budget report`, `rotation suggest`, and closed-interval `usage --by-model`
   commands at meaningful boundaries; do not add automatic caps or rotations.
6. Complete authorized preparation before asking about an unapproved external
   action. Honor prior authorization for the same scope. For a small undelegated
   change, record a local-work exception if dispatch would cost more than the work;
   never take over a live worker's scope.

These are Synod operating recommendations, not measured Astra savings. Start with
the preserved `high`/`xhigh` baseline. In a subsequent controlled pilot compare
`synod-5.6` against `synod-astra` on bounded implementation, cross-module planning,
review with a seeded defect, and interrupted-worker recovery. Hold the Codex
version, task, worker models, and acceptance criteria constant. Compare correctness
and recovery first, then accepted tasks per elapsed time, correction rounds,
advisor input/output tokens, coordination calls, waits, and compactions. Test a
lower advisor effort separately only after the baseline meets the same criteria.

## Skills, instructions, and hook audit

Scope: every project-owned template and agent instruction, model selector,
delegation adapter, package hook, and GitHub workflow. Unrelated global skills
and personal Codex settings are outside this repository migration.

| Surface | Finding and disposition |
| --- | --- |
| `src/profiles.ts` | Added preferred Astra advisor profile; retained both previous profiles and all worker roles. |
| `src/cli.ts`, `src/doctor.ts` | Removed hard-coded preference; capability discovery includes advisor planning effort and worker requirements. |
| `.codex/config.toml` template | Renders Astra advisor independently of worker defaults. Concurrency stays at three. |
| Five `.codex/agents/*.toml` templates | Reviewed implementer, explorer, mechanical, reviewer, verifier. Bounded contracts and existing sandboxes retained; no hard-coded flagship or incompatible effort. |
| `synod-advisor/SKILL.md` | Added selected advisor identity, concise evidence, change-driven supervision, bounded testing, and authorization continuity. Resolved the local-work exception without allowing takeover of a delegated scope. |
| Skill `agents/openai.yaml` | Default prompt now renders the installed profile and advisor identity. |
| Managed `AGENTS.md` block | Removed redundant next-action lookup; added compact supervision and independent-evidence guidance. |
| Five `docs/synod` note templates | Reviewed goal, plan, decisions, state notes, worklog; retain user ownership, canonical-state boundaries, and profile placeholders. Existing notes are never rewritten by this migration. |
| Host delegation and CLI App Server adapters | Resolve worker models through the installed profile; no model hard-coding to migrate. Retain bind authorization, read-only Path A, and effective-worker validation. |
| Codex hooks / notification config | No repository-managed hooks or notification scripts found. No new model-calling hooks added. |
| `package.json` hooks | `prepare` and `prepack` build TypeScript. No model invocation or production dependency change. |
| `.github` workflows and policy | Reviewed CI, publish workflow, Dependabot, PR template, and CODEOWNERS. No model selectors; existing compatibility and protected release gates retained. |
| Pricing and usage | Existing dated price example remains historical. Astra is unpriced by it; do not substitute Sol rates. |

Synod communicates with Codex App Server rather than constructing direct OpenAI
API requests. No sampling, cache, tool schema, authentication, or endpoint change
is needed in Synod for this profile. Astra's API tool calls require Responses,
but that transport belongs to Codex. The source does not add async API tools or
mid-conversation reasoning updates. See the
[official migration guidance](https://developers.openai.com/api/docs/guides/latest-model).

The current price schema has only uncached input, cached input, and output rates;
it cannot account for Astra cache-write charges or per-request long-context
multipliers. Therefore this migration does not add a purported full Astra billing
estimate. See the [Astra pricing reference](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Activation and limits

For an installed consumer project, use a release that contains this change:

```bash
pnpm dlx @ivand890/synod@0.13.0 upgrade --profile synod-astra --dry-run
pnpm dlx @ivand890/synod@0.13.0 upgrade --profile synod-astra
```

Review conflicts before applying; modified managed files still require an explicit
overwrite decision. Reload project instructions and start or select the configured
advisor in the harness. Editing templates cannot switch an already-running task.

The source checkout has retained `.synod` records but no installed manifest or
active `.codex`/`.agents` configuration. This migration updates the distributable
source, without installing over those records or editing personal settings.

The 2026-09-05 Desktop model probe observed all three profiles as compatible,
including Astra. The accompanying compatibility increment admits exact CLI
`0.153.4` and `0.152.1` builds and Desktop `0.153.4`, with generated-schema and
metadata probes, durable usage reconciliation, and persisted worker profile
validation. See [Codex compatibility](CODEX-COMPATIBILITY.md) for the maintained
lines, surface-specific evidence, promotion gate, and remaining limits.

No live Astra generation, comparative quality/cost pilot, commit, PR, publication,
or deployment is implied by source validation.

Validation covers build/typecheck, capability selection, effort requirements,
rendered instructions, record-preserving upgrades, and explicit unpriced Astra
usage. The package smoke exercises an installed tarball migration from
`synod-5.6` to `synod-astra`, a non-mutating dry run, preserved canonical state,
and retained Luna worker routing. Runtime evidence is recorded in the
[compatibility notes](CODEX-COMPATIBILITY.md).
