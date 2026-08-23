import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const readmePath = new URL("../README.md", import.meta.url);
const productPath = new URL("../PRODUCT.md", import.meta.url);
const releasingPath = new URL("../RELEASING.md", import.meta.url);
const closeoutPath = new URL("../RELEASE-CLOSEOUT.json", import.meta.url);
const archivedCloseoutPath = new URL("../release-closeouts/v0.9.3.json", import.meta.url);
const archivedPreviousCloseoutPath = new URL("../release-closeouts/v0.9.4.json", import.meta.url);
const archived095CloseoutPath = new URL("../release-closeouts/v0.9.5.json", import.meta.url);
const archivedCurrentCloseoutPath = new URL("../release-closeouts/v0.11.0.json", import.meta.url);
const archivedV011CloseoutSha256 = "20d384f89d687f7f4bcc7ad13aae523e7f913c2212e2eb52acb42d2b30e84e83";
const gifScriptPath = new URL("../scripts/capture-synod-cycle-gif.sh", import.meta.url);
const cyclePath = new URL("../docs/synod/synod-cycle.html", import.meta.url);
const cycleGifPath = new URL("../docs/synod/assets/synod-cycle-loop.gif", import.meta.url);

function gifValidatorSource(script: string): string {
  const commandStart = script.indexOf('node --input-type=module - "$gif_path"');
  assert.ok(commandStart >= 0, "GIF validator command must be present");
  const heredocStart = script.indexOf("<<'NODE'\n", commandStart);
  assert.ok(heredocStart >= 0, "GIF validator heredoc must be present");
  const sourceStart = heredocStart + "<<'NODE'\n".length;
  const sourceEnd = script.indexOf("\nNODE", sourceStart);
  assert.ok(sourceEnd >= 0, "GIF validator heredoc must be terminated");
  return script.slice(sourceStart, sourceEnd);
}

function gifComment(payload: Buffer): Buffer {
  const chunks: Uint8Array[] = [Buffer.from([0x21, 0xfe])];
  for (let offset = 0; offset < payload.length; offset += 255) {
    const block = payload.subarray(offset, offset + 255);
    chunks.push(Buffer.from([block.length]), block);
  }
  chunks.push(Buffer.from([0x00]));
  return Buffer.concat(chunks);
}

