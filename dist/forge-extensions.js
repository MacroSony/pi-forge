var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getRegisteredMacros, registerMacro, } from "./macro-engine.js";
import { promptRenderHelpers } from "./render-helpers.js";
import { getRegisteredSlots, registerSlot, } from "./slot-renderers.js";
import { forgeDir, forgeExtensionsDir, globalForgeDir, globalForgeExtensionsDir } from "./storage.js";
export function createForgeExtensionState() {
    return { unregister: [], loadVersion: 0 };
}
export async function reloadForgeExtensions(cwd, state) {
    const diagnostics = unloadForgeExtensions(state);
    state.loadVersion++;
    const loadedPaths = [];
    for (const candidate of discoverForgeExtensionCandidates(cwd)) {
        const result = await loadForgeExtensionFile(cwd, candidate.forgeDir, candidate.filePath, state.loadVersion);
        diagnostics.push(...result.diagnostics);
        if (result.loaded) {
            state.unregister.push(...result.unregister);
            loadedPaths.push(candidate.filePath);
        }
    }
    return { diagnostics, loadedPaths };
}
export function unloadForgeExtensions(state) {
    const diagnostics = [];
    for (const unregister of state.unregister.splice(0).reverse()) {
        try {
            unregister();
        }
        catch (error) {
            diagnostics.push({
                level: "warning",
                message: `Failed to unload pi-forge extension: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return diagnostics;
}
export function discoverForgeExtensionFiles(cwd) {
    return discoverForgeExtensionCandidates(cwd).map((candidate) => candidate.filePath);
}
function discoverForgeExtensionCandidates(cwd) {
    const dirs = [
        { dir: globalForgeExtensionsDir(), forgeDir: globalForgeDir() },
        { dir: forgeExtensionsDir(cwd), forgeDir: forgeDir(cwd) },
    ];
    const seenDirs = new Set();
    return dirs.flatMap(({ dir, forgeDir }) => {
        if (seenDirs.has(dir))
            return [];
        seenDirs.add(dir);
        return discoverForgeExtensionFilesInDir(dir).map((filePath) => ({ filePath, forgeDir }));
    });
}
function discoverForgeExtensionFilesInDir(dir) {
    if (!existsSync(dir))
        return [];
    const files = [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    for (const name of entries.sort()) {
        if (name.startsWith("."))
            continue;
        const fullPath = join(dir, name);
        let stats;
        try {
            stats = statSync(fullPath);
        }
        catch {
            continue;
        }
        if (stats.isFile() && isForgeExtensionFile(fullPath)) {
            files.push(fullPath);
            continue;
        }
        if (!stats.isDirectory())
            continue;
        for (const indexName of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
            const indexPath = join(fullPath, indexName);
            if (existsSync(indexPath)) {
                files.push(indexPath);
                break;
            }
        }
    }
    return files;
}
async function loadForgeExtensionFile(cwd, forgeDirPath, filePath, loadVersion) {
    const unregister = [];
    const diagnostics = [];
    try {
        const module = await import(__rewriteRelativeImportExtension(`${pathToFileURL(filePath).href}?piForgeReload=${loadVersion}`));
        const register = readRegisterFunction(module);
        if (!register) {
            return {
                loaded: false,
                unregister,
                diagnostics: [{
                        level: "warning",
                        message: `pi-forge extension ${extensionLabel(filePath)} must export a default function or named register function.`,
                    }],
            };
        }
        const cleanup = await register(createForgeExtensionApi(cwd, forgeDirPath, filePath, unregister));
        if (typeof cleanup === "function")
            unregister.push(once(cleanup));
        return { loaded: true, unregister, diagnostics };
    }
    catch (error) {
        for (const cleanup of unregister.splice(0).reverse()) {
            try {
                cleanup();
            }
            catch {
                // Preserve the original load error; cleanup failures are secondary.
            }
        }
        diagnostics.push({
            level: "warning",
            message: `Failed to load pi-forge extension ${extensionLabel(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return { loaded: false, unregister: [], diagnostics };
    }
}
function createForgeExtensionApi(cwd, forgeDirPath, extensionPath, unregister) {
    return {
        cwd,
        forgeDir: forgeDirPath,
        extensionPath,
        helpers: promptRenderHelpers,
        registerMacro: (definition) => trackUnregister(unregister, registerMacro(definition)),
        registerSlot: (definition) => trackUnregister(unregister, registerSlot(definition)),
        getRegisteredMacros,
        getRegisteredSlots,
    };
}
function trackUnregister(unregisters, unregister) {
    const tracked = once(unregister);
    unregisters.push(tracked);
    return tracked;
}
function once(callback) {
    let active = true;
    return () => {
        if (!active)
            return;
        active = false;
        callback();
    };
}
function readRegisterFunction(module) {
    const record = module && typeof module === "object" ? module : {};
    if (typeof record.default === "function")
        return record.default;
    if (typeof record.register === "function")
        return record.register;
    if (record.default && typeof record.default === "object" && typeof record.default.register === "function") {
        return record.default.register;
    }
    return undefined;
}
function isForgeExtensionFile(filePath) {
    return (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) && !filePath.endsWith(".d.ts");
}
function extensionLabel(filePath) {
    return basename(filePath);
}
//# sourceMappingURL=forge-extensions.js.map