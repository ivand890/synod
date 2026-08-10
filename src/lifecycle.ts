import path from "node:path";
import { WARNING_CODES, warning } from "./contracts.js";
import type { Warning } from "./contracts.js";
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
import type { PathInspection, TransactionHooks, TransactionOperation } from "./filesystem.js";
import {
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  createManifest,
  manifestFileMap,
  readManifest,
  serializeManifest
} from "./manifest.js";
import type { ManagedManifest, ManifestEntry, ManifestOwnership } from "./manifest.js";
import { migrateManifest } from "./migrations/index.js";
import { packageName, packageVersion } from "./package.js";
import { inspectLocalRuntime, readLocalRuntimeDescriptor } from "./local-runtime.js";
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
import type { LocalRuntimePlan } from "./local-runtime.js";
import { errorCode, errorMessage } from "./validation.js";
import {
  ORCHESTRATION_EVENTS_PATH,
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_STATUS_PATH,
  createInitialOrchestrationFiles,
  orchestrationStatus,
  validateOrchestrationReadOnly
} from "./orchestration.js";
import { CHECKPOINT_SNAPSHOT_PATH } from "./checkpoint.js";

const ORCHESTRATION_RECORD_PATHS = [
  ORCHESTRATION_STATE_PATH,
  ORCHESTRATION_EVENTS_PATH,
  CHECKPOINT_SNAPSHOT_PATH,
  ORCHESTRATION_STATUS_PATH
];

const USER_GUIDANCE_PATHS = new Set([
  "docs/synod/DECISIONS.md",
  "docs/synod/PLAN.md",
  "docs/synod/STATE.md"
]);

const CURRENT_GUIDANCE_PATHS = [
  "AGENTS.md",
  ".agents/skills/synod-advisor/SKILL.md"
];

type ManagedInspection = PathInspection | { type: "unsafe"; unsafeAncestor: string };

interface LifecycleState {
  path: string;
  action?: "create" | "update" | "remove" | "preserve" | "unchanged";
  conflict?: true;
}

export interface LifecycleResult extends Record<string, unknown> {
  targetDirectory: string;
  dryRun: boolean;
  created: string[];
  updated: string[];
  removed: string[];
  preserved: string[];
  unchanged: string[];
  conflicts: string[];
  warnings: Warning[];
  operations: Array<{ action: "write" | "delete"; path: string }>;
}

export interface LifecycleDependencies extends TransactionHooks, Record<string, unknown> {
  localRuntimePlan?: LocalRuntimePlan;
  platform?: NodeJS.Platform;
  pruneEmptyDirectories?: (targetDirectory: string, relativePaths: string[]) => Promise<void>;
}

export interface ProjectCheck {
  path: string;
  ownership: string;
  status: string;
  severity: "info" | "warning" | "error";
  runtimeVersion?: string;
  packageManager?: string;
  expectedHash?: string | undefined;
  actualHash?: string | undefined;
  code?: string;
  message?: string;
}

function inspectionHash(inspected: ManagedInspection): string | undefined {
  return inspected.type === "file" ? inspected.hash : undefined;
}

function shellQuoteArgument(value: unknown, platform: NodeJS.Platform = process.platform): string {
  const stringValue = String(value);
  const safePattern = platform === "win32"
    ? /^[A-Za-z0-9_@+=:,./\\-]+$/
    : /^[A-Za-z0-9_@%+=:,./-]+$/;
  if (safePattern.test(stringValue)) return stringValue;
  if (platform === "win32") return `"${stringValue.replaceAll('"', '""')}"`;
  return `'${stringValue.replaceAll("'", `'"'"'`)}'`;
}

function renderUpgradeCommand({ directory, targetDirectory, requestedProfile, profileId, platform }: {
  directory: string;
  targetDirectory: string;
  requestedProfile?: string;
  profileId: string;
  platform: NodeJS.Platform;
}): string {
  const args = ["pnpm", "dlx", `${packageName}@${packageVersion}`, "upgrade"];
  if (directory !== ".") args.push(targetDirectory);
  if (requestedProfile) args.push("--profile", profileId);
  return args.map(argument => shellQuoteArgument(argument, platform)).join(" ");
}

