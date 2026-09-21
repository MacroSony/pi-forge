import { createHash } from "node:crypto";
/**
 * Forge canonical JSON fingerprints shared by instruction snapshots and the
 * existing subagent wire adapter. The algorithm is unchanged: sorted plain
 * objects, finite numbers, no cycles or sparse arrays. This is content identity,
 * not an authentication signature.
 */
export const JSON_FINGERPRINT_PREFIX = "sha256:v1:";
export function canonicalJson(value) {
    return canonicalize(value, "$", new Set());
}
export function fingerprintJson(value) {
    const digest = createHash("sha256")
        .update(canonicalJson(value))
        .digest("hex");
    return `${JSON_FINGERPRINT_PREFIX}${digest}`;
}
function canonicalize(value, path, ancestors) {
    if (value === null)
        return "null";
    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError(`Cannot fingerprint non-finite number at ${path}.`);
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value !== "object" || value === undefined) {
        throw new TypeError(`Cannot fingerprint ${typeof value} at ${path}.`);
    }
    if (ancestors.has(value)) {
        throw new TypeError(`Cannot fingerprint cyclic value at ${path}.`);
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const items = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index)) {
                    throw new TypeError(`Cannot fingerprint sparse array item at ${path}[${index}].`);
                }
                items.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
            }
            return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`Cannot fingerprint non-plain object at ${path}.`);
        }
        const record = value;
        const keys = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort();
        const properties = keys.map((key) => {
            const property = canonicalize(record[key], `${path}.${key}`, ancestors);
            return `${JSON.stringify(key)}:${property}`;
        });
        return `{${properties.join(",")}}`;
    }
    finally {
        ancestors.delete(value);
    }
}
//# sourceMappingURL=json-fingerprint.js.map