import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextReleaseTag } from "../scripts/next-release-tag.js";
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

  assert.equal(workflow.match(/pnpm install --frozen-lockfile/g)?.length, 3);
  assert.match(workflow, /os: ubuntu-latest\n\s+node-version: 20/);
  assert.match(workflow, /os: ubuntu-latest\n\s+node-version: 22/);
  assert.match(workflow, /os: ubuntu-latest\n\s+node-version: 24/);
  assert.match(workflow, /os: macos-latest\n\s+node-version: 24/);
  assert.match(workflow, /os: windows-latest\n\s+node-version: 24/);
  assert.match(workflow, /run: pnpm test:package/);
});

test("installed-package smoke covers the v0.9 production-shaped release contract", async () => {
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
});

test("0.9.3 public release metadata and product/docs contract stay explicit", async () => {
  const [packageText, changelog, roadmap, readme, product, releasing, packageSmoke] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(changelogPath, "utf8"),
    readFile(roadmapPath, "utf8"),
    readFile(readmePath, "utf8"),
    readFile(productPath, "utf8"),
    readFile(releasingPath, "utf8"),
    readFile(packageSmokePath, "utf8")
  ]);
  const packageJson = parseJson(packageText);
  assert.ok(isRecord(packageJson));
  assert.equal(packageJson.version, "0.9.3");

  assert.match(changelog, /^## \[0\.9\.3\] - 2026-08-14$/m);
  assert.match(changelog, /\[Unreleased\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.3\.\.\.HEAD/);
  assert.match(changelog, /\[0\.9\.3\]: https:\/\/github\.com\/ivand890\/synod\/compare\/v0\.9\.2\.\.\.v0\.9\.3/);
  assert.match(roadmap, /Current source release: `v0\.9\.3`/);
  assert.match(roadmap, /Last verified public release at this update: `v0\.9\.3`/);
  assert.match(roadmap, /Status: delivered and publicly verified/);
  assert.doesNotMatch(roadmap, /last verified public package remains `v0\.9\.2`/i);
  assert.doesNotMatch(roadmap, /public verification remains `v0\.9\.2`/i);
  assert.match(roadmap, /\| SYN-093-VERSIONS-001 \|/);

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

  assert.match(releasing, /`v0\.9\.3` source-preparation entry is closed/);
  assert.match(releasing, /protected release procedure\s+for a future version/);
  assert.doesNotMatch(releasing, /source-preparation change\s+targets `0\.9\.3`; it does not create a tag, publish to npm, or create a GitHub\s+Release/);

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
