# Agent profile

[中文文档](../README.md) · [English](../../concepts/agent-profiles.md)

Agent profile 是项目级或用户全局、带 schema version 的预设，只引用一个精确模型、思考等级和 prompt stack。项目 profile 位于 `.pi/forge/agent-profiles/`，全局 profile 位于 `~/.pi/forge/agent-profiles/`。命令接受 `reviewer`、`project:reviewer` 和 `global:reviewer`；未限定 ID 优先解析项目 profile，项目 profile 会遮蔽同 ID 全局 profile。

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.agent-profile",
  "id": "reviewer",
  "name": "Reviewer",
  "description": "只审查代码，不做修改。",
  "autoActivate": true,
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinkingLevel": "high",
  "promptStack": "reviewer"
}
```

`promptStack` 可以是 `null`。Profile v1 不保存生成参数、工具、skills、backend 或 runner policy；不支持字段会直接报错。工具/skill 策略只属于引用的 stack。

`promptStack` 引用相对 profile 自身 scope 解析：项目 profile 用裸 ID 引用项目 stack，也可用 `global:<id>` 显式引用全局 stack；全局 profile 只能引用全局 stack，`project:<id>` 会被拒绝。

## 应用

```text
/profile save reviewer
/profile preview reviewer
/profile use reviewer
```

保存不会包含 secrets、history、tools 或 provenance。应用前会完整检查 profile、模型、认证、思考等级、stack 和工具策略；失败时不会部分应用，运行中失败会尝试 rollback。

成功应用后，后续手动修改会被保留。Profile 不是持续的 runtime owner。

## Auto-activation 与 drift

最多一个 profile 可以设置 `autoActivate: true`。它只在全新 session 中应用一次，并优先于独立 stack autoload；恢复的 branch 状态优先。无效或冲突的自动启用会 fail closed。

`/profile status` 会把 profile 源定义变化和当前模型/思考等级/stack drift 分开显示。Provenance 只用于 branch 状态报告；reload、resume、tree navigation 和 compaction 不会重新应用 profile。

普通 profile 默认不能委派。Delegation 授权由可选包 `@zihanw/pi-forge-subagents` 通过专用文件持有，使用 `project:<id>` 或 `global:<id>` 完整 key，并可按 profile 覆盖 backend/timeout。裸授权 key 无论位于哪个文件都只是项目 profile 的兼容别名；同 ID 的全局和项目 profile 永不互相继承授权。主包不读取任何 subagent 配置，删除 profile 也不会改动 `subagents.json`。启用前见[前台 delegation](../guides/delegation.md)。
