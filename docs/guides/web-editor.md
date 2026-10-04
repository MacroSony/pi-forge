# Web editor

[Documentation](../README.md)

Open the browser editor from a trusted Pi project:

```text
/preset ui
```

Use `/preset ui restart` to replace its server or `/preset ui stop` to close it.

## Connection and trust

The editor binds to an available `127.0.0.1` port and uses a session token. Multiple Pi projects can run editors simultaneously. Lifecycle reinitialization reuses the existing editor URL for the same project when possible.

Reads, preview, resources, and payload inspection remain available as appropriate, but writes require Pi to trust the project. Built-in Web writes are constrained to Pi Forge's Preset/Profile, Capability, and trusted Forge configuration storage. Never expose or proxy the editor URL to an untrusted network.

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

- preset creation with template choices (Default Pi prompt, Empty, Minimal Worker);
- an ordered **Stack** tab for Block/Slot composition;
- a **Policy** tab for tool/skill allow/deny resource policy and custom default tools (`tools.initial`);
- a peer **Capability bindings** tab for associating capabilities (Preset metadata no longer contains bindings);
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

The resource header identifies the Preset being edited separately from whether it is active in the session. The global Session capabilities strip stays available when switching surfaces. Opening **Preset properties**, item properties, rule cards, or binding details does not modify the draft. Preset properties now opens from the resource header without pushing the editor down; its field edits remain in the same Preset draft until Save. Global Session capabilities retains a compact summary and opens the non-modal **Current session** workspace, separate from the edited resource. Effective tools, instruction excerpts, active capabilities and activation controls come first; full instruction bodies, session identity and transport details are expandable. Trust/stale/error and pending/prepared warnings remain visible. Preset status feedback sits in the footer; its Disable action still targets the active Preset, not the selected draft.

- **Stack:** Rows show a name/on-off control and one summary line, such as `user · report` or `slot · chat-history`. Full identity remains available in tooltips and **Properties**, including Copy ID. Role and slot selection sit beside Properties; content follows directly. Rows support Enter/Space selection and dragging. A quiet, direct delete button remains in the item header with confirmation. Slot option forms size to their contents rather than stretching their rows.
- **Row state and pane widths:** Disabled rows use a neutral background, muted text and gray side markers; a thin selection outline means editing, not enabling. Drag the right edge of the Presets or Stack items pane to resize it. Double-click or press Enter on the separator to restore its default; arrow keys adjust it, and Escape cancels an active drag. Width preferences stay in this browser origin, never in Preset JSON, and do not dirty or save a draft. Smaller windows temporarily constrain widths to leave editing room; narrow screens retain the stacked layout.
- **Regex:** Scan rule names, enable state, stage/effect, and pattern excerpts before expanding a rule. Pattern/replacement editing stays prominent; frequency, targets, roles, and limits are under the rule's advanced section. A dashed list-end entry adds and focuses a rule. Rule/binding removal is confirmed and remains a draft change; use the Preset's **Save** action to persist changes.
- **Policy:** Permission ceiling and default tools are separate cards. Literal/wildcard editing is advanced; skill-list visibility has its own section and is not an execution sandbox.
- **Preview / Draft diff / Run diff:** Preview is a separate workspace toggle: opening, closing, or changing editor tabs preserves the current editing page. The boundary chevron widens the sidebar; wide mode offers separate shrink and focus buttons. Leaving focus restores the previous nonfocused layout and keeps the inspection tab, without replacing the draft. Choosing another editing section while focused reveals that editor and retains the dock. The panel initially uses the sidebar. Switching Preview, Draft diff, or Run diff changes only its content and preserves the current width and focus state; focused reading is entered explicitly. Narrow windows stack work areas instead of squeezing four columns; focused reading hides the editor until you return or choose an editing section. Draft diff compares draft compilation with the saved definition; Run diff compares captured provider-turn snapshots. Inspection itself does not send a model request or establish cache hits.

Profile editing groups Provider/Model and Thinking/Preset together; immutable identity appears in the heading. Profile and Capability creation still explicitly choose ID and scope. The Advanced Preset tab places editable parameters before the collapsed extension reference catalog. Preview tool details are expandable; section statistics remain available under **Source**.

Contributed **Settings** pages auto-save and show pending/saving/saved/error feedback. Failed edits remain in the form. Presets, Capabilities, and Profiles retain their explicit save controls.

### Reading Preview and tool results

Preview and Current session use readable excerpts with teal user / blue assistant roles. **Tools** groups start expanded; individual calls and results start as single lines. Fold a group to keep just its call/result counts and explicit failures. Groups cover only uninterrupted tools belonging to one assistant message; intervening messages or instructions stay visible. Missing, conflicting or ambiguous call IDs are not guessed. A uniquely matched file result can show the filename from its actual call arguments.

