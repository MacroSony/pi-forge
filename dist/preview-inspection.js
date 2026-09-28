import { hashText } from "./context-diff.js";
/**
 * Tracks occurrence counts per preview compile to disambiguate identical content
 * or duplicate message identities within the same rendered preview.
 *
 * When duplicate fingerprints are detected, ALL occurrences sharing that fingerprint
 * (including the first occurrence) are marked as temporary (:temp:N), and all of their
 * part keys are retroactively updated as well.
 */
export class InspectionOccurrenceTracker {
    entriesByBaseKey = new Map();
    register(baseKey, inspection) {
        const entries = this.entriesByBaseKey.get(baseKey) ?? [];
        const occurrence = entries.length + 1;
        if (occurrence === 1) {
            inspection.key = `${baseKey}:1`;
            for (let i = 0; i < inspection.parts.length; i++) {
                inspection.parts[i].key = `${inspection.key}:part:${i}`;
            }
            entries.push({ inspection, baseKey, occurrence });
            this.entriesByBaseKey.set(baseKey, entries);
        }
        else {
            // Only the first duplicate needs retroactive relabeling; later entries are already temporary.
            for (const prev of occurrence === 2 ? entries : []) {
                prev.inspection.key = `${baseKey}:temp:${prev.occurrence}`;
                for (let i = 0; i < prev.inspection.parts.length; i++) {
                    prev.inspection.parts[i].key = `${prev.inspection.key}:part:${i}`;
                }
            }
            // Mark current entry as temporary
            inspection.key = `${baseKey}:temp:${occurrence}`;
            for (let i = 0; i < inspection.parts.length; i++) {
                inspection.parts[i].key = `${inspection.key}:part:${i}`;
            }
            entries.push({ inspection, baseKey, occurrence });
        }
    }
}
export function createInspectionTracker() {
    return new InspectionOccurrenceTracker();
}
/**
 * Determines whether an inspection key is a temporary/duplicate key.
 * When identical fingerprints repeat, all occurrences (including the first) are marked
 * with a temporary key (:temp:N) and do not claim cross-insertion stability.
 */
export function isTemporaryInspectionKey(key) {
    return key.includes(":temp:");
}
/**
 * Resolve the inspection scope according to CompileMessageSource history slot instances,
 * stack item identities, or implicit conversation history.
 * Scoping ensures repeating history slots do not cross-pair.
 */
export function resolveInspectionScope(source, role, isForgeUpdate = false) {
    if (isForgeUpdate) {
        return "forge-capability-update";
    }
    if (source?.kind === "stack-item") {
        if (source.mergedItems && source.mergedItems.length > 0) {
            return `stack-items:${source.mergedItems.map((item) => item.itemId ?? "").join("+")}`;
        }
        if (source.itemId) {
            return `stack-item:${source.itemId}`;
        }
        return "stack-item";
    }
    if (source?.kind === "chat-history") {
        return `chat-history:${source.itemId ?? source.slot ?? "history"}`;
    }
    if (source?.kind === "implicit-history") {
        return "implicit-history";
    }
    if (role === "system") {
        return "system";
    }
    return "implicit-history";
}
/**
 * Format structured tool call arguments into clean display JSON.
 * Preserves structured values without claiming wire raw text, and never
 * substitutes null or missing values with `{}`.
 */
export function formatToolCallArguments(args) {
    if (args === undefined) {
        return "[arguments unavailable]";
    }
    if (args === null) {
        return "null";
    }
    if (typeof args === "string") {
        return JSON.stringify(args);
    }
    try {
        const formatted = JSON.stringify(args, null, 2);
        return formatted !== undefined ? formatted : JSON.stringify(String(args));
    }
    catch {
        try {
            return JSON.stringify(String(args));
        }
        catch {
            return String(args);
        }
    }
}
/**
 * Extract raw ordered parts from a compiled AgentMessage.
 * Does not guess from title or preview text; inspects the actual message content structure.
 */
