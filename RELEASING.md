# Releasing Synod

Synod publishes `@ivand890/synod` and its matching GitHub Release from GitHub Actions. npm uses trusted publishing; no npm publish token is stored in GitHub.

The public `v0.9.4` source is anchored by signed tag commit
`f116a38acffb86c752f6e5c3f8013407ecfea267` and its externally immutable GitHub
Release (`isImmutable: true`). Post-publication evidence is recorded in the
versioned `release-closeouts/v0.9.4.json`. The prior `v0.9.3` evidence is
recorded in versioned `release-closeouts/v0.9.3.json`, bound to signed tag
commit `ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788`. The root
`RELEASE-CLOSEOUT.json` is the prepared/pending `v0.9.5` candidate; it has no
public verification. Do not rerun historical tag or publication commands.
The phase-2 live verifier runs on the protected closeout PR, not the tag
workflow; the tag workflow validates only the strict prepared/pending source
record for the next release before publication.
The commands below remain the protected release procedure for a future version.

## Two-phase closeout

Release documentation advances in two explicit phases:

1. **Source preparation:** `package.json`, changelog, workflow, tests, and the
   release documents are reviewed on `main`; the root closeout for the next
   release is `prepared`/`pending` with no self-referential tag SHA. The
   protected workflow authenticates the exact tag, package version, and `main`
   ancestry, runs tests and package smoke, then validates that realizable
   pre-tag record.
2. **Public verification:** after the protected workflow publishes, record the
   exact npm `gitHead`, GitHub Release state, registry-installed package result
   (exact registry spec, `dist` integrity/attestation/provenance, and a clean
   consumer command), and public CLI result in `publicVerification`. Change the
   closeout status and the matching claims in `README.md`, `ROADMAP.md`, and
   `RELEASING.md` in the same post-publication commit. The phase-2 live verifier
   runs as a read-only gate on that protected closeout PR; it is not a tag
   workflow step and never publishes or edits external state.

An exact tag, a green workflow, or a local package build (`pnpm test:package`)
does not fill the second phase. The local tarball smoke belongs under
`sourcePreparation.localPackageSmoke`; it cannot satisfy `publicVerification`.
The closeout advances only after the external evidence is recorded in a
post-publication commit on `main`.

The shared strict validator accepts only these complete shapes:

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the release version}"
release_tag="v$release_version"
release_tag_sha="${RELEASE_TAG_SHA:?Set RELEASE_TAG_SHA to the exact tag commit}"
pnpm exec tsx scripts/validate-release-closeout.ts --phase tag \
  --tag "$release_tag" --tag-sha "$release_tag_sha" --json
pnpm exec tsx scripts/validate-release-closeout.ts --phase post-publication \
  --tag "$release_tag" --tag-sha "$release_tag_sha" --json
```

The tag phase requires `prepared`/`pending`, an absent tag SHA, and pending
local smoke. The post-publication phase requires exact `closed`/`verified`
statuses, the same tag SHA in source/npm/public evidence, immutable GitHub
release facts, npm provenance, a clean registry consumer check, and public CLI
parity. Malformed or mixed-phase records fail closed.

On the protected closeout PR, the verified branch invokes the read-only live
verifier after resolving the exact tag commit:

```bash
pnpm exec tsx scripts/verify-public-release-closeout.ts \
  --file RELEASE-CLOSEOUT.json --tag "$release_tag" \
  --tag-sha "$release_tag_sha" --repository ivand890/synod --json
```

It compares the recorded npm version, `gitHead`, `latest`, `dist` integrity,
attestation, and provenance with the live registry, compares the GitHub release
and latest-release facts through read-only `GH_TOKEN` API calls, then runs the
exact registry consumer install and public `pnpm dlx` CLI check. Any mismatch
fails closed; the tag workflow does not run this phase.

## Prepare a release

1. Create a branch from the latest `main`.
2. Update `package.json` to the intended semantic version.
3. Move the relevant entries from `Unreleased` into a dated section in `CHANGELOG.md` and update its comparison links.
4. Open a pull request and wait for the required CI check.
5. Merge the pull request into `main`.

## Publish

Update local `main`, then create a signed annotated tag for the exact release commit:

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the next version}"
git switch main
git pull --ff-only origin main
git tag -s "v$release_version" -m "v$release_version"
git push origin "v$release_version"
```

The tag must match the version in `package.json`. The protected `Publish` workflow verifies that the tagged commit belongs to `main`, runs the full test suite and package smoke test, prepares a draft GitHub Release, and publishes through the protected `npm` environment.

Every unpublished tag waits for a durable release turn derived from the complete remote tag set plus public npm/GitHub `latest` parity. The oldest pending stable tag is the only version allowed to publish. Per-tag concurrency deduplicates the same release, but the workflow does not treat GitHub Actions concurrency as a cross-version queue because pending runs can be cancelled and ordering is not guaranteed. A later tag cannot advance until the prior tag is both npm `latest` and the published GitHub `Latest` release.

After npm exposes the exact version and tagged `gitHead`, the workflow publishes the draft and verifies all of these invariants before it can succeed:

- the tagged npm version belongs to the exact Git commit;
- the matching GitHub Release exists and is neither a draft nor a prerelease;
- npm's `latest` dist-tag and GitHub's `Latest` release identify the same version;
- the npm `gitHead` for that latest version resolves to its Git tag.

GitHub Releases and npm do not share an atomic transaction. A failure after npm accepts a package can therefore leave a draft temporarily pending, but never a successful workflow with mismatched public state. Later releases remain gated. Re-running the same tag verifies the immutable npm `gitHead`, reuses the draft, and completes the release safely. Recovering an older already-published npm version explicitly uses `--latest=false` so it cannot displace the current GitHub Latest release.

Approve the `npm` environment deployment in GitHub, then verify the release:

```bash
release_version="${RELEASE_VERSION:?Set RELEASE_VERSION to the next version}"
npm view @ivand890/synod version dist-tags --json
gh release view "v$release_version" --json tagName,isDraft,isPrerelease,url
gh release list --limit 1
pnpm dlx "@ivand890/synod@$release_version" --version
```

Published versions and release tags are immutable. Fixes require a new patch version.
