/**
 * Read-only prompt-cache usage for the current session branch.
 *
 * Everything here is derived from usage the provider already reported and Pi
 * already persisted. It never changes requests, cache breakpoints, warming or
 * session entries, and it starts no inference.
 */
/** `details` key a tool result may use to report model usage that ran inside the tool call. */
export const FORGE_NESTED_USAGE_KEY = "forgeNestedUsage";
function emptyTotals() {
    return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function emptyNested() {
    return { ...emptyTotals(), calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 };
}
function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function tokenCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/** Strict parser for {@link ForgeNestedUsage}; returns undefined for any malformed value. */
export function parseForgeNestedUsage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const raw = value;
    const allowed = ["schemaVersion", "requests", "input", "output", "cacheRead", "cacheWrite"];
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
        return undefined;
    if (raw.schemaVersion !== 1)
        return undefined;
    if (!isCount(raw.requests) || !isCount(raw.input) || !isCount(raw.output))
        return undefined;
    const hasRead = raw.cacheRead !== undefined;
    const hasWrite = raw.cacheWrite !== undefined;
    if (hasRead !== hasWrite)
        return undefined;
    if (hasRead && (!isCount(raw.cacheRead) || !isCount(raw.cacheWrite)))
        return undefined;
    if (raw.requests === 0 && [raw.input, raw.output, raw.cacheRead, raw.cacheWrite].some((count) => typeof count === "number" && count > 0))
        return undefined;
    return {
        schemaVersion: 1,
        requests: raw.requests,
        input: raw.input,
        output: raw.output,
        ...(hasRead ? { cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite } : {}),
    };
}
function messageOf(entry) {
    if (!entry || typeof entry !== "object")
        return undefined;
    const record = entry;
    if (record.type !== "message" || !record.message || typeof record.message !== "object")
        return undefined;
    return record.message;
}
function requestUsage(message) {
    if (message.role !== "assistant")
        return undefined;
    const usage = message.usage;
    if (!usage || typeof usage !== "object")
        return undefined;
    const totals = {
        requests: 1,
        input: tokenCount(usage.input),
        output: tokenCount(usage.output),
        cacheRead: tokenCount(usage.cacheRead),
        cacheWrite: tokenCount(usage.cacheWrite),
    };
    // Aborted or failed requests can persist without any reported usage.
    return totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0 ? totals : undefined;
}
function add(target, value) {
    target.requests += value.requests;
    target.input += value.input;
    target.output += value.output;
    target.cacheRead += value.cacheRead;
    target.cacheWrite += value.cacheWrite;
}
function addNested(target, details) {
    if (!details || typeof details !== "object" || !(FORGE_NESTED_USAGE_KEY in details))
        return;
    const usage = parseForgeNestedUsage(details[FORGE_NESTED_USAGE_KEY]);
    if (!usage) {
        target.invalidCalls += 1;
        return;
    }
    if (usage.cacheRead === undefined || usage.cacheWrite === undefined) {
        target.cacheUnknownCalls += 1;
        return;
    }
    target.calls += 1;
    add(target, { requests: usage.requests, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
}
/** Summarize provider-reported usage from current-branch session entries (root to leaf). */
export function summarizeSessionCacheUsage(entries) {
    let turnStart = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
        if (messageOf(entries[index])?.role === "user") {
            turnStart = index + 1;
            break;
        }
    }
    const view = {
        main: { turn: emptyTotals(), session: emptyTotals() },
        nested: { turn: emptyNested(), session: emptyNested() },
    };
    entries.forEach((entry, index) => {
        const message = messageOf(entry);
        if (!message)
            return;
        const inTurn = index >= turnStart;
        const request = requestUsage(message);
        if (request) {
            add(view.main.session, request);
            if (inTurn)
                add(view.main.turn, request);
            view.main.lastRequest = request;
        }
        if (message.role === "toolResult") {
            addNested(view.nested.session, message.details);
            if (inTurn)
                addNested(view.nested.turn, message.details);
        }
    });
    return view;
}
/** cacheRead / (uncached input + cacheRead + cacheWrite); undefined when nothing was sent. */
export function cacheHitRate(totals) {
    const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
    return prompt > 0 ? totals.cacheRead / prompt : undefined;
}
//# sourceMappingURL=session-usage.js.map