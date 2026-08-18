import { registerLifecycleHandlers } from "./lifecycle.js";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.js";
import { buildPreview } from "./preview.js";
import { registerPresetCommand } from "./preset-command.js";
import { registerProfileCommand } from "./profile-command.js";
import { applyResolvedAgentProfile } from "./profile-service.js";
import { registerForgeSubagentProfilesTool } from "./subagent-profile-tool.js";
import { registerForgeSubagentCommand } from "./subagent-command.js";
import { registerForgeSubagentTool, renderEmbeddedSubagentSummary } from "./subagent-tool.js";
import { loadForgeSubagentSettings } from "./forge-config.js";
import { resolveResourceSelector } from "./catalog.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { createProfileRuntime } from "./runtime/profile-runtime.js";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.js";
import { createForgeSubagentRuntime } from "./runtime/subagent-runtime.js";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.js";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.js";
import { createRuntimeState } from "./runtime-state.js";
export { formatResourceKey, formatResourceSelector, isResourceScope, isValidResourceId, parseResourceSelector, resourceKey, RESOURCE_ID_PATTERN, } from "./resource-identity.js";
export { computeEffectiveView, createResourceCatalog, resolveEffectiveResource, resolveExactResource, resolveResourceSelector, } from "./catalog.js";
export { getRegisteredMacros, registerMacro, } from "./macro-engine.js";
export { FORGE_V1_FILTERS, FORGE_V1_MAX_EXTENSION_OUTPUT, FORGE_V1_MAX_TEMPLATE_OUTPUT, forgeV1, } from "./forge-v1/index.js";
export { getRegisteredSlots, registerSlot, } from "./slot-renderers.js";
export { chooseAutoActivateStack, chooseDefaultStack, isDisabledPromptStackId, isUsablePromptStack, isValidPromptStackId, loadPromptStacks, loadPromptStacksScoped, validatePromptStack, } from "./loader.js";
export { AGENT_PROFILE_THINKING_LEVELS, AGENT_PROFILE_TYPE, agentProfileFingerprint, agentProfilePath, agentProfilesDir, chooseAutoActivateAgentProfile, hasAutoActivateAgentProfile, hasAgentProfileErrors, isResolvedAgentProfileUsable, isUsableAgentProfile, isValidAgentProfileId, loadAgentProfileFile, loadAgentProfiles, loadAgentProfilesScoped, renderAgentProfileDiagnostics, resolveAgentProfile, validateAgentProfile, validateAgentProfilePromptStackScope, isAgentProfileProvenance, } from "./agent-profile.js";
export { applyResolvedAgentProfile, captureAgentProfile, createAgentProfilePreview, deleteAgentProfile, forgetAgentProfileProvenance, getAgentProfileRuntimeStatus, writeAgentProfile, } from "./profile-service.js";
export { createVariableAccess, promptRenderHelpers, } from "./render-helpers.js";
export * from "./subagent/contract.js";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, prepareSubagentHostPlan, resolveSubagentHostProfile, } from "./subagent-host.js";
export default function piForge(pi) {
    const state = createRuntimeState();
    const toolPolicy = createToolPolicyRuntime(pi, state);
    let profileRuntime;
    const stackRuntime = createPromptStackRuntime(pi, state, {
        syncToolPolicy: toolPolicy.sync,
        reloadProfiles: (ctx) => profileRuntime.reloadProfiles(ctx),
    });
    profileRuntime = createProfileRuntime(pi, state, {
        setActive: stackRuntime.setActive,
        updateStatus: stackRuntime.updateStatus,
    });
    const subagentRuntime = createForgeSubagentRuntime(state);
    const webEditorRuntime = createWebEditorRuntime((ctx, promptOptions) => ({
        getStacks: () => state.stacks,
        getActive: () => state.active,
        getActiveId: stackRuntime.activeId,
        getSelectedActiveId: stackRuntime.selectedActiveId,
        setActive: (id) => stackRuntime.setActive(id, ctx),
        reloadStacks: (preferredId) => stackRuntime.reloadStacks(ctx, preferredId),
        buildPreview: (target) => buildPreview(ctx, target, toolPolicy.previewOptions(promptOptions, target.stack)),
        getPolicyResources: () => toolPolicy.policyResources(promptOptions),
        getProfiles: () => state.profiles,
        getLastAppliedProfile: () => state.lastAppliedProfile,
        getCurrentProfileRuntime: () => ({
            model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
            thinkingLevel: pi.getThinkingLevel(),
            promptStack: state.active ? formatResourceKey(state.active.key) : null,
            effectiveTools: pi.getActiveTools(),
        }),
        getSubagentBackends: () => {
            // Backend construction can require live Pi runtime resources; listing
            // options for the editor must not break profile browsing when they
            // are unavailable (the same failure would surface again at prepare).
            try {
                return subagentRuntime.descriptors(ctx).map((descriptor) => ({
                    id: descriptor.id,
                    version: descriptor.version,
                }));
            }
            catch {
                return subagentRuntime.backendIds().map((id) => ({ id, version: "unavailable" }));
            }
        },
        resolveProfile: (target) => profileRuntime.resolveProfile(target, ctx),
        previewToolNames: (stack) => toolPolicy.previewToolNames(stack),
        reloadProfiles: () => profileRuntime.reloadProfiles(ctx),
        isIdle: () => typeof ctx.isIdle === "function" && ctx.isIdle(),
        applyProfile: (resolved) => applyResolvedAgentProfile(pi, state, { setActive: (id) => stackRuntime.setActive(id, ctx) }, resolved, ctx),
        getPayload: () => ({ ok: true, ...webPayloadSnapshot(state) }),
        armPayload: (savePath) => {
            armPayloadIntercept(state, ctx, savePath, "web");
            return { ok: true, ...webPayloadSnapshot(state) };
        },
        clearPayload: () => {
            clearPayloadCapture(state, ctx);
            return { ok: true, ...webPayloadSnapshot(state) };
        },
    }));
    // The forge_subagent description can embed a compact summary of enabled
    // profiles when subagents.summaryInToolDescription is enabled.
    // Registration returns a refresh function the lifecycle wiring calls with
    // a context whenever profiles, stacks, or configuration may have changed;
    // the tool re-registers only when the rendered summary actually changed.
    const profileSelectors = () => state.profiles.map((profile) => formatResourceKey(profile.key));
    const resolveProfileKey = (selector) => {
        const parsed = parseResourceSelector(selector);
        if (!parsed.ok)
            return undefined;
        const loaded = resolveResourceSelector(state.profiles, parsed.selector);
        return loaded?.key;
    };
    const refreshSubagentToolDescriptions = registerForgeSubagentTool(pi, subagentRuntime, profileSelectors, resolveProfileKey, {
        summarize: (ctx) => renderEmbeddedSubagentSummary(loadForgeSubagentSettings(ctx), state.profiles, (loaded) => profileRuntime.resolveProfile(loaded, ctx)),
    });
    registerLifecycleHandlers(pi, state, {
        reloadStacks: stackRuntime.reloadStacks,
        disposePromptStackRuntime: stackRuntime.dispose,
        disposeSubagentRuntime: subagentRuntime.dispose,
        activateFreshSessionDefaults: profileRuntime.activateFreshSessionDefaults,
        refreshWebEditorHost: webEditorRuntime.refreshHost,
        refreshSubagentToolDescriptions,
        notifyActivePreset: stackRuntime.notifyActivePreset,
        syncActiveToolPolicy: toolPolicy.sync,
        restoreActiveToolPolicy: toolPolicy.restore,
        toolPolicyBlockReason: toolPolicy.blockReason,
        activeId: stackRuntime.activeId,
        persistActiveSelection: stackRuntime.persistActiveSelection,
        recordCompileDiagnostics: stackRuntime.recordCompileDiagnostics,
    });
    registerPayloadRequestHandler(pi, state, () => state.active);
    registerPayloadCommands(pi, state);
    registerPresetCommand(pi, state, {
        selectedActiveId: stackRuntime.selectedActiveId,
        setActive: stackRuntime.setActive,
        reloadStacks: stackRuntime.reloadStacks,
        openWebEditor: webEditorRuntime.open,
        stopWebEditor: webEditorRuntime.stop,
    });
    registerProfileCommand(pi, state, {
        reloadProfiles: profileRuntime.reloadProfiles,
        resolveProfile: profileRuntime.resolveProfile,
        setActive: stackRuntime.setActive,
        previewToolNames: toolPolicy.previewToolNames,
    });
    registerForgeSubagentCommand(pi, subagentRuntime, profileSelectors, resolveProfileKey);
    registerForgeSubagentProfilesTool(pi, () => state.profiles, profileRuntime.resolveProfile);
}
//# sourceMappingURL=index.js.map