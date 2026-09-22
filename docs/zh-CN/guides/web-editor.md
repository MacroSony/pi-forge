# Web 编辑器

[中文文档](../README.md) · [English](../../guides/web-editor.md)

在可信 Pi 项目中执行：

```text
/preset ui
```

`/preset ui restart` 会替换 server，`/preset ui stop` 会关闭它。

编辑器绑定在带 session token 的可用 `127.0.0.1` 端口；多个项目可以同时运行。读取、预览和 payload 检查在合适范围内可用；写入要求 Pi 信任项目，并且文件被限制在 Pi Forge 的预设/Profile 存储内。可以在 `.pi/forge/config.json` 中设置偏好端口：

```json
{
  "webEditor": { "port": 41738 }
}
```

端口被占用时会自动选择其他端口。请不要把带 token 的编辑器 URL 暴露或代理到不可信网络。写入操作要求项目已被 Pi 信任。

## 界面语言

编辑器界面提供英文和中文。使用顶栏的语言选择器（Auto / English / 中文）；选择会写入项目配置中的 `webEditor.locale`。默认为 `Auto`，跟随浏览器语言，首次页面渲染也会参考浏览器的 `Accept-Language` 请求头。界面框架、内置预设/Profile 界面以及预览/差异停靠栏均已本地化；编译器诊断信息、插件提供的设置页面以及预设中自行编写的内容保持其原始语言。

## 预设工作区

支持：

- 从默认 Pi mirror 新建预设；
- 在 **堆栈**（Stack）tab 中编排有序的 Block/Slot；
- 在 **策略**（Policy）tab 中配置工具与技能的 allow/deny 资源策略及自定义默认工具（`tools.initial`）；
- 在独立的同级 **模式绑定**（Mode bindings）tab 中关联指令模式（Preset 元数据面板不再包含绑定）；
- 结构化元数据、参数、上下文以及 **Regex** 规则编辑；
- 拖拽排序、启用/禁用、校验和完整编译预览；
- 工具/skill 搜索、精确名称 chips 和通配符策略；
- 原生 pi-forge JSON 导入；
- 导出、fork、删除和 payload 捕获。

### 工具选择与默认工具编辑器

**策略**（Policy）tab 提供可选的自定义默认工具编辑器（`tools.initial?: string[]`）：

- **默认工具选择器：** 提供基于 SDK `sourceInfo`（Pi 内置工具、扩展包工具及顶层入口点）的可折叠、可搜索分组选择器。
- **确切工具名称：** 选择器保存具体的工具名称；不持久化包引用，不自动安装依赖包，扩展包后续新增的工具也不会被自动加入。未激活但已注册的工具在选择器中可见；未加载的工具在当前会话不可用，但手动保存的引用不会被丢弃。
- **缺省与零默认工具：** 缺省不配置 `tools.initial` 时保持传统行为（选择性 allow 匹配已注册目录；不限/deny 保留或过滤会话基线，不会全选目录）；显式配置为空列表 `[]` 时，默认激活零个工具。
- **权威上限：** 保留高级字面量与通配符 allow/deny 策略作为权威上限；被 allow/deny 拦截的工具无法作为默认工具生效。
- **运行时生命周期：** 配置的默认工具在预设处于激活状态期间作为常态基准（并非每轮一次性重置）。停用模式后按默认工具与剩余模式重新计算；停用预设恢复经外部变更协调的会话基线，切换预设则按新预设与保留的非绑定模式计算。

### 模式绑定 tab

指令模式绑定在独立的同级 **模式绑定**（Mode bindings）tab 中管理：

- 每张绑定卡片呈现模式引用、作用域徽标（`project` / `global`）、绑定 ID 以及 `modelCallable` 授权开关。
- 覆盖项（正文替换/追加、工具增加/移除）与源定义/生效值实时对比预览折叠在**高级选项**（Advanced）中，保持主列表紧凑。
- 自定义工具覆盖项配备了与策略页面一致的集成分组工具选择器。

### 保存行为与执行影响

- **模式界面：** 保存指令模式仅更新模式库文件定义，绝不会在当前会话中自动激活该模式。
- **预设编辑：** 保存**未激活**的 Preset 仅更新其磁盘文件，不会选中或激活它；**关键**：保存**当前已激活**的 Preset 会立即重载并同步其实时工具策略与模式授权，但不会替换已冻结的活动模式快照。

已有 ID 在编辑时不可修改；需要新 ID 时使用 **Fork**，避免破坏 Profile 引用和当前选择。工具栏的 scope 下拉（默认 `project`）决定新建、导入和 fork 的写入位置：选择 `global` 写入用户全局 `~/.pi/forge/prompt-stacks`, 选择 `project` 写入项目 `.pi/forge/prompt-stacks`；这些目录名在 0.5.3 中为兼容性暂时保留。列表会为全局预设显示 `global` badge；保存和删除通过 `global:<id>` 路由精确作用于全局文件。保存、导入、fork 和删除后会刷新当前 Pi 会话中的 Forge 资源，不重启 Pi 进程。

### 兼容性说明

使用 `tools.initial` 的预设需要新版 Forge 支持。旧版 Forge 可能忽略 `tools.initial` 并恢复旧选择逻辑（选择性 allow 匹配目录，不限/deny 保留或过滤会话基线）（不支持向下降级兼容）。当前代码库仍处于 0.5.4 开发树，发布版本号决策待定（0.5.5 或可能升级为 0.6 发布）；最低 SDK 要求保持 Pi `>=0.87.0 <0.88.0` 不变。

## Agent profile 工作区

列表显示 Profile ID、名称、模型、思考等级、预设、校验状态、auto-activation 和 last-applied provenance。每个 Profile 都带 `project` / `global` scope badge；同 ID 的 shadow 对会显示 `shadows global:<id>` 或 `shadowed by project:<id>`。

可信项目通过 **New profile** 旁的 scope 下拉（默认 `project`）选择目标 scope：选择 `global` 写入用户全局 `~/.pi/forge/agent-profiles`，选择 `project` 写入项目 `.pi/forge/agent-profiles`。全局 Profile 可通过显式 `global:<id>` 路由编辑、校验、保存、一次性应用和删除；未限定路由始终只作用于项目资源。编辑全局 Profile 时，预设下拉只显示全局预设。Model 选项来自 Pi registry，thinking 选项反映模型支持，预设选项来自同一个 repository。编辑器会拒绝同 scope 内第二个 auto-activation Profile。

## Delegation

Delegation 配置不在主编辑器中。可选包 `@zihanw/pi-forge-subagents` 持有专用的 `.pi/forge/subagents.json` 和 `~/.pi/forge/subagents.json` 文件。启用 profile 前请阅读[前台 delegation](delegation.md)。
