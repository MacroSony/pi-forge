import { showText } from "./preview.js";
import { requestForgeSubagentApproval } from "./subagent-tool.js";
export function registerForgeSubagentCommand(pi, runtime, profileIds) {
    pi.registerCommand("forge-agent", {
        description: "Plan or run a foreground human-approved read-only agent profile",
        getArgumentCompletions: (prefix) => completeForgeAgentArguments(prefix, profileIds()),
        handler: async (args, ctx) => {
            const parsed = parseForgeAgentArgs(args);
            if (parsed.command === "help") {
                await showText(ctx, "pi-forge agent backend", helpText());
                return;
            }
            if (parsed.command === "backends") {
                const lines = runtime.descriptors(ctx).map((descriptor) => [
                    `${descriptor.id} @ ${descriptor.version}`,
                    `  default boundary: shared-user subprocess with read-only model tools`,
                    `  prompt runtime: ${descriptor.capabilities.promptRuntimeFidelity}`,
                    `  cancellation: ${descriptor.capabilities.cancellation ? "yes" : "no"}`,
                    `  remote transport: ${descriptor.capabilities.remoteTransport ? "yes" : "no"}`,
                ].join("\n"));
                await showText(ctx, "pi-forge subagent backends", lines.join("\n\n") || "No subagent backends registered.");
                return;
            }
            if (!parsed.profileId || !parsed.task) {
                ctx.ui.notify(`Usage: /forge-agent ${parsed.command} <profile> <task>`, "warning");
                return;
            }
            if (parsed.command === "run" && !ctx.hasUI) {
                ctx.ui.notify("pi-forge: subagent execution requires interactive provider-egress confirmation; use /forge-agent plan in non-UI mode.", "error");
                return;
            }
            ctx.ui.setStatus("pi-forge-subagent", ctx.ui.theme.fg("accent", parsed.command === "plan" ? "agent:preparing" : "agent:running"));
            let prepared;
            try {
                const result = await runtime.prepare(parsed.profileId, parsed.task, ctx);
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
    const profileEnd = rest.search(/\s/);
    if (profileEnd === -1)
        return { command, profileId: rest || undefined };
    return { command, profileId: rest.slice(0, profileEnd), task: rest.slice(profileEnd).trim() || undefined };
}
function completeForgeAgentArguments(prefix, profileIds) {
    const trimmed = prefix.trimStart();
    if (!trimmed.includes(" ")) {
        return ["backends", "plan", "run"].filter((command) => command.startsWith(trimmed)).map((command) => ({ value: command, label: command }));
    }
    const match = trimmed.match(/^(plan|run)\s+(\S*)$/);
    if (!match)
        return null;
    const partial = match[2] ?? "";
    return profileIds.filter((id) => id.startsWith(partial)).map((id) => ({ value: `${match[1]} ${id}`, label: id }));
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
        "  /forge-agent plan <profile> <task>",
        "  /forge-agent run <profile> <task>",
        "",
        "plan prepares and validates the exact request without provider transport.",
        "run prepares the exact prompt, asks for human approval, then executes one foreground text task.",
        "The default child exposes read, grep, find, and ls only. It shares the invoking user's OS permissions and is not sandboxed.",
    ].join("\n");
}
//# sourceMappingURL=subagent-command.js.map