import { type InstructionMode, type LoadedInstructionMode } from "../codecs/instruction-mode.ts";
import { type ResourceScope } from "../resource-identity.ts";
export { type InstructionMode, type LoadedInstructionMode };
export type InstructionModeMutationResult = {
    ok: true;
} | {
    ok: false;
    reason: "invalid-path" | "invalid-mode" | "conflict" | "io-error";
    error: string;
};
export type InstructionModeWriteResult = InstructionModeMutationResult;
export type InstructionModeDeleteResult = InstructionModeMutationResult;
export declare const MAX_INSTRUCTION_MODE_SOURCE_SIZE: number;
export declare function globalInstructionModesDir(): string;
export declare function instructionModesDir(cwd: string): string;
/**
 * Read global instruction modes.
 * Returns empty array if directory does not exist (ENOENT).
 * Throws on real directory read errors (e.g. permission denied) to fail closed.
 */
export declare function readGlobalInstructionModes(globalDir?: string): LoadedInstructionMode[];
/**
 * Read scoped instruction modes (global and project).
 * Returns empty array for missing directory (ENOENT); throws on real directory read errors.
 * Preserves faults for shadowed resolution and attaches errors to same-scope duplicate IDs.
 */
export declare function readInstructionModesScoped(cwd: string, globalDir?: string): LoadedInstructionMode[];
/**
 * Read a single instruction mode file.
 * Returns a LoadedInstructionMode fault if reading or parsing fails, or if file exceeds 1MiB.
 */
export declare function readSingleInstructionModeFile(filePath: string, scope?: ResourceScope): LoadedInstructionMode;
/**
 * Compute the sha256 revision hash of raw instruction mode file bytes.
 * Throws ENOENT if missing or an Error if size exceeds 1MiB limit.
 */
export declare function instructionModeRevision(filePath: string): string;
/**
 * Write an instruction mode file.
 * Creates exclusively with "wx" when overwrite is false.
 * Updates atomically with expectedSourceRevision check when overwrite is true.
 */
export declare function writeInstructionModeFile(cwd: string, scope: ResourceScope, filePath: string, mode: InstructionMode, options: {
    overwrite: boolean;
    expectedSourceRevision?: string;
}): InstructionModeWriteResult;
/**
 * Delete an instruction mode file with expectedSourceRevision check.
 */
export declare function deleteInstructionModeFile(cwd: string, scope: ResourceScope, filePath: string, options: {
    expectedSourceRevision: string;
}): InstructionModeDeleteResult;
//# sourceMappingURL=instruction-mode.d.ts.map