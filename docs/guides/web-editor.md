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
- a **Policy** tab for tool/skill allow/deny resource policy and custom default tools (`tools.initial`);
- a peer **Mode bindings** tab for associating instruction modes (Preset metadata no longer contains bindings);
- structured metadata, parameters, context, and **Regex** editing;
- drag-and-drop item order and enable/disable controls;
- validation and a full compiled preview;
- registered-tool and loaded-skill search with exact-name chips and wildcard patterns;
- raw JSON recovery for advanced or unknown fields;
- native pi-forge JSON import;
- export, fork, and deletion;
- payload arming and redacted captured-payload inspection;
- light and dark themes.

### Editing and inspecting

The resource header identifies the Preset being edited separately from whether it is active in the session. The global Session instructions strip stays available when switching surfaces. Expanding metadata, item properties, rule cards, or binding details does not modify the draft.

- **Stack:** Name and content take priority. Role remains a compact, keyboard-accessible selector; Kind, ID, and slot selection are under **Properties**. Item rows support Enter/Space selection as well as dragging.
- **Regex:** Scan rule names, enable state, stage/effect, and pattern excerpts before expanding a rule. Pattern/replacement editing stays prominent; frequency, targets, roles, and limits are under the rule's advanced section. Use the Preset's **Save** action to persist changes.
- **Policy:** Permission ceiling and default tools are separate cards. Literal/wildcard editing is advanced; skill-list visibility has its own section and is not an execution sandbox.
- **Preview / Draft diff / Run diff:** The boundary chevron cycles sidebar → wide → focused reading → sidebar without replacing the draft. Preview initially uses the sidebar; each diff initially uses focused reading, then remembers manual layout choices while mounted. Narrow windows stack work areas or show the inspector alone instead of squeezing four columns. Draft diff compares draft compilation with the saved definition; Run diff compares captured provider-turn snapshots. Inspection itself does not send a model request or establish cache hits.

Contributed **Settings** pages auto-save and show pending/saving/saved/error feedback. Failed edits remain in the form. Presets, Modes, and Profiles retain their explicit save controls.

### Tool selection and default tools editor

The **Policy** tab includes an opt-in default tools editor (`tools.initial?: string[]`):

- **Default tools picker:** A searchable, collapsible grouped tool picker organizes tools by SDK `sourceInfo` (Pi built-in tools, packages, and top-level entry points).
- **Exact names:** The picker saves concrete tool names. It does not persist package references or auto-install packages, and newly introduced package tools are not automatically added. Inactive registered tools are visible in the picker; unloaded tools are unavailable in the session, but manual saved references are preserved rather than discarded.
- **Omission vs. zero defaults:** Omitting custom defaults preserves legacy behavior (selective allow selects catalog matches; unrestricted/deny retains or filters the session baseline); setting an empty list (`[]`) sets zero active tools by default.
- **Authoritative ceiling:** The advanced literal and wildcard allow/deny policy is retained and acts as an authoritative ceiling; tools blocked by allow/deny cannot be selected as defaults.
- **Runtime behavior:** Configured defaults serve as the active base while the preset is active (not a one-time reset per turn). Deactivating a mode recomputes defaults plus remaining active modes; disabling restores the reconciled session baseline, while switching recomputes under the new Preset and remaining unbound modes.

### Mode bindings tab

Instruction mode bindings are managed in the peer **Mode bindings** tab:

- Each binding card displays the mode reference, scope badge (`project` / `global`), binding ID, and `modelCallable` authorization toggle.
- Overrides (content replace/append, tool add/remove) and live source-effective preview are collapsed under an **Advanced** toggle to keep the primary binding list concise.
- Custom tool overrides feature integrated tool pickers matching the policy picker.

### Save behavior and execution impact

**Activate** uses the saved Preset. It is unavailable while the editor has unsaved changes; save explicitly first. Saving and activating are not a combined transaction.

- **Modes surface:** Saving an instruction mode updates its library definition only and never activates it into the current session.
- **Presets:** Saving an **inactive** Preset updates its configuration file without selecting or activating it. Crucially, saving the **currently active** Preset reloads and synchronizes its live tool and mode authorization policy immediately in the active session, without replacing frozen active mode snapshots.

Existing IDs are immutable during edit. Use **More → Fork** to create a different ID without breaking Profile references or the active selection. The compact selector attached to **New preset** (default `Project`) chooses where new Presets, imports, and forks are written: `Global` targets the user-global `~/.pi/forge/prompt-stacks`, `Project` targets `.pi/forge/prompt-stacks`. Those paths keep their pre-0.5.3 names for compatibility. Less-used capture, fork, import, export, and delete actions live under **More** so the Stack and Preview/Diff panes keep the available viewport. Preset rows show a `global` badge, and save/delete routes use `global:<id>` for exact global mutations. Legacy resources remain editable in place.

Saves, imports, forks, and deletes reload Preset state into the current Pi session. When another surface changes a referenced Preset, returning to Profiles refreshes Profile resolution.

### Compatibility

Presets configured with `tools.initial` require updated Forge. Older Forge versions may ignore `tools.initial` and revert to legacy selection behavior (selective allow selects catalog matches; unrestricted/deny retains or filters the session baseline) (not downgrade-compatible). These changes target the upcoming 0.5.5 release; the development package version is still 0.5.4 pending release preparation. The host requirement remains Pi `>=0.87.0 <0.88.0`.

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
