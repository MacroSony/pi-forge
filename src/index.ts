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

/**
 * Intentional public surface (0.5.0): the default Pi extension factory plus
 * the trusted-extension API (`registerMacro`/`registerSlot` and their contract
 * types). Everything else is internal; the only other entry point is
 * `@zihanw/pi-forge/subagent`, the versioned host port.
 */
export {
	registerMacro,
	type PromptMacroDefinition,
	type PromptMacroRenderContext,
	type PromptMacroRenderer,
} from "./macro-engine.ts";
export {
	registerSlot,
	type PromptSlotDefinition,
	type PromptSlotRenderContext,
	type PromptSlotRenderer,
} from "./slot-renderers.ts";
export type {
	PromptExtensionArgumentDefinition,
	PromptExtensionOptionDefinition,
	PromptExtensionOptionsSchema,
	PromptExtensionOptionType,
	PromptRegistryEntry,
} from "./extension-registry.ts";
export type {
	PromptEnvironment,
	PromptEnvironmentValue,
} from "./forge-v1/index.ts";
export type {
	PromptRenderHelpers,
} from "./render-helpers.ts";
export type {
	ForgeExtensionApi,
	ForgeExtensionRegister,
} from "./forge-extensions.ts";

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
	}), () => pi.events);

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
