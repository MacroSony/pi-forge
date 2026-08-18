import type { ResourceScope } from "../resource-identity.ts";
import type { PromptStack } from "../types.ts";
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
export declare function promptStackTargetPath(cwd: string, scope: RepositoryScope, id: string): string;
/**
 * Write a prompt stack. This is the only write path for prompt-stack domain
 * resources. `overwrite: false` refuses to clobber an existing file, matching
 * the current replacement semantics (no expected-fingerprint conflict or atomic
 * replacement is introduced yet).
 */
export declare function writePromptStackFile(cwd: string, scope: RepositoryScope, filePath: string, stack: PromptStack, options: {
    overwrite: boolean;
}): PromptStackWriteResult;
export declare function deletePromptStackFile(cwd: string, scope: RepositoryScope, filePath: string): PromptStackDeleteResult;
//# sourceMappingURL=prompt-stack.d.ts.map