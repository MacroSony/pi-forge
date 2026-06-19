# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

**pi-forge** 让你自定义 Pi 的思考方式和行为。它提供 prompt stack（提示栈）：这些 JSON 文件可以替换、追加到或插入到 Pi 的默认系统提示词之前，并控制 AI 的性格、可见工具、对话历史布局和跨轮次状态。

可以把它理解为 AI agent 的角色卡。

## 能做什么

- **赋予 Pi 个性** — 把它变成创意写手、角色扮演搭档、严格的代码审查员，或任何你想要的风格。
- **一键切换模式** — 在"写代码"、"写小说"、"做翻译"之间用一条命令切换。
- **控制 AI 看到什么** — 选择每个 prompt 中出现哪些工具、技能和项目上下文。
- **跨轮次记忆** — 让 agent 跟踪进度、存储笔记、记住用户偏好。
- **转换发出和最终消息文本** — 对选中的历史、最终编译 prompt 或已结束的 assistant 消息执行确定性 regex 替换。
- **导入 SillyTavern 预设** — 一条命令把 ST 角色预设迁移到 Pi。
- **调试 prompt** — 拦截并查看实际发给模型的内容。

## 快速上手

### 安装

```bash
pi install npm:@zihanw/pi-forge
```

### 第一个 prompt stack

创建 `.pi/forge/prompt-stacks/default.json`：

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
      "id": "role",
      "name": "主要角色",
      "enabled": true,
      "role": "system",
      "content": "你是一个友好简洁的编程助手，回答时优先给出简短说明和代码示例。"
    },
    {
      "kind": "slot",
      "id": "tools",
      "name": "可用工具",
      "enabled": true,
      "role": "system",
      "slot": "tools"
    },
    {
      "kind": "slot",
      "id": "chat-history",
      "name": "对话历史",
      "enabled": true,
      "slot": "chat-history"
    }
  ]
}
```

搞定。重启 Pi 或执行 `/preset reload`。如果当前没有选中其他栈，`default.json` 会自动启用；如果你之前执行过 `/preset use none` 或选择了别的栈，请执行 `/preset use default`。

### 可视化编辑器

不想手写 JSON？pi-forge 内置了 Web 编辑器：

```
/preset ui
```

拖拽、编辑、校验、查看完整预览和捕获的 payload、管理变量/状态/context、切换深色模式、通过原始 stack JSON 修复高级字段、导入、导出、fork、删除栈 —— 全在浏览器里完成。

导入支持原生 pi-forge stack JSON，也支持 SillyTavern 预设 JSON。SillyTavern 预设会自动转换成 prompt stack；如果一个预设里有多个 `character_id` 配置，编辑器会询问要使用哪一个。

编辑器默认运行在一个可用的 `127.0.0.1` 端口，并带有会话 token，所以多个 Pi 实例可以同时打开各自的编辑器。写入需要项目被信任，且只会写入 prompt-stack 存储目录。新建的栈会写入 `.pi/forge/prompt-stacks`；旧的 `.pi/prompt-stacks` 栈仍然可读取和编辑。保存、导入、fork、删除成功后会重新加载到当前 Pi 会话。需要时可以用 `/preset ui restart` 或 `/preset ui stop`。

要把旧栈复制到新位置，执行 `/preset migrate-stacks`。加 `--dry-run` 可先预览，加 `--overwrite` 可覆盖目标文件，加 `--delete-legacy` 会在复制成功后删除旧文件。

如果想优先使用某个端口，可以创建 `.pi/forge/config.json`。如果该端口被占用，pi-forge 会回退到其他可用端口，并显示实际 URL：

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

## 使用场景

### 🎭 角色扮演 & 创意写作

让 Pi 扮演一个角色。在系统提示词中定义性格，用 user message 注入写作风格规则，用 `{{lastUserMessage}}` 在对话历史之后重新插入用户输入。

常用模式：
- 把长期角色规则放在 `system` block。
- 把 Pi 运行时上下文（工具、技能、项目）放在 `user` slot。
- 把 `chat-history` slot 设为跳过最新用户消息。
- 在最后加一个带 `{{lastUserMessage}}` 的 `user` block。

这样最新请求会更清晰，也不会重复出现。

可复制的起步示例见 [examples/default-prompt-stack.json](examples/default-prompt-stack.json)。

### 🧑‍💻 专注代码审查

创建一个 `reviewer.json` 栈，加入严格的审查规则，例如“优先检查正确性、回归风险、安全问题和缺失测试”。保留 `tools`、`project-context`、`variables` 和 `chat-history` slot，这样 Pi 仍然能检查仓库并记住审查状态。

如果你想保留 Pi 原本的编程行为，只额外加上更严格的审查视角，可以使用 `mode: "append"`。

### 🌐 翻译模式

创建一个小型 `translator.json` 栈，用一个 system block 指定语气和目标语言，再保留 `chat-history` 和 `{{lastUserMessage}}` 的布局。这样可以在双语润色、直译、产品本地化审查之间快速切换，而不影响默认助手。

### 🔀 多模式切换

为不同任务创建独立的栈：

```
.pi/forge/prompt-stacks/
  coder.json       # 严格编程助手
  writer.json      # 创意写作搭档
  translator.json  # 双语翻译
