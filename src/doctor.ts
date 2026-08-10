import process from "node:process";
import { CodexAppServerClient, codexSurfaceFrom } from "./app-server.js";
import type { AppServerDiagnostics } from "./app-server.js";
import { resolveCodexRuntime } from "./codex-runtime.js";
import { classifyCodexVersion, CODEX_COMPATIBILITY, compareVersions, parseVersion } from "./compatibility.js";
import { WARNING_CODES, warning } from "./contracts.js";
import { ERROR_CODES, asSynodError } from "./errors.js";
import { checkProject } from "./lifecycle.js";
import { listProfiles, evaluateProfile } from "./profiles.js";
import type { ModelCapability } from "./profiles.js";
import type { Warning } from "./contracts.js";
import { isRecord } from "./validation.js";

export interface DoctorClient {
  start(): Promise<void>;
  probeCapabilities?(): Promise<unknown>;
  listModels?(): Promise<ModelCapability[]>;
  close(): Promise<unknown>;
  getDiagnostics?(): AppServerDiagnostics | Record<string, unknown>;
  getWarnings?(): Warning[];
}

export interface DoctorRuntime {
  surface?: string;
  executable: string;
  executableSource?: string;
  resolved: boolean;
}

export interface DoctorDependencies {
  clientFactory?: (options: { codexBin: string }) => DoctorClient;
  runtimeResolver?: () => DoctorRuntime;
}

