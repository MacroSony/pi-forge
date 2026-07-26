import { loadForgeSubagentSettings, resolveSubagentBackend } from "./forge-config.js";
import { showText } from "./preview.js";
import { requestForgeSubagentApproval } from "./subagent-tool.js";
export function registerForgeSubagentCommand(pi, runtime, profileIds) {
    pi.registerCommand("forge-agent", {
        description: "Plan or run a foreground human-approved read-only agent profile",
        getArgumentCompletions: (prefix) => completeForgeAgentArguments(prefix, profileIds(), runtime.backendIds()),
        handler: async (args, ctx) => {
            const parsed = parseForgeAgentArgs(args);
            if (parsed.command === "help") {
                await showText(ctx, "pi-forge agent backend", helpText());
                return;
            }
            const settings = loadForgeSubagentSettings(ctx);
            if (parsed.command === "backends") {
                const resolved = resolveSubagentBackend(settings);
                const descriptors = runtime.descriptors(ctx);
                const lines = descriptors.map((descriptor) => [
                    `${descriptor.id} @ ${descriptor.version}${descriptor.id === resolved.id ? ` (default: ${backendSourceLabel(resolved)})` : ""}`,
                    `  default boundary: shared-user subprocess with read-only model tools`,
                    `  prompt runtime: ${descriptor.capabilities.promptRuntimeFidelity}`,
                    `  cancellation: ${descriptor.capabilities.cancellation ? "yes" : "no"}`,
                    `  remote transport: ${descriptor.capabilities.remoteTransport ? "yes" : "no"}`,
                ].join("\n"));
                if (!descriptors.some((descriptor) => descriptor.id === resolved.id)) {
                    lines.push(`Configured default backend "${resolved.id}" (${backendSourceLabel(resolved)}) is not registered.`);
                }
                for (const warning of settings.warnings)
                    lines.push(`Configuration warning: ${warning}`);
                await showText(ctx, "pi-forge subagent backends", lines.join("\n\n") || "No subagent backends registered.");
                return;
            }
            if (parsed.error) {
                ctx.ui.notify(`pi-forge: ${parsed.error}`, "warning");
                return;
            }
            if (!parsed.profileId || !parsed.task) {
                ctx.ui.notify(`Usage: /forge-agent ${parsed.command} <profile> [--backend <id>] <task>`, "warning");
                return;
            }
            if (parsed.command === "run" && !ctx.hasUI) {
                ctx.ui.notify("pi-forge: subagent execution requires interactive provider-egress confirmation; use /forge-agent plan in non-UI mode.", "error");
                return;
            }
            ctx.ui.setStatus("pi-forge-subagent", ctx.ui.theme.fg("accent", parsed.command === "plan" ? "agent:preparing" : "agent:running"));
            let prepared;
            try {
                const backend = resolveSubagentBackend(settings, parsed.backend);
                const result = await runtime.prepare(parsed.profileId, parsed.task, ctx, { backendId: backend.id });
                if (!result.ok) {
                    await showText(ctx, "pi-forge subagent diagnostics", renderDiagnostics(result.diagnostics));
                    return;
                }
                prepared = result.prepared;
                if (parsed.command === "plan") {
                    await showText(ctx, `pi-forge subagent plan: ${parsed.profileId}`, renderPlan(prepared));
                    await runtime.discard(prepared);
                    prepared = undefined;
                    return;
                }
                const approval = await requestForgeSubagentApproval(prepared, parsed.task, ctx, ctx.signal);
                if (!approval.approved) {
                    await runtime.discard(prepared);
                    prepared = undefined;
                    ctx.ui.notify("pi-forge: subagent run cancelled before provider transport.", "info");
                    return;
                }
                const response = await runtime.execute(prepared, ctx, ctx.signal);
                prepared = undefined;
                runtime.takeReport?.(response.runId);
                await showText(ctx, `pi-forge subagent result: ${parsed.profileId}`, renderResponse(response));
            }
            catch (error) {
                if (prepared)
                    await runtime.discard(prepared).catch(() => undefined);
                ctx.ui.notify(`pi-forge subagent failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
            finally {
                ctx.ui.setStatus("pi-forge-subagent", undefined);
            }
        },
    });
}
function parseForgeAgentArgs(args) {
    const trimmed = args.trim();
    if (!trimmed)
        return { command: "help" };
    const firstSpace = trimmed.search(/\s/);
    const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
    if (command === "backends")
        return { command: "backends" };
    if (command !== "plan" && command !== "run")
        return { command: "help" };
    const positional = [];
    let backend;
    const tokens = rest ? rest.split(/\s+/) : [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === "--backend") {
            const value = tokens[index + 1];
            if (!value || value.startsWith("--"))
                return { command, error: "--backend requires a backend id value." };
            backend = value;
            index++;
            continue;
        }
        if (token.startsWith("--backend=")) {
            const value = token.slice("--backend=".length);
            if (!value)
                return { command, error: "--backend requires a backend id value." };
            backend = value;
            continue;
        }
        if (token.startsWith("--"))
            return { command, error: `Unknown option: ${token}` };
        positional.push(token);
    }
    const [profileId, ...taskTokens] = positional;
    return { command, profileId: profileId || undefined, task: taskTokens.join(" ") || undefined, ...(backend ? { backend } : {}) };
}
function completeForgeAgentArguments(prefix, profileIds, backendIds) {
    const trimmed = prefix.trimStart();
    if (!trimmed.includes(" ")) {
        return ["backends", "plan", "run"].filter((command) => command.startsWith(trimmed)).map((command) => ({ value: command, label: command }));
    }
    const commandMatch = trimmed.match(/^(plan|run)\s+(.*)$/);
    if (!commandMatch)
        return null;
    const rest = commandMatch[2] ?? "";
    const tokens = rest.split(/\s+/);
    const last = tokens[tokens.length - 1] ?? "";
    const previous = tokens[tokens.length - 2];
    if (previous === "--backend" || previous?.startsWith("--backend=")) {
        const head = trimmed.slice(0, trimmed.length - last.length);
        return backendIds.filter((id) => id.startsWith(last)).map((id) => ({ value: `${head}${id}`, label: id }));
    }
    if (tokens.length === 1) {
        const partial = tokens[0] ?? "";
        return profileIds.filter((id) => id.startsWith(partial)).map((id) => ({ value: `${commandMatch[1]} ${id}`, label: id }));
    }
    if (last.startsWith("-") && "--backend".startsWith(last)) {
        const head = trimmed.slice(0, trimmed.length - last.length);
        return [{ value: `${head}--backend `, label: "--backend" }];
    }
    return null;
}
function backendSourceLabel(backend) {
    switch (backend.source) {
        case "explicit": return "per-run override";
        case "project": return "project config";
        case "global": return "global config";
        default: return "built-in";
    }
}
function renderPlan(prepared) {
    const plan = prepared.plan;
    return [
        `Backend: ${plan.backendId}`,
        `Model: ${plan.model.provider}/${plan.model.id}`,
        `Thinking: ${plan.thinkingLevel}`,
        `Profile: ${plan.profile.profile.id}`,
        `Prompt stack: ${plan.profile.promptStack?.id ?? "none"}`,
        `Access: ${plan.access.level}; network ${plan.access.network}; process ${plan.access.process ? "allowed" : "denied"}`,
        `Effective tools: ${plan.effectiveToolIds.join(", ") || "none"}`,
        `System prompt: ${plan.systemPrompt.length} chars`,
        `Messages: ${plan.messages.map((message) => `${message.role}${message.protectedTask ? " (protected task)" : ""}`).join(" -> ")}`,
        `Runtime fingerprint: ${plan.promptRuntimeFingerprint}`,
        `Execution fingerprint: ${plan.executionFingerprint}`,
        "Provider transport: not started; dry plan discarded.",
        "",
        "Diagnostics:",
        renderDiagnostics(prepared.diagnostics),
    ].join("\n");
}
function renderResponse(response) {
    const lines = [
        `Status: ${response.status}`,
        `Backend: ${response.backendId}`,
        `Model: ${response.model.provider}/${response.model.id}`,
        `Duration: ${response.durationMs} ms`,
        `Effective tools: ${response.effectiveToolIds.join(", ") || "none"}`,
    ];
    if (response.status === "failed")
        lines.push(`Error: ${response.error.code}: ${response.error.message}`);
    if (response.status === "cancelled" || response.status === "timed-out")
        lines.push(`Reason: ${response.reason}`);
    if (response.status === "limit-reached")
        lines.push(`Reached limit: ${response.reachedLimit}`);
    if (response.output?.text)
        lines.push("", "Output:", response.output.text);
    return lines.join("\n");
}
function renderDiagnostics(diagnostics) {
    if (diagnostics.length === 0)
        return "No diagnostics.";
    return diagnostics.map((diagnostic) => `${diagnostic.level.toUpperCase()} ${diagnostic.code}${diagnostic.path ? ` [${diagnostic.path}]` : ""}: ${diagnostic.message}`).join("\n");
}
function helpText() {
    return [
        "Foreground read-only subprocess agent commands:",
        "",
        "  /forge-agent backends",
        "  /forge-agent plan <profile> [--backend <id>] <task>",
        "  /forge-agent run <profile> [--backend <id>] <task>",
        "",
        "plan prepares and validates the exact request without provider transport.",
        "run prepares the exact prompt, asks for human approval, then executes one foreground text task.",
        "The default child exposes read, grep, find, and ls only. It shares the invoking user's OS permissions and is not sandboxed.",
        "",
        "Backend selection: --backend overrides one run. Set subagents.backend in .pi/forge/config.json",
        "(trusted project) or ~/.pi/forge/config.json (global default; project wins). There is no fallback:",
        "if the selected backend is unavailable the run fails before provider transport.",
    ].join("\n");
}
//# sourceMappingURL=subagent-command.js.map