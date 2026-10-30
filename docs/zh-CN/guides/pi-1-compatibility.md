# Pi 1.0 兼容说明

[中文文档](../README.md) · [English](../../guides/pi-1-compatibility.md)

## Forge 0.5.10（未发布）：Pi 1.4

开发 SDK 固定为 **1.4.0**，四个可选 SDK peer 范围扩大为：

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.5.0
```

最低 Pi 0.87.0 与 `typebox@1.3.27` 保持不变；不自动承诺 Pi 1.5+ 或其他 0.x。常规 CI 与普通打包消费者使用 1.4.0，历史兼容矩阵保留 1.3.0 及已有版本。本次更新不改变 gate、工具策略、Capability 执行语义或 MCP 名称处理。下方 0.5.9 / 0.5.8 段落保留为历史说明，并非当前 peer 范围。

**本地验证限制（2026-10-30）：** Pi 1.4.0 下，`tests/pi13-tool-restore.test.ts` 的八个用例均在首次启动工具集断言（第 98 行）失败：实际列表额外包含 `forge_capability`。这些用例尚未执行到恢复会话后的策略断言，不能据此认证 1.4 上的恢复路径。其余 933 个 Node 测试、全部 70 个浏览器测试与 TypeScript/Vue 检查通过。本次 peer 更新不修改源码或测试断言来掩盖差异。

## Forge 0.5.9：Pi 1.1 / 1.2 / 1.3

Forge 0.5.9 将开发 SDK 固定为 **1.3.0**，四个可选 SDK peer 范围扩大为：

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.4.0
```

不自动承诺 Pi 1.4 或其他 0.x。历史 CI 保留 1.0.2，并增加 1.0.4 / 1.1.0 / 1.2.0；常规任务使用 1.3.0。兼容任务核对实际解析版本，并明确固定 1.x codemode/MCP/telemetry/chord 为同版本 fixture。这些任务的打包消费者也通过 `PI_TEST_COHERENT_UPSTREAM=1` 使用同样的固定版本；常规打包检查（1.3.0 任务）保持 npm 正常解析。原因是 Pi 1.0.1–1.1.x 的全新无约束安装现在会经上游 caret 拉到更新且不兼容的 codemode/MCP（例如 Pi 1.1.0 + pi-codemode 1.3.0 因缺少 `MCP_TYPESCRIPT_PREAMBLE` 导出而失败），与 Forge 无关。fixture 通过只说明 Forge 在该宿主系列上可用，不代表旧版 Pi 的全新无约束安装可用。

Pi 1.2 的空闲自定义唤醒触发无 `prompt` 的 `before_agent_start`，启动时 `isIdle()` 已为 false。Forge 在编译 System 块之前，通过现有预览投影与历史 helper 一次解析当前分支的 `runtime.lastUserMessage`，直到结算保持工具后续请求的快照。没有符合条件的用户内容则为空；自定义消息不是用户提示。保留 helper 既有渲染（包括图片的 `[image]`）；role=user 不代表经过身份认证的人类。每个实际 start 重置 turn 频率规则；忙碌时 steering 不伪造 start 或用户消息。普通/旧宿主 user 事件仍以展开后的 prompt 为准，包括空文本/仅图片输入。旧宿主不发出 custom-start 时，不伪造该事件。

**Pi 1.1 及更早版本的已知限制：** 这些宿主启动空闲自定义唤醒时（例如 Subagents 完成通知唤醒父会话）不触发任何 `before_agent_start`，Forge 无从得知这一轮开始。该次唤醒请求及其工具后续请求不带预设的 System 块；工具策略照常生效。这一点与 0.5.8 相同，已在 Pi 1.1.0 上实测。普通用户输入和忙碌时的 steering 不受影响。依赖后台完成唤醒的话，请使用 Pi 1.2 或更高版本。

Pi 1.3 保持 custom-start/System 契约，并在默认或修饰符工具选择模式创建会话时恢复 transcript 中的活动工具；显式工具列表仍覆盖恢复。Forge 按预设的 `tools.initial`、allow/deny 与活动能力重新计算有效工具，不能让过期 transcript 越过权限上限或丢失能力工具。停用预设时恢复工具策略所有者保存的启动基线，并协调可区分的外部修改，而不是用经过策略缩减的 transcript 丢弃原基线。真实 SDK 持久化会话测试使用离线 faux 流覆盖这些路径；不引入新的 enabled-membership 执行权限限制。

