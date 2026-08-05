import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bin = path.resolve("bin/synod.js");

test("the installed entry point initializes a target directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synod-cli-test-"));

  try {
    const result = spawnSync(process.execPath, [bin, "init", directory], {
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Synod initialized/);
    assert.match(await readFile(path.join(directory, "docs/synod/PLAN.md"), "utf8"), /Synod Execution Plan/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prints version and help", () => {
  const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });

  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "0.3.0");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /synod init/);
  assert.match(help.stdout, /synod usage/);
});
