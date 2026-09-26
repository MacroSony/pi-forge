# 能力（`/capability`）

[中文文档](../README.md) · [English](../../reference/capabilities.md)

Pi-forge 引入了能力（Capabilities）：会话级动态提示词指令与动态工具门控。`/capability` 是 CLI 命令名。本文档涵盖能力配置、所有权作用域、CLI 操作、Web 资源编辑、Preset 授权与 Agent 控制、投递模型、状态恢复边界与兼容性限制。

## 环境要求与安装

- **宿主版本：** Pi `>=0.87.0 <0.88.0`（仓库开发 SDK 固定为 `0.87.0`，peer 范围为 `>=0.87.0 <0.88.0`；最低 SDK 0.87 保持不变；不声称对 0.86 的双重运行时支持；当前开发树软件包版本仍为 0.5.4，目标发布为 0.5.5，版本号尚未调整）。
- **项目信任：** 激活能力、预设绑定或添加手动指令需要项目处于受信任状态（`isProjectTrusted()`）。
- **兼容性限制：** 包含 `tools.initial` 的配置需要新版 Forge 支持；旧版 Forge 会忽略 `initial`，因而配置不具备向下降级兼容性。

能力为 JSON 文件，存放在以下目录之一：

- **项目目录：** `.pi/forge/capabilities/<id>.json`
- **全局目录：** `~/.pi/forge/capabilities/<id>.json`

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.capability",
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
- **工具补丁约束：** 能力仅支持 `add` 与 `remove`；候选的 `only` 或能力级 allowlist 未实现。
- **解析与遮蔽：** 裸 ID 采用“项目优先于全局”的查找逻辑。若项目存在损坏或非法的 JSON，解析直接在本地报错（fail-closed），绝不静默回退到全局同名定义。可通过 `project:<id>` 或 `global:<id>` 指定明确 scope。

## 所有权作用域与生命周期

- **所有权划分：** 能力定义（capabilities）为可复用资源，归属于项目或全局库；绑定与授权归属于预设（Preset JSON 顶层的 `capabilities` 数组）；活跃状态与激活项严格归属于会话（Session）。
- **直接启用 vs 绑定启用：**
  - 通过 CLI 直接激活（`/capability enable <[scope:]id>`）或 Web 能力库直接启用，创建的是会话中的**未绑定**活动项。
  - 通过 CLI 绑定激活（`/capability enable-bound <id>`）或 Web 预设绑定启用，创建的是与当前 Preset 关联的**绑定**活动项。
- **不可变快照语义：** 激活时捕获不可变快照（包括内容、工具策略、内容指纹）。修改或删除磁盘上的 JSON 文件不会引发活跃会话漂移。
- **同 Preset 重载 vs 切换 Preset：** 重新加载同一 Preset 保持既有的冻结活动快照；切换 Preset 会自动停用（lifecycle 停用）旧 Preset 关联的绑定项，同时保留手动输入与未绑定的用户规则。
- **授权撤销行为：** 在 Preset 中撤销授权（将 `modelCallable` 设为 `false`）或删除绑定项，不会追溯抹除已激活的快照；用户通过 CLI（`/capability disable` 或 `/capability reset`）或 Web 面板停用是标准恢复路径。
- **用户与 Agent 所有权及去重：** 激活项记录归属主体（`user` 或 `agent`）。重复 `enable` 已激活的能力具备幂等性，绝不自动在用户与 Agent 之间转移所有权（takeover）。接管必须通过显式关闭后再重新启用。

## Preset 授权的 Agent 控制

Preset 的 `capabilities` 绑定支持智能体自主选择与启用能力：

