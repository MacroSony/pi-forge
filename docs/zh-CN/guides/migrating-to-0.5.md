# 迁移到 pi-forge 0.5

[中文文档](../README.md) · [English](../../guides/migrating-to-0.5.md)

0.5.0 是一个破坏性的清理版本。本页是全部变更的迁移说明。

## 被移除的内容

- SillyTavern 导入器（`/preset import-silly`）及其报告、指南、示例和测试。升级前请先用 pi-forge 0.4 转换 SillyTavern preset。
- 可变 turn/session 变量、变量修改 macro、`pi-forge-variable-state` session 条目和 `variables` slot。
- 正则的 `display` 与 `both` 效果；保留 `outgoing` 和 `finalize`。
- 主包中的 subagent 执行功能（移至可选包，见下文 Lane 3/4）。

## 模板语法变更

Prompt 文本现在使用封闭的 `forge-v1` 语法编译。

| 0.4 写法 | 0.5 forge-v1 |
|---|---|
| `{{name}}`（静态） | `{{ parameters.name }}` |
| `{{lastUserMessage}}` | `{{ runtime.lastUserMessage }}` |
| `{{date}}` / `{{time}}` / `{{cwd}}` | `{{ runtime.date }}` / `{{ runtime.time }}` / `{{ runtime.cwd }}` |
| `{{tools}}` | `{{ runtime.selectedToolsText }}` |
| `{{upper::x}}` | `{{ x \| upper }}` |
| `{{iftools::bash::A::B}}` | `{% if runtime.tool.bash %}A{% else %}B{% endif %}` |
| 自定义 `{{myMacro}}` | `{{ extensions.myMacro }}` |

未知路径、未知 filter、解析错误、循环和输出超限都是编译错误；失败的块会被省略，而不是把原始模板文本重新注入。

## Schema v2

Schema v2 的 stack 把不可变静态值存入 `parameters`（JSON 兼容），取代旧的纯字符串 `variables` 字段：

```json
{
  "schemaVersion": 2,
  "parameters": { "char": "Konata" }
}
```

未标注版本 / v1 的 stack 仍通过旧的 `variables` 读取器加载。

## 运行迁移工具

一个以诊断为先的机械脚本可转换已保存的 stack 文件：

```bash
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --dry-run
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --write
```

它会把 `variables` 改名为 `parameters`、映射 runtime/parameter 路径并转换简单的 filter 管道。无法机械转换的写法会被报告；只有不存在这类写法时才会写入文件。仍含旧 `variables` 字段的 schema v2 文件不会被改动，仅给出警告。

## Lane 2：带 scope 的全局 profile 与 prompt stack

- 用户全局资源现在位于 `~/.pi/forge/prompt-stacks` 和 `~/.pi/forge/agent-profiles`，与项目存储并存。Profile 和 stack 选择器支持显式 scope：`project:<id>`、`global:<id>`，裸 ID 优先解析项目资源。
- 同 ID 的项目资源会遮蔽对应的全局资源；全局 stack 不能引用项目资源（反之亦然）——引用在被引用资源的 scope 内解析。
- 未信任的项目一律拒绝：只加载全局资源，所有变更路由被拒绝，并且当 session 可能仍活跃时 `session_shutdown` 不再销毁已信任的工作区（空闲工作区一小时后被清扫；host 独立停止）。
- Web 编辑器新增 scope 下拉，可向任一存储创建 stack/profile，并通过显式 `global:<id>` 路由执行全局变更。

## Lane 3：subagent 包拆分

Subagent 执行功能从主包移入可选包 `@zihanw/pi-forge-subagents`（要求 `@zihanw/pi-forge@^0.5.0`）。如需保留前台 delegation，请单独安装该包。

- **命令：** `/subagents` 和 `/subagent-run` 已从主包移除。可选包注册 `/forge-agent backends|plan|run`。
- **模型工具：** `forge_subagent_profiles` 和 `forge_subagent` 由可选包注册。
- **配置：** `subagents.*` 从 `.pi/forge/config.json` 移入专用的 `.pi/forge/subagents.json`（可信项目）和 `~/.pi/forge/subagents.json`（用户默认）。可选包会把旧的 `config.json.subagents` 段落作为只读回退读取并发出警告；它永远不会写入旧位置。把配置值复制到 `subagents.json` 即可消除警告。
- **Web 编辑器：** delegation 卡片已从主编辑器移除；请直接编辑 `subagents.json`。
- **架构：** 主包的 prompt 编译器不再携带 subagent 假设，`ForgeWorkspace` 是资源状态和编译上下文的唯一持有者。

## Lane 4：Forge 原生 host 契约与公开 surface

- 主包不再依赖 `@zihanw/pi-subagent-runtime`，也不再导出 0.4 执行契约。该契约（`AgentRequest`、`createAgentExecutionPlan`、`validateAgentRequest`、`negotiateSubagentTools`、preflight/plan/response 校验器等）现在位于 `@zihanw/pi-forge-subagents` 内部，供其自身 runtime 接线使用；两个包都不把它作为第三方可用的公开 surface。
- `@zihanw/pi-forge/subagent` 现在只导出带版本的 host port：wire DTO 与校验器、`ForgeHostTransport`、`ForgeHost`/`ForgeHostClient`、生命周期常量，以及 Forge 持有的规范指纹辅助函数。`resolveSubagentHostProfile` / `prepareSubagentHostPlan` 已被 host port 的 `resolveProfile` 和 `prepare` 操作取代。
- 包根只导出默认扩展工厂、`registerMacro`/`registerSlot` 及其契约类型。其余根导出（loader、agent-profile、profile-service、catalog、resource-identity、render-helper 值、`forge-v1` 引擎、registry 读取器）已全部移除。
- 所有 `@zihanw/pi-forge/src/*` 子路径别名和 `./examples/*` 导出均已移除；`check-package` 会拒绝它们。

### 导入迁移表

| 0.4 导入 | 0.5 替代 |
|---|---|
| `@zihanw/pi-forge`（默认导出、`registerMacro`、`registerSlot`） | 不变 |
| `@zihanw/pi-forge/subagent` host-port 名称（`ForgeHost*`、校验器、指纹） | 不变 |
| `@zihanw/pi-forge/subagent` 执行契约（`AgentRequest`、`createAgentExecutionPlan` 等） | 已内置于 `@zihanw/pi-forge-subagents`；无公开替代 |
| `@zihanw/pi-forge/subagent` 的 `resolveSubagentHostProfile` / `prepareSubagentHostPlan` | 通过 `ForgeHostClient` 使用 host-port 操作 |
| `@zihanw/pi-forge/src/*` 别名 | 已移除；无替代（内部实现） |
| 根部的 loader/profile/catalog/engine 再导出 | 已移除；无替代（内部实现） |

## 兼容性说明

- Host port 的 wire 结构在 `FORGE_HOST_PORT_VERSION = 1` 内只做增量扩展；未知操作会以普通的 `{ ok: false, error }` 结果拒绝（`"Unknown Forge host operation: …"`），而不是抛出异常。可选包必须把任何操作失败视为该请求的终态。
- 主包内置的指纹辅助函数由黄金向量锁定，与 `@zihanw/pi-subagent-runtime` 的规范序列化保持字节兼容；计划封存（plan sealing）仍只发生在可选包中。