```

用 `/preset use coder`、`/preset use writer` 等命令切换。

### 🧠 跨轮次记忆

定义 agent 可读写的状态：

```json
"state": {
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "当前任务进度",
      "agentWritable": true
    }
  }
}
```

Agent 用 `forge_state_set` 更新状态。你也可以手动设置：

```
/state set user.preference "用 TypeScript，别用 JavaScript"
```

### 📦 SillyTavern 迁移

把 ST 预设导入 Pi：

```
/preset import-silly ~/SillyTavern/presets/my-preset.json
```

pi-forge 会把预设转换为 prompt stack，并生成迁移报告，标明哪些已处理、哪些需要手动调整。

### 🔍 Prompt 调试

查看实际发给模型的内容：

```
/payload next save=.pi/forge/payloads/last.json
```

或者不发送只预览编译结果：

```
/preset preview
```

## 工作原理

一个 prompt stack 是一个 JSON 文件，包含两种条目：

| 类型 | 作用 |
|------|------|
| **Block** | 在指定位置插入的静态文本（系统提示词、用户消息、助手消息） |
| **Slot** | 来自 Pi 运行时的动态内容 —— 工具、技能、对话历史、日期、项目上下文等 |

条目按顺序排列。当栈激活时，pi-forge 会：

1. 用你的 `system` 角色 block 和 slot 生成系统提示词，然后按照栈的 `mode` 应用。
2. 在对话历史周围插入 `user`/`assistant` 角色的 block 和 slot。
3. 展开 `{{宏}}`，如 `{{lastUserMessage}}`、`{{date}}` 和自定义变量。
4. 应用已启用的 `history` 和 `compiled` 阶段 outgoing regex 规则。
5. 可选地在 assistant 消息结束时应用破坏性的 `finalize` regex 规则。

### Slot 一览

| Slot | 插入的内容 |
|------|-----------|
| `chat-history` | 当前对话 |
| `tools` | 可用工具及其描述 |
| `tool-guidelines` | 工具使用指导 |
| `skills` | 已加载的 Pi 技能 |
| `project-context` | 项目指令和上下文文件 |
| `variables` | Agent 和用户状态（进度、偏好、笔记） |
| `date` / `cwd` / `date-cwd` | 当前日期和工作目录 |
| `active-model` | 当前使用的模型 |
| `append-system-prompt` | 用户追加的系统提示词 |
| `pi-docs` | Pi 文档指导 |

### 模式

- **replace**（默认）— 你的栈完全替换 Pi 的系统提示词。
- **append** — 你的栈追加在 Pi 默认系统提示词之后。
- **prepend** — 你的栈插入在 Pi 默认系统提示词之前。

## 常用命令

### 管理 prompt stack

| 命令 | 作用 |
|------|------|
| `/preset list` | 显示所有可用栈 |
| `/preset use <id>` | 激活一个栈 |
| `/preset use none` | 在当前会话中禁用 prompt stack |
| `/preset preview [id]` | 查看编译后的 prompt |
| `/preset validate [id]` | 检查栈是否有问题 |
| `/preset status` | 显示当前激活栈和诊断摘要 |
| `/preset diagnostics` | 显示运行时诊断 |
| `/preset reload` | 从磁盘重新加载栈 |
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | 将旧 `.pi/prompt-stacks` 文件复制到 `.pi/forge/prompt-stacks` |
| `/preset ui [stop\|restart]` | 打开、停止或重启 Web 编辑器 |

### 状态管理

| 命令 | 作用 |
|------|------|
| `/state list` | 显示所有会话状态 |
| `/state status` | 显示状态定义和当前值 |
| `/state set <name> <value>` | 设置状态变量 |
| `/state get <name>` | 读取状态变量 |
| `/state clear [name]` | 清除状态（全部或按名称） |
| `/preset vars ...` | 为旧栈保留的兼容变量命令 |

### 导入 & 调试

| 命令 | 作用 |
|------|------|
| `/preset import-silly <path>` | 导入 SillyTavern 预设 |
| `/intercept` | 显示下一条 provider payload |
| `/payload next [save=<path>]` | 显示并可保存下一条 payload |

## 常用宏

在 block 内容中使用这些宏来插入动态值：

| 宏 | 展开为 |
|----|--------|
| `{{lastUserMessage}}` | 用户最新消息 |
| `{{date}}` | 当前日期 (YYYY-MM-DD) |
| `{{time}}` | 当前时间 (HH:MM:SS) |
| `{{cwd}}` | 当前工作目录 |
| `{{tools}}` | 逗号分隔的工具名 |
| `{{selectedTools}}` | 所选工具名的别名 |
| `{{activeModel}}` | 当前模型 (provider/id) |
| `{{char}}` / `{{user}}` | 栈中定义的自定义变量 |

### 变量宏

```
{{setvar::name::value}}        设置轮次变量（每条消息清空）
{{setsessionvar::name::value}} 设置会话变量（持久化）
{{setvar::session::name::value}} 也可设置会话变量
{{getvar::name}}               读取变量（轮次 → 会话 → 静态）
{{getturnvar::name}}           只读取轮次变量
{{getsessionvar::name}}        只读取会话变量
{{clearvar::name}}             清除变量
{{clearturnvar::name}}         清除轮次变量
{{clearsessionvar::name}}      清除会话变量
```

## Stack 参考

### 完整条目类型

**Block：**

```json
{
  "kind": "block",
  "id": "unique-id",
  "name": "可读标签",
  "enabled": true,
  "role": "system",
  "content": "你的文本。用 {{宏}} 插入动态内容。"
}
```

有效角色：`system`、`user`、`assistant`、`custom`。

**Slot：**

```json
{
  "kind": "slot",
  "id": "unique-id",
  "name": "对话历史",
  "enabled": true,
  "role": "user",
  "slot": "chat-history",
  "options": {
    "includeLastUserMessage": false
  }
}
```

### Chat history 选项

```json
"options": {
  "includeLastUserMessage": false
}
```

当你在 history 之后使用 `{{lastUserMessage}}` 时设为 `false`，避免用户消息出现两次。

### 结构化 slot 格式选项

结构化运行时 slot 默认使用 XML 风格包装。给 `tools`、`tool-guidelines`、`skills`、`project-context` 或 `variables` slot 添加 `"format": "plain"`，可输出更紧凑的换行分隔文本。`variables` slot 还支持 `"format": "json"` 来输出 JSON 风格状态。

```json
{
  "kind": "slot",
  "id": "tools",
  "enabled": true,
  "role": "system",
  "slot": "tools",
  "options": {
    "format": "plain"
  }
}
```

### Regex 转换

Prompt stack 可以对发给模型的 prompt 文本执行确定性的 regex 替换，也可以选择清理已结束的 assistant 消息。Outgoing 规则支持 `history` 和 `compiled` 阶段。破坏性的最终消息清理使用 `stage: "compiled"`、`effect: "finalize"` 和 `messages` target。真正的 display-only streaming 转换和 provider-payload 重写还不会生效。

```json
"regex": {
  "schemaVersion": 1,
  "rules": [
    {
      "id": "trim-ooc",
      "enabled": true,
      "stage": "history",
      "effect": "outgoing",
      "pattern": "\\(OOC:[^)]+\\)",
      "flags": "gi",
      "replace": "",
      "roles": ["assistant"],
      "maxMessages": 20
    }
  ]
}
```

使用 `stage: "history"` 可以转换 `chat-history` slot 插入的消息。使用 `stage: "compiled"` 并可选配置 `targets: ["system"]`、`["messages"]` 或两者，可以转换最终编译后的 prompt。消息规则可以用 `roles`、`maxMessages` 和 `maxChars` 限制范围。支持的 regex flags 是 `g`、`i`、`m`、`s` 和 `u`。

要在 streaming 结束后清理一条 assistant 消息，使用 `effect: "finalize"`：

```json
{
  "id": "finalize-ooc",
  "enabled": true,
  "stage": "compiled",
  "effect": "finalize",
  "targets": ["messages"],
  "roles": ["assistant"],
  "pattern": "\\s*\\(OOC:[^)]+\\)",
  "flags": "gi",
  "replace": ""
}
```

警告：`finalize` 在 `message_end` 运行，TUI 可能已经显示过原始 streaming 输出。它会把清理后的 replacement message 交回 Pi，因此 transcript 中不会保留模型原始输出。

`effect: "outgoing"` 改变发给模型的输入。`effect: "finalize"` 改变已结束的 assistant transcript 内容。`effect: "display"` 和 `"both"` 会通过校验并产生 warning，但在真正的 display transforms 实现前运行时会忽略。

### Variables slot 选项

```json
{
  "kind": "slot",
  "id": "state",
  "enabled": true,
  "role": "user",
  "slot": "variables",
  "options": {
    "includeScopes": ["session"],
    "includeNamespaces": ["user.*", "agent.*"],
    "includeMetadata": true,
    "format": "xml",
    "maxValueChars": 1200
  }
}
```

### 状态定义

```json
"state": {
  "schemaVersion": 1,
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "当前任务进度",
      "agentWritable": true
    },
    "user.preference": {
      "type": "string",
      "scope": "session",
      "description": "用户在本会话中的偏好",
      "userWritable": true
    }
  }
}
```

支持的类型：`string`、`number`、`boolean`、`null`、`object`、`array`、`string[]`、`number[]`、`boolean[]`、`unknown`，以及 `string | null` 这样的联合类型。

## Agent 工具

pi-forge 注册了两个 AI agent 可以调用的工具：

### `forge_state_set`

批量更新持久状态。只有 `agent.*` 名称可写。用于跨轮次跟踪：

- 任务进度 (`agent.progress`)
- 待解决问题 (`agent.openQuestions`)
- 故事状态 (`agent.storyState`)
- 用户要求的笔记 (`agent.notes`)

### `forge_set_var`

设置单个字符串值的兼容性别名。推荐使用 `forge_state_set`。

## 开发环境搭建

```bash
git clone <repo>
cd pi-forge
# .pi/settings.json 已指向包根目录
pi    # 启动 Pi，信任项目，必要时 /reload
```

运行测试：

```bash
npm test
```

类型检查：

```bash
npm run typecheck
```

## License

MIT