- **模型工具注册：** `forge_capability` 以固定 schema 注册一次，可见性遵循普通可执行工具选择；注册本身不授予能力权限。调用要求存在活跃 Preset，enable/disable 还会重查具体绑定的当前授权。
- **显式授权机制：** 仅当活跃 Preset 中的绑定显式声明 `modelCallable: true` 时，Agent 才能调用；缺省默认为 `false`。
- **固定参数契约：** 仅接受 `{ action: "list" | "status" | "enable" | "disable", id?: string }`（ID 上限 128 字符）。
  - `list`：列出当前活跃 Preset 中具备调用资格的绑定能力；活动快照由 `status` 查看。
  - `status`：返回当前会话的激活数量、呈现形式、投递状态及生效工具列表。
  - `enable`：需要提供绑定的 `id`；仅可激活已授权且 `modelCallable: true` 的预设绑定能力。
  - `disable`：需要提供 `id`（绑定 ID 或激活 UUID）；仅可关闭归属于 `agent` 的激活项。
- **安全与权限边界：**
  - 每次调用均重新校验项目信任、活跃 Preset 状态、绑定标识、`modelCallable: true` 以及当前工具策略。
  - Agent 无法关闭用户启用的指令或手动指令。
  - Agent 无法执行 `reset` 操作，也无法添加任意提示词文本。
  - Agent 无法激活会移除 `forge_capability` 工具自身的能力。
  - 在运行时已注销、正在恢复或会话上下文不一致时，调用直接 fail-closed 报错。

Agent 的 list/status 回复不复制完整规则正文：list 提供作者填写的描述与效果，status 提供活动元数据，避免把仅请求内投影的规则再次塞进普通工具历史和后续摘要。人类 CLI/Web 仍可查看完整冻结正文；真实对话及作者填写的描述不会被过滤。

### Read-first Worker

一个最小配对示例：[预设](../../../examples/read-first-worker-prompt-stack.json)＋[Write tools 能力](../../../examples/capabilities/write-tools.json)。使用匹配的 0.5.5 开发版；旧发布版可能忽略 `tools.initial`。

1. 在可信的临时项目中，将预设复制为 `.pi/forge/prompt-stacks/read-first-worker.json`，能力复制为 `.pi/forge/capabilities/write-tools.json`。先检查是否已有同名文件，不覆盖自己的资源。仅导入预设不会顺带安装引用的能力。
2. 用已加载 Forge 的全新 Pi 会话，执行 `/preset reload`，再执行 `/preset use project:read-first-worker`。示例 `autoActivate: false`，绑定明确指向**项目作用域**；放到全局时，能力也须放全局并修改 `ref`。
3. 没有其他活动能力时，默认工具只有 `read`、`ls` 与 `forge_capability`；后者是能力管理工具，不是文件写入工具。模型可用 `{ "action": "list" }` 列出授权绑定，以 `{ "action": "enable", "id": "write-tools" }` 启用命令／编辑能力，再以 `{ "action": "disable", "id": "write-tools" }` 停用自己的激活项。
4. 在**当前会话**或 `/capability status` 观察：`read, ls, forge_capability` → 增加 `bash, edit` → 回到默认集。其他活动能力仍参与计算。若由人类启用，模型不能关闭该人类拥有的激活项，应从界面或 `/capability disable <activation-id>` 停用。

`allow` 是许可上限，`initial` 是默认集，`modelCallable: true` 明确允许模型选择该绑定，**不是每次启用都弹出人类审批**。若希望仅人类启用，将它改为 `false`。示例提示词要求任务结束后关闭，但这不是自动生命周期保证；Off 不撤销文件修改，也不终止运行中的工具。**Read-first 不是只读沙箱：** `bash` 能执行任意命令，而不只是写文件；这些配置不提供文件系统／进程隔离。为保持最小风格，替换提示词省略了 Pi 默认的项目上下文、技能和工具指导插槽；需要这些内容时请从默认 Pi mirror 改起。

## 命令行操作

通过 `/capability` 管理会话指令：

