# Custom macros and slots

[Documentation](../README.md)

Custom macros and slots are registered by trusted extension code, never embedded as executable code in prompt-stack JSON.

Put small project registrations in `.pi/forge/extensions/` and machine-wide personal registrations in `~/.pi/forge/extensions/`. Global modules load first, then project modules, after trust and before stack validation. Both locations reload with `/preset reload`.

## Registration module

Modules receive the pi-forge API directly, so they do not need to import the package:

```ts
// .pi/forge/extensions/ticket-context.ts
export default function register(api) {
  api.registerMacro({
    name: "ticketId",
    description: "Current ticket id from static parameters.",
    dependencies: ["parameters.ticket.id"],
    render: ({ env, helpers }) => String(env.parameters["ticket.id"]),
  });

  api.registerSlot({
    name: "ticket-context",
    description: "Render ticket context for the current task.",
    options: {
      heading: { type: "string", default: "Ticket context" },
    },
    render: ({ item, options, env, helpers }) => [
      String(options.heading ?? "Ticket context") + ":",
      "- Ticket: " + String(env.parameters["ticket.id"]),
      "- Project: " + helpers.normalizePath(String(env.runtime.cwd)),
    ].join("\n"),
  });
}
```

Use the slot declaratively:

```json
{
  "kind": "slot",
  "id": "ticket-context",
  "enabled": true,
  "role": "system",
  "slot": "ticket-context",
  "options": { "heading": "Current ticket" }
}
```

## Module rules

- Supported files are `.ts`, `.js`, `.mjs`, `.cjs`, and `index.*` inside a subdirectory.
- TypeScript should use syntax Node can strip at runtime; otherwise use JavaScript or precompile it.
- Export `default function register(api)` or named `register(api)`.
- Names must be unique across built-ins, global extensions, and project extensions.
- Duplicate names and load failures appear in diagnostics.
- Missing custom slots are validation warnings until their module is loaded.
- Registration ownership is disposed when the runtime shuts down.

The API provides `forgeDir`, `extensionPath`, helpers, registration functions, and `getRegisteredMacros()` / `getRegisteredSlots()`. Custom macro renderers receive a frozen `{ env, helpers }` and dependencies from the declaration. Global `forgeDir` is `~/.pi/forge`; project `forgeDir` is `<project>/.pi/forge`.

Reusable Pi packages may import `registerMacro` and `registerSlot` from `@zihanw/pi-forge`. The directory loaders are intended for small trusted customizations without package boilerplate.

## Security

Registration modules execute with the Pi process's user permissions. Load them only from code you trust. Stack JSON remains declarative and cannot register executable behavior by itself.

For a copyable example, see [custom-system-status-extension](../../examples/custom-system-status-extension/README.md). For built-ins, see [macros and slots](../reference/macros-and-slots.md).
