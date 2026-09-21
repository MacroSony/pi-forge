import { isDeepStrictEqual } from "node:util";
import { buildContextEntries, sessionEntryToContextMessages, } from "@earendil-works/pi-coding-agent";
import { INSTRUCTION_DELIVERY_TYPE, } from "./instruction-protocol.js";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const MAX_CURSOR_LENGTH = 128;
/**
 * Validates the metadata payload of a plain instruction delivery anchor entry.
 * Enforces strict schema constraints:
 * - Must be a non-null object with no extra fields.
 * - schemaVersion must be 1.
 * - throughEventId must be a non-empty string, length <= 128, containing no control characters.
 */
export function validateInstructionAnchorData(data) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("Invalid instruction anchor metadata: data must be a non-null object");
    }
    const record = data;
    const keys = Object.keys(record);
    for (const key of keys) {
        if (key !== "schemaVersion" && key !== "throughEventId") {
            throw new Error(`Invalid instruction anchor metadata: unexpected extra field "${key}"`);
        }
    }
    if (Object.getOwnPropertySymbols(record).length > 0) {
        throw new Error("Invalid instruction anchor metadata: unexpected symbol property");
    }
    if (!("schemaVersion" in record)) {
        throw new Error("Invalid instruction anchor metadata: missing required field schemaVersion");
    }
    if (!("throughEventId" in record)) {
        throw new Error("Invalid instruction anchor metadata: missing required field throughEventId");
    }
    if (record.schemaVersion !== 1) {
        throw new Error(`Invalid instruction anchor metadata: unsupported schemaVersion ${String(record.schemaVersion)}, expected 1`);
    }
    const throughEventId = record.throughEventId;
    if (typeof throughEventId !== "string" || throughEventId.length === 0) {
        throw new Error("Invalid instruction anchor metadata: throughEventId must be a non-empty string");
    }
    if (throughEventId.length > MAX_CURSOR_LENGTH) {
        throw new Error(`Invalid instruction anchor metadata: throughEventId length exceeds ${MAX_CURSOR_LENGTH} characters (${throughEventId.length})`);
    }
    if (CONTROL_CHAR_PATTERN.test(throughEventId)) {
        throw new Error("Invalid instruction anchor metadata: throughEventId contains control characters");
    }
    return {
        schemaVersion: 1,
        throughEventId,
    };
}
/**
 * Checks if a session entry is a plain metadata anchor for instruction delivery.
 */
export function isInstructionAnchorEntry(entry) {
    if (!entry || typeof entry !== "object")
        return false;
    const record = entry;
    return record.type === "custom" && record.customType === INSTRUCTION_DELIVERY_TYPE;
}
function parseEntryTimestamp(timestamp) {
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
        return timestamp;
    }
    if (typeof timestamp === "string") {
        const parsed = Date.parse(timestamp);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}
/**
 * Creates an ephemeral in-memory custom control message for a plain metadata anchor entry.
 * Used during context projection and Preview manual context assembly.
 * Returns undefined if the entry is not a custom instruction delivery anchor.
 * Throws if the entry is an anchor with invalid metadata.
 */
export function instructionAnchorMessage(entry) {
    if (!isInstructionAnchorEntry(entry)) {
        return undefined;
    }
    const rawEntry = entry;
    const data = validateInstructionAnchorData(rawEntry.data);
    return {
        role: "custom",
        customType: INSTRUCTION_DELIVERY_TYPE,
        content: [],
        display: false,
        details: {
            schemaVersion: data.schemaVersion,
            throughEventId: data.throughEventId,
        },
        timestamp: parseEntryTimestamp(rawEntry.timestamp),
    };
}
/** Compare stable protocol fields; Pi regenerates custom-message envelope timestamps. */
function sameContextMessage(expected, incoming) {
    if (expected.role !== "custom" || incoming.role !== "custom")
        return isDeepStrictEqual(expected, incoming);
    const { timestamp: _expectedTime, ...expectedFields } = expected;
    const { timestamp: _incomingTime, ...incomingFields } = incoming;
    return isDeepStrictEqual(expectedFields, incomingFields);
}
/**
 * Pi can persist queued custom messages without including them in the current
 * tool follow-up context. All non-custom messages must match exactly. Within a
 * custom-message run, admit omission only when earliest and latest ordered
 * alignments agree. Ambiguous duplicates fail; no text/time proximity heuristic,
 * insertion, body rewrite, or replacement of caller-owned context is permitted.
 * The result maps expected message positions to incoming positions (or omission).
 */
