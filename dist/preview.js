import { agentMessageToPreviewText, getLatestUserMessage, PromptCompilationContext, } from "./compiler.js";
import { estimatePayloadTokens } from "./payload-capture.js";
import { promptRuntimeFromCompileOptions } from "./prompt-runtime.js";
export function renderPreview(ctx, target) {
    return buildPreview(ctx, target, ctx.getSystemPromptOptions()).text;
}
export function buildPreview(ctx, target, options) {
    const sessionMessages = getPreviewSessionMessages(ctx);
    const latestUserMessage = getLatestUserMessage(sessionMessages);
    const runtime = promptRuntimeFromCompileOptions(options, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined, latestUserMessage);
    const compilation = new PromptCompilationContext(target.stack, runtime);
    const system = compilation.compileSystemPrompt(ctx.getSystemPrompt());
    const messages = compilation.compileMessages(sessionMessages);
    const diagnostics = [...target.diagnostics, ...system.diagnostics, ...messages.diagnostics];
    for (const rule of target.stack.regex?.rules ?? []) {
        if (rule.effect === "finalize" && rule.enabled !== false) {
            diagnostics.push({
                level: "info",
                message: "finalize regex rules are not represented in preview.",
            });
        }
    }
    const messageSections = messages.messages.map((message, index) => {
        const content = agentMessageToPreviewText(message);
        const source = messages.messageSources[index];
        return previewSection(`message-${index}`, previewMessageTitle(source, index), content, message.role);
    });
    const systemSection = previewSection("system", "System prompt", system.systemPrompt || "(empty)");
    const totalChars = systemSection.chars + messageSections.reduce((sum, section) => sum + section.chars, 0);
    const preview = {
        stackId: target.stack.id,
        generatedAt: new Date().toISOString(),
        system: systemSection,
        messages: messageSections,
        totalChars,
        approxTokens: estimatePayloadTokens(`${system.systemPrompt}\n${messageSections.map((section) => section.content).join("\n")}`),
    };
    const text = [
        `# Prompt stack preview: ${target.stack.id}`,
        "",
        "## System prompt",
        "",
        system.systemPrompt || "(empty)",
        "",
        "## Message layout",
        "",
        renderPreviewSectionText(messageSections),
        "",
        "## Diagnostics",
        "",
        renderDiagnostics(diagnostics),
    ].join("\n");
    return { text, preview, diagnostics };
}
function getPreviewSessionMessages(ctx) {
    const entries = getCurrentBranchEntries(ctx).map(asSessionEntry);
    const compaction = latestCompactionEntry(entries);
    const messages = [];
    const appendMessage = (entry) => {
        if (entry.type === "message" && isAgentMessage(entry.message)) {
            messages.push(entry.message);
            return;
        }
        if (entry.type === "custom_message" && typeof entry.customType === "string") {
            messages.push({
                role: "custom",
                customType: entry.customType,
                content: typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : "",
                display: entry.display === true,
                details: entry.details,
                timestamp: entryTimestamp(entry),
            });
            return;
        }
        if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary) {
            messages.push({
                role: "branchSummary",
                summary: entry.summary,
                fromId: typeof entry.fromId === "string" ? entry.fromId : "",
                timestamp: entryTimestamp(entry),
            });
        }
    };
    if (compaction && typeof compaction.summary === "string") {
        messages.push({
            role: "compactionSummary",
            summary: compaction.summary,
            tokensBefore: typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : 0,
            timestamp: entryTimestamp(compaction),
        });
        const compactionIndex = entries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
        let foundFirstKept = false;
        for (let index = 0; index < compactionIndex; index++) {
            const entry = entries[index];
            if (entry.id === compaction.firstKeptEntryId)
                foundFirstKept = true;
            if (foundFirstKept)
                appendMessage(entry);
        }
        for (let index = compactionIndex + 1; index < entries.length; index++) {
            appendMessage(entries[index]);
        }
        return messages;
    }
    for (const entry of entries)
        appendMessage(entry);
    return messages;
}
function latestCompactionEntry(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type === "compaction")
            return entry;
    }
    return undefined;
}
function getCurrentBranchEntries(ctx) {
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === null)
        return [];
    const sessionManager = ctx.sessionManager;
    return sessionManager.getBranch ? sessionManager.getBranch(leafId ?? undefined) : sessionManager.getEntries();
}
function asSessionEntry(value) {
    return value && typeof value === "object" ? value : {};
}
function isAgentMessage(value) {
    return !!value && typeof value === "object" && typeof value.role === "string";
}
function entryTimestamp(entry) {
    if (typeof entry.timestamp === "number")
        return entry.timestamp;
    if (typeof entry.timestamp === "string") {
        const timestamp = new Date(entry.timestamp).getTime();
        if (Number.isFinite(timestamp))
            return timestamp;
    }
    return Date.now();
}
function previewMessageTitle(source, index) {
    if (source?.kind === "stack-item") {
        return source.itemName?.trim() || source.itemId || `Stack item ${index + 1}`;
    }
    if (source?.kind === "chat-history") {
        const label = source.itemName?.trim() || "Chat history";
        return `${label} #${source.historyIndex ?? index + 1}`;
    }
    if (source?.kind === "implicit-history") {
        return `Conversation history #${source.historyIndex ?? index + 1}`;
    }
    return `Message ${index + 1}`;
}
function renderPreviewSectionText(sections, maxChars = 8000) {
    let text = "";
    for (const section of sections) {
        const role = section.role ? ` (${section.role})` : "";
        text += `\n--- ${section.title}${role} ---\n`;
        text += section.content;
        text += "\n";
        if (text.length > maxChars)
            return `${text.slice(0, maxChars)}\n\n[preview truncated]`;
    }
    return text.trimStart();
}
function previewSection(id, title, content, role) {
    return {
        id,
        title,
        role,
        content,
        chars: content.length,
        approxTokens: estimatePayloadTokens(content),
    };
}
export function renderDiagnostics(diagnostics) {
    if (diagnostics.length === 0)
        return "No diagnostics.";
    return diagnostics.map((d) => `${d.level.toUpperCase()}${d.itemId ? ` [${d.itemId}]` : ""}: ${d.message}`).join("\n");
}
export async function showText(ctx, title, text) {
    if (ctx.hasUI) {
        await ctx.ui.editor(title, text);
        return;
    }
    console.log(text);
}
//# sourceMappingURL=preview.js.map