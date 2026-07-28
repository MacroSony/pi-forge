import { Type } from "typebox";
import { DEFAULT_SUBAGENT_TIMEOUT_MS, loadForgeSubagentSettings, resolveSubagentBackend, } from "./forge-config.js";
import { isResolvedAgentProfileUsable, } from "./agent-profile.js";
const MAX_VISIBLE_DESCRIPTION_CHARS = 1_000;
const ForgeSubagentProfilesParameters = Type.Object({});
export function registerForgeSubagentProfilesTool(pi, profiles, resolveProfile) {
    pi.registerTool({
        name: "forge_subagent_profiles",
        label: "Forge Subagent Profiles",
        description: [
            "List the currently loaded Pi Forge subagent profiles, descriptions, default backend, and active approval mode.",
            "Use this before forge_subagent when the user has not already specified a profile ID.",
            "This reads only in-memory profile metadata and performs no provider request or subagent prompt preparation.",
        ].join(" "),
        parameters: ForgeSubagentProfilesParameters,
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!ctx.isProjectTrusted()) {
                return result("Subagent profile discovery is disabled because the project is not trusted.", {
                    status: "disabled",
                    invocationToolAvailable: false,
                    approvalMode: "interactive",
                    timeout: { milliseconds: DEFAULT_SUBAGENT_TIMEOUT_MS, source: "built-in" },
                    configWarnings: [],
                    profiles: [],
                });
            }
            const invocationToolAvailable = pi.getActiveTools().includes("forge_subagent");
            const settings = loadForgeSubagentSettings(ctx);
            const approvalMode = settings.allowAgentInvocationWithoutApproval ? "unattended-config" : "interactive";
            const defaultBackend = resolveSubagentBackend(settings);
            const summaries = profiles().map((loaded) => summarizeProfile(loaded, resolveProfile(loaded, ctx)));
            const timeout = { milliseconds: settings.timeoutMs, source: settings.timeoutSource };
            return result(renderProfileCatalog(summaries, invocationToolAvailable, approvalMode, settings.warnings, defaultBackend, timeout), { status: "completed", invocationToolAvailable, approvalMode, defaultBackend, timeout, configWarnings: settings.warnings, profiles: summaries });
        },
    });
}
export function summarizeProfile(loaded, resolved) {
    return {
        id: loaded.profile.id,
        name: loaded.profile.name,
        description: loaded.profile.description,
        model: structuredClone(loaded.profile.model),
        thinkingLevel: loaded.profile.thinkingLevel,
        promptStack: loaded.profile.promptStack,
        status: isResolvedAgentProfileUsable(resolved) ? "ready" : "unavailable",
        diagnostics: structuredClone(resolved.diagnostics),
    };
}
export function renderProfileCatalog(profiles, invocationToolAvailable, approvalMode = "interactive", configWarnings = [], defaultBackend, timeout) {
    if (profiles.length === 0) {
        return [
            `No Pi Forge subagent profiles are currently loaded. Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive"}. Approval mode: ${approvalMode}.`,
            ...(defaultBackend ? [`Default backend: ${defaultBackend.id} (${defaultBackend.source}).`] : []),
            ...(timeout ? [`Timeout: ${timeout.milliseconds} ms (${timeout.source}; best-effort host abort).`] : []),
            ...configWarnings.map((warning) => `Configuration warning: ${warning}`),
        ].join("\n");
    }
    const ready = profiles.filter((profile) => profile.status === "ready");
    const unavailable = profiles.filter((profile) => profile.status === "unavailable");
    const lines = [
        `Pi Forge subagent profiles: ${ready.length} ready, ${unavailable.length} unavailable.`,
        `Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive; the current tool policy must permit forge_subagent before the main agent can invoke a profile"}.`,
        approvalMode === "unattended-config"
            ? "Approval mode: unattended-config; exact backend preflight still runs, but forge_subagent may contact the provider without per-run human approval."
            : "Approval mode: interactive; a ready profile still undergoes exact backend preflight and per-run human approval.",
    ];
    if (defaultBackend)
        lines.push(`Default backend: ${defaultBackend.id} (${defaultBackend.source}); the interactive forge_subagent backend parameter or /forge-agent --backend overrides it per run.`);
    if (timeout)
        lines.push(`Timeout: ${timeout.milliseconds} ms (${timeout.source}; best-effort host abort).`);
    if (configWarnings.length > 0)
        lines.push(...configWarnings.map((warning) => `Configuration warning: ${warning}`));
    if (ready.length > 0) {
        lines.push("", "Ready profiles:");
        for (const profile of ready)
            lines.push(...renderProfile(profile));
    }
    if (unavailable.length > 0) {
        lines.push("", "Unavailable profiles:");
        for (const profile of unavailable)
            lines.push(...renderProfile(profile, true));
    }
    return lines.join("\n");
}
function renderProfile(profile, includeErrors = false) {
    const title = `- ${profile.id}${profile.name ? ` — ${compact(profile.name)}` : ""}`;
    const description = profile.description ? truncate(compact(profile.description), MAX_VISIBLE_DESCRIPTION_CHARS) : "(no description provided)";
    const lines = [
        title,
        `  Description: ${description}`,
        `  Model: ${profile.model.provider}/${profile.model.id}; thinking: ${profile.thinkingLevel}; stack: ${profile.promptStack ?? "none"}`,
    ];
    if (includeErrors) {
        const errors = profile.diagnostics.filter((diagnostic) => diagnostic.level === "error");
        lines.push(`  Unavailable because: ${errors.map((diagnostic) => diagnostic.message).join("; ") || "profile resolution failed"}`);
    }
    return lines;
}
function result(text, details) {
    return { content: [{ type: "text", text }], details: structuredClone(details) };
}
function compact(value) {
    return value.replace(/\s+/g, " ").trim();
}
function truncate(value, maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
//# sourceMappingURL=subagent-profile-tool.js.map