function syntheticGif(frameCount: number, commentPayload = Buffer.alloc(100_000, 0x7f)): Buffer {
  const chunks: Buffer[] = [Buffer.from("GIF89a", "ascii")];
  const logicalScreen = Buffer.alloc(7);
  logicalScreen.writeUInt16LE(1120, 0);
  logicalScreen.writeUInt16LE(622, 2);
  chunks.push(logicalScreen, gifComment(commentPayload));
  for (let frame = 0; frame < frameCount; frame += 1) {
    chunks.push(Buffer.from([
      0x21, 0xf9, 0x04, 0x00, 0x21, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00
    ]));
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

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

test("release source, archived evidence, and product/docs contract stay explicit", async () => {
  const [packageText, changelog, roadmap, readme, product, releasing, archivedCloseoutText, closeoutText, archivedCurrentCloseoutText, packageSmoke, archivedPreviousCloseoutText, archived095CloseoutText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(changelogPath, "utf8"),
    readFile(roadmapPath, "utf8"),
    readFile(readmePath, "utf8"),
    readFile(productPath, "utf8"),
    readFile(releasingPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
    readFile(closeoutPath, "utf8"),
    readFile(archivedCurrentCloseoutPath, "utf8"),
    readFile(packageSmokePath, "utf8"),
    readFile(archivedPreviousCloseoutPath, "utf8"),
    readFile(archived095CloseoutPath, "utf8")
  ]);
  const packageJson = parseJson(packageText);
  const closeout = parseJson(archivedCloseoutText);
  const currentCloseout = parseJson(closeoutText);
  const archivedCurrentCloseout = parseJson(archivedCurrentCloseoutText);
  const archivedPreviousCloseout = parseJson(archivedPreviousCloseoutText);
  const archived095Closeout = parseJson(archived095CloseoutText);
  assert.ok(isRecord(packageJson));
  assert.ok(isRecord(closeout));
  assert.equal(packageJson.version, "0.12.0");
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
  assert.equal(currentCloseout.version, "0.12.0");
  assert.equal(currentCloseout.tag, "v0.12.0");
  assert.ok(isRecord(currentCloseout.sourcePreparation));
  assert.equal(currentCloseout.sourcePreparation.status, "prepared");
  assert.equal(Object.hasOwn(currentCloseout.sourcePreparation, "tagSha"), false);
  assert.ok(isRecord(currentCloseout.publicVerification));
  assert.equal(currentCloseout.publicVerification.status, "pending");
  assert.ok(isRecord(currentCloseout.documentation));
  assert.equal(currentCloseout.documentation.status, "pending");
  assert.notEqual(closeoutText, archivedCurrentCloseoutText, "prepared 0.12.0 root closeout must not replace archived 0.11.0 evidence");
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

  assert.match(changelog, /^## \[0\.12\.0\] - 2026-08-23$/m);
  assert.match(changelog, /validated concurrency policy and CLI App Server runner/);
  assert.match(changelog, /zero-write observer leases/);
  assert.match(changelog, /typed reviewer and verifier approval lanes/);
  assert.match(changelog, /bounded parallel delegation/);
  assert.match(changelog, /^## \[0\.9\.5\] - 2026-08-15$/m);
  assert.match(changelog, /Project-local `status` now accepts the `--task`, `--active-only`, and/);
  assert.match(changelog, /^## \[0\.9\.3\] - 2026-08-14$/m);
  assert.match(changelog, /^## \[0\.9\.4\] - 2026-08-15$/m);
  assert.match(changelog, /\[Unreleased\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.12\.0\.\.\.HEAD/);
  assert.match(changelog, /\[0\.12\.0\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.11\.0\.\.\.v0\.12\.0/);
  assert.match(changelog, /\[0\.11\.0\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.5\.\.\.v0\.11\.0/);
  assert.match(changelog, /\[0\.9\.5\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.4\.\.\.v0\.9\.5/);
  assert.match(changelog, /\[0\.9\.4\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.3\.\.\.v0\.9\.4/);
  assert.match(changelog, /\[0\.9\.3\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.2\.\.\.v0\.9\.3/);
  assert.match(roadmap, /Current public release: `v0\.11\.0`/);
  assert.match(roadmap, /Current source release: `v0\.11\.0`/);
  assert.match(roadmap, /Last verified public release at this update: `v0\.11\.0`/);
  assert.match(roadmap, /release-closeouts\/v0\.11\.0\.json/);
  assert.match(roadmap, /prior `v0\.9\.5`[\s\S]*release-closeouts\/v0\.9\.5\.json/);
  assert.match(roadmap, /signed tag and GitHub Release `isImmutable: true` provide the external\s+release anchors/);
  assert.match(roadmap, /the root\s+`RELEASE-CLOSEOUT\.json` records the same closed and\s+verified `v0\.11\.0` evidence/);
  assert.doesNotMatch(roadmap, /public latest remains/);
  assert.match(roadmap, /Status: delivered and publicly verified/);
  assert.doesNotMatch(roadmap, /last verified public package remains `v0\.9\.2`/i);
  assert.doesNotMatch(roadmap, /public verification remains `v0\.9\.2`/i);
  assert.match(roadmap, /\| SYN-093-VERSIONS-001 \|/);
  assert.match(roadmap, /## v0\.9\.4 — Review, host, status, and recovery surfaces/);
  assert.match(roadmap, /public and pinned `v0\.9\.4` runtimes/);
  assert.match(roadmap, /public\/pinned `v0\.9\.4` `doctor`\s+support expression/);
  assert.doesNotMatch(roadmap, /unshipped|unreleased/);
  assert.match(roadmap, /v0\.9\.5 release requires Node `>=22`/);
  assert.match(roadmap, /## v0\.9\.5 — Status bootstrap hotfix/);
  assert.match(roadmap, /SYN-095-STATUS-BOOTSTRAP-024/);
  assert.match(roadmap, /`--task`, `--active-only`, and\s+`--changed-since-checkpoint`/);
  assert.match(roadmap, /every valid numeric\s+`0\.148\.x` variant/);
  for (const taskId of [
    "SYN-094-REVIEW-001",
    "SYN-094-HOST-002",
    "SYN-094-STATUS-003",
    "SYN-094-SURFACES-004",
    "SYN-094-PACKAGE-CLEANUP-005",
    "SYN-094-DOC-VERSION-006",
    "SYN-094-RELEASE-011",
  ]) {
    assert.match(roadmap, new RegExp(`\\| ${taskId} \\|`), `ROADMAP must include ${taskId} in the release section`);
  }
  const v093Start = roadmap.indexOf("## v0.9.3");
  const v094Start = roadmap.indexOf("## v0.9.4", v093Start);
  assert.ok(v093Start >= 0 && v094Start > v093Start, "ROADMAP release section must follow v0.9.3");
  assert.doesNotMatch(roadmap.slice(v093Start, v094Start), /SYN-094-SURFACES-004/);
  assert.doesNotMatch(roadmap, /two-phase closeout on `main`/i);

  assert.match(readme, /Public release and source tree/);
  assert.match(readme, /signed tag commit[\s\S]*externally immutable/);
  assert.match(readme, /Post-publication evidence is recorded in the versioned/);
  assert.match(readme, /Post-publication evidence is recorded in the versioned[\s\S]*release-closeouts\/v0\.11\.0\.json/);
  assert.match(readme, /prior[\s\S]*release-closeouts\/v0\.9\.5\.json/);
  assert.match(readme, /public and pinned `@ivand890\/synod@0\.11\.0`/);
  assert.match(readme, /root[\s\S]*RELEASE-CLOSEOUT\.json[\s\S]*same verified[\s\S]*public v0\.11\.0 evidence/);
  assert.match(readme, /The v0\.11\.0 source surfaces include/);
  assert.match(readme, /0\.9\.5 hotfix, retained in 0\.11\.0, makes[\s\S]*mixed selectors still\s+fail closed/);
  assert.match(readme, /v0\.11\.0 release requires Node\.js `>=22`/);
  assert.match(readme, /public\/pinned\s+`v0\.11\.0` `doctor` support expression/);
  assert.match(readme, /Known-good and exercised in CI: `0\.148\.0-alpha\.9`/);
  assert.doesNotMatch(readme, /candidate support expression `>=0\.142\.0 <0\.148\.0/);
  assert.match(readme, /synod task correct/);
  assert.match(readme, /Git-lane provenance/);
  assert.match(readme, /HostDelegationAdapter/);
  assert.match(readme, /include-local-docs/);
  assert.match(readme, /phase-2 live verifier\s+runs\s+on the protected\s+closeout PR/);
  assert.match(readme, /phase-2 live verifier\s+runs\s+on the protected\s+closeout PR,\s*not the tag\s+workflow/);
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
  assert.match(product, /0\.9\.5 hotfix, retained in 0\.11\.0, also makes the `--task`,\s+`--active-only`, and\s+`--changed-since-checkpoint` selectors/);
  assert.match(product, /Node\.js `>=22`/);
  assert.match(product, /numeric major and\s+minor are `0\.148`/);

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

  assert.match(releasing, /public `v0\.11\.0` source is anchored by signed tag commit/);
  assert.match(releasing, /externally immutable GitHub\s+Release \(`isImmutable: true`\)/);
  assert.match(releasing, /signed tag commit\s+`a120f958f7bd86bf4efeebbf1dd8f88019da1ab8`/);
  assert.match(releasing, /`release-closeouts\/v0\.11\.0\.json`/);
  assert.match(releasing, /prior `v0\.9\.5` evidence[\s\S]*`release-closeouts\/v0\.9\.5\.json`/);
  assert.match(releasing, /root\s+`RELEASE-CLOSEOUT\.json` records the same closed and verified public `v0\.11\.0`\s+evidence/);
  assert.doesNotMatch(releasing, /Public latest remains/);
  assert.doesNotMatch(releasing, /pre-tag candidate record/);
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
  assert.match(releasing, /phase-2 live verifier runs on the protected\s+closeout PR,\s*not the tag\s+workflow/);
  assert.match(roadmap, /phase-2 live verifier runs on the protected\s+closeout PR,\s*not the tag\s+workflow/);

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
      `${label} must not attribute verified v0.9.4 evidence to the pending root closeout`,
    );
  }

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
  assert.equal(releasing.match(/release_version="\$\{RELEASE_VERSION/g)?.length, 3);
  assert.ok(packageSmoke.includes("hostWaitRequired"));
  assert.ok(packageSmoke.includes("validateJobHandle"));
  assert.ok(packageSmoke.includes("stateTemplateVersion"));
});

test("release closeout validation is strict across pre-tag and post-publication phases", async () => {
  const [rootText, archivedText, archivedPreviousText, archivedCurrentText] = await Promise.all([
    readFile(closeoutPath, "utf8"),
    readFile(archivedCloseoutPath, "utf8"),
    readFile(archivedPreviousCloseoutPath, "utf8"),
    readFile(archivedCurrentCloseoutPath, "utf8"),
  ]);
  const root = parseJson(rootText);
  const archived = parseJson(archivedText);
  const archivedPrevious = parseJson(archivedPreviousText);
  const archivedCurrent = parseJson(archivedCurrentText);
  const expected = {
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
  assert.equal(root.publicVerification.status, "pending");
  assert.ok(isRecord(root.sourcePreparation));
  assert.equal(root.sourcePreparation.status, "prepared");
  assert.equal(Object.hasOwn(root.sourcePreparation, "tagSha"), false);
  assert.deepEqual(validateReleaseCloseout(root, {
    phase: "pre-tag",
    ...expected,
  }).phase, "pre-tag");
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

test("cycle GIF capture is a dependency-free deterministic contract", async () => {
  const script = await readFile(gifScriptPath, "utf8");
  const validator = gifValidatorSource(script);
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
  assert.match(validator, /requireBytes/);
  assert.match(validator, /skipSubBlocks/);
  assert.match(validator, /pendingGce/);
  assert.match(validator, /image descriptor has no preceding valid GCE/);
  assert.match(validator, /multiple pending GCE blocks/);
  assert.match(validator, /unknown GIF extension label/);
  assert.match(validator, /unknown GIF block marker/);
  assert.match(validator, /GIF trailer must be the final byte/);
  assert.doesNotMatch(validator, /for \(let index = 0; index \+ 8 < bytes\.length; index \+= 1\)/);
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

  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-gif-validator-test-"));
  try {
    const validPath = path.join(directory, "valid.gif");
    const markerLikePath = path.join(directory, "marker-like.gif");
    await writeFile(validPath, syntheticGif(33));
    const valid = spawnSync(
      process.execPath,
      ["--input-type=module", "-", validPath, "33", "13", "20"],
      { input: validator, encoding: "utf8" }
    );
    assert.equal(valid.status, 0, valid.stderr);

    const markerLikePayload = Buffer.concat([
      Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x21, 0x00, 0x00, 0x2c]),
      Buffer.alloc(100_000, 0x7f)
    ]);
    await writeFile(markerLikePath, syntheticGif(0, markerLikePayload));
    const markerLike = spawnSync(
      process.execPath,
      ["--input-type=module", "-", markerLikePath, "1", "1", "1"],
      { input: validator, encoding: "utf8" }
    );
    assert.notEqual(markerLike.status, 0);
    assert.match(markerLike.stderr, /expected 1 frames, found 0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
