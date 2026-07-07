import { applyRegexRulesToMessages, applyRegexRulesToString } from "./regex.js";
import { expandMacros } from "./macro-engine.js";
import { renderSlotText } from "./slot-renderers.js";
const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const SUMMARY_ROLES = new Set(["branchSummary", "compactionSummary"]);
export function createPromptVariableStore(sessionVariables = {}) {
    return { turn: {}, session: { ...sessionVariables }, sessionDirty: false };
}
export function resetTurnVariables(store) {
    store.turn = {};
    store.sessionDirty = false;
}
export function markSessionVariablesClean(store) {
    store.sessionDirty = false;
}
export function compileSystemPrompt(stack, runtime, baseSystemPrompt) {
    const diagnostics = [];
    const parts = [];
    for (const item of enabledItems(stack)) {
        if (item.role !== "system")
            continue;
        if (item.kind === "block") {
            const text = expandMacros(item.content, stack, runtime, diagnostics, item.id).trim();
            if (text)
                parts.push(text);
            continue;
        }
        if (item.slot === "chat-history") {
            diagnostics.push({ level: "warning", message: "chat-history slot cannot be placed in the system prompt.", itemId: item.id });
            continue;
        }
        const rendered = renderSlotText(item, stack, runtime, diagnostics).trim();
        if (rendered)
            parts.push(rendered);
    }
    const compiled = parts.join("\n\n");
    const mode = stack.mode ?? "replace";
    let systemPrompt;
    if (!compiled) {
        diagnostics.push({ level: "warning", message: "Compiled system prompt is empty; preserving base system prompt." });
        systemPrompt = baseSystemPrompt;
    }
    else if (mode === "append") {
        systemPrompt = compiled ? `${baseSystemPrompt}\n\n${compiled}` : baseSystemPrompt;
    }
    else if (mode === "prepend") {
        systemPrompt = compiled ? `${compiled}\n\n${baseSystemPrompt}` : baseSystemPrompt;
    }
    else {
        systemPrompt = compiled;
    }
    systemPrompt = applyRegexRulesToString(stack, systemPrompt, "compiled", "system", diagnostics);
    return { systemPrompt, diagnostics };
}
export function compileMessages(stack, runtime, originalMessages) {
    const diagnostics = [];
    let messages = [];
    let messageSources = [];
    let insertedHistory = false;
    for (const item of enabledItems(stack)) {
        if (item.kind === "slot" && item.slot === "chat-history") {
            if (insertedHistory && !stack.context?.allowDuplicateChatHistory) {
                diagnostics.push({
                    level: "warning",
                    message: "Skipped duplicate chat-history slot.",
                    itemId: item.id,
                });
                continue;
            }
            const historyMessages = getChatHistoryMessages(originalMessages, item, diagnostics);
            const transformedHistory = applyRegexRulesToMessages(stack, historyMessages, "history", diagnostics);
            messages.push(...transformedHistory);
            messageSources.push(...chatHistoryMessageSources(transformedHistory, item));
            insertedHistory = true;
            continue;
        }
        if (!item.role || item.role === "system")
            continue;
        const content = item.kind === "block"
            ? expandMacros(item.content, stack, runtime, diagnostics, item.id)
            : renderSlotText(item, stack, runtime, diagnostics);
        if (!content.trim())
            continue;
        const message = createSyntheticMessage(item.role, content, stack, runtime);
        messages.push(message);
        messageSources.push(stackItemMessageSource(message, item));
    }
    if (!insertedHistory) {
        messages.push(...originalMessages);
        messageSources.push(...implicitHistoryMessageSources(originalMessages));
    }
    messages = applyRegexRulesToMessages(stack, messages, "compiled", diagnostics);
    return { messages, messageSources, diagnostics };
}
export function getLatestUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "user") {
            const text = contentToText(message.content);
            if (text.trim())
                return text;
        }
    }
    return undefined;
}
export function agentMessageToPreviewText(message) {
    let text = contentToText(message.content);
    const role = message.role;
    if (role === "bashExecution") {
        const bash = message;
        text += `Ran ${bash.command ?? ""}\n${bash.output ?? ""}`;
    }
    if (role === "branchSummary" || role === "compactionSummary") {
        text += message.summary ?? "";
    }
    return text;
}
function getChatHistoryMessages(messages, item, diagnostics) {
    let result = messages;
    const options = item.options ?? {};
    let shouldRepairToolPairs = false;
    if (options.includeLastUserMessage === false) {
        const lastUserIndex = findLastUserMessageIndex(result);
        if (lastUserIndex !== -1)
            result = result.filter((_message, index) => index !== lastUserIndex);
    }
    if (options.includeSummaries === false) {
        const next = result.filter((message) => !isSummaryMessage(message));
        addHistoryFilterDiagnostic(diagnostics, item.id, "summary", result.length, next.length);
        result = next;
    }
    if (isStringArray(options.roles) && options.roles.length > 0) {
        const allowedRoles = new Set(options.roles);
        const next = result.filter((message) => allowedRoles.has(messageRole(message)));
        addHistoryFilterDiagnostic(diagnostics, item.id, "role", result.length, next.length);
        result = next;
        shouldRepairToolPairs = true;
    }
    if (options.toolMode === "drop") {
        result = dropToolHistory(result, diagnostics, item.id);
    }
    else if (options.toolMode !== undefined && options.toolMode !== "keep") {
        diagnostics.push({ level: "warning", message: `Unsupported chat-history toolMode: ${String(options.toolMode)}.`, itemId: item.id });
    }
    if (options.stripAssistantThinking === true) {
        result = stripAssistantThinkingFromHistory(result, diagnostics, item.id);
    }
    const limited = limitChatHistory(result, options, diagnostics, item.id);
    if (limited !== result) {
        result = limited;
        shouldRepairToolPairs = true;
    }
    if (shouldRepairToolPairs && options.toolMode !== "drop") {
        result = repairToolHistory(result, diagnostics, item.id);
    }
    return result;
}
function findLastUserMessageIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user")
            return i;
    }
    return -1;
}
function limitChatHistory(messages, options, diagnostics, itemId) {
    let result = messages;
    const maxMessages = positiveIntegerOption(options.maxMessages);
    const maxChars = positiveIntegerOption(options.maxChars);
    if (maxMessages !== undefined && result.length > maxMessages) {
        const next = result.slice(-maxMessages);
        diagnostics.push({
            level: "info",
            message: `Trimmed chat history from ${result.length} to ${next.length} message(s) by maxMessages.`,
            itemId,
        });
        result = next;
    }
    if (maxChars !== undefined) {
        const next = takeRecentMessagesWithinChars(result, maxChars);
        if (next.length < result.length) {
            diagnostics.push({
                level: "info",
                message: `Trimmed chat history from ${result.length} to ${next.length} message(s) by maxChars.`,
                itemId,
            });
            result = next;
        }
    }
    return result;
}
function takeRecentMessagesWithinChars(messages, maxChars) {
    const selected = [];
    let chars = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const messageChars = agentMessageToPreviewText(message).length;
        if (selected.length > 0 && chars + messageChars > maxChars)
            break;
        selected.push(message);
        chars += messageChars;
    }
    return selected.reverse();
}
function addHistoryFilterDiagnostic(diagnostics, itemId, filter, before, after) {
    if (before === after)
        return;
    diagnostics.push({
        level: "info",
        message: `Filtered ${before - after} chat-history message(s) by ${filter}.`,
        itemId,
    });
}
function dropToolHistory(messages, diagnostics, itemId) {
    let removedToolCalls = 0;
    let droppedToolResults = 0;
    let droppedEmptyMessages = 0;
    let changed = false;
    const result = [];
    for (const message of messages) {
        if (isToolResultMessage(message)) {
            droppedToolResults++;
            changed = true;
            continue;
        }
        const stripped = stripToolCallParts(message, () => false);
        removedToolCalls += stripped.removedCalls;
        if (stripped.message !== message)
            changed = true;
        if (!stripped.message) {
            droppedEmptyMessages++;
            continue;
        }
        result.push(stripped.message);
    }
    if (!changed)
        return messages;
    diagnostics.push({
        level: "info",
        message: `Dropped tool history from chat-history: removed ${removedToolCalls} tool call(s), dropped ${droppedToolResults} tool result message(s)` +
            (droppedEmptyMessages > 0 ? `, and dropped ${droppedEmptyMessages} empty message(s).` : "."),
        itemId,
    });
    return result;
}
function repairToolHistory(messages, diagnostics, itemId) {
    const includedCallIds = new Set();
    const includedResultIds = new Set();
    for (const message of messages) {
        for (const id of toolCallIdsForMessage(message))
            includedCallIds.add(id);
        const resultId = toolResultMessageId(message);
        if (resultId)
            includedResultIds.add(resultId);
    }
    let removedToolCalls = 0;
    let droppedToolResults = 0;
    let droppedEmptyMessages = 0;
    let changed = false;
    const result = [];
    for (const message of messages) {
        if (isToolResultMessage(message)) {
            const resultId = toolResultMessageId(message);
            if (!resultId || !includedCallIds.has(resultId)) {
                droppedToolResults++;
                changed = true;
                continue;
            }
            result.push(message);
            continue;
        }
        const stripped = stripToolCallParts(message, (id) => !!id && includedResultIds.has(id));
        removedToolCalls += stripped.removedCalls;
        if (stripped.message !== message)
            changed = true;
        if (!stripped.message) {
            droppedEmptyMessages++;
            continue;
        }
        result.push(stripped.message);
    }
    if (!changed)
        return messages;
    diagnostics.push({
        level: "info",
        message: `Repaired tool history after chat-history filtering: removed ${removedToolCalls} dangling tool call(s), dropped ${droppedToolResults} dangling tool result message(s)` +
            (droppedEmptyMessages > 0 ? `, and dropped ${droppedEmptyMessages} empty message(s).` : "."),
        itemId,
    });
    return result;
}
function stripToolCallParts(message, keep) {
    const content = message.content;
    if (!Array.isArray(content))
        return { message, removedCalls: 0 };
    const nextContent = content.filter((part) => !isToolCallContent(part) || keep(toolCallPartId(part)));
    const removedCalls = content.length - nextContent.length;
    if (removedCalls === 0)
        return { message, removedCalls: 0 };
    if (nextContent.length === 0)
        return { removedCalls };
    return { message: { ...message, content: nextContent }, removedCalls };
}
function toolCallIdsForMessage(message) {
    const content = message.content;
    if (!Array.isArray(content))
        return [];
    return content
        .map((part) => toolCallPartId(part))
        .filter((id) => !!id);
}
function isToolCallContent(value) {
    return isPlainObject(value) && value.type === "toolCall";
}
function toolCallPartId(value) {
    if (!isPlainObject(value))
        return undefined;
    return firstString(value.id, value.toolCallId, value.callId);
}
function isToolResultMessage(message) {
    return messageRole(message) === "toolResult";
}
function toolResultMessageId(message) {
    if (!isToolResultMessage(message))
        return undefined;
    const raw = message;
    return firstString(raw.toolCallId, raw.id, raw.callId);
}
function isSummaryMessage(message) {
    return SUMMARY_ROLES.has(messageRole(message));
}
function messageRole(message) {
    return String(message.role ?? "");
}
function positiveIntegerOption(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value)
            return value;
    }
    return undefined;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function chatHistoryMessageSources(messages, item) {
    return messages.map((message, index) => ({
        kind: "chat-history",
        itemId: item.id,
        itemName: item.name,
        slot: item.slot,
        historyIndex: index + 1,
        historyCount: messages.length,
        role: String(message.role ?? ""),
    }));
}
function implicitHistoryMessageSources(messages) {
    return messages.map((message, index) => ({
        kind: "implicit-history",
        itemName: "Conversation history",
        slot: "chat-history",
        historyIndex: index + 1,
        historyCount: messages.length,
        role: String(message.role ?? ""),
    }));
}
function stackItemMessageSource(message, item) {
    return {
        kind: "stack-item",
        itemId: item.id,
        itemName: item.name,
        role: String(message.role ?? ""),
    };
}
function stripAssistantThinkingFromHistory(messages, diagnostics, itemId) {
    let strippedBlocks = 0;
    let changedMessages = 0;
    let droppedMessages = 0;
    let changed = false;
    const result = [];
    for (const message of messages) {
        const stripped = stripAssistantThinkingFromMessage(message);
        if (stripped.message !== message) {
            changed = true;
            strippedBlocks += stripped.removedBlocks;
            changedMessages++;
        }
        if (!stripped.message) {
            droppedMessages++;
            continue;
        }
        result.push(stripped.message);
    }
    if (!changed)
        return messages;
    diagnostics.push({
        level: "info",
        message: `Stripped ${strippedBlocks} assistant thinking block(s) from ${changedMessages} chat-history message(s)` +
            (droppedMessages > 0 ? ` and dropped ${droppedMessages} empty assistant message(s).` : "."),
        itemId,
    });
    return result;
}
function stripAssistantThinkingFromMessage(message) {
    if (message.role !== "assistant")
        return { message, removedBlocks: 0 };
    const content = message.content;
    if (!Array.isArray(content))
        return { message, removedBlocks: 0 };
    const nextContent = content.filter((part) => !isThinkingContent(part));
    const removedBlocks = content.length - nextContent.length;
    if (removedBlocks === 0)
        return { message, removedBlocks: 0 };
    if (nextContent.length === 0)
        return { removedBlocks };
    return { message: { ...message, content: nextContent }, removedBlocks };
}
function isThinkingContent(value) {
    return !!value && typeof value === "object" && !Array.isArray(value) && value.type === "thinking";
}
function enabledItems(stack) {
    return stack.items.filter((item) => item.enabled !== false);
}
function createSyntheticMessage(role, content, stack, runtime) {
    const timestamp = runtime.now.getTime();
    const visible = stack.defaults?.syntheticMessagesVisible ?? false;
    if (role === "custom") {
        return {
            role: "custom",
            customType: "pi-forge",
            content: [{ type: "text", text: content }],
            display: visible,
            details: { stackId: stack.id },
            timestamp,
        };
    }
    if (role === "assistant") {
        const model = runtime.ctx?.model;
        return {
            role: "assistant",
            content: [{ type: "text", text: content }],
            api: model?.api ?? "unknown",
            provider: model?.provider ?? "unknown",
            model: model?.id ?? "unknown",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp,
        };
    }
    return {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp,
    };
}
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => {
        if (!part || typeof part !== "object")
            return "";
        const obj = part;
        if (obj.type === "text" && typeof obj.text === "string")
            return obj.text;
        if (obj.type === "thinking" && typeof obj.thinking === "string")
            return `<thinking>\n${obj.thinking}\n</thinking>`;
        if (obj.type === "toolCall")
            return `[toolCall: ${String(obj.name ?? "unknown")}]`;
        if (obj.type === "image")
            return "[image]";
        return "";
    })
        .filter(Boolean)
        .join("\n");
}
//# sourceMappingURL=compiler.js.map