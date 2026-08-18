# Prompt stacks

[Documentation](../README.md) · [中文](../zh-CN/concepts/prompt-stacks.md)

A prompt stack is an ordered, declarative description of the prompt and policy Pi should use. It combines static **blocks** with dynamic **slots**.

## Blocks and slots

A block inserts static text with a role:

```json
{
  "kind": "block",
  "id": "review-rules",
  "name": "Review rules",
  "enabled": true,
  "role": "system",
  "content": "Prioritize correctness, regressions, security, and missing tests."
}
```

A slot renders current Pi data at that position:

```json
{
  "kind": "slot",
  "id": "history",
  "name": "Conversation",
  "enabled": true,
  "role": "user",
  "slot": "chat-history",
  "options": { "includeLastUserMessage": false }
}
```

Slots cover conversation history, tools, tool guidance, skills, project context, appended system text, model, date, and working directory. See [macros and slots](../reference/macros-and-slots.md).

## Compilation order

For each new user turn, pi-forge:

1. Orders enabled blocks and slots exactly as written.
2. Builds `system` content and applies the stack's `replace`, `append`, or `prepend` mode.
3. Inserts synthetic user/assistant messages around the movable `chat-history` slot.
4. Expands built-in and trusted custom macros.
5. Applies the stack's tool policy to Pi and filters skills rendered by pi-forge.
6. Applies outgoing history/compiled regex rules.
7. Optionally applies destructive finalize rules when an assistant message completes.

The context rewrite happens only on the first provider request for a user-submitted turn. Pi can then continue its normal tool loop without repeatedly rebuilding the same context.

## System modes

- `replace` is the default and gives the stack complete control. An empty replacement falls back to Pi's base prompt.
- `append` adds stack system content after Pi's base prompt.
- `prepend` adds stack system content before Pi's base prompt.

Use `replace` when the model-visible skill list must be controlled. With `append` or `prepend`, Pi's base prompt may already contain an unfiltered skill listing.

## History placement

`chat-history` is movable. A useful task-focused layout is:

1. Long-lived system rules.
2. Runtime tools and project context.
3. Chat history with `includeLastUserMessage: false`.
4. A final user block containing `{{lastUserMessage}}`.

This preserves prior context while presenting the current request once, in an explicit final position. History can also filter summaries and roles, drop previous tool traffic, strip assistant thinking, and limit recent messages or characters. pi-forge repairs dangling tool-call/result pairs after filtering.

## Tool and skill policy

Stacks may use either `allow` or `deny` patterns for each resource. Tool policy changes Pi's active tools and is guarded at tool-call time; it remains enforced while the stack is selected. Skill policy only filters skills rendered by pi-forge—it does not prevent explicit skill invocation and is not a security boundary.

External tool additions are preserved in the baseline restored when a restrictive stack is disabled. See the exact behavior in [stack policy reference](../reference/stack-schema.md#tool-and-skill-policy).

## Scopes and shadowing

Stacks may live in the user-global `~/.pi/forge/prompt-stacks/` or the project `.pi/forge/prompt-stacks/`. A project stack shadows a same-ID global stack for unqualified commands. Selectors are `reviewer`, `project:reviewer`, or `global:reviewer`. Duplicate IDs are errors only within one scope.

## Activation and session behavior

- A stack may set `autoActivate: true`; conflicting auto-activation in one scope is invalid and fails closed.
- `default.json` has no special filename role anymore; missing `autoActivate` yields a migration warning.
- `/preset use none` records an explicit session opt-out.
- Active stack selection follows Pi's session-tree branch.
- Restored branch state takes precedence over fresh-session auto-activation.
- Project auto-activation candidates take precedence over global ones; an invalid or ambiguous project candidate never falls back to a global stack.
- An auto-activated agent profile takes precedence over standalone stack autoload.

## Extensions and transforms

Static stack variables support nested macros; lazy conditionals are available for tool and slot selection. Trusted JavaScript/TypeScript registration modules can add macros and slots without putting executable code in stack JSON. Deterministic regex rules can transform model-bound prompt text or, with an explicit warning, replace finalized assistant transcript text.

See [custom macros and slots](../guides/custom-macros-and-slots.md), [macro reference](../reference/macros-and-slots.md), and [regex schema](../reference/stack-schema.md#regex-transforms).
