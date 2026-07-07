export function hasResourcePolicy(policy) {
    return !!policy && (hasEffectiveAllowPolicy(policy.allow) || hasPatterns(policy.deny));
}
export function applyResourcePolicy(names, policy) {
    if (!hasResourcePolicy(policy))
        return names;
    if (hasEffectiveAllowPolicy(policy?.allow)) {
        return names.filter((name) => matchesAnyPattern(name, policy.allow));
    }
    if (hasPatterns(policy?.deny)) {
        return names.filter((name) => !matchesAnyPattern(name, policy.deny));
    }
    return names;
}
export function matchesAnyPattern(name, patterns) {
    return patterns.some((pattern) => resourcePatternMatches(name, pattern));
}
export function resourcePatternMatches(name, pattern) {
    if (pattern === "*")
        return true;
    if (!pattern.includes("*"))
        return name === pattern;
    const escaped = pattern
        .split("*")
        .map(escapeRegExp)
        .join(".*");
    return new RegExp(`^${escaped}$`).test(name);
}
function hasPatterns(value) {
    return Array.isArray(value) && value.length > 0;
}
function hasEffectiveAllowPolicy(value) {
    return hasPatterns(value) && value.some((pattern) => pattern !== "*");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=policy.js.map