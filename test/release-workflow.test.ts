import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextReleaseTag } from "../scripts/next-release-tag.js";
import {
  ReleaseCloseoutValidationError,
  validateReleaseCloseout,
  validateReleaseCloseoutFile,
} from "../scripts/validate-release-closeout.js";
import {
  compareGitHubRelease,
  compareNpmPublication,
  verifyPublicReleaseCloseout,
} from "../scripts/verify-public-release-closeout.js";
import { isRecord, parseJson } from "../src/validation.js";

const workflowPath = new URL("../.github/workflows/publish.yml", import.meta.url);
const ciWorkflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);
const packageSmokePath = new URL("../scripts/package-smoke.ts", import.meta.url);
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const roadmapPath = new URL("../ROADMAP.md", import.meta.url);
const roadmapHistoryPath = new URL("../docs/ROADMAP-HISTORY.md", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const productPath = new URL("../PRODUCT.md", import.meta.url);
const releasingPath = new URL("../RELEASING.md", import.meta.url);
const securityPolicyPath = new URL("../SECURITY.md", import.meta.url);
const closeoutPath = new URL("../RELEASE-CLOSEOUT.json", import.meta.url);
const archivedCloseoutPath = new URL("../release-closeouts/v0.9.3.json", import.meta.url);
const archivedPreviousCloseoutPath = new URL("../release-closeouts/v0.9.4.json", import.meta.url);
const archived095CloseoutPath = new URL("../release-closeouts/v0.9.5.json", import.meta.url);
const archivedPublishedCloseoutPath = new URL("../release-closeouts/v0.12.0.json", import.meta.url);
const archivedLatestCloseoutPath = new URL("../release-closeouts/v0.12.1.json", import.meta.url);
const archivedReleaseCloseoutPath = new URL("../release-closeouts/v0.12.2.json", import.meta.url);
const archivedCurrentCloseoutPath = new URL("../release-closeouts/v0.11.0.json", import.meta.url);
const archivedV011CloseoutSha256 = "20d384f89d687f7f4bcc7ad13aae523e7f913c2212e2eb52acb42d2b30e84e83";
const archivedV012CloseoutSha256 = "0d7d22ff06176979bc4f9bf3524f69a4d40c71dc8b85c7186237c07285ea91e0";
test("Git dependency build lifecycles do not require pnpm or Corepack", async () => {
  const packageJson = parseJson(await readFile(packagePath, "utf8"));
  assert.ok(isRecord(packageJson) && isRecord(packageJson.scripts));

  assert.equal(packageJson.scripts.prepack, "npm run build");
  assert.equal(packageJson.scripts.prepare, "npm run build");
  const buildScript = packageJson.scripts.build;
  assert.ok(typeof buildScript === "string");
  assert.doesNotMatch(buildScript, /\bpnpm\b/);
  assert.equal(packageJson.scripts.test, "pnpm typecheck && tsx scripts/test-suite.ts");
});

test("publish workflow cannot succeed without npm and GitHub Release parity", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /permissions:\n  contents: write\n  id-token: write/);
  assert.match(workflow, /group: publish-\$\{\{ github\.ref \}\}/);
  assert.doesNotMatch(workflow, /group: publish-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /name: Wait for durable release turn[\s\S]*next-release-tag\.ts[\s\S]*github_latest_tag/);
  assert.match(workflow, /Install dependencies[\s\S]*pnpm install --frozen-lockfile[\s\S]*Run tests/);
  assert.match(workflow, /name: Run source-preparation local package smoke[\s\S]*run: pnpm test:package/);
  assert.match(workflow, /name: Verify release identity[\s\S]*package_name[\s\S]*refs\/tags\/\$RELEASE_TAG\^\{commit\}[\s\S]*origin\/main/);
  assert.match(workflow, /name: Verify source closeout contract[\s\S]*scripts\/validate-release-closeout\.ts[\s\S]*--phase tag[\s\S]*--tag-sha/);
  assert.doesNotMatch(workflow, /Verify post-publication closeout when recorded/);
  assert.doesNotMatch(workflow, /--phase post-publication/);
  assert.doesNotMatch(workflow, /publication\.installedPackage/);
  const closeoutStart = workflow.indexOf("- name: Verify source closeout contract");
  const closeoutEnd = workflow.indexOf("- name: Inspect existing npm publication", closeoutStart);
  assert.ok(closeoutStart >= 0 && closeoutEnd > closeoutStart, "workflow closeout validation block must be present");
  const closeoutBlock = workflow.slice(closeoutStart, closeoutEnd);
  assert.match(closeoutBlock, /--phase tag/);
  assert.match(closeoutBlock, /--tag-sha "\$tagged_commit"/);
  assert.doesNotMatch(closeoutBlock, /0\.9\.3/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"[\s\S]*--draft[\s\S]*--verify-tag/);
  assert.match(workflow, /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=false/);
  assert.match(workflow, /--draft=false --latest=false/);
  assert.match(workflow, /npm view "@ivand890\/synod@\$package_version" gitHead/);
  assert.match(workflow, /releases\/latest" --jq \.tag_name/);
  assert.ok(workflow.includes('if [ "$published_git_head" != "$tagged_commit" ]; then'));
  assert.ok(workflow.includes("if: steps.npm_state.outputs.published != 'true'"));
  assert.ok(workflow.includes('if ! git fetch --force --tags origin; then release_state_ready=false; fi'));
  assert.ok(workflow.includes('! npm_latest="$(npm view @ivand890/synod dist-tags.latest --prefer-online)"'));
  assert.ok(workflow.includes('! github_latest_tag="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name)"'));
  assert.ok(workflow.includes('[ "$github_latest_tag" = "v$npm_latest" ] && [ "$RELEASE_TAG" = "$next_release_tag" ]'));
  assert.ok(workflow.includes('[ "$current_npm_git_head" = "$tagged_commit" ]'));
  assert.ok(workflow.includes('[ "$latest_npm_git_head" = "$latest_tagged_commit" ]'));
  const testIndex = workflow.indexOf("- name: Run tests");
  const smokeIndex = workflow.indexOf("- name: Run source-preparation local package smoke");
  assert.ok(testIndex >= 0 && smokeIndex > testIndex && closeoutStart > smokeIndex, "tests and package smoke must precede closeout validation");

  const orderedSteps = [
    "Inspect existing npm publication",
    "Wait for durable release turn",
    "Prepare GitHub Release draft",
    "Publish to npm",
    "Verify registry publication",
    "Publish GitHub Release",
    "Verify npm and GitHub release parity"
  ];
  let previousIndex = -1;
  for (const step of orderedSteps) {
    const stepIndex = workflow.indexOf(`- name: ${step}`);
    assert.ok(stepIndex > previousIndex, `${step} must follow the preceding release gate`);
    previousIndex = stepIndex;
  }
});

test("CI installs the pinned toolchain and smokes compiled packages on every supported runtime surface", async () => {
  const workflow = await readFile(ciWorkflowPath, "utf8");
  const packageJson = parseJson(await readFile(packagePath, "utf8"));

  assert.equal(workflow.match(/pnpm install --frozen-lockfile/g)?.length, 4);
  assert.ok(isRecord(packageJson) && isRecord(packageJson.engines));
  assert.equal(packageJson.engines.node, ">=22");
  const node20SelectorPattern =
    /node-version:\s*(?:20(?:\.(?:x|\d+)){0,2}|'20(?:\.(?:x|\d+)){0,2}'|"20(?:\.(?:x|\d+)){0,2}")(?=\s|$)/m;
  const node20Fixtures = [
    ["unquoted exact", "node-version: 20"],
    ["unquoted semver pattern", "node-version: 20.x"],
    ["unquoted full semver", "node-version: 20.0.0"],
    ["single-quoted semver pattern", "node-version: '20.x'"],
    ["double-quoted full semver", 'node-version: "20.0.0"']
  ] as const;
  for (const [label, node20Line] of node20Fixtures) {
    assert.match(node20Line, node20SelectorPattern, `${label} Node 20 regression fixture must be recognized`);
    assert.doesNotMatch(workflow, node20SelectorPattern, `CI must not contain ${label} Node 20`);
  }
  for (const nodeVersionLine of ["node-version: 200", "node-version: 120"]) {
    assert.doesNotMatch(nodeVersionLine, node20SelectorPattern, `not-Node-20 fixture must not be rejected: ${nodeVersionLine}`);
  }
  assert.match(workflow, /os: ubuntu-latest\n\s+node-version: 22/);
  assert.match(workflow, /os: ubuntu-latest\n\s+node-version: 24/);
  assert.match(workflow, /os: macos-latest\n\s+node-version: 24/);
  assert.match(workflow, /os: windows-latest\n\s+node-version: 24/);
  assert.match(workflow, /codex-version: "0\.152\.1"\n\s+expected-status: known-good/);
  assert.match(workflow, /codex-version: "0\.153\.4"\n\s+expected-status: known-good/);
  assert.doesNotMatch(workflow, /codex-version: "0\.1(?:4[0-9]|50)\./);
  assert.match(workflow, /SYNOD_CODEX_BIN/);
  assert.match(workflow, /run: pnpm test:package/);
  assert.match(workflow, /release-closeout:\n\s+name: Release closeout\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 30[\s\S]*fetch-depth: 0[\s\S]*pnpm install --frozen-lockfile/);
  assert.match(workflow, /name: Validate pending closeout locally[\s\S]*--phase pre-tag[\s\S]*--json/);
  assert.match(workflow, /name: Verify published closeout against public evidence[\s\S]*GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*scripts\/verify-public-release-closeout\.ts[\s\S]*--tag-sha/);
  const requiredStart = workflow.indexOf("  required:\n");
  assert.ok(requiredStart >= 0, "Required job must be present");
  const requiredBlock = workflow.slice(requiredStart);
  assert.match(requiredBlock, /needs:[\s\S]*- release-closeout/);
  assert.match(requiredBlock, /CLOSEOUT_RESULT: \$\{\{ needs\.release-closeout\.result \}\}/);
  assert.match(requiredBlock, /test "\$CLOSEOUT_RESULT" = "success"/);
});

test("installed-package smoke covers the production-shaped release contract", async () => {
  const packageSmoke = await readFile(packageSmokePath, "utf8");

  assert.match(packageSmoke, /runV09ProductionFixture/);
  assert.match(packageSmoke, /reviewer-archived/);
  assert.match(packageSmoke, /context_compacted/);
  assert.match(packageSmoke, /tokenCounters\.resets/);
  assert.match(packageSmoke, /setTaskBudgetPolicy/);
  assert.match(packageSmoke, /prepareProjectRotation/);
  assert.match(packageSmoke, /verifyProjectRotation/);
  assert.match(packageSmoke, /projectUsageCost/);
  assert.match(packageSmoke, /readFileSync\(statePath\)/);
  assert.doesNotMatch(packageSmoke, /expectedVersion === "0\.9\.3"/);
  assert.match(packageSmoke, /const installedTemplateVersion = "0\.0\.1"/);
});

test("security policy keeps release and execution boundaries fail-closed", async () => {
  const security = await readFile(securityPolicyPath, "utf8");
  const sections = [
    "System and scope",
    "Reporting a vulnerability",
    "Supported versions",
    "Threat model and trust boundaries",
    "Security invariants",
    "Sensitive local data",
    "Execution and sandbox boundary",
    "Reportable findings and severity context",
    "Out of scope",
    "Known limitations",
  ];
  let previousHeading = -1;
  for (const section of sections) {
    const heading = security.indexOf(`## ${section}`);
    assert.ok(heading > previousHeading, `SECURITY.md must keep ## ${section} in order`);
    previousHeading = heading;
  }

  assert.match(security, /private GitHub security advisory for this repository/);
  assert.match(security, /Do not\s+open a public issue for an unpatched vulnerability/);
  assert.match(security, /credentials, private source code, or raw recovery bundles/);
  assert.match(security, /acknowledge a report within five business days/);
  assert.match(security, /does not promise a fixed remediation SLA/);
  assert.match(security, /\| Latest version published to npm \| Supported \|/);
  assert.match(security, /\| Default branch and unreleased source \| Reviewed as development code, but not a published compatibility or security contract \|/);
  assert.match(security, /\| Older published versions \| Unsupported unless a security advisory says otherwise \|/);
  assert.doesNotMatch(security, /0\.12\.2/);

  for (const input of [
    "repository content",
    "Git metadata",
    "paths",
    "canonical state",
    "recovery bundles",
    "host and App Server responses",
    "child-agent output",
    "package registries",
  ]) {
    assert.match(security, new RegExp(input), `SECURITY.md must treat ${input} as untrusted`);
  }
  for (const boundary of [
    /Writer authority is bound to an exact task, revision, lease identifier, generation, owner identity, and path scope/,
    /A delegated worker cannot accept, verify, or complete its own delivery/,
    /Proposal acceptance and independent verification are separate decisions/,
    /Budget, lease, and wait checks occur before reservation, spawn, bind, mutation, or dispatch side effects/,
    /Recovery from expired, revoked, empty, or abandoned work is explicit and bounded/,
    /User content and unrelated working-tree changes are preserved/,
    /Hashes are integrity checks, not signatures and not proof of authorship or publisher identity/,
    /does not upload project state, source content, prompts, recovery bundles, or usage telemetry by default/,
    /Network access occurs only when the operator invokes a command whose purpose requires it/,
    /not an operating-system sandbox/,
    /run with the permissions granted to the invoking harness or user/,
    /Path scopes and leases express protocol authority/,
    /Synod does not replace them/,
  ]) {
    assert.match(security, boundary, `SECURITY.md must preserve ${boundary}`);
  }

  for (const finding of [
    /escape an intended project, destination, or restore boundary/,
    /overwrite or delete user-owned content without the documented explicit authorization/,
    /bypass task, revision, lease, generation, owner, path, budget, acceptance, or verification fences/,
    /confuse host handles, App Server thread identifiers, or worker identities/,
    /accept tampered state, proposals, bundles, release evidence, or managed content/,
    /expose repository contents, prompts, state, bundles, identifiers, usage records, or credentials/,
    /execute an external mutation that the operator did not authorize/,
    /make a materially false security or release claim/,
  ]) {
    assert.match(security, finding, `SECURITY.md must keep ${finding} reportable`);
  }
  assert.match(security, /generally out of scope unless they show that Synod weakens or bypasses a documented boundary/);
  assert.match(security, /A finding is still in scope if one of these conditions is used to cross a Synod-enforced boundary/);
  assert.match(security, /malicious local administrator/);
  assert.match(security, /Protocol path scopes and leases are not kernel-enforced sandbox controls/);
});

test("release source, roadmap/history, and product/docs contract stay explicit", async () => {
  const [packageText, changelog, roadmap, roadmapHistory, readme, product, releasing, archivedCloseoutText, closeoutText, archivedCurrentCloseoutText, archivedPublishedCloseoutText, archivedLatestCloseoutText, archivedReleaseCloseoutText, packageSmoke, archivedPreviousCloseoutText, archived095CloseoutText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(changelogPath, "utf8"),
    readFile(roadmapPath, "utf8"),
    readFile(roadmapHistoryPath, "utf8"),
    readFile(readmePath, "utf8"),
    readFile(productPath, "utf8"),
    readFile(releasingPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
    readFile(closeoutPath, "utf8"),
    readFile(archivedCurrentCloseoutPath, "utf8"),
    readFile(archivedPublishedCloseoutPath, "utf8"),
    readFile(archivedLatestCloseoutPath, "utf8"),
    readFile(archivedReleaseCloseoutPath, "utf8"),
    readFile(packageSmokePath, "utf8"),
    readFile(archivedPreviousCloseoutPath, "utf8"),
    readFile(archived095CloseoutPath, "utf8")
  ]);
  const packageJson = parseJson(packageText);
  const closeout = parseJson(archivedCloseoutText);
  const currentCloseout = parseJson(closeoutText);
  const archivedPublishedCloseout = parseJson(archivedPublishedCloseoutText);
  const archivedLatestCloseout = parseJson(archivedLatestCloseoutText);
  const archivedReleaseCloseout = parseJson(archivedReleaseCloseoutText);
  const archivedCurrentCloseout = parseJson(archivedCurrentCloseoutText);
  const archivedPreviousCloseout = parseJson(archivedPreviousCloseoutText);
  const archived095Closeout = parseJson(archived095CloseoutText);
  assert.ok(isRecord(packageJson));
  assert.ok(isRecord(closeout));
  assert.equal(packageJson.version, "0.13.0");
  assert.equal(closeout.schemaVersion, 1);
  assert.equal(closeout.package, "@ivand890/synod");
  assert.equal(closeout.version, "0.9.3");
  assert.equal(closeout.tag, "v0.9.3");
  assert.deepEqual(closeout.sourcePreparation, {
    status: "closed",
    tagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
    mainAncestorRequired: true,
    localPackageSmoke: {
      artifact: "local tarball",
      command: "pnpm test:package",
      status: "passed",
      version: "0.9.3"
    }
  });
  const publicVerification = closeout.publicVerification as Record<string, unknown>;
  assert.equal(publicVerification.status, "verified");
  assert.deepEqual(publicVerification.npm, {
    package: "@ivand890/synod",
    version: "0.9.3",
    gitHead: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
    latest: "0.9.3"
  });
  assert.deepEqual(publicVerification.githubRelease, {
    tag: "v0.9.3",
    url: "https://github.com/ivand890/synod/releases/tag/v0.9.3",
    publishedAt: "2026-08-14T19:29:39Z",
    isDraft: false,
    isPrerelease: false,
    isImmutable: true,
    isLatest: true
  });
  assert.equal(publicVerification.installedPackage, undefined, "local smoke must not masquerade as public evidence");
  assert.deepEqual(publicVerification.registryInstalledPackage, {
    spec: "@ivand890/synod@0.9.3",
    dist: {
      integrity: "sha512-U9NagkGCOWXHQ3giKEBRaD87UGI6hwAn7Emd5sJwdhr6Qp10zdWHe+DGrNz1iSjkXzxczSzYd6RsivKwtQAa7w==",
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.9.3",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" }
      }
    },
    consumerCommand: "pnpm add --ignore-scripts --save-exact @ivand890/synod@0.9.3",
    verification: { command: "pnpm exec synod --version", status: "passed", version: "0.9.3" },
    status: "passed",
    version: "0.9.3"
  });
  assert.equal((publicVerification.publicCli as Record<string, unknown>).status, "passed");
  assert.equal((closeout.documentation as Record<string, unknown>).status, "verified");
  assert.deepEqual((closeout.documentation as Record<string, unknown>).paths, ["README.md", "ROADMAP.md", "RELEASING.md"]);

  assert.ok(isRecord(currentCloseout));
  assert.equal(
    createHash("sha256").update(archivedCurrentCloseoutText).digest("hex"),
    archivedV011CloseoutSha256,
    "v0.11.0 closeout archive must remain byte-stable",
  );
  assert.equal(
    createHash("sha256").update(archivedPublishedCloseoutText).digest("hex"),
    archivedV012CloseoutSha256,
    "v0.12.0 closeout archive must remain byte-stable",
  );
  assert.equal(currentCloseout.version, "0.13.0");
  assert.equal(currentCloseout.tag, "v0.13.0");
  validateReleaseCloseout(currentCloseout, { phase: "pre-tag", expectedVersion: "0.13.0", expectedTag: "v0.13.0" });
  assert.ok(isRecord(archivedReleaseCloseout));
  assert.equal(archivedReleaseCloseout.version, "0.12.2");
  assert.ok(isRecord(archivedReleaseCloseout.sourcePreparation));
  assert.equal(archivedReleaseCloseout.sourcePreparation.tagSha, "0ae623f4537daaa62278e70ae077b3231578a88e");
  assert.ok(isRecord(archivedLatestCloseout));
  assert.equal(archivedLatestCloseout.version, "0.12.1");
  assert.equal(archivedLatestCloseout.tag, "v0.12.1");
  assert.ok(isRecord(archivedLatestCloseout.publicVerification));
  assert.equal(archivedLatestCloseout.publicVerification.status, "verified");
  assert.notDeepEqual(currentCloseout, archivedLatestCloseout);
  assert.notDeepEqual(currentCloseout, archivedPublishedCloseout);
  assert.notDeepEqual(currentCloseout, archivedCurrentCloseout);
  assert.ok(isRecord(archivedPreviousCloseout));
  assert.equal(archivedPreviousCloseout.version, "0.9.4");
  assert.equal(archivedPreviousCloseout.tag, "v0.9.4");
  assert.ok(isRecord(archived095Closeout));
  assert.equal(archived095Closeout.version, "0.9.5");
  assert.equal(archived095Closeout.tag, "v0.9.5");

  assert.ok(isRecord(archivedCurrentCloseout));
  assert.equal(archivedCurrentCloseout.schemaVersion, 1);
  assert.equal(archivedCurrentCloseout.package, "@ivand890/synod");
  assert.equal(archivedCurrentCloseout.version, "0.11.0");
  assert.equal(archivedCurrentCloseout.tag, "v0.11.0");
  assert.deepEqual(archivedCurrentCloseout.sourcePreparation, {
    status: "closed",
    tagSha: "a120f958f7bd86bf4efeebbf1dd8f88019da1ab8",
    mainAncestorRequired: true,
    localPackageSmoke: {
      artifact: "local tarball",
      command: "pnpm test:package",
      status: "passed",
      version: "0.11.0",
    },
  });
  const currentPublicVerification = archivedCurrentCloseout.publicVerification as Record<string, unknown>;
  assert.deepEqual(currentPublicVerification.npm, {
    package: "@ivand890/synod",
    version: "0.11.0",
    gitHead: "a120f958f7bd86bf4efeebbf1dd8f88019da1ab8",
    latest: "0.11.0",
  });
  assert.deepEqual(currentPublicVerification.githubRelease, {
    tag: "v0.11.0",
    url: "https://github.com/ivand890/synod/releases/tag/v0.11.0",
    publishedAt: "2026-08-18T18:25:08Z",
    isDraft: false,
    isPrerelease: false,
    isImmutable: true,
    isLatest: true,
  });
  assert.deepEqual(currentPublicVerification.registryInstalledPackage, {
    spec: "@ivand890/synod@0.11.0",
    dist: {
      integrity: "sha512-ilqxLExPly9TqUQhErcK5DOball/DmTQEG9ISpirtcAxTC6nhH4G298lg/cAz4A74lSLnz6Gc9Jk/zkOif0NUQ==",
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.11.0",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    consumerCommand: "pnpm add --ignore-scripts --save-exact @ivand890/synod@0.11.0",
    verification: { command: "pnpm exec synod --version", status: "passed", version: "0.11.0" },
    status: "passed",
    version: "0.11.0",
  });
  assert.deepEqual(currentPublicVerification.publicCli, {
    command: "pnpm dlx @ivand890/synod@0.11.0 --version",
    status: "passed",
    version: "0.11.0",
  });
  assert.deepEqual(archivedCurrentCloseout.documentation, {
    status: "verified",
    paths: ["README.md", "ROADMAP.md", "RELEASING.md"],
    rule: "Advance these paths together only when publicVerification is verified.",
  });

  assert.match(changelog, /^## \[0\.12\.2\] - 2026-08-27$/m);
  assert.match(changelog, /selects `synod-5\.6` when every required model/);
  assert.match(changelog, /opaque host handles, exact Codex thread UUIDs/);
  assert.match(changelog, /Task-aware waits and host delegation boundaries now refresh/);
  assert.match(changelog, /tested `0\.148\.x`[\s\S]*`0\.150\.x` minor lines/);
  assert.match(changelog, /packaged, dated OpenAI API price-file example/);
  assert.match(changelog, /^## \[0\.12\.1\] - 2026-08-27$/m);
  assert.match(changelog, /authorization preflight before bind/);
  assert.match(changelog, /CLI Path A stays read-only/);
  assert.match(changelog, /`task next` argv now includes/);
  assert.match(changelog, /`--view summary` redacts reservation tokens/);
  assert.match(changelog, /^## \[0\.12\.0\] - 2026-08-23$/m);
  assert.match(changelog, /validated concurrency policy and CLI App Server runner/);
  assert.match(changelog, /zero-write observer leases/);
  assert.match(changelog, /typed reviewer and verifier approval lanes/);
  assert.match(changelog, /bounded parallel delegation/);
  assert.match(changelog, /^## \[0\.9\.5\] - 2026-08-15$/m);
  assert.match(changelog, /Project-local `status` now accepts the `--task`, `--active-only`, and/);
  assert.match(changelog, /^## \[0\.9\.3\] - 2026-08-14$/m);
  assert.match(changelog, /^## \[0\.9\.4\] - 2026-08-15$/m);
  assert.match(changelog, /\[Unreleased\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.13\.0\.\.\.HEAD/);
  assert.match(changelog, /\[0\.12\.2\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.12\.1\.\.\.v0\.12\.2/);
  assert.match(changelog, /\[0\.12\.1\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.12\.0\.\.\.v0\.12\.1/);
  assert.match(changelog, /\[0\.12\.0\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.11\.0\.\.\.v0\.12\.0/);
  assert.match(changelog, /\[0\.11\.0\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.5\.\.\.v0\.11\.0/);
  assert.match(changelog, /\[0\.9\.5\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.4\.\.\.v0\.9\.5/);
  assert.match(changelog, /\[0\.9\.4\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.3\.\.\.v0\.9\.4/);
  assert.match(changelog, /\[0\.9\.3\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.2\.\.\.v0\.9\.3/);
  assert.match(roadmap, /Operator promise:/);
  assert.match(roadmap, /Category: local trust layer for consequential agent work/);
  assert.match(roadmap, /North-star metric:[\s\S]*zero protocol-level human intervention/);
  assert.match(roadmap, /Current release truth:/);
  assert.match(roadmap, /Current public release: `v0\.12\.2`/);
  assert.match(roadmap, /Current source release: `v0\.13\.0`/);
  assert.match(roadmap, /Last verified public release at this update: `v0\.12\.2`/);
  assert.match(roadmap, /signed tag commit[\s\S]*0ae623f4537daaa62278e70ae077b3231578a88e/);
  assert.match(roadmap, /\[RELEASE-CLOSEOUT\.json\]\(RELEASE-CLOSEOUT\.json\)/);
  assert.match(roadmap, /\[release-closeouts\/v0\.12\.2\.json\]\(release-closeouts\/v0\.12\.2\.json\)/);
  assert.match(roadmap, /\[RELEASING\.md\]\(RELEASING\.md\)/);
  assert.match(roadmap, /\[docs\/ROADMAP-HISTORY\.md\]\(docs\/ROADMAP-HISTORY\.md\)/);
  assert.equal(roadmap.match(/\[release-closeouts\/v0\.12\.2\.json\]\(/g)?.length, 1, "ROADMAP must own the current closeout link once");
  assert.match(roadmap, /Public proof covers[\s\S]*source preparation is not public proof/);
  assert.doesNotMatch(roadmap, /release-closeouts\/v0\.12\.1\.json|release-closeouts\/v0\.12\.0\.json|release-closeouts\/v0\.11\.0\.json|release-closeouts\/v0\.9\.5\.json/);
  assert.match(roadmap, /runtime requires Node `>=22`/);
  assert.match(roadmap, /supports Codex numeric minor lines\s+`0\.148` and `0\.150`/);
  assert.match(roadmap, /## 1\. Invisible Loop — v1/);
  assert.match(roadmap, /## 2\. Programs/);
  assert.match(roadmap, /## 3\. Portable Trust/);
  assert.match(roadmap, /## 4\. Agent Teams/);
  assert.match(roadmap, /v1 exit gate:/);
  assert.match(roadmap, /Current blocked-by\/worktree continuation is source-only/);
  assert.match(roadmap, /publish it in a pinned `@ivand890\/synod@0\.13\.0` package before pilots start/);
  assert.match(roadmap, /source-checkout behavior alone is not pilot evidence/);
  assert.equal(roadmap.match(/Current blocked-by\/worktree continuation is source-only/g)?.length, 1, "ROADMAP must own the source-only publication prerequisite once");
  assert.equal(roadmap.match(/source-checkout behavior alone is not pilot evidence/g)?.length, 1, "ROADMAP must state the source/public proof boundary once");
  const invisibleLoopDependencyRow = roadmap.match(/^\| Invisible Loop \(v1\) \|.*$/m)?.[0];
  assert.ok(invisibleLoopDependencyRow, "ROADMAP must include the Invisible Loop dependency row");
  assert.match(invisibleLoopDependencyRow, /Verified v0\.12\.2 contract and the pinned-publication condition above/);
  assert.doesNotMatch(invisibleLoopDependencyRow, /Invisible Loop exit gate/);
  assert.doesNotMatch(roadmap, /released source-only blocker\/worktree behavior/);
  assert.match(roadmap, /Three real production-shaped pilots[\s\S]*at least three repositories/);
  assert.match(roadmap, /different domain/);
  assert.match(roadmap, /operated by someone other than the author/);
  assert.match(roadmap, /All three pilots complete with zero protocol-level human intervention/);
  assert.match(roadmap, /interruption\s+and recovery/);
  assert.match(roadmap, /Independent verification/);
  assert.match(roadmap, /security review/);
  assert.match(roadmap, /zero protocol-level human intervention/);
  assert.match(roadmap, /v1 does not authorize autonomous merge, push, deployment, secret mutation,[\s\S]*payment, provider spending/);
  assert.match(roadmap, /accepts a natural-language substantial outcome/);
  assert.match(roadmap, /progressively refined dependency graph/);
  assert.match(roadmap, /goal, constraints, dependencies, and expected\s+evidence/);
  assert.match(roadmap, /Independent ready leaves dispatch automatically within configured capacity/);
  assert.match(roadmap, /concise human decision queue/);
  assert.match(roadmap, /Programs are not reusable workflow templates/);
  assert.match(roadmap, /Cross-repository dependency graphs/);
  assert.match(roadmap, /Organization policy and approval boundaries/);
  assert.match(roadmap, /Multiple human decision owners/);
  assert.match(roadmap, /Optional local or self-hosted operational visibility/);
  assert.match(roadmap, /while remaining local-first/);
  assert.match(roadmap, /Dependency order and release-proof boundary/);
  assert.match(roadmap, /Historical release evidence is not a future commitment/);
  assert.ok(roadmap.split(/\r?\n/).length <= 200, "ROADMAP.md must stay within the active-roadmap line budget");
  assert.equal(roadmap.match(/^Deliberate non-goals:$/gm)?.length, 4, "ROADMAP must retain non-goals for all four horizons");
  assert.equal(roadmap.match(/^Measurable gate:$/gm)?.length, 3, "ROADMAP must retain measurable gates for Programs, Portable Trust, and Agent Teams");
  const horizonHeadings = [
    "## 1. Invisible Loop — v1",
    "## 2. Programs",
    "## 3. Portable Trust",
    "## 4. Agent Teams",
  ];
  let previousHorizon = -1;
  for (const headingText of horizonHeadings) {
    const heading = roadmap.indexOf(headingText);
    assert.ok(heading > previousHorizon, `ROADMAP must keep ${headingText} in order`);
    previousHorizon = heading;
  }
  assert.match(roadmapHistory, /^# Synod Roadmap History/m);
  assert.match(roadmapHistory, /historical evidence, not a forward\s+commitment/);
  for (const releaseSection of [
    "## v0.6 — Delivered foundation",
    "## Pre-v0.7 foundation — TypeScript 7 source migration",
    "## v0.7 — Recoverable phase boundaries",
    "## v0.8 — Durable ownership and interruption recovery",
    "## v0.9 — Marginal economics and adaptive orchestration",
    "## v0.10 — Agent-completable golden path",
    "## v0.11 — Agent-recoverable interruption",
    "## v0.12 — Independent proof",
  ]) {
    assert.ok(roadmapHistory.includes(releaseSection), `ROADMAP-HISTORY must preserve ${releaseSection}`);
  }
  assert.match(roadmapHistory, /## v0\.9\.4 — Review, host, status, and recovery surfaces/);
  assert.match(roadmapHistory, /## v0\.9\.5 — Status bootstrap hotfix/);
  assert.match(roadmapHistory, /## v0\.12 — Independent proof/);
  assert.match(roadmapHistory, /Status: `v0\.12\.2` is publicly verified/);
  assert.match(roadmapHistory, /registry-installed package integrity\/attestation\/provenance/);
  assert.match(roadmapHistory, /release-closeouts\/v0\.12\.2\.json/);
  assert.doesNotMatch(roadmapHistory, /^## Current release evidence index$/m);
  assert.doesNotMatch(roadmapHistory, /^## Delivered foundation$/m);
  assert.match(roadmapHistory, /At the `v0\.12\.2` closeout, dated 2026-08-30,[\s\S]*still open[\s\S]*later[\s\n]+carried into the active roadmap/);
  assert.doesNotMatch(roadmapHistory, /broader independent-proof milestone remains in progress/);
  assert.match(roadmapHistory, /The v0\.9\.5 release required Node `>=22`/);
  assert.doesNotMatch(roadmapHistory, /The current\s+v0\.9\.5 release requires Node/);
  assert.match(roadmapHistory, /local tarball smoke remained source-preparation evidence/);
  assert.doesNotMatch(roadmapHistory, /local tarball smoke remains source-preparation evidence/);
  assert.match(roadmapHistory, /The delivered package[\s\S]*published compiled ESM JavaScript[\s\S]*consumers did not need TypeScript[\s\S]*no production\s+dependency/);
  assert.doesNotMatch(roadmapHistory, /Synod will publish compiled ESM JavaScript|consumers will not need TypeScript|no\s+production dependency will be added/);
  assert.match(roadmapHistory, /Foundation gate required[\s\S]*The migration landed separately/);
  assert.doesNotMatch(roadmapHistory, /Foundation gate: the compiled package must be|migration\s+must land separately/);
  assert.match(roadmapHistory, /SYN-094-RELEASE-011` additionally required[\s\S]*live verifier ran/);
  assert.doesNotMatch(roadmapHistory, /SYN-094-RELEASE-011` additionally requires|live verifier\s+runs on the protected closeout PR/);
  assert.match(roadmapHistory, /The release required Node `>=22` and retained/);
  assert.doesNotMatch(roadmapHistory, /The release requires Node `>=22` and retains/);
  assert.match(roadmapHistory, /reservation tokens remained in JSON\. The agent was not permitted/);
  assert.doesNotMatch(roadmapHistory, /reservation tokens remain in JSON\. The agent must not/);
  assert.match(roadmapHistory, /The historical release gate required killing the worker[\s\S]*Acceptance did not advance/);
  assert.doesNotMatch(roadmapHistory, /Release gate: kill the worker while the task is `ACTIVE`/);
  assert.match(roadmapHistory, /SYN-095-STATUS-BOOTSTRAP-024/);
  assert.match(roadmapHistory, /\| SYN-093-VERSIONS-001 \|/);
  assert.match(roadmapHistory, /`--task`, `--active-only`, and\s+`--changed-since-checkpoint`/);
  assert.match(roadmapHistory, /every valid numeric\s+`0\.148\.x` variant/);
  for (const historicalTaskId of ["SYN-069A", "SYN-070", "SYN-080", "SYN-090", "SYN-100", "SYN-110", "SYN-120"]) {
    assert.match(roadmapHistory, new RegExp(`\\| ${historicalTaskId} \\|`), `ROADMAP-HISTORY must preserve ${historicalTaskId}`);
  }
  for (const taskId of [
    "SYN-094-REVIEW-001",
    "SYN-094-HOST-002",
    "SYN-094-STATUS-003",
    "SYN-094-SURFACES-004",
    "SYN-094-PACKAGE-CLEANUP-005",
    "SYN-094-DOC-VERSION-006",
    "SYN-094-RELEASE-011",
  ]) {
    assert.ok(roadmapHistory.includes(`| ${taskId} |`), `ROADMAP-HISTORY must include ${taskId}`);
  }
  const v093Start = roadmapHistory.indexOf("## v0.9.3");
  const v094Start = roadmapHistory.indexOf("## v0.9.4", v093Start);
  assert.ok(v093Start >= 0 && v094Start > v093Start, "ROADMAP-HISTORY release section must follow v0.9.3");
  assert.doesNotMatch(roadmap, /\| SYN-094-(?:REVIEW|HOST|STATUS|SURFACES|PACKAGE-CLEANUP|DOC-VERSION|RELEASE)-/);
  assert.doesNotMatch(roadmap, /\| SYN-(?:069A|070|080|090|100|110|120) \|/);
  assert.doesNotMatch(roadmap, /## v0\.9\.[345]/);
  assert.doesNotMatch(roadmap, /two-phase closeout on main/i);

  assert.ok(readme.split(/\r?\n/).length <= 210, "README.md must stay within the operator-facing line budget");
  assert.ok(roadmapHistory.split(/\r?\n/).length <= 320, "ROADMAP-HISTORY.md must stay within the historical line budget");
  assert.ok(product.split(/\r?\n/).length <= 115, "PRODUCT.md must stay within the product-context line budget");
  for (const section of [
    "Start with an outcome",
    "Who is responsible for what",
    "When work is interrupted",
    "Install and upgrade",
    "The supervised loop",
    "Source-only capabilities",
    "Recovery and local evidence",
    "Usage and JSON",
    "Compatibility",
    "Release proof route",
    "Development",
  ]) {
    assert.match(readme, new RegExp(`^## ${section}$`, "m"), `README.md must include ${section}`);
  }
  assert.match(readme, /natural-language outcome/);
  assert.match(readme, /human's desired outcome is not an execution grant/);
  assert.match(readme, /host-only primitives/);
  assert.match(readme, /stale instruction authorizes no write/);
  assert.match(readme, /`?DONE`? is not a commit, push, PR, deploy, spend, or production mutation/);
  assert.match(readme, /Interruption is an expected supervision path/);
  assert.match(readme, /resume, reassign, and supersede/);
  assert.match(readme, /pnpm dlx @ivand890\/synod@0\.12\.2 init/);
  assert.match(readme, /pnpm dlx @ivand890\/synod@<version> upgrade --dry-run/);
  assert.match(readme, /`--blocked-by` dispatch[\s\S]*worktree[\s\S]*source-only/);
  assert.match(readme, /source\s+checkout behavior alone is not pilot evidence/i);
  assert.match(readme, /include-local-docs/);
  assert.match(readme, /Usage reports are read-only/);
  assert.match(readme, /Every `--json` command emits a versioned envelope/);
  assert.match(readme, /v0\.12\.2 release requires Node\.js `>=22`/);
  assert.match(readme, /supports Codex numeric minor lines `0\.148\.x` and `0\.150\.x`/);
  assert.match(readme, /untested[\s\S]*`0\.149\.x` gap fails closed/);
  assert.match(readme, /public and pinned `@ivand890\/synod@0\.12\.2`/);
  assert.match(readme, /signed tag\s+commit[\s\S]*externally immutable/);
  assert.match(readme, /Prepared source:[\s\S]*RELEASE-CLOSEOUT\.json[\s\S]*release-closeouts\/v0\.12\.2\.json/);
  assert.match(readme, /See \[RELEASING\.md\]\(RELEASING\.md\) for the protected release procedure/);
  assert.equal(readme.match(/\[release-closeouts\/v0\.12\.2\.json\]\(/g)?.length, 1, "README must link the current versioned closeout once");
  assert.match(readme, /Local tarball smoke[\s\S]*source-preparation evidence only; they do not prove external publication/);
  assert.equal(readme.match(/source-preparation evidence only/g)?.length, 1, "README must state the local/public proof boundary once");
  assert.doesNotMatch(readme, /release-closeouts\/v0\.12\.1\.json|release-closeouts\/v0\.12\.0\.json|release-closeouts\/v0\.11\.0\.json|release-closeouts\/v0\.9\.5\.json/);
  assert.doesNotMatch(readme, /phase-2 live verifier|strict prepared\/pending source record|clean\s+consumer install|registry-installed package integrity|separate public CLI check/);
  assert.doesNotMatch(readme, /synod lease (?:reserve|bind)/);
  assert.doesNotMatch(readme, /--reservation-token|--baseline-hash|--expected-reserved-at/);
  for (const phrase of [
    "runtimeVersion",
    "installedTemplateVersion",
    "stateTemplateVersion",
    "JobHandle",
    "JobEvent",
    "hostWaitRequired",
    "sourceSequence",
    "observationId",
    "WaitReport",
  ]) {
    assert.doesNotMatch(readme, new RegExp(phrase), `README.md must not carry the ${phrase} field catalogue`);
  }
  assert.doesNotMatch(readme, /closeout(?: evidence)? (?:is|was) recorded (?:on|in) `main`/i);
  assert.match(changelog, /numeric `0\.148` minor line/);

  const productSections = [
    "Register",
    "Users",
    "Product Purpose",
    "Brand Personality",
    "Anti-references",
    "Design Principles",
    "Accessibility & Inclusion",
  ];
  for (const section of productSections) {
    assert.match(product, new RegExp(`^## ${section}$`, "m"), `PRODUCT.md must include ${section}`);
  }
  assert.match(product, /^product$/m);
  assert.equal(product.match(/^## /gm)?.length, 7);
  assert.match(product, /precise, calm, and accountable/);
  assert.equal(product.match(/^\d+\. /gm)?.length, 5);
  assert.match(product, /WCAG 2\.2 AA/);
  assert.match(product, /Category: local trust layer for consequential agent work/);
  assert.match(product, /local trust layer for consequential agent work/);
  assert.match(product, /human operator/);
  assert.match(product, /Jobs-to-be-done/);
  assert.match(product, /Trust boundaries are explicit/);
  assert.match(product, /Interruption is a normal product state/);
  assert.match(product, /North-star outcome/);
  assert.match(product, /zero protocol-level human intervention/);
  assert.match(product, /## Anti-references/);
  for (const phrase of [
    "public",
    "release",
    "version",
    "v0.12",
    "Node.js",
    "Codex",
    "App Server",
    "JobHandle",
    "JobEvent",
    "HostDelegationAdapter",
    "selector",
    "--task",
    "source-only",
  ]) {
    assert.doesNotMatch(product, new RegExp(phrase, "i"), `PRODUCT.md must not carry ${phrase} implementation detail`);
  }

  assert.match(releasing, /public `v0\.12\.2` source is anchored by signed tag commit/);
  assert.match(releasing, /externally immutable GitHub\s+Release \(`isImmutable: true`\)/);
  assert.match(releasing, /signed tag commit\s+`0ae623f4537daaa62278e70ae077b3231578a88e`/);
  assert.match(releasing, /`release-closeouts\/v0\.12\.2\.json`/);
  assert.match(releasing, /`release-closeouts\/v0\.12\.1\.json`/);
  assert.match(releasing, /`release-closeouts\/v0\.12\.0\.json`/);
  assert.match(releasing, /`release-closeouts\/v0\.11\.0\.json`/);
  assert.match(releasing, /(?:prior|earlier)\s+`v0\.9\.5` evidence[\s\S]*`release-closeouts\/v0\.9\.5\.json`/);
  assert.match(releasing, /root `RELEASE-CLOSEOUT\.json` prepares `v0\.13\.0`/);
  assert.doesNotMatch(releasing, /pre-tag candidate record/);
  assert.match(releasing, /registry-installed package result/);
  assert.match(releasing, /local tarball smoke belongs under\s+`sourcePreparation\.localPackageSmoke`/);
  assert.match(releasing, /Two-phase closeout/);
  assert.match(releasing, /protected release procedure\s+for a future version/);
  assert.match(releasing, /scripts\/validate-release-closeout\.ts/);
  assert.match(releasing, /scripts\/verify-public-release-closeout\.ts/);
  assert.match(releasing, /phase-strict closeout validation|Malformed or mixed-phase records fail closed/);
  assert.match(releasing, /phase-2 live verifier runs on the protected\s+closeout PR,\s*not the tag\s+workflow/);

  const runbookSections = [
    "Release truth and authority",
    "Phase 1: Prepare source",
    "Phase 2: Protected publish",
    "Phase 3: Public verification and closeout",
    "Failure and recovery",
    "Historical evidence",
  ];
  let previousRunbookHeading = -1;
  for (const section of runbookSections) {
    const heading = releasing.indexOf(`## ${section}`);
    assert.ok(heading > previousRunbookHeading, `RELEASING.md must keep ## ${section} in order`);
    previousRunbookHeading = heading;
  }
  assert.ok(releasing.split(/\r?\n/).length <= 110, "RELEASING.md must stay within the 110-line operator runbook budget");
  for (const boundary of [
    /signed annotated tag/,
    /trusted publishing[\s\S]*no npm publish token is stored in GitHub/,
    /sourcePreparation\.status[\s\S]*prepared[\s\S]*publicVerification\.status[\s\S]*documentation\.status[\s\S]*pending/,
    /tag workflow validates phase 1 only/,
    /read-only phase-2 live verifier[\s\S]*protected closeout PR/,
    /Local tests, a tarball, a tag, or a green workflow are not public proof/,
    /GitHub Releases and npm are not an atomic transaction/,
    /rerun[\s\S]*fail closed/,
    /Published tags and npm versions are immutable/,
    /root and matching versioned closeouts must be[\s\S]*byte-identical/,
    /npm version,[\s\S]*gitHead[\s\S]*latest[\s\S]*integrity[\s\S]*attestation[\s\S]*provenance/,
    /immutable[\s\S]*GitHub Release[\s\S]*Latest parity/,
    /clean consumer install of the exact registry spec/,
    /public `pnpm dlx @ivand890\/synod@\$release_version --version` check/,
    /--latest=false/,
  ]) {
    assert.match(releasing, boundary, `RELEASING.md must preserve ${boundary}`);
  }

  const unsupportedArchiveWording = [
    /immutable source and\s+post-publication evidence is archived in[\s\S]*release-closeouts\//i,
    /evidence remains immutable in[\s\S]*release-closeouts\//i,
    /captured in immutable\s+[`\w/.-]*release-closeouts\//i,
    /immutable v0\.9\.3 closeout archive/i,
    /immutable prepared\/pending source record/i,
  ];
  for (const [label, text] of [["README.md", readme], ["ROADMAP.md", roadmap], ["RELEASING.md", releasing]] as const) {
    for (const pattern of unsupportedArchiveWording) {
      assert.doesNotMatch(text, pattern, `${label} must not call a versioned closeout archive immutable`);
    }
    assert.doesNotMatch(
      text,
      /root[\s\S]{0,100}RELEASE-CLOSEOUT\.json[\s\S]{0,100}same verified[\s\S]{0,40}v0\.9\.4 evidence/i,
      `${label} must not attribute verified v0.9.4 evidence to the current root closeout`,
    );
  }

  assert.equal(releasing.match(/release_version="\$\{RELEASE_VERSION/g)?.length, 3);
  assert.ok(packageSmoke.includes("hostWaitRequired"));
  assert.ok(packageSmoke.includes("validateJobHandle"));
  assert.ok(packageSmoke.includes("stateTemplateVersion"));
});

test("release closeout validation is strict across pre-tag and post-publication phases", async () => {
  const [rootText, archivedText, archivedPreviousText, archivedCurrentText, archivedPublishedText, archivedLatestText, archivedReleaseText] = await Promise.all([
    readFile(closeoutPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
    readFile(archivedPreviousCloseoutPath, "utf8"),
    readFile(archivedCurrentCloseoutPath, "utf8"),
    readFile(archivedPublishedCloseoutPath, "utf8"),
    readFile(archivedLatestCloseoutPath, "utf8"),
    readFile(archivedReleaseCloseoutPath, "utf8"),
  ]);
  validateReleaseCloseout(parseJson(rootText), { phase: "pre-tag", expectedVersion: "0.13.0" });
  const root = parseJson(archivedReleaseText);
  const archived = parseJson(archivedText);
  const archivedPrevious = parseJson(archivedPreviousText);
  const archivedCurrent = parseJson(archivedCurrentText);
  const archivedPublished = parseJson(archivedPublishedText);
  const archivedLatest = parseJson(archivedLatestText);
  const archivedRelease = parseJson(archivedReleaseText);
  const expected = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.12.2",
    expectedTag: "v0.12.2",
  } as const;
  const publishedLatest = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.12.1",
    expectedTag: "v0.12.1",
  } as const;
  const publishedCurrent012 = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.12.0",
    expectedTag: "v0.12.0",
  } as const;
  const publishedCurrent011 = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.11.0",
    expectedTag: "v0.11.0",
  } as const;
  const publishedCurrent = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.9.5",
    expectedTag: "v0.9.5",
  } as const;
  const published = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.9.4",
    expectedTag: "v0.9.4",
  } as const;
  assert.ok(isRecord(root) && isRecord(root.publicVerification));
  assert.equal(root.publicVerification.status, "verified");
  assert.ok(isRecord(root.sourcePreparation));
  assert.equal(root.sourcePreparation.status, "closed");
  assert.equal(root.sourcePreparation.tagSha, "0ae623f4537daaa62278e70ae077b3231578a88e");
  assert.deepEqual(validateReleaseCloseout(root, {
    phase: "post-publication",
    ...expected,
    expectedTagSha: "0ae623f4537daaa62278e70ae077b3231578a88e",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.12.2",
    tag: "v0.12.2",
    tagSha: "0ae623f4537daaa62278e70ae077b3231578a88e",
  });
  assert.deepEqual(root, archivedRelease);
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.12.2.json", {
    phase: "post-publication",
    ...expected,
    expectedTagSha: "0ae623f4537daaa62278e70ae077b3231578a88e",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.12.2",
    tag: "v0.12.2",
    tagSha: "0ae623f4537daaa62278e70ae077b3231578a88e",
  });
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.12.1.json", {
    phase: "post-publication",
    ...publishedLatest,
    expectedTagSha: "937c7d713523e4de587e7a6951716d72a9681131",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.12.1",
    tag: "v0.12.1",
    tagSha: "937c7d713523e4de587e7a6951716d72a9681131",
  });
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.12.0.json", {
    phase: "post-publication",
    ...publishedCurrent012,
    expectedTagSha: "9ee278290b3f7928138aa827b544a5145d516a3b",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.12.0",
    tag: "v0.12.0",
    tagSha: "9ee278290b3f7928138aa827b544a5145d516a3b",
  });
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.11.0.json", {
    phase: "post-publication",
    ...publishedCurrent011,
    expectedTagSha: "a120f958f7bd86bf4efeebbf1dd8f88019da1ab8",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.11.0",
    tag: "v0.11.0",
    tagSha: "a120f958f7bd86bf4efeebbf1dd8f88019da1ab8",
  });
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.9.5.json", {
    phase: "post-publication",
    ...publishedCurrent,
    expectedTagSha: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.9.5",
    tag: "v0.9.5",
    tagSha: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
  });
  assert.notDeepEqual(root, archivedLatest);
  assert.notDeepEqual(root, archivedPublished);
  assert.notDeepEqual(root, archivedCurrent);
  assert.ok(isRecord(archivedPrevious));
  assert.equal(archivedPrevious.version, "0.9.4");
  assert.equal(archivedPrevious.tag, "v0.9.4");
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.9.4.json", {
    phase: "post-publication",
    ...published,
    expectedTagSha: "f116a38acffb86c752f6e5c3f8013407ecfea267",
  }).version, "0.9.4");
  assert.deepEqual(validateReleaseCloseoutFile("release-closeouts/v0.9.3.json", {
    phase: "post-publication",
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.9.3",
    expectedTag: "v0.9.3",
    expectedTagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
  }), {
    phase: "post-publication",
    package: "@ivand890/synod",
    version: "0.9.3",
    tag: "v0.9.3",
    tagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
  });

  const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const pendingFixture = clone(root);
  assert.ok(isRecord(pendingFixture));
  pendingFixture.sourcePreparation = {
    status: "prepared",
    mainAncestorRequired: true,
    localPackageSmoke: {
      artifact: "local tarball",
      command: "pnpm test:package",
      status: "pending",
      version: expected.expectedVersion,
    },
  };
  pendingFixture.publicVerification = { status: "pending" };
  pendingFixture.documentation = {
    status: "pending",
    paths: ["README.md", "ROADMAP.md", "RELEASING.md"],
    rule: "Advance these paths together only when publicVerification is verified.",
  };
  assert.deepEqual(validateReleaseCloseout(pendingFixture, { phase: "pre-tag", ...expected }).phase, "pre-tag");
  assert.deepEqual(validateReleaseCloseout(pendingFixture, {
    phase: "tag",
    ...expected,
    expectedTagSha: "0123456789abcdef0123456789abcdef01234567",
  }).phase, "tag");
  assert.throws(
    () => validateReleaseCloseout(pendingFixture, {
      phase: "post-publication",
      ...expected,
      expectedTagSha: "0123456789abcdef0123456789abcdef01234567",
    }),
    error => error instanceof ReleaseCloseoutValidationError && /sourcePreparation/.test(error.message),
  );

  const verifiedFixture = clone(pendingFixture);
  assert.ok(isRecord(verifiedFixture));
  const verifiedTagSha = "abcdef0123456789abcdef0123456789abcdef01";
  const archivedPublication = isRecord(archivedCurrent) && isRecord(archivedCurrent.publicVerification)
    ? archivedCurrent.publicVerification
    : undefined;
  assert.ok(isRecord(archivedPublication));
  const archivedNpm = archivedPublication.npm;
  const archivedGitHubRelease = archivedPublication.githubRelease;
  const archivedRegistry = archivedPublication.registryInstalledPackage;
  const archivedPublicCli = archivedPublication.publicCli;
  assert.ok(isRecord(archivedNpm) && isRecord(archivedGitHubRelease));
  assert.ok(isRecord(archivedRegistry) && isRecord(archivedPublicCli));
  const archivedRegistryDist = archivedRegistry.dist;
  assert.ok(isRecord(archivedRegistryDist) && isRecord(archivedRegistryDist.attestations));
  const archivedAttestations = archivedRegistryDist.attestations;
  verifiedFixture.sourcePreparation = {
    status: "closed",
    tagSha: verifiedTagSha,
    mainAncestorRequired: true,
    localPackageSmoke: {
      artifact: "local tarball",
      command: "pnpm test:package",
      status: "passed",
      version: expected.expectedVersion,
    },
  };
  verifiedFixture.publicVerification = {
    status: "verified",
    tagSha: verifiedTagSha,
    npm: {
      ...archivedNpm,
      package: expected.expectedPackage,
      version: expected.expectedVersion,
      gitHead: verifiedTagSha,
      latest: expected.expectedVersion,
    },
    githubRelease: {
      ...archivedGitHubRelease,
      tag: expected.expectedTag,
      url: `https://github.com/ivand890/synod/releases/tag/${expected.expectedTag}`,
    },
    registryInstalledPackage: {
      ...archivedRegistry,
      spec: `${expected.expectedPackage}@${expected.expectedVersion}`,
      dist: {
        ...archivedRegistryDist,
        attestations: {
          ...archivedAttestations,
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@${expected.expectedVersion}`,
        },
      },
      consumerCommand: `pnpm add --ignore-scripts --save-exact ${expected.expectedPackage}@${expected.expectedVersion}`,
      verification: {
        command: "pnpm exec synod --version",
        status: "passed",
        version: expected.expectedVersion,
      },
      version: expected.expectedVersion,
    },
    publicCli: {
      ...archivedPublicCli,
      command: `pnpm dlx ${expected.expectedPackage}@${expected.expectedVersion} --version`,
      version: expected.expectedVersion,
    },
  };
  verifiedFixture.documentation = {
    status: "verified",
    paths: ["README.md", "ROADMAP.md", "RELEASING.md"],
    rule: "Advance these paths together only when publicVerification is verified.",
  };
  assert.ok(isRecord(verifiedFixture.sourcePreparation));
  const recordedVerifiedTagSha = verifiedFixture.sourcePreparation.tagSha;
  assert.equal(recordedVerifiedTagSha, verifiedTagSha);
  assert.deepEqual(validateReleaseCloseout(verifiedFixture, {
    phase: "post-publication",
    ...expected,
    expectedTagSha: recordedVerifiedTagSha as string,
  }), {
    phase: "post-publication",
    package: expected.expectedPackage,
    version: expected.expectedVersion,
    tag: expected.expectedTag,
    tagSha: recordedVerifiedTagSha,
  });
  assert.throws(
    () => validateReleaseCloseout(verifiedFixture, { phase: "pre-tag", ...expected }),
    error => error instanceof ReleaseCloseoutValidationError && /sourcePreparation/.test(error.message),
  );
  assert.throws(
    () => validateReleaseCloseout(verifiedFixture, {
      phase: "tag",
      ...expected,
      expectedTagSha: recordedVerifiedTagSha as string,
    }),
    error => error instanceof ReleaseCloseoutValidationError && /sourcePreparation/.test(error.message),
  );

  const mixedPhase = clone(pendingFixture);
  assert.ok(isRecord(mixedPhase) && isRecord(mixedPhase.publicVerification));
  mixedPhase.publicVerification.status = "verified";
  assert.throws(
    () => validateReleaseCloseout(mixedPhase, { phase: "pre-tag", ...expected }),
    error => error instanceof ReleaseCloseoutValidationError && /publicVerification\.status/.test(error.message),
  );

  const selfReferential = clone(pendingFixture);
  assert.ok(isRecord(selfReferential) && isRecord(selfReferential.sourcePreparation));
  selfReferential.sourcePreparation.tagSha = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(
    () => validateReleaseCloseout(selfReferential, { phase: "tag", ...expected, expectedTagSha: "0123456789abcdef0123456789abcdef01234567" }),
    error => error instanceof ReleaseCloseoutValidationError && /sourcePreparation has an invalid shape/.test(error.message),
  );

  const malformedVerifiedFixture = clone(verifiedFixture);
  assert.ok(isRecord(malformedVerifiedFixture) && isRecord(malformedVerifiedFixture.sourcePreparation));
  malformedVerifiedFixture.sourcePreparation.tagSha = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(
    () => validateReleaseCloseout(malformedVerifiedFixture, {
      phase: "post-publication",
      ...expected,
      expectedTagSha: recordedVerifiedTagSha as string,
    }),
    error => error instanceof ReleaseCloseoutValidationError && /sourcePreparation\.tagSha/.test(error.message),
  );

  const malformedPublication = clone(archivedCurrent);
  assert.ok(isRecord(malformedPublication) && isRecord(malformedPublication.publicVerification));
  assert.ok(isRecord(malformedPublication.publicVerification.npm));
  malformedPublication.publicVerification.npm.gitHead = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(
    () => validateReleaseCloseout(malformedPublication, {
      phase: "post-publication",
      ...publishedCurrent011,
      expectedTagSha: "a120f958f7bd86bf4efeebbf1dd8f88019da1ab8",
    }),
    error => error instanceof ReleaseCloseoutValidationError && /publicVerification\.npm/.test(error.message),
  );
});

test("public closeout comparisons fail closed on registry and GitHub mismatches", () => {
  const recordedNpm = {
    package: "@ivand890/synod",
    version: "0.9.5",
    gitHead: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
    latest: "0.9.5",
    integrity: "sha512-+yFgEyv8ylEWt4+MtBP/o+YumrVCSljnk5QyIrMqLxGRcZE7ICBRQoj3msk9e+fMW+S9vcGTFZrf1TXXiS3OQQ==",
    attestationUrl: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.9.5",
    provenancePredicateType: "https://slsa.dev/provenance/v1",
  } as const;
  const recordedGitHub = {
    tag: "v0.9.5",
    url: "https://github.com/ivand890/synod/releases/tag/v0.9.5",
    publishedAt: "2026-08-16T04:02:34Z",
    isDraft: false,
    isPrerelease: false,
    isImmutable: true,
    isLatest: true,
  } as const;
  assert.deepEqual(compareNpmPublication(recordedNpm, recordedNpm), []);
  assert.deepEqual(compareGitHubRelease(recordedGitHub, recordedGitHub), []);
  assert.match(compareNpmPublication({ ...recordedNpm, latest: "0.9.2" }, recordedNpm).join("\n"), /npm latest differs/);
  assert.match(compareNpmPublication({ ...recordedNpm, integrity: "sha512-invalid" }, recordedNpm).join("\n"), /npm integrity differs/);
  assert.match(compareNpmPublication({ ...recordedNpm, provenancePredicateType: "wrong" }, recordedNpm).join("\n"), /npm provenancePredicateType differs/);
  assert.match(compareGitHubRelease({ ...recordedGitHub, isDraft: true }, recordedGitHub).join("\n"), /GitHub release isDraft differs/);
  assert.match(compareGitHubRelease({ ...recordedGitHub, isImmutable: false }, recordedGitHub).join("\n"), /GitHub release isImmutable differs/);
  assert.match(compareGitHubRelease({ ...recordedGitHub, isLatest: false }, recordedGitHub).join("\n"), /GitHub release isLatest differs/);
});

test("public closeout verifier validates the exact post-publication record before live reads", async () => {
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "read-only-test-token";
  const pnpmArgs: string[][] = [];
  const commandRunner = (command: string, args: readonly string[]): string => {
    if (command === "npm") {
      return JSON.stringify({
        version: "0.9.5",
        gitHead: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
        "dist-tags.latest": "0.9.5",
        "dist.integrity": "sha512-+yFgEyv8ylEWt4+MtBP/o+YumrVCSljnk5QyIrMqLxGRcZE7ICBRQoj3msk9e+fMW+S9vcGTFZrf1TXXiS3OQQ==",
        "dist.attestations": {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.9.5",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      });
    }
    if (command === "gh" && args[1] === "repos/ivand890/synod/releases/latest") {
      return JSON.stringify({ tag_name: "v0.9.5" });
    }
    if (command === "gh") {
      return JSON.stringify({
        tag_name: "v0.9.5",
        html_url: "https://github.com/ivand890/synod/releases/tag/v0.9.5",
        published_at: "2026-08-16T04:02:34Z",
        draft: false,
        prerelease: false,
        immutable: true,
      });
    }
    if (command === "pnpm") {
      pnpmArgs.push([...args]);
      if (args[0] === "add") return "";
      return "0.9.5\n";
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  try {
    const result = verifyPublicReleaseCloseout({
      filePath: "release-closeouts/v0.9.5.json",
      expectedPackage: "@ivand890/synod",
      expectedVersion: "0.9.5",
      expectedTag: "v0.9.5",
      expectedTagSha: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
      repository: "ivand890/synod",
      commandRunner,
    });
    assert.equal(result.registryInstallVersion, "0.9.5");
    assert.equal(result.publicCliVersion, "0.9.5");
    assert.deepEqual(pnpmArgs, [
      ["add", "--ignore-scripts", "--save-exact", "--registry", "https://registry.npmjs.org", "@ivand890/synod@0.9.5"],
      ["--reporter=silent", "exec", "synod", "--version"],
      ["--reporter=silent", "dlx", "--config.registry=https://registry.npmjs.org", "@ivand890/synod@0.9.5", "--version"],
    ]);

    const pendingDirectory = await mkdtemp(path.join(os.tmpdir(), "synod-pending-closeout-test-"));
    const pendingPath = path.join(pendingDirectory, "RELEASE-CLOSEOUT.json");
    const pendingRecord = parseJson(await readFile(archived095CloseoutPath, "utf8"));
    assert.ok(isRecord(pendingRecord));
    pendingRecord.sourcePreparation = {
      status: "prepared",
      mainAncestorRequired: true,
      localPackageSmoke: {
        artifact: "local tarball",
        command: "pnpm test:package",
        status: "pending",
        version: "0.9.5",
      },
    };
    pendingRecord.publicVerification = { status: "pending" };
    pendingRecord.documentation = {
      status: "pending",
      paths: ["README.md", "ROADMAP.md", "RELEASING.md"],
      rule: "Advance these paths together only when publicVerification is verified.",
    };
    await writeFile(pendingPath, `${JSON.stringify(pendingRecord)}\n`, "utf8");
    try {
      assert.throws(
        () => verifyPublicReleaseCloseout({
          filePath: pendingPath,
          expectedPackage: "@ivand890/synod",
          expectedVersion: "0.9.5",
          expectedTag: "v0.9.5",
          expectedTagSha: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
          repository: "ivand890/synod",
          commandRunner: () => { throw new Error("live command must not run for a pending record"); },
        }),
        /sourcePreparation|publicVerification\.status/,
      );
    } finally {
      await rm(pendingDirectory, { recursive: true, force: true });
    }

    assert.throws(
      () => verifyPublicReleaseCloseout({
        filePath: "release-closeouts/v0.9.5.json",
        expectedPackage: "@ivand890/synod",
        expectedVersion: "0.9.5",
        expectedTag: "v0.9.5",
        expectedTagSha: "494f1ebd85b1c51dde522e7a7ec6e334dadc4e30",
        repository: "ivand890/synod",
        commandRunner: (command, args) => {
          if (command === "npm") return JSON.stringify({ version: "0.9.5", gitHead: "wrong", "dist-tags.latest": "0.9.5", "dist.integrity": "wrong", "dist.attestations": { url: "wrong", provenance: { predicateType: "wrong" } } });
          throw new Error(`live command must stop after npm mismatch: ${command} ${args.join(" ")}`);
        },
      }),
      /npm publication does not match live public evidence/,
    );
  } finally {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("durable release turn selects the oldest pending stable tag", () => {
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.3", "v0.5.2", "v0.5.1"]), "v0.5.2");
  assert.equal(nextReleaseTag("0.9.0", ["v0.10.0", "v0.9.1"]), "v0.9.1");
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.2-beta.1", "not-a-release"]), "");
  assert.throws(() => nextReleaseTag("latest", ["v0.5.2"]), /stable semantic version/);
});
