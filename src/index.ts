import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLifecycleHandlers } from "./lifecycle.ts";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks } from "./loader.ts";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.ts";
import { applyResourcePolicy, hasResourcePolicy } from "./policy.ts";
import { buildPreview, showText } from "./preview.ts";
import { registerPresetCommand, selectedActiveId as selectedActiveIdForState } from "./preset-command.ts";
import { createRuntimeState, STATE_ENTRY_TYPE } from "./runtime-state.ts";
import type { PromptStackDiagnostic } from "./types.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "./web-host.ts";
import { startWebEditorServer, type WebEditorServer } from "./web-editor/index.ts";

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

export default function piForge(pi: ExtensionAPI) {
	const sharedWebEditors = getSharedWebEditorRegistry();
	const state = createRuntimeState();
	let webEditor: WebEditorServer | undefined;
	let webEditorCwd: string | undefined;
	let webEditorPreferredPort: number | undefined;
	let toolPolicyBaseline: string[] | undefined;

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

	function reloadStacks(ctx: ExtensionContext, preferredId?: string): void {
		if (!ctx.isProjectTrusted()) {
			state.stacks = [];
			state.active = undefined;
			syncActiveToolPolicy(ctx);
			ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
			updateStatus(ctx);
			return;
		}

		state.stacks = loadPromptStacks(ctx.cwd);
		state.active = chooseDefaultStack(state.stacks, preferredId);
		updateStatus(ctx);
		syncActiveToolPolicy(ctx);
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

		const baseline = toolPolicyBaseline ?? pi.getActiveTools();
		toolPolicyBaseline ??= [...baseline];
		const nextTools = applyResourcePolicy(filterKnownTools(baseline), policy);
		pi.setActiveTools(nextTools);
		if (ctx) {
			const label = nextTools.length > 0 ? `tools:${nextTools.length}` : "tools:none";
			ctx.ui.setStatus("pi-forge-tools", ctx.ui.theme.fg(nextTools.length > 0 ? "accent" : "warning", label));
		}
	}

	function restoreToolPolicy(ctx?: ExtensionContext): void {
		if (toolPolicyBaseline) {
			pi.setActiveTools(filterKnownTools(toolPolicyBaseline));
			toolPolicyBaseline = undefined;
		}
		if (ctx) ctx.ui.setStatus("pi-forge-tools", undefined);
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
			buildPreview: (target) => buildPreview(ctx, target, state.sessionVariables),
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
		refreshWebEditorHost,
		notifyActivePreset,
		syncActiveToolPolicy,
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
}
