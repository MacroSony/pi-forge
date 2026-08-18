import { FORGE_V1_MAX_TEMPLATE_OUTPUT } from "./types.js";
const ROOTS = new Set(["runtime", "parameters", "extensions"]);
const LEGACY_RUNTIME = new Map([
    ["cwd", ["runtime", "cwd"]],
    ["date", ["runtime", "date"]],
    ["time", ["runtime", "time"]],
    ["lastUserMessage", ["runtime", "lastUserMessage"]],
    ["selectedTools", ["runtime", "selectedToolsText"]],
    ["tools", ["runtime", "selectedToolsText"]],
    ["activeModel", ["runtime", "activeModel"]],
]);
export function render(nodes, environment, options = {}) {
    const limit = options.templateLimit ?? FORGE_V1_MAX_TEMPLATE_OUTPUT;
    try {
        const text = renderNodeList(nodes, environment, limit, 0, options.resolveExtension);
        return { ok: true, text };
    }
    catch (error) {
        if (isForgeError(error))
            return { ok: false, error };
        throw error;
    }
}
function renderNodeList(nodes, environment, limit, depth, resolveExtension) {
    if (depth > 64) {
        throw { kind: "recursion", message: "forge-v1 template nesting exceeds 64 levels." };
    }
    let result = "";
    for (const node of nodes) {
        if (node.kind === "text") {
            result += node.text;
        }
        else if (node.kind === "output") {
            const raw = evaluatePath(node.path, environment, node.span, false, resolveExtension);
            let value = raw;
            for (const filter of node.filters) {
                value = applyFilter(filter, value, node.span);
            }
            result += valueToString(value);
        }
        else if (node.kind === "if") {
            const branch = evaluatePredicate(node.predicate, environment, resolveExtension) ? node.thenBody : node.elseBody;
            if (branch)
                result += renderNodeList(branch, environment, limit, depth + 1, resolveExtension);
        }
        if (result.length > limit) {
            throw {
                kind: "output-limit",
                message: `forge-v1 template output exceeds ${limit} characters.`,
            };
        }
    }
    return result;
}
function evaluatePath(path, environment, span, allowUndefined = false, resolveExtension) {
    if (path.length === 0)
        return undefined;
    const first = path[0];
    if (first === "extensions" && path.length === 2) {
        const name = path[1];
        if (Object.prototype.hasOwnProperty.call(environment.extensions, name))
            return environment.extensions[name];
        if (resolveExtension) {
            const resolved = resolveExtension(name);
            if (resolved !== undefined)
                return resolved;
        }
        if (allowUndefined)
            return undefined;
        throw undefinedError(path, span);
    }
    let cursor;
    if (ROOTS.has(first)) {
        if (first === "runtime")
            cursor = environment.runtime;
        else if (first === "parameters")
            cursor = environment.parameters;
        else
            cursor = environment.extensions;
        const rest = path.slice(1);
        for (const segment of rest) {
            if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !(segment in cursor)) {
                if (allowUndefined)
                    return undefined;
                throw undefinedError(path, span);
            }
            cursor = cursor[segment];
        }
        return cursor;
    }
    if (path.length === 1) {
        if (Object.prototype.hasOwnProperty.call(environment.parameters, first)) {
            return environment.parameters[first];
        }
        const legacyRoot = LEGACY_RUNTIME.get(first);
        if (legacyRoot) {
            return evaluatePath(legacyRoot, environment, span, allowUndefined, resolveExtension);
        }
        if (Object.prototype.hasOwnProperty.call(environment.extensions, first)) {
            return environment.extensions[first];
        }
        if (resolveExtension) {
            const resolved = resolveExtension(first);
            if (resolved !== undefined)
                return resolved;
        }
    }
    if (allowUndefined)
        return undefined;
    throw undefinedError(path, span);
}
function undefinedError(path, span) {
    return {
        kind: "undefined",
        message: `Undefined forge-v1 path: {{${path.join(".")}}}`,
        span,
    };
}
function evaluatePredicate(predicate, environment, resolveExtension) {
    if (predicate.kind === "truthy") {
        const value = evaluatePath(predicate.path, environment, predicate.span, true, resolveExtension);
        return isTruthy(value);
    }
    const value = evaluatePath(predicate.path, environment, predicate.span, false, resolveExtension);
    const actual = valueToString(value);
    if (predicate.kind === "eq")
        return actual === predicate.expected;
    return actual !== predicate.expected;
}
function isTruthy(value) {
    if (value === undefined || value === null)
        return false;
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string")
        return value.length > 0;
    if (typeof value === "number")
        return value !== 0;
    if (Array.isArray(value))
        return value.length > 0;
    return Object.keys(value).length > 0;
}
function applyFilter(name, value, span) {
    switch (name) {
        case "trim":
            return String(value).trim();
        case "upper":
            return String(value).toUpperCase();
        case "lower":
            return String(value).toLowerCase();
        case "json":
            return JSON.stringify(value);
        case "xml":
            return escapeXml(String(value));
        default:
            throw {
                kind: "filter",
                message: `Unknown forge-v1 filter: ${name}`,
                span,
            };
    }
}
export function valueToString(value) {
    if (value === undefined)
        return "";
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
export function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
function isForgeError(value) {
    return !!value && typeof value === "object" && typeof value.kind === "string";
}
//# sourceMappingURL=renderer.js.map