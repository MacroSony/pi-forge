import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "../forge-extensions.js";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks } from "../loader.js";
import { selectedActiveId as selectedActiveIdForState } from "../preset-command.js";
import { STATE_ENTRY_TYPE } from "../runtime-state.js";
export function createPromptStackRuntime(pi, state, deps) {
    const forgeExtensionState = createForgeExtensionState();
    function activeId() {
        return state.active?.stack.id;
    }
    function selectedActiveId() {
        return selectedActiveIdForState(state);
    }
    function persistActiveSelection(id) {
        if (id === state.lastPersistedActiveId)
            return;
        pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: id });
        state.lastPersistedActiveId = id;
    }
    function setActive(id, ctx) {
        if (!id || isDisabledPromptStackId(id)) {
            state.active = undefined;
            if (id)
                persistActiveSelection("none");
            if (ctx)
                updateStatus(ctx);
            deps.syncToolPolicy(ctx);
            return true;
        }
        const found = state.stacks.find((candidate) => candidate.stack.id === id);
        if (!found)
            return false;
        state.active = found;
        persistActiveSelection(found.stack.id);
        if (ctx)
            updateStatus(ctx);
        deps.syncToolPolicy(ctx);
        return true;
    }
    async function reloadStacks(ctx, preferredId, options = {}) {
        if (!ctx.isProjectTrusted()) {
            state.forgeExtensionDiagnostics = unloadForgeExtensions(forgeExtensionState);
            state.forgeExtensionPaths = [];
            state.stacks = [];
            state.profiles = [];
            state.active = undefined;
            if (!options.deferToolPolicy)
                deps.syncToolPolicy(ctx);
            ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
            updateStatus(ctx);
            return;
        }
        const extensionResult = await reloadForgeExtensions(ctx.cwd, forgeExtensionState);
        state.forgeExtensionDiagnostics = extensionResult.diagnostics;
        state.forgeExtensionPaths = extensionResult.loadedPaths;
        state.stacks = loadPromptStacks(ctx.cwd);
        deps.reloadProfiles(ctx);
        if (state.forgeExtensionDiagnostics.length > 0) {
            for (const loaded of state.stacks)
                loaded.diagnostics.unshift(...state.forgeExtensionDiagnostics);
        }
        state.active = options.suppressAutoActivate && preferredId === undefined
            ? undefined
            : chooseDefaultStack(state.stacks, preferredId);
        updateStatus(ctx);
        if (!options.deferToolPolicy)
            deps.syncToolPolicy(ctx);
    }
    function updateStatus(ctx) {
        if (state.active) {
            ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", `stack:${state.active.stack.id}`));
        }
        else {
            ctx.ui.setStatus("pi-forge", undefined);
            state.latestCompileDiagnostics = [];
            ctx.ui.setStatus("pi-forge-diagnostics", undefined);
        }
    }
    function notifyActivePreset(ctx, detail) {
        if (!state.active)
            return;
        const errorCount = state.active.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
        const warningCount = state.active.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
        const suffix = errorCount || warningCount ? ` (${errorCount} errors, ${warningCount} warnings)` : "";
        ctx.ui.notify(`pi-forge: active preset ${state.active.stack.id}${suffix} (${detail})`, errorCount ? "error" : "info");
    }
    function recordCompileDiagnostics(ctx, diagnostics) {
        state.latestCompileDiagnostics = diagnostics;
        const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
        const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
        if (errors || warnings) {
            ctx.ui.setStatus("pi-forge-diagnostics", ctx.ui.theme.fg(errors ? "error" : "warning", `forge:${errors}e/${warnings}w`));
            return;
        }
        ctx.ui.setStatus("pi-forge-diagnostics", undefined);
    }
    return { activeId, selectedActiveId, persistActiveSelection, setActive, reloadStacks, updateStatus, notifyActivePreset, recordCompileDiagnostics };
}
//# sourceMappingURL=prompt-stack-runtime.js.map