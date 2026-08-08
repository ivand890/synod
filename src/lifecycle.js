import path from "node:path";
import { WARNING_CODES, warning } from "./contracts.js";
import { ERROR_CODES, SynodError } from "./errors.js";
import {
  applyTransaction,
  contentHash,
  inspectPath,
  normalizeText,
  pathType,
  pruneEmptyDirectories,
  resolveProjectPath,
  unsafeAncestor
} from "./filesystem.js";
import {
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  createManifest,
  manifestFileMap,
  readManifest,
  serializeManifest
} from "./manifest.js";
import { migrateManifest } from "./migrations/index.js";
import { packageVersion } from "./package.js";
import { DEFAULT_PROFILE, getProfile } from "./profiles.js";
import {
  agentsBlockSeparator,
  appendAgentsBlock,
  extractManagedAgentsBlock,
  findManagedAgentsBlocks,
  generatedConfigMarker,
  loadTemplateSet,
  ownershipFor,
  removeAgentsBlocks,
  replaceAgentsBlocks
} from "./templates.js";
import { compareVersions } from "./compatibility.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  createInitialOrchestrationFiles,
  orchestrationStatus
} from "./orchestration.js";

const ORCHESTRATION_RECORD_PATHS = [
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATUS_PATH
];

async function validateTarget(directory) {
  const targetDirectory = path.resolve(directory || ".");
  const type = await pathType(targetDirectory);
  if (type === "missing") {
    throw new SynodError(ERROR_CODES.TARGET_NOT_FOUND, `Target directory does not exist: ${targetDirectory}`, {
      details: { targetDirectory }
    });
  }
  if (type !== "directory") {
    throw new SynodError(ERROR_CODES.TARGET_NOT_DIRECTORY, `Target is not a real directory: ${targetDirectory}`, {
      details: { targetDirectory, actualType: type }
    });
  }
  return targetDirectory;
}

async function inspectManagedPath(targetDirectory, relativePath) {
  const targetPath = resolveProjectPath(targetDirectory, relativePath);
  const unsafe = await unsafeAncestor(targetDirectory, targetPath);
  if (unsafe) return { type: "unsafe", unsafeAncestor: unsafe };
  return inspectPath(targetPath);
}

function operationForWrite(relativePath, content, inspected) {
  return {
    action: "write",
    path: relativePath,
    content,
    expected: { type: inspected.type, ...(inspected.hash ? { hash: inspected.hash } : {}) }
  };
}

function operationForDelete(relativePath, inspected) {
  return {
    action: "delete",
    path: relativePath,
    expected: { type: inspected.type, ...(inspected.hash ? { hash: inspected.hash } : {}) }
  };
}

function resultFromPlan(targetDirectory, dryRun, operations, states, warnings, conflicts, extra = {}) {
  return {
    targetDirectory,
    dryRun,
    created: states.filter(item => item.action === "create").map(item => item.path),
    updated: states.filter(item => item.action === "update").map(item => item.path),
    removed: states.filter(item => item.action === "remove").map(item => item.path),
    preserved: states.filter(item => item.action === "preserve").map(item => item.path),
    unchanged: states.filter(item => item.action === "unchanged").map(item => item.path),
    conflicts,
    warnings,
    operations: operations.map(item => ({ action: item.action, path: item.path })),
    ...extra
  };
}

async function applyPlannedTransaction(targetDirectory, operations, dependencies, result) {
  const transaction = await applyTransaction(targetDirectory, operations, dependencies);
  for (const failure of transaction.cleanupFailures) {
    result.warnings.push(warning(
      WARNING_CODES.BACKUP_CLEANUP_FAILED,
      `Synod committed the transaction but could not remove a backup for ${failure.path}: ${failure.message}`,
      failure
    ));
  }
}

