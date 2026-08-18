# Custom System Status Extension

This example shows how trusted pi-forge extension modules can register a custom macro and custom slot without importing `@zihanw/pi-forge` from a loose Pi extension file.

It registers:

- `{{ extensions.cpuLoad }}` macro: one-line CPU load summary.
- `machine-status` slot: CPU load, OS load average, memory, and uptime snapshot.

The renderers are synchronous, so this example uses Node's OS load average and memory APIs. It is a rough machine-load signal, not an async sampled CPU-utilization profiler.

## Try It

Install or load pi-forge, then copy the extension module and stack into a trusted project:

```bash
mkdir -p .pi/forge/extensions .pi/forge/prompt-stacks
cp examples/custom-system-status-extension/index.ts .pi/forge/extensions/system-status.ts
cp examples/custom-system-status-extension/prompt-stack.json .pi/forge/prompt-stacks/custom-system-status.json
```

Start Pi, trust the project if prompted, then run:

```text
/preset reload
/preset use custom-system-status
```

Use `/preset diagnostics` to confirm the extension file is listed under loaded pi-forge extensions.

## Where To Put The Extension

pi-forge loads trusted registration modules from a global location and the current project:

```text
~/.pi/forge/extensions/
.pi/forge/extensions/
```

Use `~/.pi/forge/extensions/` for personal machine-wide macros and slots. Use `.pi/forge/extensions/` when the customization should travel with the project's prompt stacks.

Supported entries:

- `~/.pi/forge/extensions/system-status.ts`
- `.pi/forge/extensions/system-status.ts`
- `.pi/forge/extensions/system-status.js`
- `.pi/forge/extensions/system-status.mjs`
- `.pi/forge/extensions/system-status.cjs`
- `.pi/forge/extensions/system-status/index.ts`
- `.pi/forge/extensions/system-status/index.js`

Each module exports a default function or named `register` function:

```ts
export default function register(api) {
  api.registerMacro({ name: "cpuLoad", dependencies: [], render: ({ env, helpers }) => "..." });
  api.registerSlot({ name: "machine-status", render: () => "..." });
}
```

pi-forge passes the registration API into the function, tracks unregister callbacks, and unregisters previous definitions before reloading the folder. If the extension is not loaded, the stack can still be read, but `machine-status` will validate as an unsupported slot and `{{ extensions.cpuLoad }}` will remain an unresolved extension path.

Only use this folder for trusted code. These modules execute with normal local code permissions after the project is trusted.

## Stack Reference

The stack references the custom slot declaratively:

```json
{
  "kind": "slot",
  "id": "machine-status",
  "enabled": true,
  "role": "system",
  "slot": "machine-status",
  "options": {
    "format": "plain",
    "heading": "Runtime machine snapshot",
    "includeMemory": true,
    "includeUptime": true
  }
}
```

Only the extension file contains executable code. The prompt stack just selects the registered slot and passes options.
