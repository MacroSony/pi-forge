import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.ts";
import { buildPreview } from "./preview.ts";
import { registerPresetCommand } from "./preset-command.ts";
import { registerProfileCommand } from "./profile-command.ts";
import { applyResolvedAgentProfile } from "./profile-service.ts";
import { formatResourceKey } from "./resource-identity.ts";
import { createProfileRuntime, type ProfileRuntime } from "./runtime/profile-runtime.ts";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.ts";
import { ForgeWorkspace } from "./workspace.ts";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.ts";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.ts";
import { createCompileCycleState } from "./compile-cycle.ts";
import { createPayloadState } from "./payload-state.ts";

export {
	formatResourceKey,
	formatResourceSelector,
	isResourceScope,
	isValidResourceId,
	parseResourceSelector,
	resourceKey,
	RESOURCE_ID_PATTERN,
	type ResourceKey,
	type ResourceScope,
	type ResourceSelector,
	type ResourceSelectorParseResult,
} from "./resource-identity.ts";
export {
	computeEffectiveView,
	createResourceCatalog,
	resolveEffectiveResource,
	resolveExactResource,
	resolveResourceSelector,
	type ResourceCatalog,
	type ScopedResource,
} from "./catalog.ts";
export {
	getRegisteredMacros,
	registerMacro,
	type PromptMacroDefinition,
	type PromptMacroRenderContext,
	type PromptMacroRenderer,
} from "./macro-engine.ts";
export {
	FORGE_V1_FILTERS,
	FORGE_V1_MAX_EXTENSION_OUTPUT,
	FORGE_V1_MAX_TEMPLATE_OUTPUT,
	forgeV1,
} from "./forge-v1/index.ts";
export type {
	ForgeV1Error,
	ForgeV1ErrorKind,
	ForgeV1TemplateEngine,
	PromptEnvironment,
	PromptEnvironmentValue,
	TemplateDependency,
	TemplateDependencyKind,
	TemplateNode,
	TemplateOutputNode,
	TemplateParseResult,
	TemplatePredicate,
	TemplateRenderResult,
	TemplateSourceSpan,
	TemplateTextNode,
} from "./forge-v1/index.ts";
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
	chooseAutoActivateStack,
	chooseDefaultStack,
	isDisabledPromptStackId,
	isUsablePromptStack,
	isValidPromptStackId,
	loadPromptStacks,
	loadPromptStacksScoped,
	validatePromptStack,
} from "./loader.ts";
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
	loadAgentProfilesScoped,
	renderAgentProfileDiagnostics,
	resolveAgentProfile,
	validateAgentProfile,
	validateAgentProfilePromptStackScope,
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
} from "./render-helpers.ts";
export * from "./subagent/contract.ts";
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
	const workspace = new ForgeWorkspace();
	const compileCycle = createCompileCycleState();
	const payloadState = createPayloadState();
	const currentActive = () => workspace.snapshotKnown ? workspace.snapshot().active : undefined;
	const toolPolicy = createToolPolicyRuntime(pi, () => currentActive());
	let profileRuntime: ProfileRuntime;
	const stackRuntime = createPromptStackRuntime(pi, workspace, compileCycle, {
		syncToolPolicy: toolPolicy.sync,
	});
	profileRuntime = createProfileRuntime(pi, workspace, {
		setActive: (id, ctx) => stackRuntime.setActive(id, ctx),
		updateStatus: stackRuntime.updateStatus,
	});
	const webEditorRuntime = createWebEditorRuntime((ctx: ExtensionContext, promptOptions: BuildSystemPromptOptions) => ({
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
		applyProfile: (resolved) => applyResolvedAgentProfile(
			pi,
			workspace,
			{ setActive: (id) => stackRuntime.setActive(id, ctx) },
			resolved,
			ctx,
		),
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