async function pruneCommittedDirectories(targetDirectory, states, dependencies, result) {
  const prune = dependencies.pruneEmptyDirectories || pruneEmptyDirectories;
  try {
    await prune(targetDirectory, states.filter(item => item.action === "remove").map(item => item.path));
  } catch (error) {
    result.warnings.push(warning(
      WARNING_CODES.DIRECTORY_PRUNE_FAILED,
      `Synod committed the lifecycle changes but could not remove every empty directory: ${error.message}`,
      { targetDirectory, message: error.message }
    ));
  }
}

function addManifestEntry(entries, pathValue, ownership, hash, provenance = "installed", extra = {}) {
  entries.set(pathValue, { path: pathValue, ownership, contentHash: hash, provenance, ...extra });
}

async function planAgentsInit(targetDirectory, block, force, previousEntry) {
  const inspected = await inspectManagedPath(targetDirectory, "AGENTS.md");
  if (inspected.type === "unsafe" || !["missing", "file"].includes(inspected.type)) {
    return { inspected, state: { path: "AGENTS.md", conflict: true } };
  }
  const existing = inspected.type === "file" ? inspected.content : "";
  const blocks = findManagedAgentsBlocks(existing);
  if (blocks.length === 0) {
    if (previousEntry && !force) return { inspected, state: { path: "AGENTS.md", conflict: true } };
    const content = appendAgentsBlock(existing, block);
    return {
      inspected,
      content,
      separatorBefore: agentsBlockSeparator(existing),
      state: { path: "AGENTS.md", action: inspected.type === "missing" ? "create" : "update" }
    };
  }
  if (blocks.length > 1 && !force) return { inspected, state: { path: "AGENTS.md", conflict: true } };
  const managed = extractManagedAgentsBlock(existing);
  if (blocks.length === 1 && normalizeText(managed.content) === normalizeText(block)) {
    return {
      inspected,
      content: existing,
      separatorBefore: previousEntry?.separatorBefore,
      state: { path: "AGENTS.md", action: "unchanged" }
    };
  }
  if (previousEntry && blocks.length === 1 && contentHash(managed.content) !== previousEntry.contentHash && !force) {
    return { inspected, state: { path: "AGENTS.md", conflict: true } };
  }
  if (!previousEntry && !force) return { inspected, state: { path: "AGENTS.md", conflict: true } };
  return {
    inspected,
    content: replaceAgentsBlocks(existing, block),
    separatorBefore: previousEntry?.separatorBefore,
    state: { path: "AGENTS.md", action: "update" },
    warning: blocks.length > 1
      ? warning(
          WARNING_CODES.AGENTS_BLOCK_DUPLICATES_REPAIRED,
          `Repaired ${blocks.length} complete Synod managed blocks in AGENTS.md.`,
          { path: "AGENTS.md", blocksFound: blocks.length }
        )
      : undefined
  };
}