| 命令 | 行为 |
|---|---|
| `/capability list` | 显式重新发现能力库，并列出项目与全局能力及校验状态。 |
| `/capability bindings` | 列出当前活跃 Preset 的能力绑定，包括人类专用绑定。 |
| `/capability enable <[scope:]id>` | 激活指定的未绑定能力（裸 ID 或限定作用域）。直接 enable 保持未绑定。 |
| `/capability enable-bound <id>` | 按绑定 ID 激活当前 Preset 中已绑定的能力。 |
| `/capability status` | 显示激活能力数量、投递表现形式、投递状态以及当前选中的工具。 |
| `/capability disable <activation-or-capability-id>` | 通过激活 UUID 或能力 ID 关闭激活的能力。 |
| `/capability reset` | 关闭当前会话所有激活的能力与手动指令（仅限用户）。 |
| `/capability add <text>` | 向当前会话追加一条手动字面指令（无工具变更）。 |
| `/capability help` | 显示命令用法与兼容性说明。 |

补全使用当前 session 与最近发布的 workspace snapshot，不会在每次按键时扫描资源。需要显式刷新发现时使用 `/capability list`。`bindings` 仍显示人类专用绑定；`modelCallable: false` 只禁止 Agent 控制，不会把绑定从人类检查或启用列表中过滤掉。

**零推理成本：** 所有 `/capability` 斜杠命令与 Web 活动面板操作均在本地执行，仅更新内部会话状态并同步工具策略，操作本身不调用模型推理，不消耗付费 token。活动指令的规则正文仅在随后的真实模型请求中占用输入 token。

## Web 资源编辑

### 能力管理界面（Capabilities CRUD）

顶部导航栏的**能力**（Capabilities）页面提供项目与全局能力的完整生命周期管理。能力库 API 为 `GET /api/capabilities`，选择器与 effective 变体为 `/api/capabilities/<selector>` 和 `/api/capabilities/effective`：

- **浏览与审查：** 查看能力 ID、显示名称、描述、指令正文及工具变更（`+add`、`-remove`），并显示校验诊断。
- **新建：** 在明确的项目作用域（`.pi/forge/capabilities/`）或全局作用域（`~/.pi/forge/capabilities/`）下创建新能力。
- **编辑与保存：** 编辑显示名称、描述、指令正文与工具增删项。能力 ID 在保存时不可修改。
- **分组工具选择器：** 能力工具选择（`+add` / `-remove`）提供基于 SDK `sourceInfo`（Pi 内置工具、扩展包工具及顶层入口点）的分组选择器。选择器保存具体确切的工具名称（EXACT concrete tool names）：不持久化包引用，不自动安装依赖包，外部包新增的工具也不会自动加入。未激活但已注册的工具在选择器中可见；未加载的工具在当前会话不可用，但手动保存的引用不会被丢弃。
- **删除：** 支持在二次确认后删除磁盘上的能力 JSON 文件。
- **版本防脏写（`sourceRevision`）：** 保存与删除操作强制校验界面加载时的源文件哈希版本（`sourceRevision`）。并发修改导致版本过期时返回 `409 Conflict` 并完整保留本地编辑草稿。
- **资源安全与保存执行影响：** 保存能力仅更新能力库定义，绝不自动将其激活到活跃会话中。非法 JSON fail-closed 本地报错；符号链接目录与目标不可写入。

### Preset 能力绑定 tab

在 Preset 编辑器中，能力绑定现已独立为同级的“**能力绑定**”（`bindings`）tab；Preset 元数据面板不再包含绑定：

- **限定引用：** 必须使用限定作用域引用（`project:<id>` 或 `global:<id>`）。
- **绑定 ID 与元数据：** 在 Preset 内唯一定义的绑定标识符（上限 128 字符）。
- **Agent 授权：** 勾选 `modelCallable` 开关（默认关闭），允许智能体通过 `forge_capability` 自主调用。
- **折叠的高级选项：** 覆盖项与源定义/有效值对比预览默认折叠在高级选项（Advanced）中，保持主列表清爽。
- **有限覆盖（Finite Overrides）：**
  - **正文覆盖：** 可选*无（沿用源内容）*、*替换*（`content`）或*追加*（`appendContent`，以双换行追加）。
  - **工具覆盖：** `tools.add` 与 `tools.remove` 分别选择*继承*（省略字段）或*自定义覆盖*（字面工具列表，允许显式 `[]` 清空源定义该项），并使用集成分组工具选择器。
  - 不支持注入任意自定义字段、脚本或继承链。
