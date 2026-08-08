import { contentHash, inspectPath, resolveProjectPath, unsafeAncestor } from "../filesystem.js";
import { createManifest } from "../manifest.js";
import { extractManagedAgentsBlock, generatedConfigMarker, ownershipFor } from "../templates.js";
import { LEGACY_V1_HASHES } from "./legacy-v1-hashes.js";

function legacyAgentsSeparator(content, blockStart) {
  const prefix = content.slice(0, blockStart);
  if (prefix.length === 0) return { separatorBefore: "" };
  const trailingNewlines = prefix.match(/\n+$/)?.[0].length || 0;
  if (trailingNewlines >= 3) return { separatorBefore: "" };
  return { separatorAmbiguous: true };
}

export async function migrateManifest1To2(targetDirectory, legacy) {
  const baseline = LEGACY_V1_HASHES[legacy.templateVersion];
  const baselinePaths = baseline
    ? Object.keys(baseline).filter(item => item !== "AGENTS.md#synod-block")
    : [
        ".agents/skills/synod-advisor/agents/openai.yaml",
        ".agents/skills/synod-advisor/SKILL.md",
        ".codex/agents/synod-explorer.toml",
        ".codex/agents/synod-implementer.toml",
        ".codex/agents/synod-mechanical.toml",
        ".codex/agents/synod-reviewer.toml",
        ".codex/agents/synod-verifier.toml",
        ".codex/config.toml",
        "docs/synod/DECISIONS.md",
        "docs/synod/GOAL.md",
        "docs/synod/PLAN.md",
        "docs/synod/STATE.md",
        "docs/synod/WORKLOG.md"
      ];
  const files = [];

  for (const relativePath of baselinePaths) {
    const inspected = await inspectLegacyPath(targetDirectory, relativePath);
    let ownership = ownershipFor(relativePath);
    if (relativePath === ".codex/config.toml" && inspected.type === "file" && !inspected.content.startsWith(generatedConfigMarker)) {
      ownership = "user";
    }
    const trustedBaseline = baseline?.[relativePath];
    files.push({
      path: relativePath,
      ownership,
      contentHash: ownership === "user" && inspected.hash ? inspected.hash : trustedBaseline || inspected.hash,
      provenance: trustedBaseline ? "legacy-baseline" : "legacy-adopted"
    });
  }

  const agents = await inspectLegacyPath(targetDirectory, "AGENTS.md");
  if (agents.type === "file") {
    const managed = extractManagedAgentsBlock(agents.content);
    const trustedBlock = baseline?.["AGENTS.md#synod-block"];
    if (managed.content || trustedBlock) {
      files.push({
        path: "AGENTS.md",
        ownership: "shared",
        contentHash: trustedBlock || (managed.content ? contentHash(managed.content) : undefined),
        provenance: trustedBlock ? "legacy-baseline" : "legacy-adopted",
        ...legacyAgentsSeparator(agents.content, managed.blocks[0]?.start || 0)
      });
    }
  }

  return createManifest({
    templateVersion: legacy.templateVersion,
    profile: "synod-5.6",
    files: files.filter(entry => entry.contentHash),
    migrations: [{ from: 1, to: 2 }]
  });
}

async function inspectLegacyPath(targetDirectory, relativePath) {
  const targetPath = resolveProjectPath(targetDirectory, relativePath);
  if (await unsafeAncestor(targetDirectory, targetPath)) return { type: "unsafe" };
  return inspectPath(targetPath);
}
