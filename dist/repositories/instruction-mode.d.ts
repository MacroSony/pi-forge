import { type LoadedInstructionMode } from "../codecs/instruction-mode.ts";
import type { ResourceScope } from "../resource-identity.ts";
export { type LoadedInstructionMode };
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
//# sourceMappingURL=instruction-mode.d.ts.map