export async function initProject(
  { directory = ".", dryRun = false, force = false, profile: requestedProfile } = {},
  dependencies = {}
) {
  const targetDirectory = await validateTarget(directory);
  const existingManifest = await readManifest(targetDirectory, { required: false });
  const profileId = requestedProfile || existingManifest?.profile || DEFAULT_PROFILE;
  if (existingManifest && (
    existingManifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    existingManifest.templateVersion !== packageVersion ||
    existingManifest.profile !== profileId
  )) {
    throw new SynodError(ERROR_CODES.UPGRADE_REQUIRED, "This project is already managed by another Synod template or profile. Run `synod upgrade`.", {
      details: {
        installedTemplateVersion: existingManifest.templateVersion,
        installedProfile: existingManifest.profile,
        targetTemplateVersion: packageVersion,
        targetProfile: profileId
      }
    });
  }

  const profile = getProfile(profileId);
  const templates = await loadTemplateSet(packageVersion, profile);
  const existingRecords = await Promise.all(
    ORCHESTRATION_RECORD_PATHS.map(async relativePath => [
      relativePath,
      await inspectManagedPath(targetDirectory, relativePath)
    ])
  );
  const adoptExistingRecords = !existingManifest
    && existingRecords.every(([, inspected]) => inspected.type === "file");
  if (adoptExistingRecords) {
    await orchestrationStatus({ directory: targetDirectory }, dependencies);
    for (const [relativePath, inspected] of existingRecords) {
      templates.files.set(relativePath, inspected.content);
    }
  } else {
    const orchestrationDependencies = { ...dependencies, checkpointOverlay: templates.files };
    for (const [relativePath, content] of await createInitialOrchestrationFiles(targetDirectory, orchestrationDependencies)) {
      templates.files.set(relativePath, content);
    }
  }
  const previous = existingManifest ? manifestFileMap(existingManifest) : new Map();
  const entries = new Map();
  const operations = [];
  const states = [];
  const warnings = [];
  const conflicts = [];

  const agentsPlan = await planAgentsInit(targetDirectory, templates.agentsBlock, force, previous.get("AGENTS.md"));
  states.push(agentsPlan.state);
  if (agentsPlan.state.conflict) conflicts.push("AGENTS.md");
  else {
    if (["create", "update"].includes(agentsPlan.state.action)) {
      operations.push(operationForWrite("AGENTS.md", agentsPlan.content, agentsPlan.inspected));
    }
    addManifestEntry(
      entries,
      "AGENTS.md",
      "shared",
      contentHash(templates.agentsBlock),
      previous.get("AGENTS.md")?.provenance || "installed",
      {
        ...(agentsPlan.separatorBefore === undefined ? {} : { separatorBefore: agentsPlan.separatorBefore }),
        ...(previous.get("AGENTS.md")?.separatorAmbiguous ? { separatorAmbiguous: true } : {})
      }
    );
  }
  if (agentsPlan.warning) warnings.push(agentsPlan.warning);

  for (const [relativePath, templateContent] of templates.files) {
    const inspected = await inspectManagedPath(targetDirectory, relativePath);
    const previousEntry = previous.get(relativePath);
    let ownership = previousEntry?.ownership || ownershipFor(relativePath);
    let state;

    if (inspected.type === "unsafe" || !["missing", "file"].includes(inspected.type)) {
      state = { path: relativePath, conflict: true };
    } else if (previousEntry?.ownership === "user" || previousEntry?.ownership === "record") {
      ownership = previousEntry.ownership;
      if (ownership === "record" && inspected.type === "missing") {
        state = { path: relativePath, conflict: true };
      } else {
        state = { path: relativePath, action: "preserve" };
        if (inspected.type === "missing") {
          warnings.push(warning(
            WARNING_CODES.USER_OWNED_FILE_MISSING,
            `User-owned file is missing: ${relativePath}`,
            { path: relativePath }
          ));
        } else if (ownership === "user" && normalizeText(inspected.content) !== normalizeText(templateContent)) {
          warnings.push(warning(
            WARNING_CODES.DURABLE_STATE_PRESERVED,
            `Preserved user-owned project state in ${relativePath}.`,
            { path: relativePath }
          ));
        }
      }
    } else if (inspected.type === "missing") {
      state = { path: relativePath, action: "create" };
      operations.push(operationForWrite(relativePath, templateContent, inspected));
    } else if (ownership === "record") {
      state = adoptExistingRecords
        ? { path: relativePath, action: "preserve" }
        : { path: relativePath, conflict: true };
    } else if (relativePath.startsWith("docs/synod/")) {
      ownership = "user";
      state = { path: relativePath, action: "preserve" };
      if (normalizeText(inspected.content) !== normalizeText(templateContent)) {
        warnings.push(warning(
          WARNING_CODES.DURABLE_STATE_PRESERVED,
          `Preserved user-owned project state in ${relativePath}.`,
          { path: relativePath }
        ));
      }
    } else if (
      !previousEntry
      && relativePath === ".codex/config.toml"
      && !inspected.content.startsWith(generatedConfigMarker)
    ) {
      ownership = "user";
      state = { path: relativePath, action: "preserve" };
      warnings.push(warning(
        WARNING_CODES.USER_CONFIG_PRESERVED,
        "Preserved the existing user-owned .codex/config.toml.",
        { path: relativePath }
      ));
    } else if (normalizeText(inspected.content) === normalizeText(templateContent)) {
      state = { path: relativePath, action: "unchanged" };
    } else if (previousEntry && inspected.hash !== previousEntry.contentHash && !force) {
      state = { path: relativePath, conflict: true };
    } else if (!previousEntry && !force) {
      state = { path: relativePath, conflict: true };
    } else {
      state = { path: relativePath, action: "update" };
      operations.push(operationForWrite(relativePath, templateContent, inspected));
    }

    states.push(state);
    if (state.conflict) {
      conflicts.push(relativePath);
      continue;
    }
    const installedHash = ownership === "record" && previousEntry
      ? previousEntry.contentHash
      : ownership === "record" && inspected.hash
        ? inspected.hash
        : ownership === "user" && previousEntry
          ? previousEntry.contentHash
          : ownership === "user" && inspected.hash
            ? inspected.hash
            : contentHash(templateContent);
    addManifestEntry(entries, relativePath, ownership, installedHash, previousEntry?.provenance || "installed");
  }

  const manifest = createManifest({
    templateVersion: packageVersion,
    profile: profile.id,
    files: [...entries.values()],
    migrations: existingManifest?.migrations || []
  });
  const manifestContent = serializeManifest(manifest);
  const manifestInspected = await inspectManagedPath(targetDirectory, MANIFEST_PATH);
  if (!["missing", "file"].includes(manifestInspected.type)) conflicts.push(MANIFEST_PATH);
  else if (manifestInspected.type === "missing") {
    states.push({ path: MANIFEST_PATH, action: "create" });
    operations.push(operationForWrite(MANIFEST_PATH, manifestContent, manifestInspected));
  } else if (normalizeText(manifestInspected.content) === normalizeText(manifestContent)) {
    states.push({ path: MANIFEST_PATH, action: "unchanged" });
  } else {
    states.push({ path: MANIFEST_PATH, action: "update" });
    operations.push(operationForWrite(MANIFEST_PATH, manifestContent, manifestInspected));
  }

  const result = resultFromPlan(targetDirectory, dryRun, operations, states, warnings, conflicts, {
    templateVersion: packageVersion,
    profile: profile.id
  });
  if (!dryRun && conflicts.length === 0) {
    await applyPlannedTransaction(targetDirectory, operations, dependencies, result);
  }
  return result;
}

