# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

![pi-forge header](https://raw.githubusercontent.com/MacroSony/pi-forge/main/assets/pi-forge-header-concept-1.png)

**pi-forge** 让你自定义 Pi 的思考方式和行为。它提供用于 prompt/工具策略的 prompt stack（提示栈），也提供可一次性应用模型、思考等级和提示栈的 agent profile（agent 配置预设）。

可以把它理解为 AI agent 的角色卡。

## 能做什么

- **赋予 Pi 个性** — 把它变成创意写手、角色扮演搭档、严格的代码审查员，或任何你想要的风格。
- **一键切换模式** — 在"写代码"、"写小说"、"做翻译"之间用一条命令切换。
- **保存完整 agent 预设** — 捕获当前模型、思考等级和提示栈，以后一条命令一起应用。
- **控制 AI 看到什么** — 选择每个 prompt 中出现哪些工具、技能和项目上下文。
- **按栈限制工具和技能** — 为专注模式启用工具策略，并过滤技能可见性。
- **使用模板变量** — 定义 `{{char}}` / `{{user}}` 这样的静态值，并在 prompt 文本里使用 ST 风格的轮次/会话变量宏。
- **转换发出和最终消息文本** — 对选中的历史、最终编译 prompt 或已结束的 assistant 消息执行确定性 regex 替换。
- **导入 SillyTavern 预设** — 一条命令把 ST 角色预设迁移到 Pi。
- **调试 prompt** — 拦截并查看实际发给模型的内容。

## 快速上手

### 安装

```bash
pi install npm:@zihanw/pi-forge@0.4.0-beta.1
```

此 beta 会发布到 npm 的 `next` channel，不会替换稳定版 `latest`。当前源码要求 Node.js 22.19 或更高版本，并且必须使用 Pi 0.82.1 所采用的精确 `@earendil-works/pi-*` 0.82.1 package 版本。

> **Pi 版本兼容性：** 当前源码只以 Pi 0.82.1 为目标；不声明兼容更早或尚未验证的后续 Pi SDK 版本。已发布的 `0.4.0-beta.1` package 最初以 Pi 0.80.10 为目标，因此请使用明确标注支持 Pi 0.82.1 的 release，或自行 build 当前源码。安装或重新 build pi-forge 后请重启 Pi，确保 extension 与 host SDK 使用同一套接口。如果主 agent 可以正常使用 provider，但 subagent preparation 报告 `No API key found`，请先检查是否仍在运行旧的 pi-forge build，不要直接执行 `/login`：session/runtime API 不匹配会在 preparation 时丢失主 session 的认证信息，重新登录无法修复这个版本不匹配。

### 第一个 prompt stack

从 [examples/default-prompt-stack.json](examples/default-prompt-stack.json) 创建 `.pi/forge/prompt-stacks/default.json`。

默认示例参考了 `@earendil-works/pi-coding-agent/dist/core/system-prompt.js` 中 Pi 自己的 prompt builder，但把它拆成可移动的 pi-forge slot：角色、工具、guidelines、Pi 文档提示、append-system-prompt、项目上下文、技能、日期/cwd 和对话历史。

```bash
mkdir -p .pi/forge/prompt-stacks
$EDITOR .pi/forge/prompt-stacks/default.json
```

把示例 JSON 粘贴进去。如果你就在这个仓库里开发，也可以直接执行 `cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json`。

搞定。重启 Pi 或执行 `/preset reload`。如果当前没有选中其他栈，`default.json` 会自动启用；如果你之前执行过 `/preset use none` 或选择了别的栈，请执行 `/preset use default`。

### 可视化编辑器

不想手写 JSON？pi-forge 内置了 Web 编辑器：

```
/preset ui
```

拖拽、新建、编辑、校验、查看完整预览和捕获的 payload、用 tabs 管理变量/context/regex 规则、切换深色模式、通过原始 stack JSON 修复高级字段、导入、导出、fork、删除栈 —— 全在浏览器里完成。新栈会从默认 Pi prompt mirror 布局开始。已有 stack ID 不可在保存时修改；需要新 ID 时请使用 Fork，避免破坏 profile 引用或当前选择。Stack metadata 可以折叠，方便把当前编辑区留在屏幕内。Policy tab 会显示已注册工具和已加载 skills，并提供已选 pattern chips 和过滤输入，方便用精确名称编写 allow/deny 规则，同时保留通配符写法。

导入支持原生 pi-forge stack JSON，也支持 SillyTavern 预设 JSON。SillyTavern 预设会自动转换成 prompt stack；如果一个预设里有多个 `character_id` 配置，编辑器会询问要使用哪一个。

编辑器默认运行在一个可用的 `127.0.0.1` 端口，并带有会话 token，所以多个 Pi 实例可以同时打开各自的编辑器。如果 Pi 在 session navigation 或新会话后重新初始化扩展，同一项目中的 `/preset ui` 会复用已有编辑器 URL，不会遗留旧 server 后再开一个新端口；resources 和 preview 在生命周期刷新后仍可使用。写入需要项目被信任，且只会写入 prompt-stack 存储目录。新建的栈会写入 `.pi/forge/prompt-stacks`；旧的 `.pi/prompt-stacks` 栈仍然可读取和编辑。保存、导入、fork、删除成功后会重新加载到当前 Pi 会话。需要时可以用 `/preset ui restart` 或 `/preset ui stop`。

要把旧栈复制到新位置，执行 `/preset migrate-stacks`。加 `--dry-run` 可先预览，加 `--overwrite` 可覆盖目标文件，加 `--delete-legacy` 会在复制成功后删除旧文件。

如果想优先使用某个端口，可以创建 `.pi/forge/config.json`。如果该端口被占用，pi-forge 会回退到其他可用端口，并显示实际 URL：

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

### Agent profile

Agent profile 是保存在 `.pi/forge/agent-profiles` 下的项目级 JSON 文件。先正常配置 Pi，然后捕获当前模型、思考等级和 prompt stack，就能快速创建：

```text
/profile save reviewer
/profile use reviewer
```

Profile 只应用一次，不会持续接管 Pi 的模型或思考等级；之后的手动修改会一直保留，直到再次执行 `/profile use reviewer`。被选中的 prompt stack 仍会在激活期间持续执行严格工具策略。

也可以直接编写 profile：

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.agent-profile",
  "id": "reviewer",
  "name": "Reviewer",
  "description": "只审查代码，不做修改。",
  "autoActivate": true,
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinkingLevel": "high",
  "promptStack": "reviewer"
}
```

`autoActivate: true` 会在 Pi 启动全新 session 时一次性应用整个 profile。最多只能有一个 profile 请求自动应用。自动应用的 profile 优先于独立 prompt stack 的自动加载，即使它的 `promptStack` 为 `null` 也不会回退；如果没有 profile 请求自动应用，则继续使用现有的 `default.json`/`autoActivate` stack 规则。已恢复的 session branch 选择优先于这两种自动加载机制。

`promptStack` 可以为 `null`。Profile v1 不保存工具名或 skill 列表；引用的 prompt stack 是工具策略和模型可见 skill 过滤的唯一来源。校验会拒绝不支持的字段，避免悄悄保留无效的生成参数或 runner 配置。

`/profile preview <id>` 会解析模型、认证、思考等级支持、prompt stack 和最终工具集，但不会改变运行时。`/profile status` 显示上次应用的 profile 和当前 drift；profile provenance 会跟随 session branch 恢复用于状态显示，但 reload、resume、tree navigation 或 compaction 绝不会自动重新应用 profile。全新 session 的自动应用仍然是一次性的，因此之后的手动修改会被保留。

### 实验性前台 subagent

0.4 beta 可以把已有 profile 作为独立、干净、一次性的 Pi 子进程运行。无数据外发的 `forge_subagent_profiles` 工具让主 agent 查看当前已加载 profile 的 ID、名称、描述、声明的模型/思考等级/stack、当前解析状态和审批模式。用户没有指定 profile 时，主 agent 应先调用该工具，再调用 `forge_subagent`。限制严格的主 agent prompt stack 必须同时允许这两个工具名。用户也可以继续使用同一执行路径的命令：

```text
/forge-agent backends
/forge-agent plan reviewer 检查这个 API 设计是否正确。
/forge-agent run reviewer 检查这个 API 设计是否正确。
/forge-agent run reviewer --backend pi-rpc-readonly 检查这个 API 设计是否正确。
```

目前注册了两个实验性 backend：`pi-subprocess-readonly`（默认；在全新的 `pi --mode text --print` 子进程中执行）和 `pi-rpc-readonly`（在全新的 `pi --mode rpc` 进程中执行）。两者编译完全相同的密封 prompt，并执行相同的只读 shared-user 边界，仅进程协议不同。Backend 选择属于配置而不是 profile schema：在 `~/.pi/forge/config.json` 中设置 `subagents.backend` 作为用户级默认值，在受信任项目的 `.pi/forge/config.json` 中覆盖它，并可用 `--backend <id>` 或交互模式下 `forge_subagent` 的 `backend` 参数对单次运行再次覆盖。`/forge-agent backends` 会标记解析出的默认 backend，并在其未注册时给出警告。系统故意不提供 fallback：如果所选 backend 不可用，运行会在 provider transport 之前失败。无人值守的 `forge_subagent` 调用固定使用配置的默认 backend，并拒绝单次调用的覆盖参数。

前台运行默认采用 60 秒的 best-effort timeout。较慢的模型或较大的 review 可以通过 `subagents.timeoutMs` 将其设置为 1 秒至 1 小时。用户级配置对所有项目生效，受信任项目中的配置可以覆盖它；无效值会被忽略并产生警告。Profile discovery、backend 输出、dry plan 和 approval 详情都会显示最终 timeout。

```json
{
  "subagents": {
    "timeoutMs": 300000
  }
}
```

`plan` 会解析 profile 和 stack、编译实际将发送给 provider 的 prompt、校验不可变执行计划，然后丢弃它，不会联系 provider。`/forge-agent run` 和默认配置下的 `forge_subagent` 会先准备完全相同的精确计划，再显示审批界面。默认界面显示 agent 任务、profile/stack、provider、模型、思考等级、最终工具、工作目录、安全边界、payload 大小和执行 fingerprint。选择 **View full prompt** 可以在批准前查看完整 system prompt 和按顺序排列的 provider-bound messages；在查看器中的编辑不会生效。

如果要明确允许父 agent 无需逐次审批即可调用 `forge_subagent`，可以在受信任项目的 `.pi/forge/config.json` 中设置：

```json
{
  "subagents": {
    "allowAgentInvocationWithoutApproval": true
  }
}
```

此选项只影响模型可调用的 `forge_subagent` 工具；`/forge-agent run` 仍然需要交互审批。精确 preflight 和不可变计划校验仍会执行，tool result 也会记录 `trusted-project-config` 授权来源，但 provider transport 会在不向人类显示 prompt 的情况下开始。Profile discovery 会报告当前审批模式。未受信任项目会忽略该设置，格式错误的值会 fail closed。请把项目 config 当作授权文件：除非允许所有能调用 `forge_subagent` 的父 agent 无需再次询问就把编译后的 prompt 和可读文件内容发送给指定 provider，否则不要启用或提交此选项。

子 agent 从干净对话开始，不会自动继承主 agent 历史。它在前台运行，并使用 profile 指定的精确模型、思考等级和 prompt stack。候选工具只有 `read`、`grep`、`find` 和 `ls`，还会继续受到 stack 工具策略限制；不会加载 write/edit/shell 工具、skills、prompt templates、context files 或第三方 extensions。最终工具结果包含有界的模型可见报告和可展开的人类可见执行详情。保留的 transcript 会限制每个字符串的大小、删去类似 base64 的文本，并只保留 512 KiB 的滚动尾部，以便保留最终报告而不让 TUI 持有无界工具历史。内联图片数据会留在 child 内供所选视觉模型使用，但专用 report channel 会在任何内容进入主 session 前，把二进制 payload 替换成 MIME type 和编码体积元数据。

重要：首个 backend 是 **shared-user**，不是操作系统沙箱。只读是模型工具策略；子进程仍然拥有启动它的用户权限，因此可以读取该用户可读的绝对路径，把内容发送给所选 provider，并把文本保留在父级 tool-result details 中。Host timeout 和取消仅为 best effort。`/tree` 会从当前对话分支移除调用和结果，但被放弃的 entry 仍可能留在 Pi 的磁盘 session JSONL 中；要删除敏感的保留文本，需要删除相应 session 数据。`/tree` 也不能撤销 provider 请求、计费或外部副作用。默认工具集刻意不提供文件系统写入路径；bubblewrap 类沙箱和 staged write mode 留待后续实现。

## 使用场景

### 🎭 角色扮演 & 创意写作

让 Pi 扮演一个角色。在系统提示词中定义性格，用 user message 注入写作风格规则，用 `{{lastUserMessage}}` 在对话历史之后重新插入用户输入。

常用模式：
- 把长期角色规则放在 `system` block。
- 把 Pi 运行时上下文（工具、技能、项目）放在 `user` slot。
- 把 `chat-history` slot 设为跳过最新用户消息。
- 在最后加一个带 `{{lastUserMessage}}` 的 `user` block。

这样最新请求会更清晰，也不会重复出现。

如果想先从一个基线栈 fork 再改成角色，可以从 [examples/default-prompt-stack.json](examples/default-prompt-stack.json) 开始。

### 🧑‍💻 专注代码审查

创建一个 `reviewer.json` 栈，加入严格的审查规则，例如“优先检查正确性、回归风险、安全问题和缺失测试”。保留 `tools`、`project-context`、`variables` 和 `chat-history` slot，这样 Pi 仍然能检查仓库并看到你暴露的模板变量。

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

### 🧪 展示 pi-forge 特性的预设

- **Pi mirror** — 从 [examples/default-prompt-stack.json](examples/default-prompt-stack.json) 开始。它保留 Pi 的默认行为，同时把每个运行时区块变成可移动、可检查的 slot。
- **Focused reviewer** — 见 [examples/reviewer-prompt-stack.json](examples/reviewer-prompt-stack.json)。它禁用写文件工具，把旧聊天历史包裹成背景上下文，从 history 中移除最新用户消息，再用 `{{lastUserMessage}}` 作为明确的 review target 插入。
- **SillyTavern DM writer** — 见 [examples/sillytavern-dm-writer-prompt-stack.json](examples/sillytavern-dm-writer-prompt-stack.json)。它用 `{{char}}` / `{{user}}` 定义 Dungeon Master 角色，包裹旧冒险历史，把 `{{lastUserMessage}}` 作为当前玩家行动重新插入，并用 regex 清理 OOC 注释、暗骰标记、骰子写法和 `Player:` 前缀。

### 🔧 模板变量

定义稳定的 prompt 常量：

```json
"variables": {
  "char": "Konata",
  "user": "User"
}
```

在 prompt 文本里用 ST 风格宏做局部变量读写：

```
{{setvar::mood::focused}}
{{getvar::mood}}
{{setsessionvar::topic::compiler cleanup}}
```

需要长期保存的项目记忆请写入仓库文件，而不是 pi-forge prompt 变量。

### 📦 SillyTavern 迁移

把 ST 预设导入 Pi：

```
/preset import-silly ~/SillyTavern/presets/my-preset.json
```

pi-forge 会把预设转换为 prompt stack，并生成迁移报告，标明哪些已处理、哪些需要手动调整。

可安全表示的 SillyTavern `promptOnly` regex 脚本会作为 history 阶段规则转换成 pi-forge `regex.rules`，包括 full-match token 转换、trim strings、depth 字段和明确的 user/assistant placement。Display-only、prompt/display 混合、DOM/browser、CSS/HTML 美化、JavaScript、不支持的 placement 和无效 regex 脚本会保留为报告项，供手动检查。

### 🔍 Prompt 调试

查看实际发给模型的内容：

```
/payload next save=.pi/forge/payloads/last.json
```

或者打开 `/preset ui`，点击 **Arm payload**，发送下一条 Pi prompt，然后在浏览器里查看脱敏后的 provider payload。凭据形式的 token 字段仍会隐藏，而 `max_tokens`、`input_tokens`、`output_tokens` 等正常限制和计数字段会保留显示。

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
4. 将 stack 的工具策略应用到 Pi 当前 active tools，并过滤 pi-forge 渲染的 tool/skill slot。
5. 应用已启用的 `history` 和 `compiled` 阶段 outgoing regex 规则。
6. 可选地在 assistant 消息结束时应用破坏性的 `finalize` regex 规则。

### Slot 一览

| Slot | 插入的内容 |
|------|-----------|
| `chat-history` | 当前对话 |
| `tools` | 可用工具及其描述 |
| `tool-guidelines` | 工具使用指导 |
| `skills` | 已加载的 Pi 技能 |
| `project-context` | 项目指令和上下文文件 |
| `variables` | 静态/会话/轮次模板变量 |
| `date` / `cwd` / `date-cwd` | 当前日期、可选当前时间和工作目录 |
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

### 管理 agent profile

| 命令 | 作用 |
|------|------|
| `/profile list` | 显示项目 profile 和解析诊断 |
| `/profile use <id>` | 预检并一次性应用 profile |
| `/profile save <id> [--overwrite]` | 捕获当前模型、思考等级和 prompt stack |
| `/profile status` | 显示当前运行时、上次应用来源和 drift |
| `/profile preview <id>` | 不应用，只预览解析结果和最终工具 |
| `/profile validate [id]` | 校验一个 profile；省略 id 时校验全部 |
| `/profile reload` | 从磁盘重新加载 profile，但不应用 |
| `/profile forget` | 忘记上次应用来源，不改变运行时 |

### 实验性前台 subagent

| 命令 | 作用 |
|------|------|
| `/forge-agent backends` | 显示已注册的实验性 backend、能力和解析出的默认 backend |
| `/forge-agent plan <profile> [--backend <id>] <task>` | 不进行 provider transport，准备、校验、显示并丢弃精确执行计划 |
| `/forge-agent run <profile> [--backend <id>] <task>` | 审查精确计划并在批准后运行一个前台只读文本任务 |

模型可调用的工具包括用于本地元数据发现的 `forge_subagent_profiles`，以及用于执行的 `forge_subagent`。发现工具不需要审批，也不会请求 provider 或准备 subagent prompt。当前主 agent 工具策略必须允许执行工具；之后还必须存在交互式审批 UI，或者启用上文明确说明的受信任项目免审批选项，subagent 才可运行。

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

### 过滤和条件宏

宏支持嵌套，`::` 分隔符只会在当前宏深度拆分。

| 宏 | 展开为 |
|----|--------|
| `{{trim::value}}` | 去掉首尾空白后的 `value` |
| `{{upper::value}}` | 大写 `value` |
| `{{lower::value}}` | 小写 `value` |
| `{{json::value}}` | `value` 的 JSON 字符串字面量 |
| `{{xml::value}}` | XML 转义后的 `value` |
| `{{ifvar::name::then::else}}` | 变量存在时输出 `then`，否则输出 `else` |
| `{{ifeq::name::expected::then::else}}` | 变量等于 `expected` 时输出 `then`，否则输出 `else` |
| `{{iftools::tool::then::else}}` | 当前工具列表包含 `tool` 时输出 `then`，否则输出 `else` |
| `{{ifslot::slot::then::else}}` | 启用的 stack 条目包含 `slot` 时输出 `then`，否则输出 `else` |

条件宏是 lazy 的：只有选中的分支会展开，所以被跳过的分支不会设置或清除变量。最后的 `else` 参数可省略，默认输出空文本。

### 可信自定义宏和 slot

自定义宏和 slot 由可信扩展代码注册，不把可执行代码写进 prompt-stack JSON。项目本地自定义代码放在 `.pi/forge/extensions/`。机器级个人自定义代码放在 `~/.pi/forge/extensions/`。pi-forge 会在项目受信任后、stack 校验前先加载全局模块，再加载项目本地模块；两个位置都会在 `/preset reload` 时重新加载。

这些模块会从 pi-forge 接收注册 API，所以不需要 import `@zihanw/pi-forge`，也不需要知道 pi-forge 安装在哪里。

```ts
// .pi/forge/extensions/ticket-context.ts
export default function register(api) {
  api.registerMacro({
    name: "ticketId",
    description: "从会话变量读取当前 ticket id。",
    render: (ctx) => ctx.variables.toMacroText(ctx.variables.get("ticket.id")),
  });

  api.registerSlot({
    name: "ticket-context",
    description: "渲染当前任务的 ticket 上下文。",
    options: {
      heading: { type: "string", default: "Ticket context" },
    },
    render: (ctx) => [
      String(ctx.options.heading ?? "Ticket context") + ":",
      "- Ticket: " + ctx.variables.toMacroText(ctx.variables.get("ticket.id")),
      "- Project: " + ctx.helpers.normalizePath(ctx.runtime.options.cwd),
    ].join("\n"),
  });
}
```

支持 `.ts`、`.js`、`.mjs`、`.cjs` 文件，也支持子目录里的 `index.*`。TypeScript 模块应使用 Node 运行时可直接 strip 的语法；如果需要更复杂的构建，使用 `.js` / `.mjs`。模块可以导出 `default function register(api)`，也可以导出具名 `register(api)`。注册的宏和 slot 名称必须在内置项、全局扩展、项目扩展之间唯一；重复名称会显示为扩展加载 warning。

API 包含 `cwd`、`forgeDir`、`extensionPath`、`helpers`、`registerMacro`、`registerSlot`、`getRegisteredMacros`、`getRegisteredSlots`。对全局模块来说，`forgeDir` 是 `~/.pi/forge`；对项目模块来说，它是 `<project>/.pi/forge`。

缺失的自定义 slot 会产生校验 warning，直到对应注册模块加载。内置宏和 slot 也使用同一个 registry，可用 `getRegisteredMacros()` 和 `getRegisteredSlots()` 作为实现参考。`/preset diagnostics` 会显示已加载的 pi-forge extension 文件和加载失败信息。

完整可复制的扩展和 stack 示例见 [examples/custom-system-status-extension](examples/custom-system-status-extension)。它通过 `.pi/forge/extensions/system-status.ts` 注册 `{{cpuLoad}}` 宏和 `machine-status` slot。

可复用的 Pi package 仍然可以从 `@zihanw/pi-forge` import `registerMacro` 和 `registerSlot`。`.pi/forge/extensions` 和 `~/.pi/forge/extensions` loader 主要用于不需要 package 样板的小型可信自定义逻辑。

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
  "includeLastUserMessage": false,
  "stripAssistantThinking": true,
  "includeSummaries": true,
  "toolMode": "keep",
  "roles": ["user", "assistant"],
  "maxMessages": 40,
  "maxChars": 20000
}
```

