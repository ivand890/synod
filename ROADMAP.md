# Synod Roadmap

Last updated: 2026-08-30

Operator promise: a human states the outcome once. Synod gives the harness a bounded, recoverable path from request to independently verified local delivery; the agent carries protocol mechanics while humans retain product decisions and all external authority.

Category: local trust layer for consequential agent work, with an operator-first interface.

North-star metric: the share of substantial outcomes completed and independently verified without protocol-level human intervention; the target is zero protocol-level human intervention per production-shaped task. Report the intervention count and evidence reference; token totals and external actions are separate measures.

Current release truth:

- Current public release: `v0.12.2`.
- Current source release: `v0.12.2`.
- Last verified public release at this update: `v0.12.2`.
- The signed tag commit is `0ae623f4537daaa62278e70ae077b3231578a88e`; the matching GitHub Release is externally immutable (`isImmutable: true`).
- Matching records are [RELEASE-CLOSEOUT.json](RELEASE-CLOSEOUT.json) and [release-closeouts/v0.12.2.json](release-closeouts/v0.12.2.json).
- Public proof covers npm/GitHub/registry-installed package parity, attestation/provenance, clean consumer install, and a separate public CLI check; source preparation is not public proof.
- The runtime requires Node `>=22` and supports Codex numeric minor lines `0.148` and `0.150`; the untested `0.149.x` gap fails closed, and `0.148.0-alpha.9` is known-good.
- See [RELEASING.md](RELEASING.md) for release procedure and [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md) for dated release archaeology.

This is the forward roadmap. It does not turn source preparation into a published runtime or treat a historical task ID as a new commitment. Delivered v0.6 through v0.12 chronology, release-specific task tables, compatibility notes, closeout facts, and provenance are preserved in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

## Direction

Synod is a local trust layer for agents that do consequential work. The sequence below moves from an invisible, reliable operator loop to accepted programs, portable proof, and bounded teams. Each horizon has an outcome gate; a later horizon cannot claim an earlier gate by implication.

## 1. Invisible Loop — v1

Outcome: the operator asks for an outcome, and a supported harness completes the local protocol without making the operator learn leases, fences, or wait authority.

Capabilities:

- A fresh supervisor follows the executable path from task creation through host-owned delegation, task-aware wait, proposal submission, acceptance, independent verification, and `DONE` using canonical next actions.
- Blocked-by dependencies, path-scoped ownership, exact worktree fences, and reviewed return to the requested worktree are fail-closed surfaces.
- Worker interruption, empty delivery, stale ownership, and a new root session produce typed recovery choices without advancing acceptance or discarding a sealed proposal.
- The harness records enough per-task evidence to report the north-star metric without reconstructing protocol state from chat.

v1 exit gate:

- Three real production-shaped pilots run on released, pinned package artifacts across at least three repositories: this repository, a different domain, and at least one repository operated by someone other than the author.
- Current blocked-by/worktree continuation is source-only: publish it in a pinned `@ivand890/synod@0.12.x` package before pilots start; source-checkout behavior alone is not pilot evidence. Pilots exercise that artifact, including a forced interruption and recovery in a new root session.
- Independent verification reproduces the reviewed result and exact relevant worktree identity for every pilot; adversarial ownership and recovery cases fail closed.
- A security review covers leases, recovery bundles, write scopes, uninstall-preservation boundaries, and the no-telemetry default.
- All three pilots complete with zero protocol-level human intervention: no manual fence copying, lease repair, owner substitution, or undocumented supervisor implementation. Product decisions, review decisions, and external approvals remain human-controlled and are not protocol interventions.

Dependencies: the verified `v0.12.2` contract, the publication condition in the v1 exit gate, a harness adapter that owns spawn and wait identity, and the existing canonical state, lease, recovery, and review surfaces.

Deliberate non-goals:

- v1 does not authorize autonomous merge, push, deployment, secret mutation, payment, provider spending, or any other external action.
- v1 does not add a second harness, a background execution plane, or a mutating MCP server.
- v1 does not call a green local test, `DONE`, or a token reduction a substitute for independent evidence.

## 2. Programs

Outcome: an operator submits a natural-language substantial outcome and receives a progressively refined dependency graph whose goals and constraints are accepted by humans before execution.

Capabilities:

- Synod accepts a natural-language substantial outcome, identifies assumptions and constraints, and proposes a progressively refined dependency graph of outcome-level work rather than asking the operator to author a workflow.
- Each refinement presents the goal, constraints, dependencies, and expected evidence for explicit human acceptance before the graph can advance.
- Independent ready leaves dispatch automatically within configured capacity, path scopes, and lease fences; blocked or over-capacity leaves remain queued and cannot be guessed into execution.
- A concise human decision queue shows only unresolved goal, constraint, approval, or recovery decisions; protocol mechanics stay out of that queue.
- Program runs retain checkpoints, provenance, budgets, and decision history so a rerun resumes from the last verified boundary without replaying completed work.