function preservedGuidanceWarning(relativePath: string): Warning {
  return warning(
    WARNING_CODES.DURABLE_STATE_PRESERVED,
    `Preserved user-owned guidance in ${relativePath}. Review the current managed guidance and update this file manually if its Synod instructions are stale.`,
    {
      path: relativePath,
      action: "review-and-update-manually",
      currentGuidance: CURRENT_GUIDANCE_PATHS
    }
  );
}

async function validateTarget(directory: string): Promise<string> {
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

async function inspectManagedPath(targetDirectory: string, relativePath: string): Promise<ManagedInspection> {
  const targetPath = resolveProjectPath(targetDirectory, relativePath);
  const unsafe = await unsafeAncestor(targetDirectory, targetPath);
  if (unsafe) return { type: "unsafe", unsafeAncestor: unsafe };
  return inspectPath(targetPath);
}

function operationForWrite(relativePath: string, content: string, inspected: PathInspection): TransactionOperation {
  return {
    action: "write",
    path: relativePath,
    content,
    expected: { type: inspected.type, ...(inspected.type === "file" ? { hash: inspected.hash } : {}) }
  };
}

function operationForDelete(relativePath: string, inspected: PathInspection): TransactionOperation {
  return {
    action: "delete",
    path: relativePath,
    expected: { type: inspected.type, ...(inspected.type === "file" ? { hash: inspected.hash } : {}) }
  };
}

function resultFromPlan(
  targetDirectory: string,
  dryRun: boolean,
  operations: TransactionOperation[],
  states: LifecycleState[],
  warnings: Warning[],
  conflicts: string[],
  extra: Record<string, unknown> = {}
): LifecycleResult {
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

async function applyPlannedTransaction(
  targetDirectory: string,
  operations: TransactionOperation[],
  dependencies: LifecycleDependencies,
  result: LifecycleResult
): Promise<void> {
  const transaction = await applyTransaction(targetDirectory, operations, dependencies);
  for (const failure of transaction.cleanupFailures) {
    result.warnings.push(warning(
      WARNING_CODES.BACKUP_CLEANUP_FAILED,
      `Synod committed the transaction but could not remove a backup for ${failure.path}: ${failure.message}`,
      failure
    ));
  }
}

async function pruneCommittedDirectories(
  targetDirectory: string,
  states: LifecycleState[],
  dependencies: LifecycleDependencies,
  result: LifecycleResult
): Promise<void> {
  const prune = dependencies.pruneEmptyDirectories || pruneEmptyDirectories;
  try {
    await prune(targetDirectory, states.filter(item => item.action === "remove").map(item => item.path));
  } catch (error) {
    result.warnings.push(warning(
      WARNING_CODES.DIRECTORY_PRUNE_FAILED,
      `Synod committed the lifecycle changes but could not remove every empty directory: ${errorMessage(error)}`,
      { targetDirectory, message: errorMessage(error) }
    ));
  }
}

function addManifestEntry(
  entries: Map<string, ManifestEntry>,
  pathValue: string,
  ownership: ManifestOwnership,
  hash: string,
  provenance = "installed",
  extra: Pick<ManifestEntry, "separatorBefore" | "separatorAmbiguous"> = {}
): void {
  entries.set(pathValue, { path: pathValue, ownership, contentHash: hash, provenance, ...extra });
}

async function planAgentsInit(
  targetDirectory: string,
  block: string,
  force: boolean,
  previousEntry?: ManifestEntry
): Promise<{
  inspected: ManagedInspection;
  state: LifecycleState;
  content?: string;
  separatorBefore?: string | undefined;
  warning?: Warning | undefined;
}> {
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
  { directory = ".", dryRun = false, force = false, profile: requestedProfile }: {
    directory?: string;
    dryRun?: boolean;
    force?: boolean;
    profile?: string;
  } = {},
  dependencies: LifecycleDependencies = {}
): Promise<LifecycleResult> {
  const targetDirectory = await validateTarget(directory);
  const localRuntimeDescriptor = await readLocalRuntimeDescriptor(targetDirectory);
  const localRuntimePlan = dependencies.localRuntimePlan || (localRuntimeDescriptor ? {
    action: "unchanged",
    runtimeVersion: localRuntimeDescriptor.runtimeVersion,
    packageManager: localRuntimeDescriptor.packageManager
  } : undefined);
  const existingManifest = await readManifest(targetDirectory, { required: false });
  const existingProfile = existingManifest?.schemaVersion === 1 ? undefined : existingManifest?.profile;
  const profileId = requestedProfile || existingProfile || DEFAULT_PROFILE;
  if (existingManifest && (
    existingManifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    existingManifest.templateVersion !== packageVersion ||
    existingProfile !== profileId
  )) {
    const recommendedCommand = renderUpgradeCommand({
      directory,
      targetDirectory,
      ...(requestedProfile !== undefined ? { requestedProfile } : {}),
      profileId,
      platform: dependencies.platform || process.platform
    });
    throw new SynodError(ERROR_CODES.UPGRADE_REQUIRED, `This project is already managed by another Synod template or profile. Run \`${recommendedCommand}\`.`, {
      details: {
        installedTemplateVersion: existingManifest.templateVersion,
        installedProfile: existingProfile,
        targetTemplateVersion: packageVersion,
        targetProfile: profileId,
        recommendedCommand
      }
    });
  }

  const profile = getProfile(profileId);
  const templates = await loadTemplateSet(packageVersion, profile);
  const existingRecords = await Promise.all(
    ORCHESTRATION_RECORD_PATHS.map(async (relativePath): Promise<[string, ManagedInspection]> => [
      relativePath,
      await inspectManagedPath(targetDirectory, relativePath)
    ])
  );
  const adoptExistingRecords = !existingManifest
    && existingRecords.every(([, inspected]) => inspected.type === "file");
  if (adoptExistingRecords) {
    if (dryRun) await validateOrchestrationReadOnly({ directory: targetDirectory });
    else await orchestrationStatus({ directory: targetDirectory }, dependencies);
    for (const [relativePath, inspected] of existingRecords) {
      if (inspected.type === "file") templates.files.set(relativePath, inspected.content);
    }
  } else {
    const orchestrationDependencies = { ...dependencies, checkpointOverlay: templates.files };
    for (const [relativePath, content] of await createInitialOrchestrationFiles(targetDirectory, orchestrationDependencies)) {
      templates.files.set(relativePath, content);
    }
  }
  const managedExisting: ManagedManifest | undefined = existingManifest;
  const previous = managedExisting ? manifestFileMap(managedExisting) : new Map<string, ManifestEntry>();
  const entries = new Map<string, ManifestEntry>();
  const operations: TransactionOperation[] = [];
  const states: LifecycleState[] = [];
  const warnings: Warning[] = [];
  const conflicts: string[] = [];

  const agentsPlan = await planAgentsInit(targetDirectory, templates.agentsBlock, force, previous.get("AGENTS.md"));
  states.push(agentsPlan.state);
  if (agentsPlan.state.conflict) conflicts.push("AGENTS.md");
  else {
    if (
      agentsPlan.state.action
      && ["create", "update"].includes(agentsPlan.state.action)
      && agentsPlan.content !== undefined
      && agentsPlan.inspected.type !== "unsafe"
    ) {
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
    let state: LifecycleState;

    if (inspected.type === "unsafe" || (inspected.type !== "missing" && inspected.type !== "file")) {
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
      : ownership === "record" && inspectionHash(inspected)
        ? inspectionHash(inspected)
        : ownership === "user" && previousEntry
          ? previousEntry.contentHash
          : ownership === "user" && inspectionHash(inspected)
            ? inspectionHash(inspected)
            : contentHash(templateContent);
    if (!installedHash) throw new SynodError(ERROR_CODES.MANIFEST_INVALID, `Could not determine a manifest hash for ${relativePath}.`);
    addManifestEntry(entries, relativePath, ownership, installedHash, previousEntry?.provenance || "installed");
  }

  const manifest = createManifest({
    templateVersion: packageVersion,
    profile: profile.id,
    files: [...entries.values()],
    migrations: managedExisting?.migrations || []
  });
  const manifestContent = serializeManifest(manifest);
  const manifestInspected = await inspectManagedPath(targetDirectory, MANIFEST_PATH);
  if (manifestInspected.type !== "missing" && manifestInspected.type !== "file") conflicts.push(MANIFEST_PATH);
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
    runtimeVersion: localRuntimePlan?.runtimeVersion || null,
    runtimeAction: localRuntimePlan?.action || null,
    templateVersion: packageVersion,
    profile: profile.id
  });
  if (!dryRun && conflicts.length === 0) {
    await applyPlannedTransaction(targetDirectory, operations, dependencies, result);
  }
  return result;
}

export async function upgradeProject(
  { directory = ".", dryRun = false, force = false, profile: requestedProfile }: {
    directory?: string;
    dryRun?: boolean;
    force?: boolean;
    profile?: string;
  } = {},
  dependencies: LifecycleDependencies = {}
): Promise<LifecycleResult> {
  const targetDirectory = await validateTarget(directory);
  const localRuntimeDescriptor = await readLocalRuntimeDescriptor(targetDirectory);
  const localRuntimePlan = dependencies.localRuntimePlan || (localRuntimeDescriptor ? {
    action: "unchanged",
    runtimeVersion: localRuntimeDescriptor.runtimeVersion,
    packageManager: localRuntimeDescriptor.packageManager
  } : undefined);
  const rawManifest = await readManifest(targetDirectory);
  if (!rawManifest) throw new SynodError(ERROR_CODES.NOT_INSTALLED, `Synod is not installed in ${targetDirectory}.`);
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
  const nextEntries = new Map<string, ManifestEntry>();
  const operations: TransactionOperation[] = [];
  const states: LifecycleState[] = [];
  const warnings: Warning[] = [];
  const conflicts: string[] = [];

  const agentsPlan = await planAgentsInit(targetDirectory, templates.agentsBlock, force, previous.get("AGENTS.md"));
  states.push(agentsPlan.state);
  if (agentsPlan.state.conflict) conflicts.push("AGENTS.md");
  else {
    if (
      agentsPlan.state.action
      && ["create", "update"].includes(agentsPlan.state.action)
      && agentsPlan.content !== undefined
      && agentsPlan.inspected.type !== "unsafe"
    ) {
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
    let state: LifecycleState;

    if (inspected.type === "unsafe" || (inspected.type !== "missing" && inspected.type !== "file")) {
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
      } else if (
        USER_GUIDANCE_PATHS.has(relativePath)
        && normalizeText(inspected.content) !== normalizeText(templateContent)
      ) {
        warnings.push(preservedGuidanceWarning(relativePath));
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
      if (
        USER_GUIDANCE_PATHS.has(relativePath)
        && normalizeText(inspected.content) !== normalizeText(templateContent)
      ) {
        warnings.push(preservedGuidanceWarning(relativePath));
      }
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
      ? old?.contentHash || inspectionHash(inspected) || contentHash(templateContent)
      : ownership === "user"
        ? old?.contentHash || inspectionHash(inspected) || contentHash(templateContent)
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
    runtimeVersion: localRuntimePlan?.runtimeVersion || null,
    runtimeAction: localRuntimePlan?.action || null,
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

export async function checkProject({ directory = "." }: { directory?: string } = {}) {
  const targetDirectory = await validateTarget(directory);
  const localRuntimeDescriptor = await readLocalRuntimeDescriptor(targetDirectory);
  const rawManifest = await readManifest(targetDirectory);
  if (!rawManifest) throw new SynodError(ERROR_CODES.NOT_INSTALLED, `Synod is not installed in ${targetDirectory}.`);
  const { manifest, applied } = await migrateManifest(targetDirectory, rawManifest);
  const checks: ProjectCheck[] = [];
  const warnings: Warning[] = [];

  if (localRuntimeDescriptor) {
    const runtimeCheck: ProjectCheck = {
      path: ".synod/runtime",
      ownership: "runtime",
      runtimeVersion: localRuntimeDescriptor.runtimeVersion,
      packageManager: localRuntimeDescriptor.packageManager,
      status: "unknown",
      severity: "error"
    };
    try {
      const localRuntime = await inspectLocalRuntime(targetDirectory, localRuntimeDescriptor);
      runtimeCheck.status = localRuntime.ready ? "ready" : "missing";
      runtimeCheck.severity = localRuntime.ready ? "info" : "error";
    } catch (error) {
      if (!(error instanceof SynodError) || error.code !== ERROR_CODES.LOCAL_RUNTIME_INVALID) throw error;
      runtimeCheck.status = "invalid";
      runtimeCheck.severity = "error";
      runtimeCheck.code = error.code;
      runtimeCheck.message = error.message;
    }
    checks.push(runtimeCheck);
  }

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
      const actualHash = inspectionHash(inspected);
      checks.push({
        path: entry.path,
        ownership: entry.ownership,
        status: inspected.type === "file" ? "recorded" : "missing",
        severity: inspected.type === "file" ? "info" : "error",
        actualHash
      });
      continue;
    }
    if (entry.ownership === "user") {
      const actualHash = inspectionHash(inspected);
      checks.push({
        path: entry.path,
        ownership: entry.ownership,
        status: inspected.type === "file" ? (inspected.hash === entry.contentHash ? "ok" : "modified-user") : "missing-user",
        severity: inspected.type === "file" ? "info" : "warning",
        expectedHash: entry.contentHash,
        actualHash
      });
      continue;
    }
    const ok = inspected.type === "file" && inspected.hash === entry.contentHash;
    const actualHash = inspectionHash(inspected);
    checks.push({
      path: entry.path,
      ownership: entry.ownership,
      status: inspected.type === "missing" ? "missing" : ok ? "ok" : "modified",
      severity: ok ? "info" : "error",
      expectedHash: entry.contentHash,
      actualHash
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
        code: errorCode(error) || ERROR_CODES.ORCHESTRATION_STATE_INVALID,
        message: errorMessage(error)
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
    runtimeVersion: localRuntimeDescriptor?.runtimeVersion || null,
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
  { directory = ".", dryRun = false, force = false }: {
    directory?: string;
    dryRun?: boolean;
    force?: boolean;
  } = {},
  dependencies: LifecycleDependencies = {}
): Promise<LifecycleResult> {
  const targetDirectory = await validateTarget(directory);
  const localRuntimeDescriptor = await readLocalRuntimeDescriptor(targetDirectory);
  const localRuntimePlan = dependencies.localRuntimePlan || (localRuntimeDescriptor ? {
    action: "remove",
    runtimeVersion: localRuntimeDescriptor.runtimeVersion,
    packageManager: localRuntimeDescriptor.packageManager
  } : undefined);
  const rawManifest = await readManifest(targetDirectory);
  if (!rawManifest) throw new SynodError(ERROR_CODES.NOT_INSTALLED, `Synod is not installed in ${targetDirectory}.`);
  const { manifest } = await migrateManifest(targetDirectory, rawManifest);
  const operations: TransactionOperation[] = [];
  const states: LifecycleState[] = [];
  const conflicts: string[] = [];
  const warnings: Warning[] = [];

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
      const content = removeAgentsBlocks(inspected.content, {
        ...(entry.separatorBefore !== undefined ? { separatorBefore: entry.separatorBefore } : {})
      });
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
    runtimeVersion: localRuntimePlan?.runtimeVersion || null,
    runtimeAction: localRuntimePlan?.action || null,
    templateVersion: manifest.templateVersion,
    profile: manifest.profile
  });
  if (!dryRun && conflicts.length === 0) {
    await applyPlannedTransaction(targetDirectory, operations, dependencies, result);
    await pruneCommittedDirectories(targetDirectory, states, dependencies, result);
  }
  return result;
}
