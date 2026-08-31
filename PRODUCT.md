# Product

## Register

product

Category: local trust layer for consequential agent work, with an operator-first
interface.

Synod turns a human's substantial outcome into a bounded, reviewable,
recoverable path to independently verified local delivery.

## Users

The primary user is a human operator: a maintainer, technical lead, or
supervisor who states an outcome and remains responsible for
the decisions around it. Agents support that operator; they do not inherit
the operator's authority.

Jobs-to-be-done:

- State an outcome once and receive clear scope, acceptance, and verification.
- See what is planned, authorized, observed, incomplete, or blocked.
- Pause, correct, resume, or recover work without losing its evidence.
- Distinguish a verified local result from an external action or outcome.

## Product Purpose

Synod provides persistent local supervision for work that must be trusted. It
helps the operator move from intent to scoped work, independent review, and
verified local delivery while keeping Git, external distribution, deployment,
spending, and production decisions outside implicit product authority.

Trust boundaries are explicit:

- Human intent defines the desired outcome, scope, and approvals.
- The harness carries intent, invokes supervision, and reports observations.
- Synod's canonical local records decide which transitions are legal.
- Workers act only within current, explicitly granted scope and authority;
  chat labels and stale instructions authorize nothing.
- External systems and their actions remain under the operator's control and
  require their own confirmation and evidence.

Interruption is a normal product state. A restart, stopped worker, expired
authorization, stale state, timeout, budget boundary, or request for user
input must surface the next legal action and preserve incomplete evidence.
Synod never silently retries, replaces, accepts, or turns an interruption into
success.

North-star outcome: a human states a substantial outcome once, and a
production-shaped task reaches independently verified local delivery with
zero protocol-level human intervention. Product decisions, review decisions,
and external approvals remain human-controlled.

## Brand Personality

Synod is precise, calm, and accountable.

- **Precise:** use stable language, explicit authority, and evidence-backed
  status.
- **Calm:** make waits, interruptions, and incomplete states clear without
  theatrical progress claims.
- **Accountable:** tie meaningful status to durable evidence and an identifiable
  owner; local completion is never external proof.

## Anti-references

- An autonomous swarm that declares success from chat activity instead of
  reviewable evidence.
- A remote black box that uploads project state or telemetry by default and
  hides authority behind a progress dashboard.
- An autopilot that silently mutates Git, production, paid providers, or other
  external systems.
- A decorative dashboard that uses color, motion, or large metrics to imply
  completion while omitting the evidence boundary.
- Editable notes or copied values treated as canonical authority.

## Design Principles

1. **Evidence before status:** show the revision, owner, authority, and
   evidence before presenting a state as complete.
2. **Make authority legible:** distinguish human intent, observation, canonical
   selection, worker execution, and external action.
3. **Local and reversible by default:** keep state local, preserve recovery
   material, avoid implicit external mutation, and fail closed on ambiguity.
4. **Small contracts, bounded recovery:** make the next legal action explicit,
   keep correction bounded, and preserve stopped work for review.
5. **Documentation follows observed truth:** product guidance, delivery
   evidence, and tests must agree with what the product actually observes;
   policy is not proof of runtime ownership or an external outcome.

## Accessibility & Inclusion

Synod is text- and documentation-first. Use semantic headings, readable
examples, explicit remediation, and text alternatives for diagrams. Never
require color perception, animation, or a fast response to understand state.

Interactive documentation should target WCAG 2.2 AA where applicable, support
keyboard and screen-reader navigation, preserve visible focus, and honor
reduced-motion preferences. Keep evidence scannable for people with low vision
or cognitive-load constraints, and make machine-readable output usable by
assistive tooling.
