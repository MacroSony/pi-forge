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
- native pi-forge and SillyTavern JSON import;
- export, fork, and deletion;
- payload arming and redacted captured-payload inspection;
- light and dark themes.

Existing IDs are immutable during edit. Use **Fork** to create a different ID without breaking profile references or the active selection. New stacks, imports, and forks write to `.pi/forge/prompt-stacks`; legacy stacks remain editable in place.

Saves, imports, forks, and deletes reload stack state into the current Pi session. When another surface changes a referenced stack, returning to profiles refreshes profile resolution without discarding unsaved delegation fields.

## Agent-profile workspace

The profile list shows each profile's ID, display metadata, model, thinking level, stack, resolution state, auto-activation, last-applied provenance, and delegation status.

Trusted projects can create, edit, validate, save, apply once, and delete profiles. Model choices come from Pi's model registry, thinking choices reflect model support, and stack choices come from the shared repository. The editor rejects a second auto-activation profile.

The runtime/provenance card separates current runtime state, last-applied snapshot, source-definition changes, and field-level runtime drift.

## Delegation card

The profile delegation card edits only project-level `subagents.profiles.<id>` values: enablement, backend override, and timeout override. General defaults and `allowAgentInvocationWithoutApproval` remain config-file-only because they affect broader authorization.

Unsaved delegation changes are guarded when selecting another profile, starting another profile operation, refreshing, deleting, or leaving/reloading the page. The card shows effective values and the source of each inherited or overridden setting.

Read [foreground delegation](delegation.md) before enabling a profile.

## Migration

To copy legacy `.pi/prompt-stacks` into `.pi/forge/prompt-stacks`:

```text
/preset migrate-stacks --dry-run
/preset migrate-stacks
```

Review before adding `--overwrite` or `--delete-legacy`.
