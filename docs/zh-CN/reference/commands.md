# 命令参考

[中文文档](../README.md) · [English](../../reference/commands.md)

方括号参数可选。写项目文件的命令要求项目已被信任。未限定的 `<id>` 使用项目优先的有效查找；需要精确选择时使用 `project:<id>` 或 `global:<id>`。

## Prompt stack

| 命令 | 行为 |
|---|---|
| `/preset list` | 列出 stack 和状态 |
| `/preset status` | 显示当前 stack 和诊断摘要 |
| `/preset use <id>` | 校验并选择 stack |
| `/preset use none` | 在当前 session branch 禁用 stack |
| `/preset preview [id]` | 编译但不发送 provider 请求 |
| `/preset validate [id]` | 校验一个或全部 stack |
| `/preset diagnostics` | 显示 loader、runtime、policy、regex 和 extension 诊断 |
| `/preset reload` | 重新加载 stack 和可信 macro/slot registration |
| `/preset ui [stop\|restart]` | 打开或管理 Web 编辑器 |

## 迁移与导入

| 命令 | 行为 |
|---|---|
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | 把旧 stack 复制到 `.pi/forge/prompt-stacks` |

覆盖或删除之前请先使用 `--dry-run`。

## Agent profile

| 命令 | 行为 |
|---|---|
| `/profile list` | 列出 profile 和解析诊断 |
| `/profile use <id>` | preflight 并一次性应用 |
| `/profile save <id\|global:id> [--overwrite]` | 捕获当前模型、thinking 和 stack；`global:<id>` 写入用户全局目录 |
| `/profile status` | 比较当前 runtime 和 last-applied provenance |
| `/profile preview <id>` | 不应用地解析模型/auth/thinking/stack/tools |
| `/profile validate [id]` | 校验一个或全部 profile |
| `/profile reload` | 重新加载定义，但不应用 |
| `/profile forget` | 删除 provenance，不改变 runtime |

## 实验性 delegation

以下命令由可选包 `@zihanw/pi-forge-subagents` 提供。

| 命令 | 行为 |
|---|---|
| `/forge-agent backends` | 列出 backend、capabilities 和默认值 |
| `/forge-agent plan <profile> [--backend <id>] <task>` | 准备、显示并丢弃计划，不联系 provider |
| `/forge-agent run <profile> [--backend <id>] <task>` | 审批并执行前台只读任务 |

只接受匹配 scope 明确授权的 profile：项目 `subagents.json` 授权 `project:<id>`，全局 `subagents.json` 授权 `global:<id>`；也可使用 `.pi/forge/config.json.subagents` 作为只读兼容来源。模型工具为 `forge_subagent_profiles` 和 `forge_subagent`。见[安全说明](../guides/delegation.md)。

## Payload

| 命令 | 行为 |
|---|---|
| `/intercept` | 显示下一个脱敏 provider payload |
| `/payload next [save=<path>]` | 显示并可选保存 payload，同时提供给 Web 编辑器 |

即使 credentials 字段被脱敏，保存的 payload 仍可能包含 prompt 和对话内容，请按敏感数据处理。
