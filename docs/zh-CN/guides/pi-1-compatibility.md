# Pi 1.0 兼容说明

[中文文档](../README.md) · [English](../../guides/pi-1-compatibility.md)

## 源码补丁与已发布包

本兼容补丁**尚未发布**，源码 manifest 仍为 0.5.7。安装已发布的 `@zihanw/pi-forge@0.5.7` 不会获得这些改动；该 artifact 的 Pi peer 范围仍为 `>=0.87.0 <0.88.0`。

源码中四个 Pi SDK 包的 peer 策略为：

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || 1.0.0
```

最低 Pi 保持 0.87.0。开发依赖固定为 Pi 1.0.0 和 `typebox@1.3.27`。SDK 和 TypeBox 仍为宿主提供的可选 peer，不私装运行时副本；不自动承诺其他中间版本或未来版本。

本补丁只调整依赖、测试覆盖与文档，**不改变**工具授权、Capability 所有权、用量汇总或个人配置。

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
PI_TEST_VERSION=1.0.0 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

不指定时，packed 检查读取一致的已安装 SDK family 及其声明的 TypeBox 版本，不再硬编码旧 pin。两个消费者都使用正常 npm peer 解析，并核对实际安装版本。如果存在 optional sibling，使用它声明的 runtime 依赖；不把这当成未发布本地 runtime 的测试。

常规 Linux/macOS/Windows CI 使用固定的 Pi 1.0.0；显式旧版本兼容与 scheduled latest 探针运行在 Linux。目标 release commit 的 CI 仍是发布门槛，不代表当前源码补丁已完成远端平台或真实 provider 验收。
