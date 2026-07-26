import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.ts";
import { buildPreview } from "./preview.ts";
import { registerPresetCommand } from "./preset-command.ts";
import { registerProfileCommand } from "./profile-command.ts";
import { registerForgeSubagentProfilesTool } from "./subagent-profile-tool.ts";
import { registerForgeSubagentCommand } from "./subagent-command.ts";
import { registerForgeSubagentTool } from "./subagent-tool.ts";
import { createProfileRuntime, type ProfileRuntime } from "./runtime/profile-runtime.ts";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.ts";
import { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.ts";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.ts";
import { createRuntimeState } from "./runtime-state.ts";

export {
	getRegisteredMacros,
	registerMacro,
	type PromptMacroDefinition,
	type PromptMacroRenderContext,
	type PromptMacroRenderer,
} from "./macro-engine.ts";
export {
	getRegisteredSlots,
	registerSlot,
	type PromptSlotDefinition,
	type PromptSlotRenderContext,
	type PromptSlotRenderer,
} from "./slot-renderers.ts";
export {
	type PromptExtensionArgumentDefinition,
	type PromptExtensionOptionDefinition,
	type PromptExtensionOptionsSchema,
	type PromptExtensionOptionType,
	type PromptRegistryEntry,
} from "./extension-registry.ts";
export {
	type ForgeExtensionApi,
	type ForgeExtensionRegister,
} from "./forge-extensions.ts";
export {
	AGENT_PROFILE_THINKING_LEVELS,
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilePath,
	agentProfilesDir,
	chooseAutoActivateAgentProfile,
	hasAutoActivateAgentProfile,
	hasAgentProfileErrors,
	isResolvedAgentProfileUsable,
	isUsableAgentProfile,
	isValidAgentProfileId,
	loadAgentProfileFile,
	loadAgentProfiles,
	renderAgentProfileDiagnostics,
	resolveAgentProfile,
	validateAgentProfile,
	type AgentProfile,
	type AgentProfileDiagnostic,
	type AgentProfileDiagnosticLevel,
	type AgentProfileModelReference,
	type AgentProfileResolutionResources,
	type AgentProfileProvenance,
	type AgentProfileRuntimeSnapshot,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
	isAgentProfileProvenance,
} from "./agent-profile.ts";
export {
	applyResolvedAgentProfile,
	captureAgentProfile,
	createAgentProfilePreview,
	deleteAgentProfile,
	forgetAgentProfileProvenance,
	getAgentProfileRuntimeStatus,
	writeAgentProfile,
	type AgentProfileApplicationDeps,
	type AgentProfileApplicationResult,
	type AgentProfileApplicationState,
	type AgentProfileCaptureInput,
	type AgentProfileCaptureResult,
	type AgentProfileCurrentRuntime,
	type AgentProfileDeleteResult,
	type AgentProfileDriftField,
	type AgentProfilePreview,
	type AgentProfileRuntimeStatus,
	type AgentProfileWriteResult,
} from "./profile-service.ts";
export {
	createVariableAccess,
	promptRenderHelpers,
	type PromptRenderHelpers,
	type PromptVariableAccess,
	type PromptVariableScope,
	type PromptWritableVariableScope,
} from "./render-helpers.ts";
export * from "./subagent-contract.ts";
export {
	appendProtectedAgentTask,
	collectMacroCommandNames,
	collectSubagentPromptDependencies,
	compileProtectedAgentTaskMessages,
	currentSubagentPromptRegistrationCatalog,
	isProtectedAgentTaskPreserved,
	prepareSubagentHostPlan,
	resolveSubagentHostProfile,
	type SubagentHostResolution,
	type SubagentPromptRegistration,
	type SubagentPromptRegistrationCatalog,
} from "./subagent-host.ts";

export default function piForge(pi: ExtensionAPI) {
	const state = createRuntimeState();
	const toolPolicy = createToolPolicyRuntime(pi, state);
	let profileRuntime: ProfileRuntime;
	const stackRuntime = createPromptStackRuntime(pi, state, {
		syncToolPolicy: toolPolicy.sync,
		reloadProfiles: (ctx) => profileRuntime.reloadProfiles(ctx),
	});
	profileRuntime = createProfileRuntime(pi, state, {
		setActive: stackRuntime.setActive,
		updateStatus: stackRuntime.updateStatus,
	});
	const subagentRuntime = createForgeSubagentRuntime(state);
	const webEditorRuntime = createWebEditorRuntime((ctx: ExtensionContext, promptOptions: BuildSystemPromptOptions) => ({
		getStacks: () => state.stacks,
		getActive: () => state.active,
		getActiveId: stackRuntime.activeId,
		getSelectedActiveId: stackRuntime.selectedActiveId,
		setActive: (id) => stackRuntime.setActive(id, ctx),
		reloadStacks: (preferredId) => stackRuntime.reloadStacks(ctx, preferredId),
		buildPreview: (target) => buildPreview(ctx, target, state.sessionVariables, toolPolicy.previewOptions(promptOptions, target.stack)),
		getPolicyResources: () => toolPolicy.policyResources(promptOptions),
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
		disposePromptStackRuntime: stackRuntime.dispose,
		disposeSubagentRuntime: subagentRuntime.dispose,
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
	registerForgeSubagentCommand(pi, subagentRuntime, () => state.profiles.map((profile) => profile.profile.id));
	registerForgeSubagentProfilesTool(pi, () => state.profiles, profileRuntime.resolveProfile);
	registerForgeSubagentTool(pi, subagentRuntime, () => state.profiles.map((profile) => profile.profile.id));
}
