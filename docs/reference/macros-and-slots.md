# Macros and runtime slots

[Documentation](../README.md)

## Value macros

| Macro | Value |
|---|---|
| `{{lastUserMessage}}` | Latest user message |
| `{{date}}` | Current date as `YYYY-MM-DD` |
| `{{time}}` | Current time as `HH:MM:SS` |
| `{{cwd}}` | Current working directory |
| `{{tools}}` | Comma-separated selected tool names |
| `{{selectedTools}}` | Alias of `{{tools}}` |
| `{{activeModel}}` | Current `provider/model` |
| `{{name}}` | Static stack variable lookup from `stack.variables` |

## Filters and conditionals

Nested macros are supported. `::` separators are parsed only at the current macro depth.

| Macro | Result |
|---|---|
| `{{trim::value}}` | Trim surrounding whitespace |
| `{{upper::value}}` | Uppercase value |
| `{{lower::value}}` | Lowercase value |
| `{{json::value}}` | JSON string literal |
| `{{xml::value}}` | XML-escaped value |
| `{{iftools::tool::then::else}}` | Select by effective tool name |
| `{{ifslot::slot::then::else}}` | Select by enabled slot name |

The final `else` is optional. Branches are lazy: skipped branches are not expanded.

Unknown macro behavior is controlled by stack `defaults.unknownMacro`: keep, warn, or error according to schema validation.

## Built-in slots

| Slot | Rendered content |
|---|---|
| `chat-history` | Current conversation, with filtering and limits |
| `tools` | Effective tools and descriptions/snippets |
| `tool-guidelines` | Tool-use guidance |
| `skills` | Model-visible loaded Pi skills |
| `project-context` | Trusted project instructions/context |
| `append-system-prompt` | Pi's appended system prompt text |
| `date` | Current date, optionally time |
| `cwd` | Working directory |
| `date-cwd` | Date and working directory, optionally time |
| `active-model` | Selected provider/model |
| `pi-docs` | Pi documentation guidance |

Structured slots (`tools`, `tool-guidelines`, `skills`, `project-context`) default to XML-style wrappers and support `"format": "plain"`.

Notable Pi-mirror options include `tools.onlyWithSnippets`, `tool-guidelines.heading`, `tool-guidelines.includePiDefaultGuidelines`, `tool-guidelines.piStyle`, and `skills.requireReadTool`. `date` and `date-cwd` support `includeTime: true`.

The complete `chat-history` option set is documented in [stack schema](stack-schema.md#chat-history-options).

## Trusted custom definitions

Trusted global/project modules and reusable Pi packages can register additional macro and slot names. The runtime exposes the active definitions through `getRegisteredMacros()` and `getRegisteredSlots()`. See [custom macros and slots](../guides/custom-macros-and-slots.md).
