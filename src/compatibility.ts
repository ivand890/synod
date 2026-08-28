export interface SemanticVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string | undefined;
  build?: string | undefined;
}

export type CompatibilityStatus = "unsupported" | "supported" | "known-good";

export const CODEX_COMPATIBILITY = Object.freeze({
  supported: ">=0.148.0-0 <0.149.0 || >=0.150.0-0 <0.151.0 (all 0.148.x and 0.150.x variants)",
  knownGood: Object.freeze(["0.148.0-alpha.9"]),
  minimum: "0.148.0",
  maximumExclusive: "0.151.0"
} as const);

const SUPPORTED_CODEX_MINORS = new Set([148, 150]);

export function parseVersion(value: unknown): SemanticVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
  );
  if (!match) return undefined;
  const prerelease = match[4];
  if (prerelease?.split(".").some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return undefined;
  }
  return {
    raw: value.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5]
  };
}

export function compareVersions(left: string | SemanticVersion, right: string | SemanticVersion): -1 | 0 | 1 {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) throw new TypeError("Cannot compare invalid semantic versions.");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const leftIdentifiers = a.prerelease.split(".");
  const rightIdentifiers = b.prerelease.split(".");
  const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length < rightIdentifier.length ? -1 : 1;
      }
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function classifyCodexVersion(version: unknown): { status: CompatibilityStatus; reason: string } {
  const parsed = parseVersion(version);
  if (!parsed) return { status: "unsupported", reason: "invalid_version" };

  if (parsed.major === 0 && parsed.minor < 148) {
    return { status: "unsupported", reason: "below_supported_range" };
  }
  if (parsed.major !== 0 || !SUPPORTED_CODEX_MINORS.has(parsed.minor)) {
    return { status: "unsupported", reason: "above_tested_range" };
  }

  if (CODEX_COMPATIBILITY.knownGood.some(versionValue => compareVersions(parsed, versionValue) === 0)) {
    return { status: "known-good", reason: "tested_in_ci" };
  }
  return {
    status: "supported",
    reason: parsed.prerelease === undefined ? "inside_supported_range" : "preview_inside_supported_range"
  };
}
