# README media

## September 26 README refresh

The concept header `../pi-forge-header-concept-1.png` is restored unchanged. The duplicate overview screenshot is no longer embedded; old image files remain available. Installation precedes all demo GIFs.

Follow-up review: the TUI clip was removed from both READMEs because its command/status flow did not clearly communicate the benefit. The file and recorder are retained as historical material; the five WebUI feature GIFs remain in use. The personal motivation is now a short opening note, with a prominent optional-subagents link before installation.

Recordings produced for this refresh, based on source `6a197e6` plus the local unpublished-alias removal:

- `tui-quickstart.gif` (retained, not embedded in README): real Pi 0.87.1 TUI, 1000×540, about 12.75s. `/preset use project:read-first` → `/instruction use project:write-tools` → `/instruction status`. This uses synthetic read-first resources, not a verbatim copy of the checked-in example. Real Forge operations change selected tools from read/ls/control to also bash/edit. No model response is shown or implied.
- `<locale>/tool-selection.gif`: real Policy picker, defaults read/ls → read/ls/grep, Save/Activate, compiled Preview tool list. Permission ceiling already includes grep; this is a default-selection edit, not an authorization bypass. About 12.94s.
- `<locale>/regex-transforms.gif`: enable a preconfigured outgoing system-text rule, then inspect `SAMPLE_TOKEN` → `[REDACTED]` in Preview. About 8.07s. Only synthetic text is used; no general secret-detection guarantee.

Browser captures use the built product editor and production loopback host/compiler, with an inert command harness and synthetic tools (not a live model session). Native X11 pointer interactions are continuous; the blue halo is a recording aid. 1440×900 masters export to 1200×750/15fps GIFs. Semantic before/after assertions check Preview and tool selection; the browser is restricted to its own editor origin. Parent review confirmed no page errors or external browser requests in either locale, and decoded all five GIFs.

The TUI uses a separate temporary home/agent directory, isolated dark colors with brighter dim text, no session persistence, and a local `offline-demo` model definition with an inert placeholder key. That model is not a real provider. Pi runs offline; a Node preload blocks fetch/socket connections and asserts an empty network-attempt log. Keyframes were manually reviewed for actual command results and tool state; capture action logs are not automated OCR assertions. The terminal has no custom Forge UI or replaced output. Earlier captures showing missing-model warnings were discarded from the published asset and retained only in the local evidence report.

### Reproduce the new recordings

Requires the repository dev dependencies, Pi CLI, Google Chrome, Xvfb, xdotool, ffmpeg, ImageMagick `import`, GNOME Terminal and `dbus-run-session`. Private displays `:192` (browser) and `:196` (terminal) must be free. Recorders create disposable resources and clean up only their own processes. Outputs default to the review directory, not the checked-in images.

```bash
npm run build
PI_FORGE_MEDIA_OUT_DIR=/tmp/forge-tools-regex node scripts/record-readme-tools-regex.ts
PI_FORGE_MEDIA_OUT_DIR=/tmp/forge-tui node scripts/record-readme-tui.ts
```

Review `/tmp/forge-tools-regex/assets/{en,zh-CN}/` and `/tmp/forge-tui/assets/tui-quickstart.gif` before copying to `assets/readme/`. Masters, keyframes and evidence stay in each output directory. Fixture IDs, timing and hashes vary between runs. These clips prove local editing/management behavior, not provider delivery, model compliance, cache reuse, sandbox isolation or autonomous agent decisions.

## September 24 continuous v3

Captured 2026-09-24 EDT from accepted UI commit `89c6ba2` (development package metadata 0.5.4), using isolated synthetic projects, the built production loopback editor/compiler and, for Mode, a real SDK AgentSession with no remote model requests.

The September 24 capture produced these per-locale files:
- `editor-overview-v3.png` (retained, no longer in README): editor and compiled Preview (1439×899 browser viewport; the continuous videos/GIFs include the 1px X11 border at 1440×900).
- `context-composition.gif`: native drag reordering plus project-context toggle, about 14.6s.
- `mode-tools.gif`: Current session Use → locate → Off → locate removal, about 18.3s. Actual SDK tools `read → read,grep,find → read`; projected instructions/stop notices remain distinct from delivery or cache evidence.
- `edit-draft-diff.gif`: real keyboard edit followed by Draft diff without resizing, about 13–14s.

GIFs are 1440×900/15fps exports of continuous 30fps x11grab MP4, without time acceleration or stitched state screenshots. The native pointer drives the UI; the blue halo/click pulse is a disclosed recording aid, not a Forge feature. Native dragging's light drag image and actual compile loading states are retained. GIF palette conversion is lossy. Complete MP4/GIF decoding and real browser playback/seek were checked for both languages. No personal resources/credentials/history, model inference, provider/cache claims or user-host restart were involved.

## Reproduce September 24 recordings

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
