# 快速上手

[中文文档](README.md) · [English](../getting-started.md)

## 安装

pi-forge 需要 Node.js 22.19 或更高版本，并作为 Pi extension 运行：

```bash
pi install npm:@zihanw/pi-forge
```

安装或更新后请重启 Pi。Pi host 会提供运行时 SDK；精确 package 版本只用于可复现的开发测试。项目被 Pi 信任后，pi-forge 才会加载项目 stack、profile 和 config。

## 第一个 stack

Prompt stack 保存在 `.pi/forge/prompt-stacks/*.json`。推荐从 [默认 Pi mirror](../../examples/default-prompt-stack.json) 开始：

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json
```

如果不是在仓库 clone 中，可以打开 `/preset ui` 新建 stack；编辑器使用同样的默认布局。

```text
/preset reload
/preset use default
```

如果没有恢复的 session 选择或明确 opt-out，`default.json` 会自动启用。设置 `"autoActivate": false` 可以关闭此行为。

## 编辑和检查

```text
/preset ui
```

编辑器运行在带 token 的本地 `127.0.0.1` URL，支持结构化/原始 JSON 编辑、排序、校验、完整预览、策略、regex、导入导出、fork 和 profile 管理。

命令行也可以检查：

```text
/preset validate default
/preset preview default
/preset diagnostics
```

## 创建 profile

先选择模型、思考等级和 stack，然后执行：

```text
/profile save reviewer
/profile preview reviewer
/profile use reviewer
```

Profile 保存在 `.pi/forge/agent-profiles/*.json`。应用是经过 preflight 的一次性操作；之后的手动设置不会被自动覆盖。

## 存储与迁移

| 路径 | 用途 |
|---|---|
| `.pi/forge/prompt-stacks/` | 项目 prompt stacks |
| `.pi/forge/agent-profiles/` | 项目 agent profiles |
| `.pi/forge/config.json` | 项目配置和 delegation 授权 |
| `.pi/forge/extensions/` | 可信项目 macro/slot 代码 |
| `~/.pi/forge/config.json` | 用户默认配置 |
| `~/.pi/forge/extensions/` | 可信用户 macro/slot 代码 |

旧的 `.pi/prompt-stacks/*.json` 仍可读取；新 stack 会写到 `.pi/forge/prompt-stacks`。安全迁移方式：

```text
/preset migrate-stacks --dry-run
/preset migrate-stacks
```

确认复制结果后再考虑 `--overwrite` 或 `--delete-legacy`。