- **源定义与有效值对比预览：** 左右对比分栏实时展示源定义的正文/工具与覆盖生效后的有效正文/工具，复用服务端与运行时完全一致的解析器（`resolveCapabilityBindings`）。
- **防脏写保护：** 当 Preset 包含或修改绑定时，保存请求强制校验磁盘源版本（`sourceRevision`），防止覆盖外部并发编辑或新增的绑定（409 Conflict）。
- **Preset 保存执行影响：** 保存未激活的 Preset 仅更新其定义，绝不会选中或激活它；**关键**：保存当前已激活的 Preset 会立即重载并同步其实时工具策略与能力授权，但不会替换已冻结的活动能力快照。

## Web 会话能力面板

Web 编辑器保留全局**会话能力**（Session capabilities）摘要，入口进入非模态的**当前会话**工作区：左侧能力／工具控制，右侧当前会话投影。预设编辑页仍保留独立的 Preview／Draft diff／Run diff；跨工作区保留未保存编辑和检查布局。

### 面板功能与状态展示

- **活动能力列表：** 展示当前会话处于活动状态的所有能力与手动指令。每个卡片呈现：
  - **标识与来源：** 激活 ID、显示名称以及解析来源（如 `project:review`、`global:review` 或 `manual`）。
  - **开启者：** 标明由用户（`user`）还是智能体（`agent`）启用。
  - **冻结正文快照：** 默认显示摘要，可展开查看激活时捕获的完整规则字面内容（frozen snapshot）。
  - **工具调整与生效工具：** 卡片明确区分配置的工具补丁与当前生效工具；本页面最近一次成功操作显示实际净增减，多个能力重叠时生效集可能不变。
- **投递与呈现状态：**
  - **投递状态：** 显示 `none`（无变更记录）、`pending`（等待下次请求生效）或 `prepared`（上下文已为本轮就绪）。面板特别注明：`prepared` 仅表示提示词上下文准备完毕，不代表模型实际遵从或确认送达。
  - **文本呈现：** 显示当前模型使用 `native` 原生系统消息分段还是 `user` 带标记的时间线更新。
- **会话操作：**
  - **单项停用：** 点击**停用**按钮，按 `activationId` 关闭指定项。
  - **确认重置：** 点击**重置全部**后提供二次确认按钮（**确认重置** / **取消**），防止误操作清空会话指令。
- **提示词缓存用量：** 当当前分支存在提示词缓存数据时，面板展示本轮及整场会话的提示词缓存命中率与请求次数，并在界面上严格区分主会话请求与嵌套工具调用。详见[会话缓存用量](session-cache.md)。

### 人类启用选择器（带守卫的预览与启用）

面板内置了人类专用的能力启用选择器：

- **会话投影（`GET /api/capability-state/preview`）：** 只读检查已启用的已保存预设及当前能力快照，编译前后核对 session／leaf／revision 及活动预设指纹。Preview 旁路元数据将真实投影更新块关联到 activation ID，不修改提示词消息。要求可信会话与已启用预设；缺失或过期明确报错，不准备请求、同步工具或证明提供商送达／缓存复用。
- **资源发现（`GET /api/capability-state/available`）：** 纯本地只读接口，返回当前会话状态及可用能力选项，清晰分为*能力库项（未绑定）*与*当前预设（已绑定）*。读取操作绝不修改工具策略或产生会话事件。
- **即时预选预览：** 在下拉框中选择能力后，立即展开预选卡片呈现：
  - 标签名称、ID、类别徽标（`能力库` 或 `预设绑定`）及正文指纹摘要（`#<hash>`）。
  - 工具差异预览（`+add`、`-remove` 或 `无工具变更`）。
  - 若该能力无法通过工具策略校验，显示异常警示条（Problem banner）。
  - 完整的字面规则内容预览。
