import { applyResourcePolicy } from "./policy.js";
export const promptRenderHelpers = {
    escapeXml,
    formatDate,
    formatTime,
    normalizePath,
    selectedToolNames,
    slotTextFormat,
    plainBullet,
    plainContinuation,
    indentPlainBlock,
};
export function createVariableAccess(_runtime, stack) {
    return {
        get: (name) => collectStaticVariables(stack)[name],
        toMacroText: variableValueToMacroText,
        toPromptText: variableValueToPromptText,
    };
}
export function selectedToolNames(stack, runtime) {
    return applyResourcePolicy([...(runtime.options.selectedTools ?? [])], stack.tools);
}
export function slotTextFormat(item, options = {}) {
    const format = item.options?.format;
    if (format === "plain")
        return "plain";
    if (format === "json" && options.allowJson)
        return "json";
    return "xml";
}
export function collectStaticVariables(stack) {
    return { ...(stack.variables ?? {}) };
}
export function variableValueToMacroText(value) {
    if (value === undefined)
        return "";
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
export function variableValueToPromptText(value) {
    if (typeof value === "string")
        return value;
    return JSON.stringify(value, null, 2);
}
export function plainBullet(label, value) {
    return `- ${label}: ${plainContinuation(value, "  ")}`;
}
export function plainContinuation(value, indent) {
    return value.split("\n").map((line, index) => index === 0 ? line : `${indent}${line}`).join("\n");
}
export function indentPlainBlock(value, indent) {
    return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}
export function normalizePath(value) {
    return value.replace(/\\/g, "/");
}
export function formatDate(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
export function formatTime(now) {
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
}
export function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
//# sourceMappingURL=render-helpers.js.map