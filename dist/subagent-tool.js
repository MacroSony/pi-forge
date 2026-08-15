import { getMarkdownTheme, } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "./forge-config.js";
import { summarizeProfile } from "./subagent-profile-tool.js";
import { sanitizePiSubprocessRunReport, } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { isRecord } from "@zihanw/pi-subagent-runtime";
const APPROVE = "Approve and run";
const VIEW_FULL_PROMPT = "View full prompt";
const REJECT = "Reject";
const MAX_PROGRESS_ITEMS = 100;
const MAX_APPROVAL_TASK_PREVIEW_CHARS = 48;
const MAX_APPROVAL_EXECUTION_PREVIEW_CHARS = 44;
const MAX_APPROVAL_PATH_PREVIEW_CHARS = 44;
const MAX_APPROVAL_FINGERPRINT_PREVIEW_CHARS = 24;
const MAX_EMBEDDED_PROFILES = 8;
const MAX_EMBEDDED_SUMMARY_CHARS = 1_000;
const ForgeSubagentParameters = Type.Object({
    profileId: Type.String({
        minLength: 1,
        description: "ID of a Pi Forge agent profile explicitly enabled for subagent delegation.",
    }),
    task: Type.String({
        minLength: 1,
        description: "The focused task to delegate to the subagent.",
    }),
    backend: Type.Optional(Type.String({
        minLength: 1,
        description: "Backend ID to prepare and execute through (see /forge-agent backends). Honored only for interactively approved runs; trusted-project unattended invocation always uses the configured default backend.",
    })),
});
export function registerForgeSubagentTool(pi, runtime, profileIds, options = {}) {
    // The description is static at registration time; re-registering the tool
    // by name replaces its definition and refreshes the tool registry. Track
    // the last embedded summary so lifecycle refreshes (every turn included)
    // are no-ops unless the profile summary actually changed.
    let lastSummary;
    function register(embedded) {
        pi.registerTool({
            name: "forge_subagent",
            label: "Forge Subagent",
            description: forgeSubagentToolDescription(embedded),
            parameters: ForgeSubagentParameters,
            // Parallel execution lets the parent model issue several subagent calls
            // in one turn. Pi serializes a whole batch only when any call in it is
            // sequential; approvals stay safe because requestForgeSubagentApproval
            // serializes its dialogs internally.
            executionMode: "parallel",
            async execute(_toolCallId, params, signal, onUpdate, ctx) {
                const settings = loadForgeSubagentSettings(ctx);
                const approvalRequired = !settings.allowAgentInvocationWithoutApproval;
                const configDiagnostics = settings.warnings.map((message) => ({ level: "warning", code: "host.config", message }));
                const baseDetails = {
                    status: "preparing",
                    profileId: params.profileId,
                    task: params.task,
                    approval: {
                        required: approvalRequired,
                        approved: false,
                        viewedFullPrompt: false,
                        source: approvalRequired ? "none" : "trusted-project-config",
                    },
                    diagnostics: configDiagnostics,
                    progress: [],
                };
                const knownProfileIds = profileIds();
                const enabledProfileIds = knownProfileIds.filter((profileId) => resolveSubagentProfilePolicy(settings, profileId).enabled);
                if (!knownProfileIds.includes(params.profileId)) {
                    const available = enabledProfileIds.join(", ") || "none";
                    return toolResult(`Unknown Pi Forge agent profile: ${params.profileId}. Enabled subagent profiles: ${available}.`, { ...baseDetails, status: "failed" }, true);
                }
                const configuredPolicy = resolveSubagentProfilePolicy(settings, params.profileId);
                if (!configuredPolicy.enabled) {
                    return toolResult(`Pi Forge agent profile "${params.profileId}" is not enabled for subagent delegation. Use forge_subagent_profiles to discover enabled profiles.`, { ...baseDetails, status: "failed" }, true);
                }
                const configuredBackend = configuredPolicy.backend;
                if (!approvalRequired && params.backend && params.backend !== configuredBackend.id) {
                    return toolResult(`Subagent invocation was not run: unattended invocation is pinned to the configured backend "${configuredBackend.id}". To use "${params.backend}", run interactively or change the trusted subagent configuration.`, {
                        ...baseDetails,
                        status: "failed",
                        approval: { required: false, approved: false, viewedFullPrompt: false, source: "trusted-project-config" },
                    }, true);
                }
                const runPolicy = resolveSubagentProfilePolicy(settings, params.profileId, approvalRequired ? params.backend : undefined);
                if (approvalRequired && !ctx.hasUI) {
                    return toolResult("Subagent invocation was not run: interactive human approval is unavailable.", { ...baseDetails, status: "cancelled" });
                }
                onUpdate?.(toolResult("Preparing the exact subagent prompt; provider transport is still closed.", baseDetails));
                let prepared;
                try {
                    const preparation = await runtime.prepare(params.profileId, params.task, ctx, {
                        backendId: runPolicy.backend.id,
                        timeoutMs: runPolicy.timeout.milliseconds,
                    });
                    if (!preparation.ok) {
                        const diagnostics = [...configDiagnostics, ...preparation.diagnostics];
                        return toolResult(`Subagent preparation failed:\n${renderDiagnostics(diagnostics)}`, { ...baseDetails, status: "failed", diagnostics }, true);
                    }
                    prepared = preparation.prepared;
                    const plan = summarizeForgeSubagentPlan(prepared, ctx.cwd);
                    const preparedDetails = {
                        ...baseDetails,
                        status: approvalRequired ? "awaiting-approval" : "prepared",
                        plan,
                        diagnostics: [...configDiagnostics, ...prepared.diagnostics],
                    };
                    onUpdate?.(toolResult(approvalRequired
                        ? "The exact plan is ready and awaiting human approval."
                        : "The exact plan is ready; per-run approval is bypassed by trusted-project configuration.", preparedDetails));
                    const approval = approvalRequired
                        ? await requestForgeSubagentApproval(prepared, params.task, ctx, signal)
                        : { approved: true, viewedFullPrompt: false };
                    if (!approval.approved) {
                        await runtime.discard(prepared);
                        prepared = undefined;
                        return toolResult("Subagent invocation was rejected by the human before provider transport.", {
                            ...preparedDetails,
                            status: "cancelled",
                            approval: { required: true, approved: false, viewedFullPrompt: approval.viewedFullPrompt, source: "none" },
                        });
                    }
                    const approvedAt = new Date().toISOString();
                    const progress = [];
                    const running = {
                        ...preparedDetails,
                        status: "running",
                        approval: {
                            required: approvalRequired,
                            approved: true,
                            viewedFullPrompt: approval.viewedFullPrompt,
                            source: approvalRequired ? "human" : "trusted-project-config",
                            executionFingerprint: prepared.plan.executionFingerprint,
                            approvedAt,
                        },
                        progress,
                    };
                    const response = await runtime.execute(prepared, ctx, signal, (update) => {
                        progress.push(structuredClone(update));
                        if (progress.length > MAX_PROGRESS_ITEMS)
                            progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
                        onUpdate?.(toolResult(truncate(update.message, 2_000), { ...running, progress: [...progress] }));
                    });
                    prepared = undefined;
                    const rawReport = runtime.takeReport?.(response.runId);
                    const report = rawReport ? sanitizePiSubprocessRunReport(rawReport) : undefined;
                    const finalDetails = {
                        ...running,
                        status: toolStatus(response),
                        progress: [...progress],
                        response,
                        report,
                    };
                    return toolResult(renderResponseForModel(response), finalDetails, response.status === "failed");
                }
                catch (error) {
                    if (prepared)
                        await runtime.discard(prepared).catch(() => undefined);
                    const message = error instanceof Error ? error.message : String(error);
                    return toolResult(`Subagent invocation failed: ${message}`, { ...baseDetails, status: "failed" }, true);
                }
            },
            renderCall(args, theme) {
                const task = truncate(args.task.replace(/\s+/g, " ").trim(), 100);
                return new Text(`${theme.fg("toolTitle", theme.bold("forge subagent "))}${theme.fg("accent", args.profileId)}\n${theme.fg("dim", task)}`, 0, 0);
            },
            renderResult(result, { expanded, isPartial }, theme) {
                const details = result.details;
                if (!details)
                    return new Text(textContent(result) || "(no subagent result)", 0, 0);
                if (!expanded)
                    return renderCollapsedResult(result, details, isPartial, theme);
                return renderExpandedResult(result, details, theme);
            },
        });
    }
    function refresh(ctx) {
        const summary = options.summarize?.(ctx);
        if (summary === lastSummary)
            return;
        lastSummary = summary;
        register(summary);
    }
    register(undefined);
    return refresh;
}
function forgeSubagentToolDescription(embedded) {
    const lines = [
        "Delegate one foreground task to a Pi Forge agent profile explicitly enabled in subagents.profiles.",
        "Multiple forge_subagent calls in one turn run concurrently; interactive approvals are serialized one at a time.",
        embedded
            ? "The enabled profiles are summarized below; run forge_subagent_profiles for full descriptions, diagnostics, and approval mode."
            : "Use forge_subagent_profiles first when the user has not already specified a profile ID.",
        "Runs require human approval after exact preparation unless the trusted project explicitly enables unattended agent invocation.",
        "The child receives only approved read tools, but runs with the invoking user's OS permissions; read-only is not a sandbox.",
        "The optional backend parameter selects the execution backend for interactively approved runs; unattended invocation always uses the configured default backend.",
        "Use the final report as evidence and do not repeatedly request the same rejected delegation.",
    ].join(" ");
    return embedded ? `${lines}\n\n${embedded}` : lines;
}
/**
 * Compact summary of enabled subagent profiles for the forge_subagent tool
 * description. Rendered only when subagents.summaryInToolDescription
 * is enabled; ready profiles come first, unavailable profiles stay visible so
 * the model does not attempt them. Returns undefined when disabled or when no
 * profile is enabled for delegation.
 */
