import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	chooseAutoActivateAgentProfile,
	hasAutoActivateAgentProfile,
	isResolvedAgentProfileUsable,
	loadAgentProfiles,
	renderAgentProfileDiagnostics,
	resolveAgentProfile,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";
import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "./forge-extensions.ts";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks } from "./loader.ts";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.ts";
import { applyResourcePolicy, hasResourcePolicy } from "./policy.ts";
import { buildPreview, showText } from "./preview.ts";
import { registerPresetCommand, selectedActiveId as selectedActiveIdForState } from "./preset-command.ts";
import { applyResolvedAgentProfile, registerProfileCommand } from "./profile-command.ts";
import { createRuntimeState, STATE_ENTRY_TYPE } from "./runtime-state.ts";
import type { PromptStack, PromptStackDiagnostic } from "./types.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "./web-host.ts";
import { startWebEditorServer, type WebEditorPolicyResource, type WebEditorPolicyResources, type WebEditorServer } from "./web-editor/index.ts";

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
	createVariableAccess,
	promptRenderHelpers,
	type PromptRenderHelpers,
	type PromptVariableAccess,
	type PromptVariableScope,
	type PromptWritableVariableScope,
} from "./render-helpers.ts";

const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";

interface SharedWebEditorState {
	server?: WebEditorServer;
	cwd?: string;
	preferredPort?: number;
}

interface SharedWebEditorRegistry {
	byCwd: Record<string, SharedWebEditorState | undefined>;
}

type PiForgeGlobal = typeof globalThis & {
	__piForgeWebEditor?: SharedWebEditorRegistry;
};

function getSharedWebEditorRegistry(): SharedWebEditorRegistry {
	const globalScope = globalThis as PiForgeGlobal;
	globalScope[WEB_EDITOR_GLOBAL_KEY] ??= { byCwd: {} };
	return globalScope[WEB_EDITOR_GLOBAL_KEY];
}

function sameToolSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every((name) => rightSet.has(name));
}

function reconcileToolPolicyBaseline(baseline: string[], lastApplied: string[], current: string[]): string[] {
	const baselineSet = new Set(baseline);
	const lastAppliedSet = new Set(lastApplied);
	const currentSet = new Set(current);

	for (const name of current) {
		if (!lastAppliedSet.has(name)) baselineSet.add(name);
	}
	for (const name of lastApplied) {
		if (!currentSet.has(name)) baselineSet.delete(name);
	}

	return [
		...baseline.filter((name) => baselineSet.has(name)),
		...current.filter((name) => baselineSet.has(name) && !baseline.includes(name)),
	];
}