- **Bodyguard 安全启用（`POST /api/capability-state/enable`）：**
  - 提交载荷包含 `{ guard: { sessionId, leafId, revision }, kind, id, fingerprint }`。
  - 服务端在执行前严格比对会话 Guard 与磁盘定义的最新内容指纹。
  - 若会话、分支、版本或源文件发生变更，服务端返回 `409 Conflict` 拒绝操作。
  - 绝不自动猜测或盲目重试。
  - 启用操作需要项目已受信任（`isProjectTrusted() === true`），未信任会话返回 `403 Forbidden`。

### 轮询策略、并发保护与安全机制

- **页面可见轮询与零推理开销：** 页面可见时每3秒静默读取 `GET /api/capability-state`，窗口获焦或主动刷新也会同步。能力目录只在进入工作区、主动刷新或相关操作后读取，不随每次轮询重载；无变化的后台检查不闪 loading 或禁用控件。会话投影由实际状态变化驱动，离开后忽略迟到回包。所有查询均为本地读取，不产生模型推理与 API token 开销。
- **错误与冲突时不盲目重试：** 遇到请求失败或 409 冲突时标记为 stale，需人工复核，不自动重试写操作。
- **项目信任要求：** 在 Web 端修改会话能力严格要求项目已受信任（`isProjectTrusted() === true`）。未受信任返回 `403 Forbidden`，命令行恢复通道保留。
- **Guard 防旧页与服务生命周期保护：** 每次修改均携带会话 Guard（`sessionId`、`leafId`、`revision`）。服务注销或不可用时返回 `503 Service Unavailable`。

### 本地测试与宿主热加载

在本地开发测试场（已有本地 build 接线）中调试时注意：
- 宿主热加载需要用户在 Pi 宿主控制台中手动执行 `/reload`。
- 若在 reload 之前已有 Web 服务器在运行，还需在宿主中执行 `/preset ui restart`，并使用新生成的带 token URL 打开。老 Web 服务器的闭包绑定在旧宿主生命周期上，不会随宿主刷新自动新增路由。切勿假定全局 host 已自动切换。

## 生命周期与工具同步

- **统一的 `context_with_system` 流水线：** 在 Pi 0.87 中，标准 `context` 生命周期 hook 默认排除 System 消息。Forge 将完整编译器、基础提示词替换与能力投影流水线全部移至 `context_with_system`，无需内部两阶段拆分。
- **使用 `buildSessionProjection` 规范投影：** 运行时、预览与锚点定位基于 Pi 0.87 的规范 `buildSessionProjection`（支持 `context_edit` 的 omission、replacement 与 `sourceEntry`），确保瞬态请求拼装准确反映轮次上下文编辑，同时保持磁盘上的原始会话历史完全不变。
- **保持 Leading System 在首位：** SDK 传入的 leading System 始终保持在首位，Forge 自身的前缀纯元数据锚点紧跟其后插入。
- **续跑与结算生命周期：** `agent_end` 仍是安全的落锚提交时机，但编译周期与 busy fence 仅在 `agent_settled` 时重置。这确保了由 `agent_before_settle` 发起的继续执行（continuation）不会丢失已编译的 Preset 状态。
- **立即工具同步 vs. 下次请求提示词生效：**
  - 可执行工具策略在能力激活时**立即同步**（`pi.setActiveTools()`），被策略禁用的工具在执行期立即被拦截。
  - 提示词文本与原生 System 分段或 fallback 用户更新在**下一次模型请求边界**生效。
  - 正在执行中的工具调用批次绝不会被中途终止。