export function renderEmbeddedSubagentSummary(settings, profiles, resolve) {
    if (!settings.summaryInToolDescription)
        return undefined;
    const summaries = [];
    for (const loaded of profiles) {
        const policy = resolveSubagentProfilePolicy(settings, loaded.profile.id);
        if (!policy.enabled)
            continue;
        summaries.push(summarizeProfile(loaded, resolve(loaded), policy));
    }
    if (summaries.length === 0)
        return undefined;
    const readyFirst = [...summaries].sort((a, b) => statusRank(a.status) - statusRank(b.status));
    return renderEmbeddedSummaryText(readyFirst);
}
export function renderEmbeddedSummaryText(summaries) {
    const total = summaries.length;
    const visible = summaries.slice(0, MAX_EMBEDDED_PROFILES);
    const lines = ["Enabled subagent profiles:"];
    for (const profile of visible)
        lines.push(`- ${embeddedProfileLine(profile)}`);
    if (total > visible.length) {
        const omitted = total - visible.length;
        lines.push(`- ... and ${omitted} more enabled profile${omitted === 1 ? "" : "s"} (forge_subagent_profiles lists all)`);
    }
    const text = lines.join("\n");
    return text.length <= MAX_EMBEDDED_SUMMARY_CHARS
        ? text
        : `${text.slice(0, Math.max(0, MAX_EMBEDDED_SUMMARY_CHARS - 3))}...`;
}
function statusRank(status) {
    return status === "ready" ? 0 : 1;
}
function embeddedProfileLine(profile) {
    const label = profile.name ? `${profile.id} — ${compact(profile.name)}` : profile.id;
    const target = `${profile.model.provider}/${profile.model.id} · thinking ${profile.thinkingLevel} · stack ${profile.promptStack ?? "none"}`;
    const execution = `backend ${profile.backend.id} · ${formatTimeoutMs(profile.timeout.milliseconds)}`;
    if (profile.status === "ready")
        return `${label}: ${target}; ${execution}`;
    const reason = profile.diagnostics.find((diagnostic) => diagnostic.level === "error")?.message
        ?? "profile resolution failed";
    return `${label}: ${target}; ${execution} (unavailable: ${compact(reason)})`;
}
function formatTimeoutMs(milliseconds) {
    return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}
