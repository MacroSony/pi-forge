# DeepSeek Harness Minimal Tools (optional Pi extension)

This directory contains an optional **Pi extension** that makes `examples/minimal-prompt-stack.json` much closer to DeepSeek Harness's shipped `minimal` agent preset.

It registers the same two model-facing tool names:

- `bash`: one long-lived bash process per Pi session; working directory and exported environment variables persist across calls; each command has the DSH minimal preset's fixed 300 second limit and 16,000 character output clip.
- `str_replace_editor`: `view`, `create`, `str_replace`, and `insert` with absolute paths, DSH-style line-numbered views, unique-match replacement, and 16,000 character view clipping.

The prompt side remains in pi-forge: `examples/minimal-prompt-stack.json` replaces Pi's system prompt with exactly `You are a helpful software engineer assistant.`, inserts chat history, omits compaction summaries from model context, and allows only those two tools.

## Install

This is a normal Pi tool extension, **not** a pi-forge trusted macro/slot module. Do not put it under `.pi/forge/extensions/`.

```bash
mkdir -p .pi/extensions/deepseek-minimal-tools
cp examples/deepseek-minimal-tools-extension/index.ts .pi/extensions/deepseek-minimal-tools/index.ts
cp examples/minimal-prompt-stack.json .pi/forge/prompt-stacks/minimal.json
```

Restart or reload Pi, trust the project if prompted, then run `/preset use minimal`.

## Fidelity boundary

Source-checked DSH minimal behavior: the complete system prompt is the one-line persona; the model receives `bash` plus `str_replace_editor`; runtime context, workspace instructions, skills, jobs, subagents, and compaction are absent from the minimal preset.

This Pi approximation intentionally does **not** claim DSH deployment guarantees that pi-forge cannot enforce. In particular:

- DSH uses a PTY-backed shell; this example uses a long-lived piped bash process. Basic cwd/environment persistence matches, but TTY detection, prompt control, and interactive job control differ.
- DSH's local filesystem and sandbox seam are not present. These tools run with the current OS user's permissions; `str_replace_editor` requires absolute paths but is not a sandbox.
- The stock DSH bash description claims no internet access and package mirrors. Those are deployment properties, not properties of this Pi extension, so they are omitted here.
- Pi may still perform session maintenance outside the model request. The stack's `includeSummaries: false` keeps compaction summaries out of the provider-bound context; it does not change Pi's session-storage behavior.

Without this optional tool extension, the Minimal stack still activates, but `str_replace_editor` is not registered and the effective model-visible tool surface falls short of the DSH shape.
