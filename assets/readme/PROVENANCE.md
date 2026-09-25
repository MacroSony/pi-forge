# README media — continuous v3

Captured 2026-09-24 EDT from accepted UI commit `89c6ba2` (development package metadata 0.5.4), using isolated synthetic projects, the built production loopback editor/compiler and, for Mode, a real SDK AgentSession with no remote model requests.

Current README uses these per-locale files:
- `editor-overview-v3.png`: current editor and compiled Preview (1439×899 browser viewport; the continuous videos/GIFs include the 1px X11 border at 1440×900).
- `context-composition.gif`: native drag reordering plus project-context toggle, about 14.6s.
- `mode-tools.gif`: Current session Use → locate → Off → locate removal, about 18.3s. Actual SDK tools `read → read,grep,find → read`; projected instructions/stop notices remain distinct from delivery or cache evidence.
- `edit-draft-diff.gif`: real keyboard edit followed by Draft diff without resizing, about 13–14s.

GIFs are 1440×900/15fps exports of continuous 30fps x11grab MP4, without time acceleration or stitched state screenshots. The native pointer drives the UI; the blue halo/click pulse is a disclosed recording aid, not a Forge feature. Native dragging's light drag image and actual compile loading states are retained. GIF palette conversion is lossy. Complete MP4/GIF decoding and real browser playback/seek were checked for both languages. No personal resources/credentials/history, model inference, provider/cache claims or user-host restart were involved.

## Reproduce current recordings

Requires the checkout's development dependencies, Xvfb, xdotool, ffmpeg, Google Chrome and Python Pillow. Private display `:192` must be unused. The recorder refuses to use an occupied display, creates disposable fixtures and cleans its own processes/resources. Do not copy output over formal assets without reviewing it.

```bash
npm run build
PI_FORGE_MEDIA_OUT_DIR=/tmp/forge-readme-v3 LOCALES=en,zh-CN SCENES=context,diff,mode node scripts/record-readme-continuous.ts
python3 scripts/export-readme-continuous.py /tmp/forge-readme-v3
```

Output is `media/<locale>/{context,mode,diff}.{mp4,gif}`, proof images and semantic evidence; `manifest.json` records dimensions/durations/hashes. Copy approved GIFs to the corresponding names above and `context-poster.png` to `editor-overview-v3.png`. New recordings have fresh synthetic session IDs; pixel-identical reproduction is not promised.

## Retained legacy media (not referenced by current README)

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
