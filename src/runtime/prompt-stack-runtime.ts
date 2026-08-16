import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveResourceSelector } from "../catalog.ts";
import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "../forge-extensions.ts";
import {
	chooseDefaultStack,
	isDisabledPromptStackId,
	loadGlobalPromptStacks,
	loadPromptStacksScoped,
} from "../loader.ts";
import { selectedActiveId as selectedActiveIdForState } from "../preset-command.ts";
import { formatResourceKey, parseResourceSelector } from "../resource-identity.ts";
import { STATE_ENTRY_TYPE, type PiForgeRuntimeState } from "../runtime-state.ts";
import type { PromptStackDiagnostic } from "../types.ts";

export interface PromptStackRuntime {
	dispose(): PromptStackDiagnostic[];
	activeId(): string | undefined;
	selectedActiveId(): string | undefined;
	persistActiveSelection(): void;
	setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
	reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: { deferToolPolicy?: boolean; suppressAutoActivate?: boolean }): Promise<void>;
	updateStatus(ctx: ExtensionContext): void;
	notifyActivePreset(ctx: ExtensionContext, detail: string): void;
	recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
}

export function createPromptStackRuntime(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: {
		syncToolPolicy(ctx?: ExtensionContext): void;
		reloadProfiles(ctx: ExtensionContext): void;
	},
): PromptStackRuntime {
	const forgeExtensionState = createForgeExtensionState();

	function dispose(): PromptStackDiagnostic[] {
		const diagnostics = unloadForgeExtensions(forgeExtensionState);
		state.forgeExtensionDiagnostics = diagnostics;
		state.forgeExtensionPaths = [];
		return diagnostics;
	}

	function activeId(): string | undefined {
		return state.active?.stack.id;
	}

	function selectedActiveId(): string | undefined {
		return selectedActiveIdForState(state);
	}

	function persistActiveSelection(): void {
		const canonical = state.active ? formatResourceKey(state.active.key) : "none";
		if (canonical === state.lastPersistedActiveId) return;
		pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: canonical });
		state.lastPersistedActiveId = canonical;
	}

	function setActive(id: string | undefined, ctx?: ExtensionContext): boolean {
		if (!id || isDisabledPromptStackId(id)) {
			state.active = undefined;
			if (id) persistActiveSelection();
			if (ctx) updateStatus(ctx);
			deps.syncToolPolicy(ctx);
			return true;
		}

		if (ctx && !ctx.isProjectTrusted()) return false;

		const parsed = parseResourceSelector(id);
		if (!parsed.ok) return false;
		const found = resolveResourceSelector(state.stacks, parsed.selector);
		if (!found) return false;

		state.active = found;
		persistActiveSelection();
		if (ctx) updateStatus(ctx);
		deps.syncToolPolicy(ctx);
		return true;
	}

	async function reloadStacks(
		ctx: ExtensionContext,
		preferredId?: string,
		options: { deferToolPolicy?: boolean; suppressAutoActivate?: boolean } = {},
	): Promise<void> {
		if (!ctx.isProjectTrusted()) {
			state.forgeExtensionDiagnostics = unloadForgeExtensions(forgeExtensionState);
			state.forgeExtensionPaths = [];
			// Global stacks are user-owned and remain browsable/previewable, but
			// activation is refused until the project is trusted.
			state.stacks = loadGlobalPromptStacks();
			deps.reloadProfiles(ctx);
			state.active = undefined;
			if (!options.deferToolPolicy) deps.syncToolPolicy(ctx);
			ctx.ui.notify("pi-forge: project is not trusted; project prompt stacks are disabled (global stacks remain browsable).", "warning");
			updateStatus(ctx);
			return;
		}

		const extensionResult = await reloadForgeExtensions(ctx.cwd, forgeExtensionState);
		state.forgeExtensionDiagnostics = extensionResult.diagnostics;
		state.forgeExtensionPaths = extensionResult.loadedPaths;
		state.stacks = loadPromptStacksScoped(ctx.cwd);
		deps.reloadProfiles(ctx);
		if (state.forgeExtensionDiagnostics.length > 0) {
			for (const loaded of state.stacks) loaded.diagnostics.unshift(...state.forgeExtensionDiagnostics);
		}
		state.active = options.suppressAutoActivate && preferredId === undefined
			? undefined
			: chooseDefaultStack(state.stacks, preferredId);
		updateStatus(ctx);
		if (!options.deferToolPolicy) deps.syncToolPolicy(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.active) {
			ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", `stack:${state.active.stack.id}`));
		} else {
			ctx.ui.setStatus("pi-forge", undefined);
			state.latestCompileDiagnostics = [];
			ctx.ui.setStatus("pi-forge-diagnostics", undefined);
		}
	}

	function notifyActivePreset(ctx: ExtensionContext, detail: string): void {
		if (!state.active) return;
		const errorCount = state.active.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
		const warningCount = state.active.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
		const suffix = errorCount || warningCount ? ` (${errorCount} errors, ${warningCount} warnings)` : "";
		ctx.ui.notify(`pi-forge: active preset ${state.active.stack.id}${suffix} (${detail})`, errorCount ? "error" : "info");
	}

	function recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void {
		state.latestCompileDiagnostics = diagnostics;
		const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
		const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
		if (errors || warnings) {
			ctx.ui.setStatus("pi-forge-diagnostics", ctx.ui.theme.fg(errors ? "error" : "warning", `forge:${errors}e/${warnings}w`));
			return;
		}
		ctx.ui.setStatus("pi-forge-diagnostics", undefined);
	}

	return { dispose, activeId, selectedActiveId, persistActiveSelection, setActive, reloadStacks, updateStatus, notifyActivePreset, recordCompileDiagnostics };
}