当你在 history 之后使用 `{{lastUserMessage}}` 时设为 `false`，避免用户消息出现两次。

把 `stripAssistantThinking` 设为 `true` 可以从插入的历史中移除之前 assistant 的 thinking block。可见 assistant 文本、tool call 和 tool result 消息会保留。它只影响这个 slot 插入到模型输入里的 history，不会修改当前 agent loop 或已存储 transcript。

使用 `includeSummaries: false` 可以排除 Pi 的 branch/compaction summary 消息；`roles` 可以只保留指定消息角色；`toolMode: "drop"` 可以移除之前的 tool call/tool result history；`maxMessages` / `maxChars` 可以只保留最近 history。当过滤或截断可能拆散 tool-call pair 时，pi-forge 会移除悬空的 tool call/result，避免发送不一致的 tool history。

### Date slot 选项

在 `date` 或 `date-cwd` slot 上设置 `"includeTime": true`，会在当前日期后加入 `HH:MM:SS` 格式的当前时间。

### 结构化 slot 格式选项

结构化运行时 slot 默认使用 XML 风格包装。给 `tools`、`tool-guidelines`、`skills`、`project-context` 或 `variables` slot 添加 `"format": "plain"`，可输出更紧凑的换行分隔文本。

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

默认 Pi mirror 示例还会用到几个额外 slot 选项：