export async function upgradeProject(
  { directory = ".", dryRun = false, force = false, profile: requestedProfile } = {},
  dependencies = {}
) {
  const targetDirectory = await validateTarget(directory);
  const rawManifest = await readManifest(targetDirectory);
  const { manifest: installed, applied } = await migrateManifest(targetDirectory, rawManifest);
  if (compareVersions(installed.templateVersion, packageVersion) > 0) {
    throw new SynodError(ERROR_CODES.DOWNGRADE_UNSUPPORTED, "Installed template is newer than this Synod CLI.", {
      details: { installed: installed.templateVersion, cli: packageVersion }
    });
  }
  const profile = getProfile(requestedProfile || installed.profile || DEFAULT_PROFILE);
  const templates = await loadTemplateSet(packageVersion, profile);
  const orchestrationDependencies = { ...dependencies, checkpointOverlay: templates.files };
  for (const [relativePath, content] of await createInitialOrchestrationFiles(targetDirectory, orchestrationDependencies)) {
    templates.files.set(relativePath, content);
  }
  const previous = manifestFileMap(installed);
  const nextEntries = new Map();
  const operations = [];
  const states = [];
  const warnings = [];
  const conflicts = [];

  const agentsPlan = await planAgentsInit(targetDirectory, templates.agentsBlock, force, previous.get("AGENTS.md"));
  states.push(agentsPlan.state);
  if (agentsPlan.state.conflict) conflicts.push("AGENTS.md");
  else {
    if (["create", "update"].includes(agentsPlan.state.action)) {
      operations.push(operationForWrite("AGENTS.md", agentsPlan.content, agentsPlan.inspected));
    }
    addManifestEntry(
      nextEntries,
      "AGENTS.md",
      "shared",
      contentHash(templates.agentsBlock),
      previous.get("AGENTS.md")?.provenance || "installed",
      {
        ...(agentsPlan.separatorBefore === undefined ? {} : { separatorBefore: agentsPlan.separatorBefore }),
        ...(previous.get("AGENTS.md")?.separatorAmbiguous ? { separatorAmbiguous: true } : {})
      }
    );
  }
  if (agentsPlan.warning) warnings.push(agentsPlan.warning);

  for (const [relativePath, templateContent] of templates.files) {
    const inspected = await inspectManagedPath(targetDirectory, relativePath);
    const old = previous.get(relativePath);
    let ownership = old?.ownership || ownershipFor(relativePath);
    let state;

    if (inspected.type === "unsafe" || !["missing", "file"].includes(inspected.type)) {
      state = { path: relativePath, conflict: true };
    } else if (old?.ownership === "record") {
      if (inspected.type === "missing") {
        state = { path: relativePath, conflict: true };
      } else {
        ownership = "record";
        state = { path: relativePath, action: "preserve" };
      }
    } else if (old?.ownership === "user") {
      state = { path: relativePath, action: inspected.type === "missing" ? "preserve" : "preserve" };
      if (inspected.type === "missing") {
        warnings.push(warning(WARNING_CODES.USER_OWNED_FILE_MISSING, `User-owned file is missing: ${relativePath}`, { path: relativePath }));
      }
    } else if (inspected.type === "missing") {
      if (old && !force) state = { path: relativePath, conflict: true };
      else {
        state = { path: relativePath, action: "create" };
        operations.push(operationForWrite(relativePath, templateContent, inspected));
      }
    } else if (!old && ownership !== "record" && (relativePath.startsWith("docs/synod/") || (
      relativePath === ".codex/config.toml" && !inspected.content.startsWith(generatedConfigMarker)
    ))) {
      ownership = "user";
      state = { path: relativePath, action: "preserve" };
    } else if (!old && !force) {
      state = { path: relativePath, conflict: true };
    } else if (old && (old.provenance === "legacy-adopted" || inspected.hash !== old.contentHash) && !force) {
      state = { path: relativePath, conflict: true };
    } else if (normalizeText(inspected.content) === normalizeText(templateContent)) {
      state = { path: relativePath, action: "unchanged" };
    } else {
      state = { path: relativePath, action: "update" };
      operations.push(operationForWrite(relativePath, templateContent, inspected));
    }

    states.push(state);
    if (state.conflict) {
      conflicts.push(relativePath);
      continue;
    }
    const installedHash = ownership === "record"
      ? old?.contentHash || inspected.hash || contentHash(templateContent)
      : ownership === "user"
        ? old?.contentHash || inspected.hash || contentHash(templateContent)
        : contentHash(templateContent);
    addManifestEntry(nextEntries, relativePath, ownership, installedHash, ownership === "user" ? old?.provenance || "adopted-user" : "installed");
  }

  for (const old of installed.files) {
    if (old.path === "AGENTS.md" || templates.files.has(old.path) || nextEntries.has(old.path)) continue;
    const inspected = await inspectManagedPath(targetDirectory, old.path);
    if (old.ownership === "user") {
      states.push({ path: old.path, action: "preserve" });
      nextEntries.set(old.path, old);
    } else if (inspected.type === "missing") {
      states.push({ path: old.path, action: "unchanged" });
    } else if (inspected.type !== "file" || (inspected.hash !== old.contentHash && !force)) {
      states.push({ path: old.path, conflict: true });
      conflicts.push(old.path);
    } else {
      states.push({ path: old.path, action: "remove" });
      operations.push(operationForDelete(old.path, inspected));
    }
  }

  const migrationHistory = [...(installed.migrations || [])];
  for (const migration of applied) {
    if (!migrationHistory.some(item => item.from === migration.from && item.to === migration.to)) {
      migrationHistory.push(migration);
    }
  }
  const nextManifest = createManifest({
    templateVersion: packageVersion,
    profile: profile.id,
    files: [...nextEntries.values()],
    migrations: migrationHistory
  });
  const manifestContent = serializeManifest(nextManifest);
  const manifestInspected = await inspectManagedPath(targetDirectory, MANIFEST_PATH);
  if (manifestInspected.type !== "file") conflicts.push(MANIFEST_PATH);
  else if (normalizeText(manifestInspected.content) === normalizeText(manifestContent)) {
    states.push({ path: MANIFEST_PATH, action: "unchanged" });
  } else {
    states.push({ path: MANIFEST_PATH, action: "update" });
    operations.push(operationForWrite(MANIFEST_PATH, manifestContent, manifestInspected));
  }

  const result = resultFromPlan(targetDirectory, dryRun, operations, states, warnings, conflicts, {
    fromTemplateVersion: installed.templateVersion,
    templateVersion: packageVersion,
    profile: profile.id,
    migrations: applied
  });
  if (!dryRun && conflicts.length === 0) {
    await applyPlannedTransaction(targetDirectory, operations, dependencies, result);
    await pruneCommittedDirectories(targetDirectory, states, dependencies, result);
  }
  return result;
}

