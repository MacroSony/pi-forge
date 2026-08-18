# Forge-v1 templates and runtime slots

[Documentation](../README.md)

Prompt text is compiled with the `forge-v1` engine: one closed grammar with no
includes, loops, function calls, or arbitrary expressions. Preview, runtime,
and subagent preparation use the same engine entry.

## Template interpolation

| Syntax | Value |
|---|---|
| `{{ runtime.cwd }}` | Current working directory |
| `{{ runtime.date }}` | Current date as `YYYY-MM-DD` |
| `{{ runtime.time }}` | Current time as `HH:MM:SS` |
| `{{ runtime.lastUserMessage }}` | Latest user message |
| `{{ runtime.selectedToolsText }}` | Comma-separated effective tool names |
| `{{ runtime.activeModel }}` | Current `provider/model` |
| `{{ parameters.<name> }}` | Static stack parameter |
| `{{ extensions.<name> }}` | Registered custom macro value |

Legacy v1 stacks keep a compatibility fallback: bare `{{name}}` resolves to a
static parameter, `{{lastUserMessage}}`/`{{date}}`/`{{time}}`/`{{cwd}}` resolve
to the matching `runtime.*` value, and registered custom macros resolve by
name. New v2 stacks use the explicit `parameters.*` / `runtime.*` paths.

## Filters

Nested pipelines are supported; filters are pure and versioned.

| Filter | Result |
|---|---|
| `{{ value \| trim }}` | Trim surrounding whitespace |
| `{{ value \| upper }}` | Uppercase |
| `{{ value \| lower }}` | Lowercase |
| `{{ value \| json }}` | JSON string literal |
| `{{ value \| xml }}` | XML-escaped |

## Conditionals

```text
{% if runtime.tool.read %}read is available{% else %}read is unavailable{% endif %}
{% if parameters.mode == "image-reader" %}image reader{% endif %}
{% if runtime.tool.bash != null %}bash visible{% endif %}
```

- `{% if path %}` selects the branch when the path exists and is truthy.
- `==` / `!=` compare against a quoted string, including empty strings.
- Nested `{% if %}` blocks are supported.
- An undefined output path is a strict compile error (no raw fallback); the
  legacy `defaults.unresolvedMacroPolicy` is ignored.
- `runtime.tool.<name>` and `runtime.slot.<name>` booleans power tool/slot
  conditionals without function calls.

When a block fails to parse, analyze, or render, pi-forge emits an error
diagnostic and omits that block rather than re-injecting raw template text.

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

Structured slots (`tools`, `tool-guidelines`, `skills`, `project-context`)
default to XML-style wrappers and support `"format": "plain"`.

## Trusted custom definitions

Trusted global/project modules register macros (addressed as
`{{ extensions.<name> }}`) and slots through the pure extension port:

```ts
api.registerMacro({
  name: "ticketId",
  description: "Current ticket id.",
  dependencies: ["parameters.ticket.id"],
  render: ({ env, helpers }) => String(env.parameters["ticket.id"]),
});

api.registerSlot({
  name: "ticket-context",
  description: "Render ticket context.",
  dependencies: ["parameters.ticket.id"],
  options: { heading: { type: "string", default: "Ticket context" } },
  render: ({ item, options, env, helpers }) => "...",
});
```

Custom slots receive the same pure `{ item, options, env, helpers }` context and
declared-dependency resolution as macros, and their output is held to the same
16,384-character extension limit.

See [custom macros and slots](../guides/custom-macros-and-slots.md).
