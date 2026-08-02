# Agent profile

[中文文档](../README.md) · [English](../../concepts/agent-profiles.md)

Agent profile 是项目级、带 schema version 的预设，只引用一个精确模型、思考等级和 prompt stack。

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

普通 profile 默认不能委派。Delegation 使用独立的可信项目授权；删除 profile 也会清除其授权，防止以后同 ID profile 继承权限。启用前见[前台 delegation](../guides/delegation.md)。