Measurable gate:

- Three natural-language substantial outcomes across at least two repositories produce progressively accepted graphs with explicit goals, constraints, dependencies, evidence, and stop conditions.
- Each run automatically dispatches every independent ready leaf only within configured capacity, while blocked, conflicting, or over-capacity leaves remain visibly queued and fail closed.
- The decision queue contains every unresolved human decision and no routine lease, wait, or fence operation; no run emits an unexplained protocol-level intervention.

Dependencies: the Invisible Loop exit gate, canonical task/recovery evidence, capacity and path-ownership enforcement, and a stable local graph format.

Deliberate non-goals:

- Programs are not reusable workflow templates or a static macro library; the graph must be proposed from the operator's stated outcome and constraints.
- No program may accept its own goal or constraints, hide a human decision, or dispatch outside an explicit capacity and ownership boundary.
- No unattended background job runner, unbounded self-modification, or automatic phase rotation.
- No program may silently merge, publish, deploy, spend, or contact an external provider.

## 3. Portable Trust

Outcome: a result can leave its originating chat and worktree with enough portable evidence for another verifier to reproduce what was reviewed and what was delivered.

Capabilities:

- Recovery and evidence bundles bind source identity, relevant worktree content, canonical task/event identity, policy decisions, and verifier results.
- Independent tools can verify signatures or hashes, detect tampering, distinguish source preparation from public publication, and reject unsafe or incomplete material before restore.
- Trust reports make local delivery, Git integration, external approval, deployment, and operational verification separate facts.

Measurable gate:

- Two independent verifiers reconstruct the same reviewed fingerprint from a clean checkout; tampered, incomplete, wrong-base, unsafe-path, and stale material fail closed before mutation.
- Every v1 pilot and every program run has a portable evidence reference that an independent verifier can consume without the original transcript.

Dependencies: the Invisible Loop and Programs gates, canonical hash-chained events, exact worktree identity, and an explicit verification tool.

Deliberate non-goals:

- No default upload of project state or telemetry to a Synod service and no hosted trust claim that replaces Git, CI, code review, or protected release evidence.
- No trust score based on raw token totals or an assumption that provenance implies permission to act.

## 4. Agent Teams

Outcome: accepted Programs coordinate bounded agents across repositories and organization boundaries while remaining local-first and preserving human authority.

Capabilities:

- Cross-repository dependency graphs connect outcomes, repositories, owners, release boundaries, and evidence without collapsing them into one worktree.
- Organization policy and approval boundaries are evaluated before dispatch; policy owners can require different evidence or decisions for different repositories and environments.
- Multiple human decision owners can accept goals, constraints, policy exceptions, and external approvals through the concise decision queue; no single operator identity is silently substituted.
- Independent agents work in non-overlapping lanes, exchange portable evidence, and hand off at verified boundaries; conflicts and stale owners fail closed.
- Optional local or self-hosted operational visibility shows team health, capacity, decisions, and evidence without requiring a hosted control plane.

Measurable gate:

- A production-shaped cross-repository program with at least three bounded roles completes across three repositories and two human decision owners with zero overlapping writes, zero unreviewed cross-lane integration, and a successful interruption/reassignment drill.
- Organization policy and approval boundaries are exercised for every repository, and every delivered outcome has independent verification and a portable evidence reference.
- The same run completes with local-only operation and with optional self-hosted operational visibility enabled; neither mode requires a hosted service or protocol-level human intervention.

Dependencies: Portable Trust, Programs with cross-repository dependency and decision semantics, the Invisible Loop harness boundary, and explicit organization policy contracts.

Deliberate non-goals:

- Optional local/self-hosted visibility is not a hosted control plane or a reason to upload project state by default.
- Teams do not gain autonomous merge, push, deployment, secret mutation, payment, provider spending, or other external authority.
- No larger team count, extra model profile, decorative dashboard, or new lifecycle vocabulary is a roadmap outcome by itself.

## Dependency order and release-proof boundary

The order is strict: Invisible Loop → Programs → Portable Trust → Agent Teams. A horizon may ship incrementally, but its gate is not satisfied by source preparation, a local green test run, or a historical closeout.

| Horizon | Exit evidence | Depends on |
|---|---|---|
| Invisible Loop (v1) | 3 real production-shaped pilots across 3 repositories, interruption recovery, independent verification, security review, and 0 protocol-level interventions | Verified v0.12.2 contract and the pinned-publication condition above |
| Programs | 3 natural-language substantial outcomes across 2 repositories with accepted graphs and explicit stop conditions | Invisible Loop |
| Portable Trust | 2 independent verifiers reproduce fingerprints and reject tampered material | Invisible Loop, Programs |
| Agent Teams | 3 bounded roles across 3 repositories, 2 human decision owners, 0 overlapping writes, and portable evidence | Portable Trust |

Historical release evidence is not a future commitment; current release proof is summarized above and detailed in the linked closeout and history records.
