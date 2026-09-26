# 会话缓存用量

[中文文档](../README.md) · [English](../../reference/session-cache.md)

目标版本：Forge 0.5.5（未发布）。嵌套用量契约为实验性，在首个生成者发布前可能调整。Forge 为当前活动会话分支汇总只读的提示词缓存（prompt-cache）用量指标。这些指标展示在 Web 编辑器的**当前会话**能力面板中，并包含在能力运行时的状态数据内。

## 只读架构

缓存统计数据完全由模型服务商已报告、且 Pi 已持久化在当前分支消息中的用量数据推导而来：

- **零副作用：** Forge 绝不为了用量统计发起模型推理、写入会话条目、修改提示词文本、插入 `cache_control` 断点或触发提示词预热（warming）。
- **复用现有轮询：** Web 客户端通过现有的页面可见性轮询（`GET /api/capability-state`）获取缓存指标，不增加任何额外轮询循环或网络定时器。
- **从根到叶的分支遍历：** 统计覆盖当前活动分支从根节点到当前叶节点的完整路径。
  - **主会话请求（main）：** 统计当前分支上带有非零持久化用量（`input + output + cacheRead + cacheWrite > 0`）的 `assistant` 消息。无用量报告的请求（如中止的操作或未返回用量数据的报错请求）予以忽略。
  - **最近一次有用量的请求：** 最近一条带非零用量的 assistant 消息；之后中止或未报告用量的请求不会替换它。
  - **本轮请求（turn）：** 统计当前分支最新一条 `user` 消息之后出现的 assistant 请求。本轮内多步工具调用的多次模型请求合并累计。
  - **会话范围（session）：** 聚合当前活动分支上所有合规请求，包括分支上仍然保留的压缩前历史对话。
- **边界与统计排除：**
  - 明确排除独立的 Pi 顶层 `usage` 事件、压缩记录（compaction）以及分支摘要（`branch_summary`）用量。
  - Pi 可以单独持久化预热用量；这里有意只统计对话请求，不计预热或摘要开销。
  - 本指标反映分支消息的提示词缓存效率，**不等于** Pi 的会话账单总额或全局账单统计。

## 缓存命中率计算公式与聚合语义

### 计算公式

提示词缓存命中率衡量提示词前缀复用效率：

```
cacheHitRate = cacheRead / (input + cacheRead + cacheWrite)
```

- `input`：归一化的未缓存输入 Token（遵循 `pi-ai` 的 `Usage` 规范）。
- `cacheRead`：从服务商提示词缓存中读取的 Token 数。
- `cacheWrite`：写入服务商提示词缓存断点的 Token 数。
- `output`：模型输出补全 Token 严格排除在命中率分母之外。
- **分母为空 / 零：** 当提示词 Token 总和（`input + cacheRead + cacheWrite`）为 0 时，命中率未定义，界面显示破折号（`—`）。

### 聚合规则

- **多模型混合：** 当同一轮或同一会话中运行不同模型时，整体命中率按 Token 绝对数值累加计算（缓存读取总数 / 提示词 Token 总数），**绝非**对各请求的命中百分比取算术平均值。
- **服务商报告差异：** 服务商返回的缓存计数为 0（`cacheRead: 0`, `cacheWrite: 0`）可能仅代表该服务商 API 不报告缓存统计，并不能作为服务商不支持缓存或未发生缓存的证据。

## 主会话与嵌套工具严格分离

用量严格划分为两个独立流：
1. **主会话模型（`main`）：** 当前分支上由主模型发起的直接请求。
2. **嵌套工具（`nested`）：** 内部发起模型调用的工具（如分身 subagent）所报告的用量。嵌套用量绝不混入 `main`。

在 Web 界面中：
- 主会话与嵌套工具在独立行中显示（**缓存命中**与**分身/嵌套工具**）。
- 浮层提示（tooltip）仅展示**已知**数据的合并总计，并始终注明缺失、无效及缓存未知的报告不计入，不代表完整账单。

## 实验性嵌套用量契约（`toolResult.details.forgeNestedUsage`）

内部调用模型的工具可在其工具结果的 `toolResult.details.forgeNestedUsage`（常量 `FORGE_NESTED_USAGE_KEY`）中上报聚合 Token 与缓存指标。

### 类型化导入

```ts
import {
  FORGE_NESTED_USAGE_KEY,
  parseForgeNestedUsage,
  type ForgeNestedUsage,
} from "@zihanw/pi-forge/subagent";
```

### JSON 载荷示例

```json
{
  "role": "toolResult",
  "toolCallId": "call_subagent_abc123",
  "content": [{ "type": "text", "text": "分身任务完成。" }],
  "details": {
    "forgeNestedUsage": {
      "schemaVersion": 1,
      "requests": 2,
      "input": 1500,
      "output": 420,
      "cacheRead": 3200,
      "cacheWrite": 0
    }
  }
}
```

### 契约规范与字段定义

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `schemaVersion` | `1` | 是 | 契约版本。必须为字面量数字 `1`。 |
| `requests` | `number` | 是 | 非负安全整数。工具调用期间内部发起的模型请求总数。仅当传入的所有 Token 计数均为 0 时，才允许为 `0`。 |
| `input` | `number` | 是 | 非负安全整数。归一化的未缓存输入 Token 数。 |
| `output` | `number` | 是 | 非负安全整数。生成的输出补全 Token 数。 |
| `cacheRead` | `number` | 可选 | 非负安全整数。从缓存读取的提示词 Token 数。必须与 `cacheWrite` 配对出现。 |
| `cacheWrite` | `number` | 可选 | 非负安全整数。写入缓存的提示词 Token 数。必须与 `cacheRead` 配对出现。 |

- **严格模式：** 不允许包含任何额外属性字段。
- **缓存字段配对规则：** `cacheRead` 与 `cacheWrite` 必须同时提供或同时省略。若生成者无法获知缓存数据，必须将两者同时省略。
- **单次调用聚合：** 最终工具结果必须针对该次工具调用提供单次聚合数据（包含其内部所有模型请求）。严禁分段进度快照或跨调用的重复累计终身总计。
- **递归汇总与去重职责：** 工具生成者自行负责多层嵌套子 agent 的去重与汇总。嵌套用量中绝对不能包含父级或主会话的 Token。
- **数据摄入与容错处理：**
  - **未知缓存数据：** 省略 `cacheRead`/`cacheWrite` 的合法记录从所有请求数及 Token 合计中排除，并在 `cacheUnknownCalls` 中计数提示（`N 次调用未报告缓存数据`）。
  - **格式无效记录：** 校验失败的载荷直接忽略，并在 `invalidCalls` 中计数提示（`N 条格式无效的报告已忽略`）。
  - **字段缺失：** 未提供 `forgeNestedUsage` 视作无嵌套用量，Forge 不做旧格式挖掘或文本日志爬取。

### 归属统计与 Pi 原生总计边界（重要）

- **仅供 Forge 归属展示：** `toolResult.details.forgeNestedUsage` 仅供 Forge 界面展示与用量归属统计，**绝不修改** Pi 内置的会话总计。
- **避免重复统计：** Pi 原生已支持 `toolResult.usage`。未来的生成者可在 `toolResult.usage` 填报底层用量供 Pi 计入总账，同时在 `toolResult.details.forgeNestedUsage` 填报供 Forge 缓存归属展示。Forge 汇总时不再累加顶层的 `toolResult.usage`，因而不会重复记账。
- **生态与运行时状态：** 运行时与 subagent 生成者接入留待后续更新。旧分身调用没有此字段时显示暂无数据，不回填历史。
