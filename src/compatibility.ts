export interface SemanticVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string | undefined;
  build?: string | undefined;
}

export type CompatibilityStatus = "unsupported" | "supported" | "known-good";
export type CompatibilitySurface = "cli" | "desktop" | "unknown";

export const CODEX_COMPATIBILITY = Object.freeze({
  policy: "current-and-previous-validated" as const,
  currentLine: "0.153",
  previousLine: "0.152",
  supported: "0.153.4 || 0.152.1 (validated patches only; surface-specific)",
  knownGood: Object.freeze(["0.153.4", "0.152.1"]),
  validatedVersions: Object.freeze({
    cli: Object.freeze(["0.153.4", "0.152.1"]),
    desktop: Object.freeze(["0.153.4"])
  }),
  minimum: "0.152.1",
  maximumExclusive: "0.154.0"
} as const);

export const CODEX_PROTOCOL_LABEL = "validated Codex 0.152/0.153";

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

export function classifyCodexVersion(version: unknown, surface: CompatibilitySurface = "cli"): { status: CompatibilityStatus; reason: string } {
  const parsed = parseVersion(version);
  if (!parsed) return { status: "unsupported", reason: "invalid_version" };

  if (parsed.major === 0 && parsed.minor < 152) {
    return { status: "unsupported", reason: "below_supported_range" };
  }
  if (parsed.major !== 0 || parsed.minor > 153) {
    return { status: "unsupported", reason: "above_tested_range" };
  }

  if (surface === "unknown") return { status: "unsupported", reason: "surface_unavailable" };
  if (CODEX_COMPATIBILITY.validatedVersions[surface].some(value => value === parsed.raw)) {
    return { status: "known-good", reason: "validated_patch" };
  }
  if (CODEX_COMPATIBILITY.knownGood.some(value => value === parsed.raw)) {
    return { status: "unsupported", reason: "surface_version_unvalidated" };
  }
  return { status: "unsupported", reason: "unvalidated_patch" };
}
