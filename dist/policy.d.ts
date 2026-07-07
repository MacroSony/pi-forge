import type { PromptResourcePolicy } from "./types.ts";
export declare function hasResourcePolicy(policy: PromptResourcePolicy | undefined): boolean;
export declare function applyResourcePolicy(names: string[], policy: PromptResourcePolicy | undefined): string[];
export declare function matchesAnyPattern(name: string, patterns: string[]): boolean;
export declare function resourcePatternMatches(name: string, pattern: string): boolean;
//# sourceMappingURL=policy.d.ts.map