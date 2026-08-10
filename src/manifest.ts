import { readFile } from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, SynodError } from "./errors.js";
import { inspectPath, unsafeAncestor } from "./filesystem.js";
import { parseVersion } from "./compatibility.js";
import { errorMessage, isRecord, parseJson } from "./validation.js";

export const MANIFEST_PATH = ".synod/manifest.json";
export const MANIFEST_SCHEMA_VERSION = 3;
export type ManifestOwnership = "synod" | "shared" | "user" | "record";

export interface ManifestMigration {
  from: number;
  to: number;
}

export interface ManifestEntry {
  path: string;
  ownership: ManifestOwnership;
  contentHash: string;
  provenance?: string;
  separatorBefore?: string;
  separatorAmbiguous?: true;
}

export interface LegacyManifest {
  schemaVersion: 1;
  templateVersion: string;
  method?: string;
}

export interface ManagedManifest {
  schemaVersion: 2 | 3;
  templateVersion: string;
  method: "advisor-loop";
  profile: string;
  hashAlgorithm: "sha256";
  migrations: ManifestMigration[];
  files: ManifestEntry[];
}

export type SynodManifest = LegacyManifest | ManagedManifest;

const recordPaths = new Set([
  ".synod/state.json",
  ".synod/events.jsonl",
  ".synod/checkpoint.json",
  "docs/synod/STATUS.md"
]);

function allowedManifestPath(value: string): boolean {
  if (value === "AGENTS.md" || value === ".codex/config.toml") return true;
  return recordPaths.has(value)
    || value.startsWith("docs/synod/")
    || value.startsWith(".codex/agents/synod-")
    || value.startsWith(".agents/skills/synod-advisor/");
}

export function serializeManifest(manifest: ManagedManifest): string {
  return `${JSON.stringify({
    ...manifest,
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  }, null, 2)}\n`;
}

export function createManifest({
  templateVersion,
  profile,
  files,
  migrations = [],
  schemaVersion = MANIFEST_SCHEMA_VERSION
}: {
  templateVersion: string;
  profile: string;
  files: ManifestEntry[];
  migrations?: ManifestMigration[];
  schemaVersion?: 2 | 3;
}): ManagedManifest {
  return {
    schemaVersion,
    templateVersion,
    method: "advisor-loop",
    profile,
    hashAlgorithm: "sha256",
    migrations,
    files
  };
}

function isMigration(value: unknown): value is ManifestMigration {
  return isRecord(value) && Number.isInteger(value.from) && Number.isInteger(value.to);
}

function isManifestOwnership(value: unknown): value is ManifestOwnership {
  return value === "synod" || value === "shared" || value === "user" || value === "record";
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return isRecord(value)
    && typeof value.path === "string"
    && isManifestOwnership(value.ownership)
    && typeof value.contentHash === "string"
    && (value.provenance === undefined || typeof value.provenance === "string")
    && (value.separatorBefore === undefined || typeof value.separatorBefore === "string")
    && (value.separatorAmbiguous === undefined || value.separatorAmbiguous === true);
}

function isManagedManifest(value: unknown): value is ManagedManifest {
  return isRecord(value)
    && (value.schemaVersion === 2 || value.schemaVersion === 3)
    && typeof value.templateVersion === "string"
    && value.method === "advisor-loop"
    && typeof value.profile === "string"
    && value.hashAlgorithm === "sha256"
    && Array.isArray(value.migrations)
    && value.migrations.every(isMigration)
    && Array.isArray(value.files)
    && value.files.every(isManifestEntry);
}

function isLegacyManifest(value: unknown): value is LegacyManifest {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.templateVersion === "string"
    && (value.method === undefined || typeof value.method === "string");
}

