#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compareVersions } from "../src/compatibility.js";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function nextReleaseTag(npmLatest, tags) {
  if (!STABLE_VERSION.test(npmLatest)) {
    throw new Error(`npm latest must be a stable semantic version, received ${npmLatest}`);
  }

  const pending = tags
    .filter(tag => tag.startsWith("v") && STABLE_VERSION.test(tag.slice(1)))
    .filter(tag => compareVersions(tag.slice(1), npmLatest) > 0)
    .sort((left, right) => compareVersions(left.slice(1), right.slice(1)));
  return pending[0] ?? "";
}

function readRepositoryTags() {
  return execFileSync("git", ["tag", "--list", "v*.*.*"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nextTag = nextReleaseTag(process.argv[2] ?? "", readRepositoryTags());
  process.stdout.write(nextTag);
}
