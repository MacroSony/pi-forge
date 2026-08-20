# Web editor

[Documentation](../README.md)

Open the browser editor from a trusted Pi project:

```text
/preset ui
```

Use `/preset ui restart` to replace its server or `/preset ui stop` to close it.

## Connection and trust

The editor binds to an available `127.0.0.1` port and uses a session token. Multiple Pi projects can run editors simultaneously. Lifecycle reinitialization reuses the existing editor URL for the same project when possible.

Reads, preview, resources, and payload inspection remain available as appropriate, but writes require Pi to trust the project. Files are constrained to pi-forge's stack/profile storage. Never expose or proxy the editor URL to an untrusted network.

Choose a preferred port in `.pi/forge/config.json`:

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

If that port is unavailable, pi-forge selects another and shows the actual URL.

## Prompt-stack workspace

The stack workspace provides:

- creation from the default Pi-mirror layout;
- structured metadata, item, policy, variables, context, and regex editing;
- drag-and-drop item order and enable/disable controls;
- validation and a full compiled preview;
- registered-tool and loaded-skill search with exact-name chips and wildcard patterns;
- raw JSON recovery for advanced or unknown fields;
- native pi-forge JSON import;
- export, fork, and deletion;
- payload arming and redacted captured-payload inspection;
- light and dark themes.

Existing IDs are immutable during edit. Use **Fork** to create a different ID without breaking profile references or the active selection. The toolbar scope selector (default `project`) chooses where new stacks, imports, and forks are written: `global` targets the user-global `~/.pi/forge/prompt-stacks`, `project` targets `.pi/forge/prompt-stacks`. Stack rows show a `global` badge, and save/delete routes use `global:<id>` for exact global mutations. Legacy stacks remain editable in place.

Saves, imports, forks, and deletes reload stack state into the current Pi session. When another surface changes a referenced stack, returning to profiles refreshes profile resolution.

## Agent-profile workspace

The profile list shows each profile's ID, display metadata, model, thinking level, stack, resolution state, auto-activation, last-applied provenance, and a `project`/`global` scope badge. Same-ID shadow pairs are marked `shadows global:<id>` or `shadowed by project:<id>`.

Trusted projects can create profiles in either scope: the scope selector beside **New profile** (default `project`) chooses whether to write the user-global `~/.pi/forge/agent-profiles` or the project `.pi/forge/agent-profiles`. Global profiles can be edited, validated, saved, applied once, and deleted through explicit `global:<id>` routes; unqualified routes stay project-only. When editing a global profile, the prompt-stack dropdown offers only global stacks. Model choices come from Pi's model registry, thinking choices reflect model support, and stack choices come from the shared repository. The editor rejects a second auto-activation profile within the same scope.

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
