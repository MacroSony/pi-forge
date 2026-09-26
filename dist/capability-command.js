import { formatResourceKey } from "./resource-identity.js";
import { showText } from "./preview.js";
const CAPABILITY_USAGE = "/capability add <text> | list | bindings | enable <[scope:]id> | enable-bound <id> | disable <activation-id> | status | reset | help";
const CAPABILITY_VERBS = ["add", "list", "bindings", "enable", "enable-bound", "disable", "status", "reset", "help"];
export function registerCapabilityCommand(pi, runtime) {
    const command = {
        description: "Manage session capabilities (no inference)",
        getArgumentCompletions: (prefix) => capabilityArgumentCompletions(runtime, prefix),
        handler: async (args, ctx) => {
            await handleCapabilityCommand(runtime, args, ctx);
        },
    };
    pi.registerCommand("capability", command);
}
async function handleCapabilityCommand(runtime, args, ctx) {
    const { operation, value } = parseCapabilityInvocation(args);
    try {
        if (operation === "help") {
            if (value.trim())
                throw new Error(`Usage: ${CAPABILITY_USAGE}`);
            return await showText(ctx, "pi-forge capability help", capabilityHelp());
        }
        if (operation === "list") {
            assertNoValue(value);
            return await showText(ctx, "Capability library", runtime.library(ctx));
        }
        if (operation === "status") {
            assertNoValue(value);
            return await showText(ctx, "Session capabilities", runtime.status(ctx));
        }
        if (operation === "bindings") {
            assertNoValue(value);
            const res = runtime.readBindings(ctx);
            if (!res.ok)
                throw new Error(res.error);
            const content = res.bindings.length
                ? res.bindings
                    .map((b) => `${b.id}${b.modelCallable ? " [modelCallable]" : " [human-only]"}: ${formatResourceKey(b.ref)}${b.capability.name ? ` — ${b.capability.name}` : ""}`)
                    .join("\n")
                : "No capability bindings in active preset.";
            return await showText(ctx, "Preset capability bindings", content);
        }
        if (operation === "enable-bound") {
            assertSingleValue(value, "enable-bound <id>");
            const res = runtime.enableBound(ctx, value.trim(), "user");
            if (!res.ok)
                throw new Error(res.error);
            notify(ctx, res.message, "info");
            return;
        }
        if (operation !== "add" && operation !== "enable" && operation !== "disable" && operation !== "reset") {
            throw new Error(`Usage: ${CAPABILITY_USAGE}`);
        }
        if (operation === "reset") {
            assertNoValue(value);
        }
        else if (operation !== "add") {
            assertSingleValue(value, `${operation} <${operation === "disable" ? "activation-id" : "id"}>`);
        }
        else if (!value.trim()) {
            throw new Error("Usage: /capability add <text>");
        }
        const result = runtime.change(ctx, operation, operation === "add" ? value : value.trim());
        notify(ctx, result, "info");
    }
    catch (error) {
        const message = `pi-forge: ${error instanceof Error ? error.message : "Capability update failed."}`;
        if (ctx.hasUI)
            ctx.ui.notify(message, "error");
        else
            console.error(message);
    }
}
function capabilityArgumentCompletions(runtime, prefix) {
    const input = prefix.trimStart();
    if (!input)
        return CAPABILITY_VERBS.map((verb) => ({ value: verb, label: verb }));
    const match = input.match(/^(\S+)([\s\S]*)$/);
    if (!match)
        return CAPABILITY_VERBS.map((verb) => ({ value: verb, label: verb }));
    const operation = match[1];
    const remainder = match[2] ?? "";
    if (!remainder && !prefix.endsWith(" ")) {
        return CAPABILITY_VERBS
            .filter((verb) => verb.startsWith(operation))
            .map((verb) => ({ value: verb, label: verb }));
    }
    if (operation === "add")
        return null;
    if (!["enable", "enable-bound", "disable"].includes(operation))
        return [];
    const argument = remainder.trim();
    if (argument && /\s/.test(argument))
        return [];
    // The command API does not pass a context to completion callbacks. The
    // runtime retains only the current session context, and rejects a disposed
    // or cross-session view rather than exposing stale resources.
    const projected = runtime.completionView();
    if (!projected.ok)
        return [];
    if (operation === "enable") {
        const wantsScope = argument.includes(":");
        return projected.capabilities
            .map((candidate) => ({
            selector: wantsScope || candidate.collides ? candidate.id : candidate.bareId,
            label: candidate.label,
        }))
            .filter((candidate) => candidate.selector.startsWith(argument))
            .sort((a, b) => a.selector.localeCompare(b.selector))
            .map((candidate) => ({ value: `enable ${candidate.selector}`, label: candidate.label }));
    }
    if (operation === "enable-bound") {
        return projected.bindings
            .filter((candidate) => candidate.id.startsWith(argument))
            .map((candidate) => ({ value: `enable-bound ${candidate.id}`, label: candidate.label }));
    }
    return projected.active
        .filter((candidate) => candidate.id.startsWith(argument))
        .map((candidate) => ({ value: `disable ${candidate.id}`, label: candidate.label }));
}
function parseCapabilityInvocation(args) {
    const input = args.trimStart();
    if (!input)
        return { operation: "status", value: "" };
    const match = input.match(/^(\S+)([\s\S]*)$/);
    if (!match)
        return { operation: "status", value: "" };
    const operation = match[1];
    const remainder = match[2] ?? "";
    // Remove only the first syntax separator for add. The rest is user text,
    // including internal and trailing whitespace.
    return { operation, value: operation === "add" && remainder.startsWith(" ") ? remainder.slice(1) : remainder.trim() };
}
function assertNoValue(value) {
    if (value.trim())
        throw new Error(`Usage: ${CAPABILITY_USAGE}`);
}
function assertSingleValue(value, usage) {
    const trimmed = value.trim();
    if (!trimmed || /\s/.test(trimmed))
        throw new Error(`Usage: /capability ${usage}`);
}
function notify(ctx, message, level) {
    if (ctx.hasUI)
        ctx.ui.notify(message, level);
    else if (level === "error")
        console.error(message);
    else
        console.log(message);
}
function capabilityHelp() {
    return [
        "Usage:",
        `  ${CAPABILITY_USAGE}`,
        "",
        "add preserves the free-form text after the command and does not infer a capability ID.",
        "enable completions offer bare IDs when unique, qualified selectors on collision or when ':' is typed.",
        "enable-bound completes bindings saved on the current active preset, including human-only bindings.",
        "disable completes exact active activation IDs; the label identifies the source and actor.",
        "Completions use the current session and last published workspace snapshot only.",
        "Run /capability list to explicitly reload the capability library; no watcher or per-keystroke scan is used.",
    ].join("\n");
}
//# sourceMappingURL=capability-command.js.map