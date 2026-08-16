import { resolveResourceSelector } from "../catalog.js";
import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "../forge-extensions.js";
import { chooseDefaultStack, isDisabledPromptStackId, loadGlobalPromptStacks, loadPromptStacksScoped, } from "../loader.js";
import { selectedActiveId as selectedActiveIdForState } from "../preset-command.js";
import { formatResourceKey, parseResourceSelector } from "../resource-identity.js";
import { STATE_ENTRY_TYPE } from "../runtime-state.js";
export function createPromptStackRuntime(pi, state, deps) {
    const forgeExtensionState = createForgeExtensionState();
    function dispose() {
        const diagnostics = unloadForgeExtensions(forgeExtensionState);
        state.forgeExtensionDiagnostics = diagnostics;
        state.forgeExtensionPaths = [];
        return diagnostics;
    }
    function activeId() {
        return state.active?.stack.id;
    }
    function selectedActiveId() {
        return selectedActiveIdForState(state);
    }
    function persistActiveSelection() {
        const canonical = state.active ? formatResourceKey(state.active.key) : "none";
        if (canonical === state.lastPersistedActiveId)
            return;
        pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: canonical });
        state.lastPersistedActiveId = canonical;
    }
    function setActive(id, ctx) {
        if (!id || isDisabledPromptStackId(id)) {
            state.active = undefined;
            if (id)
                persistActiveSelection();
            if (ctx)
                updateStatus(ctx);
            deps.syncToolPolicy(ctx);
            return true;
        }
        if (ctx && !ctx.isProjectTrusted())
            return false;
        const parsed = parseResourceSelector(id);
        if (!parsed.ok)
            return false;
        const found = resolveResourceSelector(state.stacks, parsed.selector);
        if (!found)
            return false;
        state.active = found;
        persistActiveSelection();
        if (ctx)
            updateStatus(ctx);
        deps.syncToolPolicy(ctx);
        return true;
    }
    async function reloadStacks(ctx, preferredId, options = {}) {
        if (!ctx.isProjectTrusted()) {
            state.forgeExtensionDiagnostics = unloadForgeExtensions(forgeExtensionState);
            state.forgeExtensionPaths = [];
            // Global stacks are user-owned and remain browsable/previewable, but
            // activation is refused until the project is trusted.
            state.stacks = loadGlobalPromptStacks();
            deps.reloadProfiles(ctx);
            state.active = undefined;
            if (!options.deferToolPolicy)
                deps.syncToolPolicy(ctx);
            ctx.ui.notify("pi-forge: project is not trusted; project prompt stacks are disabled (global stacks remain browsable).", "warning");
            updateStatus(ctx);
            return;
        }
        const extensionResult = await reloadForgeExtensions(ctx.cwd, forgeExtensionState);
        state.forgeExtensionDiagnostics = extensionResult.diagnostics;
        state.forgeExtensionPaths = extensionResult.loadedPaths;
        state.stacks = loadPromptStacksScoped(ctx.cwd);
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
    return { dispose, activeId, selectedActiveId, persistActiveSelection, setActive, reloadStacks, updateStatus, notifyActivePreset, recordCompileDiagnostics };
}
//# sourceMappingURL=prompt-stack-runtime.js.map