import { PromptCompilationContext } from "./compiler.js";
import { formatResourceKey } from "./resource-identity.js";
/** Find the character-level common prefix used by the cache estimate. */
export function commonPrefixLength(currentPrompt, nextPrompt) {
    const currentCharacters = Array.from(currentPrompt);
    const nextCharacters = Array.from(nextPrompt);
    const limit = Math.min(currentCharacters.length, nextCharacters.length);
    let index = 0;
    while (index < limit && currentCharacters[index] === nextCharacters[index])
        index += 1;
    return index;
}
/** Pure prompt-change decision and estimate; identical prompts intentionally return no impact. */
export function calculatePromptCacheImpact(currentPrompt, nextPrompt) {
    if (currentPrompt === nextPrompt)
        return undefined;
    const commonPrefixChars = commonPrefixLength(currentPrompt, nextPrompt);
    const currentPromptChars = Array.from(currentPrompt).length;
    const currentPromptTokens = approximateTokens(currentPromptChars);
    const commonPrefixTokens = approximatePrefixTokens(commonPrefixChars);
    return {
        commonPrefixChars,
        commonPrefixTokens,
        currentPromptTokens,
        remainingPromptTokens: Math.max(0, currentPromptTokens - commonPrefixTokens),
        retentionPercent: currentPromptChars > 0 ? Math.round((commonPrefixChars / currentPromptChars) * 100) : 0,
    };
}
/** Pure warning formatter, kept separate so command/runtime integration is easy to test. */
export function formatPromptCacheWarning(currentPrompt, nextPrompt, usage) {
    const impact = calculatePromptCacheImpact(currentPrompt, nextPrompt);
    if (!impact)
        return undefined;
    const cacheSuffix = usage?.cacheStatus === "reported"
        ? ` Last request read ~${usage.cacheRead} tokens from cache.`
        : "";
    if (impact.commonPrefixChars > 0) {
        return `Switching will change the system prompt. Common prefix with current prompt: ~${impact.commonPrefixTokens} tokens (${impact.retentionPercent}%). The remaining ~${impact.remainingPromptTokens} tokens of history will be re-processed.${cacheSuffix}`;
    }
    return `Switching replaces the system prompt entirely; the full prompt prefix (~${impact.currentPromptTokens} tokens) will be re-processed.${cacheSuffix}`;
}
/**
 * Build the user-facing warning before the active stack is changed. The saved
 * compilation runtime is the same runtime used by lifecycle's last compile.
 * Compilation failures are deliberately ignored so this path cannot block a switch.
 */
export function promptCacheWarningForStackSwitch(current, next, compileCycle, usage) {
    if (stackKey(current) === stackKey(next))
        return undefined;
    if (compileCycle.currentCompilationRuntime
        && compileCycle.currentCompiledSystemPrompt !== undefined
        && compileCycle.currentCompiledStackKey === stackKey(current)) {
        try {
            const nextPrompt = next
                ? new PromptCompilationContext(next.stack, compileCycle.currentCompilationRuntime).compileSystemPrompt(compileCycle.currentBaseSystemPrompt ?? "").systemPrompt
                : compileCycle.currentBaseSystemPrompt ?? "";
            return formatPromptCacheWarning(compileCycle.currentCompiledSystemPrompt, nextPrompt, usage);
        }
        catch {
            return undefined;
        }
    }
    return "Switching may change the system prompt; prompt cache impact cannot be estimated until a request has been compiled.";
}
function stackKey(stack) {
    return stack ? formatResourceKey(stack.key) : undefined;
}
function approximateTokens(chars) {
    return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}
function approximatePrefixTokens(chars) {
    return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}
//# sourceMappingURL=prompt-cache-warning.js.map