import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { showText } from "./preview.js";
import { createProviderPayloadCaptureWithSerialization } from "./payload-capture.js";
import { appendContextDiffCapture, attachContextDiffUsage, createContextDiffHistory } from "./context-diff-history.js";
export function registerPayloadCommands(pi, state) {
    const command = {
        description: "Inspect the next provider-hook payload; canonical /forge payload, not an HTTP interception proxy",
        getArgumentCompletions: (prefix) => {
            const parts = prefix.trimStart().split(/\s+/);
            if (parts.length === 1)
                return ["next", "status", "cancel", "help"].filter(s => s.startsWith(parts[0] ?? "")).map(s => ({ value: s, label: s }));
            if (parts[0] !== "next")
                return [];
            const suggestion = "save=.pi/forge/payloads/last.json";
            if (parts.length === 2)
                return suggestion.startsWith(parts[1] ?? "") ? [{ value: `next ${suggestion}`, label: suggestion }] : [];
            if (parsePayloadNext(prefix.replace(/^\s*next\s+/, "").replace(/\s+--[\w-]*$/, ""))?.savePath && !prefix.includes("--overwrite") && /^--/.test(parts.at(-1) ?? "")) {
                return "--overwrite".startsWith(parts.at(-1)) ? [{ value: prefix.slice(0, prefix.length - parts.at(-1).length) + "--overwrite", label: "--overwrite" }] : [];
            }
            return [];
        },
        handler: async (args, ctx) => {
            const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
            const op = match?.[1] ?? "next", rest = match?.[2] ?? "";
            if (["status", "cancel", "help"].includes(op)) {
                if (rest)
                    return ctx.ui.notify("Usage: /forge payload next [save=<path>] [--overwrite] | status | cancel | help", "warning");
                if (op === "cancel") {
                    const armed = state.interceptNextProviderPayload;
                    state.interceptNextProviderPayload = false;
                    state.interceptPayloadSavePath = undefined;
                    state.interceptPayloadOverwrite = undefined;
                    state.interceptPayloadDisplayTarget = "editor";
                    state.payloadCaptureArmedAt = undefined;
                    ctx.ui.setStatus("pi-forge-intercept", undefined);
                    ctx.ui.notify(armed ? "pi-forge: pending payload capture cancelled; retained captures/history unchanged." : "pi-forge: no pending payload capture.", "info");
                    return;
                }
                return showText(ctx, "Forge payload", op === "status"
                    ? `Capture: ${state.interceptNextProviderPayload ? "armed" : "idle"}\nSave: ${state.interceptPayloadSavePath ?? "(none)"}\nLatest capture: ${state.latestProviderPayloadCapture ? "available" : "(none)"}`
                    : '/forge payload next [save=<path>] [--overwrite] | status | cancel | help\nQuote paths containing spaces: next save="path with spaces.json"\nExisting files require --overwrite. Arming does not call a model.\nCapture occurs at before_provider_request; later plugin shaping may change the final wire body.\n/payload and /intercept remain compatibility entries; bare /payload arms next.');
            }
            if (op !== "next")
                return ctx.ui.notify(`Unknown /payload subcommand: ${op}. Use /forge payload help.`, "warning");
            const parsed = parsePayloadNext(rest);
            if (!parsed)
                return ctx.ui.notify('Usage: /forge payload next [save=<path>] [--overwrite]; quote paths containing spaces.', "warning");
            if (parsed.savePath) {
                if (!ctx.isProjectTrusted())
                    return ctx.ui.notify("pi-forge: project is not trusted; refusing to save provider payload.", "warning");
                const path = parsed.savePath.startsWith("/") ? parsed.savePath : join(ctx.cwd, parsed.savePath);
                if (!parsed.overwrite && existsSync(path))
                    return ctx.ui.notify("pi-forge: payload file exists; use a new path or explicit --overwrite.", "warning");
            }
            armPayloadIntercept(state, ctx, parsed.savePath);
            state.interceptPayloadOverwrite = parsed.overwrite;
        },
    };
    pi.registerCommand("payload", command);
    pi.registerCommand("intercept", {
        description: "Compatibility shortcut for /forge payload next",
        handler: async (args, ctx) => {
            if (args.trim())
                return ctx.ui.notify("Usage: /intercept (or /forge payload help)", "warning");
            armPayloadIntercept(state, ctx);
        },
    });
    return command;
}
function parsePayloadNext(rest) {
    if (!rest.trim())
        return { overwrite: false };
    const match = rest.trim().match(/^save=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+?))(?:\s+(--overwrite))?$/);
    if (!match)
        return undefined;
    const savePath = match[1] ?? match[2] ?? match[3];
    if (!savePath || /[\x00\r\n]/.test(savePath) || savePath.startsWith('"') || savePath.startsWith("'"))
        return undefined;
    return { savePath, overwrite: Boolean(match[4]) };
}
export function registerPayloadRequestHandler(pi, state, getActive) {
    pi.on("before_provider_request", async (event, ctx) => {
        const wasArmed = state.interceptNextProviderPayload;
        const savePath = state.interceptPayloadSavePath;
        const overwrite = state.interceptPayloadOverwrite === true;
        const displayTarget = state.interceptPayloadDisplayTarget;
        const capture = captureProviderPayload(state, getActive(), event.payload, savePath);
        if (!wasArmed)
            return;
        state.interceptNextProviderPayload = false;
        state.interceptPayloadSavePath = undefined;
        state.interceptPayloadOverwrite = undefined;
        state.interceptPayloadDisplayTarget = "editor";
        state.payloadCaptureArmedAt = undefined;
        state.latestProviderPayloadCapture = capture;
        ctx.ui.setStatus("pi-forge-intercept", undefined);
        if (savePath) {
            if (!ctx.isProjectTrusted()) {
                ctx.ui.notify("pi-forge: project is not trusted; refusing to save provider payload.", "warning");
            }
            else {
                const resolvedPath = savePath.startsWith("/") ? savePath : join(ctx.cwd, savePath);
                try {
                    mkdirSync(dirname(resolvedPath), { recursive: true });
                    writeFileSync(resolvedPath, capture.text, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
                    ctx.ui.notify(`pi-forge: provider payload saved to ${resolvedPath} (${capture.chars} chars, ~${capture.approxTokens} tokens)`, "info");
                }
                catch (error) {
                    ctx.ui.notify(`pi-forge: payload captured but NOT saved: ${error instanceof Error ? error.message : String(error)}`, "error");
                }
            }
        }
        if (displayTarget === "web") {
            ctx.ui.notify(`pi-forge: provider payload captured for web editor (${capture.chars} chars, ~${capture.approxTokens} tokens).`, "info");
            return;
        }
        if (ctx.hasUI) {
            await ctx.ui.editor(`pi-forge: provider payload (${capture.chars} chars, ~${capture.approxTokens} tokens)`, capture.text);
            return;
        }
        console.log(capture.text);
    });
}
export function recordProviderResponseUsage(state, message) {
    const turnId = state.pendingContextDiffUsageTurnIds.shift();
    if (!turnId)
        return;
    const usage = message.usage;
    attachContextDiffUsage(state.contextDiffHistory, turnId, {
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        input: finiteUsage(usage.input),
        output: finiteUsage(usage.output),
        cacheRead: finiteUsage(usage.cacheRead),
        cacheWrite: finiteUsage(usage.cacheWrite),
        totalTokens: finiteUsage(usage.totalTokens),
    });
}
export function armPayloadIntercept(state, ctx, savePath, displayTarget = "editor") {
    state.interceptNextProviderPayload = true;
    state.interceptPayloadSavePath = savePath;
    state.interceptPayloadOverwrite = undefined;
    state.interceptPayloadDisplayTarget = displayTarget;
    state.payloadCaptureArmedAt = new Date().toISOString();
    state.latestProviderPayloadCapture = undefined;
    ctx.ui.setStatus("pi-forge-intercept", ctx.ui.theme.fg("warning", savePath ? "payload:armed+save" : "payload:armed"));
    if (displayTarget === "web") {
        ctx.ui.notify(savePath ? `pi-forge: next provider payload will be captured in the web editor and saved to ${savePath}.` : "pi-forge: next provider payload will be captured in the web editor.", "info");
        return;
    }
    ctx.ui.notify(savePath ? `pi-forge: next provider payload will be displayed and saved to ${savePath}.` : "pi-forge: next provider payload will be displayed before sending.", "info");
}
export function clearPayloadCapture(state, ctx) {
    state.interceptNextProviderPayload = false;
    state.interceptPayloadSavePath = undefined;
    state.interceptPayloadOverwrite = undefined;
    state.interceptPayloadDisplayTarget = "editor";
    state.payloadCaptureArmedAt = undefined;
    state.latestProviderPayloadCapture = undefined;
    state.contextDiffHistory = createContextDiffHistory();
    state.pendingContextDiffUsageTurnIds = [];
    ctx.ui.setStatus("pi-forge-intercept", undefined);
}
export function webPayloadSnapshot(state) {
    if (state.interceptNextProviderPayload) {
        return {
            status: "armed",
            armedAt: state.payloadCaptureArmedAt,
            savePath: state.interceptPayloadSavePath,
        };
    }
    if (state.latestProviderPayloadCapture) {
        return {
            status: "captured",
            capture: state.latestProviderPayloadCapture,
        };
    }
    return { status: "idle" };
}
function captureProviderPayload(state, active, value, savePath) {
    const { capture, serializedPayload } = createProviderPayloadCaptureWithSerialization(value, {
        stackId: active?.stack.id,
        savePath,
    });
    appendContextDiffCapture(state.contextDiffHistory, { ...capture, serializedPayload });
    const turnId = state.contextDiffHistory.turns.at(-1)?.turnId;
    if (turnId)
        state.pendingContextDiffUsageTurnIds.push(turnId);
    return capture;
}
function finiteUsage(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
//# sourceMappingURL=payload-command.js.map