export async function doctorProject(
  { directory = ".", project = true }: { directory?: string; project?: boolean } = {},
  {
    clientFactory = options => new CodexAppServerClient(options),
    runtimeResolver = resolveCodexRuntime
  }: DoctorDependencies = {}
) {
  const runtime = runtimeResolver();
  const unresolvedDesktop = runtime.surface === "desktop" && !runtime.resolved;
  const client = unresolvedDesktop ? undefined : clientFactory({ codexBin: runtime.executable });
  const issues: Array<{ code: string; message: string; details?: unknown }> = [];
  const warnings: Warning[] = [];
  let diagnostics: AppServerDiagnostics | Record<string, unknown> | undefined;
  let models: ModelCapability[] = [];

  if (unresolvedDesktop) {
    issues.push({
      code: ERROR_CODES.CODEX_RUNTIME_AMBIGUOUS,
      message: "Synod is running from Codex Desktop but could not resolve the Desktop App Server executable.",
      details: runtime
    });
  }

  if (client) {
    try {
      await client.start();
      await client.probeCapabilities?.();
      models = await client.listModels?.() || [];
    } catch (error) {
      const value = asSynodError(error);
      issues.push({ code: value.code, message: value.message, details: value.details });
    } finally {
      await client.close().catch(error => {
        const value = asSynodError(error);
        issues.push({ code: value.code, message: value.message, details: value.details });
      });
      diagnostics = client.getDiagnostics?.() || {};
      warnings.push(...(client.getWarnings?.() || []));
    }
  }

  const diagnosticValue = isRecord(diagnostics) ? diagnostics : {};
  const codexVersion = typeof diagnosticValue.codexVersion === "string" ? diagnosticValue.codexVersion : undefined;
  const reportedSurface = typeof diagnosticValue.codexSurface === "string"
    ? diagnosticValue.codexSurface
    : codexSurfaceFrom(diagnosticValue.codexUserAgent);
  const codexSurface = ["desktop", "cli"].includes(reportedSurface) ? reportedSurface : runtime.surface;
  const codexRuntime = {
    surface: codexSurface,
    label: codexSurface === "desktop" ? "Codex Desktop" : codexSurface === "cli" ? "Codex CLI" : "Codex runtime",
    executable: typeof diagnosticValue.codexExecutable === "string"
      ? diagnosticValue.codexExecutable
      : (unresolvedDesktop ? null : runtime.executable) || null,
    executableSource: runtime.executableSource || null,
    home: typeof diagnosticValue.codexHome === "string" ? diagnosticValue.codexHome : null
  };
  const compatibility = codexVersion
    ? { ...codexRuntime, version: codexVersion, ...classifyCodexVersion(codexVersion), range: CODEX_COMPATIBILITY.supported, knownGood: [...CODEX_COMPATIBILITY.knownGood] }
    : { ...codexRuntime, version: null, status: "unsupported", reason: "version_unavailable", range: CODEX_COMPATIBILITY.supported, knownGood: [...CODEX_COMPATIBILITY.knownGood] };
  if (compatibility.status === "unsupported") {
    warnings.push(warning(
      WARNING_CODES.CODEX_VERSION_UNSUPPORTED,
      `Codex ${codexVersion || "unknown"} is outside Synod's tested support range ${CODEX_COMPATIBILITY.supported}.`,
      compatibility
    ));
  }

  const parsedCodexVersion = parseVersion(codexVersion);
  const releaseCodexVersion = parsedCodexVersion && (() => {
    const { prerelease: _prerelease, ...release } = parsedCodexVersion;
    return release;
  })();
  const profileCodexVersion = parsedCodexVersion?.prerelease === undefined
    ? parsedCodexVersion
    : releaseCodexVersion;
  const profileChecks = listProfiles().map(profile => {
    const capabilityCheck = evaluateProfile(profile, models);
    const versionEligible = compatibility.status !== "unsupported"
      && profileCodexVersion !== undefined
      && compareVersions(profileCodexVersion, profile.minimumCodexVersion) >= 0;
    return {
      ...capabilityCheck,
      modelCompatible: capabilityCheck.compatible,
      compatible: capabilityCheck.compatible && versionEligible,
      description: profile.description,
      minimumCodexVersion: profile.minimumCodexVersion,
      versionEligible
    };
  });
  const recommendedProfile = profileChecks.find(item => item.id === "synod-5.6" && item.compatible)?.id
    || profileChecks.find(item => item.compatible)?.id
    || null;

  let projectCheck;
  if (project) {
    try {
      projectCheck = await checkProject({ directory });
    } catch (error) {
      const value = asSynodError(error);
      if (value.code !== "SYNOD_NOT_INSTALLED") {
        issues.push({ code: value.code, message: value.message, details: value.details });
      }
    }
  }
  const selectedProfile = projectCheck?.profile;
  const selectedProfileCheck = profileChecks.find(item => item.id === selectedProfile);
  if (selectedProfileCheck && !selectedProfileCheck.modelCompatible) {
    warnings.push(warning(
      WARNING_CODES.PROFILE_INCOMPATIBLE,
      `Installed model profile ${selectedProfile} is not available in this Codex runtime.`,
      { profile: selectedProfile, missing: selectedProfileCheck.missing }
    ));
  }

  const nodeSupported = Number(process.versions.node.split(".")[0]) >= 20;
  const healthy = nodeSupported
    && issues.length === 0
    && compatibility.status !== "unsupported"
    && profileChecks.some(item => item.compatible)
    && (!projectCheck || projectCheck.healthy)
    && (!selectedProfileCheck || selectedProfileCheck.compatible);

  return {
    healthy,
    node: { version: process.versions.node, supported: nodeSupported, range: ">=20" },
    codex: compatibility,
    capabilities: {
      appServer: isRecord(diagnosticValue.appServer) && isRecord(diagnosticValue.appServer.capabilities)
        ? diagnosticValue.appServer.capabilities
        : {},
      models: models.map(model => ({
        id: model.id || model.model,
        reasoningEfforts: (model.supportedReasoningEfforts || []).map(item =>
          typeof item === "string" ? item : item.reasoningEffort
        )
      }))
    },
    profiles: profileChecks,
    recommendedProfile,
    project: projectCheck,
    issues,
    warnings,
    diagnostics: diagnostics || {}
  };
}
