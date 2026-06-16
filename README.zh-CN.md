# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

用于提示栈和代理配置管理的 Pi 扩展包。当前第一个里程碑实现了基于文件的提示栈。

## 包设置

这个仓库是一个 Pi 包。`package.json` 通过 `pi.extensions` 暴露 `./src/index.ts` 作为扩展入口。

在这个 checkout 中做本地开发时，`.pi/settings.json` 指向包根目录：

```json
{
  "packages": [".."]
}
```

启动 Pi 后，信任当前项目；如有需要，使用 `/reload` 重新加载。

发布到你选择的 npm 包名后，可以这样安装：

```bash
pi install npm:@zihanw/pi-forge
```

## 提示栈

提示栈文件放在：

```txt
.pi/prompt-stacks/*.json
```

激活规则：

1. 如果恢复出的 `/preset use <id>` 选择仍然存在，并且该栈没有校验错误，则优先使用它。
2. 如果恢复出的是 `/preset use none`，则禁用提示栈替换。
3. 如果 `.pi/prompt-stacks/default.json` 存在，且该栈没有设置 `"autoActivate": false`，则自动激活它。
4. 否则，使用第一个设置了 `"autoActivate": true` 的提示栈。
5. `/preset use <id>` 会切换当前会话的提示栈，并持久化这个选择。
6. `/preset use none` 会禁用提示栈替换，并持久化这个选择。

当某个提示栈处于激活状态时，pi-forge 默认会替换 Pi 的默认 system prompt，并围绕一个可移动的 `chat-history` 插槽重建每条用户消息对应的第一次 provider request。工具结果后的后续回合会使用 Pi 的自然上下文，因此 post-history 指令不会在每次工具调用后反复追加。

## 命令

```txt
/preset list
/preset status
/preset use <id|none>
/preset preview [id]
/preset validate [id]
/preset diagnostics
/preset reload
/preset vars [set <name> <value>|get <name>|clear [name]]
/state [list|status|set <name> <value>|get <name>|clear [name]]
/preset import-silly <path> [character_id] [--dry-run] [--overwrite]
/intercept
/payload next [save=<path>]
```

## SillyTavern 预设导入

将 SillyTavern 预设 JSON 导入为 `.pi/prompt-stacks/<id>.json`，并把迁移报告写入 `.pi/forge/import-reports/<id>.md`：

```txt
/preset import-silly <path> [character_id] [--dry-run] [--overwrite]
```

默认情况下，如果目标栈文件或报告文件已经存在，导入会拒绝覆盖，除非用户在 UI 确认中同意。使用 `--dry-run` 可以只预览生成的 JSON 和报告而不写入文件；使用 `--overwrite` 可以允许替换已有文件。

如果一个预设包含多个 `prompt_order` 条目，请传入想使用的 `character_id`。导入出的提示栈会设置为 `autoActivate: false`；检查报告后，可用 `/preset use <id>` 激活。

## Payload 检查

`/intercept` 会在下一次 provider payload 发送前显示它。`/payload next [save=<path>]` 做同样的事，并且可以把脱敏和截断后的 payload 保存到文件。查看器或通知中会包含字符数和粗略 token 数。例如：

```txt
/payload next save=.pi/forge/payloads/last.json
```

## 代理工具

### forge_state_set

批量更新持久提示状态。只有以 `agent.` 开头的状态名允许由代理写入；用户状态和提示栈状态对代理只读。它适合跨回合状态跟踪，例如 roleplay 中的角色情绪、故事进度，或 coding 中的任务检查点、已发现事实。

当提示栈启用了 `variables` 插槽时，代理会看到渲染后的提示状态，并可用 `forge_state_set` 更新 `agent.*` 状态。没有这个插槽时，状态仍可用于宏替换，但代理不会看到结构化状态视图。

`forge_set_var` 保留为兼容性别名，用于设置一个字符串值。新提示栈应优先使用 `forge_state_set`。

## 提示栈格式

最小示例：

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.prompt-stack",
  "id": "default",
  "autoActivate": true,
  "mode": "replace",
  "items": [
    {
      "kind": "block",
      "id": "main-role",
      "enabled": true,
      "role": "system",
      "content": "You are a precise coding assistant."
    },
    {
      "kind": "slot",
      "id": "tools",
      "enabled": true,
      "role": "system",
      "slot": "tools"
    },
    {
      "kind": "block",
      "id": "history-open",
      "enabled": true,
      "role": "user",
      "content": "<conversation_context>"
    },
    {
      "kind": "slot",
      "id": "chat-history",
      "enabled": true,
      "slot": "chat-history"
    },
    {
      "kind": "block",
      "id": "history-close",
      "enabled": true,
      "role": "user",
      "content": "</conversation_context>"
    }
  ]
}
```

## 条目

### Blocks

静态文本：

```json
{
  "kind": "block",
  "id": "post-history-nudge",
  "enabled": true,
  "role": "user",
  "content": "Reason carefully about the latest request before answering."
}
```

### Slots

来自 Pi 运行时的动态内容：

```json
{
  "kind": "slot",
  "id": "skills",
  "enabled": true,
  "role": "system",
  "slot": "skills"
}
```

支持的插槽：

- `chat-history`：当前 Pi 会话中的对话上下文
- `tools`：已启用工具的名称和 prompt snippet
- `tool-guidelines`：已启用工具的使用指导
- `skills`：已加载的 Pi skills
- `project-context`：项目指令和上下文文件
- `append-system-prompt`：用户追加的 system prompt 文本
- `variables`：以结构化 XML 或 JSON 渲染的 static/session/turn 提示状态
- `date`
- `cwd`
- `date-cwd`
- `active-model`
- `pi-docs`

### Variables / State Slot

默认以结构化 XML 渲染提示状态：

```xml
<prompt_state>
  <static>
    <var name="char" type="string">Agent</var>
  </static>
  <session>
    <var name="agent.mood" type="string">happy</var>
    <var name="agent.progress" type="string">step 3</var>
  </session>
  <turn>
    <var name="recent" type="string">just happened</var>
  </turn>
