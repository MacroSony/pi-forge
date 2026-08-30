import { chooseAutoActivateAgentProfile, hasAutoActivateAgentProfile, isResolvedAgentProfileUsable, renderAgentProfileDiagnostics, resolveAgentProfile, } from "../agent-profile.js";
import { chooseDefaultStack } from "../loader.js";
import { applyResolvedAgentProfile } from "../profile-service.js";
import { formatResourceKey } from "../resource-identity.js";
export function createProfileRuntime(pi, workspace, deps) {
    function reloadProfiles(ctx) {
        workspace.reloadProfiles(ctx.cwd, ctx.isProjectTrusted());
    }
    function resolveProfile(target, ctx) {
        return resolveAgentProfile(target, {
            models: ctx.modelRegistry.getAll(),
            availableModels: ctx.modelRegistry.getAvailable(),
            promptStacks: [...workspace.snapshot().stacks],
            toolNames: pi.getAllTools().map((tool) => tool.name),
        });
    }
    async function activateFreshSessionDefaults(ctx) {
        // D3: auto-activation is an application action. Untrusted projects may
        // browse global definitions, but they must not apply global profiles or
        // activate global presets during a fresh session.
        if (!ctx.isProjectTrusted())
            return;
        const snapshot = workspace.snapshot();
        const target = chooseAutoActivateAgentProfile(snapshot.profiles);
        if (!target) {
            if (hasAutoActivateAgentProfile(snapshot.profiles)) {
                workspace.setActiveStack(undefined);
                deps.updateStatus(ctx);
                ctx.ui.notify("pi-forge: multiple agent profiles request auto-activation; no profile or fallback preset was applied.", "error");
                return;
            }
            const fallback = chooseDefaultStack([...snapshot.stacks]);
            workspace.setActiveStack(fallback ? formatResourceKey(fallback.key) : undefined);
            deps.updateStatus(ctx);
            return;
        }
        const resolved = resolveProfile(target, ctx);
        if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
            workspace.setActiveStack(undefined);
            deps.updateStatus(ctx);
            ctx.ui.notify(`pi-forge: auto-activation profile ${target.profile.id} failed preflight; no profile or fallback preset was applied. ${renderAgentProfileDiagnostics(resolved.diagnostics)}`, "error");
            return;
        }
        const result = await applyResolvedAgentProfile(pi, workspace, { setActive: deps.setActive }, resolved, ctx);
        if (!result.ok) {
            const rollbackSuffix = result.rollbackErrors.length > 0 ? ` Rollback problems: ${result.rollbackErrors.join("; ")}.` : "";
            const detail = result.detail.endsWith(".") ? result.detail : `${result.detail}.`;
            ctx.ui.notify(`pi-forge: failed to auto-activate profile ${target.profile.id}: ${detail}${rollbackSuffix}`, "error");
            return;
        }
        ctx.ui.notify(`pi-forge: auto-activated profile ${target.profile.id} once for this fresh session${result.warningCount ? ` with ${result.warningCount} warning(s)` : ""}; later manual changes will be preserved.`, result.warningCount ? "warning" : "info");
    }
    return { reloadProfiles, resolveProfile, activateFreshSessionDefaults };
}
//# sourceMappingURL=profile-runtime.js.map