# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md) · [中文文档](docs/zh-CN/README.md)

![pi-forge header](https://raw.githubusercontent.com/MacroSony/pi-forge/main/assets/pi-forge-header-concept-1.png)

**pi-forge** 让你自定义 [Pi](https://github.com/badlogic/pi-mono) 的思考方式和行为。Prompt stack（提示栈）负责 prompt 组合和工具策略；agent profile（agent 配置预设）可以一次性应用模型、思考等级和提示栈。

可以把它理解为 AI agent 的角色卡和工作台。

## 主要能力

- 把 system prompt、聊天历史、工具、skills、项目上下文和运行时数据组合成可排序的 block 和 slot。
- 用一条命令切换编程、审查、写作、角色扮演和翻译模式。
- 保存并应用完整的模型/思考等级/提示栈预设。
- 按栈严格限制工具，并过滤模型可见的 skills。
- 使用静态、轮次和会话变量，以及支持嵌套的模板宏。
- 对发给模型的 prompt 或最终 assistant 消息执行确定性 regex 转换。
- 在本地 Web 编辑器中管理 stack/profile，并检查实际 provider payload。
- 用明确启用的 profile 运行实验性、需要审批的前台 subagent。

## 安装

pi-forge 需要 Node.js 22.19 或更高版本。

```bash
pi install npm:@zihanw/pi-forge
```

安装或更新后请重启 Pi。运行中的 Pi host 会向 extension 提供 SDK package；pi-forge 只在开发和测试中固定精确版本，以保证结果可复现，不会用 peer dependency 锁死 Pi 频繁发布的版本。兼容策略见[开发与兼容性](docs/development/setup.md#pi-compatibility)（英文）。

## 五分钟上手

### 1. 创建 prompt stack

从 [默认 Pi mirror](examples/default-prompt-stack.json) 创建 `.pi/forge/prompt-stacks/default.json`：

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json
```

如果你通过 npm 安装而不是 clone 仓库，请直接打开 `/preset ui` 新建 stack；编辑器使用相同的 Pi mirror 布局。

重启 Pi，或执行：

```text
/preset reload
/preset use default
```

没有其他 stack 或已恢复 session 选择优先时，`default.json` 会自动启用。

### 2. 打开可视化编辑器

```text
/preset ui
```

本地编辑器可以新建、fork、校验、预览、导入、导出和删除 prompt stack，并可在新建/fork/导入时明确选择写入项目或用户全局存储。Preview dock 提供带旧/新行号和行内高亮的 unified/split diff，可只看变化行或保留三行/全部上下文；Run diff 会把 chars/4 估算与 Pi 返回的真实 prompt/cache usage、cache hit rate 明确分开。切换到 **Agent profiles** 可以浏览项目与全局 profile、编辑和删除全局 profile（通过显式 `global:<id>` 路由）。写入操作要求项目已被信任。Delegation 配置由可选包 `@zihanw/pi-forge-subagents` 的 `subagents.json` 文件管理，不在编辑器中。

### 3. 保存 profile

先正常配置 Pi，然后捕获当前设置：

```text
/profile save reviewer
/profile use reviewer
```

Profile 只应用一次。之后手动修改模型或思考等级会被保留，直到再次应用 profile；当前 prompt stack 的工具策略则会在启用期间持续执行。

## 基本概念

Prompt stack 是一个有序 JSON 文档，包含：

| 类型 | 用途 |
|---|---|
| **Block** | 固定的 `system`、`user`、`assistant` 或隐藏 `custom` 文本 |
| **Slot** | 工具、skills、项目上下文、变量、日期/cwd、聊天历史等运行时内容 |

Stack 可以 `replace`、`append` 或 `prepend` Pi 的基础 system prompt。编译时，pi-forge 会展开宏、插入对话、执行工具策略、过滤自己渲染的 skill 列表，并应用已启用的 regex 规则。

Agent profile 是项目级或用户全局预设，引用精确 provider/model、思考等级和 prompt stack。它不会重复保存工具或 skill 策略；被引用的 stack 始终是唯一来源。项目 profile 和 stack 可以遮蔽同 ID 的全局资源；需要精确选择时使用 `project:<id>` 或 `global:<id>`。

> **命名说明。** `/preset` 命令族管理的是 prompt stack（提示词栈）。命令名反映 stack 文件的实际作用：一份文档同时携带上下文编排（blocks/slots）和随附的 tool/skill/regex 策略——更接近一份完整预设，而不是一段裸提示词。资源与命令命名将在未来版本统一（见 [roadmap](docs/development/roadmap.md)）；在那之前，"prompt stack／提示词栈"指文档本身，"preset／预设"指管理它的命令族。

推荐从这些示例开始：

- [默认 Pi mirror](examples/default-prompt-stack.json)：保留 Pi 默认行为，同时让所有区域都可移动。
- [最小 worker](examples/minimal-prompt-stack.json)：尽量接近 DeepSeek Harness Minimal 的模型可见表面——同一句 persona、聊天历史，以及仅 `bash` + `str_replace_editor`；配合可选的 [Pi 工具扩展](examples/deepseek-minimal-tools-extension/README.md) 可获得更接近的 shell/editor 语义。
- [Regex hack pack](examples/hack-prompt-stack.json)：针对两种示例 token 形态展示 request 频率的出站脱敏和 transcript finalize 清理；它不是完整的密钥扫描器。
- [自定义 system-status extension](examples/custom-system-status-extension/README.md)：注册可信 macro 和 slot。
- [Fake assistant 直接输出实验](examples/fake-assistant-direct-output-prompt-stack.json)：在聊天历史后追加普通 assistant 文本，测试模型特定的思考捷径；是否有效取决于 model/provider/endpoint，使用前必须做同条件 A/B。

## 常用命令

| 命令 | 用途 |
|---|---|
| `/preset ui [stop\|restart]` | 打开或管理 Web 编辑器 |
| `/preset list` | 列出 prompt stack |
| `/preset use <id\|none>` | 选择或禁用 stack |
| `/preset preview [id]` | 编译 stack，但不发送请求 |
| `/preset validate [id]` | 校验一个或全部 stack |
| `/preset diagnostics` | 查看运行时和 extension 诊断 |
| `/profile list` | 列出并 preflight profile |
| `/profile save <id> [--overwrite]` | 把当前运行时保存为 profile |
| `/profile use <id>` | preflight 后一次性应用 profile |
| `/profile status` | 查看上次应用 provenance 和当前 drift |
| `/payload next [save=<path>]` | 检查下一个经过脱敏的 provider payload |

完整列表见[命令参考](docs/zh-CN/reference/commands.md)。

## 实验性前台 delegation

可选包 `@zihanw/pi-forge-subagents` 在 pi-forge 的 `/subagent` host port 之上提供前台 delegation。模型通过 `forge_subagent_profiles` 发现可用 profile，再用 `forge_subagent` 调用；用户可以使用 `/forge-agent plan` 和 `/forge-agent run`。

此功能仍是**实验性功能**，profile 默认不能委派。请在可信项目的 `.pi/forge/subagents.json`（或可选包只读兼容的 `.pi/forge/config.json.subagents`）中逐个启用。除非项目明确授权无人值守的模型调用，否则执行前会显示与不可变计划绑定的审批界面。

> **安全边界：** 当前 backend 是 shared-user 进程，不是操作系统沙箱。“只读”只描述模型可见工具策略。Child 仍有启动用户的 OS 读取权限；可读内容可能发送给所选 provider，并保留在 Pi session 数据中。Timeout 和取消仅为 best effort，`/tree` 不能撤销 provider 请求、计费或外部影响。

启用前必须阅读[前台 delegation 与安全模型](docs/zh-CN/guides/delegation.md)。

## 文档导航

### 学习

- [快速上手](docs/zh-CN/getting-started.md)
- [Prompt stack 概念](docs/zh-CN/concepts/prompt-stacks.md)
- [Agent profile 概念](docs/zh-CN/concepts/agent-profiles.md)
- [Web 编辑器](docs/zh-CN/guides/web-editor.md)
- [前台 delegation](docs/zh-CN/guides/delegation.md)

### 参考

- [命令](docs/zh-CN/reference/commands.md)
- [英文 stack schema](docs/reference/stack-schema.md)
- [英文 macros 与 slots](docs/reference/macros-and-slots.md)
- [英文配置参考](docs/reference/configuration.md)

完整英文文档从 [docs/README.md](docs/README.md) 开始。

## 兼容性原则

- npm 安装不会要求用户跟随某个精确 Pi patch 版本。
- Release 会分别记录实际测试过的 Pi 最低版本和当前版本。
- 如果实验性 subagent 依赖的 host capability 不存在，它应在 provider transport 前明确报错并 fail closed。
- 普通 prompt stack 和 profile 使用不应因为可选 delegation backend 不兼容而失效。

## License

[MIT](LICENSE)