```json
{
  "slot": "tools",
  "options": {
    "format": "plain",
    "onlyWithSnippets": true
  }
}
```

`tools.onlyWithSnippets` 会像 Pi 默认 prompt 一样，只显示带 prompt snippet 的工具。`tool-guidelines.heading`、`tool-guidelines.includePiDefaultGuidelines` 和 `tool-guidelines.piStyle` 用来匹配 Pi 默认的 guidelines 标题和条目。`skills.requireReadTool` 会在 read 工具未启用时隐藏 skills，和 Pi 默认行为一致。

### 工具和技能策略

Prompt stack 可以用栈级 `allow` 或 `deny` 列表限制 active tools，并过滤模型可见的技能。模式默认精确匹配，也支持 `*` 通配符。

```json
{
  "tools": {
    "allow": ["read", "bash"]
  },
  "skills": {
    "deny": ["browser-danger"]
  }
}
```

对于工具，`allow` 只保留匹配的 active tools，`deny` 移除匹配的 active tools。对于技能，同样的 pattern 控制哪些技能保留在 pi-forge 渲染的 `skills` slot 中。同一个资源策略不能同时包含非空 `allow` 和 `deny` 列表；混用会产生 validation error。

工具策略会在栈激活期间通过 Pi 的 active tool list 强制执行。启动和 reload 时，pi-forge 会等其它扩展完成 `session_start` 工具配置，再记录 baseline 并应用 stack 策略；之后还会在用户输入和 turn 开始前重新应用策略。即使其它扩展稍后调用 `setActiveTools()`，tool-call guard 也会阻止模型执行策略之外的工具。外部扩展新增的工具会保留在可恢复 baseline 中，并在禁用 prompt stack 或切换到没有工具策略的 stack 时恢复。

