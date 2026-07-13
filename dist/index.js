import { registerLifecycleHandlers } from "./lifecycle.js";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.js";
import { buildPreview } from "./preview.js";
import { registerPresetCommand } from "./preset-command.js";
import { registerProfileCommand } from "./profile-command.js";
import { createProfileRuntime } from "./runtime/profile-runtime.js";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.js";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.js";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.js";
import { createRuntimeState } from "./runtime-state.js";
export { getRegisteredMacros, registerMacro, } from "./macro-engine.js";
export { getRegisteredSlots, registerSlot, } from "./slot-renderers.js";
export { AGENT_PROFILE_THINKING_LEVELS, AGENT_PROFILE_TYPE, agentProfileFingerprint, agentProfilePath, agentProfilesDir, chooseAutoActivateAgentProfile, hasAutoActivateAgentProfile, hasAgentProfileErrors, isResolvedAgentProfileUsable, isUsableAgentProfile, isValidAgentProfileId, loadAgentProfileFile, loadAgentProfiles, renderAgentProfileDiagnostics, resolveAgentProfile, validateAgentProfile, isAgentProfileProvenance, } from "./agent-profile.js";
export { applyResolvedAgentProfile, captureAgentProfile, createAgentProfilePreview, deleteAgentProfile, forgetAgentProfileProvenance, getAgentProfileRuntimeStatus, writeAgentProfile, } from "./profile-service.js";
export { createVariableAccess, promptRenderHelpers, } from "./render-helpers.js";
export * from "./subagent-contract.js";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, resolveSubagentHostProfile, } from "./subagent-host.js";
export { SubagentBackendRegistry, SubagentBackendRegistryError, } from "./subagent/backend-registry.js";
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
    const webEditorRuntime = createWebEditorRuntime((ctx) => ({
        getStacks: () => state.stacks,
        getActive: () => state.active,
        getActiveId: stackRuntime.activeId,
        getSelectedActiveId: stackRuntime.selectedActiveId,
        setActive: (id) => stackRuntime.setActive(id, ctx),
        reloadStacks: (preferredId) => stackRuntime.reloadStacks(ctx, preferredId),
        buildPreview: (target) => buildPreview(ctx, target, state.sessionVariables, toolPolicy.previewOptions(ctx, target.stack)),
        getPolicyResources: () => toolPolicy.policyResources(ctx),
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
    registerLifecycleHandlers(pi, state, {
        reloadStacks: stackRuntime.reloadStacks,
        activateFreshSessionDefaults: profileRuntime.activateFreshSessionDefaults,
        refreshWebEditorHost: webEditorRuntime.refreshHost,
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
}
//# sourceMappingURL=index.js.map