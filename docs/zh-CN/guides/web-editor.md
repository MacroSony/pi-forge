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
- 在 **堆栈** tab 中编排有序的 Block/Slot；
- 结构化和原始 JSON 编辑；
- 拖拽排序、启用/禁用、校验和完整编译预览；
- 工具/skill 搜索、精确名称 chips 和通配符策略；
- variables、context 和 regex 规则；
- 原生 pi-forge JSON 导入；
- 导出、fork、删除和 payload 捕获。

已有 ID 在编辑时不可修改；需要新 ID 时使用 **Fork**，避免破坏 Profile 引用和当前选择。工具栏的 scope 下拉（默认 `project`）决定新建、导入和 fork 的写入位置：选择 `global` 写入用户全局 `~/.pi/forge/prompt-stacks`，选择 `project` 写入项目 `.pi/forge/prompt-stacks`；这些目录名在 0.5.3 中为兼容性暂时保留。列表会为全局预设显示 `global` badge；保存和删除通过 `global:<id>` 路由精确作用于全局文件。保存、导入、fork 和删除后会重新加载当前 Pi session。

## Agent profile 工作区

列表显示 Profile ID、名称、模型、思考等级、预设、校验状态、auto-activation 和 last-applied provenance。每个 Profile 都带 `project` / `global` scope badge；同 ID 的 shadow 对会显示 `shadows global:<id>` 或 `shadowed by project:<id>`。

可信项目通过 **New profile** 旁的 scope 下拉（默认 `project`）选择目标 scope：选择 `global` 写入用户全局 `~/.pi/forge/agent-profiles`，选择 `project` 写入项目 `.pi/forge/agent-profiles`。全局 Profile 可通过显式 `global:<id>` 路由编辑、校验、保存、一次性应用和删除；未限定路由始终只作用于项目资源。编辑全局 Profile 时，预设下拉只显示全局预设。Model 选项来自 Pi registry，thinking 选项反映模型支持，预设选项来自同一个 repository。编辑器会拒绝同 scope 内第二个 auto-activation Profile。

## Delegation

Delegation 配置不在主编辑器中。可选包 `@zihanw/pi-forge-subagents` 持有专用的 `.pi/forge/subagents.json` 和 `~/.pi/forge/subagents.json` 文件。启用 profile 前请阅读[前台 delegation](delegation.md)。
