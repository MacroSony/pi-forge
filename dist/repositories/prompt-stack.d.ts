import type { ResourceScope } from "../resource-identity.ts";
import type { LoadedPromptStack, PromptStack } from "../types.ts";
export type RepositoryScope = Extract<ResourceScope, "project" | "global">;
export type PromptStackWriteResult = {
    ok: true;
    filePath: string;
} | {
    ok: false;
    reason: "invalid-path" | "exists" | "io";
    error: string;
};
export type PromptStackDeleteResult = {
    ok: true;
    filePath: string;
} | {
    ok: false;
    reason: "invalid-path" | "missing" | "io";
    error: string;
};
export declare function readPromptStacks(cwd: string): LoadedPromptStack[];
export declare function readPromptStacksScoped(cwd: string, globalDir?: string): LoadedPromptStack[];
export declare function readGlobalPromptStacks(globalDir?: string): LoadedPromptStack[];
export declare function promptStackTargetPath(cwd: string, scope: RepositoryScope, id: string): string;
export declare function writePromptStackFile(cwd: string, scope: RepositoryScope, filePath: string, stack: PromptStack, options: {
    overwrite: boolean;
}): PromptStackWriteResult;
export declare function deletePromptStackFile(cwd: string, scope: RepositoryScope, filePath: string): PromptStackDeleteResult;
//# sourceMappingURL=prompt-stack.d.ts.map