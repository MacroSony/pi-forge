# 指令模式 (system-update)

[中文文档](../README.md) · [English](../../reference/instruction-modes.md)

Pi-forge 引入了指令模式（Instruction Modes）：会话级动态提示词指令与动态工具门控。本文档涵盖模式配置、CLI 操作、投递模型、状态恢复边界与兼容性限制。

## 环境要求与安装

- **宿主版本：** Pi `>= 0.86.0`。
- **项目信任：** 激活指令模式或添加手动指令需要项目处于受信任状态（`isProjectTrusted()`）。

指令模式为 JSON 文件，存放在以下目录之一：

- **项目目录：** `.pi/forge/instruction-modes/<id>.json`
- **全局目录：** `~/.pi/forge/instruction-modes/<id>.json`

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.instruction-mode",
  "id": "review",
  "name": "Review",
  "description": "Report findings and evidence before editing.",
  "content": "List findings, evidence, and risks. Do not directly edit files.",
  "tools": {
    "add": [],
    "remove": ["bash", "powershell", "write", "edit"]
  }
}
```

### 资源规则

- **纯字面内容：** `content` 严格按字面文本处理（上限 100,000 字符），非文件路径、脚本或宏，不会展开模板变量。
- **工具名称：** `add` 与 `remove` 数组中的工具名必须为确切标识符（上限 128 字符，无空白符、控制符或 `*`/`?` 通配符，每个数组限 256 个工具）。
- **解析与遮蔽：** 裸 ID 采用“项目优先于全局”的查找逻辑。若项目存在损坏或非法的 JSON，解析直接在本地报错（fail-closed），绝不静默回退到全局同名定义。可通过 `project:<id>` 或 `global:<id>` 指定明确 scope。

## 命令行操作

通过 `/system-update` 管理会话指令：

| 命令 | 行为 |
|---|---|
| `/system-update list` | 列出项目与全局库中可用的指令模式及其校验状态。 |
| `/system-update use <[scope:]id>` | 激活指定的指令模式（如 `/system-update use project:review` 或裸 ID）。 |
| `/system-update status` | 显示激活模式数量、投递表现形式、投递状态以及当前选中的工具。 |
| `/system-update off <activation-or-mode-id>` | 通过激活 UUID 或模式 ID 关闭激活的指令模式。 |
| `/system-update reset` | 关闭当前会话所有激活的指令模式与手动指令。 |
| `/system-update add <text>` | 向当前会话追加一条手动字面指令（无工具变更）。 |

**零推理成本：** 所有 `/system-update` 斜杠命令与 Web 活动面板操作均在本地执行，仅更新内部会话状态，操作本身不调用模型推理，不消耗付费 token（no inference）。但请注意：活动指令的规则正文仍会在随后的真实模型请求中占用输入 token。投递锚点使用同名投递类型（`pi-forge-instruction-delivery`）下的纯 `custom` 会话条目持久化，仅携带游标元数据（`schemaVersion: 1`, `throughEventId`），彻底取代先前的 `sendMessage` steering 与对话消息型 `custom_message` 载体。空闲时立即落锚；运行中的会话变更则安全推迟到当前工具调用批次全部完成后落锚，或在 `agent_end` 助手回复产生后提交，不额外向模型排入轮次。UI 状态通知（`ctx.ui.setStatus`）完全独立解耦。

## 检查规则更新的预览

现有 **Preview／预览** 按“选中的 Preset 草稿＋当前会话指令快照”试算，复用正常请求的纯预设／指令投影：显示原生 System 分段或带归属的 user 更新，包括停用通知和压缩检查点。投递标记为纯元数据锚点，不再作为对话消息或通用 custom_message 任务展示。命名分段和工具声明变化可读，不显示为空白 System 卡片。普通历史仍尊重插槽名称，例如插槽叫 `Delegated Task`，普通历史就仍用这个标签。

System 正文、原生命名分段与历史工具声明分开展示。代码区和分段复制只含正文／分段值，不把展示器生成的 `Added tool`、`Updated system prompt section` 当成原生 System 正文；fallback 用户更新本身包含的文字则原样保留。历史工具声明折叠显示，并明确标注**不是当前选择**。独立的“预览工具选择”采用草稿策略＋当前模式计算出的工具，而非旧转录声明。文本估算不含工具 schema 和检查器标签；只有结构化变更的消息仍可检查，投影后真正空掉的 System 卡片隐藏。空的非 System 消息以及真实正文中的同名短语不删除。草稿差异仍能检测无正文变化的结构化字段／工具选择变更。历史只按连续段分组：中途插入的指令更新保持在前后消息之间，不移到全部历史末尾。

切换模式后刷新预览即可检查新投影。它不是最终 provider payload，也不是送达确认；读取／复制不会推理、改变工具或把 pending 标成 prepared。全文不再受原先消息布局 8,000 字符截断限制。修改源文件不替换活动快照。已有自然语言摘要（包括其中引用的旧通知）保持原样；这次修复不重写历史摘要，也不改变 Pi 的压缩切点。

## Web 会话指令面板

除了 `/system-update` 命令行外，Web 编辑器在顶部导航栏下方提供了可展开的**会话指令模式**（Session instructions）活动面板，用于直观查看与管理当前会话的指令状态。

### 面板功能与状态展示

- **活动模式列表：** 展示当前会话中处于活动状态的所有指令模式与手动指令。每个卡片呈现：
  - **标识与来源：** 激活 ID、显示名称以及解析来源（如 `project:review`、`global:review` 或 `manual`）。
  - **开启者：** 标明模式由用户（`user`）还是智能体（`agent`）启用。
  - **冻结正文快照：** 可折叠展开查看激活时捕获的规则字面内容（frozen snapshot）。
  - **工具补丁与生效工具：** 单项指令的工具增删补丁（`+add`、`-remove`）以及会话整体的最终生效工具列表（`effectiveTools`）。
- **投递与呈现状态：**
  - **投递状态：** 显示 `none`（尚无指令变更记录）、`pending`（等待下次请求生效）或 `prepared`（上下文已为本轮就绪）。面板特别注明：`prepared` 仅表示提示词上下文准备完毕，不代表模型实际遵从或确认送达。
  - **文本呈现：** 显示当前模型使用 `native` 原生系统消息切片还是 `user` 带来源标记的时间线更新。
- **会话操作：**
  - **单项关闭：** 点击**关闭**按钮，按 `activationId` 停用指定的指令项。
  - **确认重置：** 点击**重置全部**后提供二次确认按钮（**确认重置** / **取消**），防止误操作清空会话指令。

### 轮询策略、并发保护与安全机制

- **页面可见轮询与零推理开销：** Web 客户端仅在页面处于可见状态（`document.visibilityState === "visible"`）时每 3 秒发起一次 `GET /api/instructions` 轮询，并在窗口重新获焦（focus）或点击**刷新**按钮时请求。所有查询均为本地状态读取，不产生任何模型推理与 API token 开销。
- **错误与 409 冲突时不盲目重试：** 若请求失败、状态过期或服务端返回 `409 Conflict`，面板会将其标记为 stale（已过期）并提示手动重新核对，绝不盲目进行写操作自动重试。
- **项目信任要求：** 在 Web 端执行修改操作严格要求项目已受信任（`isProjectTrusted() === true`）。未受信任会话将收到 `403 Forbidden` 并禁用修改，用户仍可使用命令行（`/system-update reset`）进行恢复。
- **Guard 防旧页与服务生命周期保护：** 每次修改请求均携带由 `sessionId`、`leafId`、版本哈希 `revision` 以及运行时实例代数（`instanceId` / runtime generation）派生的 Guard。若会话、分支或运行时已被重置，请求将返回 `409 Conflict`，防止旧页面覆盖新状态；当指令服务卸载或不可用时，返回 `503 Service Unavailable`。

### 明确能力边界与非目标

- **会话活动面板，而非编辑器：** 该面板是当前 Session 活跃状态的观察与控制面板，**不是**指令模式库编辑器（不支持在磁盘上编写或保存 JSON 模式文件），**不是**源文件 diff 对比工具，**不是**每个工具选择的根因解释器（why-per-tool），也**不是** Preset 绑定界面。
- **不新增工具 schema 与缓存预警：** 模式仍使用 `add/remove`，面板不新增 `only` 或模式级 allow/deny 字段，也不提供工具 transport 或 prompt 缓存影响预警。
- **未实现特性：** Preset 的 `instructionModes` 配置绑定与供模型调用的 `forge_system_update` agent tool 在当前阶段仍未实现。

### 本地测试与宿主热加载

在本地开发测试场（已有本地 build 接线）中调试时注意：
- 宿主热加载需要用户在 Pi 宿主控制台中手动执行 `/reload`。
- 若在 reload 之前已有 Web 服务器在运行，还需在宿主中执行 `/preset ui restart`，并使用新生成的带 token URL 打开。老 Web 服务器的闭包绑定在旧宿主生命周期上，不会随宿主刷新自动新增路由。切勿假定全局 host 已自动切换。

## 生命周期与工具同步

- **请求边界生效：** 指令内容与工具策略在下一次向模型发起请求时统一生效。运行中的工具批次绝不会被中途终止。
- **快照语义：** 模式激活时捕获不可变快照。修改磁盘上的 JSON 文件不会引发活跃会话漂移；必须通过 `/system-update off <id>` 后接 `/system-update use <id>` 重新加载生效。
- **顶层预设策略优先：** 模式不能越权启用已被当前预设（Preset）deny 策略禁用的工具。多个模式并存时，工具移除（remove）在当前会话的活动模式之间优先。
- **工具基线恢复：** Forge 记录基线工具集以便在关闭模式后正确复原。对缺乏基线记录的旧会话，Forge 采取保守策略恢复，而非盲目授予所有已注册工具。

## 投递模型：Native 与 Fallback

Forge 在每次发起模型请求时通过两阶段拼装动态投影指令增量：

1. **编译前物化（Materialize）：** 扫描会话条目中的纯 `custom` 元数据锚点（`pi-forge-instruction-delivery`）。在请求上下文边界（`prepareInstructionMessages`）校验元数据，并严格按其在会话转录中的序数位置物化为内存中的瞬态标记，绝不在磁盘转录中伪造对话消息。
2. **规则投影（Project）：** 由 `projectInstructionMessages` 将物化后的增量转化为适配当前模型的呈现形式：
   - **Native 投递：** 当模型服务商声明支持会话中系统消息（`compat.supportsMidConvoSystemMessages === true`）时，增量以 `SystemMessage.sections`（以 `forge-instruction-<id>` 为 key）注入，关闭时发送 null patch。Native 投递完全依赖服务商 capability 标记，并非所有提供商都支持。
   - **Fallback 投递：** 对不支持原生系统更新的模型，增量以带来源标记的时间线用户消息（`[pi-forge instruction update]`）投递。Forge 绝不折叠或篡改首条 leading system prompt，不把用户/工具对话提升为系统权限。

## 状态恢复与验证边界

指令状态由追加式会话事件与投递游标（`throughEventId`）推导恢复：

- **纯元数据投递锚点：** 投递标记以同名类型（`pi-forge-instruction-delivery`）的纯 `custom` 会话条目持久化，仅包含 `{ schemaVersion: 1, throughEventId }` 游标元数据，不写入 `custom_message`，不使用 `sendMessage`。空闲变更立即落锚；运行中变更在工具批次完成后安全落锚；`agent_end` 在没有 Forge 上下文处理失败且批次完整时补齐未提交游标。UI 状态通知独立解耦，不向模型排入额外轮次。
- **SDK 离线验证：** 会话恢复、手动 compaction checkpoint 及分支切换（`session.navigateTree`）均已通过 SDK 本地测试套件离线验证。这验证了提示词拼装与工具门控逻辑，但不构成对远程模型实际遵从或服从程度的保证。
- **Compaction 与缓存：** 压缩断点（compaction checkpoint）位置保持不变（位于引导系统提示词之后、压缩摘要之前；上游 Pi 的元数据切分 bug 独立存在，当前尚未修复）。真实 SDK 压缩请求输入表征测试表明：新的控制元数据和仅请求内投影的规则**不会自动进入摘要输入**；选中摘要窗口内的真实用户、助手与 peer 对话不因这次修复被过滤，其中真实引用的规则文字仍保留。测试套件采用模拟假响应，仅用于验证请求组装与管线形状，不能等同于远程 LLM 实际语义压缩与遵从验收。
- **向后兼容与旧会话风险：** 系统兼容读取并恢复历史会话中既有的 `custom_message` 投递条目。但 Forge 不会主动迁移磁盘旧条目，也不会抹除或重写既有的历史压缩摘要。**重要警示：** 若在包含旧版 `custom_message` 载体的旧会话中触发压缩，这些旧载体仍可能被读入总结器而造成历史污染！
- **会话写盘时机：** 在仅输入斜杠命令的新会话中，在首个 assistant 回复产生前，Pi 可能尚未向磁盘写出 JSONL 会话条目。

## 兼容性与安全边界

- **前置扩展上下文改写：** Pi 允许 `context` hook 改写消息。当可见元数据锚点或未锚定事件需要定位时，Forge 要求输入与会话记录有唯一的有序对应，否则中止而非猜测。Pi 可能先保存排队的 custom 消息、但暂不放入工具续跑上下文：Forge 仅容许位置能唯一确定的 custom 消息缺省，忽略其重新生成的外层时间戳；保留传入对象，不擅自把缺省对话补回请求。前置改写因而可能与该定位方式冲突。需审查后调整冲突插件顺序或行为；简单后移不保证组合安全。通用插件、warming、自动 overflow 兼容性仍未全面验收。
- **系统提示词 Getter：** `ctx.getSystemPrompt()` 和 SDK 接口返回 Pi 的原始基础提示词，而非 Forge 编译后的完整请求。请使用 `/payload` 或 Run context diff 查看实际编译结果。Forge 不声称已同步 SDK getter。在生命周期 hook 中强行返回完整 `systemPrompt` 的第三方扩展会引发投影冲突，不被支持。
- **沙盒免责：** 指令模式不提供操作系统级沙盒或权限隔离。示例 `review.json` 移除了 `bash`、`powershell`、`write` 和 `edit`，但未封禁外部 MCP 工具或 subagent，不能视为真正沙盒。请根据具体运行环境配置相应的执行工具移除列表。

## 发布状态（0.5.5-core）

0.5.5 仍在分阶段实现中，尚未全量完成：

- 人工 CLI 切片（`/system-update`）、投影运行时、Web 会话指令活动面板以及正式的纯元数据锚点修复已实现。
- Preset `instructionModes` 字段、运行时权限检查、Agent 工具 `forge_system_update`（list/status/use/off）及完整模式库 Web 编辑界面尚未开发。
- CLI 人工激活的模式未绑定 Preset（Web 面板只能关闭或重置现有活动项），切换 Preset 时予以保留，但仍受新 Preset 顶层策略约束。完整演示视频与完整媒体尚未发布，版本号维持 0.5.4 直至发布筹备。
