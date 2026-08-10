import { validateManifest } from "../manifest.js";
import type { ManagedManifest } from "../manifest.js";

export function migrateManifest2To3(manifest: ManagedManifest): ManagedManifest {
  const validated = validateManifest(manifest);
  if (validated.schemaVersion === 1) throw new TypeError("Expected a managed manifest.");
  return {
    ...validated,
    schemaVersion: 3,
    migrations: [
      ...validated.migrations,
      ...(validated.migrations.some(item => item.from === 2 && item.to === 3)
        ? []
        : [{ from: 2, to: 3 }])
    ]
  };
}
