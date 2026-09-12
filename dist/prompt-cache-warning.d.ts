import type { CompileCycleState } from "./compile-cycle.ts";
import type { ContextDiffProviderUsage } from "./context-diff-history.ts";
import type { LoadedPromptStack } from "./types.ts";
export interface PromptCacheImpact {
    commonPrefixChars: number;
    commonPrefixTokens: number;
    currentPromptTokens: number;
    remainingPromptTokens: number;
    retentionPercent: number;
}
/** Find the character-level common prefix used by the cache estimate. */
export declare function commonPrefixLength(currentPrompt: string, nextPrompt: string): number;
/** Pure prompt-change decision and estimate; identical prompts intentionally return no impact. */
export declare function calculatePromptCacheImpact(currentPrompt: string, nextPrompt: string): PromptCacheImpact | undefined;
/** Pure warning formatter, kept separate so command/runtime integration is easy to test. */
export declare function formatPromptCacheWarning(currentPrompt: string, nextPrompt: string, usage?: Pick<ContextDiffProviderUsage, "cacheRead" | "cacheStatus">): string | undefined;
/**
 * Build the user-facing warning before the active stack is changed. The saved
 * compilation runtime is the same runtime used by lifecycle's last compile.
 * Compilation failures are deliberately ignored so this path cannot block a switch.
 */
export declare function promptCacheWarningForStackSwitch(current: LoadedPromptStack | undefined, next: LoadedPromptStack | undefined, compileCycle: CompileCycleState, usage?: ContextDiffProviderUsage): string | undefined;
//# sourceMappingURL=prompt-cache-warning.d.ts.map