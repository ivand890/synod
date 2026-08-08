import { readFile } from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, SynodError } from "./errors.js";
import { inspectPath, unsafeAncestor } from "./filesystem.js";
import { parseVersion } from "./compatibility.js";

export const MANIFEST_PATH = ".synod/manifest.json";
export const MANIFEST_SCHEMA_VERSION = 2;
const ownershipValues = new Set(["synod", "shared", "user"]);

function allowedManifestPath(value) {
  if (value === "AGENTS.md" || value === ".codex/config.toml") return true;
  return value.startsWith("docs/synod/")
    || value.startsWith(".codex/agents/synod-")
    || value.startsWith(".agents/skills/synod-advisor/");
}

export function serializeManifest(manifest) {
  return `${JSON.stringify({
    ...manifest,
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  }, null, 2)}\n`;
}

export function createManifest({ templateVersion, profile, files, migrations = [] }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    templateVersion,
    method: "advisor-loop",
    profile,
    hashAlgorithm: "sha256",
    migrations,
    files
  };
}

export function validateManifest(manifest, { allowLegacy = true } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Synod manifest must be a JSON object.");
  }
  if (manifest.schemaVersion === 1 && allowLegacy) {
    if (!parseVersion(manifest.templateVersion)) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Legacy manifest is missing templateVersion.");
    }
    return manifest;
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new SynodError(
      ERROR_CODES.MANIFEST_UNSUPPORTED,
      `Unsupported Synod manifest schema: ${manifest.schemaVersion}`,
      { details: { schemaVersion: manifest.schemaVersion, supported: [1, MANIFEST_SCHEMA_VERSION] } }
    );
  }
  if (!parseVersion(manifest.templateVersion) || typeof manifest.profile !== "string") {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest is missing templateVersion or profile.");
  }
  if (manifest.hashAlgorithm !== "sha256" || !Array.isArray(manifest.files)) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest hashAlgorithm or files collection is invalid.");
  }

  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      path.posix.normalize(entry.path) !== entry.path ||
      !allowedManifestPath(entry.path) ||
      seen.has(entry.path)
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest contains an invalid or duplicate path.", {
        details: { path: entry?.path }
      });
    }
    if (!ownershipValues.has(entry.ownership)) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid ownership for ${entry.path}.`);
    }
    if (
      (entry.path === "AGENTS.md" && entry.ownership !== "shared") ||
      (entry.path.startsWith("docs/synod/") && entry.ownership !== "user") ||
      (entry.path !== "AGENTS.md" && entry.ownership === "shared") ||
      ((entry.path.startsWith(".codex/agents/") || entry.path.startsWith(".agents/skills/")) && entry.ownership !== "synod")
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Ownership does not match the managed path ${entry.path}.`);
    }
    if (typeof entry.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.contentHash)) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid content hash for ${entry.path}.`);
    }
    if (
      entry.separatorBefore !== undefined
      && (entry.path !== "AGENTS.md" || !["", "\n", "\n\n"].includes(entry.separatorBefore))
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid managed separator for ${entry.path}.`);
    }
    seen.add(entry.path);
  }
  return manifest;
}

export async function readManifest(targetDirectory, { required = true } = {}) {
  const manifestPath = path.join(targetDirectory, ...MANIFEST_PATH.split("/"));
  const unsafe = await unsafeAncestor(targetDirectory, manifestPath);
  if (unsafe) {
    throw new SynodError(ERROR_CODES.UNSAFE_PATH, `Refusing to read the manifest through unsafe path: ${unsafe}`, {
      details: { path: MANIFEST_PATH, unsafeAncestor: unsafe }
    });
  }
  const inspected = await inspectPath(manifestPath);
  if (inspected.type === "missing") {
    if (!required) return undefined;
    throw new SynodError(ERROR_CODES.NOT_INSTALLED, `Synod is not installed in ${targetDirectory}.`, {
      details: { targetDirectory, manifestPath: MANIFEST_PATH }
    });
  }
  if (inspected.type !== "file") {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Synod manifest is not a regular file.", {
      details: { actualType: inspected.type }
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Could not parse ${MANIFEST_PATH}: ${error.message}`, {
      cause: error
    });
  }
  return validateManifest(manifest);
}

export function manifestFileMap(manifest) {
  return new Map(manifest.files.map(entry => [entry.path, entry]));
}