// Pi's select/editor UI is a single slot: a second concurrent dialog clears
// the first component and leaves its promise permanently unresolved. Parallel
// tool calls must therefore serialize the interactive approval flow through
// this gate. Execution after each approval is not gated, so approved runs
// still overlap; unattended invocation never enters the gate.
let approvalDialogGate = Promise.resolve();
function withApprovalDialog(run) {
    const next = approvalDialogGate.then(run);
    approvalDialogGate = next.then(() => undefined, () => undefined);
    return next;
}
export async function requestForgeSubagentApproval(prepared, task, ctx, signal) {
    return withApprovalDialog(async () => {
        let viewedFullPrompt = false;
        while (!signal?.aborted) {
            const choice = await ctx.ui.select(renderApprovalSummary(prepared, task, ctx.cwd), [APPROVE, VIEW_FULL_PROMPT, REJECT], { signal });
            if (choice === VIEW_FULL_PROMPT) {
                viewedFullPrompt = true;
                await ctx.ui.editor(`Subagent approval details: ${prepared.plan.profile.profile.id} (view only; edits are ignored)`, [
                    renderApprovalDetails(prepared, task, ctx.cwd),
                    "",
                    renderFullForgeSubagentPrompt(prepared),
                ].join("\n"));
                continue;
            }
            return { approved: choice === APPROVE, viewedFullPrompt };
        }
        return { approved: false, viewedFullPrompt };
    });
}
export function summarizeForgeSubagentPlan(prepared, cwd) {
    const plan = prepared.plan;
    return {
        backendId: plan.backendId,
        profileId: plan.profile.profile.id,
        promptStackId: plan.profile.promptStack?.id ?? null,
        provider: plan.model.provider,
        model: plan.model.id,
        thinkingLevel: plan.thinkingLevel,
        effectiveToolIds: [...plan.effectiveToolIds],
        executionBoundary: plan.access.executionBoundary ?? "isolated",
        workingDirectory: cwd,
        systemPromptChars: plan.systemPrompt.length,
        messageCount: plan.messages.length,
        messageRoles: plan.messages.map((message) => message.role),
        ...(plan.limits.timeoutMs ? {
            timeoutMs: plan.limits.timeoutMs.value,
            timeoutEnforcement: plan.limits.timeoutMs.enforcement,
        } : {}),
        promptRuntimeFingerprint: plan.promptRuntimeFingerprint,
        conversationFingerprint: plan.conversationFingerprint,
        executionFingerprint: plan.executionFingerprint,
    };
}
export function renderApprovalSummary(prepared, task, cwd) {
    const plan = prepared.plan;
    const summary = summarizeForgeSubagentPlan(prepared, cwd);
    const timeout = summary.timeoutMs === undefined
        ? "none"
        : `${summary.timeoutMs} ms ${summary.timeoutEnforcement ?? "unknown enforcement"}`;
    return [
        `Run foreground subagent ${oneLinePreview(summary.profileId, MAX_APPROVAL_EXECUTION_PREVIEW_CHARS)}?`,
        `Task: ${oneLinePreview(task, MAX_APPROVAL_TASK_PREVIEW_CHARS)}`,
        `Backend: ${oneLinePreview(summary.backendId, MAX_APPROVAL_EXECUTION_PREVIEW_CHARS)}`,
        `Model: ${oneLinePreview(`${summary.provider}/${summary.model} · thinking ${summary.thinkingLevel}`, MAX_APPROVAL_EXECUTION_PREVIEW_CHARS)}`,
        `Stack/tools: ${oneLinePreview(`${summary.promptStackId ?? "none"} · ${toolNames(plan).join(", ") || "none"}`, MAX_APPROVAL_EXECUTION_PREVIEW_CHARS)}`,
        `Directory: ${oneLinePreview(summary.workingDirectory, MAX_APPROVAL_PATH_PREVIEW_CHARS)}`,
        `Boundary: ${oneLinePreview(summary.executionBoundary, 16)} · ${timeout}`,
        `Payload: ${summary.systemPromptChars} system chars + ${summary.messageCount} messages`,
        `Execution: ${compactIdentifier(summary.executionFingerprint, MAX_APPROVAL_FINGERPRINT_PREVIEW_CHARS)} (see full prompt)`,
        "No OS sandbox; provider gets prompt/files read by agent.",
    ].join("\n");
}
export function renderApprovalDetails(prepared, task, cwd) {
    const plan = prepared.plan;
    const summary = summarizeForgeSubagentPlan(prepared, cwd);
    return [
        "# Subagent approval details",
        "",
        "Agent prompt:",
        indent(truncate(task, 2_000)),
        "",
        `Backend: ${summary.backendId}`,
        `Provider: ${summary.provider}`,
        `Model: ${summary.model}`,
        `Thinking: ${summary.thinkingLevel}`,
        `Prompt stack: ${summary.promptStackId ?? "none"}`,
        `Tools: ${toolNames(plan).join(", ") || "none"}`,
        `Working directory: ${summary.workingDirectory}`,
        `Boundary: ${summary.executionBoundary} (read-only tool policy; no OS sandbox)`,
        ...(summary.timeoutMs === undefined ? [] : [`Timeout: ${summary.timeoutMs} ms (${summary.timeoutEnforcement ?? "unknown enforcement"})`]),
        `Full payload: ${summary.systemPromptChars} system chars + ${summary.messageCount} messages`,
        `Prompt runtime fingerprint: ${summary.promptRuntimeFingerprint}`,
        `Conversation fingerprint: ${summary.conversationFingerprint}`,
        `Execution fingerprint: ${summary.executionFingerprint}`,
        "",
        "The provider receives the compiled prompt and any files the read tools access.",
        "The subprocess retains your user permissions even though write/process tools are unavailable.",
    ].join("\n");
}
export function renderFullForgeSubagentPrompt(prepared) {
    const plan = prepared.plan;
    const messages = plan.messages.flatMap((message, index) => [
        `## Message ${index + 1}: ${message.role}${message.protectedTask ? " (protected delegated task)" : ""}${message.source ? ` [${message.source}]` : ""}`,
        "",
        message.content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} media ${part.mediaId}]`).join("\n"),
        "",
    ]);
    return [
        `# Exact provider-bound subagent prompt`,
        "",
        `Backend: ${plan.backendId}`,
        `Profile: ${plan.profile.profile.id}`,
        `Provider/model: ${plan.model.provider}/${plan.model.id}`,
        `Thinking: ${plan.thinkingLevel}`,
        `Tools: ${toolNames(plan).join(", ") || "none"}`,
        `Timeout: ${plan.limits.timeoutMs ? `${plan.limits.timeoutMs.value} ms (${plan.limits.timeoutMs.enforcement})` : "none"}`,
        `Conversation fingerprint: ${plan.conversationFingerprint}`,
        `Execution fingerprint: ${plan.executionFingerprint}`,
        "",
        "## System prompt",
        "",
        plan.systemPrompt,
        "",
        ...messages,
    ].join("\n");
}
function renderCollapsedResult(result, details, isPartial, theme) {
    const icon = details.status === "completed"
        ? theme.fg("success", "✓")
        : details.status === "failed"
            ? theme.fg("error", "✗")
            : details.status === "cancelled" || details.status === "timed-out"
                ? theme.fg("warning", "○")
                : theme.fg("accent", "●");
    const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(details.profileId))} ${theme.fg("muted", `[${details.status}${isPartial ? ", live" : ""}]`)}`];
    if (details.plan)
        lines.push(theme.fg("dim", `${details.plan.provider}/${details.plan.model} · ${details.plan.thinkingLevel} · ${details.plan.executionBoundary}`));
    const output = textContent(result);
    if (output)
        lines.push(theme.fg(details.status === "failed" ? "error" : "toolOutput", truncateLines(output, 8, 2_000)));
    if (details.report)
        lines.push(theme.fg("dim", usageText(details.report)));
    if (details.report && details.report.messages.length > 0)
        lines.push(theme.fg("muted", "Ctrl+O to view the full subagent transcript"));
    return new Text(lines.join("\n"), 0, 0);
}
function renderExpandedResult(result, details, theme) {
    const container = new Container();
    container.addChild(new Text(theme.fg("toolTitle", theme.bold(`${details.profileId} [${details.status}]`)), 0, 0));
    if (details.plan) {
        container.addChild(new Text([
            `${theme.fg("muted", "Model:")} ${details.plan.provider}/${details.plan.model} (${details.plan.thinkingLevel})`,
            `${theme.fg("muted", "Boundary:")} ${details.plan.executionBoundary}; read-only model tools`,
            ...(details.plan.timeoutMs === undefined ? [] : [`${theme.fg("muted", "Timeout:")} ${details.plan.timeoutMs} ms (${details.plan.timeoutEnforcement ?? "unknown"})`]),
            `${theme.fg("muted", "Tools:")} ${details.plan.effectiveToolIds.join(", ") || "none"}`,
            `${theme.fg("muted", "Fingerprint:")} ${details.plan.executionFingerprint}`,
            `${theme.fg("muted", "Approval:")} ${approvalText(details.approval)}`,
        ].join("\n"), 0, 0));
    }
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Delegated task ───"), 0, 0));
    container.addChild(new Text(details.task, 0, 0));
    if (details.report?.messages.length) {
        container.addChild(new Spacer(1));
        const transcriptLabel = details.report.retention.truncated
            ? `─── Bounded subagent transcript tail (${details.report.retention.omittedMessages} earlier/oversized message${details.report.retention.omittedMessages === 1 ? "" : "s"} omitted) ───`
            : "─── Subagent transcript ───";
        container.addChild(new Text(theme.fg("muted", transcriptLabel), 0, 0));
        for (const message of details.report.messages)
            appendMessage(container, message, theme);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", usageText(details.report)), 0, 0));
        if (details.report.stderr.trim()) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("warning", `stderr:\n${details.report.stderr.trim()}`), 0, 0));
        }
    }
    else {
        const output = textContent(result);
        if (output) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
            container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
        }
    }
    return container;
}
function appendMessage(container, value, theme) {
    if (!isRecord(value))
        return;
    if (value.role === "assistant" && Array.isArray(value.content)) {
        for (const part of value.content) {
            if (!isRecord(part))
                continue;
            if (part.type === "toolCall") {
                const name = typeof part.name === "string" ? part.name : "tool";
                const args = isRecord(part.arguments) ? JSON.stringify(part.arguments) : "{}";
                container.addChild(new Text(`${theme.fg("muted", "→")} ${theme.fg("accent", name)} ${theme.fg("dim", args)}`, 0, 0));
            }
            else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                container.addChild(new Markdown(part.text.trim(), 0, 0, getMarkdownTheme()));
            }
        }
        return;
    }
    if (value.role === "toolResult") {
        const name = typeof value.toolName === "string" ? value.toolName : "tool";
        const header = value.isError === true ? theme.fg("error", `← ${name} failed`) : theme.fg("muted", `← ${name}`);
        container.addChild(new Text(header, 0, 0));
        const content = messageText(value.content);
        if (content)
            container.addChild(new Text(theme.fg("toolOutput", content), 1, 0));
    }
}
function toolResult(text, details, _isError = false) {
    return { content: [{ type: "text", text }], details: structuredClone(details) };
}
function renderResponseForModel(response) {
    if (response.status === "completed")
        return response.output?.text || "Subagent completed without a textual report.";
    if (response.status === "failed")
        return `Subagent failed (${response.error.code}): ${response.error.message}${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
    if (response.status === "cancelled" || response.status === "timed-out")
        return `Subagent ${response.status}: ${response.reason}${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
    return `Subagent stopped after reaching ${response.reachedLimit}.${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
}
function toolStatus(response) {
    if (response.status === "completed")
        return "completed";
    if (response.status === "failed" || response.status === "limit-reached")
        return "failed";
    return response.status;
}
function renderDiagnostics(diagnostics) {
    return diagnostics.map((item) => `${item.level.toUpperCase()} ${item.code}: ${item.message}`).join("\n") || "No diagnostics.";
}
function toolNames(plan) {
    const names = new Map(plan.preflight.toolCatalog.map((tool) => [tool.id, tool.name]));
    return plan.effectiveToolIds.map((id) => names.get(id) ?? id);
}
function textContent(result) {
    return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function messageText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    return value.filter(isRecord).flatMap((part) => {
        if (part.type === "text" && typeof part.text === "string")
            return [part.text];
        if (part.type === "image") {
            const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/unknown";
            const encodedBytes = typeof part.encodedBytes === "number" ? `; ${formatBytes(part.encodedBytes)} encoded` : "";
            return [`[Image data omitted from retained subagent report: ${mimeType}${encodedBytes}]`];
        }
        return [];
    }).join("\n");
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
function usageText(report) {
    const usage = report.usage;
    const retention = report.retention.truncated ? ` · ${report.retention.omittedMessages} transcript message${report.retention.omittedMessages === 1 ? "" : "s"} omitted` : "";
    return `${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${usage.input} input · ${usage.output} output · ${usage.totalTokens} total · $${usage.cost.toFixed(4)}${retention}`;
}
function approvalText(approval) {
    if (!approval.approved)
        return approval.required ? "not approved" : "not executed";
    if (approval.source === "trusted-project-config")
        return "per-run approval bypassed by trusted-project config";
    return `approved${approval.viewedFullPrompt ? " after full-prompt review" : ""}`;
}
function indent(text) {
    return text.split("\n").map((line) => `  ${line}`).join("\n");
}
function truncate(text, maxChars) {
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function compact(value) {
    return value.replace(/\s+/g, " ").trim();
}
function oneLinePreview(text, maxChars) {
    return truncate(text.replace(/\s+/g, " ").trim(), maxChars);
}
function compactIdentifier(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    const visibleChars = Math.max(2, maxChars - 3);
    const startChars = Math.ceil(visibleChars / 2);
    const endChars = Math.floor(visibleChars / 2);
    return `${value.slice(0, startChars)}...${value.slice(-endChars)}`;
}
function truncateLines(text, maxLines, maxChars) {
    return truncate(text.split("\n").slice(0, maxLines).join("\n"), maxChars);
}
//# sourceMappingURL=subagent-tool.js.map