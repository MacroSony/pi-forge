# Importing SillyTavern presets

[Documentation](../README.md)

Import through the command line:

```text
/preset import-silly ~/SillyTavern/presets/my-preset.json
```

Use `--dry-run` to preview, `--overwrite` to replace protected output, and an optional `character_id` when the preset contains multiple prompt orders. The web editor also accepts SillyTavern JSON and asks which character order to use when necessary.

Generated stacks go to `.pi/forge/prompt-stacks/<id>.json`; reports go to `.pi/forge/import-reports/<id>.md`. Always read the report before activating the stack.

## Converted behavior

The importer:

- converts prompt order into ordered stack items;
- maps the chat-history marker to a movable `chat-history` slot;
- detects `{{lastUserMessage}}` and avoids duplicating the latest user turn;
- carries relevant identifiers in `source.sillytavern` metadata;
- maps deterministic `promptOnly` regex scripts to history-stage outgoing rules when their behavior is representable;
- converts full-match replacement syntax and preserves trim strings, depth limits, and supported user/assistant placement.

## Report-only behavior

The following require manual review and are not executed:

- display-only or mixed prompt/display scripts;
- DOM, browser, CSS, HTML-decoration, or JavaScript behavior;
- unsupported placements or invalid regular expressions;
- markers with no pi-forge equivalent;
- SillyTavern features whose ordering or lifecycle cannot be represented safely.

pi-forge does not embed arbitrary executable preset code. Unsupported content stays visible in the migration report instead of being silently approximated.

## Recommended workflow

1. Run a dry import.
2. Read every warning and omission in the report.
3. Open the generated stack in `/preset ui`.
4. Validate it and inspect the full preview.
5. Compare the history placement and regex rules with the original preset.
6. Activate it only after the preview matches your intent.

See [stack schema](../reference/stack-schema.md#regex-transforms) for the supported regex runtime.
