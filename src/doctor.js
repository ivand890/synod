import process from "node:process";
import { CodexAppServerClient, codexSurfaceFrom } from "./app-server.js";
import { resolveCodexRuntime } from "./codex-runtime.js";
import { classifyCodexVersion, CODEX_COMPATIBILITY, compareVersions, parseVersion } from "./compatibility.js";
import { WARNING_CODES, warning } from "./contracts.js";
import { ERROR_CODES, asSynodError } from "./errors.js";
import { checkProject } from "./lifecycle.js";
import { listProfiles, evaluateProfile } from "./profiles.js";

export async function doctorProject(
  { directory = ".", project = true } = {},
  {
    clientFactory = options => new CodexAppServerClient(options),
    runtimeResolver = resolveCodexRuntime
  } = {}
) {
  const runtime = runtimeResolver();
  const unresolvedDesktop = runtime.surface === "desktop" && !runtime.resolved;
  const client = unresolvedDesktop ? undefined : clientFactory({ codexBin: runtime.executable });
  const issues = [];
  const warnings = [];
  let diagnostics = {};
  let models = [];

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
      await client.probeCapabilities();
      models = await client.listModels();
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

  const codexVersion = diagnostics.codexVersion;
  const reportedSurface = diagnostics.codexSurface || codexSurfaceFrom(diagnostics.codexUserAgent);
  const codexSurface = ["desktop", "cli"].includes(reportedSurface) ? reportedSurface : runtime.surface;
  const codexRuntime = {
    surface: codexSurface,
    label: codexSurface === "desktop" ? "Codex Desktop" : codexSurface === "cli" ? "Codex CLI" : "Codex runtime",
    executable: diagnostics.codexExecutable || (unresolvedDesktop ? null : runtime.executable) || null,
    executableSource: runtime.executableSource || null,
    home: diagnostics.codexHome || null
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

  const profileChecks = listProfiles().map(profile => ({
    ...evaluateProfile(profile, models),
    description: profile.description,
    minimumCodexVersion: profile.minimumCodexVersion,
    versionEligible: compatibility.status !== "unsupported"
      && Boolean(parseVersion(codexVersion))
      && compareVersions(codexVersion, profile.minimumCodexVersion) >= 0
  })).map(value => ({ ...value, compatible: value.compatible && value.versionEligible }));
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
  if (selectedProfileCheck && !selectedProfileCheck.compatible) {
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
      appServer: diagnostics.appServer?.capabilities || {},
      models: models.map(model => ({
        id: model.id || model.model,
        reasoningEfforts: (model.supportedReasoningEfforts || []).map(item => item.reasoningEffort || item)
      }))
    },
    profiles: profileChecks,
    recommendedProfile,
    project: projectCheck,
    issues,
    warnings,
    diagnostics
  };
}
