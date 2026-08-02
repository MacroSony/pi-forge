# 实验性前台 delegation

[中文文档](../README.md) · [English](../../guides/delegation.md)

> **实验性：** 此 API 和 backend 可能独立于稳定的 prompt stack/profile 功能发生变化。

pi-forge 可以把明确授权的 agent profile 作为独立、干净、一次性的 Pi 进程执行。它在前台运行，并向父对话返回有界报告。

## 启用 profile

Profile 默认不能委派。请在可信项目的 `.pi/forge/config.json` 中逐个启用，或使用 `/preset ui` 的 delegation 卡片：

```json
{
  "subagents": {
    "backend": "pi-subprocess-readonly",
    "timeoutMs": 60000,
    "profiles": {
      "reviewer": {
        "enabled": true,
        "timeoutMs": 300000
      }
    }
  }
}
```

Profile 授权只允许出现在项目配置，因为 profile 本身也是项目资源。全局 `~/.pi/forge/config.json` 可以设置通用 backend/timeout；全局 `profiles` 会警告并被忽略。未启用或未列出的 ID 不会被 discovery 返回，即使猜中 ID 也会被拒绝。

## Plan 与运行

```text
/forge-agent backends
/forge-agent plan reviewer 检查这个 API 设计。
/forge-agent run reviewer 检查这个 API 设计。
```

`plan` 会解析 profile/stack、编译并校验不可变的实际 provider-bound 计划，然后在不联系 provider 的情况下丢弃。

父模型使用无数据外发的 `forge_subagent_profiles` 做 discovery，再用 `forge_subagent` 执行。限制严格的父 stack 必须允许这两个工具名。

当前有两个 fresh-process backend：默认 `pi-subprocess-readonly` 使用 text/print，`pi-rpc-readonly` 使用 RPC。两者执行同一密封 prompt 和 shared-user 只读策略。所选 backend 不可用时会 fail closed，不会自动 fallback。

## 审批

默认情况下，provider transport 前会显示与执行 fingerprint 绑定的计划，包括任务、profile/stack、provider/model、thinking、工具、cwd、安全边界和 payload 大小。可以选择 **View full prompt** 检查完整 system prompt 和消息。

可信项目可以明确允许模型无需逐次审批：

```json
{
  "subagents": {
    "allowAgentInvocationWithoutApproval": true
  }
}
```

它只影响 `forge_subagent`；`/forge-agent run` 仍需要交互审批。格式错误或不可信项目会 fail closed。请把此 config 当作授权文件：除非所有可调用父 agent 都可以无需再次询问就把编译 prompt 和可读文件发给 provider，否则不要启用或提交此设置。

## Child 边界

Child 从干净对话开始，不会自动继承父 history。候选工具只有 `read`、`grep`、`find`、`ls`，并继续受到 stack policy 限制。它不会加载 write/edit/shell、skills、prompt templates、context files 或第三方 extensions。

> **当前 backend 是 shared-user，不是操作系统沙箱。** “只读”只是模型工具策略，进程仍拥有启动用户的 OS 权限。该用户可读的绝对路径可能被读取并发送给 provider；文本可能保留在父 tool-result 和 Pi session JSONL。Timeout/取消仅为 best effort。`/tree` 不能撤销 provider 请求、计费或外部影响，也不保证删除磁盘上的 abandoned entry。

不要给此 shared-user 设计添加 write/edit/shell。操作系统隔离和需要第二次审批的 staged write 属于未来工作。