export async function checkProject({ directory = "." } = {}) {
  const targetDirectory = await validateTarget(directory);
  const rawManifest = await readManifest(targetDirectory);
  const { manifest, applied } = await migrateManifest(targetDirectory, rawManifest);
  const checks = [];
  const warnings = [];

  for (const entry of manifest.files) {
    const inspected = await inspectManagedPath(targetDirectory, entry.path);
    if (entry.ownership === "shared") {
      if (inspected.type !== "file") {
        checks.push({ path: entry.path, ownership: entry.ownership, status: "missing", severity: "error" });
        continue;
      }
      const managed = extractManagedAgentsBlock(inspected.content);
      const actualHash = managed.content ? contentHash(managed.content) : undefined;
      checks.push({
        path: entry.path,
        ownership: entry.ownership,
        status: actualHash === entry.contentHash ? "ok" : "modified",
        severity: actualHash === entry.contentHash ? "info" : "error",
        expectedHash: entry.contentHash,
        actualHash
      });
      continue;
    }
    if (entry.ownership === "record") {
      checks.push({
        path: entry.path,
        ownership: entry.ownership,
        status: inspected.type === "file" ? "recorded" : "missing",
        severity: inspected.type === "file" ? "info" : "error",
        actualHash: inspected.hash
      });
      continue;
    }
    if (entry.ownership === "user") {
      checks.push({
        path: entry.path,
        ownership: entry.ownership,
        status: inspected.type === "file" ? (inspected.hash === entry.contentHash ? "ok" : "modified-user") : "missing-user",
        severity: inspected.type === "file" ? "info" : "warning",
        expectedHash: entry.contentHash,
        actualHash: inspected.hash
      });
      continue;
    }
    const ok = inspected.type === "file" && inspected.hash === entry.contentHash;
    checks.push({
      path: entry.path,
      ownership: entry.ownership,
      status: inspected.type === "missing" ? "missing" : ok ? "ok" : "modified",
      severity: ok ? "info" : "error",
      expectedHash: entry.contentHash,
      actualHash: inspected.hash
    });
  }

  const orchestrationRecordsPresent = ORCHESTRATION_RECORD_PATHS.every(relativePath =>
    checks.some(check => check.path === relativePath && check.status === "recorded")
  );
  if (orchestrationRecordsPresent) {
    try {
      await orchestrationStatus({ directory: targetDirectory });
      checks.push({
        path: ".synod/orchestration",
        ownership: "record",
        status: "valid",
        severity: "info"
      });
    } catch (error) {
      checks.push({
        path: ".synod/orchestration",
        ownership: "record",
        status: "invalid",
        severity: "error",
        code: error.code || ERROR_CODES.ORCHESTRATION_STATE_INVALID,
        message: error.message
      });
    }
  }

  const upgradeAvailable = manifest.templateVersion !== packageVersion || rawManifest.schemaVersion !== MANIFEST_SCHEMA_VERSION;
  if (upgradeAvailable) {
    warnings.push(warning(
      WARNING_CODES.PROJECT_UPGRADE_AVAILABLE,
      `Project template ${manifest.templateVersion} can be upgraded to ${packageVersion}.`,
      { installed: manifest.templateVersion, available: packageVersion }
    ));
  }
  const healthy = !checks.some(item => item.severity === "error");
  return {
    targetDirectory,
    healthy,
    templateVersion: manifest.templateVersion,
    profile: manifest.profile,
    manifestSchemaVersion: rawManifest.schemaVersion,
    upgradeAvailable,
    pendingMigrations: applied,
    checks,
    warnings
  };
}

