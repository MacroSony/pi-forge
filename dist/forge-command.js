import { FORGE_COMMAND_DISCOVERY_EVENT } from "./command-contribution/index.js";
import { showText } from "./preview.js";
export async function handleForgeUi(args, ctx, deps, usage = "/forge ui") {
    const value = args.trim();
    if (value === "help")
        return showText(ctx, "Forge UI", `${usage} [stop|restart]\nOpen the existing workspace, stop its server, or explicitly restart it.`);
    if (value && value !== "stop" && value !== "restart") {
        ctx.ui.notify(`Usage: ${usage} [stop|restart]`, "warning");
        return;
    }
    if (value === "stop")
        await deps.stopWebEditor(ctx);
    else
        await deps.openWebEditor(ctx, value === "restart" ? "restart" : "open");
}
/** Main owns /forge. Optional packages contribute only a child, never another root. */
export function registerForgeCommand(pi, deps, payload) {
    const builtins = Object.assign(Object.create(null), {
        ui: {
            description: "Open/stop/restart the Forge workspace",
            handler: (args, ctx) => handleForgeUi(args, ctx, deps),
            getArgumentCompletions: (prefix) => {
                if (/\s/.test(prefix.trim()))
                    return [];
                return ["stop", "restart", "help"].filter(s => s.startsWith(prefix.trim())).map(s => ({ value: s, label: s }));
            },
        },
        payload,
    });
    function discover() {
        const result = new Map();
        let accepting = true;
        pi.events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
            version: 1,
            provide(value) {
                if (!accepting || !value || typeof value.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.name)
                    || value.name === "help" || value.name in builtins || typeof value.handler !== "function"
                    || typeof value.description !== "string" || (value.getArgumentCompletions !== undefined && typeof value.getArgumentCompletions !== "function"))
                    return;
                result.set(value.name, [...(result.get(value.name) ?? []), value]);
            },
        });
        accepting = false; // This is synchronous local discovery; ignore late offers.
        return result;
    }
    pi.registerCommand("forge", {
        description: "Forge workspace, payload inspection and optional subagents; /forge help",
        getArgumentCompletions: async (prefix) => {
            const input = prefix.trimStart();
            const match = input.match(/^(\S+)(\s+)([\s\S]*)$/);
            const contributions = discover();
            if (!match)
                return ["help", ...Object.keys(builtins), ...[...contributions].filter(([, c]) => c.length === 1).map(([name]) => name)]
                    .filter(name => name.startsWith(input)).sort().map(name => ({ value: name, label: name }));
            const [, name, , rest] = match;
            const candidates = contributions.get(name);
            const child = builtins[name] ?? (candidates?.length === 1 ? candidates[0] : undefined);
            if (!child?.getArgumentCompletions)
                return [];
            try {
                const complete = child.getArgumentCompletions;
                const items = await complete(rest);
                // A plugin unloaded/replaced while an asynchronous completer was running.
                if (!builtins[name]) {
                    const now = discover().get(name);
                    if (now?.length !== 1 || now[0] !== child || now[0]?.getArgumentCompletions !== complete)
                        return [];
                }
                return items?.map(item => ({ ...item, value: `${name} ${item.value}` })) ?? [];
            }
            catch {
                return [];
            }
        },
        handler: async (args, ctx) => {
            const match = args.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/);
            const name = match?.[1] ?? "help";
            const rest = match?.[2] ?? "";
            const contributions = discover();
            if (name === "help") {
                if (rest.trim())
                    return ctx.ui.notify("Usage: /forge help", "warning");
                return showText(ctx, "Forge commands", [
                    "/forge ui [stop|restart] — workspace lifecycle",
                    "/forge payload next|status|cancel|help — request-hook inspection (does not itself call a model)",
                    ...[...contributions].map(([key, values]) => `/forge ${key} — ${values.length === 1 ? values[0].description : "unavailable: duplicate contributors"}`),
                    ...(!contributions.has("subagent") ? ["/forge subagent — requires matching @zihanw/pi-forge-subagents"] : []),
                    "", "/preset help — context presets", "/profile help — model/thinking/preset combinations",
                    "/capability help — session capabilities",
                    "Compatibility: /preset ui, /payload, and /intercept remain available; /forge-agent requires the optional package.",
                    "Legacy /subagent is a different low-level smoke helper, not the execution plan command.",
                ].join("\n"));
            }
            const candidates = contributions.get(name);
            if (candidates && candidates.length !== 1)
                return ctx.ui.notify(`pi-forge: ambiguous /forge ${name}; disable duplicate command contributors.`, "error");
            const child = builtins[name] ?? candidates?.[0];
            if (!child)
                return ctx.ui.notify(name === "subagent"
                    ? "pi-forge: /forge subagent requires the matching optional pi-forge-subagents package."
                    : `Unknown /forge subcommand: ${name}. Use /forge help.`, "warning");
            await child.handler(rest, ctx);
        },
    });
}
//# sourceMappingURL=forge-command.js.map