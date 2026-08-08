import { ERROR_CODES, SynodError } from "../errors.js";
import { MANIFEST_SCHEMA_VERSION, validateManifest } from "../manifest.js";
import { migrateManifest1To2 } from "./1-to-2.js";
import { migrateManifest2To3 } from "./2-to-3.js";

export async function migrateManifest(targetDirectory, manifest) {
  let current = validateManifest(manifest);
  const applied = [];
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
  return { manifest: validateManifest(current, { allowLegacy: false }), applied };
}
