# Synod Decisions

Append decisions. Do not rewrite earlier entries silently; supersede them with a new decision.

## D-001 — Durable state is authoritative operational memory

Date: initialization
Status: accepted

### Decision

Use `docs/synod/` as the durable operational record. Treat chat transcripts and generated memories as supporting context only.

### Rationale

Threads can be compacted, memories can be delayed, and the working tree can change between sessions.

### Consequence

Verify checkpoints against Git and runtime evidence whenever work resumes.

## D-002 — Cost-efficient agents perform implementation

Date: initialization
Status: accepted

### Decision

Use Sol for architecture, decomposition, supervision, review, integration, and final verification. Delegate atomic implementation to Luna Max by default and escalate to Terra only when task complexity or failed correction rounds justify it.

### Rationale

Sol's highest-value contribution is judgment and control of the loop. Spending Sol on routine implementation defeats the cost-efficiency objective of the advisor pattern.

### Consequence

Every implementation task needs a bounded contract, write scope, acceptance criteria, and verification commands. Sol inspects and tests each result but does not routinely author it.