export function validateManifest(manifest: unknown, { allowLegacy = true }: { allowLegacy?: boolean } = {}): SynodManifest {
  if (!isRecord(manifest)) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Synod manifest must be a JSON object.");
  }
  if (typeof manifest.schemaVersion === "number" && manifest.schemaVersion < MANIFEST_SCHEMA_VERSION && allowLegacy) {
    if (manifest.schemaVersion === 1) {
      if (!parseVersion(manifest.templateVersion)) {
        throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Legacy manifest is missing templateVersion.");
      }
      if (!isLegacyManifest(manifest)) {
        throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Legacy manifest shape is invalid.");
      }
      return manifest;
    }
    if (manifest.schemaVersion === 2) return validateSchema2Manifest(manifest);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new SynodError(
      ERROR_CODES.MANIFEST_UNSUPPORTED,
      `Unsupported Synod manifest schema: ${manifest.schemaVersion}`,
      { details: { schemaVersion: manifest.schemaVersion, supported: [1, 2, MANIFEST_SCHEMA_VERSION] } }
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
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      path.posix.normalize(entry.path) !== entry.path ||
      !allowedManifestPath(entry.path) ||
      seen.has(entry.path)
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest contains an invalid or duplicate path.", {
      details: { path: isRecord(entry) ? entry.path : undefined }
      });
    }
    if (!isManifestOwnership(entry.ownership)) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid ownership for ${entry.path}.`);
    }
    if (
      (entry.path === "AGENTS.md" && entry.ownership !== "shared") ||
      (recordPaths.has(entry.path) && entry.ownership !== "record") ||
      (entry.path.startsWith("docs/synod/") && !recordPaths.has(entry.path) && entry.ownership !== "user") ||
      (entry.path !== "AGENTS.md" && entry.ownership === "shared") ||
      (!recordPaths.has(entry.path) && entry.ownership === "record") ||
      ((entry.path.startsWith(".codex/agents/") || entry.path.startsWith(".agents/skills/")) && entry.ownership !== "synod")
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Ownership does not match the managed path ${entry.path}.`);
    }
    if (typeof entry.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.contentHash)) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid content hash for ${entry.path}.`);
    }
    if (
      entry.separatorBefore !== undefined
      && (
        entry.path !== "AGENTS.md"
        || typeof entry.separatorBefore !== "string"
        || !["", "\n", "\n\n"].includes(entry.separatorBefore)
      )
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid managed separator for ${entry.path}.`);
    }
    if (
      entry.separatorAmbiguous !== undefined
      && (entry.path !== "AGENTS.md" || entry.separatorAmbiguous !== true)
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Invalid managed separator state for ${entry.path}.`);
    }
    seen.add(entry.path);
  }
  if (!isManagedManifest(manifest) || manifest.schemaVersion !== 3) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest contains invalid migrations or metadata.");
  }
  return manifest;
}

function validateSchema2Manifest(manifest: Record<string, unknown>): ManagedManifest {
  if (!parseVersion(manifest.templateVersion) || typeof manifest.profile !== "string") {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest is missing templateVersion or profile.");
  }
  if (manifest.hashAlgorithm !== "sha256" || !Array.isArray(manifest.files)) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Manifest hashAlgorithm or files collection is invalid.");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !isRecord(entry) || typeof entry.path !== "string" || !allowedManifestPath(entry.path)
      || seen.has(entry.path) || typeof entry.ownership !== "string"
      || !["synod", "shared", "user"].includes(entry.ownership)
      || typeof entry.contentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.contentHash)
    ) {
      throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Schema 2 manifest contains an invalid entry.", {
        details: { path: isRecord(entry) ? entry.path : undefined }
      });
    }
    seen.add(entry.path);
  }
  if (!isManagedManifest(manifest) || manifest.schemaVersion !== 2) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, "Schema 2 manifest metadata is invalid.");
  }
  return manifest;
}

export async function readManifest(
  targetDirectory: string,
  { required = true }: { required?: boolean } = {}
): Promise<SynodManifest | undefined> {
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
  let manifest: unknown;
  try {
    manifest = parseJson(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Could not parse ${MANIFEST_PATH}: ${errorMessage(error)}`, {
      cause: error
    });
  }
  return validateManifest(manifest);
}

export function manifestFileMap(manifest: ManagedManifest): Map<string, ManifestEntry> {
  return new Map(manifest.files.map(entry => [entry.path, entry]));
}