**Results → Original order** is the default. **Pair with calls** places uniquely associated returns beside their calls only within a safe continuous tool interval. Cross-message results and unassociated-result barriers remain in place. This is display pairing, not a timeline or claim about parallel execution; the position markers always refer to the original projection. These view controls do not modify the Preset, provider context or executable tools. Choices are local to the open inspector, not persisted resource settings.

Search examines complete message text, roles, source labels, tool names/call IDs, named System section keys and historical declaration JSON. Matching groups, text and declarations open temporarily; clearing search restores prior disclosure choices and reading positions. **Full text** expands the inspection text; **Source** exposes provenance and existing text estimates. Named System sections distinguish setting, setting empty, and removal; historical tool declarations remain separate from currently selected tools. The existing estimates still describe the compiler's text projection, not full tool schemas, structured arguments or media.

**Historical transcript tool declarations** keep each added tool collapsed to one line: name, an excerpt of its real description, and a count when the schema explicitly lists top-level properties. This is a declared-property count, not inferred arity through references/composites; an unknown schema does not mean zero arguments. Open a tool to inspect or copy its complete Preview declaration JSON (name, description and parameters when present). Removed declarations retain their names only; no missing schema is reconstructed. These historical records do not select executable tools.

Editing within the same Preset keeps inspection choices and unchanged tool reading positions. While the new draft compiles, the previous preview is explicitly marked pending and its inspection controls are paused. A real resource switch still resets local inspection state. On short narrow screens the Preset shell scrolls as needed so headers cannot squeeze the editor/inspection dock to zero height.

**Copy report** retains the compiler text report. Copy a tool row for its complete displayed parameters/output. Structured argument JSON is a representation of the compiled object, not raw provider-wire bytes; images and unsupported content parts have explicit placeholders. Text copying is not a complete multimodal export. Folding, pairing and excerpts do not reduce model context, token usage, or establish cache savings. Draft/Run diff and request invalidation retain their existing meanings.

### Inspecting a Capability's context impact

The **Current session** workspace places capability controls and tools on the left, and the session projection on the right (stacked on narrow screens). It shows current effective tools and a short excerpt of each active instruction snapshot. A successful Enable/Disable/Reset in this browser also shows the observed tool additions/removals; this is not a persistent history. A Capability's configured tool adjustments are labeled separately: overlapping Capabilities can produce no net tool change.

**Locate in context** keeps the controls visible and highlights related projected update blocks, scrolling to the latest match. Normal updates do not steal the reading position. The workspace inspects the **active saved Preset + current session capabilities**, not whichever Preset is being edited. The Preset editor still supports simultaneous editing and **Preview / Draft diff / Run diff**; switching workspaces preserves its draft, selection, inspection tab and width/focus.

**After switching Presets:** if a turn ran under A and you then activate saved Preset B, this projection updates to B with the existing branch history and current capabilities, without sending a model request. Merely selecting/editing B leaves A active. Earlier A messages and historical declarations can still appear as history; that does not mean B failed to activate. This is a current composition preview, not the last sent request or an exact prediction of the next provider payload. Run diff retains captured requests; Payload shows the capture that was armed, not arbitrary past turns. Capture is at the provider hook and can precede later plugin shaping.

Background status checks are quiet and do not reload the capabilities catalog or disable otherwise usable controls on each poll. Catalog discovery occurs on workspace entry, explicit refresh and relevant mutation follow-up. Returning invalidates late reads from a previous visit without discarding in-flight mutation receipts. Projection reads follow semantic state changes, rather than a second polling loop. During same-branch refresh a labeled previous projection remains visible; stale/untrusted or changed session/branch data is invalidated.

Block numbers apply only to that preview. Native System sections and attributed user-fallback updates retain their actual roles; stopping a Capability does not erase its earlier updates. If no reliable match is visible, the inspector says so rather than guessing. This first iteration requires a trusted session and an active Preset; full event-history browsing is not included.

Inspection is a local read: it neither prepares/delivers a request nor changes tools or session history. It is not a captured provider payload or evidence of cache reuse; use Run diff/Payload and reported usage for those separate observations.

### Tool selection and default tools editor

The **Policy** tab includes an opt-in default tools editor (`tools.initial?: string[]`):

- **Default tools picker:** A searchable, collapsible grouped tool picker organizes tools by SDK `sourceInfo` (Pi built-in tools, packages, and top-level entry points). Group checkboxes select/deselect the currently filtered group. **Enter tool names manually** preserves literal/offline-name entry, including in the Capability editor.
- **Exact names:** The picker saves concrete tool names. It does not persist package references or auto-install packages, and newly introduced package tools are not automatically added. Inactive registered tools are visible in the picker; unloaded tools are unavailable in the session, but manual saved references are preserved rather than discarded.
- **Omission vs. zero defaults:** Omitting custom defaults preserves legacy behavior (selective allow selects catalog matches; unrestricted/deny retains or filters the session baseline); setting an empty list (`[]`) sets zero active tools by default.
- **Authoritative ceiling:** The advanced literal and wildcard allow/deny policy is retained and acts as an authoritative ceiling; tools blocked by allow/deny cannot be selected as defaults.
- **Runtime behavior:** Configured defaults serve as the active base while the preset is active (not a one-time reset per turn). Disabling a capability recomputes defaults plus remaining active capabilities; disabling the preset restores the reconciled session baseline, while switching recomputes under the new Preset and remaining unbound capabilities.

