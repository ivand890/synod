import { ERROR_CODES, SynodError } from "./errors.js";
import type { Warning } from "./contracts.js";

export interface ModelRequirement {
  model: string;
  effort: string;
  planEffort?: string;
}

export interface ImplementerProfile {
  profile: string;
  model: string;
  effort: string;
}

export type ProfileRole = "supervisor" | "implementer" | "explorer" | "reviewer" | "verifier" | "mechanical";
export type DelegationRole = "implementer" | "reviewer" | "verifier";

export interface DelegationProfile extends ImplementerProfile {
  role: DelegationRole;
}

export interface ModelProfile {
  id: string;
  description: string;
  minimumCodexVersion: string;
  defaultSubagent: ModelRequirement;
  roles: Record<ProfileRole, ModelRequirement> & {
    supervisor: ModelRequirement & { planEffort: string };
  };
}

export type ModelCapability = (
  | { id: string; model?: string | undefined }
  | { id?: string | undefined; model: string }
) & {
  supportedReasoningEfforts?: Array<string | { reasoningEffort: string }> | undefined;
};

export interface MissingCapability {
  role: string;
  model: string;
  capability: "model" | "reasoning_effort" | "plan_reasoning_effort";
  effort?: string;
}

export interface ProfileRequirements {
  id: string;
  defaultSubagent: ModelRequirement;
  roles: Record<string, ModelRequirement>;
}

export type ProfileSelectionSource = "explicit" | "existing" | "capability" | "fallback";

export interface ProfileSelection {
  profile: string;
  source: ProfileSelectionSource;
  reason?: string;
  details?: Record<string, unknown>;
  warning?: Warning;
}

export const PREFERRED_PROFILE = "synod-5.6";
export const PORTABLE_PROFILE = "portable";
export const FALLBACK_PROFILE = PORTABLE_PROFILE;

const profiles: Record<string, ModelProfile> = {
  [PREFERRED_PROFILE]: {
    id: PREFERRED_PROFILE,
    description: "Role-specialized GPT-5.6 profile for current Codex releases.",
    minimumCodexVersion: "0.148.0",
    defaultSubagent: { model: "gpt-5.6-terra", effort: "max" },
    roles: {
      supervisor: { model: "gpt-5.6-sol", effort: "high", planEffort: "xhigh" },
      implementer: { model: "gpt-5.6-luna", effort: "max" },
      explorer: { model: "gpt-5.6-terra", effort: "medium" },
      reviewer: { model: "gpt-5.6-terra", effort: "high" },
      verifier: { model: "gpt-5.6-terra", effort: "high" },
      mechanical: { model: "gpt-5.6-luna", effort: "medium" }
    }
  },
  [PORTABLE_PROFILE]: {
    id: PORTABLE_PROFILE,
    description: "Portable profile for the current supported Codex range.",
    minimumCodexVersion: "0.148.0",
    defaultSubagent: { model: "gpt-5.5", effort: "high" },
    roles: {
      supervisor: { model: "gpt-5.5", effort: "xhigh", planEffort: "xhigh" },
      implementer: { model: "gpt-5.5", effort: "high" },
      explorer: { model: "gpt-5.5", effort: "medium" },
      reviewer: { model: "gpt-5.5", effort: "high" },
      verifier: { model: "gpt-5.5", effort: "high" },
      mechanical: { model: "gpt-5.5", effort: "low" }
    }
  }
};

export function listProfiles(): ModelProfile[] {
  return Object.values(profiles).map(profile => structuredClone(profile));
}

export function getProfile(id: string): ModelProfile {
  const profile = profiles[id];
  if (!profile) {
    throw new SynodError(ERROR_CODES.PROFILE_NOT_FOUND, `Unknown model profile: ${id}`, {
      details: { profile: id, available: Object.keys(profiles) }
    });
  }
  return structuredClone(profile);
}

/**
 * Resolve the worker configuration from the installed profile.  Callers that
 * launch a worker must provide the profile explicitly; silently falling back
 * to a built-in profile would let an installed profile select the wrong model.
 */
export function resolveImplementerProfile(profileId: unknown): ImplementerProfile {
  const resolved = resolveDelegationProfile(profileId, "implementer");
  const { role: _role, ...implementer } = resolved;
  return implementer;
}

export function isDelegationRole(value: unknown): value is DelegationRole {
  return value === "implementer" || value === "reviewer" || value === "verifier";
}

/** Resolve the exact model and effort for one supported delegation lane. */
export function resolveDelegationProfile(
  profileId: unknown,
  role: DelegationRole = "implementer"
): DelegationProfile {
  if (!isDelegationRole(role)) {
    throw new SynodError(ERROR_CODES.DELEGATION_ROLE_INVALID, `Unsupported delegation role: ${String(role)}.`, {
      details: { role, allowed: ["implementer", "reviewer", "verifier"] }
    });
  }
  if (typeof profileId !== "string" || profileId.length === 0 || profileId.trim() !== profileId) {
    throw new SynodError(
      ERROR_CODES.PROFILE_NOT_FOUND,
      `An installed Synod profile is required to resolve the ${role}.`,
      { details: { profile: profileId ?? null, role, reason: "missing-or-invalid" } }
    );
  }
  const profile = getProfile(profileId);
  const selected = profile.roles[role];
  if (typeof selected.model !== "string" || selected.model.length === 0
    || typeof selected.effort !== "string" || selected.effort.length === 0) {
    throw new SynodError(
      ERROR_CODES.PROFILE_NOT_FOUND,
      `Synod profile ${profileId} does not provide a supported ${role} configuration.`,
      { details: { profile: profileId, role, reason: "unsupported" } }
    );
  }
  return {
    profile: profile.id,
    role,
    model: selected.model,
    effort: selected.effort
  };
}

/** Alias retained for callers that use the shorter role-resolution name. */
export const resolveProfileRole = resolveDelegationProfile;

function modelIdentity(model: ModelCapability): string {
  if (typeof model.model === "string") return model.model;
  if (typeof model.id === "string") return model.id;
  throw new TypeError("Model capability is missing its identity.");
}

export function evaluateProfile(profile: ProfileRequirements, models: ModelCapability[] | undefined) {
  const availableModels = new Map<string, Set<string>>(
    (models || []).map(model => [
      modelIdentity(model),
      new Set((model.supportedReasoningEfforts || []).map(item =>
        typeof item === "string" ? item : item.reasoningEffort
      ))
    ])
  );
  const missing: MissingCapability[] = [];

  const requirements: Record<string, ModelRequirement> = {
    default_subagent: profile.defaultSubagent,
    ...profile.roles
  };

  for (const [role, requirement] of Object.entries(requirements)) {
    const efforts = availableModels.get(requirement.model);
    if (!efforts) {
      missing.push({ role, model: requirement.model, capability: "model" });
      continue;
    }
    if (!efforts.has(requirement.effort)) {
      missing.push({
        role,
        model: requirement.model,
        effort: requirement.effort,
        capability: "reasoning_effort"
      });
    }
    if (requirement.planEffort && !efforts.has(requirement.planEffort)) {
      missing.push({
        role,
        model: requirement.model,
        effort: requirement.planEffort,
        capability: "plan_reasoning_effort"
      });
    }
  }

  return { id: profile.id, compatible: missing.length === 0, missing };
}
