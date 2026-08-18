# Migrating to pi-forge 0.5

[Documentation](../README.md)

0.5.0 is a breaking cleanup release. This page is the migration note for the
changes landed so far (Lane 1a-1c plus the compiler/extension conformance
pass in Lane 1d).

## What was removed

- SillyTavern importer (`/preset import-silly`), its reports, guide, example,
  and tests. Convert SillyTavern presets with pi-forge 0.4 before upgrading.
- Mutable turn/session variables, variable mutation macros,
  `pi-forge-variable-state` session entries, and the `variables` slot.
- Regex `display` and `both` effects; `outgoing` and `finalize` remain.

## Template syntax changes

Prompt text now compiles with the closed `forge-v1` grammar.

| 0.4 construct | 0.5 forge-v1 |
|---|---|
| `{{name}}` (static) | `{{ parameters.name }}` |
| `{{lastUserMessage}}` | `{{ runtime.lastUserMessage }}` |
| `{{date}}` / `{{time}}` / `{{cwd}}` | `{{ runtime.date }}` / `{{ runtime.time }}` / `{{ runtime.cwd }}` |
| `{{tools}}` | `{{ runtime.selectedToolsText }}` |
| `{{upper::x}}` | `{{ x \| upper }}` |
| `{{iftools::bash::A::B}}` | `{% if runtime.tool.bash %}A{% else %}B{% endif %}` |
| custom `{{myMacro}}` | `{{ extensions.myMacro }}` |

Unknown paths, unknown filters, parse errors, cycles, and output-limit breaches
are compile errors; a failing block is omitted instead of re-injecting raw
template text.

## Schema v2

Schema v2 stacks store immutable static values in `parameters` (JSON-compatible)
instead of the legacy string-only `variables` field:

```json
{
  "schemaVersion": 2,
  "parameters": { "char": "Konata" }
}
```

Unversioned / v1 stacks continue to load through the legacy `variables` reader.

## Running the migration utility

A mechanical, diagnostics-first script converts a saved stack file:

```bash
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --dry-run
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --write
```

It renames `variables` to `parameters`, maps runtime/parameter paths, and
converts simple filter pipelines. Non-mechanical constructs are reported and
the file is only written when they are absent. A schema v2 file that still
contains a legacy `variables` field is left untouched and only warned about.

## Preview and finalize

Preview never applies `finalize`; it now reports an informational diagnostic.
`finalize` remains a destructive, lifecycle-owned transform that replaces the
stored assistant message.
