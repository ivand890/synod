# Releasing Synod

Synod publishes `@ivand890/synod` and its matching GitHub Release from GitHub Actions. npm uses trusted publishing; no npm publish token is stored in GitHub.

## Prepare a release

1. Create a branch from the latest `main`.
2. Update `package.json` to the intended semantic version.
3. Move the relevant entries from `Unreleased` into a dated section in `CHANGELOG.md` and update its comparison links.
4. Open a pull request and wait for the required CI check.
5. Merge the pull request into `main`.

## Publish

Update local `main`, then create a signed annotated tag for the exact release commit:

```bash
release_version=0.7.0
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
release_version=0.7.0
npm view @ivand890/synod version dist-tags --json
gh release view "v$release_version" --json tagName,isDraft,isPrerelease,url
gh release list --limit 1
pnpm dlx "@ivand890/synod@$release_version" --version
```

Published versions and release tags are immutable. Fixes require a new patch version.
