# Synod Decisions

Append decisions. Do not rewrite earlier entries silently; supersede them with a new decision.

## D-001 — Durable state is authoritative operational memory

Date: initialization
Status: accepted

### Decision

Use `.synod/state.json` as canonical orchestration state, `.synod/events.jsonl` as the append-only audit record, and `docs/synod/STATUS.md` as the generated human view. Treat chat transcripts and generated memories as supporting context only.

### Rationale

Threads can be compacted, memories can be delayed, Markdown can be edited, and the working tree can change between sessions.

### Consequence

Run `synod status` whenever work resumes and record intentional checkpoint changes explicitly.

## D-002 — Cost-efficient agents perform implementation

Date: initialization
Status: accepted

### Decision

Use the configured supervising model for architecture, decomposition, supervision, review, integration, and final verification. Delegate atomic implementation to the selected cost-efficient worker and escalate only when task complexity or failed correction rounds justify it.

### Rationale

The supervising model's highest-value contribution is judgment and control of the loop. Spending it on routine implementation defeats the cost-efficiency objective of the advisor pattern.

### Consequence

Every implementation task needs a bounded contract, write scope, acceptance criteria, and verification commands. The supervisor inspects and tests each result but does not routinely author it.
