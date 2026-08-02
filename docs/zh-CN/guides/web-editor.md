# Web 编辑器

[中文文档](../README.md) · [English](../../guides/web-editor.md)

在可信 Pi 项目中执行：

```text
/preset ui
```

`/preset ui restart` 会替换 server，`/preset ui stop` 会关闭它。

编辑器绑定在带 session token 的可用 `127.0.0.1` 端口；多个项目可以同时运行。可以在 `.pi/forge/config.json` 中设置偏好端口：

```json
{
  "webEditor": { "port": 41738 }
}
```

端口被占用时会自动选择其他端口。请不要把带 token 的编辑器 URL 暴露或代理到不可信网络。写入操作要求项目已被 Pi 信任。

## Prompt stack 工作区

支持：

- 从默认 Pi mirror 新建 stack；
- 结构化和原始 JSON 编辑；
- 拖拽排序、启用/禁用、校验和完整编译预览；
- 工具/skill 搜索、精确名称 chips 和通配符策略；
- variables、context 和 regex 规则；
- 原生 pi-forge 与 SillyTavern JSON 导入；
- 导出、fork、删除和 payload 捕获。

已有 ID 在编辑时不可修改；需要新 ID 时使用 **Fork**，避免破坏 profile 引用和当前选择。保存、导入、fork 和删除后会重新加载当前 Pi session。

## Agent profile 工作区

列表显示 profile ID、名称、模型、思考等级、stack、校验状态、auto-activation、last-applied provenance 和 delegation 状态。

可信项目可以新建、编辑、校验、保存、一次性应用和删除 profile。Model 选项来自 Pi registry，thinking 选项反映模型支持，stack 选项来自同一个 repository。编辑器会拒绝第二个 auto-activation profile。

Delegation 卡片只修改项目级 profile 的 enable/backend/timeout。切换 profile、刷新、删除或离开页面时，未保存的 delegation 字段会得到保护。通用默认值和 `allowAgentInvocationWithoutApproval` 只能在 config 文件中设置。

启用前请阅读[前台 delegation](delegation.md)。
