# Web editor

[Documentation](../README.md)

Open the browser editor from a trusted Pi project:

```text
/preset ui
```

Use `/preset ui restart` to replace its server or `/preset ui stop` to close it.

## Connection and trust

The editor binds to an available `127.0.0.1` port and uses a session token. Multiple Pi projects can run editors simultaneously. Lifecycle reinitialization reuses the existing editor URL for the same project when possible.

Reads, preview, resources, and payload inspection remain available as appropriate, but writes require Pi to trust the project. Files are constrained to Pi Forge's Preset/Profile storage. Never expose or proxy the editor URL to an untrusted network.

Choose a preferred port in `.pi/forge/config.json`:

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

If that port is unavailable, pi-forge selects another and shows the actual URL.

## Interface language

The editor interface is available in English and Chinese. Use the language selector in the top bar (Auto / English / 中文); the choice is written to `webEditor.locale` in the project config. `Auto` (the default) follows the browser language, and the initial page render also honors the browser's `Accept-Language` header. Interface chrome, built-in Preset/Profile surfaces, and the preview/diff dock are localized; compiler diagnostics, provider-contributed settings pages, and authored Preset content stay in their authored language.

## Preset workspace

The Preset workspace provides:

- creation from the default Pi-mirror layout;
- an ordered **Stack** tab for Block/Slot composition;
- structured metadata, policy, parameters, context, and Regex editing;
- drag-and-drop item order and enable/disable controls;
- validation and a full compiled preview;
- registered-tool and loaded-skill search with exact-name chips and wildcard patterns;
- raw JSON recovery for advanced or unknown fields;
- native pi-forge JSON import;
- export, fork, and deletion;
- payload arming and redacted captured-payload inspection;
- light and dark themes.

Existing IDs are immutable during edit. Use **More → Fork** to create a different ID without breaking Profile references or the active selection. The compact selector attached to **New preset** (default `Project`) chooses where new Presets, imports, and forks are written: `Global` targets the user-global `~/.pi/forge/prompt-stacks`, `Project` targets `.pi/forge/prompt-stacks`. Those paths keep their pre-0.5.3 names for compatibility. Less-used capture, fork, import, export, and delete actions live under **More** so the Stack and Preview/Diff panes keep the available viewport. Preset rows show a `global` badge, and save/delete routes use `global:<id>` for exact global mutations. Legacy resources remain editable in place.

Saves, imports, forks, and deletes reload Preset state into the current Pi session. When another surface changes a referenced Preset, returning to Profiles refreshes Profile resolution.

## Agent-profile workspace

The Profile list shows each Profile's ID, display metadata, model, thinking level, Preset, resolution state, auto-activation, last-applied provenance, and a `project`/`global` scope badge. Same-ID shadow pairs are marked `shadows global:<id>` or `shadowed by project:<id>`.

Trusted projects can create Profiles in either scope: the scope selector beside **New profile** (default `project`) chooses whether to write the user-global `~/.pi/forge/agent-profiles` or the project `.pi/forge/agent-profiles`. Global Profiles can be edited, validated, saved, applied once, and deleted through explicit `global:<id>` routes; unqualified routes stay project-only. When editing a global Profile, the Preset dropdown offers only global Presets. Model choices come from Pi's model registry, thinking choices reflect model support, and Preset choices come from the shared repository. The editor rejects a second auto-activation Profile within the same scope.

The runtime/provenance card separates current runtime state, last-applied snapshot, source-definition changes, and field-level runtime drift.

## Delegation

Delegation configuration is not part of the main editor. The optional `@zihanw/pi-forge-subagents` package owns the dedicated `.pi/forge/subagents.json` and `~/.pi/forge/subagents.json` files. Read [foreground delegation](delegation.md) before enabling a profile.

## Migration

To copy legacy `.pi/prompt-stacks` into `.pi/forge/prompt-stacks`:

```text
/preset migrate-stacks --dry-run
/preset migrate-stacks
```

Review before adding `--overwrite` or `--delete-legacy`.
