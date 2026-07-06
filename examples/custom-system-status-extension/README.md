# Custom System Status Extension

This example shows how trusted extension code can register a pi-forge custom macro and custom slot.

It registers:

- `{{cpuLoad}}` macro: one-line CPU load summary.
- `machine-status` slot: CPU load, OS load average, memory, and uptime snapshot.

The renderers are synchronous, so this example uses Node's OS load average and memory APIs. It is a rough machine-load signal, not an async sampled CPU-utilization profiler.

## Try It Quickly

From a project where `@zihanw/pi-forge` is installed:

```bash
pi -e ./examples/custom-system-status-extension/index.ts
```

When developing from a local pi-forge checkout without installing the package, run the example in place from this repository. The extension falls back to `../../src/index.ts`.

If you copy the extension into another project's `.pi/extensions/` folder while pi-forge itself is loaded from a local checkout, point the extension at that same checkout:

```bash
PI_FORGE_MODULE=/path/to/pi-forge/src/index.ts pi
```

Replace `/path/to/pi-forge` with the local checkout that matches the pi-forge extension you load from `settings.json`.

Then copy `prompt-stack.json` into your project's prompt-stack folder:

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/custom-system-status-extension/prompt-stack.json .pi/forge/prompt-stacks/custom-system-status.json
```

Use `/preset reload`, then `/preset use custom-system-status`.

## Where To Put The Extension

Use one of Pi's trusted extension locations:

- Project-local: `.pi/extensions/system-status/index.ts`
- Global: `~/.pi/agent/extensions/system-status/index.ts`
- Package-managed: a Pi package with a `pi.extensions` entry in `package.json`

For project-local use:

```bash
mkdir -p .pi/extensions/system-status
cp examples/custom-system-status-extension/index.ts .pi/extensions/system-status/index.ts
```

Project-local extensions load only after the project is trusted. If the extension is not loaded, the stack can still be read, but `machine-status` will validate as an unsupported slot and `{{cpuLoad}}` will remain an unresolved macro.

If the extension fails with `Cannot find module '@zihanw/pi-forge'`, pi-forge is not installed as a package visible to this extension. Either install/load pi-forge as a package, run the example in place from the pi-forge checkout, or set `PI_FORGE_MODULE` to the local `src/index.ts` path of the checkout that Pi is loading.

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