export async function uninstallProject(
  { directory = ".", dryRun = false, force = false } = {},
  dependencies = {}
) {
  const targetDirectory = await validateTarget(directory);
  const rawManifest = await readManifest(targetDirectory);
  const { manifest } = await migrateManifest(targetDirectory, rawManifest);
  const operations = [];
  const states = [];
  const conflicts = [];
  const warnings = [];

  for (const entry of manifest.files) {
    const inspected = await inspectManagedPath(targetDirectory, entry.path);
    if (entry.ownership === "user" || entry.ownership === "record") {
      states.push({ path: entry.path, action: "preserve" });
      continue;
    }
    if (entry.ownership === "shared") {
      if (inspected.type === "missing") {
        states.push({ path: entry.path, action: "unchanged" });
        continue;
      }
      if (inspected.type !== "file") {
        states.push({ path: entry.path, conflict: true });
        conflicts.push(entry.path);
        continue;
      }
      if (entry.separatorAmbiguous && !force) {
        states.push({ path: entry.path, conflict: true });
        conflicts.push(entry.path);
        continue;
      }
      const managed = extractManagedAgentsBlock(inspected.content);
      const matches = managed.content && contentHash(managed.content) === entry.contentHash;
      if (!matches && !force) {
        states.push({ path: entry.path, conflict: true });
        conflicts.push(entry.path);
        continue;
      }
      const content = removeAgentsBlocks(inspected.content, { separatorBefore: entry.separatorBefore });
      if (content.length === 0) {
        states.push({ path: entry.path, action: "remove" });
        operations.push(operationForDelete(entry.path, inspected));
      } else {
        states.push({ path: entry.path, action: "update" });
        operations.push(operationForWrite(entry.path, content, inspected));
      }
      continue;
    }

    if (inspected.type === "missing") {
      states.push({ path: entry.path, action: "unchanged" });
    } else if (inspected.type !== "file" || ((entry.provenance === "legacy-adopted" || inspected.hash !== entry.contentHash) && !force)) {
      states.push({ path: entry.path, conflict: true });
      conflicts.push(entry.path);
    } else {
      states.push({ path: entry.path, action: "remove" });
      operations.push(operationForDelete(entry.path, inspected));
    }
  }

  const manifestInspected = await inspectManagedPath(targetDirectory, MANIFEST_PATH);
  if (manifestInspected.type !== "file") conflicts.push(MANIFEST_PATH);
  else {
    states.push({ path: MANIFEST_PATH, action: "remove" });
    operations.push(operationForDelete(MANIFEST_PATH, manifestInspected));
  }

  const result = resultFromPlan(targetDirectory, dryRun, operations, states, warnings, conflicts, {
    templateVersion: manifest.templateVersion,
    profile: manifest.profile
  });
  if (!dryRun && conflicts.length === 0) {
    await applyPlannedTransaction(targetDirectory, operations, dependencies, result);
    await pruneCommittedDirectories(targetDirectory, states, dependencies, result);
  }
  return result;
}
