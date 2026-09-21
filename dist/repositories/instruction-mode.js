import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInstructionModeFault, isUsableInstructionMode, parseInstructionMode, serializeInstructionMode, } from "../codecs/instruction-mode.js";
import { isValidResourceId } from "../resource-identity.js";
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
    let sourceRevision;
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
        sourceRevision = createHash("sha256").update(buf).digest("hex");
    }
    catch (error) {
        return createInstructionModeFault(filePath, scope, `Failed to read instruction mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...parseInstructionMode(source, filePath, scope), sourceRevision };
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
/**
 * Compute the sha256 revision hash of raw instruction mode file bytes.
 * Throws ENOENT if missing or an Error if size exceeds 1MiB limit.
 */
export function instructionModeRevision(filePath) {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Expected a regular file at ${filePath}`);
    }
    if (stat.size > MAX_INSTRUCTION_MODE_SOURCE_SIZE) {
        throw new Error(`Instruction mode file size (${stat.size} bytes) exceeds 1MiB limit.`);
    }
    const buf = readFileSync(filePath);
    if (buf.byteLength > MAX_INSTRUCTION_MODE_SOURCE_SIZE) {
        throw new Error(`Instruction mode file size (${buf.byteLength} bytes) exceeds 1MiB limit.`);
    }
    return createHash("sha256").update(buf).digest("hex");
}
function pathTraversesNoSymlink(anchor, target) {
    const resolvedAnchor = resolve(anchor);
    const resolvedTarget = resolve(target);
    const rel = relative(resolvedAnchor, resolvedTarget);
    if (rel.startsWith("..") || isAbsolute(rel))
        return false;
    try {
        if (lstatSync(resolvedAnchor).isSymbolicLink())
            return false;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            return false;
        // anchor does not exist yet
    }
    let current = resolvedAnchor;
    for (const segment of rel.split(sep)) {
        if (!segment || segment === ".")
            continue;
        current = join(current, segment);
        try {
            if (lstatSync(current).isSymbolicLink())
                return false;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                return false;
            // segment does not exist yet
        }
    }
    return true;
}
function verifyInstructionModePath(cwd, scope, filePath, expectedId) {
    if (scope !== "project" && scope !== "global") {
        return { ok: false, reason: "invalid-path", error: `Invalid scope: ${String(scope)}` };
    }
    if (!filePath || typeof filePath !== "string") {
        return { ok: false, reason: "invalid-path", error: "File path is required." };
    }
    const rootDir = resolve(scope === "global" ? globalInstructionModesDir() : instructionModesDir(cwd));
    const anchor = resolve(scope === "global" ? globalForgeDir() : cwd);
    const resolvedTarget = resolve(filePath);
    if (dirname(resolvedTarget) !== rootDir) {
        return { ok: false, reason: "invalid-path", error: `Path is outside ${scope} root (${rootDir}): ${filePath}` };
    }
    const fileName = basename(resolvedTarget);
    if (!fileName.endsWith(".json") || fileName.startsWith(".")) {
        return { ok: false, reason: "invalid-path", error: `File must be a non-hidden .json file: ${fileName}` };
    }
    const id = basename(fileName, ".json");
    if (!isValidResourceId(id) || (expectedId !== undefined && expectedId !== id)) {
        return { ok: false, reason: "invalid-path", error: `Invalid ID or rename mismatch: ${fileName}` };
    }
    if (!pathTraversesNoSymlink(anchor, resolvedTarget)) {
        return { ok: false, reason: "invalid-path", error: `Path traverses or targets a symlink: ${filePath}` };
    }
    try {
        if (lstatSync(resolvedTarget).isDirectory()) {
            return { ok: false, reason: "invalid-path", error: `Path is a directory: ${filePath}` };
        }
    }
    catch {
        // Target does not exist yet
    }
    return { ok: true, rootDir, fileName };
}
function checkExpectedRevision(filePath, expected) {
    if (!expected)
        return { ok: false, reason: "conflict", error: "expectedSourceRevision is required." };
    if (!existsSync(filePath))
        return { ok: false, reason: "conflict", error: `File does not exist: ${filePath}` };
    try {
        const current = instructionModeRevision(filePath);
        if (current !== expected) {
            return { ok: false, reason: "conflict", error: `Revision conflict: expected ${expected}, got ${current}.` };
        }
    }
    catch (err) {
        if (err?.code === "ENOENT")
            return { ok: false, reason: "conflict", error: `File does not exist: ${filePath}` };
        return { ok: false, reason: "io-error", error: `Failed to read revision: ${err instanceof Error ? err.message : String(err)}` };
    }
    return null;
}
/**
 * Write an instruction mode file.
 * Creates exclusively with "wx" when overwrite is false.
 * Updates atomically with expectedSourceRevision check when overwrite is true.
 */
export function writeInstructionModeFile(cwd, scope, filePath, mode, options) {
    const pathCheck = verifyInstructionModePath(cwd, scope, filePath, mode?.id);
    if (!pathCheck.ok)
        return pathCheck;
    let serialized;
    try {
        serialized = serializeInstructionMode(mode);
    }
    catch (error) {
        return { ok: false, reason: "invalid-mode", error: `Failed to serialize mode: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_INSTRUCTION_MODE_SOURCE_SIZE) {
        return { ok: false, reason: "invalid-mode", error: "Instruction mode file size exceeds 1MiB limit." };
    }
    const parsed = parseInstructionMode(serialized, filePath, scope);
    if (!isUsableInstructionMode(parsed)) {
        const msg = parsed.diagnostics.filter((d) => d.level === "error").map((d) => d.message).join("; ");
        return { ok: false, reason: "invalid-mode", error: msg || "Invalid instruction mode." };
    }
    const { rootDir, fileName } = pathCheck;
    if (!options.overwrite) {
        if (existsSync(filePath))
            return { ok: false, reason: "conflict", error: `Instruction mode already exists: ${filePath}` };
        try {
            mkdirSync(rootDir, { recursive: true });
            writeFileSync(filePath, serialized, { encoding: "utf8", flag: "wx" });
            return { ok: true };
        }
        catch (error) {
            if (error?.code === "EEXIST")
                return { ok: false, reason: "conflict", error: `Instruction mode already exists: ${filePath}` };
            return { ok: false, reason: "io-error", error: `Failed to write mode: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    const revConflict = checkExpectedRevision(filePath, options.expectedSourceRevision);
    if (revConflict)
        return revConflict;
    const tempPath = join(rootDir, `.${fileName}.${randomUUID()}.tmp`);
    try {
        mkdirSync(rootDir, { recursive: true });
        writeFileSync(tempPath, serialized, "utf8");
        renameSync(tempPath, filePath);
        return { ok: true };
    }
    catch (error) {
        try {
            if (existsSync(tempPath))
                unlinkSync(tempPath);
        }
        catch { }
        return { ok: false, reason: "io-error", error: `Failed to write mode: ${error instanceof Error ? error.message : String(error)}` };
    }
}
/**
 * Delete an instruction mode file with expectedSourceRevision check.
 */
export function deleteInstructionModeFile(cwd, scope, filePath, options) {
    const pathCheck = verifyInstructionModePath(cwd, scope, filePath);
    if (!pathCheck.ok)
        return pathCheck;
    const revConflict = checkExpectedRevision(filePath, options?.expectedSourceRevision);
    if (revConflict)
        return revConflict;
    try {
        unlinkSync(filePath);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, reason: "io-error", error: `Failed to delete mode: ${error instanceof Error ? error.message : String(error)}` };
    }
}
//# sourceMappingURL=instruction-mode.js.map