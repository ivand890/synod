# Releasing Synod

Synod publishes `@ivand890/synod` from GitHub Actions with npm trusted publishing. No npm publish token is stored in GitHub.

## Prepare a release

1. Create a branch from the latest `main`.
2. Update `package.json` to the intended semantic version.
3. Move the relevant entries from `Unreleased` into a dated section in `CHANGELOG.md` and update its comparison links.
4. Open a pull request and wait for the required CI check.
5. Merge the pull request into `main`.

## Publish

Update local `main`, then create a signed annotated tag for the exact release commit:

```bash
release_version=0.3.2
git switch main
git pull --ff-only origin main
git tag -s "v$release_version" -m "v$release_version"
git push origin "v$release_version"
```

The tag must match the version in `package.json`. The protected `Publish` workflow verifies that the tagged commit belongs to `main`, runs the full test suite and package smoke test, and publishes through the protected `npm` environment.

Approve the `npm` environment deployment in GitHub, then verify the release:

```bash
release_version=0.3.2
npm view @ivand890/synod version dist-tags --json
pnpm dlx "@ivand890/synod@$release_version" --version
```

Published versions and release tags are immutable. Fixes require a new patch version.
