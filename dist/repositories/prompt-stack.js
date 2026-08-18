import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createPromptStackFault, parsePromptStack, serializePromptStack } from "../codecs/prompt-stack.js";
import { globalPromptStacksDir, isSafeGlobalPromptStackMutationPath, isSafePromptStackMutationPath, promptStackPath, promptStackReadDirs, } from "../storage.js";
// ---------------------------------------------------------------------------
// Read (the only scoped read path).
// ---------------------------------------------------------------------------
export function readPromptStacks(cwd) {
    const loaded = promptStackFiles(promptStackReadDirs(cwd), "project").map((file) => loadPromptStackFile(file, "project"));
    annotateDuplicateStackIds(loaded);
    return loaded;
}
export function readPromptStacksScoped(cwd, globalDir = globalPromptStacksDir()) {
    const loaded = [
        ...promptStackFiles([globalDir], "global").map((file) => loadPromptStackFile(file, "global")),
        ...promptStackFiles(promptStackReadDirs(cwd), "project").map((file) => loadPromptStackFile(file, "project")),
    ];
    annotateDuplicateStackIds(loaded);
    return loaded;
}
export function readGlobalPromptStacks(globalDir = globalPromptStacksDir()) {
    const loaded = promptStackFiles([globalDir], "global").map((file) => loadPromptStackFile(file, "global"));
    annotateDuplicateStackIds(loaded);
    return loaded;
}
function promptStackFiles(dirs, scope) {
    const files = [];
    const shadowedNames = new Set();
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        let entries;
        try {
            entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
        }
        catch {
            continue;
        }
        for (const name of entries.sort()) {
            if (shadowedNames.has(name))
                continue;
            shadowedNames.add(name);
            files.push(join(dir, name));
        }
    }
    return files;
}
function loadPromptStackFile(filePath, scope) {
    let source;
    try {
        source = readFileSync(filePath, "utf8");
    }
    catch (error) {
        return createPromptStackFault(filePath, scope, `Failed to read prompt stack: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parsePromptStack(source, filePath, scope);
}
function annotateDuplicateStackIds(stacks) {
    const byScopeId = new Map();
    for (const loaded of stacks) {
        const key = `${loaded.scope}\0${loaded.stack.id}`;
        const matches = byScopeId.get(key) ?? [];
        matches.push(loaded);
        byScopeId.set(key, matches);
    }
    for (const matches of byScopeId.values()) {
        if (matches.length <= 1)
            continue;
        const id = matches[0].stack.id;
        const scope = matches[0].scope;
        const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
        for (const loaded of matches) {
            loaded.diagnostics.push({
                level: "error",
                message: `Duplicate ${scope} stack id: ${id} appears in multiple files (${files}).`,
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Write / delete (the only scoped mutation path).
// ---------------------------------------------------------------------------
export function promptStackTargetPath(cwd, scope, id) {
    return scope === "global" ? join(globalPromptStacksDir(), `${id}.json`) : promptStackPath(cwd, id);
}
function isSafeTarget(cwd, scope, filePath) {
    return scope === "project"
        ? isSafePromptStackMutationPath(cwd, filePath)
        : isSafeGlobalPromptStackMutationPath(filePath);
}
function targetError(scope, filePath) {
    return `Prompt stack path is outside ${scope} prompt-stack storage or traverses a symbolic link: ${filePath}`;
}
export function writePromptStackFile(cwd, scope, filePath, stack, options) {
    if (!isSafeTarget(cwd, scope, filePath)) {
        return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
    }
    if (!options.overwrite && existsSync(filePath)) {
        return { ok: false, reason: "exists", error: `Prompt stack already exists: ${filePath}` };
    }
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, serializePromptStack(stack), { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
        return { ok: true, filePath };
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code === "EEXIST")
            return { ok: false, reason: "exists", error: `Prompt stack already exists: ${filePath}` };
        return { ok: false, reason: "io", error: `Failed to write prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export function deletePromptStackFile(cwd, scope, filePath) {
    if (!isSafeTarget(cwd, scope, filePath)) {
        return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
    }
    if (!existsSync(filePath))
        return { ok: false, reason: "missing", error: `Prompt stack does not exist: ${filePath}` };
    try {
        unlinkSync(filePath);
        return { ok: true, filePath };
    }
    catch (error) {
        return { ok: false, reason: "io", error: `Failed to delete prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
}
//# sourceMappingURL=prompt-stack.js.map