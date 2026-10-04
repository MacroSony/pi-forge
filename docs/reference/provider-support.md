# Provider support for mid-conversation updates (Pi 0.87.1 snapshot)

[Documentation](../README.md) · [中文](../zh-CN/reference/provider-support.md)

This page records how Pi 0.87.1 sends mid-conversation system updates and tool changes for each API, and which models in the Pi model catalog were flagged for them. It explains why a [capability](capabilities.md#delivery-models-native-vs-fallback) may arrive as a native system update on one model and as a labeled user message on another.

> **Snapshot status:** Pi 0.87.1 (`@earendil-works/pi-ai` 0.87.1), local model catalog last checked 2026-09-21 to 2026-09-25, recorded 2026-09-26. Pi fetches the model catalog remotely and caches it in `~/.pi/agent/models-store.json`, so flags can change without a Pi upgrade. Run `/capability status` to see which path the current model uses before relying on this table.

## How the choice is made

Pi and Forge both read the current model's `compat` flags on every request:

| Flag | Effect when `true` | Effect when absent or `false` |
|---|---|---|
| `supportsMidConvoSystemMessages` | Later system messages stay at their position in the conversation. Forge sends instruction text as native system sections. | Pi folds all system messages into the leading system prompt and sends the current tool list at request level. Forge sends instruction text as a labeled `[pi-forge capability update]` user message. |
| `supportsMidConvoToolChanges` (Anthropic Messages) | Tool additions and removals are sent as `tool_addition` / `tool_removal` blocks inside the system update. | The whole current tool list is sent at request level. |
| `supportsAdditionalTools` / `supportsToolSearch` (OpenAI Responses, Codex, Azure) | New tools are loaded in place (`additional_tools`, or a client-side tool search call and output). | The whole current tool list is sent at request level. |
| `supportsMidConvoToolAdditions` (OpenAI Completions) | New tools are loaded in place by a system message that carries `tools`. | The whole current tool list is sent at request level. |

Tool flags only apply when `supportsMidConvoSystemMessages` is also enabled. The provider name, the authentication method, and auth extensions do not decide the path. The same model can be flagged differently under different providers.

## Behavior by API

| API | Instruction text | Tool changes |
|---|---|---|
| `anthropic-messages` | With the flag: a `role: "system"` message. Pi holds it until just before the next assistant message, so it never separates a `tool_use` from its `tool_result`; an update recorded before a user message is sent after it. | With `supportsMidConvoToolChanges` and at least one initial tool. **Pi 1.0.1+:** the request-level list stays fixed (initial tools plus a reserved deferred placeholder); later tools are defined by value inside `tool_addition` blocks (a same-name redefinition replaces the earlier definition) and withdrawn by `tool_removal`. **Pi 1.0.0 and earlier:** later tools are appended to the request-level list with `defer_loading`, the list only grows, and a same-name redefinition falls back to the full list. Otherwise (including a session that starts with no active tools, such as `tools.initial: []`): the current list at request level. |
| `openai-responses`, `openai-codex-responses`, `azure-openai-responses` | With the flag: a `developer` message (reasoning models that accept the developer role) or a `system` message, at its position. | Additions load in place while retained history contains only additions. Any removal or same-name redeclaration anywhere in retained history switches that request to the full current list at request level. |
| `openai-completions` | With the flag: a `developer` or `system` message at its position. | Additions load in place with `supportsMidConvoToolAdditions`; removals and redeclarations switch to the full current list. |
| `mistral-conversations` | With the flag: a `system` message at its position. | Always the full current list at request level. |
| Google Generative AI / Vertex | Always folded into `systemInstruction`; no mid-conversation path. | Full current list. |
| Bedrock Converse | Always folded into the request-level system prompt. | Full current tool configuration. |
| `pi-messages` | Passes the context to its backend unchanged; behavior depends on that backend. | Backend-defined. |

Updates are rendered as `Updated system prompt section "<name>": ...` or `Removed system prompt section "<name>".`. [Tool-only capabilities](capabilities.md#delivery-models-native-vs-fallback) send no text update.

## Flagged models in the 2026-09 catalog

Only models with `supportsMidConvoSystemMessages: true` are listed.

| Provider | Models | Tool changes |
|---|---|---|
| `anthropic` | `claude-fable-5`, `claude-fable-5-1`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5` | Native additions and removals |
| `openai-codex` | `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol` | Additions in place (`additional_tools`) |
| `openai-codex` | `gpt-5.5` | Additions in place via tool search |
| `opencode` | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-pro`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra` | Additions in place (`additional_tools`) |
| `opencode` | `claude-fable-5`, `claude-fable-5-1`, `claude-opus-4-8`, `claude-opus-5` | Text only; any tool change sends the full list |
| `opencode`, `opencode-go` | `kimi-k3` | Additions in place |
| `opencode-go` | `gpt-5.6-luna` | Additions in place (`additional_tools`) |
| `deepseek` | `deepseek-v4-pro` | Text only; any tool change sends the full list |

Not flagged in the same catalog, among others: `anthropic/claude-sonnet-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-opus-4-5` to `claude-opus-4-7`, `claude-haiku-4-5`; `openai-codex/gpt-5.3-codex-spark`; `deepseek/deepseek-flash`; every `google` and `kimi-coding` model.

## Observed cache behavior

These are single-session observations, not guarantees. Cache reuse is decided by the provider.

- **`anthropic/claude-opus-5-5`, native path (OAuth through an auth extension):** adding, removing, and re-adding tools, including a capability the model enabled itself, kept the full cached prefix on all 18 follow-up requests. Requests with lower hit rates were writing new content, such as new tool definitions or large file reads, not losing earlier cache.
- **`anthropic/claude-sonnet-5`, fallback path:** the request after a tool change read nothing from cache, because Pi rewrote the leading system prompt and tool list. The model also questioned the labeled user update before using the new tool.
- **OpenAI Responses / Codex:** in earlier tests, a removal switched to the full tool list and cache reads dropped to zero; requests with only additions kept the prefix.

To keep caches stable, prefer a flagged model with native tool changes. On Responses-family models, avoid removing tools in a session where cache reuse matters.

## Checking your own setup

1. Run `/capability status`. It reports `native system sections` or `attributed user updates` for the current model.
2. To see the flags directly, look up the model under its provider in `~/.pi/agent/models-store.json` and read its `compat` object.
3. Use `/forge payload next` to capture the actual next request if you need to confirm the wire format.
