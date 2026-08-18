import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveResourceSelector } from "./catalog.js";
import { parseResourceSelector } from "./resource-identity.js";
import { globalPromptStacksDir, promptStackReadDirs } from "./storage.js";
import { createPromptStackFault, parsePromptStack } from "./codecs/prompt-stack.js";
export { globalPromptStacksDir, isInsideGlobalPromptStackStorage, isInsidePromptStackStorage, isSafeGlobalPromptStackMutationPath, isSafePromptStackMutationPath, legacyPromptStacksDir, promptStackPath, promptStackReadDirs, promptStacksDir, } from "./storage.js";
export { isValidResourceId as isValidPromptStackId } from "./resource-identity.js";
export { validatePromptStack } from "./codecs/prompt-stack.js";
export function loadPromptStacks(cwd) {
    const loaded = promptStackFiles(promptStackReadDirs(cwd)).map((file) => loadPromptStackFile(file, "project"));
    annotateDuplicateStackIds(loaded);
    return loaded;
}
/**
 * Load both global and project prompt stacks. Global definitions are
 * user-owned and always load; project definitions load from the trusted
 * project directories plus the legacy project directory.
 */
export function loadPromptStacksScoped(cwd, globalDir = globalPromptStacksDir()) {
    const loaded = [
        ...promptStackFiles([globalDir]).map((file) => loadPromptStackFile(file, "global")),
        ...promptStackFiles(promptStackReadDirs(cwd)).map((file) => loadPromptStackFile(file, "project")),
    ];
    annotateDuplicateStackIds(loaded);
    return loaded;
}
/** Load only the user-owned global stacks, used by untrusted projects. */
export function loadGlobalPromptStacks(globalDir = globalPromptStacksDir()) {
    const loaded = promptStackFiles([globalDir]).map((file) => loadPromptStackFile(file, "global"));
    annotateDuplicateStackIds(loaded);
    return loaded;
}
function promptStackFiles(dirs) {
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
export function chooseDefaultStack(stacks, preferredId) {
    if (isDisabledPromptStackId(preferredId))
        return undefined;
    if (preferredId) {
        const parsed = parseResourceSelector(preferredId);
        if (parsed.ok) {
            const preferred = resolveResourceSelector(stacks, parsed.selector);
            if (preferred && isUsablePromptStack(preferred))
                return preferred;
        }
    }
    return chooseAutoActivateStack(stacks);
}
/**
 * Standalone prompt-stack auto-activation with project-over-global scope
 * precedence. Only `autoActivate: true` participates. A project scope with
 * an invalid or ambiguous candidate fails closed instead of falling back to
 * a global candidate.
 */
export function chooseAutoActivateStack(stacks) {
    // A project scope with any auto-activation candidate fails closed on
    // ambiguity or invalidity; it never falls back to a global candidate.
    const projectCandidates = stacks.filter((loaded) => loaded.scope === "project" && loaded.stack.autoActivate === true);
    if (projectCandidates.length > 0) {
        return projectCandidates.length === 1 && isUsablePromptStack(projectCandidates[0])
            ? projectCandidates[0]
            : undefined;
    }
    // A same-ID project stack shadows a global stack even when the project
    // stack opted out or is invalid, so those global candidates never apply.
    const projectIds = new Set(stacks.filter((loaded) => loaded.scope === "project").map((loaded) => loaded.stack.id));
    const globalCandidates = stacks.filter((loaded) => loaded.scope === "global" && loaded.stack.autoActivate === true && !projectIds.has(loaded.stack.id));
    return globalCandidates.length === 1 && isUsablePromptStack(globalCandidates[0])
        ? globalCandidates[0]
        : undefined;
}
export function isUsablePromptStack(loaded) {
    return !loaded.diagnostics.some((diagnostic) => diagnostic.level === "error");
}
export function isDisabledPromptStackId(id) {
    return id === "none" || id === "off";
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
//# sourceMappingURL=loader.js.map