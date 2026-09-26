# 命令参考

[中文文档](../README.md) · [English](../../reference/commands.md)

方括号参数可选。主 pi-forge 命令会严格检查参数：未知 flag 和多余参数都会被拒绝。写入项目文件的命令要求项目已受信任。未限定的 `<id>` 使用项目优先查找；需要精确选择时使用 `project:<id>` 或 `global:<id>`。

## Forge 命令

`/forge` 是推荐的根命令。不带参数时显示 Forge 帮助；`/forge help` 也一样。

| 命令 | 行为 |
|---|---|
| `/forge ui [stop\|restart]` | 打开、停止或明确重启本地 Web 编辑器。 |
| `/forge payload next [save=<path> [--overwrite]]` | 捕获下一个 provider hook payload，显示并可选保存。路径含空格时要加引号，例如 `save="path with spaces.json"`。 |
| `/forge payload status` | 显示是否有待处理捕获，以及是否已有最近捕获。 |
| `/forge payload cancel` | 只取消待处理的下一次捕获；不会删除或重置已保留的捕获或 context-diff 历史。 |
| `/forge payload help` | 显示 payload 语法和捕获边界。 |
| `/forge subagent ...` | 由匹配的 `@zihanw/pi-forge-subagents` 可选包提供的子命令。重复贡献者会 fail closed。 |

`/forge payload` 和裸 `/payload` 都会布置下一次捕获。`/intercept` 仍是同一“捕获但不保存”行为的兼容快捷方式。只有在 `save=<path>` 中显式提供 `--overwrite` 才会覆盖已有文件；布置捕获本身不会调用模型。捕获发生在 `before_provider_request`，所以后续插件改写可能使最终 wire body 不同。即使脱敏了类似 credential 的字段，保存内容仍可能包含 prompt 和对话文本。

旧的 `/subagent` 命令是独立的底层 smoke helper，不是 `/forge subagent` 的执行计划命令。

## Prompt preset

| 命令 | 行为 |
|---|---|
| `/preset list` | 列出 preset 以及启用／校验状态。 |
| `/preset status` | 显示选中的 preset 和诊断摘要。 |
| `/preset use <id>` | 校验并选择 preset。 |
| `/preset use none` | 在当前 session branch 禁用 preset；也接受 `off`。 |
| `/preset preview [id]` | 编译并显示 preset，不发送 provider 请求；省略时使用选中的 preset。 |
| `/preset validate [id]` | 省略参数时校验当前选中的 preset；指定参数时只校验该 preset，默认不会校验全部 preset。 |
| `/preset diagnostics` | 显示 loader、runtime、policy、regex 和可信 extension 诊断。 |
| `/preset reload` | 重新加载 preset 及可信 macro/slot registration。 |
| `/preset ui [stop\|restart]` | 本地 Web 编辑器的兼容入口；推荐使用 `/forge ui`。 |
| `/preset help` | 显示 preset 命令帮助。 |

## 存储迁移

| 命令 | 行为 |
|---|---|
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | 将旧 `.pi/prompt-stacks` 文件复制到 `.pi/forge/prompt-stacks`。 |

覆盖或删除前请先使用 `--dry-run`。

## Agent profile

| 命令 | 行为 |
|---|---|
| `/profile list` | 列出 project profile 和解析诊断。 |
| `/profile use <id>` | preflight 并一次性应用 profile。 |
| `/profile save <id\|global:id> [--overwrite]` | 捕获当前模型、thinking 和 preset。 |
| `/profile status` | 比较当前 runtime 与 last-applied provenance。 |
| `/profile preview <id>` | 不应用地解析 model/auth/thinking/preset/tools。 |
| `/profile validate [id]` | 省略参数时校验全部已加载 profile；指定参数时只校验该 profile。 |
| `/profile reload` | 重新加载定义但不应用。 |
| `/profile forget` | 删除 last-applied provenance，不改变 runtime。 |
| `/profile help` | 显示 profile 命令帮助。 |

## 指令模式

`/instruction` 用于管理会话指令模式。

| 命令 | 行为 |
|---|---|
| `/instruction add <text>` | 添加字面手动指令。 |
| `/instruction list` | 显式重新发现并列出指令模式库。 |
| `/instruction bindings` | 列出当前 preset 的绑定，包括人类专用绑定（`modelCallable: false`）。 |
| `/instruction use <[scope:]id>` | 启用未绑定的库模式。 |
| `/instruction use-bound <id>` | 启用当前 preset 的一个绑定。 |
| `/instruction off <activation-id>` | 停用一个活动项。 |
| `/instruction status` | 显示活动指令和生效工具。 |
| `/instruction reset` | 停用全部活动指令和手动指令。 |
| `/instruction help` | 显示用法和兼容性说明。 |

补全使用当前 session 与最近发布的 workspace snapshot，不会在每次按键时扫描资源。需要显式刷新发现时使用 `/instruction list`。`bindings` 仍显示人类专用绑定；`modelCallable: false` 只禁止 Agent 控制，不会把它从人类列表中过滤掉。

## 可选前台委派

以下命令由匹配的可选包 `@zihanw/pi-forge-subagents` 提供，不属于主 pi-forge：

| 命令 | 行为 |
|---|---|
| `/forge-agent backends` | 列出已注册 backend、能力和有效默认值。 |
| `/forge-agent plan <profile> [--backend <id>] <task>` | 准备、显示并丢弃精确计划，不发送 provider 请求。 |
| `/forge-agent run <profile> [--backend <id>] <task>` | 准备前台运行，始终请求人类审批，然后通过所选 backend 执行。backend 可能写文件；它并非天然只读。 |

可选包只接受明确 scope 的 profile：在其 `subagents.json` 中使用 `project:<id>` 或 `global:<id>` key。模型工具对应为 `forge_subagent_profiles`（本地发现）和 `forge_subagent`（执行）。模型可调用的 `forge_subagent` 工具是另一条路径。它是否可无人值守由可信项目中的显式授权控制；不能用来绕过 `/forge-agent run` 必须审批的要求。见[委派安全说明](../guides/delegation.md)。