function contextAlignment(expected, incoming) {
    const mapping = new Array(expected.length);
    let e = 0, i = 0;
    while (e < expected.length || i < incoming.length) {
        if (expected[e]?.role !== "custom") {
            if (!expected[e] || !incoming[i] || !sameContextMessage(expected[e], incoming[i]))
                return undefined;
            mapping[e++] = i++;
            continue;
        }
        const expectedStart = e, incomingStart = i;
        while (expected[e]?.role === "custom")
            e++;
        while (incoming[i]?.role === "custom")
            i++;
        const earliest = [];
        let cursor = expectedStart;
        for (let current = incomingStart; current < i; current++) {
            while (cursor < e && !sameContextMessage(expected[cursor], incoming[current]))
                cursor++;
            if (cursor === e)
                return undefined;
            earliest.push(cursor++);
        }
        cursor = e - 1;
        for (let current = i - 1; current >= incomingStart; current--) {
            while (cursor >= expectedStart && !sameContextMessage(expected[cursor], incoming[current]))
                cursor--;
            if (cursor !== earliest[current - incomingStart])
                return undefined;
            mapping[cursor--] = current;
        }
    }
    return mapping;
}
export function instructionContextMatches(expected, incoming) {
    return contextAlignment(expected, incoming) !== undefined;
}
/**
 * Materializes plain metadata anchors into context messages at their exact ordinal positions.
 *
 * Rules:
 * - If no visible plain metadata anchor exists in context entries, returns the original messages array.
 * - If visible anchors exist, validates their metadata and checks the ordered protocol alignment before injection (see instructionContextMatches).
 * - Preserves all original message object references from incoming messages.
 * - Never guesses by timestamps or text matching; fails closed if context was modified by preceding extensions.
 */
export function materializeInstructionAnchors(entries, messages) {
    if (!Array.isArray(entries)) {
        throw new TypeError("Invalid entries: expected an array");
    }
    if (!Array.isArray(messages)) {
        throw new TypeError("Invalid messages: expected an array");
    }
    if (entries.length === 0) {
        return messages;
    }
    const contextEntries = buildContextEntries(entries);
    let hasVisibleAnchor = false;
    for (const entry of contextEntries) {
        if (isInstructionAnchorEntry(entry)) {
            hasVisibleAnchor = true;
            validateInstructionAnchorData(entry.data);
        }
    }
    if (!hasVisibleAnchor) {
        return messages;
    }
    const rawMessages = contextEntries.flatMap(sessionEntryToContextMessages);
    const alignment = contextAlignment(rawMessages, messages);
    if (!alignment) {
        throw new Error("Cannot materialize instruction anchors: context has no unique session alignment (possible preceding extension rewrite or deferred custom messages)");
    }
    const materialized = [];
    let messageIndex = 0;
    for (const entry of contextEntries) {
        if (isInstructionAnchorEntry(entry)) {
            const anchorMessage = instructionAnchorMessage(entry);
            if (anchorMessage) {
                materialized.push(anchorMessage);
            }
            continue;
        }
        const entryMessages = sessionEntryToContextMessages(entry);
        for (let i = 0; i < entryMessages.length; i++) {
            const incomingIndex = alignment[messageIndex++];
            if (incomingIndex !== undefined)
                materialized.push(messages[incomingIndex]);
        }
    }
    if (messageIndex !== rawMessages.length) {
        throw new Error(`Cannot materialize instruction anchors: context message count mismatch (processed ${messageIndex} of ${rawMessages.length} session messages)`);
    }
    return materialized;
}
/**
 * Checks whether the current turn has in-flight or unresolved tool calls.
 *
 * Turn scoping rule:
 * - Real user messages (`role: "user"`) define a new user turn and clear any
 *   historical orphan tool calls left by interrupted or crashed earlier turns.
 * - Custom peer messages (`role: "custom"`) do not establish a new user boundary
 *   and do not clear pending calls.
 * - Assistant tool calls add to the pending set; matching toolResult messages remove them.
 */
export function hasPendingInstructionToolCalls(messages) {
    if (!Array.isArray(messages))
        return false;
    const pending = new Set();
    for (const msg of messages) {
        if (!msg || typeof msg !== "object")
            continue;
        if (msg.role === "user") {
            pending.clear();
            continue;
        }
        if (msg.role === "assistant") {
            const assistant = msg;
            if (Array.isArray(assistant.content)) {
                for (const block of assistant.content) {
                    if (block
                        && typeof block === "object"
                        && block.type === "toolCall") {
                        const id = block.id;
                        if (typeof id === "string" && id.length > 0) {
                            pending.add(id);
                        }
                    }
                }
            }
            continue;
        }
        if (msg.role === "toolResult") {
            const toolResult = msg;
            if (typeof toolResult.toolCallId === "string" && toolResult.toolCallId.length > 0) {
                pending.delete(toolResult.toolCallId);
            }
            continue;
        }
    }
    return pending.size > 0;
}
//# sourceMappingURL=instruction-anchors.js.map