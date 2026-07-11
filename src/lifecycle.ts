import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
	getLatestUserMessage,
	markSessionVariablesClean,
	resetTurnVariables,
} from "./compiler.ts";
import { applyFinalizeRegexRulesToMessage } from "./regex.ts";
import { isAgentProfileProvenance } from "./agent-profile.ts";
import { PROFILE_ENTRY_TYPE, STATE_ENTRY_TYPE, VARIABLE_ENTRY_TYPE, type PiForgeRuntimeState } from "./runtime-state.ts";
import type { PromptStackDiagnostic, PromptVariableStore, PromptVariableValue } from "./types.ts";

export interface LifecycleDeps {
	reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: { deferToolPolicy?: boolean }): Promise<void>;
	refreshWebEditorHost(ctx: ExtensionContext): void;
	notifyActivePreset(ctx: ExtensionContext, detail: string): void;
	syncActiveToolPolicy(ctx?: ExtensionContext): void;
	restoreActiveToolPolicy(): void;
	toolPolicyBlockReason(toolName: string): string | undefined;
	activeId(): string | undefined;
	persistActiveSelection(id: string): void;
	recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
}

export function registerLifecycleHandlers(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: LifecycleDeps): void {
	let startupToolPolicyPending = false;

	pi.on("session_shutdown", async () => {
		// Pi carries the old runtime's active built-in tool names into a replacement
		// runtime. Restore the pre-policy set before reload/session replacement so the
		// replacement pi-forge instance can capture a complete baseline.
		startupToolPolicyPending = false;
		deps.restoreActiveToolPolicy();
	});

	pi.on("session_start", async (event, ctx) => {
		startupToolPolicyPending = true;
		try {
			await restoreBranchScopedRuntime(ctx, state, deps, { deferToolPolicy: true });
		} catch (error) {
			startupToolPolicyPending = false;
			throw error;
		}
		deps.refreshWebEditorHost(ctx);
		deps.notifyActivePreset(ctx, "after session " + event.reason);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		if (!startupToolPolicyPending) return;
		startupToolPolicyPending = false;
		deps.syncActiveToolPolicy(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreBranchScopedRuntime(ctx, state, deps);
		deps.refreshWebEditorHost(ctx);
		deps.notifyActivePreset(ctx, "after tree navigation");
	});

	pi.on("session_compact", async (_event, ctx) => {
		await restoreBranchScopedRuntime(ctx, state, deps);
		deps.refreshWebEditorHost(ctx);
		deps.notifyActivePreset(ctx, "after compaction");
	});

	pi.on("turn_start", async () => {
		deps.syncActiveToolPolicy();
		const id = deps.activeId();
		if (id) deps.persistActiveSelection(id);
	});

	pi.on("input", async () => {
		deps.syncActiveToolPolicy();
	});

	pi.on("tool_call", async (event) => {
		const reason = deps.toolPolicyBlockReason(event.toolName);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.currentSystemPromptOptions = event.systemPromptOptions;
		state.currentLatestUserMessage = event.prompt;
		state.currentVariableStore = createPromptVariableStore(state.sessionVariables);
		resetTurnVariables(state.currentVariableStore);
		state.contextRewritePending = true;

		if (!state.active) return;

		const result = compileSystemPrompt(
			state.active.stack,
			{ options: event.systemPromptOptions, ctx, latestUserMessage: event.prompt, now: new Date(), variables: state.currentVariableStore },
			event.systemPrompt,
		);
		deps.recordCompileDiagnostics(ctx, result.diagnostics);
		persistVariablesIfDirty(pi, state, state.currentVariableStore);

		return { systemPrompt: result.systemPrompt };
	});

	pi.on("context", async (event, ctx) => {
		if (!state.active || !state.currentSystemPromptOptions || !state.contextRewritePending) return;

		// Rewrite the message layout only for the first provider request of a user-submitted prompt.
		// Tool-result follow-up turns must receive Pi's natural context; otherwise post-history
		// prompt blocks such as COT / {{lastUserMessage}} are re-appended after every tool call
		// and the model restarts its planning instead of continuing from the tool result.
		state.contextRewritePending = false;

		if (!state.currentVariableStore) state.currentVariableStore = createPromptVariableStore(state.sessionVariables);
		const latestUserMessage = getLatestUserMessage(event.messages) ?? state.currentLatestUserMessage;
		const result = compileMessages(
			state.active.stack,
			{ options: state.currentSystemPromptOptions, ctx, latestUserMessage, now: new Date(), variables: state.currentVariableStore },
			event.messages,
		);
		deps.recordCompileDiagnostics(ctx, [...state.latestCompileDiagnostics, ...result.diagnostics]);
		persistVariablesIfDirty(pi, state, state.currentVariableStore);
		return { messages: result.messages };
	});

	pi.on("message_end", async (event, ctx) => {
		if (!state.active) return;
		const diagnostics: PromptStackDiagnostic[] = [];
		const message = applyFinalizeRegexRulesToMessage(state.active.stack, event.message, diagnostics);
		if (diagnostics.length > 0) deps.recordCompileDiagnostics(ctx, [...state.latestCompileDiagnostics, ...diagnostics]);
		if (!message) return;
		return { message };
	});

	pi.on("agent_end", async () => {
		persistVariablesIfDirty(pi, state, state.currentVariableStore);
		state.currentSystemPromptOptions = undefined;
		state.currentLatestUserMessage = undefined;
		state.currentVariableStore = undefined;
		state.contextRewritePending = false;
	});
}

async function restoreBranchScopedRuntime(
	ctx: ExtensionContext,
	state: PiForgeRuntimeState,
	deps: LifecycleDeps,
	options?: { deferToolPolicy?: boolean },
): Promise<void> {
	state.sessionVariables = getRestoredVariables(ctx);
	state.lastAppliedProfile = getRestoredProfileProvenance(ctx);
	state.currentVariableStore = undefined;
	const restoredActiveId = getRestoredActiveId(ctx);
	state.lastPersistedActiveId = restoredActiveId;
	await deps.reloadStacks(ctx, restoredActiveId, options);
}

function getRestoredProfileProvenance(ctx: ExtensionContext) {
	const entries = getCurrentBranchEntries(ctx);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { provenance?: unknown } };
		if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY_TYPE) continue;
		if (entry.data?.provenance === null) return undefined;
		return isAgentProfileProvenance(entry.data?.provenance) ? entry.data.provenance : undefined;
	}
	return undefined;
}

