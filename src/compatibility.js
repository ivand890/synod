export const CODEX_COMPATIBILITY = Object.freeze({
  supported: ">=0.142.0 <0.148.0",
  knownGood: Object.freeze(["0.142.0", "0.147.0"]),
  minimum: "0.142.0",
  maximumExclusive: "0.148.0"
});

export function parseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    raw: value.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) throw new TypeError("Cannot compare invalid semantic versions.");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function classifyCodexVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed || parsed.prerelease !== undefined) {
    return { status: "unsupported", reason: "invalid_or_prerelease" };
  }
  if (compareVersions(parsed, CODEX_COMPATIBILITY.minimum) < 0) {
    return { status: "unsupported", reason: "below_supported_range" };
  }
  if (compareVersions(parsed, CODEX_COMPATIBILITY.maximumExclusive) >= 0) {
    return { status: "unsupported", reason: "above_tested_range" };
  }
  if (CODEX_COMPATIBILITY.knownGood.includes(parsed.raw)) {
    return { status: "known-good", reason: "tested_in_ci" };
  }
  return { status: "supported", reason: "inside_supported_range" };
}
