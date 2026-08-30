# 预设与堆栈

[中文文档](../README.md) · [English](../../concepts/prompt-stacks.md)

**Preset（预设）**是 Pi Forge 应用的完整声明式资源；其中由固定 **Block** 和动态 **Slot** 组成的有序 prompt 编排叫 **Stack（堆栈）**。同一份预设还会携带策略、Regex、参数和扩展引用。

> **0.5.3 兼容说明。** UI 使用“预设 → 堆栈”术语。这个补丁版本仍保留文件路径、JSON type、Profile 字段、API 路由和内部类型中的 `prompt-stack` / `promptStack` 拼写。

预设当前放在兼容路径 `.pi/forge/prompt-stacks/` 或用户全局 `~/.pi/forge/prompt-stacks/`。命令接受 `reviewer`、`project:reviewer` 和 `global:reviewer`；未限定 ID 优先解析项目预设，项目预设会遮蔽同 ID 全局预设。重复 ID 只在同一 scope 内算错误。

## 编译模型

每个用户轮次开始时，pi-forge 会：

1. 按 JSON 顺序排列启用的 block/slot。
2. 构建 system 内容，并使用 `replace`、`append` 或 `prepend` 模式。
3. 在可移动 `chat-history` 周围插入 user/assistant 消息。
4. 用 forge-v1 编译 `runtime.*` / `parameters.*` / `extensions.*` 模板。
5. 对 Pi 执行工具策略，并过滤 pi-forge 渲染的 skills。
6. 应用 history/compiled outgoing regex。`frequency: "request"` 的 outgoing 消息规则还会在 tool 结果后续请求上对 Pi 的完整自然上下文再次运行；默认 `"turn"` 保持仅在每轮首次请求运行。
7. 可选地在消息完成后应用破坏性的 finalize regex；`roles` 显式包含 `"toolResult"` 的 finalize 规则还会改写存储的 tool 结果消息。

## 常用历史布局

1. 长期 system 规则。
2. 工具和项目上下文。
3. `includeLastUserMessage: false` 的 `chat-history`。
4. 包含 `{{ runtime.lastUserMessage }}` 的最终 user block。

这样既保留旧上下文，又只在最后明确出现一次当前请求。History 还可以过滤 summary/role、去掉旧工具消息、移除 assistant thinking，并限制消息数或字符数。

堆栈还可以通过 `context.mergeConsecutiveRoles`（及可选的 `context.mergeSeparator`）把连续的同角色条目合并成一条消息；chat-history 输出和 custom 角色条目永远不会被合并。详见英文 [Preset schema](../../reference/stack-schema.md#context-options)。

## 策略边界

工具 `allow`/`deny` 会修改 Pi active tools，并在 tool call 时再次检查。具体的 `allow` 列表会从 Pi 的完整已注册工具目录中选择，因此可以启用预设激活前处于 inactive 状态的工具；`deny` 只从原 active baseline 中移除工具，`allow: ["*"]` 仍表示不限制且不会启用全部工具。Skill policy 只过滤 pi-forge 渲染给模型的列表；它不能阻止明确调用，也不是安全边界。若必须控制模型可见 skill 列表，请使用 `replace`，因为 Pi 的基础 prompt 可能已经在 `append`/`prepend` 内容之前列出 skills。

## Scope 与自动启用

- 只有显式设置 `"autoActivate": true` 的预设参与自动启用；文件名（包括 `default.json`）没有特殊作用。
- 项目预设优先于全局预设；项目 scope 存在候选时，即使项目候选无效或冲突也会 fail closed，不会回退到全局预设。
- 同 ID 项目预设会遮蔽全局预设，包括无效 shadow 或显式 opt-out。
- `/preset use none` 会记录 session branch 的 opt-out。
- Active Preset 选择会跟随 Pi session tree branch。
- 恢复的 branch 状态优先于新 session 自动启用。
- 自动启用的 Agent Profile 优先于独立预设 autoload。

完整字段见英文 [stack schema](../../reference/stack-schema.md)（schema v2 使用 `parameters`），模板语法见[参考](../../reference/macros-and-slots.md)。