function getCurrentBranchEntries(ctx: ExtensionContext): unknown[] {
	const leafId = ctx.sessionManager.getLeafId();
	if (leafId === null) return [];
	const sessionManager = ctx.sessionManager as {
		getBranch?: (fromId?: string) => unknown[];
		getEntries: () => unknown[];
	};
	return sessionManager.getBranch ? sessionManager.getBranch(leafId ?? undefined) : sessionManager.getEntries();
}

function getRestoredActiveId(ctx: ExtensionContext): string | undefined {
	const entries = getCurrentBranchEntries(ctx);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { activeStackId?: unknown } };
		if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
			return typeof entry.data?.activeStackId === "string" ? entry.data.activeStackId : undefined;
		}
	}
	return undefined;
}

function getRestoredVariables(ctx: ExtensionContext): Record<string, PromptVariableValue> {
	const entries = getCurrentBranchEntries(ctx);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { variables?: unknown } };
		if (entry.type !== "custom" || entry.customType !== VARIABLE_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data.variables !== "object" || Array.isArray(entry.data.variables)) return {};
		return normalizeVariableRecord(entry.data.variables as Record<string, unknown>);
	}
	return {};
}

function persistVariablesIfDirty(pi: ExtensionAPI, state: PiForgeRuntimeState, store: PromptVariableStore | undefined): void {
	if (!store?.sessionDirty) return;
	state.sessionVariables = { ...store.session };
	pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: state.sessionVariables });
	markSessionVariablesClean(store);
}

function normalizeVariableRecord(value: Record<string, unknown>): Record<string, PromptVariableValue> {
	const result: Record<string, PromptVariableValue> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (isPromptVariableValue(raw)) result[key] = raw;
	}
	return result;
}

function isPromptVariableValue(value: unknown): value is PromptVariableValue {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isPromptVariableValue);
	if (!value || typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(isPromptVariableValue);
}
