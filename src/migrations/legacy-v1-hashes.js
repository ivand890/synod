const common = {
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

export const LEGACY_V1_HASHES = Object.freeze({
  "0.3.0": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:6620c742a28805a1b8d515ccd8825ab91f494b60a002af45e7bfd4de4d0d6a7a",
    "docs/synod/WORKLOG.md": "sha256:0028cadbec3445797ea507c26a3bc8adca66ba89c37b549c8a4604ae9dcf63fc"
  }),
  "0.3.1": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:1cf10b08fe2a02009d015d7c045638ae3b67294b47245d3fcae7ce45ae9bf41f",
    "docs/synod/WORKLOG.md": "sha256:2521f9fd35de15ae6d3d3d2da5c637d2e4a88c39a4b9aa32a01b2208aee563db"
  }),
  "0.3.2": Object.freeze({
    ...common,
    "docs/synod/STATE.md": "sha256:19a508908130c6a0a43419d24e6da31a9c541037d7ea734acdff2fc0e496a36c",
    "docs/synod/WORKLOG.md": "sha256:3bc347a0a743ca7a4d8dd1a20116234ff230440ff9308fc59541889c3d9c4d61"
  })
});