Pi 1.3 内部 SDK/codemode/MCP/telemetry 改为精确版本依赖，普通消费者无需历史 fixture 覆盖即可解析七个 Pi 包为 1.3.0；这不会修复旧版本 caret 的解析漂移。

下文 0.5.8 一节记录上一版本的策略（peer 至 `<1.1.0`），仅作历史保留，不是当前 peer 范围。

## Forge 0.5.8 与旧版本

本指南介绍 **Forge 0.5.8** 兼容补丁。安装旧版 `@zihanw/pi-forge@0.5.7` 不会获得这些改动；该 artifact 的 Pi peer 范围仍为 `>=0.87.0 <0.88.0`。

Forge 0.5.8 为四个 Pi SDK 包声明的 peer 策略为：

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.1.0
```

最低 Pi 保持 0.87.0。开发依赖固定为 Pi 1.0.2 和 `typebox@1.3.27`。SDK 和 TypeBox 仍为宿主提供的可选 peer，不私装运行时副本；`>=1.0.0 <1.1.0` 覆盖 Pi 1.0 的补丁版本；本次发布实测 1.0.0、1.0.1、1.0.2，CI 定时任务会测试最新 Pi。不自动承诺其他 0.x 中间版本或 Pi 1.1 及以后版本。

本补丁只调整依赖、测试覆盖与文档，**不改变**工具授权、Capability 所有权、用量汇总或个人配置。

## 不受支持宿主的边界

Forge 需要上游 Pi 的 `systemPromptOptions` 与 `context_with_system` 契约。oh-my-pi（OMP）等分支仍不受支持；优雅处理缺失输入不等于支持 OMP，也不认证分支的工具权限实现。

- CLI 应用预设/Profile 会在改变选择或模型前检查命令专用的提示词 API；普通生命周期 context 无需提供命令专用 getter。
- 全新会话的自动 Profile 模型/思考设置及预设/工具选择仍然提前生效，可能早于首轮提示词兼容性被观察到。不会延后应用，也不会在随后检测到缺失输入时自动回滚。
- 缺少必要输入时每个会话只警告一次，清除过时的编译捕获，并在该会话内锁定拒绝新的预设/Profile 应用及预设编译/预览，包括已打开 Web 编辑器的 Preview。检测**不会**中止 provider 请求派发，也不会自动清除独立生效的工具策略；Forge 仍继续应用并检查其策略。
- `/preset use none`（或 `off`）可显式禁用预设。新会话会重置锁定状态与警告次数；tree navigation、compaction 和 agent settlement 不会重置。重试前应先修复宿主契约，再新建会话。
- 检测不覆盖所有宿主，也不保证在启动时完成。有效的选项与成功的 `pi.on()` 注册不能证明 `context_with_system` 真会被调用；Forge 不以注册成功推断 hook 支持。

## Native MCP：逐项确认精确名称迁移

Pi 0.99.2+ 规范化 native MCP 名称，例如 `mcp__demo-server__ping` 改为 `mcp__demo_server__ping`。同一服务器内 `a-b` 与 `a_b` 等工具名冲突会添加 hash 后缀；服务器名规范化冲突会被拒绝。

请检查 allow/deny、initial、Capability add/remove、脚本和已保存 loadout 中的精确名称：

- 未注册的 Capability **add** 会被拒绝。旧 initial 名称可能被省略，旧精确 allow 项不会放行新名称。
- **旧的精确 deny/remove 名称可能只是匹配不到更名后的工具。** 不能把所有旧名称都当成 fail-closed；限制项和添加项一样需要检查。
- 等服务器连接后，查看 Web 编辑器刷新后的工具选择器，或扩展 API `pi.getAllTools()` 返回的注册目录。仅查看 active 列表会漏掉 inactive/deferred 工具。
- 人工确认每个 old→new 映射，包括碰撞 hash，再更新配置。Forge 不猜测别名，也不全局替换连字符。

这些规则针对 **native MCP**，不是 `pi-mcp-adapter` 2.x 等第三方 adapter。本补丁不迁移 adapter 配置或改写现有资源。

## Discovery 与延迟注册

默认 native MCP 服务器后台连接，不阻塞首个 prompt；`direct` exposure 的启动行为不同。默认工具以 deferred exposure 注册，不列进 codemode description，通过 `searchTools()` / `describeNamespace()` 发现。搜索工具不会授予 Forge Capability，也不会覆盖工具策略。

Pi 1.0 改进了 resume/reload 后的 deferred 工具恢复。Forge 仍要求 Capability add 的工具已注册；服务器未就绪时，应等待注册后重试原操作。单纯 reload 不保证解决问题。显式策略同步可能替换宿主恢复的 loadout，不应假定所有 pending 工具必须自动恢复。完整慢 MCP resume/reload 需要集成验收，不能拿 catalog mock 测试冒充。

Forge 保留 `mcp_servers` 等外来 System section，包括更新和删除。上游 section 更新可能改变后续 prompt，不保证 cache 命中。

## Pi 1.0.1 起的 Anthropic 工具变化

在支持原生中途改工具的 Anthropic 模型上，Pi 1.0.1 起请求级工具列表固定为初始工具加一个保留占位工具，之后的每个工具都直接以完整定义写在 `tool_addition` 块里。因此启用或停用 Capability 不再改写请求级工具列表，同名重定义也不再强制发送完整列表。原生路径仍需要至少一个初始工具：会话开始时没有任何活动工具（例如 `tools.initial: []` 的预设）时，每次工具变化都会在请求级别发送当前完整列表。Forge 不改变这一行为，也没有针对 1.0.1 起重新做真实缓存实测。详见 [Provider 支持](../reference/provider-support.md)。

## Codemode 边界保持原样

Pi 1.0 访问不存在的 `tools` 属性会抛错。检查存在性请用 `"name" in tools`，不要用 `typeof tools.name`。

`tools.initial` 是默认 loadout，**不是按 enabled 集合检查执行的 gate**。在 Preset 许可内、已注册的 deferred/codemode 工具，即使未列入 initial，或添加它的 Capability 已关闭，仍可能经 codemode nested 调用。Preset 的 allow **或** deny 策略和活动 Capability.remove 仍生效；direct 调用还取决于宿主 active loadout。本补丁不改变这些语义，也不让 discovery 自动按授权过滤。

`models.generateImages()`（1.0 新增）和 `models.classify()`（0.99 已有）直接调用会话 model registry，不经过 `ctx.executeTool()` / `tool_call`。关闭生图工具**不等于**关闭模型 API。Pi settings 没有 `models: false` 开关；SDK factory `createCodemodeExtension({ models: false })` 需要明确的编程式插件装配。

Pi 会将 codemode 模型返回的用量计入总账。Forge cache 面板仍分别展示 assistant 用量与显式 `details.forgeNestedUsage`，没有新增任意 native tool/model usage 汇总；不能把两份回执直接重复加总。

## TUI 与配套包

Pi 1.0 默认 fullscreen。要保留普通终端 scrollback，可在 Pi settings 中设置 `"tuiMode": "regular"`，或运行 `pi --tui-mode regular`。这不改变 Forge WebUI。

agent-core 实验 harness 的移除，不等于我们配套 runtime 使用的 coding-agent `AgentSession` 被移除。`pi-durable` 仍明确标为实验性；本补丁不接入它，也不新增跨重启 continue。

已发布的 subagents 0.5.3 不支持 `tools.initial`。尚未发布的新功能版本可以合入 Pi 1.0 适配，但仍需独立完成 runtime artifact/floor、TypeBox peer 整理、bwrap `/tmp` 启动器修复、packed 验收与发布授权。主 Forge 独立发布；main+optional 的 import smoke 不等于待发布 continue/background 功能已验收。见 [host-port 兼容说明](../../reference/subagent-host-port.md#tool-selection-compatibility)。

## 验证

```bash
# 目标与已安装开发 SDK 不同时，请同时指定这两个版本。
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 npm run check:packed
PI_TEST_VERSION=1.4.0 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

不指定时，packed 检查读取一致的已安装 SDK family 及其声明的 TypeBox 版本，不再硬编码旧 pin。两个消费者都使用正常 npm peer 解析，并核对实际安装版本。如果存在 optional sibling，使用它声明的 runtime 依赖；不把这当成未发布本地 runtime 的测试。

常规 Linux/macOS/Windows CI 使用固定的 Pi 1.4.0；显式兼容（0.87.0 至 1.3.0，含 1.0.2）与 scheduled latest 探针运行在 Linux。目标 release commit 的 CI 仍是发布门槛；本文不记录其结果，也不代表已完成真实 provider 验收。