- **顶层预设策略优先：** 能力不能越权启用已被当前预设 deny 策略禁用的工具。多个能力并存时，工具移除（remove）在当前会话的活动能力之间全局优先。
- **工具基线恢复：** 关闭能力后按预设默认工具与剩余能力重新计算；预设工具选择与能力叠加均不再生效时，恢复经过外部变更协调的会话基线。对缺乏记录的旧会话，Forge 采取保守策略恢复，而非盲目授予所有已注册工具。
- **Parent 生命周期与重入围栏：** 严格维护 `disposed` 标志、`lifecycleRevision` 计数器与 `sameContext` 会话校验，杜绝跨会话串号与注销后的非法重入。

## 检查规则更新的预览

现有 **Preview／预览** 按“选中的 Preset 草稿＋当前会话能力快照”试算：

- 复用正常请求的纯预设／能力投影：显示原生 System 分段或带归属的 user 更新，包括停用通知和压缩检查点。
- 投递标记为纯元数据锚点，不作为对话消息展示。
- System 正文、原生命名分段与历史工具声明分开展示。代码区和分段复制只含正文/分段值，不把检查器生成的 `Added tool` 等提示混入原生文本。
- 历史工具声明折叠显示，并明确标注不是当前选择。
- 预览工具选择采用草稿策略＋当前能力计算出的工具。
- 文本估算不含工具 schema 和检查器标签；投影后真正空掉的 System 卡片隐藏。
- 历史只按连续段分组：中途插入的能力更新保持在前后消息之间，不移到全部历史末尾。
- 纯只读检查：读取或复制预览内容不会发起推理、不会改变工具状态，也不会将 pending 标记为 prepared。全文不受原先消息布局 8,000 字符限制。

## 投递模型：Native 与 Fallback

Forge 在每次发起模型请求时通过两阶段拼装动态投影能力增量：

1. **编译前物化（Materialize）：** 扫描通过 `buildSessionProjection` 规范投影后的会话条目中的纯 `custom` 元数据锚点（`pi-forge-capability-delivery`）。在请求上下文边界（`prepareCapabilityMessages`）校验元数据，并严格按其在投影转录中的序数位置物化为内存中的瞬态标记，绝不在磁盘转录中伪造对话消息或修改原始历史。
2. **规则投影（Project）：** 由 `projectCapabilityMessages` 将物化后的增量转化为适配当前模型的呈现形式：
   - **Native 投递：** 当模型服务商声明支持会话中系统消息（`compat.supportsMidConvoSystemMessages === true`）时，增量以 `SystemMessage.sections`（以 `forge-capability-<id>` 为 key）注入，关闭时发送 null patch。Native 投递完全依赖服务商 capability 标记，并非所有提供商都支持。
   - **Fallback 投递：** 对不支持原生系统更新的模型，增量以带来源标记的时间线用户消息（`[pi-forge capability update]`）投递。Forge 绝不折叠或篡改首条 leading system prompt，不把用户/工具对话提升为系统权限。
   - **纯工具能力：** 正文为空或只有空白的能力在两条路径下都不发文字更新：启用时不发分段，停用时不发移除通知，compaction checkpoint 里也不包含它。只有工具变化进入请求，**当前会话**中也不提供“在上下文中定位”按钮。
   - **如何判断走哪条路径：** 每次请求都按 Pi 模型目录中当前模型的 `compat` 条目决定；该目录由 Pi 拉取并缓存在本地，可能随更新变化。服务商名称、认证方式或认证扩展都不决定这一点，同一服务商的不同型号也可能不同。例如 2026-09-26 在 Pi 0.87.1 下观察到的目录中，`anthropic/claude-opus-4-8`、`claude-opus-5`、`claude-opus-5-5` 带有该标记，`anthropic/claude-sonnet-5` 没有。用 `/model` 切换后，之后的请求随之改变投递方式。`/capability status` 和 Agent 的 `status` 动作会显示 `native system sections` 或 `attributed user updates`；测试原生更新或缓存行为前请先确认。各 API 的行为和 Pi 0.87.1 时带标记的模型见[服务商支持情况](provider-support.md)。
   - **Fallback 的附带影响：** 对未标记的模型，Pi 还会把它自己的工具变更声明折回首条 system 消息和顶层工具列表，因此工具变化会改写下一次请求的开头，这部分缓存前缀无法复用。部分模型可能把带标记的用户更新当作不可信文本，先质疑再使用新工具。

