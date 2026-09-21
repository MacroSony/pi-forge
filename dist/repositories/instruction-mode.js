import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInstructionModeFault, parseInstructionMode, } from "../codecs/instruction-mode.js";
import { globalForgeDir } from "../storage.js";
export const MAX_INSTRUCTION_MODE_SOURCE_SIZE = 1024 * 1024; // 1 MiB
export function globalInstructionModesDir() {
    return join(globalForgeDir(), "instruction-modes");
}
export function instructionModesDir(cwd) {
    return join(cwd, ".pi", "forge", "instruction-modes");
}
/**
 * Read global instruction modes.
 * Returns empty array if directory does not exist (ENOENT).
 * Throws on real directory read errors (e.g. permission denied) to fail closed.
 */
export function readGlobalInstructionModes(globalDir = globalInstructionModesDir()) {
    const modes = loadInstructionModesFromDir(globalDir, "global");
    annotateDuplicateInstructionModeIds(modes);
    return modes;
}
/**
 * Read scoped instruction modes (global and project).
 * Returns empty array for missing directory (ENOENT); throws on real directory read errors.
 * Preserves faults for shadowed resolution and attaches errors to same-scope duplicate IDs.
 */
export function readInstructionModesScoped(cwd, globalDir = globalInstructionModesDir()) {
    const modes = [
        ...loadInstructionModesFromDir(globalDir, "global"),
        ...loadInstructionModesFromDir(instructionModesDir(cwd), "project"),
    ];
    annotateDuplicateInstructionModeIds(modes);
    return modes;
}
/**
 * Read a single instruction mode file.
 * Returns a LoadedInstructionMode fault if reading or parsing fails, or if file exceeds 1MiB.
 */
export function readSingleInstructionModeFile(filePath, scope = "project") {
    let source;
    try {
        const stat = statSync(filePath);
        if (stat.size > MAX_INSTRUCTION_MODE_SOURCE_SIZE) {
            return createInstructionModeFault(filePath, scope, `Instruction mode file size (${stat.size} bytes) exceeds 1MiB limit.`);
        }
        const buf = readFileSync(filePath);
        if (buf.byteLength > MAX_INSTRUCTION_MODE_SOURCE_SIZE) {
            return createInstructionModeFault(filePath, scope, `Instruction mode file size (${buf.byteLength} bytes) exceeds 1MiB limit.`);
        }
        source = buf.toString("utf8");
    }
    catch (error) {
        return createInstructionModeFault(filePath, scope, `Failed to read instruction mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseInstructionMode(source, filePath, scope);
}
function loadInstructionModesFromDir(dir, scope) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch (error) {
        const err = error;
        if (err && (err.code === "ENOENT" || (typeof err.message === "string" && err.message.includes("ENOENT")))) {
            return [];
        }
        throw error instanceof Error ? error : new Error(String(error));
    }
    const fileNames = [];
    for (const entry of entries) {
        if (!entry.name.endsWith(".json") || entry.name.startsWith("."))
            continue;
        if (entry.isDirectory())
            continue;
        if (entry.isSymbolicLink()) {
            try {
                if (!statSync(join(dir, entry.name)).isFile())
                    continue;
            }
            catch {
                // Retain broken symlinks so read will record a fault
            }
        }
        else if (!entry.isFile()) {
            continue;
        }
        fileNames.push(entry.name);
    }
    fileNames.sort();
    return fileNames.map((name) => readSingleInstructionModeFile(join(dir, name), scope));
}
function annotateDuplicateInstructionModeIds(modes) {
    const byScopeId = new Map();
    for (const loaded of modes) {
        const key = `${loaded.scope}\0${loaded.mode.id}`;
        const matches = byScopeId.get(key) ?? [];
        matches.push(loaded);
        byScopeId.set(key, matches);
    }
    for (const matches of byScopeId.values()) {
        if (matches.length <= 1)
            continue;
        const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
        for (const loaded of matches) {
            loaded.diagnostics.push({
                level: "error",
                message: `Duplicate ${loaded.scope} instruction mode id: "${loaded.mode.id}" appears in multiple files (${files}).`,
            });
        }
    }
}
//# sourceMappingURL=instruction-mode.js.map