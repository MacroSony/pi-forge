# README media

Captured on 2026-09-23 from the built 0.5.5-development WebUI (package version still 0.5.4), using the production loopback editor server and compiler with an isolated, synthetic code-review project.

Each locale (`en`, `zh-CN`) has:

- `editor-overview.png`: 1440 × 900, selected instructions beside compiled Preview.
- `context-toggle.gif`: 1440 × 900, two real, settled UI states in a five-second loop. Clicking the project-context toggle removes/restores the owned example `AGENTS.md` paragraph. This is a sampled-state demonstration, not real-time footage or a latency measurement. No zoom, captions, or drawn/replaced UI.
- `draft-diff.png`: 1440 × 620, one instruction edit compared with the saved Preset. Token deltas are estimates, not provider usage.

No model requests, credentials, personal presets, real conversation history, or user-host restart were needed. `demo-session` and the project contents are examples; `/tmp/pi-forge-readme-*` is a disposable project. Runtime context-file input is supplied through the harness's public prompt-options boundary; no private SDK state is patched. Browser traffic is restricted to that editor origin. These images demonstrate editing/compilation, not provider delivery, model compliance or cache reuse.

## Reproduce from a repository checkout

Requires the repository's Node development dependencies, system Chrome (or `CHROME_PATH`) and Python with Pillow for GIF encoding. Outputs are local; this does not publish them.

```bash
npm run build
PI_FORGE_MEDIA_OUT_DIR=/tmp/forge-readme-capture node scripts/record-readme-media.ts
# Inspect the captured PNGs before replacing the checked-in media.
python3 scripts/render-readme-media.py /tmp/forge-readme-capture assets/readme
npm run check:docs
npm run check:package
```

The recorder owns its temporary project/global configuration directories and removes them after use. It never copies user auth files. GIFs use one shared palette and two 2.5-second holds; the encoder validates frame count, loop and dimensions.
