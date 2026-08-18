import type { LoadedPromptStack } from "./types.ts";
export { globalPromptStacksDir, isInsideGlobalPromptStackStorage, isInsidePromptStackStorage, isSafeGlobalPromptStackMutationPath, isSafePromptStackMutationPath, legacyPromptStacksDir, promptStackPath, promptStackReadDirs, promptStacksDir, } from "./storage.ts";
export { isValidResourceId as isValidPromptStackId } from "./resource-identity.ts";
export { validatePromptStack } from "./codecs/prompt-stack.ts";
/** Read project stacks (delegated to the repository read path). */
export declare function loadPromptStacks(cwd: string): LoadedPromptStack[];
/** Read both global and project stacks (delegated to the repository read path). */
export declare function loadPromptStacksScoped(cwd: string, globalDir?: string): LoadedPromptStack[];
/** Read only the user-owned global stacks (delegated to the repository read path). */
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