技能策略会过滤 pi-forge `skills` slot 渲染出的技能。它不会禁用显式技能调用，也不是 capability 或安全边界。如果 stack 使用 `mode: "append"` 或 `"prepend"`，Pi base prompt 里可能已经包含未过滤的技能；需要控制模型可见的技能列表时请使用 `mode: "replace"`。

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

使用 `stage: "history"` 可以转换 `chat-history` slot 插入的消息。使用 `stage: "compiled"` 并可选配置 `targets: ["system"]`、`["messages"]` 或两者，可以转换最终编译后的 prompt。消息规则可以用 `roles`、`maxMessages`、`maxChars`、`minDepth` 和 `maxDepth` 限制范围，其中 depth `0` 是最新消息。Replacement 使用 JavaScript 语法（`$&` 表示完整匹配，`$1` 表示捕获组；`$0` 也作为完整匹配的别名，`$$` 转义字面 `$`）。`trimStrings` 会从展开后的 replacement match/capture 中移除字面量字符串，对应 SillyTavern 的 Trim Out 行为。支持的 regex flags 是 `g`、`i`、`m`、`s` 和 `u`。

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

SillyTavern 导入会把确定性的 prompt-only `{{match}}` / `$0` full-match replacement 转成 JavaScript `$&`（`$0` 和 `$&` 在 pi-forge 中都可以用），在 `source.sillytavern` 中保留原始 regex 元数据，并作为 history 阶段规则运行以保持 depth 相对 chat。display-only、browser、unsupported-placement 脚本保留为 report-only。Web 编辑器提供结构化 Regex 对话框来编辑这些规则字段，并会保留需要通过 raw JSON 编辑的高级未知字段。

