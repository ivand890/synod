import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const readmePath = new URL("../README.md", import.meta.url);
const productPath = new URL("../PRODUCT.md", import.meta.url);
const releasingPath = new URL("../RELEASING.md", import.meta.url);
const closeoutPath = new URL("../RELEASE-CLOSEOUT.json", import.meta.url);
const archivedCloseoutPath = new URL("../release-closeouts/v0.9.3.json", import.meta.url);
const gifScriptPath = new URL("../scripts/capture-synod-cycle-gif.sh", import.meta.url);
const cyclePath = new URL("../docs/synod/synod-cycle.html", import.meta.url);
const cycleGifPath = new URL("../docs/synod/assets/synod-cycle-loop.gif", import.meta.url);

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
  assert.match(workflow, /codex-version: "0\.148\.0-alpha\.1"\n\s+expected-status: supported/);
  assert.match(workflow, /codex-version: "0\.148\.0-alpha\.9"\n\s+expected-status: known-good/);
  assert.doesNotMatch(workflow, /codex-version: "0\.14(?:1|2|5|7)\.0"/);
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

test("archived 0.9.3 evidence and product/docs contract stay explicit", async () => {
  const [packageText, changelog, roadmap, readme, product, releasing, closeoutText, packageSmoke] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(changelogPath, "utf8"),
    readFile(roadmapPath, "utf8"),
    readFile(readmePath, "utf8"),
    readFile(productPath, "utf8"),
    readFile(releasingPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
    readFile(packageSmokePath, "utf8")
  ]);
  const packageJson = parseJson(packageText);
  const closeout = parseJson(closeoutText);
  assert.ok(isRecord(packageJson));
  assert.ok(isRecord(closeout));
  assert.equal(packageJson.version, "0.9.4");
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

  assert.match(changelog, /^## \[0\.9\.3\] - 2026-08-14$/m);
  assert.match(changelog, /^## \[0\.9\.4\] - 2026-08-15$/m);
  assert.match(changelog, /\[Unreleased\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.4\.\.\.HEAD/);
  assert.match(changelog, /\[0\.9\.4\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.3\.\.\.v0\.9\.4/);
  assert.match(changelog, /\[0\.9\.3\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.2\.\.\.v0\.9\.3/);
  assert.match(roadmap, /Current public release: `v0\.9\.3`/);
  assert.match(roadmap, /Current source candidate: `v0\.9\.4` \(unreleased\)/);
  assert.match(roadmap, /Last verified public release at this update: `v0\.9\.3`/);
  assert.match(roadmap, /immutable `release-closeouts\/v0\.9\.3\.json`/);
  assert.match(roadmap, /root\s+`RELEASE-CLOSEOUT\.json` now records the `v0\.9\.4` pre-tag `prepared`\/`pending`/);
  assert.match(roadmap, /public latest remains `v0\.9\.3`/);
  assert.match(roadmap, /Status: delivered and publicly verified/);
  assert.doesNotMatch(roadmap, /last verified public package remains `v0\.9\.2`/i);
  assert.doesNotMatch(roadmap, /public verification remains `v0\.9\.2`/i);
  assert.match(roadmap, /\| SYN-093-VERSIONS-001 \|/);
  assert.match(roadmap, /## v0\.9\.4 — Candidate surfaces \(unreleased\)/);
  assert.match(roadmap, /unshipped and unavailable to public or pinned\s+`v0\.9\.3` runtimes/);
  assert.match(roadmap, /future `v0\.9\.4` release is published/);
  assert.match(roadmap, /doctor` support\s+ceiling remains `<0\.148\.0`/);
  assert.match(roadmap, /candidate support expression is\s+`>=0\.148\.0-0 <0\.149\.0 \(all 0\.148\.x variants\)`/);
  assert.doesNotMatch(roadmap, /candidate support expression is\s+`>=0\.142\.0 <0\.148\.0/);
  assert.match(roadmap, /v0\.9\.4 source candidate requires Node(?:\.js)? `>=22`/);
  for (const taskId of [
    "SYN-094-REVIEW-001",
    "SYN-094-HOST-002",
    "SYN-094-STATUS-003",
    "SYN-094-SURFACES-004",
    "SYN-094-PACKAGE-CLEANUP-005",
    "SYN-094-DOC-VERSION-006",
    "SYN-094-RELEASE-011",
  ]) {
    assert.match(roadmap, new RegExp(`\\| ${taskId} \\|`), `ROADMAP must include ${taskId} in the candidate section`);
  }
  const v093Start = roadmap.indexOf("## v0.9.3");
  const v094Start = roadmap.indexOf("## v0.9.4", v093Start);
  assert.ok(v093Start >= 0 && v094Start > v093Start, "ROADMAP candidate section must follow v0.9.3");
  assert.doesNotMatch(roadmap.slice(v093Start, v094Start), /SYN-094-SURFACES-004/);
  assert.doesNotMatch(roadmap, /two-phase closeout on `main`/i);

  assert.match(readme, /Public release versus source candidate/);
  assert.match(readme, /immutable source and\s+post-publication evidence is archived in/);
  assert.match(readme, /pre-tag `prepared`\/`pending` record/);
  assert.match(readme, /Public latest remains `v0\.9\.3`/);
  assert.match(readme, /public and pinned `@ivand890\/synod@0\.9\.3`/);
  assert.match(readme, /Candidate-only source surfaces/);
  assert.match(readme, /v0\.9\.4` source candidate requires Node\.js `>=22`/);
  assert.match(readme, /uses the support expression `>=0\.148\.0-0 <0\.149\.0 \(all 0\.148\.x variants\)`/);
  assert.match(readme, /Candidate known-good and exercised in CI: `0\.148\.0-alpha\.9`/);
  assert.doesNotMatch(readme, /candidate support expression `>=0\.142\.0 <0\.148\.0/);
  assert.match(readme, /synod task correct/);
  assert.match(readme, /Git-lane provenance/);
  assert.match(readme, /HostDelegationAdapter/);
  assert.match(readme, /include-local-docs/);
  assert.match(readme, /post-publication\s+closeout commit are verified/);
  assert.match(readme, /phase-2 live verifier runs on the protected closeout PR,\s*not the tag\s+workflow/);
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
  assert.match(product, /precise, calm, and accountable/);
  assert.equal(product.match(/^\d+\. /gm)?.length, 5);
  assert.match(product, /WCAG 2\.2 AA/);
  assert.match(product, /`JobHandle` and `JobEvent`/);
  assert.match(product, /injected\s+`HostDelegationAdapter`/);
  assert.match(product, /independent Git lanes/);
  assert.match(product, /execution\s+ownership/);

  const lifecycle = "READY → reserve → read-only spawn → bind-driven ACTIVE → explicit write authorization → task-aware wait → proposal submit → REVIEW → ACCEPTED → VERIFIED → DONE";
  assert.ok(readme.includes(lifecycle), "README must show the lease-fenced executable lifecycle");
  assert.match(readme, /synod lease reserve T-001/);
  assert.match(readme, /read-only contract/);
  assert.match(readme, /synod lease bind T-001/);
  assert.match(readme, /synod wait --task T-001/);
  assert.match(readme, /synod proposal submit T-001/);
  assert.doesNotMatch(readme, /synod task transition T-001 ACTIVE --revision/);
  assert.match(readme, /advisor\/supervisor policy for an ordinary correction is to return work to the same available worker/);
  assert.match(readme, /not a runtime owner-continuity guarantee/);
  assert.match(readme, /fresh reservation, lease-generation bind, authorization, and wait boundary/);
  assert.match(readme, /only that recovery path reassigns a replacement thread/);
  assert.doesNotMatch(readme, /A correction repeats the reservation, read-only spawn/);

  assert.match(releasing, /public `v0\.9\.3` source and post-publication evidence is immutable/);
  assert.match(releasing, /`release-closeouts\/v0\.9\.3\.json`/);
  assert.match(releasing, /root `RELEASE-CLOSEOUT\.json`\s+is the current `v0\.9\.4` pre-tag candidate record/);
  assert.match(releasing, /prepared.*pending/);
  assert.match(releasing, /Public latest remains `v0\.9\.3`/);
  assert.match(releasing, /registry-installed package result/);
  assert.match(releasing, /local tarball smoke belongs under\s+`sourcePreparation\.localPackageSmoke`/);
  assert.match(readme, /local tarball smoke is source-preparation evidence only/);
  assert.match(readme, /clean\s+consumer install of the exact registry spec/);
  assert.match(roadmap, /registry-installed package integrity\/attestation\/provenance/);
  assert.match(releasing, /Two-phase closeout/);
  assert.match(releasing, /protected release procedure\s+for a future version/);
  assert.match(releasing, /scripts\/validate-release-closeout\.ts/);
  assert.match(releasing, /scripts\/verify-public-release-closeout\.ts/);
  assert.match(releasing, /phase-strict closeout validation|Malformed or mixed-phase records fail closed/);
  assert.match(releasing, /phase-2 live verifier runs on the protected closeout PR,\s*not the tag\s+workflow/);
  assert.match(roadmap, /phase-2 live verifier runs on the protected closeout PR,\s*not the tag\s+workflow/);

  for (const phrase of [
    "runtimeVersion",
    "installedTemplateVersion",
    "stateTemplateVersion",
    "`templateVersion` as an alias",
    "Wait authority and transport are separate fields",
    "hostWaitRequired",
    "canonical` authority on a selection/event",
    "There is no Synod thread/resume observer.",
    "schema-1 `JobHandle`/`JobEvent` contract",
    "does not persist job records",
    "App Server provenance has `transport`",
    "canonical provenance has `sourceSequence`",
    "host provenance has `observationId`",
    "The `mode` field belongs to `WaitReport`, not `JobEvent`.",
  ]) {
    assert.ok(readme.includes(phrase), `README must document ${phrase}`);
  }
  assert.equal(releasing.match(/release_version="\$\{RELEASE_VERSION/g)?.length, 2);
  assert.ok(packageSmoke.includes("hostWaitRequired"));
  assert.ok(packageSmoke.includes("validateJobHandle"));
  assert.ok(packageSmoke.includes("stateTemplateVersion"));
});

test("release closeout validation is strict across pre-tag and post-publication phases", async () => {
  const [rootText, archivedText] = await Promise.all([
    readFile(closeoutPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
  ]);
  const root = parseJson(rootText);
  const archived = parseJson(archivedText);
  const expected = {
    expectedPackage: "@ivand890/synod",
    expectedVersion: "0.9.4",
    expectedTag: "v0.9.4",
  } as const;
  assert.ok(isRecord(root) && isRecord(root.publicVerification));
  const rootPublicationStatus = root.publicVerification.status;
  if (rootPublicationStatus === "pending") {
    assert.deepEqual(validateReleaseCloseout(root, { phase: "pre-tag", ...expected }), {
      phase: "pre-tag",
      package: "@ivand890/synod",
      version: "0.9.4",
      tag: "v0.9.4",
    });
    assert.deepEqual(validateReleaseCloseout(root, {
      phase: "tag",
      ...expected,
      expectedTagSha: "0123456789abcdef0123456789abcdef01234567",
    }), {
      phase: "tag",
      package: "@ivand890/synod",
      version: "0.9.4",
      tag: "v0.9.4",
    });
  } else if (rootPublicationStatus === "verified") {
    assert.ok(isRecord(root.sourcePreparation));
    const recordedTagSha = root.sourcePreparation.tagSha;
    assert.equal(typeof recordedTagSha, "string");
    assert.deepEqual(validateReleaseCloseout(root, {
      phase: "post-publication",
      ...expected,
      expectedTagSha: recordedTagSha as string,
    }), {
      phase: "post-publication",
      package: "@ivand890/synod",
      version: "0.9.4",
      tag: "v0.9.4",
      tagSha: recordedTagSha,
    });
  } else {
    assert.fail(`root closeout has an unsupported publication status: ${String(rootPublicationStatus)}`);
  }
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
  const archivedPublication = isRecord(archived) && isRecord(archived.publicVerification)
    ? archived.publicVerification
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

  const malformedPublication = clone(archived);
  assert.ok(isRecord(malformedPublication) && isRecord(malformedPublication.publicVerification));
  assert.ok(isRecord(malformedPublication.publicVerification.npm));
  malformedPublication.publicVerification.npm.gitHead = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(
    () => validateReleaseCloseout(malformedPublication, {
      phase: "post-publication",
      expectedPackage: "@ivand890/synod",
      expectedVersion: "0.9.3",
      expectedTag: "v0.9.3",
      expectedTagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
    }),
    error => error instanceof ReleaseCloseoutValidationError && /publicVerification\.npm/.test(error.message),
  );
});

test("public closeout comparisons fail closed on registry and GitHub mismatches", () => {
  const recordedNpm = {
    package: "@ivand890/synod",
    version: "0.9.3",
    gitHead: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
    latest: "0.9.3",
    integrity: "sha512-U9NagkGCOWXHQ3giKEBRaD87UGI6hwAn7Emd5sJwdhr6Qp10zdWHe+DGrNz1iSjkXzxczSzYd6RsivKwtQAa7w==",
    attestationUrl: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.9.3",
    provenancePredicateType: "https://slsa.dev/provenance/v1",
  } as const;
  const recordedGitHub = {
    tag: "v0.9.3",
    url: "https://github.com/ivand890/synod/releases/tag/v0.9.3",
    publishedAt: "2026-08-14T19:29:39Z",
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
  const commandRunner = (command: string, args: readonly string[]): string => {
    if (command === "npm") {
      return JSON.stringify({
        version: "0.9.3",
        gitHead: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
        "dist-tags.latest": "0.9.3",
        "dist.integrity": "sha512-U9NagkGCOWXHQ3giKEBRaD87UGI6hwAn7Emd5sJwdhr6Qp10zdWHe+DGrNz1iSjkXzxczSzYd6RsivKwtQAa7w==",
        "dist.attestations": {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@ivand890%2fsynod@0.9.3",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      });
    }
    if (command === "gh" && args[1] === "repos/ivand890/synod/releases/latest") {
      return JSON.stringify({ tag_name: "v0.9.3" });
    }
    if (command === "gh") {
      return JSON.stringify({
        tag_name: "v0.9.3",
        html_url: "https://github.com/ivand890/synod/releases/tag/v0.9.3",
        published_at: "2026-08-14T19:29:39Z",
        draft: false,
        prerelease: false,
        immutable: true,
      });
    }
    if (command === "pnpm" && args[0] === "add") return "";
    if (command === "pnpm") return "0.9.3\n";
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  try {
    const result = verifyPublicReleaseCloseout({
      filePath: "release-closeouts/v0.9.3.json",
      expectedPackage: "@ivand890/synod",
      expectedVersion: "0.9.3",
      expectedTag: "v0.9.3",
      expectedTagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
      repository: "ivand890/synod",
      commandRunner,
    });
    assert.equal(result.registryInstallVersion, "0.9.3");
    assert.equal(result.publicCliVersion, "0.9.3");

    assert.throws(
      () => verifyPublicReleaseCloseout({
        filePath: "RELEASE-CLOSEOUT.json",
        expectedPackage: "@ivand890/synod",
        expectedVersion: "0.9.4",
        expectedTag: "v0.9.4",
        expectedTagSha: "0123456789abcdef0123456789abcdef01234567",
        repository: "ivand890/synod",
        commandRunner: () => { throw new Error("live command must not run for a pending record"); },
      }),
      /sourcePreparation|publicVerification\.status/,
    );

    assert.throws(
      () => verifyPublicReleaseCloseout({
        filePath: "release-closeouts/v0.9.3.json",
        expectedPackage: "@ivand890/synod",
        expectedVersion: "0.9.3",
        expectedTag: "v0.9.3",
        expectedTagSha: "ddbcaf4953f1dd3f0ec5cb82ba6403b6e9699788",
        repository: "ivand890/synod",
        commandRunner: (command, args) => {
          if (command === "npm") return JSON.stringify({ version: "0.9.3", gitHead: "wrong", "dist-tags.latest": "0.9.3", "dist.integrity": "wrong", "dist.attestations": { url: "wrong", provenance: { predicateType: "wrong" } } });
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

test("cycle GIF capture is a dependency-free deterministic contract", async () => {
  const script = await readFile(gifScriptPath, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /CHROME_BIN/);
  assert.match(script, /FFMPEG_BIN/);
  assert.match(script, /--window-size=1120,622/);
  assert.match(script, /-framerate 3/);
  assert.ok(script.includes("expected_frames=$(( ${#normal_steps[@]} + ${#correction_steps[@]} ))"));
  assert.match(script, /expected 33/);
  assert.match(script, /normal_steps=\(/);
  assert.match(script, /correction_steps=\(/);
  assert.match(script, /normalFrames < 1 \|\| correctionFrames < 1/);
  assert.match(script, /--dump-dom/);
  assert.match(script, /bytes\[index \+ 7\] !== 0x00/);
  assert.match(script, /bytes\[index \+ 8\] !== 0x2c && bytes\[index \+ 8\] !== 0x21/);
  assert.match(script, /gif-capture-sentinel/);
  assert.match(script, /normalHashes/);
  assert.match(script, /correctionHashes/);
  assert.match(script, /validate_gif/);
  assert.match(script, /asset_sibling/);
  assert.match(script, /mv -f "\$asset_sibling" "\$output_path"/);
  assert.doesNotMatch(script, /mv -f "\$temporary_output" "\$output_path"/);
  assert.match(script, /mktemp -d/);
  const normalSteps = script.match(/normal_steps=\(([\s\S]*?)\n\)/)?.[1];
  const correctionSteps = script.match(/correction_steps=\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(normalSteps);
  assert.ok(correctionSteps);
  assert.match(normalSteps, /(?:^|\s)"done"(?:\s|$)/);
  assert.match(correctionSteps, /(?:^|\s)"done"(?:\s|$)/);
});

test("Synod cycle visualizer documents the executable lease and wait boundaries", async () => {
  const cycle = await readFile(cyclePath, "utf8");
  const cycleGif = await readFile(cycleGifPath);
  const lifecycle = "READY → reserve → read-only spawn → bind-driven ACTIVE → explicit supervisor authorization → task-aware wait → proposal submit → REVIEW → ACCEPTED → VERIFIED → DONE → checkpoint";

  assert.ok(cycle.includes(lifecycle), "the visualizer must expose the executable lifecycle");
  for (const phrase of [
    "writeAuthorized:false",
    "bind moves the task to ACTIVE",
    "waitAuthority: canonical",
    "waitAuthority: appServer",
    "waitAuthority: host",
    "mode",
    "authority ≠ mode",
    "notLoaded",
    "notification",
    "cursor",
    "poll",
    "handoff",
    "same available worker",
    "fresh reservation",
    "lease-generation bind",
    "explicit recovery",
    "Acceptance evidence",
    "Verification evidence",
    "checkpoint",
  ]) {
    assert.ok(cycle.includes(phrase), `cycle visualizer must document ${phrase}`);
  }

  assert.match(cycle, /<noscript>[\s\S]*READY → reserve[\s\S]*checkpoint[\s\S]*<\/noscript>/);
  assert.match(cycle, /prefers-reduced-motion/);
  assert.match(cycle, /window\.history\.replaceState/);
  assert.match(cycle, /document\.addEventListener\("keydown"/);
  assert.match(cycle, /mobile-snapshot/);
  assert.match(cycle, /params\.get\("capture"\) === "gif"/);
  assert.match(cycle, /gif-capture-sentinel/);
  assert.match(cycle, /captureRequestError/);
  assert.match(cycle, /requestedScenarioKnown/);
  assert.match(cycle, /gif-capture/);
  assert.match(cycle, /aria-label=/);
  assert.doesNotMatch(cycle, /three concurrent agents|run three agents|Fill all three slots/i);
  assert.doesNotMatch(cycle, /task transition[^\n]*ACTIVE/i);

  assert.equal(cycleGif.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(cycleGif.readUInt16LE(6), 1120, "GIF logical screen width must remain 1120px");
  assert.equal(cycleGif.readUInt16LE(8), 622, "GIF logical screen height must remain 622px");
  let graphicControlFrames = 0;
  for (let index = 0; index + 2 < cycleGif.length; index += 1) {
    if (cycleGif[index] === 0x21 && cycleGif[index + 1] === 0xf9 && cycleGif[index + 2] === 0x04) {
      graphicControlFrames += 1;
    }
  }
  assert.equal(graphicControlFrames, 33, "GIF must contain one graphic-control marker per capture frame");
  assert.ok(cycleGif.length >= 100_000 && cycleGif.length <= 2_000_000, "GIF size must stay within the reviewed capture bounds");
});

test("durable release turn selects the oldest pending stable tag", () => {
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.3", "v0.5.2", "v0.5.1"]), "v0.5.2");
  assert.equal(nextReleaseTag("0.9.0", ["v0.10.0", "v0.9.1"]), "v0.9.1");
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.2-beta.1", "not-a-release"]), "");
  assert.throws(() => nextReleaseTag("latest", ["v0.5.2"]), /stable semantic version/);
});
