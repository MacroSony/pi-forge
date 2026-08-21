/**
 * Host-neutral snapshot extraction from captured provider payloads.
 *
 * This module stays free of Node/DOM/Vue APIs so the same extraction logic can
 * be reused by the web host and future non-web surfaces.
 */
import { createBlock, createTurnSnapshot } from "./context-diff.js";
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
    const payload = capture.payload;
    if (!isPlainObject(payload)) {
        return [createBlock("payload-text", "payload", capture.text)];
    }
    const blocks = [];
    const requestFields = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key === "system")
            continue;
        if (key === "messages" && Array.isArray(value))
            continue;
        requestFields[key] = value;
    }
    if (Object.keys(requestFields).length > 0) {
        const requestText = stringify(requestFields, 2);
        blocks.push(createBlock("request", "request", requestText, {
            section: "request",
            fields: requestFields,
        }));
    }
    if (typeof payload.system === "string") {
        blocks.push(createBlock("system", "system", payload.system, {
            section: "system",
            value: payload.system,
        }));
    }
    else if (Array.isArray(payload.system)) {
        const systemText = contentBlocksToText(payload.system);
        if (systemText.length > 0 || payload.system.length > 0) {
            blocks.push(createBlock("system", "system", systemText || stringify(payload.system), {
                section: "system",
                value: payload.system,
            }));
        }
    }
    else if (payload.system !== undefined) {
        blocks.push(createBlock("system", "system", stringify(payload.system), {
            section: "system",
            value: payload.system,
        }));
    }
    if (Array.isArray(payload.messages)) {
        let hasSystemBlock = blocks.some((block) => block.key === "system");
        for (let index = 0; index < payload.messages.length; index++) {
            const message = payload.messages[index];
            if (!isPlainObject(message)) {
                blocks.push(createBlock(`message-${index}`, "message", messageToText(message), {
                    section: "message",
                    value: message,
                }));
                continue;
            }
            const role = typeof message.role === "string" && message.role.length > 0 ? message.role : "message";
            const key = index === 0 && role === "system" && !hasSystemBlock ? "system" : `message-${index}`;
            if (key === "system")
                hasSystemBlock = true;
            blocks.push(createBlock(key, role, messageToText(message), {
                section: "message",
                value: message,
            }));
        }
    }
    if (blocks.length > 0)
        return blocks;
    return [createBlock("payload", "payload", stringify(payload), {
            section: "payload",
            value: payload,
        })];
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