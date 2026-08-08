import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/publish.yml", import.meta.url);

test("publish workflow cannot succeed without npm and GitHub Release parity", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /permissions:\n  contents: write\n  id-token: write/);
  assert.match(workflow, /group: publish-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"[\s\S]*--draft[\s\S]*--verify-tag/);
  assert.match(workflow, /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=false/);
  assert.match(workflow, /npm view "@ivand890\/synod@\$package_version" gitHead/);
  assert.match(workflow, /releases\/latest" --jq \.tag_name/);

  const orderedSteps = [
    "Inspect existing npm publication",
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