export default function piForge(pi: ExtensionAPI) {
	const sharedWebEditors = getSharedWebEditorRegistry();
	const state = createRuntimeState();
	let webEditor: WebEditorServer | undefined;
	let webEditorCwd: string | undefined;
	let webEditorPreferredPort: number | undefined;
	let toolPolicyBaseline: string[] | undefined;
	let lastAppliedToolPolicy: string[] | undefined;
	const forgeExtensionState = createForgeExtensionState();

	function activeId(): string | undefined {
		return state.active?.stack.id;
	}

	function selectedActiveId(): string | undefined {
		return selectedActiveIdForState(state);
	}

	function persistActiveSelection(id: string): void {
		if (id === state.lastPersistedActiveId) return;
		pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: id });
		state.lastPersistedActiveId = id;
	}

	function setActive(id: string | undefined, ctx?: ExtensionContext): boolean {
		if (!id || isDisabledPromptStackId(id)) {
			state.active = undefined;
			if (id) persistActiveSelection("none");
			if (ctx) updateStatus(ctx);
			syncActiveToolPolicy(ctx);
			return true;
		}

		const found = state.stacks.find((candidate) => candidate.stack.id === id);
		if (!found) return false;
		state.active = found;
		persistActiveSelection(found.stack.id);
		if (ctx) updateStatus(ctx);
		syncActiveToolPolicy(ctx);
		return true;
	}

	function reloadProfiles(ctx: ExtensionContext): void {
		state.profiles = ctx.isProjectTrusted() ? loadAgentProfiles(ctx.cwd) : [];
	}

	function resolveProfile(target: LoadedAgentProfile, ctx: ExtensionContext): ResolvedAgentProfile {
		return resolveAgentProfile(target, {
			models: ctx.modelRegistry.getAll(),
			availableModels: ctx.modelRegistry.getAvailable(),
			promptStacks: state.stacks,
			toolNames: pi.getAllTools().map((tool) => tool.name),
		});
	}

	async function reloadStacks(
		ctx: ExtensionContext,
		preferredId?: string,
		options: { deferToolPolicy?: boolean; suppressAutoActivate?: boolean } = {},
	): Promise<void> {
		if (!ctx.isProjectTrusted()) {
			const unloadDiagnostics = unloadForgeExtensions(forgeExtensionState);
			state.forgeExtensionDiagnostics = unloadDiagnostics;
			state.forgeExtensionPaths = [];
			state.stacks = [];
			state.profiles = [];
			state.active = undefined;
			if (!options.deferToolPolicy) syncActiveToolPolicy(ctx);
			ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
			updateStatus(ctx);
			return;
		}

		const extensionResult = await reloadForgeExtensions(ctx.cwd, forgeExtensionState);
		state.forgeExtensionDiagnostics = extensionResult.diagnostics;
		state.forgeExtensionPaths = extensionResult.loadedPaths;
		state.stacks = loadPromptStacks(ctx.cwd);
		reloadProfiles(ctx);
		if (state.forgeExtensionDiagnostics.length > 0) {
			for (const loaded of state.stacks) loaded.diagnostics.unshift(...state.forgeExtensionDiagnostics);
		}
		state.active = options.suppressAutoActivate && preferredId === undefined
			? undefined
			: chooseDefaultStack(state.stacks, preferredId);
		updateStatus(ctx);
		if (!options.deferToolPolicy) syncActiveToolPolicy(ctx);
	}

	async function activateFreshSessionDefaults(ctx: ExtensionContext): Promise<void> {
		const target = chooseAutoActivateAgentProfile(state.profiles);
		if (!target) {
			if (hasAutoActivateAgentProfile(state.profiles)) {
				state.active = undefined;
				updateStatus(ctx);
				ctx.ui.notify("pi-forge: multiple agent profiles request auto-activation; no profile or fallback prompt stack was applied.", "error");
				return;
			}
			state.active = chooseDefaultStack(state.stacks);
			updateStatus(ctx);
			return;
		}

		const resolved = resolveProfile(target, ctx);
		if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
			state.active = undefined;
			updateStatus(ctx);
			ctx.ui.notify(
				`pi-forge: auto-activation profile ${target.profile.id} failed preflight; no profile or fallback prompt stack was applied. ${renderAgentProfileDiagnostics(resolved.diagnostics)}`,
				"error",
			);
			return;
		}

		const result = await applyResolvedAgentProfile(pi, state, { setActive }, resolved, ctx);
		if (!result.ok) {
			const rollbackSuffix = result.rollbackErrors.length > 0 ? ` Rollback problems: ${result.rollbackErrors.join("; ")}.` : "";
			const detail = result.detail.endsWith(".") ? result.detail : `${result.detail}.`;
			ctx.ui.notify(`pi-forge: failed to auto-activate profile ${target.profile.id}: ${detail}${rollbackSuffix}`, "error");
			return;
		}

		ctx.ui.notify(
			`pi-forge: auto-activated profile ${target.profile.id} once for this fresh session${result.warningCount ? ` with ${result.warningCount} warning(s)` : ""}; later manual changes will be preserved.`,
			result.warningCount ? "warning" : "info",
		);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.active) {
			ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", "stack:" + state.active.stack.id));
		} else {
			ctx.ui.setStatus("pi-forge", undefined);
			state.latestCompileDiagnostics = [];
			ctx.ui.setStatus("pi-forge-diagnostics", undefined);
		}
	}

	function syncActiveToolPolicy(ctx?: ExtensionContext): void {
		const policy = state.active?.stack.tools;
		if (!hasResourcePolicy(policy)) {
			restoreToolPolicy(ctx);
			return;
		}

		const currentTools = filterKnownTools(pi.getActiveTools());
		if (toolPolicyBaseline && lastAppliedToolPolicy) {
			toolPolicyBaseline = reconcileToolPolicyBaseline(toolPolicyBaseline, lastAppliedToolPolicy, currentTools);
		}
		const baseline = toolPolicyBaseline ?? currentTools;
		toolPolicyBaseline ??= [...baseline];
		const nextTools = applyResourcePolicy(filterKnownTools(baseline), policy);
		if (!sameToolSet(currentTools, nextTools)) pi.setActiveTools(nextTools);
		lastAppliedToolPolicy = [...nextTools];
		if (ctx) {
			const label = nextTools.length > 0 ? `tools:${nextTools.length}` : "tools:none";
			ctx.ui.setStatus("pi-forge-tools", ctx.ui.theme.fg(nextTools.length > 0 ? "accent" : "warning", label));
		}
	}

	function restoreToolPolicy(ctx?: ExtensionContext): void {
		if (toolPolicyBaseline) {
			const currentTools = filterKnownTools(pi.getActiveTools());
			if (lastAppliedToolPolicy) {
				toolPolicyBaseline = reconcileToolPolicyBaseline(toolPolicyBaseline, lastAppliedToolPolicy, currentTools);
			}
			const restoredTools = filterKnownTools(toolPolicyBaseline);
			if (!sameToolSet(currentTools, restoredTools)) pi.setActiveTools(restoredTools);
			toolPolicyBaseline = undefined;
		}
		lastAppliedToolPolicy = undefined;
		if (ctx) ctx.ui.setStatus("pi-forge-tools", undefined);
	}

	function toolPolicyBlockReason(toolName: string): string | undefined {
		const active = state.active;
		if (!active || !hasResourcePolicy(active.stack.tools)) return undefined;
		if (applyResourcePolicy([toolName], active.stack.tools).includes(toolName)) return undefined;
		return `Tool "${toolName}" is blocked by prompt stack "${active.stack.id}".`;
	}

	function filterKnownTools(names: string[]): string[] {
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		if (known.size === 0) return names;
		return names.filter((name) => known.has(name));
	}

	function notifyActivePreset(ctx: ExtensionContext, detail: string): void {
		if (!state.active) return;
		const errorCount = state.active.diagnostics.filter((d) => d.level === "error").length;
		const warningCount = state.active.diagnostics.filter((d) => d.level === "warning").length;
		const suffix = errorCount || warningCount ? " (" + errorCount + " errors, " + warningCount + " warnings)" : "";
		ctx.ui.notify("pi-forge: active preset " + state.active.stack.id + suffix + " (" + detail + ")", errorCount ? "error" : "info");
	}

	function recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void {
		state.latestCompileDiagnostics = diagnostics;
		const errors = diagnostics.filter((d) => d.level === "error").length;
		const warnings = diagnostics.filter((d) => d.level === "warning").length;
		if (errors || warnings) {
			ctx.ui.setStatus("pi-forge-diagnostics", ctx.ui.theme.fg(errors ? "error" : "warning", `forge:${errors}e/${warnings}w`));
			return;
		}
		ctx.ui.setStatus("pi-forge-diagnostics", undefined);
	}

	function webHostRuntime(ctx: ExtensionCommandContext): WebHostRuntime {
		return {
			getStacks: () => state.stacks,
			getActive: () => state.active,
			getActiveId: activeId,
			getSelectedActiveId: selectedActiveId,
			setActive: (id) => setActive(id, ctx),
			reloadStacks: (preferredId) => reloadStacks(ctx, preferredId),
			buildPreview: (target) => buildPreview(ctx, target, state.sessionVariables, previewOptionsForStack(ctx, target.stack)),
			getPolicyResources: () => getPolicyResources(ctx),
			getPayload: () => ({ ok: true, ...webPayloadSnapshot(state) }),
			armPayload: (savePath) => {
				armPayloadIntercept(state, ctx, savePath, "web");
				return { ok: true, ...webPayloadSnapshot(state) };
			},
			clearPayload: () => {
				clearPayloadCapture(state, ctx);
				return { ok: true, ...webPayloadSnapshot(state) };
			},
		};
	}

	function getPolicyResources(ctx: ExtensionCommandContext): WebEditorPolicyResources {
		const options = ctx.getSystemPromptOptions();
		const activeTools = new Set(pi.getActiveTools());
		const snippets = options.toolSnippets ?? {};
		const tools = pi.getAllTools()
			.map((tool) => normalizeToolResource(tool, activeTools, snippets))
			.filter(hasPolicyResourceName)
			.sort(comparePolicyResource);
		const skills = (options.skills ?? [])
			.map(normalizeSkillResource)
			.filter(hasPolicyResourceName)
			.sort(comparePolicyResource);
		return { tools, skills };
	}

	function previewOptionsForStack(ctx: ExtensionCommandContext, stack: PromptStack): BuildSystemPromptOptions {
		const base = ctx.getSystemPromptOptions();
		const baseSelectedTools = Array.isArray(base.selectedTools) ? base.selectedTools : pi.getActiveTools();
		const policyActive = hasResourcePolicy(stack.tools);
		const baselineTools = policyActive ? (toolPolicyBaseline ?? pi.getActiveTools()) : baseSelectedTools;
		const selectedTools = policyActive
			? applyResourcePolicy(filterKnownTools(baselineTools), stack.tools)
			: baseSelectedTools;
		const selectedToolSet = new Set(selectedTools);
		const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
		const toolInfos = pi.getAllTools();
		for (const tool of toolInfos) {
			const name = stringValue((tool as { name?: unknown }).name);
			if (!name || !selectedToolSet.has(name) || toolSnippets[name]) continue;
			const snippet = stringValue((tool as { promptSnippet?: unknown }).promptSnippet);
			if (snippet) toolSnippets[name] = snippet;
		}

		const mappedGuidelines = toolInfos
			.filter((tool) => {
				const name = stringValue((tool as { name?: unknown }).name);
				return !!name && selectedToolSet.has(name);
			})
			.flatMap((tool) => stringArrayValue((tool as { promptGuidelines?: unknown }).promptGuidelines));
		const promptGuidelines = policyActive && !sameStringSet(baseSelectedTools, selectedTools)
			? mappedGuidelines
			: (base.promptGuidelines ?? mappedGuidelines);

		return { ...base, selectedTools, toolSnippets, promptGuidelines };
	}

	function previewToolNames(stack: PromptStack | undefined): string[] {
		const baseline = filterKnownTools(toolPolicyBaseline ?? pi.getActiveTools());
		return stack && hasResourcePolicy(stack.tools) ? applyResourcePolicy(baseline, stack.tools) : baseline;
	}

	function filterToolSnippets(snippets: Record<string, string | undefined>, selectedTools: Set<string>): Record<string, string> {
		const filtered: Record<string, string> = {};
		for (const [name, snippet] of Object.entries(snippets)) {
			if (selectedTools.has(name) && snippet) filtered[name] = snippet;
		}
		return filtered;
	}

	function normalizeToolResource(
		tool: { name?: unknown; description?: unknown; promptSnippet?: unknown; sourceInfo?: unknown },
		activeTools: Set<string>,
		snippets: Record<string, string | undefined>,
	): WebEditorPolicyResource {
		const name = String(tool.name ?? "");
		return {
			name,
			description: stringValue(tool.description) ?? stringValue(tool.promptSnippet) ?? snippets[name],
			source: sourceLabel(tool.sourceInfo),
			active: activeTools.has(name),
		};
	}

	function normalizeSkillResource(skill: { name?: unknown; description?: unknown; filePath?: unknown; disableModelInvocation?: unknown }): WebEditorPolicyResource {
		return {
			name: String(skill.name ?? ""),
			description: stringValue(skill.description),
			source: stringValue(skill.filePath),
			hidden: skill.disableModelInvocation === true,
		};
	}

	function stringValue(value: unknown): string | undefined {
		return typeof value === "string" && value.trim() ? value : undefined;
	}

	function stringArrayValue(value: unknown): string[] {
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
	}

	function sourceLabel(value: unknown): string | undefined {
		if (!value || typeof value !== "object") return undefined;
		const source = stringValue((value as { source?: unknown }).source);
		const path = stringValue((value as { path?: unknown }).path);
		if (source && path) return `${source}: ${path}`;
		return source ?? path;
	}

	function comparePolicyResource(a: WebEditorPolicyResource, b: WebEditorPolicyResource): number {
		return a.name.localeCompare(b.name);
	}

	function hasPolicyResourceName(resource: WebEditorPolicyResource): boolean {
		return !!resource.name.trim();
	}

	function sameStringSet(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		const bSet = new Set(b);
		return a.every((value) => bSet.has(value));
	}

	function sharedWebEditorForCwd(cwd: string): SharedWebEditorState {
		sharedWebEditors.byCwd[cwd] ??= {};
		return sharedWebEditors.byCwd[cwd];
	}

	function syncWebEditorFromShared(cwd: string): void {
		const shared = sharedWebEditorForCwd(cwd);
		webEditor = shared.server;
		webEditorCwd = shared.cwd;
		webEditorPreferredPort = shared.preferredPort;
	}

	function rememberWebEditor(server: WebEditorServer, cwd: string, preferredPort: number | undefined): void {
		const shared = sharedWebEditorForCwd(cwd);
		webEditor = server;
		webEditorCwd = cwd;
		webEditorPreferredPort = preferredPort;
		shared.server = server;
		shared.cwd = cwd;
		shared.preferredPort = preferredPort;
	}

	function clearWebEditor(server: WebEditorServer): void {
		if (webEditor === server) {
			webEditor = undefined;
			webEditorCwd = undefined;
			webEditorPreferredPort = undefined;
		}
		for (const [cwd, shared] of Object.entries(sharedWebEditors.byCwd)) {
			if (shared?.server === server) delete sharedWebEditors.byCwd[cwd];
		}
	}

	function refreshWebEditorHost(ctx: ExtensionContext): void {
		syncWebEditorFromShared(ctx.cwd);
		if (!webEditor) return;
		const commandCtx = ctx as ExtensionCommandContext;
		webEditor.updateHost(createWebEditorHost(commandCtx, webHostRuntime(commandCtx)));
		rememberWebEditor(webEditor, ctx.cwd, webEditorPreferredPort);
		ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
	}

	async function openWebEditor(ctx: ExtensionCommandContext, mode: "open" | "restart" = "open"): Promise<void> {
		syncWebEditorFromShared(ctx.cwd);
		const settings = loadWebEditorSettings(ctx);
		for (const warning of settings.warnings) ctx.ui.notify(warning, "warning");

		if (webEditor && (mode === "restart" || webEditorPreferredPort !== settings.preferredPort)) {
			const server = webEditor;
			await server.close();
			clearWebEditor(server);
			ctx.ui.setStatus("pi-forge-editor", undefined);
		}

		if (!webEditor) {
			try {
				webEditor = await startWebEditorServer(createWebEditorHost(ctx, webHostRuntime(ctx)), { port: settings.preferredPort });
			} catch (error) {
				if (settings.preferredPort !== undefined) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`pi-forge: preferred editor port 127.0.0.1:${settings.preferredPort} was unavailable (${detail}); using an available port instead.`, "warning");
					try {
						webEditor = await startWebEditorServer(createWebEditorHost(ctx, webHostRuntime(ctx)));
					} catch (fallbackError) {
						const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
						ctx.ui.setStatus("pi-forge-editor", undefined);
						ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${fallbackDetail}.`, "error");
						return;
					}
				} else {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.setStatus("pi-forge-editor", undefined);
					ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${detail}.`, "error");
					return;
				}
			}
			rememberWebEditor(webEditor, ctx.cwd, settings.preferredPort);
			ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
			ctx.ui.notify(`pi-forge: stack editor running at ${webEditor.url}`, "info");
		} else {
			webEditor.updateHost(createWebEditorHost(ctx, webHostRuntime(ctx)));
			rememberWebEditor(webEditor, ctx.cwd, settings.preferredPort);
			ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
			ctx.ui.notify(`pi-forge: stack editor already running at ${webEditor.url}`, "info");
		}

		await showText(ctx, "pi-forge stack editor", `Open the local stack editor:\n\n${webEditor.url}\n\nServer bound to 127.0.0.1:${webEditor.port}\nOptional config: ${settings.configPath}\nProject: ${webEditorCwd}`);
	}

	async function stopWebEditor(ctx: ExtensionCommandContext): Promise<void> {
		syncWebEditorFromShared(ctx.cwd);
		if (!webEditor) {
			ctx.ui.notify("pi-forge: stack editor is not running.", "info");
			return;
		}
		const server = webEditor;
		await server.close();
		clearWebEditor(server);
		ctx.ui.setStatus("pi-forge-editor", undefined);
		ctx.ui.notify("pi-forge: stack editor stopped.", "info");
	}

	registerLifecycleHandlers(pi, state, {
		reloadStacks,
		activateFreshSessionDefaults,
		refreshWebEditorHost,
		notifyActivePreset,
		syncActiveToolPolicy,
		restoreActiveToolPolicy: () => restoreToolPolicy(),
		toolPolicyBlockReason,
		activeId,
		persistActiveSelection,
		recordCompileDiagnostics,
	});
	registerPayloadRequestHandler(pi, state, () => state.active);
	registerPayloadCommands(pi, state);
	registerPresetCommand(pi, state, {
		selectedActiveId,
		setActive,
		reloadStacks,
		openWebEditor,
		stopWebEditor,
	});
	registerProfileCommand(pi, state, {
		reloadProfiles,
		resolveProfile,
		setActive,
		previewToolNames,
	});
}
