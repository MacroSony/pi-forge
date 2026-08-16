import { chooseAutoActivateAgentProfile, hasAutoActivateAgentProfile, isResolvedAgentProfileUsable, loadAgentProfilesScoped, loadGlobalAgentProfiles, renderAgentProfileDiagnostics, resolveAgentProfile, } from "../agent-profile.js";
import { chooseDefaultStack } from "../loader.js";
import { applyResolvedAgentProfile } from "../profile-service.js";
export function createProfileRuntime(pi, state, deps) {
    function reloadProfiles(ctx) {
        state.profiles = ctx.isProjectTrusted() ? loadAgentProfilesScoped(ctx.cwd) : loadGlobalAgentProfiles();
    }
    function resolveProfile(target, ctx) {
        return resolveAgentProfile(target, {
            models: ctx.modelRegistry.getAll(),
            availableModels: ctx.modelRegistry.getAvailable(),
            promptStacks: state.stacks,
            toolNames: pi.getAllTools().map((tool) => tool.name),
        });
    }
    async function activateFreshSessionDefaults(ctx) {
        // D3: auto-activation is an application action. Untrusted projects may
        // browse global definitions, but they must not apply global profiles or
        // activate global prompt stacks during a fresh session.
        if (!ctx.isProjectTrusted())
            return;
        const target = chooseAutoActivateAgentProfile(state.profiles);
        if (!target) {
            if (hasAutoActivateAgentProfile(state.profiles)) {
                state.active = undefined;
                deps.updateStatus(ctx);
                ctx.ui.notify("pi-forge: multiple agent profiles request auto-activation; no profile or fallback prompt stack was applied.", "error");
                return;
            }
            state.active = chooseDefaultStack(state.stacks);
            deps.updateStatus(ctx);
            return;
        }
        const resolved = resolveProfile(target, ctx);
        if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
            state.active = undefined;
            deps.updateStatus(ctx);
            ctx.ui.notify(`pi-forge: auto-activation profile ${target.profile.id} failed preflight; no profile or fallback prompt stack was applied. ${renderAgentProfileDiagnostics(resolved.diagnostics)}`, "error");
            return;
        }
        const result = await applyResolvedAgentProfile(pi, state, { setActive: deps.setActive }, resolved, ctx);
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