import { isDisabledPromptStackId } from "../loader.js";
import { formatResourceKey } from "../resource-identity.js";
import { persistActiveSelection as persistActiveSelectionEntry } from "../session-adapter.js";
export function createPromptStackRuntime(pi, workspace, compileCycle, deps) {
    let lastPersistedActiveId;
    function dispose() {
        return workspace.disposeExtensions();
    }
    function activeId() {
        return workspace.snapshot().active?.stack.id;
    }
    function selectedActiveId() {
        const snapshot = workspace.snapshot();
        if (snapshot.active)
            return formatResourceKey(snapshot.active.key);
        return isDisabledPromptStackId(lastPersistedActiveId) ? "none" : undefined;
    }
    function restorePersistedActiveId(id) {
        lastPersistedActiveId = id;
    }
    function persistActiveSelection() {
        const snapshot = workspace.snapshot();
        const canonical = snapshot.active ? formatResourceKey(snapshot.active.key) : "none";
        if (canonical === lastPersistedActiveId)
            return;
        persistActiveSelectionEntry(pi, canonical);
        lastPersistedActiveId = canonical;
    }
    function setActive(id, ctx) {
        if (!id || isDisabledPromptStackId(id)) {
            workspace.setActiveStack(id);
            persistActiveSelection();
            if (ctx)
                updateStatus(ctx);
            deps.syncToolPolicy(ctx);
            return true;
        }
        if (ctx && !ctx.isProjectTrusted())
            return false;
        if (!workspace.setActiveStack(id))
            return false;
        persistActiveSelection();
        if (ctx)
            updateStatus(ctx);
        deps.syncToolPolicy(ctx);
        return true;
    }
    async function reloadStacks(ctx, preferredId, options = {}) {
        if (!ctx.isProjectTrusted()) {
            workspace.disposeExtensions();
            workspace.reload(ctx.cwd, { trusted: false, activeStackId: undefined, suppressAutoActivate: true });
            deps.syncToolPolicy(ctx);
            ctx.ui.notify("pi-forge: project is not trusted; project prompt stacks are disabled (global stacks remain browsable).", "warning");
            updateStatus(ctx);
            return;
        }
        await workspace.loadExtensions(ctx.cwd);
        workspace.reload(ctx.cwd, {
            trusted: true,
            activeStackId: preferredId,
            suppressAutoActivate: options.suppressAutoActivate && preferredId === undefined,
        });
        updateStatus(ctx);
        if (!options.deferToolPolicy)
            deps.syncToolPolicy(ctx);
    }
    function updateStatus(ctx) {
        const active = workspace.snapshot().active;
        if (active) {
            ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", `stack:${active.stack.id}`));
        }
        else {
            ctx.ui.setStatus("pi-forge", undefined);
            compileCycle.latestCompileDiagnostics = [];
            ctx.ui.setStatus("pi-forge-diagnostics", undefined);
        }
    }
    function notifyActivePreset(ctx, detail) {
        const active = workspace.snapshot().active;
        if (!active)
            return;
        const errorCount = active.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
        const warningCount = active.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
        const suffix = errorCount || warningCount ? ` (${errorCount} errors, ${warningCount} warnings)` : "";
        ctx.ui.notify(`pi-forge: active preset ${active.stack.id}${suffix} (${detail})`, errorCount ? "error" : "info");
    }
    function recordCompileDiagnostics(ctx, diagnostics) {
        compileCycle.latestCompileDiagnostics = diagnostics;
        const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
        const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
        if (errors || warnings) {
            ctx.ui.setStatus("pi-forge-diagnostics", ctx.ui.theme.fg(errors ? "error" : "warning", `forge:${errors}e/${warnings}w`));
            return;
        }
        ctx.ui.setStatus("pi-forge-diagnostics", undefined);
    }
    return { dispose, activeId, selectedActiveId, restorePersistedActiveId, persistActiveSelection, setActive, reloadStacks, updateStatus, notifyActivePreset, recordCompileDiagnostics };
}
//# sourceMappingURL=prompt-stack-runtime.js.map