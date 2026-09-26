# 实验性前台 delegation

[中文文档](../README.md) · [English](../../guides/delegation.md)

> **实验性：** 此 API 和 backend 可能独立于稳定的 prompt stack/profile 功能发生变化。

可选包 `@zihanw/pi-forge-subagents` 会通过选定的 backend 执行明确授权的 agent profile。默认只读 backend 使用独立、干净、一次性的 Pi 子进程；可写 backend 的边界见下文。本文档流程在前台运行，并向父对话返回有界报告。

> **默认工具兼容要求：** Forge 0.5.5 主包已提供 `tools.initial`；独立发布的可选 subagents 0.5.3 不兼容该字段。在可选包将 Forge floor 提升到 `^0.5.5` 并单独发布修复前，请使用匹配的本地源码；版本与发布门槛见[工具选择兼容说明（英文）](../../reference/subagent-host-port.md#tool-selection-compatibility)。这项可选包兼容工作不是主包 release gate。


## 启用 profile

Profile 默认不能委派。请在可信项目的 `.pi/forge/subagents.json` 中逐个启用项目 profile，在用户全局 `~/.pi/forge/subagents.json` 中逐个启用全局 profile；`.pi/forge/config.json.subagents` 仅作为只读兼容来源：

```json
{
  "backend": "pi-subprocess-readonly",
  "timeoutMs": 60000,
  "profiles": {
    "project:reviewer": {
      "enabled": true,
      "timeoutMs": 300000
    }
  }
}
```

授权 key 应使用完整 selector：`project:<id>` 或 `global:<id>`。裸 key 仅为项目 profile 的兼容写法，即使写在 `~/.pi/forge/subagents.json` 中也只授权 `project:<id>`；授权全局 profile 必须显式写成 `"global:reviewer": { "enabled": true }`。同 ID 的全局和项目 profile 不会互相继承 enable/backend/timeout。未启用或未列出的 ID 不会被 discovery 返回，即使猜中 ID 也会被拒绝。

## Plan 与运行

```text
/forge-agent backends
/forge-agent plan reviewer 检查这个 API 设计。
/forge-agent run reviewer 检查这个 API 设计。
```

`plan` 会解析 profile/stack、编译并校验不可变的实际 provider-bound 计划，然后在不联系 provider 的情况下丢弃。Profile selector 在所有入口使用同一语法：`reviewer`、`project:reviewer` 或 `global:reviewer`。在 delegation 中，裸 ID 选择 `project:<id>`；调用全局 profile 请使用明确的 `global:<id>`。同 ID 的 profile 仍彼此独立，不会互相继承 delegation policy。

父模型使用无数据外发的 `forge_subagent_profiles` 做 discovery，再用 `forge_subagent` 执行。限制严格的父 stack 必须允许这两个工具名。

匹配的可选 subagents 包与 runtime 开发版本提供四个 backend ID。以下说明基于尚未完成的可选包源码，不代表配套 release 已定稿；Forge 0.5.5 主包不依赖它们。请同时遵守上方 Forge 兼容要求：

- `pi-subprocess-readonly` 是默认 backend，使用 `pi --mode text --print`。它提供 `read`、`grep`、`find`、`ls` allowlist，属于 shared-user；allowlist 不是 OS 沙箱。
- `pi-rpc-readonly` 使用 `pi --mode rpc`，采用相同的 shared-user 只读策略，只改变进程协议。
- `pi-inprocess` 在 host model runtime 中运行，拥有启动用户的完整权限。它是 workspace-write backend；在 sealed access level 和 stack policy 允许时可提供 `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash`，但没有 OS 沙箱。需要 extension-registered provider 时应使用它。
- `pi-bwrap-write` 是仅限 Linux 的可选 Bubblewrap backend。它为选定 workspace 提供隔离的 `workspace-write` 挂载，并可在允许时提供 `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash`。写入会直接落到该 workspace，不是另行审批再 apply 的 staged patch；需要 Bubblewrap，默认还要求 git workspace。

所选 backend 不可用时会 fail closed，不会自动 fallback。Fresh-process backend 对 extension-registered provider 会报告不可移植；此时改用 `pi-inprocess`。不要把此开发矩阵或 `tools.initial` 修复理解为配套 companion release 已发布。

Human 运行的 backend 优先级是：显式 per-run `--backend`、匹配 profile override、可信项目默认值、全局默认值、内置 `pi-subprocess-readonly`。交互式模型调用也可以提供 per-call backend override；无人值守的模型调用会固定使用生效的 profile/config backend，并拒绝该 override。Timeout 依次采用匹配 profile override、可信项目默认值、全局默认值，再到内置 60 秒；有效范围为 1,000–3,600,000 ms，host timeout 仅为 best effort。

## 审批

默认情况下，provider transport 前会显示与执行 fingerprint 绑定的计划，包括任务、profile/stack、provider/model、thinking、工具、cwd、安全边界和 payload 大小。可以选择 **View full prompt** 检查完整 system prompt 和消息。

可信项目可以明确允许模型无需逐次审批：

```json
{
  "allowAgentInvocationWithoutApproval": true
}
```

在专用 `subagents.json` 中该 flag 必须位于顶层；只有旧版 `config.json` 的嵌套 `subagents` 段落使用嵌套形式。

它只影响 `forge_subagent`；`/forge-agent run` 仍需要交互审批。该 flag 可以来自全局默认或可信项目文件，项目值优先。尚未发布的配套修复中，某一层省略时会继承；某一层明确写入非 boolean 时，该层设为 `false` 并发出 warning；更高优先级层的有效 boolean 仍会正常覆盖较低层。若整个配置文件不可读、格式错误或不是 JSON object，则该文件会带 warning 被忽略，之前有效的层仍可能继续生效。不可信项目的项目配置会被忽略，execution trust gate 也会阻止该项目运行 delegation。请把 `subagents.json` 当作授权文件：除非所有可调用父 agent 都可以无需再次询问就把编译 prompt 和可读文件发给 provider，否则不要启用或提交此设置。

## Child 边界

普通的新 child 从干净对话开始，不会自动继承父 history。显式保留 child 后续聊与后台运行属于独立的开发中特性，详见[配套包文档](https://github.com/MacroSony/pi-forge-subagents)。对 `pi-subprocess-readonly` 和 `pi-rpc-readonly`，候选工具只有 `read`、`grep`、`find`、`ls`，并继续受到 stack policy 限制；这些 child 不加载 write/edit/shell、skills、prompt templates、context files 或第三方 extensions。`pi-inprocess` 和 `pi-bwrap-write` 仅在 access level 与 stack policy 允许时提供上文所述可写工具。

> **边界取决于 backend：** subprocess/RPC 只读 backend 和 `pi-inprocess` 都是 shared-user，不是 OS 沙箱；后者在 host 进程中拥有启动用户完整权限。`pi-bwrap-write` 是 Linux 隔离例外：选定 workspace 是可写的项目挂载，另有只读运行时挂载与沙箱临时存储。它不是 staged patch/apply 流程，也不提供 network isolation。Shared-user backend 中，该用户可读的绝对路径可能被读取并发送给 provider；文本可能保留在父 tool-result 和 Pi session JSONL。Timeout/取消仅为 best effort。`/tree` 不能撤销 provider 请求、计费或外部影响，也不保证删除磁盘上的 abandoned entry。

选择只读 backend 时不要授予 mutation path；选择可写 backend 则应视为明确授权其修改选定 workspace。
