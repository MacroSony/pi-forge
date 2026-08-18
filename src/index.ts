import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.ts";
import { buildPreview } from "./preview.ts";
import { registerPresetCommand } from "./preset-command.ts";
import { registerProfileCommand } from "./profile-command.ts";
import { applyResolvedAgentProfile } from "./profile-service.ts";
import { registerForgeSubagentProfilesTool } from "./subagent-profile-tool.ts";
import { registerForgeSubagentCommand } from "./subagent-command.ts";
import { registerForgeSubagentTool, renderEmbeddedSubagentSummary } from "./subagent-tool.ts";
import { loadForgeSubagentSettings } from "./forge-config.ts";
import { resolveResourceSelector } from "./catalog.ts";
import { formatResourceKey, parseResourceSelector, type ResourceKey } from "./resource-identity.ts";
import { createProfileRuntime, type ProfileRuntime } from "./runtime/profile-runtime.ts";
import { createPromptStackRuntime } from "./runtime/prompt-stack-runtime.ts";
import { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import { ForgeWorkspace } from "./workspace.ts";
import { createToolPolicyRuntime } from "./runtime/tool-policy-runtime.ts";
import { createWebEditorRuntime } from "./runtime/web-editor-runtime.ts";
import { createRuntimeState } from "./runtime-state.ts";

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
	const forgeWorkspace = new ForgeWorkspace({
		activeStackId: () => stackRuntime.activeId() ?? null,
		lastAppliedProfile: () => state.lastAppliedProfile,
	});
	forgeWorkspace.startHostPort(pi.events);
	const webEditorRuntime = createWebEditorRuntime((ctx: ExtensionContext, promptOptions: BuildSystemPromptOptions) => ({
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
			} catch {
				return subagentRuntime.backendIds().map((id) => ({ id, version: "unavailable" }));
			}
		},
		resolveProfile: (target) => profileRuntime.resolveProfile(target, ctx),
		previewToolNames: (stack) => toolPolicy.previewToolNames(stack),
		reloadProfiles: () => profileRuntime.reloadProfiles(ctx),
		isIdle: () => typeof ctx.isIdle === "function" && ctx.isIdle(),
		applyProfile: (resolved) => applyResolvedAgentProfile(
			pi,
			state,
			{ setActive: (id) => stackRuntime.setActive(id, ctx) },
			resolved,
			ctx,
		),
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
	const resolveProfileKey = (selector: string): ResourceKey | undefined => {
		const parsed = parseResourceSelector(selector);
		if (!parsed.ok) return undefined;
		const loaded = resolveResourceSelector(state.profiles, parsed.selector);
		return loaded?.key;
	};

	const refreshSubagentToolDescriptions = registerForgeSubagentTool(
		pi,
		subagentRuntime,
		profileSelectors,
		resolveProfileKey,
		{
			summarize: (ctx) => renderEmbeddedSubagentSummary(
				loadForgeSubagentSettings(ctx),
				state.profiles,
				(loaded) => profileRuntime.resolveProfile(loaded, ctx),
			),
		},
	);

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
		reloadForgeWorkspace: (ctx) => forgeWorkspace.reload(ctx.cwd),
		disposeForgeWorkspace: () => forgeWorkspace.dispose(),
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