## 状态恢复与验证边界

能力状态由追加式会话事件与投递游标（`throughEventId`）推导恢复：

- **纯元数据投递锚点：** 投递标记以同名类型（`pi-forge-capability-delivery`）的纯 `custom` 会话条目持久化，仅包含 `{ schemaVersion: 1, throughEventId }` 游标元数据，不写入 `custom_message`，不使用 `sendMessage`。空闲变更立即落锚；运行中变更在工具批次完成后安全落锚；`agent_end` 在没有 Forge 上下文处理失败且批次完整时补齐未提交游标。UI 状态通知独立解耦，不向模型排入额外轮次。
- **SDK 离线验证：** 会话恢复、手动 compaction checkpoint 及分支切换（`session.navigateTree`）均已通过 SDK 本地测试套件离线验证。这验证了提示词拼装与工具门控逻辑，但不构成对远程模型实际遵从或服从程度的保证。
- **Compaction 与缓存：** 压缩断点（compaction checkpoint）位置保持不变（位于引导系统提示词之后、压缩摘要之前；上游 Pi 的元数据切分 bug 独立存在，当前尚未修复）。真实 SDK 压缩请求输入表征测试表明：新的控制元数据和仅请求内投影的规则**不会自动进入摘要输入**；选中摘要窗口内的真实用户、助手与 peer 对话不因这次修复被过滤，其中真实引用的规则文字仍保留。测试套件采用模拟假响应，仅用于验证请求组装与管线形状，不能等同于远程 LLM 实际语义压缩与遵从验收。
- **预发布破坏性边界：** 本次重命名不提供旧别名或旧读取器。使用旧指令模式键、Schema、目录或工具名的开发配置必须转换为新的能力名称；包含旧能力状态的会话不支持继续恢复该状态。Forge 不会改写旧 JSONL 或历史摘要；完成转换后请开启新会话，不要依赖部分恢复。
- **会话写盘时机：** 在仅输入斜杠命令的新会话中，在首个 assistant 回复产生前，Pi 可能尚未向磁盘写出 JSONL 会话条目。

## 兼容性与安全边界

