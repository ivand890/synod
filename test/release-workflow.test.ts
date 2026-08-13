import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextReleaseTag } from "../scripts/next-release-tag.js";
import { isRecord, parseJson } from "../src/validation.js";

const workflowPath = new URL("../.github/workflows/publish.yml", import.meta.url);
const ciWorkflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);
const packageSmokePath = new URL("../scripts/package-smoke.ts", import.meta.url);

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
  assert.match(packageSmoke, /tokenCounters\.resets !== 1/);
  assert.match(packageSmoke, /setTaskBudgetPolicy/);
  assert.match(packageSmoke, /prepareProjectRotation/);
  assert.match(packageSmoke, /verifyProjectRotation/);
  assert.match(packageSmoke, /projectUsageCost/);
  assert.match(packageSmoke, /beforeReadOnly\.every/);
});

test("durable release turn selects the oldest pending stable tag", () => {
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.3", "v0.5.2", "v0.5.1"]), "v0.5.2");
  assert.equal(nextReleaseTag("0.9.0", ["v0.10.0", "v0.9.1"]), "v0.9.1");
  assert.equal(nextReleaseTag("0.5.1", ["v0.5.2-beta.1", "not-a-release"]), "");
  assert.throws(() => nextReleaseTag("latest", ["v0.5.2"]), /stable semantic version/);
});
