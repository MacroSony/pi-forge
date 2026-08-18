# Prompt-stack patterns and examples

[Documentation](../README.md)

Use these as starting patterns rather than rigid templates. The [default Pi mirror](../../examples/default-prompt-stack.json) is the safest baseline to fork.

## Roleplay and creative writing

Put long-lived character rules in a system block, runtime context in appropriate slots, and the current user action in an explicit final user block:

1. System character/personality block.
2. Tools, project context, and other runtime slots.
3. `chat-history` with `includeLastUserMessage: false`.
4. Final user block containing `{{ runtime.lastUserMessage }}`.

This keeps the latest request clear and avoids duplication. Static `{{ parameters.char }}` / `{{ parameters.user }}` values work well for character constants. Durable project memory belongs in project files, not parameters.

## Focused code review

Start from [the reviewer example](../../examples/reviewer-prompt-stack.json). It denies writing tools, wraps prior history as background, omits the latest user message from history, then reinserts it as the explicit review target.

Use a rule such as “prioritize correctness, regressions, security, and missing tests.” Keep tools, project context, and history when the reviewer must inspect the repository. Use `append` to retain Pi's normal coding prompt, or `replace` when the stack must fully control prompt and skill visibility.

## Translation mode

Create a small stack with a system block for target language, register/tone, and terminology rules. Retain history and a final `{{ runtime.lastUserMessage }}`. Separate literal translation, localization review, and bilingual editing into different stacks when their rules conflict.

## Multi-mode switching

Keep independent project files:

```text
.pi/forge/prompt-stacks/
  coder.json
  writer.json
  translator.json
```

Switch with `/preset use coder`, `/preset use writer`, or `/preset use translator`. Capture a profile when a mode also needs a specific model and thinking level.

## Read-only scout

Allow only `read`, `grep`, `find`, and `ls`, omit editing tools, and cap chat history with `maxChars`. This is useful for exploration turns where the model should report findings without changing files.

Tool policy constrains model tool calls but is not an operating-system sandbox. A normal Pi agent may still have other non-tool ways to interact with its host; do not describe a prompt stack alone as process isolation.

## Surgical patcher

Keep the Pi mirror, require the tools needed for the workflow, strip prior assistant thinking from inserted history, and move project context near the current user turn. This reduces distracting prompt material without removing relevant repository instructions.

## Payload lab

Include `active-model` and `date-cwd`, then add compiled regex rules for deterministic redaction or formatting. Pair the stack with `/payload next` or the web editor's capture view to audit exactly what changed.

## Pi-docs expert

Allow read/search tools, include the `pi-docs` and project-context slots, and keep a focused system instruction. This encourages answers grounded in installed Pi documentation rather than general model memory.

## Trusted runtime status

The [custom system-status example](../../examples/custom-system-status-extension/README.md) registers `{{ extensions.cpuLoad }}` and a `machine-status` slot from trusted project code. Use this pattern for deterministic host data that cannot be represented as static stack JSON.
