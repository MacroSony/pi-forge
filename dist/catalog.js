export function createResourceCatalog(all) {
    const effective = computeEffectiveView(all);
    function resolveExact(scopeOrKey, maybeId) {
        const scope = typeof scopeOrKey === "string" ? scopeOrKey : scopeOrKey.scope;
        const id = typeof scopeOrKey === "string" ? maybeId : scopeOrKey.id;
        const matches = all.filter((item) => item.key.scope === scope && item.key.id === id);
        return matches.length === 1 ? matches[0] : undefined;
    }
    function resolveEffective(id) {
        return resolveEffectiveResource(all, id);
    }
    function resolveSelector(selector) {
        if (selector.scope)
            return resolveExact(selector.scope, selector.id);
        return resolveEffective(selector.id);
    }
    return { all, effective, resolveExact, resolveEffective, resolveSelector };
}
export function computeEffectiveView(all) {
    const ids = [];
    const seen = new Set();
    for (const item of all) {
        if (seen.has(item.key.id))
            continue;
        seen.add(item.key.id);
        ids.push(item.key.id);
    }
    return ids
        .map((id) => resolveEffectiveResource(all, id))
        .filter((item) => item !== undefined);
}
/**
 * Project-over-global effective resolution. A project definition shadows a
 * same-ID global definition even when the project definition is invalid; an
 * ambiguous project scope (duplicate IDs) fails closed instead of falling
 * back to the global resource.
 */
export function resolveEffectiveResource(all, id) {
    const projectMatches = all.filter((item) => item.key.id === id && item.key.scope === "project");
    if (projectMatches.length === 1)
        return projectMatches[0];
    if (projectMatches.length > 1)
        return undefined;
    const globalMatches = all.filter((item) => item.key.id === id && item.key.scope === "global");
    return globalMatches.length === 1 ? globalMatches[0] : undefined;
}
export function resolveExactResource(all, key) {
    const matches = all.filter((item) => item.key.scope === key.scope && item.key.id === key.id);
    return matches.length === 1 ? matches[0] : undefined;
}
export function resolveResourceSelector(all, selector) {
    if (selector.scope)
        return resolveExactResource(all, { scope: selector.scope, id: selector.id });
    return resolveEffectiveResource(all, selector.id);
}
export function scopedResourceId(key) {
    return `${key.scope}:${key.id}`;
}
//# sourceMappingURL=catalog.js.map