### Capability bindings tab

Capability bindings are managed in the peer **Capability bindings** tab:

- Each binding card shows one scoped capability reference and the model-activation authorization toggle. Binding ID belongs to its expandable details, not a permanently visible header field.
- **Advanced** reveals binding ID and overrides (content replace/append, tool add/remove). The live source-effective preview has its own disclosure.
- Tool overrides choose **Inherit** or **Custom override**, with integrated tool pickers matching the policy picker. A custom list may be empty: `[]` replaces that source add/remove list with zero entries, while inheritance omits the override. It does not clear every session tool or bypass other permission limits.
- Binding order is catalog order, not execution priority; the editor no longer offers up/down controls. Direct removal requires confirmation and stays in the Preset draft until Save. Expanded details follow their binding when another row is deleted.

### Save behavior and execution impact

**Activate** uses the saved Preset. It is unavailable while the editor has unsaved changes; save explicitly first. Saving and activating are not a combined transaction.

- **Capabilities surface:** Saving a capability updates its library definition only and does not enable it in the current session.
- **Presets:** Saving an **inactive** Preset updates its configuration file without selecting or activating it. Crucially, saving the **currently active** Preset refreshes its policy immediately in the active session (synchronizing live tool and capability authorization policy), without replacing frozen active capability snapshots.

Existing IDs are immutable during edit. Use **More → Fork** to create a different ID without breaking Profile references or the active selection. The **New preset**, **Import**, and **Fork** dialogs collect name, ID, and target scope (default `Project`) before writing: `Global` targets the user-global `~/.pi/forge/prompt-stacks`, `Project` targets `.pi/forge/prompt-stacks`. Those paths keep their pre-0.5.3 names for compatibility.

The **New preset** dialog offers three initial templates:
- **Default Pi prompt:** Preserves Pi's built-in prompt layout with movable slots, tools, guidelines, docs, project context, skills, and chat history.
- **Empty:** Starts with no preset items or tool/skills policies (`items: []`). This does not mean zero context or tools; Pi automatically retains its base system prompt and history when no composed system prompt is provided.
- **Minimal Worker:** Mirrors the DeepSeek Harness minimal shape (`examples/minimal-prompt-stack.json`) with a single-line system persona ('You are a helpful software engineer assistant.'), chat history with summaries disabled, and restricted tools (`bash` and `edit` only).

Choosing a template automatically updates the suggested preset name as long as it has not been customized by the user. The **Import** and **Fork** dialogs continue to use the supplied or loaded source preset, not a creation template.

The dashed creation entry sits below the Preset list; **Add content / slot** below the item list lets you choose Block or Slot. Less-used capture, fork, import, export, and delete actions live under **More** so the Stack and Preview/Diff panes keep the available viewport. Preset rows show a `global` badge, and save/delete routes use `global:<id>` for exact global mutations. Legacy resources remain editable in place.

Saves, imports, forks, and deletes reload Preset state into the current Pi session. When another surface changes a referenced Preset, returning to Profiles refreshes Profile resolution.

### Compatibility

Presets configured with `tools.initial` require updated Forge. Older Forge versions may ignore `tools.initial` and revert to legacy selection behavior (selective allow selects catalog matches; unrestricted/deny retains or filters the session baseline) (not downgrade-compatible). These changes require Forge 0.5.5; the minimum host requirement remains Pi 0.87.0 (published 0.5.7 peer range was `>=0.87.0 <0.88.0`; unreleased source compatibility supports `>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.1.0`; see [Pi 1.0 compatibility guide](pi-1-compatibility.md)).

## Agent-profile workspace

The Profile list shows each Profile's ID, display metadata, model, thinking level, Preset, resolution state, auto-activation, last-applied provenance, and a `project`/`global` scope badge. Same-ID shadow pairs are marked `shadows global:<id>` or `shadowed by project:<id>`.

Profile and Capability libraries place their dashed creation entry below the resource list. Creation editors put name first and choose scope in one place; they keep their full model/content fields and do not write incomplete resources merely to create a list row.

Trusted projects can create Profiles in either scope: the scope field in the creation editor (default `project`) chooses whether to write the user-global `~/.pi/forge/agent-profiles` or the project `.pi/forge/agent-profiles`. Global Profiles can be edited, validated, saved, applied once, and deleted through explicit `global:<id>` routes; unqualified routes stay project-only. When editing a global Profile, the Preset dropdown offers only global Presets. Model choices come from Pi's model registry, thinking choices reflect model support, and Preset choices come from the shared repository. The editor rejects a second auto-activation Profile within the same scope.

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
