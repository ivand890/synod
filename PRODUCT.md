# Product

## Register

product

## Users

Synod is for maintainers and supervisors of Codex projects who need delegated
work to stay bounded, reviewable, and recoverable. Implementers, explorers,
reviewers, verifiers, and mechanical workers operate under the supervisor's
task contracts; release operators consume the evidence while retaining separate
ownership of Git hosting, publication, and deployment.

These users work in a repository and terminal during long or interrupted
multi-phase changes. They need exact commands, machine-readable output, and
honest answers about what is authorized, what was observed, what remains
incomplete, and what can be recovered.

## Product Purpose

Synod installs a persistent, reviewed advisor loop in a Codex project. Its
version-pinned runtime coordinates atomic tasks, scoped reserve-and-bind writer
leases, task-aware waits, proposals, acceptance, verification, and durable
local evidence. Canonical task and lease state lives in the local `.synod`
records; Git and observed runtime behavior remain the technical truth.

The primary supervisor remains responsible for planning, integration, review,
and final evidence. Synod makes authority boundaries explicit, including the
separation between host, App Server, and canonical wait authority. The strict
`JobHandle` and `JobEvent` contracts in 0.9.3 are validation-only durable
shapes: they do not add persistence, runners, process ownership, spawn/resume
observation, or an execution plane.

The public `v0.12.1` release supports the corrected Codex delegation paths. On
a supported Codex CLI without an injected adapter, `delegate start` selects
Synod's owned
CLI App Server Path A for read-only observer turns only. Writer leases stay
host-owned: Desktop and Codex CLI return `hostSpawnRequired` so the supervisor
calls `spawn_agent`, then `delegate complete --owner-thread`. An injected
`HostDelegationAdapter` remains supported for host-owned spawn identity, bind
authorization, wait observation, and lease liveness. Desktop returns an
explicit host spawn/wait handoff and never starts a child App Server;
unsupported or non-Codex contexts fail closed. Synod does not claim broad
execution ownership. Proposal evidence also keeps independent Git lanes:
`proposalAdded`, `gitTracked`, `staged`, and `committed` are separate facts,
not one completion signal. The 0.9.5 hotfix, retained since 0.11.0, also makes the `--task`,
`--active-only`, and `--changed-since-checkpoint` selectors work through an
initialized project-local bootstrap while incompatible selector combinations
still fail closed. The public release requires Node.js `>=22`, and its Codex
support expression accepts every valid semantic version whose numeric major and
minor are `0.148`, including stable, patch, prerelease, and build-metadata
variants; `0.148.0-alpha.9` is known-good. Future source increments remain
unavailable to a pinned runtime until a corresponding release and explicit
project runtime upgrade.

Human-owned Markdown under `docs/synod/` is local/private supporting context,
not canonical orchestration state, Git evidence, or release proof. The five
allowlisted notes (`GOAL.md`, `PLAN.md`, `STATE.md`, `DECISIONS.md`, and
`WORKLOG.md`) become portable only through the explicit, hash-verified
`--include-local-docs` recovery-bundle path; generated `STATUS.md` remains a
local projection and is never exported as proof.

Success means an operator can follow the lifecycle from `READY` through
reservation, read-only spawn, bind, explicit authorization, wait, proposal,
acceptance, verification, and `DONE` without guessing. `DONE` proves only the
recorded local delivery, acceptance, and verification transitions. It does not
claim a commit, push, deployment, external approval, or operational outcome.

## Brand Personality

Synod is precise, calm, and accountable.

- **Precise:** stable names, exact revisions, explicit authority, and commands
  that fail closed when their fence is stale or incomplete.
- **Calm:** bounded waits, clear incomplete states, and no theatrical progress
  claims when a host or external observer still owns the next step.
- **Accountable:** every meaningful status is tied to durable evidence and an
  identifiable owner; local completion is never presented as release proof.

## Anti-references

- An autonomous agent swarm that claims success from chat activity instead of
  reviewable evidence.
- A hosted black box that uploads repository state or telemetry by default and
  hides the authority behind a progress dashboard.
- A release or deployment autopilot that silently mutates Git, production, or
  paid providers.
- A decorative dashboard that uses color, motion, or large metrics to imply
  completion while omitting the exact revision, lease, or observer boundary.
- Editable Markdown, stale version labels, or copied lease values treated as
  canonical state.
- Operator examples that jump directly into `ACTIVE` without reserve and bind.

## Design Principles

1. **Evidence before status:** show the exact revision, owner, authority, and
   evidence before presenting a state as complete.
2. **Make authority legible:** distinguish reservation, bind, explicit
   authorization, transport, host observation, App Server observation, and
   canonical selection instead of collapsing them into one progress signal.
3. **Local and reversible by default:** keep state local, avoid implicit network
   or production mutations, preserve proposals and recovery material, and fail
   closed on ambiguity.
4. **Small contracts, bounded recovery:** make the next legal action explicit,
   keep correction rounds finite, and preserve a stopped worker's proposal
   rather than silently accepting or discarding it.
5. **Documentation follows runtime truth:** operator guidance, product context,
   release metadata, and tests must agree with the released package and its
   observed boundaries. Advisor policy describes what the supervisor should
   attempt; runtime output and persisted events describe what actually
   happened. Policy cannot be presented as an owner-continuity or publication
   guarantee.

## Accessibility & Inclusion

Synod is CLI- and documentation-first, so accessibility starts with semantic
text and JSON rather than color or timing. Use descriptive headings, readable
code examples, stable field names, explicit error remediation, and text
alternatives for diagrams. Never require color perception, animation, or a
fast observer response to understand task state.

Interactive documentation should target WCAG 2.2 AA where applicable, support
keyboard and screen-reader navigation, preserve visible focus, and honor
reduced-motion preferences. Dense evidence should remain scannable for people
with low vision or cognitive load constraints, while machine-readable output
supports assistive tooling and automation. Examples should avoid locale- or
timezone-dependent assumptions and should state when a host-owned observation
still requires an operator or platform action.
