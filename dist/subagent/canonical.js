import { createHash } from "node:crypto";
import { SUBAGENT_FINGERPRINT_PREFIX } from "./types.js";
export function canonicalSubagentJson(value) {
    return canonicalize(value, "$", new Set());
}
export function subagentFingerprint(value) {
    return `${SUBAGENT_FINGERPRINT_PREFIX}${createHash("sha256").update(canonicalSubagentJson(value)).digest("hex")}`;
}
export function subagentSourceProfileFingerprint(profile) {
    return subagentFingerprint(profile);
}
export function subagentPromptStackFingerprint(stack) {
    return subagentFingerprint(stack);
}
export function subagentPromptRuntimeFingerprint(runtime) {
    const { promptRuntimeFingerprint: _ignored, ...behavior } = runtime;
    return subagentFingerprint(behavior);
}
export function subagentExecutionFingerprint(plan) {
    const { executionFingerprint: _ignored, ...behavior } = plan;
    return subagentFingerprint(behavior);
}
function canonicalize(value, path, ancestors) {
    if (value === null)
        return "null";
    if (typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError(`Cannot fingerprint non-finite number at ${path}.`);
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value !== "object")
        throw new TypeError(`Cannot fingerprint ${typeof value} at ${path}.`);
    if (ancestors.has(value))
        throw new TypeError(`Cannot fingerprint cyclic value at ${path}.`);
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors)).join(",")}]`;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new TypeError(`Cannot fingerprint non-plain object at ${path}.`);
        const record = value;
        const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, ancestors)}`).join(",")}}`;
    }
    finally {
        ancestors.delete(value);
    }
}
//# sourceMappingURL=canonical.js.map