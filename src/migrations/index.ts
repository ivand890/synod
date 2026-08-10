import { ERROR_CODES, SynodError } from "../errors.js";
import { MANIFEST_SCHEMA_VERSION, validateManifest } from "../manifest.js";
import { migrateManifest1To2 } from "./1-to-2.js";
import { migrateManifest2To3 } from "./2-to-3.js";
import type { ManagedManifest, ManifestMigration, SynodManifest } from "../manifest.js";

export async function migrateManifest(
  targetDirectory: string,
  manifest: unknown
): Promise<{ manifest: ManagedManifest; applied: ManifestMigration[] }> {
  let current = validateManifest(manifest);
  const applied: ManifestMigration[] = [];
  while (current.schemaVersion < MANIFEST_SCHEMA_VERSION) {
    if (current.schemaVersion === 1) {
      current = await migrateManifest1To2(targetDirectory, current);
      applied.push({ from: 1, to: 2 });
      continue;
    }
    if (current.schemaVersion === 2) {
      current = migrateManifest2To3(current);
      applied.push({ from: 2, to: 3 });
      continue;
    }
    throw new SynodError(ERROR_CODES.MANIFEST_UNSUPPORTED, `No migration from schema ${current.schemaVersion}.`);
  }
  const validated: SynodManifest = validateManifest(current, { allowLegacy: false });
  if (validated.schemaVersion === 1) {
    throw new SynodError(ERROR_CODES.MANIFEST_UNSUPPORTED, "Legacy manifest remained after migration.");
  }
  return { manifest: validated, applied };
}
