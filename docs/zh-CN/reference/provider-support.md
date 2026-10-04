# 各服务商对会话中更新的支持情况（Pi 0.87.1 快照）

[中文文档](../README.md) · [English](../../reference/provider-support.md)

本页记录 Pi 0.87.1 在各 API 下如何发送会话中的 system 更新和工具变化，以及 Pi 模型目录中哪些模型带有相应标记。它解释了为什么同一个[能力](capabilities.md#投递模型native-与-fallback)在一个模型上以原生 system 更新送达，换到另一个模型却变成带标记的用户消息。

> **快照状态：** Pi 0.87.1（`@earendil-works/pi-ai` 0.87.1），本地模型目录最近检查于 2026-09-21 至 2026-09-25，记录于 2026-09-26。模型目录由 Pi 远程拉取并缓存在 `~/.pi/agent/models-store.json`，标记可能在不升级 Pi 的情况下变化。依赖下表之前，请先用 `/capability status` 确认当前模型走哪条路径。

## 如何决定

Pi 和 Forge 在每次请求时都读取当前模型的 `compat` 标记：

| 标记 | 为 `true` 时 | 缺失或为 `false` 时 |
|---|---|---|
| `supportsMidConvoSystemMessages` | 后续 system 消息保留在对话中的原位置；Forge 以原生 system 分段发送指令正文。 | Pi 把所有 system 消息折回首条 system 提示词，并在请求级别发送当前工具列表；Forge 以带标记的 `[pi-forge capability update]` 用户消息发送指令正文。 |
| `supportsMidConvoToolChanges`（Anthropic Messages） | 工具增删以 `tool_addition` / `tool_removal` 块放在 system 更新中发送。 | 在请求级别发送完整的当前工具列表。 |
| `supportsAdditionalTools` / `supportsToolSearch`（OpenAI Responses、Codex、Azure） | 新工具在原位置加载（`additional_tools`，或客户端 tool search 的调用与结果）。 | 在请求级别发送完整的当前工具列表。 |
| `supportsMidConvoToolAdditions`（OpenAI Completions） | 新工具由一条带 `tools` 的 system 消息在原位置加载。 | 在请求级别发送完整的当前工具列表。 |

工具相关标记只有在 `supportsMidConvoSystemMessages` 也启用时才生效。服务商名称、认证方式和认证扩展都不决定走哪条路径；同一个模型挂在不同服务商下，标记也可能不同。

## 各 API 的行为

| API | 指令正文 | 工具变化 |
|---|---|---|
| `anthropic-messages` | 有标记时为 `role: "system"` 消息。Pi 会把它留到下一条 assistant 消息之前再发，因此不会插在 `tool_use` 和对应的 `tool_result` 之间；记录在用户消息之前的更新，实际会发在该用户消息之后。 | 需要 `supportsMidConvoToolChanges` 且至少一个初始工具。**Pi 1.0.1 起：** 请求级工具列表固定不变（初始工具加一个保留的 deferred 占位工具）；之后的工具直接以完整定义写在 `tool_addition` 块里（同名重定义会替换旧定义），用 `tool_removal` 撤下。**Pi 1.0.0 及更早：** 之后的工具带 `defer_loading` 追加到请求级列表，列表只增不减，同名重定义会退回发送完整列表。其他情况（包括会话开始时没有任何活动工具，例如 `tools.initial: []`）在请求级别发送当前列表。 |
| `openai-responses`、`openai-codex-responses`、`azure-openai-responses` | 有标记时，在原位置发送 `developer` 消息（支持 developer 角色的推理模型）或 `system` 消息。 | 保留的历史中只有新增时，新工具在原位置加载；历史中任何位置出现过移除或同名重声明，这次请求就改为在请求级别发送完整的当前列表。 |
| `openai-completions` | 有标记时，在原位置发送 `developer` 或 `system` 消息。 | 有 `supportsMidConvoToolAdditions` 时新增在原位置加载；移除和重声明改为发送完整的当前列表。 |
| `mistral-conversations` | 有标记时，在原位置发送 `system` 消息。 | 始终在请求级别发送完整的当前列表。 |
| Google Generative AI / Vertex | 始终折入 `systemInstruction`，没有会话中路径。 | 完整的当前列表。 |
| Bedrock Converse | 始终折入请求级 system 提示词。 | 完整的当前工具配置。 |
| `pi-messages` | 原样把上下文交给后端，行为取决于该后端。 | 由后端决定。 |

更新正文渲染为 `Updated system prompt section "<name>": ...` 或 `Removed system prompt section "<name>".`。[纯工具能力](capabilities.md#投递模型native-与-fallback)不发送文字更新。

## 2026-09 目录中带标记的模型

只列出 `supportsMidConvoSystemMessages: true` 的模型。

| 服务商 | 模型 | 工具变化 |
|---|---|---|
| `anthropic` | `claude-fable-5`、`claude-fable-5-1`、`claude-opus-4-8`、`claude-opus-5`、`claude-opus-5-5` | 原生增删 |
| `openai-codex` | `gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol` | 新增在原位置加载（`additional_tools`） |
| `openai-codex` | `gpt-5.5` | 新增通过 tool search 在原位置加载 |
| `opencode` | `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.4-pro`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-astra` | 新增在原位置加载（`additional_tools`） |
| `opencode` | `claude-fable-5`、`claude-fable-5-1`、`claude-opus-4-8`、`claude-opus-5` | 仅正文；任何工具变化都发送完整列表 |
| `opencode`、`opencode-go` | `kimi-k3` | 新增在原位置加载 |
| `opencode-go` | `gpt-5.6-luna` | 新增在原位置加载（`additional_tools`） |
| `deepseek` | `deepseek-v4-pro` | 仅正文；任何工具变化都发送完整列表 |

同一目录中没有标记的模型包括：`anthropic/claude-sonnet-5`、`claude-sonnet-4-5`、`claude-sonnet-4-6`、`claude-opus-4-5` 至 `claude-opus-4-7`、`claude-haiku-4-5`；`openai-codex/gpt-5.3-codex-spark`；`deepseek/deepseek-flash`；以及所有 `google` 和 `kimi-coding` 模型。

## 实测缓存表现

以下是单个会话中的观察，不构成保证。缓存是否复用由服务商决定。

- **`anthropic/claude-opus-5-5`，原生路径（通过认证扩展使用 OAuth）：** 新增、移除、重新添加工具，包括模型自己启用的能力，18 次续轮请求全部完整复用了已缓存的前缀。命中率偏低的请求是在写入新内容，例如新的工具定义或大文件读取结果，并没有丢失之前的缓存。
- **`anthropic/claude-sonnet-5`，fallback 路径：** 工具变化后的那次请求没有读到任何缓存，因为 Pi 改写了首条 system 提示词和工具列表。模型还对带标记的用户更新产生了怀疑，确认后才使用新工具。
- **OpenAI Responses / Codex：** 之前的测试中，一次移除就改为发送完整工具列表，缓存读取降为 0；只有新增的请求保住了前缀。

想让缓存稳定，优先选用带原生工具变化标记的模型；在 Responses 系列模型上，如果在意缓存复用，尽量不要在同一会话中移除工具。

## 检查自己的环境

1. 运行 `/capability status`，它会显示当前模型使用 `native system sections` 还是 `attributed user updates`。
2. 如需直接查看标记，在 `~/.pi/agent/models-store.json` 中找到对应服务商下的模型，读取其 `compat` 对象。
3. 如需确认实际发送格式，用 `/forge payload next` 捕获下一次真实请求。
