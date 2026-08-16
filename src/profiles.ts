import { ERROR_CODES, SynodError } from "./errors.js";

export interface ModelRequirement {
  model: string;
  effort: string;
  planEffort?: string;
}

export type ProfileRole = "supervisor" | "implementer" | "explorer" | "reviewer" | "verifier" | "mechanical";

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

const profiles: Record<string, ModelProfile> = {
  "synod-5.6": {
    id: "synod-5.6",
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
  portable: {
    id: "portable",
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

export const DEFAULT_PROFILE = "portable";

export function listProfiles(): ModelProfile[] {
  return Object.values(profiles).map(profile => structuredClone(profile));
}

export function getProfile(id: string = DEFAULT_PROFILE): ModelProfile {
  const profile = profiles[id];
  if (!profile) {
    throw new SynodError(ERROR_CODES.PROFILE_NOT_FOUND, `Unknown model profile: ${id}`, {
      details: { profile: id, available: Object.keys(profiles) }
    });
  }
  return structuredClone(profile);
}

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