- **要求上游 Pi 0.87：** 必须使用上游 Pi `>=0.87.0 <0.88.0`。不提供对 0.86 的双重运行时支持。之前在 `context` hook 中操作或读取完整 System 消息的第三方扩展必须迁移到 `context_with_system` 完整 hook。
- **`before_agent_start` 注入时机：** `before_agent_start` 阶段强制注入的 System 提示词在 Pi 执行流中仍然晚于 `context_with_system` 生效。
- **前置扩展上下文改写：** Pi 允许 hook 改写消息。当可见元数据锚点或未锚定事件需要定位时，Forge 要求输入与规范会话投影有唯一的有序对应，否则中止而非猜测（fail-closed）。Pi 可能先保存排队的 custom 消息、但暂不放入工具续跑上下文：Forge 仅容许位置能唯一确定的 custom 消息缺省，忽略其重新生成的外层时间戳；保留传入对象，不擅自把缺省对话补回请求。前置改写因而可能与该定位方式冲突；简单后移不保证组合安全。通用插件、warming、自动 overflow 兼容性仍未全面验收。
- **上游缺陷与协议限制：** 上游 Pi 元数据分块及语义截断缺陷（semantic-cut defect）未被修复，压缩检查点位置保持不变。旧会话和旧投递载体保持原样，不支持继续恢复能力状态；Forge 不会迁移旧 JSONL 或改写历史摘要。不支持也不承诺 OMP（Oh My Pi）。
- **系统提示词 Getter：** `ctx.getSystemPrompt()` 和 SDK 接口返回 Pi 的原始基础提示词，而非 Forge 编译后的完整请求。请使用 `/forge payload`（裸 `/payload` 仍兼容）或 Run context diff 查看实际编译结果。Forge 不声称已同步 SDK getter。在生命周期 hook 中强行返回完整 `systemPrompt` 的第三方扩展会引发投影冲突，不被支持。
- **Provider 托管与缓存保守预警：** 工具传输序列化与提示词前缀缓存命中由下游提供商完全托管。工具策略变更、提示词前缀波动及会话压缩均会破坏缓存边界。支持追加的 Codex 传输在保留历史没有移除/重复声明时可追加全新工具以保留请求前缀，但不保证命中；移除或同名再声明会回退到当前全量工具表；Anthropic 原生工具变化等各 API 行为见[服务商支持情况](provider-support.md)；pi-forge 提供保守的 Provider 托管与缓存预警，不提供权限绕过或缓存保障（不保证零 KV 缓存失效）。
- **沙盒免责：** 能力不提供操作系统级沙盒或权限隔离。示例 `review.json` 移除了 `bash`、`powershell`、`write` 和 `edit`，但未封禁外部 MCP 工具或 subagent，不能视为真正沙盒。请根据具体运行环境配置相应的执行工具移除列表。

## 交付状态（0.5.5-core）

0.5.5 核心功能源码已在所有规划的开发通道中全量交付：

- 能力基础编解码器、多范围解析、会话事件与不可变快照 Reducer。
- 人工 CLI 操作集（`/capability` add、list、bindings、enable、enable-bound、disable、status、reset）。
- 纯元数据锚点投影机制与编译前序数物化。
- Web 会话能力活动面板与带守卫的人类启用选择器（`GET /api/capability-state/available`, `POST /api/capability-state/enable`）。
- Live Preset 绑定在独立的同级“能力绑定”tab 中支持（`capabilities`），具备有限覆盖、折叠的高级面板及 `modelCallable: true` 显式授权。
- 限制级智能体控制工具 `forge_capability`（list、status、enable、disable，ID ≤ 128 字符）。
- Web 能力管理界面（Capabilities CRUD）支持 SDK 分组工具选择器与 `sourceRevision` 防脏写。
- Preset 策略新增自定义默认工具编辑器（`tools.initial?: string[]`），支持具体工具名、零默认工具（`[]`）以及缺省回退到传统逻辑。
- Parent 核心防护：源版本一致性保障、外部新增绑定防脏写检测、生命周期与重入安全围栏。
- 工具补丁仅支持 `add` 与 `remove`；候选的 `only`/allowlist 未实现。
- 提供保守的 Provider 托管与缓存预警；兼容的 Codex 传输在保留历史没有移除/重复声明时可追加全新工具以保留前缀（不保证缓存命中）；移除/同名重加回退全量当前工具表；不进行自动旧数据迁移，不重写历史摘要；无 Pi split patch；不声称 forceprompt、warming、autooverflow 或远程模型验收保证。
- 2026-09-24 UI 收口时（提交 `89c6ba2`）本地构建、完整 Node／浏览器／打包验证已通过；这不等于远端提供商验收或已发布。目标版本为 0.5.5，开发元数据仍为 0.5.4，配套发布准备待收尾。宿主仍要求 Pi `>=0.87.0 <0.88.0`；发布、推送和宿主 reload 需单独授权。


文件路径校验会拒绝检查时已存在的符号链接，但不能隔离另一个本地进程并发替换目录的攻击；源版本比较也不是跨进程锁。不要把资源编辑用于不可信进程可竞争修改的共享目录。
