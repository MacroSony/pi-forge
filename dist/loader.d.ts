import type { LoadedPromptStack } from "./types.ts";
export { globalPromptStacksDir, isInsideGlobalPromptStackStorage, isInsidePromptStackStorage, isSafeGlobalPromptStackMutationPath, isSafePromptStackMutationPath, legacyPromptStacksDir, promptStackPath, promptStackReadDirs, promptStacksDir, } from "./storage.ts";
export { isValidResourceId as isValidPromptStackId } from "./resource-identity.ts";
export { validatePromptStack } from "./codecs/prompt-stack.ts";
export declare function loadPromptStacks(cwd: string): LoadedPromptStack[];
/**
 * Load both global and project prompt stacks. Global definitions are
 * user-owned and always load; project definitions load from the trusted
 * project directories plus the legacy project directory.
 */
export declare function loadPromptStacksScoped(cwd: string, globalDir?: string): LoadedPromptStack[];
/** Load only the user-owned global stacks, used by untrusted projects. */
export declare function loadGlobalPromptStacks(globalDir?: string): LoadedPromptStack[];
export declare function chooseDefaultStack(stacks: LoadedPromptStack[], preferredId?: string): LoadedPromptStack | undefined;
/**
 * Standalone prompt-stack auto-activation with project-over-global scope
 * precedence. Only `autoActivate: true` participates. A project scope with
 * an invalid or ambiguous candidate fails closed instead of falling back to
 * a global candidate.
 */
export declare function chooseAutoActivateStack(stacks: LoadedPromptStack[]): LoadedPromptStack | undefined;
export declare function isUsablePromptStack(loaded: LoadedPromptStack): boolean;
export declare function isDisabledPromptStackId(id: string | undefined): boolean;
//# sourceMappingURL=loader.d.ts.map