# Prompt stack

[中文文档](../README.md) · [English](../../concepts/prompt-stacks.md)

Prompt stack 是一份有序、声明式的 prompt 与策略描述，由固定 **block** 和动态 **slot** 组成。

## 编译模型

每个用户轮次开始时，pi-forge 会：

1. 按 JSON 顺序排列启用的 block/slot。
2. 构建 system 内容，并使用 `replace`、`append` 或 `prepend` 模式。
3. 在可移动 `chat-history` 周围插入 user/assistant 消息。
4. 展开内置、变量和可信自定义宏。
5. 对 Pi 执行工具策略，并过滤 pi-forge 渲染的 skills。
6. 应用 history/compiled outgoing regex。
7. 可选地在消息完成后应用破坏性的 finalize regex。

## 常用历史布局

1. 长期 system 规则。
2. 工具和项目上下文。
3. `includeLastUserMessage: false` 的 `chat-history`。
4. 包含 `{{lastUserMessage}}` 的最终 user block。

这样既保留旧上下文，又只在最后明确出现一次当前请求。History 还可以过滤 summary/role、去掉旧工具消息、移除 assistant thinking，并限制消息数或字符数。

## 策略边界

工具 `allow`/`deny` 会修改 Pi active tools，并在 tool call 时再次检查。Skill policy 只过滤 pi-forge 渲染给模型的列表；它不能阻止明确调用，也不是安全边界。若必须控制模型可见 skill 列表，请使用 `replace`，因为 Pi 的基础 prompt 可能已经在 `append`/`prepend` 内容之前列出 skills。

## Session 行为

- `default.json` 默认自动启用。
- `/preset use none` 会记录 session branch 的 opt-out。
- Active stack 和 session variables 会跟随 Pi session tree branch。
- 恢复的 branch 状态优先于新 session 自动启用。
- 自动启用的 agent profile 优先于独立 stack autoload。

完整字段见英文 [stack schema](../../reference/stack-schema.md)，macro/slot 见[参考](../../reference/macros-and-slots.md)。