export function extractRawParts(message) {
    if (!message)
        return [];
    const content = message.content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const part of content) {
            if (!part || typeof part !== "object") {
                if (typeof part === "string") {
                    parts.push({ kind: "text", text: part });
                }
                else {
                    parts.push({ kind: "unknown", text: "[unknown]" });
                }
                continue;
            }
            const item = part;
            const type = item.type;
            if (type === "text") {
                parts.push({
                    kind: "text",
                    text: typeof item.text === "string" ? item.text : "",
                });
            }
            else if (type === "thinking") {
                parts.push({
                    kind: "thinking",
                    text: typeof item.thinking === "string" ? item.thinking : "",
                });
            }
            else if (type === "toolCall") {
                parts.push({
                    kind: "toolCall",
                    toolName: typeof item.name === "string" ? item.name : undefined,
                    callId: typeof item.id === "string" ? item.id : undefined,
                    text: formatToolCallArguments(item.arguments),
                });
            }
            else if (type === "image") {
                // Provide explicit placeholder/type only. Never copy or leak base64 data.
                const mimeType = typeof item.mimeType === "string" && item.mimeType.trim().length > 0
                    ? item.mimeType.trim()
                    : "";
                parts.push({
                    kind: "image",
                    text: mimeType ? `[image: ${mimeType}]` : "[image]",
                });
            }
            else {
                // Neutral type hint preserved for unknown part types
                const typeHint = typeof type === "string" && type.trim().length > 0
                    ? type.trim()
                    : "unknown";
                parts.push({
                    kind: "unknown",
                    text: `[unknown: ${typeHint}]`,
                });
            }
        }
        return parts;
    }
    if (typeof content === "string") {
        if (content.length > 0) {
            return [{ kind: "text", text: content }];
        }
        return [];
    }
    // Handle messages without content (e.g. bashExecution, branchSummary, or text property)
    const msg = message;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "bashExecution") {
        const command = typeof msg.command === "string" ? msg.command : "";
        const output = typeof msg.output === "string" ? msg.output : "";
        return [{ kind: "text", text: `Ran ${command}\n${output}` }];
    }
    if (role === "branchSummary" || role === "compactionSummary") {
        const summary = typeof msg.summary === "string" ? msg.summary : "";
        if (summary.length > 0) {
            return [{ kind: "text", text: summary }];
        }
    }
    if (typeof msg.text === "string" && msg.text.length > 0) {
        return [{ kind: "text", text: msg.text }];
    }
    if (typeof msg.summary === "string" && msg.summary.length > 0) {
        return [{ kind: "text", text: msg.summary }];
    }
    return [];
}
/**
 * Extract toolResult metadata strictly from a standard SDK toolResult message.
 * Must be msg.role === 'toolResult' and strictly extract toolCallId from msg.toolCallId.
 * Does not guess from unknown roles or other fields. Unknown roles remain neutral.
 */
export function extractToolResult(message) {
    if (!message || typeof message !== "object")
        return undefined;
    const msg = message;
    if (msg.role !== "toolResult") {
        return undefined;
    }
    const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
    const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
    const isError = typeof msg.isError === "boolean" ? msg.isError : undefined;
    const res = {};
    if (callId !== undefined)
        res.callId = callId;
    if (toolName !== undefined)
        res.toolName = toolName;
    if (isError !== undefined)
        res.isError = isError;
    return res;
}
/**
 * Compute stable content fingerprint from scope, role, full display parts, and toolResult.
 * Ensures argument or tool changes alter the hash even if legacy content strings match.
 * Distinguishes missing isError from false and true (does not default to false).
 */
export function computeInspectionFingerprint(scope, role, parts, toolResult, systemMetadata) {
    const raw = JSON.stringify({
        scope,
        role,
        systemMetadata,
        parts: parts.map((p) => [p.kind, p.text, p.toolName ?? "", p.callId ?? ""]),
        toolResult: toolResult
            ? {
                callId: toolResult.callId ?? null,
                toolName: toolResult.toolName ?? null,
                isError: toolResult.isError === undefined ? "missing" : toolResult.isError,
            }
            : null,
    });
    return hashText(raw);
}
/**
 * Build the complete inspection sidecar for a section from its compiled AgentMessage.
 * Relies strictly on scope + display structure hash rather than heuristics on message fields.
 */
export function buildSectionInspection(message, scope, tracker) {
    if (!message) {
        const baseKey = `${scope}:system:empty`;
        const inspection = {
            key: "",
            scope,
            parts: [],
        };
        tracker.register(baseKey, inspection);
        return inspection;
    }
    const role = String(message.role ?? "unknown");
    const rawParts = extractRawParts(message);
    const toolResult = extractToolResult(message);
    // Named section operations and tool declarations are displayed separately, but
    // still distinguish reading identity (including null versus an empty string).
    const system = role === "system" ? message : undefined;
    const metadata = system ? { sections: system.sections, added: system.toolsAdded, removed: system.toolsRemoved } : undefined;
    const hash = computeInspectionFingerprint(scope, role, rawParts, toolResult, metadata);
    const baseFingerprintKey = `${scope}:${role}:${hash}`;
    const parts = rawParts.map((raw) => {
        const part = {
            key: "",
            kind: raw.kind,
            text: raw.text,
        };
        if (raw.toolName !== undefined)
            part.toolName = raw.toolName;
        if (raw.callId !== undefined)
            part.callId = raw.callId;
        return part;
    });
    const inspection = {
        key: "",
        scope,
        parts,
    };
    if (toolResult) {
        inspection.toolResult = toolResult;
    }
    tracker.register(baseFingerprintKey, inspection);
    return inspection;
}
//# sourceMappingURL=preview-inspection.js.map