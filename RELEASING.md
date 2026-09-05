# Releasing Synod

Synod publishes `@ivand890/synod` and its matching GitHub Release from GitHub Actions. npm uses trusted publishing through the protected `npm` environment; no npm publish token is stored in GitHub.

## Release truth and authority

Release authority is exact Git state, the phase-appropriate closeout record, and the protected workflow or closeout pull request that verifies it. Local tests, a tarball, a tag, or a green workflow are not public proof. Published tags and npm versions are immutable; corrections require a new patch version.

The public `v0.13.0` source is anchored by signed tag commit `e0696cdd2387395c73a5b8497cc085c041737c2d` and its externally immutable GitHub Release (`isImmutable: true`). Two-phase closeout has three checkpoints: prepare source, let the protected tag workflow publish it, then independently verify public evidence. The tag workflow validates phase 1 only; phase-2 live verifier runs on the protected closeout PR, not the tag workflow. The commands below are the protected release procedure for a future version.

## Phase 1: Prepare source

1. Branch from the latest `main`; update `package.json`, `CHANGELOG.md`, workflow/tests, and release documents. Merge the reviewed pull request into `main` after required CI is green.
2. Set the root closeout to `prepared`/`pending`: `sourcePreparation.status` is `prepared`, `publicVerification.status` and `documentation.status` are `pending`, `sourcePreparation.tagSha` is absent, and local tarball smoke is pending. The local tarball smoke belongs under `sourcePreparation.localPackageSmoke`; it cannot satisfy public verification.
3. Run phase-strict closeout validation before and at the tag boundary; malformed or mixed-phase records fail closed.

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the release version}"
release_tag="v$release_version"
release_tag_sha="${RELEASE_TAG_SHA:?Set RELEASE_TAG_SHA to the exact tag commit}"
pnpm exec tsx scripts/validate-release-closeout.ts --phase pre-tag --tag "$release_tag" --json
pnpm exec tsx scripts/validate-release-closeout.ts --phase tag --tag "$release_tag" --tag-sha "$release_tag_sha" --json
```

## Phase 2: Protected publish

From reviewed `main`, create a signed annotated tag for the exact release commit and push only that tag:

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the next version}"
git switch main
git pull --ff-only origin main
git tag -s "v$release_version" -m "v$release_version"
git push origin "v$release_version"
```

The tag must equal the manifest version and be an ancestor of `origin/main`. The protected `Publish` workflow installs the pinned toolchain, runs `pnpm test` and `pnpm test:package`, validates the prepared/pending source closeout, creates or reuses a draft GitHub Release, and publishes to npm with trusted GitHub Actions credentials—not a stored npm token.

Only the oldest pending stable tag may publish after the remote tag set and npm/GitHub `latest` agree; per-tag concurrency deduplicates a rerun but is not a cross-version queue. GitHub Releases and npm are not an atomic transaction: npm may accept a package while a draft remains pending, but the workflow never succeeds with mismatched public state. Later tags remain gated until the prior tag is npm `latest` and the GitHub `Latest` release.

## Phase 3: Public verification and closeout

After publication, update the closeout only from a protected closeout PR. The read-only phase-2 live verifier runs on the protected closeout PR, compares recorded and live facts, and performs the clean registry consumer install and public CLI check:

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the published version}"
release_tag="v$release_version"
release_tag_sha="${RELEASE_TAG_SHA:?Set RELEASE_TAG_SHA to the exact tag commit}"
pnpm exec tsx scripts/verify-public-release-closeout.ts --file RELEASE-CLOSEOUT.json --tag "$release_tag" --tag-sha "$release_tag_sha" --repository ivand890/synod --json
```

Public evidence must bind the exact tag SHA to:

- npm version, `gitHead`, `latest`, `dist` integrity, attestation URL, and SLSA provenance;
- an immutable, published, non-prerelease GitHub Release with exact tag and SHA, plus npm/GitHub Latest parity;
- the registry-installed package result: a clean consumer install of the exact registry spec followed by `pnpm exec synod --version`; and
- a separate public `pnpm dlx @ivand890/synod@$release_version --version` check.

Only then may `sourcePreparation` be `closed`, `publicVerification` be `verified`, and matching `README.md`, `ROADMAP.md`, and `RELEASING.md` claims advance together. The root `RELEASE-CLOSEOUT.json` is the matching verified closeout record for `v0.13.0`; the root and matching versioned closeouts must be byte-identical.

## Failure and recovery

- Any mismatch, unavailable external state, or malformed/mixed-phase closeout fails closed; never mark a release verified from local evidence.
- Re-running the same tag may verify an existing npm version only when its `gitHead` is the exact tagged commit and may reuse the draft. Never republish, retarget, or overwrite a tag or version; any rerun that cannot prove exact public state must fail closed.
- If npm accepted a package before GitHub completed, keep the closeout pending and rerun the same protected workflow after public state is readable; npm and GitHub remain non-atomic.
- Recovery of an older published version explicitly uses `--latest=false` so it cannot displace the current GitHub Latest release; later releases remain gated by durable ordering and public parity.

## Historical evidence

Current `v0.13.0` evidence is in `RELEASE-CLOSEOUT.json` and `release-closeouts/v0.13.0.json`; previous `v0.12.2` evidence remains in `release-closeouts/v0.12.2.json`. The prior `v0.9.5` evidence is in `release-closeouts/v0.9.5.json`, bound to signed tag commit `494f1ebd85b1c51dde522e7a7ec6e334dadc4e30`; other historical pointers are `release-closeouts/v0.12.1.json`, `release-closeouts/v0.12.0.json`, and `release-closeouts/v0.11.0.json`. These pointers are historical evidence, not instructions to rerun old tag or publication commands.
