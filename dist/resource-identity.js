/**
 * Unified resource ID grammar shared by agent profiles and prompt stacks.
 * `:` is reserved for scope qualification and must not appear in JSON IDs.
 */
export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidResourceId(id) {
    return RESOURCE_ID_PATTERN.test(id);
}
export function isResourceScope(value) {
    return value === "global" || value === "project";
}
export function resourceKey(scope, id) {
    return { scope, id };
}
export function formatResourceKey(key) {
    return `${key.scope}:${key.id}`;
}
export function formatResourceSelector(selector) {
    return selector.scope ? `${selector.scope}:${selector.id}` : selector.id;
}
/**
 * Parse a selector into `{ scope?, id }`. Rejects unknown scope prefixes,
 * empty IDs, and malformed selectors. Bare `none`/`off` are opt-outs and
 * should be handled by the caller before selector parsing.
 */
export function parseResourceSelector(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return { ok: false, error: "Resource selector must not be empty." };
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
        if (!isValidResourceId(trimmed)) {
            return {
                ok: false,
                error: `Invalid resource id: ${trimmed}. Ids must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.`,
            };
        }
        return { ok: true, selector: { id: trimmed } };
    }
    const scopePart = trimmed.slice(0, colonIndex);
    const idPart = trimmed.slice(colonIndex + 1);
    if (!isResourceScope(scopePart)) {
        return {
            ok: false,
            error: `Unknown scope prefix: ${scopePart}. Expected "project" or "global".`,
        };
    }
    if (!isValidResourceId(idPart)) {
        return {
            ok: false,
            error: `Invalid resource id: ${idPart}. Ids must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.`,
        };
    }
    return { ok: true, selector: { scope: scopePart, id: idPart } };
}
//# sourceMappingURL=resource-identity.js.map