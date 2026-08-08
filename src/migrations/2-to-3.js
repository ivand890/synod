import { validateManifest } from "../manifest.js";

export function migrateManifest2To3(manifest) {
  validateManifest(manifest);
  return {
    ...manifest,
    schemaVersion: 3,
    migrations: [
      ...(manifest.migrations || []),
      ...((manifest.migrations || []).some(item => item.from === 2 && item.to === 3)
        ? []
        : [{ from: 2, to: 3 }])
    ]
  };
}