</prompt_state>
```

选项：

```json
{
  "includeStatic": true,
  "includeSession": true,
  "includeTurn": true,
  "includeScopes": ["session"],
  "includeNamespaces": ["user.*", "agent.*"],
  "excludeNamespaces": ["agent.scratch.*"],
  "includeMetadata": true,
  "format": "xml",
  "maxValueChars": 1200
}
```

提供 `includeScopes` 时，它会覆盖较旧的 `includeStatic`、`includeSession`、`includeTurn` 布尔选项。命名空间过滤支持精确名称，也支持 `agent.*` 这样的通配前缀。

使用这个插槽可以让代理看到可变状态；代理也可以通过 `forge_state_set` 更新这些状态中的 `agent.*`。将 `"format": "json"` 设为 JSON 时，同一份状态 payload 会作为转义后的 JSON 放在 `<prompt_state>` 内。

## Roles

- `system` 条目会编译进替换后的 system prompt。
- `user` 条目会插入为临时 user message。
- `assistant` 条目会插入为临时 assistant message。
- `custom` 条目会插入为隐藏的 Pi custom message，并由 Pi 转换成 user context。

`chat-history` 会在它所在的位置展开为实时对话。默认情况下，只有第一个启用的 `chat-history` 插槽会被展开。

如果要从 chat history 插槽中省略最新的用户消息，可以这样写：

```json
{
  "kind": "slot",
  "id": "chat-history",
  "enabled": true,
  "slot": "chat-history",
  "options": {
    "includeLastUserMessage": false
  }
}
```

这对 SillyTavern 风格的提示栈很有用，因为它们常常会在 post-history 指令中重新插入 `{{lastUserMessage}}`。

如果确实想重复插入历史：

```json
{
  "context": {
    "allowDuplicateChatHistory": true
  }
}
```

## 宏

block content 中支持的宏：

- `{{cwd}}`
- `{{date}}`
- `{{time}}`
- `{{lastUserMessage}}`
- `{{selectedTools}}` / `{{tools}}`
- `{{activeModel}}`
- 来自提示栈 `variables` 对象的自定义变量，例如 `{{char}}`

### Variables / Prompt State

静态变量来自提示栈文件：

```json
"variables": {
  "char": "Assistant",
  "user": "USER"
}
```

提示栈中也可以声明 typed state definitions：

```json
"state": {
  "schemaVersion": 1,
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "Concise summary of current task progress",
      "agentWritable": true
    },
    "agent.openQuestions": {
      "type": "string[]",
      "scope": "session",
      "description": "Questions that may need user input",
      "agentWritable": true
    }
  }
}
```

支持的类型字符串刻意保持较小，并接近 TypeScript 写法：`string`、`number`、`boolean`、`null`、`object`、`array`、`string[]`、`number[]`、`boolean[]`、`unknown`，以及 `string | null` 这样的 union。

definition default 会在对应 scope 被包含时显示在 `variables` 插槽中。默认值不会初始化持久 session state，所以在用户、代理或宏写入该值之前，`/state get <name>` 仍可能显示 `(not set)`。

用户可以通过下面的命令设置 typed JSON-compatible session state：

```txt
/state set user.preference "concise answers"
/state set user.maxExamples 2
/state set user.flags ["brief","technical"]
```

`/preset vars set <name> <value>` 保留为旧的字符串专用命令。

可变 turn variables 会在每条用户消息开始时清空：

```txt
{{setvar::name::value}}
{{setturnvar::name::value}}
{{getvar::name}}
{{getturnvar::name}}
{{var::name}}
{{clearvar::name}}
```

可变 session state 会作为扩展状态持久化到 Pi 会话中，并从当前 session tree 分支恢复。当你用 Pi 的 tree 控件跳转到更早的消息时，pi-forge 会恢复该分支可到达的最新状态快照，因此状态会随对话历史回滚，而不会泄漏来自未来分支的状态。

```txt
{{setsessionvar::name::value}}
{{setvar::session::name::value}}
{{getsessionvar::name}}
{{getvar::name}}
{{clearsessionvar::name}}
{{clearvar::session::name}}
```

`{{getvar::name}}`、`{{var::name}}` 和 bare `{{name}}` 的查找顺序是：

1. turn variables
2. session state
3. static stack variables

`setvar` 宏输出空文本。非字符串状态值在宏替换时会被 JSON 字符串化。未知宏默认产生 warning，并保持原样。
