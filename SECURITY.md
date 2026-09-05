# Security Policy

## System and scope

Synod is a local trust layer for agent work. It coordinates a human operator, a Codex-compatible harness, the Synod supervisor, delegated workers, repository state, and external systems that the work may touch.

The caller and operating system authorize whether Synod starts and what permissions the process receives. Repository content, Git metadata, paths, recovery bundles, canonical state, host and App Server responses, child-agent output, package registries, and other external inputs must be treated as untrusted.

This policy covers the Synod CLI, its installed project runtime and templates, `.synod` state and recovery artifacts, delegation and lease protocols, proposal review and verification, release tooling, and the documented operator workflow in this repository.

## Reporting a vulnerability

Please report suspected vulnerabilities through a private GitHub security advisory for this repository. Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, impact, reproduction steps, relevant configuration, and any suggested mitigation. Do not include credentials, private source code, or raw recovery bundles. Redact repository contents, prompts, paths, host identifiers, and other sensitive local data unless a maintainer explicitly requests them through the private advisory.

Maintainers aim to acknowledge a report within five business days. Investigation and remediation time depend on severity, exploitability, and release risk; this policy does not promise a fixed remediation SLA. Coordinated disclosure should wait until a fix or documented mitigation is available.

## Supported versions

| Version | Security support |
| --- | --- |
| Latest version published to npm | Supported |
| Default branch and unreleased source | Reviewed as development code, but not a published compatibility or security contract |
| Older published versions | Unsupported unless a security advisory says otherwise |

Upgrade to the latest published version before reporting behavior that may already be fixed. Source tests or local builds do not prove that a published package contains the same fix.

## Threat model and trust boundaries

Synod assumes the local operator controls the machine, repository, harness, and credentials used to run it. It is designed to reduce accidental or confused-deputy failures between an operator, supervisor, workers, Git state, and host adapters. It is not designed to defend against a malicious local administrator, a compromised operating system, or a harness that can silently bypass the protocol while retaining equivalent filesystem and process permissions.

The main trust boundaries are:

- Human intent: the operator authorizes the outcome and any consequential external action.
- Harness and host: the caller starts processes and supplies local permissions, model access, thread identity, and host responses.
- Synod supervisor: the supervisor plans, delegates, reviews, accepts, verifies, and closes work.
- Workers: delegated agents operate only within explicit task, revision, lease, and path scopes; their output is evidence, not self-approval.
- Repository and local artifacts: Git state, `.synod` state, bundles, paths, and file contents are inputs to validate, not authority by themselves.
- External systems: registries, GitHub, network services, deployment targets, and paid providers retain their own authentication and authorization boundaries.

## Security invariants

Synod's protocol is intended to preserve these invariants:

- Path handling stays within the selected project or explicitly named destination. Inputs are normalized and validated before filesystem mutation.
- Destructive lifecycle operations preserve user-owned or modified content unless an explicit force or restore contract authorizes replacement.
- Recovery bundles are bounded, verified before restore, and do not implicitly include ignored generated state or human-owned local notes.
- Stored digests detect accidental change and bind exact artifacts or revisions. Hashes are integrity checks, not signatures and not proof of authorship or publisher identity.
- Writer authority is bound to an exact task, revision, lease identifier, generation, owner identity, and path scope.
- A delegated worker cannot accept, verify, or complete its own delivery. Proposal acceptance and independent verification are separate decisions.
- Budget, lease, and wait checks occur before reservation, spawn, bind, mutation, or dispatch side effects that they are meant to gate.
- Recovery from expired, revoked, empty, or abandoned work is explicit and bounded; it does not silently accept the proposal.
- User content and unrelated working-tree changes are preserved and remain outside a task unless explicitly brought into scope.
- `DONE` records local protocol completion. It does not by itself prove merge, publication, deployment, registry parity, provider action, or any other external fact.

Synod does not upload project state, source content, prompts, recovery bundles, or usage telemetry by default. Network access occurs only when the operator invokes a command whose purpose requires it, such as package installation, release verification, or a harness or host integration.

## Sensitive local data

Treat `.synod` and any exported recovery bundle as sensitive local data. Depending on the workflow, they may reveal repository paths, task objectives, evidence references, Git metadata, thread or host identifiers, usage records, proposal contents, and copies of tracked or explicitly included local files.

Do not publish these artifacts, attach them to public issues, or share them with third parties without inspecting and redacting them. Keep them under the same access controls as the repository they describe. Never store credentials, access tokens, private keys, payment data, or unrelated personal data in task objectives, evidence strings, state, or bundles.

## Execution and sandbox boundary

Synod is a coordination and evidence protocol, not an operating-system sandbox. Commands, adapters, hooks, package managers, tests, and child processes run with the permissions granted to the invoking harness or user. Path scopes and leases express protocol authority; they do not prevent a malicious or compromised process with filesystem access from bypassing those controls.

Use operating-system isolation, least-privilege credentials, branch protection, CI policy, code review, secret scanning, deployment approvals, and provider-specific controls where those protections are required. Synod does not replace them.

## Reportable findings and severity context

Security reports are especially useful when they demonstrate that Synod can:

- escape an intended project, destination, or restore boundary through crafted paths, archives, links, or metadata;
- overwrite or delete user-owned content without the documented explicit authorization;
- bypass task, revision, lease, generation, owner, path, budget, acceptance, or verification fences;
- confuse host handles, App Server thread identifiers, or worker identities in a way that grants authority to the wrong actor;
- accept tampered state, proposals, bundles, release evidence, or managed content as authentic or current;
- expose repository contents, prompts, state, bundles, identifiers, usage records, or credentials across an unintended boundary;
- execute an external mutation that the operator did not authorize; or
- make a materially false security or release claim that downstream automation can trust as proof.

Severity depends on required local privileges, whether the behavior crosses a documented trust boundary, the sensitivity and breadth of exposed or modified data, interaction requirements, persistence, and the availability of a practical mitigation.

## Out of scope

The following are generally out of scope unless they show that Synod weakens or bypasses a documented boundary:

- arbitrary command execution by an operator who intentionally asks the harness to run that command with their own permissions;
- behavior that requires a malicious local administrator, compromised operating system, or already-compromised harness with equivalent access;
- secrets deliberately placed in repository files, prompts, task evidence, environment variables, logs, or bundles contrary to this policy;
- availability or correctness failures in third-party model providers, registries, GitHub, deployment platforms, or other external services;
- social engineering, prompt quality, model accuracy, and worker mistakes that remain subject to normal supervisor review and verification; and
- unsupported older versions when the issue is not present in the latest published release.

A finding is still in scope if one of these conditions is used to cross a Synod-enforced boundary, gain authority assigned to another actor, or create evidence that Synod incorrectly treats as trusted.

## Known limitations

- Synod cannot protect against a malicious local administrator, compromised operating system, or harness that can directly modify the same files and processes.
- Protocol path scopes and leases are not kernel-enforced sandbox controls.
- Local hashes and sealed bundles provide integrity evidence, not cryptographic publisher identity or non-repudiation.
- A passing source or build test does not prove that npm, GitHub, a registry, or another public runtime contains the same bytes.
- Local `ACCEPTED`, `VERIFIED`, or `DONE` state does not prove that a pull request merged, a release published, a deployment succeeded, or an external provider applied a change.
- The safety of commands executed through a harness still depends on the harness, its configuration, granted permissions, credentials, and the operator's review of consequential actions.
