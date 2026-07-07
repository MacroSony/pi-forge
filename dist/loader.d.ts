import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "./types.ts";
export { isInsidePromptStackStorage, legacyPromptStacksDir, promptStackPath, promptStackReadDirs, promptStacksDir } from "./storage.ts";
export declare function loadPromptStacks(cwd: string): LoadedPromptStack[];
export declare function chooseDefaultStack(stacks: LoadedPromptStack[], preferredId?: string): LoadedPromptStack | undefined;
export declare function isUsablePromptStack(loaded: LoadedPromptStack): boolean;
export declare function isDisabledPromptStackId(id: string | undefined): boolean;
export declare function validatePromptStack(stack: PromptStack): PromptStackDiagnostic[];
//# sourceMappingURL=loader.d.ts.map