### Variables slot 选项

```json
{
  "kind": "slot",
  "id": "variables",
  "enabled": true,
  "role": "user",
  "slot": "variables",
  "options": {
    "includeStatic": true,
    "includeSession": true,
    "includeTurn": false,
    "format": "xml"
  }
}
```

## 开发环境搭建

```bash
git clone https://github.com/MacroSony/pi-forge.git
cd pi-forge
npm install
npm run build
# .pi/settings.json 会加载 package 构建后的 dist/index.js
pi    # 启动 Pi，信任项目，必要时 /reload
```

npm package 会有意省略实际的 `src/` 文件，并在运行时加载编译后的 `dist/`。需要查看或修改 pi-forge 本身时，请 clone 或 fork 仓库，不要直接修改 `node_modules` 或生成的 `dist/`。仓库 clone 可以用 Git 保留改动，并包含开发依赖、测试以及 source-to-dist 一致性检查。

进行接近 release 的本地测试时，在 `.pi/settings.json` 中注册 clone 后的 package 目录；package manifest 会加载已跟踪的 `dist/index.js`：

```json
{
  "packages": ["../pi-forge"]
}
```

进行实时源码开发时，请移除上面的 pi-forge package entry，再通过 `.pi/settings.json` 直接加载 TypeScript extension：

```json
{
  "extensions": ["../pi-forge/src/index.ts"]
}
```

也可以用 `pi -e ../pi-forge/src/index.ts` 做一次性的源码级 smoke test。不要同时加载 package 和 source entry，否则 pi-forge 会初始化两次。修改 browser client 源码后还需要执行 `npm run build:client`，因为本地编辑器提供的是生成后的 browser bundle。

运行测试：

```bash
npm test
```

运行真实浏览器中的编辑器 smoke test（如果 Chrome 不在标准路径，请设置 `CHROME_PATH`）：

```bash
npm run test:browser
```

类型检查：

```bash
npm run typecheck
```

构建 package 输出：

```bash
npm run build
```

运行完整仓库验证，包括在临时目录中执行干净构建，并逐字节检查已跟踪的 `dist/` 是否与 `src/` 一致：

```bash
npm run verify
```

CI 会运行同一套验证。源代码变更影响生成输出时，请运行 `npm run build`，并将对应的 `dist/` 变更与源代码一起提交。

## License

MIT
