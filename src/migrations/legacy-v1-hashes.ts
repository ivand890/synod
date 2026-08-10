const common: Readonly<Record<string, string>> = {
  ".agents/skills/synod-advisor/agents/openai.yaml": "sha256:22fd32cd924bd004d669710b920ce9dcebda49d0f7d745e90c0e2bef9bceb7d1",
  ".agents/skills/synod-advisor/SKILL.md": "sha256:49b838b12196b8f12fb7664b4c32fab27f8cf5b40c2af22fb617dabf3000f726",
  ".codex/agents/synod-explorer.toml": "sha256:c7745d3041c363f99cf22c1e5e5953414199500df1c9c5a3680dcdb648420821",
  ".codex/agents/synod-implementer.toml": "sha256:5952a59791aef038b9e1b50052ef615414ed1a77c169b2b0a387c88a8aae5e8d",
  ".codex/agents/synod-mechanical.toml": "sha256:34b0c8d9e985a2d544c89d783b3862a8ac2effedc4e6cb37a419c772310698cf",
  ".codex/agents/synod-reviewer.toml": "sha256:e7fdf801f29032dee480095303427ec2427afb9327906b7739262ec13ce744e1",
  ".codex/agents/synod-verifier.toml": "sha256:4ccf35e2a0c1e364056e6fa2a6b9b96ad1317a0361c3942cfc27996fb36e7bba",
  ".codex/config.toml": "sha256:5366a88b807884c1e33108ca605d6e7fed048c86f85e95d3ea7ccf2e2b61a604",
  "docs/synod/DECISIONS.md": "sha256:d98e26f113522874efee65c13e3544196e9f0fc80c24c8cad5729c8a09f385c6",
  "docs/synod/GOAL.md": "sha256:4712f8a1937f56ff3ec298c6aca8be06cfd6d05bd902437105c8c3506a151f14",
  "docs/synod/PLAN.md": "sha256:8f9ca299eb15532d97a06d6d3731e9633ab68167df383b8ff8284bc5995b5dc6",
  "AGENTS.md#synod-block": "sha256:a7bbf12a84bd6d379bc9a1f52b86307ff216cca78050279440eb1faafa1d35b3"
};

export const LEGACY_V1_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "0.3.0": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:3008bc27d19cf51f2876748e35b03f78b136568bf81c041c94c04650a1e23300",
    "docs/synod/WORKLOG.md": "sha256:6096f69b04f17b9e7500967148d92c55bf18f26ccb54edf8c25b4b0f4529a38e"
  }),
  "0.3.1": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:3008bc27d19cf51f2876748e35b03f78b136568bf81c041c94c04650a1e23300",
    "docs/synod/WORKLOG.md": "sha256:6096f69b04f17b9e7500967148d92c55bf18f26ccb54edf8c25b4b0f4529a38e"
  }),
  "0.3.2": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:3008bc27d19cf51f2876748e35b03f78b136568bf81c041c94c04650a1e23300",
    "docs/synod/WORKLOG.md": "sha256:6096f69b04f17b9e7500967148d92c55bf18f26ccb54edf8c25b4b0f4529a38e"
  })
});
