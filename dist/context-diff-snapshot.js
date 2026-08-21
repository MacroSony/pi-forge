/**
 * Host-neutral snapshot extraction from captured provider payloads.
 *
 * This module stays free of Node/DOM/Vue APIs so the same extraction logic can
 * be reused by the web host and future non-web surfaces.
 */
import { createBlock, createTurnSnapshot, hashText } from "./context-diff.js";
/** Convert a captured provider payload into an ordered TurnSnapshot of Blocks. */
export function extractTurnSnapshot(capture) {
    return createTurnSnapshot({
        turnId: capture.turnId ?? capture.capturedAt,
        capturedAt: capture.capturedAt,
        stackId: capture.stackId ?? "",
        blocks: extractBlocks(capture),
    });
}
function extractBlocks(capture) {
    const serializedPayload = parseSerializedPayload(capture.serializedPayload);
    const payload = serializedPayload === undefined ? capture.payload : serializedPayload;
    if (!isPlainObject(payload)) {
        return [createBlock("payload-text", "payload", capture.text, capture.serializedPayload === undefined ? undefined : {
                section: "payload",
                serializedPayload: capture.serializedPayload,
            })];
    }
    const blocks = [];
    const messageKeyCounts = new Map();
    for (const [key, value] of Object.entries(payload)) {
        if (key === "system") {
            blocks.push(createSystemBlock(value));
            continue;
        }
        if (key === "messages" && Array.isArray(value) && value.length > 0) {
            for (const message of value) {
                const text = messageToText(message);
                const role = messageRole(message);
                const baseKey = `message-${keyPart(role)}-${hashText(`${role}\u0000${text}`).slice(0, 8)}`;
                const occurrence = messageKeyCounts.get(baseKey) ?? 0;
                messageKeyCounts.set(baseKey, occurrence + 1);
                const messageKey = occurrence === 0 ? baseKey : `${baseKey}-${occurrence + 1}`;
                blocks.push(createBlock(messageKey, role, text, {
                    section: "messages",
                    value: message,
                }));
            }
            continue;
        }
        blocks.push(createRequestFieldBlock(key, value));
    }
    if (blocks.length > 0)
        return blocks;
    return [createBlock("payload", "payload", stringify(payload), {
            section: "payload",
            value: payload,
        })];
}
function createRequestFieldBlock(key, value) {
    return createBlock(`request-${key}`, "request", stringify({ [key]: value }, 2), {
        section: "request",
        field: key,
        value,
    });
}
function createSystemBlock(value) {
    if (typeof value === "string") {
        return createBlock("system", "system", value, {
            section: "system",
            value,
        });
    }
    if (Array.isArray(value)) {
        const systemText = contentBlocksToText(value);
        return createBlock("system", "system", systemText || stringify(value), {
            section: "system",
            value,
        });
    }
    return createBlock("system", "system", stringify(value), {
        section: "system",
        value,
    });
}
function messageRole(message) {
    return isPlainObject(message) && typeof message.role === "string" && message.role.length > 0
        ? message.role
        : "message";
}
function keyPart(value) {
    const part = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return part || "message";
}
function parseSerializedPayload(serializedPayload) {
    if (serializedPayload === undefined)
        return undefined;
    try {
        return JSON.parse(serializedPayload);
    }
    catch {
        return undefined;
    }
}
function stringify(value, space = 0) {
    try {
        const result = JSON.stringify(value, null, space);
        return result === undefined ? String(value) : result;
    }
    catch {
        return String(value);
    }
}
function messageToText(message) {
    if (typeof message === "string")
        return message;
    if (!isPlainObject(message))
        return stringify(message);
    const content = message.content;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content))
        return contentBlocksToText(content);
    return stringify(message);
}
function contentBlocksToText(content) {
    if (!Array.isArray(content))
        return typeof content === "string" ? content : "";
    const parts = [];
    for (const part of content) {
        if (isPlainObject(part) && typeof part.text === "string") {
            parts.push(part.text);
        }
        else if (isPlainObject(part) && part.type === "image") {
            parts.push("[image content]");
        }
        else if (typeof part === "string") {
            parts.push(part);
        }
        else if (part !== undefined && part !== null) {
            parts.push(stringify(part));
        }
    }
    return parts.join("\n").trim();
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=context-diff-snapshot.js.map