import { registerLifecycleHandlers } from "./lifecycle.js";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.js";
import { buildPreview } from "./preview.js";
import { registerPresetCommand } from "./preset-command.js";
import { registerProfileCommand } from "./profile-command.js";
import { applyResolvedAgentProfile } from "./profile-service.js";
import { formatResourceKey } from "./resource-identity.js";
import { createProfileRuntime } from "./runtime/profile-runtime.js";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.js";
import { ForgeWorkspace } from "./workspace.js";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.js";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.js";
import { createCompileCycleState } from "./compile-cycle.js";
import { createPayloadState } from "./payload-state.js";
export { formatResourceKey, formatResourceSelector, isResourceScope, isValidResourceId, parseResourceSelector, resourceKey, RESOURCE_ID_PATTERN, } from "./resource-identity.js";
export { computeEffectiveView, createResourceCatalog, resolveEffectiveResource, resolveExactResource, resolveResourceSelector, } from "./catalog.js";
export { getRegisteredMacros, registerMacro, } from "./macro-engine.js";
export { FORGE_V1_FILTERS, FORGE_V1_MAX_EXTENSION_OUTPUT, FORGE_V1_MAX_TEMPLATE_OUTPUT, forgeV1, } from "./forge-v1/index.js";
export { getRegisteredSlots, registerSlot, } from "./slot-renderers.js";
export { chooseAutoActivateStack, chooseDefaultStack, isDisabledPromptStackId, isUsablePromptStack, isValidPromptStackId, loadPromptStacks, loadPromptStacksScoped, validatePromptStack, } from "./loader.js";
export { AGENT_PROFILE_THINKING_LEVELS, AGENT_PROFILE_TYPE, agentProfileFingerprint, agentProfilePath, agentProfilesDir, chooseAutoActivateAgentProfile, hasAutoActivateAgentProfile, hasAgentProfileErrors, isResolvedAgentProfileUsable, isUsableAgentProfile, isValidAgentProfileId, loadAgentProfileFile, loadAgentProfiles, loadAgentProfilesScoped, renderAgentProfileDiagnostics, resolveAgentProfile, validateAgentProfile, validateAgentProfilePromptStackScope, isAgentProfileProvenance, } from "./agent-profile.js";
export { applyResolvedAgentProfile, captureAgentProfile, createAgentProfilePreview, deleteAgentProfile, forgetAgentProfileProvenance, getAgentProfileRuntimeStatus, writeAgentProfile, } from "./profile-service.js";
export { createVariableAccess, promptRenderHelpers, } from "./render-helpers.js";
export default function piForge(pi) {
    const workspace = new ForgeWorkspace();
    const compileCycle = createCompileCycleState();
    const payloadState = createPayloadState();
    const currentActive = () => workspace.snapshotKnown ? workspace.snapshot().active : undefined;
    const toolPolicy = createToolPolicyRuntime(pi, () => currentActive());
    let profileRuntime;
    const stackRuntime = createPromptStackRuntime(pi, workspace, compileCycle, {
        syncToolPolicy: toolPolicy.sync,
    });
    profileRuntime = createProfileRuntime(pi, workspace, {
        setActive: (id, ctx) => stackRuntime.setActive(id, ctx),
        updateStatus: stackRuntime.updateStatus,
    });
    const webEditorRuntime = createWebEditorRuntime((ctx, promptOptions) => ({
        getStacks: () => [...workspace.snapshot().stacks],
        getActive: () => currentActive(),
        getActiveId: stackRuntime.activeId,
        getSelectedActiveId: stackRuntime.selectedActiveId,
        setActive: (id) => stackRuntime.setActive(id, ctx),
        reloadStacks: (preferredId) => stackRuntime.reloadStacks(ctx, preferredId),
        buildPreview: (target) => buildPreview(ctx, target, toolPolicy.previewOptions(promptOptions, target.stack)),
        getPolicyResources: () => toolPolicy.policyResources(promptOptions),
        getProfiles: () => [...workspace.snapshot().profiles],
        getLastAppliedProfile: () => workspace.snapshot().lastAppliedProfile,
        getCurrentProfileRuntime: () => {
            const active = currentActive();
            return {
                model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
                thinkingLevel: pi.getThinkingLevel(),
                promptStack: active ? formatResourceKey(active.key) : null,
                effectiveTools: pi.getActiveTools(),
            };
        },
        resolveProfile: (target) => profileRuntime.resolveProfile(target, ctx),
        previewToolNames: (stack) => toolPolicy.previewToolNames(stack),
        reloadProfiles: () => profileRuntime.reloadProfiles(ctx),
        isIdle: () => typeof ctx.isIdle === "function" && ctx.isIdle(),
        applyProfile: (resolved) => applyResolvedAgentProfile(pi, workspace, { setActive: (id) => stackRuntime.setActive(id, ctx) }, resolved, ctx),
        getPayload: () => ({ ok: true, ...webPayloadSnapshot(payloadState) }),
        armPayload: (savePath) => {
            armPayloadIntercept(payloadState, ctx, savePath, "web");
            return { ok: true, ...webPayloadSnapshot(payloadState) };
        },
        clearPayload: () => {
            clearPayloadCapture(payloadState, ctx);
            return { ok: true, ...webPayloadSnapshot(payloadState) };
        },
    }));
    registerLifecycleHandlers(pi, workspace, compileCycle, {
        reloadStacks: stackRuntime.reloadStacks,
        disposePromptStackRuntime: stackRuntime.dispose,
        activateFreshSessionDefaults: profileRuntime.activateFreshSessionDefaults,
        refreshWebEditorHost: webEditorRuntime.refreshHost,
        notifyActivePreset: stackRuntime.notifyActivePreset,
        syncActiveToolPolicy: toolPolicy.sync,
        restoreActiveToolPolicy: toolPolicy.restore,
        toolPolicyBlockReason: toolPolicy.blockReason,
        persistActiveSelection: stackRuntime.persistActiveSelection,
        recordCompileDiagnostics: stackRuntime.recordCompileDiagnostics,
        restorePersistedActiveId: stackRuntime.restorePersistedActiveId,
        reloadForgeWorkspace: (ctx) => {
            workspace.startHostPort(pi.events);
        },
        disposeForgeWorkspace: () => workspace.dispose(),
    });
    registerPayloadRequestHandler(pi, payloadState, () => currentActive());
    registerPayloadCommands(pi, payloadState);
    registerPresetCommand(pi, workspace, compileCycle, {
        selectedActiveId: stackRuntime.selectedActiveId,
        setActive: stackRuntime.setActive,
        reloadStacks: stackRuntime.reloadStacks,
        openWebEditor: webEditorRuntime.open,
        stopWebEditor: webEditorRuntime.stop,
    });
    registerProfileCommand(pi, workspace, {
        reloadProfiles: profileRuntime.reloadProfiles,
        resolveProfile: profileRuntime.resolveProfile,
        setActive: stackRuntime.setActive,
        previewToolNames: toolPolicy.previewToolNames,
    });
}
//# sourceMappingURL=index.js.map