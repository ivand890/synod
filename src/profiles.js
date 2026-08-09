import { ERROR_CODES, SynodError } from "./errors.js";

const profiles = {
  "synod-5.6": {
    id: "synod-5.6",
    description: "Role-specialized GPT-5.6 profile for current Codex releases.",
    minimumCodexVersion: "0.147.0",
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
    description: "Portable profile for the full supported Codex range.",
    minimumCodexVersion: "0.142.0",
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

export function listProfiles() {
  return Object.values(profiles).map(profile => structuredClone(profile));
}

export function getProfile(id = DEFAULT_PROFILE) {
  const profile = profiles[id];
  if (!profile) {
    throw new SynodError(ERROR_CODES.PROFILE_NOT_FOUND, `Unknown model profile: ${id}`, {
      details: { profile: id, available: Object.keys(profiles) }
    });
  }
  return structuredClone(profile);
}

export function evaluateProfile(profile, models) {
  const availableModels = new Map(
    (models || []).map(model => [
      model.id || model.model,
      new Set((model.supportedReasoningEfforts || []).map(item => item.reasoningEffort || item))
    ])
  );
  const missing = [];

  const requirements = {
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
