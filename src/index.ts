import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSessionContext, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
	agentMessageToPreviewText,
	getLatestUserMessage,
	markSessionVariablesClean,
	renderPreviewMessages,
	resetTurnVariables,
} from "./compiler.ts";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks, promptStackPath, promptStackReadDirs } from "./loader.ts";
import { createProviderPayloadCapture, estimatePayloadTokens } from "./payload-capture.ts";
import { applyResourcePolicy, hasResourcePolicy } from "./policy.ts";
import { applyFinalizeRegexRulesToMessage } from "./regex.ts";
import { importSillyTavernPreset } from "./sillytavern-importer.ts";
import { migrateLegacyPromptStacks, renderMigrationReport } from "./stack-migration.ts";
import type { LoadedPromptStack, PromptStackDiagnostic, PromptStateValue, PromptVariableStore } from "./types.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "./web-host.ts";
import { startWebEditorServer, type WebEditorPayloadCapture, type WebEditorPayloadSnapshot, type WebEditorPreview, type WebEditorPreviewSection, type WebEditorServer, type WebEditorStateSnapshot } from "./web-editor/index.ts";

const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
const AGENT_VAR_PREFIX = "agent.";
const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";

type StateActor = "agent" | "user";
type PayloadDisplayTarget = "editor" | "web";

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

interface StateUpdateInput {
	name: string;
	value: PromptStateValue;
	reason?: string;
}

export default function piForge(pi: ExtensionAPI) {
	const sharedWebEditors = getSharedWebEditorRegistry();
	let stacks: LoadedPromptStack[] = [];
	let active: LoadedPromptStack | undefined;
	let currentSystemPromptOptions: BuildSystemPromptOptions | undefined;
	let currentLatestUserMessage: string | undefined;
	let currentVariableStore: PromptVariableStore | undefined;
	let contextRewritePending = false;
	let sessionVariables: Record<string, PromptStateValue> = {};
	let lastPersistedActiveId: string | undefined;
	let interceptNextProviderPayload = false;
	let interceptPayloadSavePath: string | undefined;
	let interceptPayloadDisplayTarget: PayloadDisplayTarget = "editor";
	let payloadCaptureArmedAt: string | undefined;
	let latestProviderPayloadCapture: WebEditorPayloadCapture | undefined;
	let latestCompileDiagnostics: PromptStackDiagnostic[] = [];
	let webEditor: WebEditorServer | undefined;
	let webEditorCwd: string | undefined;
	let webEditorPreferredPort: number | undefined;
	let toolPolicyBaseline: string[] | undefined;

	function activeId(): string | undefined {
		return active?.stack.id;
	}

	function selectedActiveId(): string | undefined {
		if (active) return active.stack.id;
		return isDisabledPromptStackId(lastPersistedActiveId) ? "none" : undefined;
	}

	function persistActiveSelection(id: string): void {
		if (id === lastPersistedActiveId) return;
		pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: id });
		lastPersistedActiveId = id;
	}

	function setActive(id: string | undefined, ctx?: ExtensionContext): boolean {
		if (!id || isDisabledPromptStackId(id)) {
			active = undefined;
			if (id) persistActiveSelection("none");
			if (ctx) updateStatus(ctx);
			syncActiveToolPolicy(ctx);
			return true;
		}

		const found = stacks.find((candidate) => candidate.stack.id === id);
		if (!found) return false;
		active = found;
		persistActiveSelection(found.stack.id);
		if (ctx) updateStatus(ctx);
		syncActiveToolPolicy(ctx);
		return true;
	}

	function reloadStacks(ctx: ExtensionContext, preferredId?: string): void {
		if (!ctx.isProjectTrusted()) {
			stacks = [];
			active = undefined;
			syncActiveToolPolicy(ctx);
			ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
			updateStatus(ctx);
			return;
		}

		stacks = loadPromptStacks(ctx.cwd);
		active = chooseDefaultStack(stacks, preferredId);
		updateStatus(ctx);
		syncActiveToolPolicy(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (active) {
			ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", "stack:" + active.stack.id));
		} else {
			ctx.ui.setStatus("pi-forge", undefined);
			latestCompileDiagnostics = [];
			ctx.ui.setStatus("pi-forge-diagnostics", undefined);
		}
	}

	function syncActiveToolPolicy(ctx?: ExtensionContext): void {
		const policy = active?.stack.tools;
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
		if (!active) return;
		const errorCount = active.diagnostics.filter((d) => d.level === "error").length;
		const warningCount = active.diagnostics.filter((d) => d.level === "warning").length;
		const suffix = errorCount || warningCount ? " (" + errorCount + " errors, " + warningCount + " warnings)" : "";
		ctx.ui.notify("pi-forge: active preset " + active.stack.id + suffix + " (" + detail + ")", errorCount ? "error" : "info");
	}

	function recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void {
		latestCompileDiagnostics = diagnostics;
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
			getStacks: () => stacks,
			getActive: () => active,
			getActiveId: activeId,
			getSelectedActiveId: selectedActiveId,
			setActive: (id) => setActive(id, ctx),
			reloadStacks: (preferredId) => reloadStacks(ctx, preferredId),
			buildPreview: (target) => buildPreview(ctx, target),
			getState: () => ({ ok: true, ...webStateSnapshot() }),
			setState: (name, value) => {
				if (!isPromptStateValue(value)) return { ok: false, status: 400, error: "State value must be JSON-compatible." };
				const result = applyStatePatch([{ name, value }], [], "user");
				if (!result.ok) return { ok: false, status: 400, error: result.error };
				return { ok: true, ...webStateSnapshot() };
			},
			clearState: (name) => {
				const clears = name ? [name] : Object.keys(sessionVariables);
				const result = applyStatePatch([], clears, "user");
				if (!result.ok) return { ok: false, status: 400, error: result.error };
				return { ok: true, ...webStateSnapshot() };
			},
			getPayload: () => ({ ok: true, ...webPayloadSnapshot() }),
			armPayload: (savePath) => {
				armPayloadIntercept(ctx, savePath, "web");
				return { ok: true, ...webPayloadSnapshot() };
			},
			clearPayload: () => {
				clearPayloadCapture(ctx);
				return { ok: true, ...webPayloadSnapshot() };
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

	function getRestoredVariables(ctx: ExtensionContext): Record<string, PromptStateValue> {
		const entries = getCurrentBranchEntries(ctx);
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { variables?: unknown } };
			if (entry.type !== "custom" || entry.customType !== VARIABLE_ENTRY_TYPE) continue;
			if (!entry.data || typeof entry.data.variables !== "object" || Array.isArray(entry.data.variables)) return {};
			return normalizeStateRecord(entry.data.variables as Record<string, unknown>);
		}
		return {};
	}

	function persistVariablesIfDirty(store: PromptVariableStore | undefined): void {
		if (!store?.sessionDirty) return;
		sessionVariables = { ...store.session };
		pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: sessionVariables });
		markSessionVariablesClean(store);
	}

	function normalizeStateRecord(value: Record<string, unknown>): Record<string, PromptStateValue> {
		const result: Record<string, PromptStateValue> = {};
		for (const [key, raw] of Object.entries(value)) {
			if (isPromptStateValue(raw)) result[key] = raw;
		}
		return result;
	}

	function isPromptStateValue(value: unknown): value is PromptStateValue {
		if (value === null) return true;
		const type = typeof value;
		if (type === "string" || type === "boolean") return true;
		if (type === "number") return Number.isFinite(value);
		if (Array.isArray(value)) return value.every(isPromptStateValue);
		if (!value || typeof value !== "object") return false;
		return Object.values(value as Record<string, unknown>).every(isPromptStateValue);
	}

	function validateStateName(name: string): string | undefined {
		if (!name.trim()) return "state name must not be empty";
		if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
			return "state name may only contain letters, numbers, underscore, dash, dot, and colon";
		}
		return undefined;
	}

	function validateStateUpdate(update: StateUpdateInput, actor: StateActor): string | undefined {
		const permissionError = validateStateWritePermission(update.name, actor, actor === "agent" ? "write" : "set");
		if (permissionError) return permissionError;

		const definition = active?.stack.state?.definitions?.[update.name];
		if (definition?.type) {
			const typeError = validateStateValueType(update.value, definition.type);
			if (typeError) return `${update.name}: expected ${definition.type}, got ${typeError}`;
		}
		return undefined;
	}

	function validateStateClear(name: string, actor: StateActor): string | undefined {
		return validateStateWritePermission(name, actor, "clear");
	}

	function validateStateWritePermission(name: string, actor: StateActor, action: "set" | "write" | "clear"): string | undefined {
		const nameError = validateStateName(name);
		if (nameError) return `${name || "(empty)"}: ${nameError}`;

		if (actor === "agent" && !name.startsWith(AGENT_VAR_PREFIX)) {
			return `${name}: agents may only ${action} ${AGENT_VAR_PREFIX}* state`;
		}

		const definition = active?.stack.state?.definitions?.[name];
		if (actor === "agent" && definition?.agentWritable === false) {
			return `${name}: stack schema marks this state as not agent-writable`;
		}
		if (actor === "user" && definition?.userWritable === false) {
			return `${name}: stack schema marks this state as not user-writable`;
		}
		return undefined;
	}

	function applyStatePatch(updates: StateUpdateInput[], clears: string[], actor: StateActor): { ok: true; updated: number; cleared: number } | { ok: false; error: string } {
		for (const update of updates) {
			const error = validateStateUpdate(update, actor);
			if (error) return { ok: false, error };
		}
		for (const name of clears) {
			const error = validateStateClear(name, actor);
			if (error) return { ok: false, error };
		}

		for (const update of updates) {
			sessionVariables[update.name] = update.value;
			if (currentVariableStore) currentVariableStore.session[update.name] = update.value;
		}
		for (const name of clears) {
			delete sessionVariables[name];
			if (currentVariableStore) delete currentVariableStore.session[name];
		}

		pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: { ...sessionVariables } });
		if (currentVariableStore) markSessionVariablesClean(currentVariableStore);
		return { ok: true, updated: updates.length, cleared: clears.length };
	}

	function validateStateValueType(value: PromptStateValue, typeExpression: string): string | undefined {
		const types = typeExpression.split("|").map((part) => part.trim()).filter(Boolean);
		if (types.length === 0 || types.some((type) => stateValueMatchesType(value, type))) return undefined;
		return inferRuntimeType(value);
	}

	function stateValueMatchesType(value: PromptStateValue, type: string): boolean {
		if (type === "any" || type === "unknown" || type === "json" || type === "Json") return true;
		if (type === "null") return value === null;
		if (type === "array" || type === "unknown[]") return Array.isArray(value);
		if (type === "object" || type === "Record<string, unknown>" || type === "Record<string, any>") {
			return !!value && typeof value === "object" && !Array.isArray(value);
		}
		if (type.endsWith("[]")) {
			if (!Array.isArray(value)) return false;
			const itemType = type.slice(0, -2).trim();
			return value.every((item) => stateValueMatchesType(item, itemType));
		}
		return typeof value === type;
	}

	function inferRuntimeType(value: PromptStateValue): string {
		if (value === null) return "null";
		if (Array.isArray(value)) return "array";
		return typeof value;
	}

	function parseStateCommandValue(raw: string): PromptStateValue {
		const trimmed = raw.trim();
		if (/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|["[{])/.test(trimmed)) {
			try {
				const parsed = JSON.parse(trimmed);
				if (isPromptStateValue(parsed)) return parsed;
			} catch {
				// Fall back to string for friendly command input.
			}
		}
		return raw;
	}

	function formatStateValue(value: PromptStateValue): string {
		return typeof value === "string" ? value : JSON.stringify(value, null, 2);
	}

	function restoreBranchScopedState(ctx: ExtensionContext): void {
		sessionVariables = getRestoredVariables(ctx);
		currentVariableStore = undefined;
		const restoredActiveId = getRestoredActiveId(ctx);
		lastPersistedActiveId = restoredActiveId;
		reloadStacks(ctx, restoredActiveId);
	}

	pi.on("session_start", async (event, ctx) => {
		restoreBranchScopedState(ctx);
		refreshWebEditorHost(ctx);
		notifyActivePreset(ctx, "after session " + event.reason);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreBranchScopedState(ctx);
		refreshWebEditorHost(ctx);
		notifyActivePreset(ctx, "after tree navigation");
	});

	pi.on("session_compact", async (_event, ctx) => {
		restoreBranchScopedState(ctx);
		refreshWebEditorHost(ctx);
		notifyActivePreset(ctx, "after compaction");
	});

	pi.on("turn_start", async () => {
		syncActiveToolPolicy();
		const id = activeId();
		if (id) persistActiveSelection(id);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentSystemPromptOptions = event.systemPromptOptions;
		currentLatestUserMessage = event.prompt;
		currentVariableStore = createPromptVariableStore(sessionVariables);
		resetTurnVariables(currentVariableStore);
		contextRewritePending = true;

		if (!active) return;

		const result = compileSystemPrompt(
			active.stack,
			{ options: event.systemPromptOptions, ctx, latestUserMessage: event.prompt, now: new Date(), variables: currentVariableStore },
			event.systemPrompt,
		);
		recordCompileDiagnostics(ctx, result.diagnostics);
		persistVariablesIfDirty(currentVariableStore);

		return { systemPrompt: result.systemPrompt };
	});

	pi.on("context", async (event, ctx) => {
		if (!active || !currentSystemPromptOptions || !contextRewritePending) return;

		// Rewrite the message layout only for the first provider request of a user-submitted prompt.
		// Tool-result follow-up turns must receive Pi's natural context; otherwise post-history
		// prompt blocks such as COT / {{lastUserMessage}} are re-appended after every tool call
		// and the model restarts its planning instead of continuing from the tool result.
		contextRewritePending = false;

		if (!currentVariableStore) currentVariableStore = createPromptVariableStore(sessionVariables);
		const latestUserMessage = getLatestUserMessage(event.messages) ?? currentLatestUserMessage;
		const result = compileMessages(
			active.stack,
			{ options: currentSystemPromptOptions, ctx, latestUserMessage, now: new Date(), variables: currentVariableStore },
			event.messages,
		);
		recordCompileDiagnostics(ctx, [...latestCompileDiagnostics, ...result.diagnostics]);
		persistVariablesIfDirty(currentVariableStore);
		return { messages: result.messages };
	});

	pi.on("message_end", async (event, ctx) => {
		if (!active) return;
		const diagnostics: PromptStackDiagnostic[] = [];
		const message = applyFinalizeRegexRulesToMessage(active.stack, event.message, diagnostics);
		if (diagnostics.length > 0) recordCompileDiagnostics(ctx, [...latestCompileDiagnostics, ...diagnostics]);
		if (!message) return;
		return { message };
	});

	pi.on("agent_end", async () => {
		persistVariablesIfDirty(currentVariableStore);
		currentSystemPromptOptions = undefined;
		currentLatestUserMessage = undefined;
		currentVariableStore = undefined;
		contextRewritePending = false;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!interceptNextProviderPayload) return;
		const savePath = interceptPayloadSavePath;
		const displayTarget = interceptPayloadDisplayTarget;
		interceptNextProviderPayload = false;
		interceptPayloadSavePath = undefined;
		interceptPayloadDisplayTarget = "editor";
		payloadCaptureArmedAt = undefined;
		ctx.ui.setStatus("pi-forge-intercept", undefined);

		const capture = captureProviderPayload(event.payload, savePath);
		if (savePath) {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("pi-forge: project is not trusted; refusing to save provider payload.", "warning");
			} else {
				const resolvedPath = savePath.startsWith("/") ? savePath : join(ctx.cwd, savePath);
				mkdirSync(dirname(resolvedPath), { recursive: true });
				writeFileSync(resolvedPath, capture.text, "utf8");
				ctx.ui.notify(`pi-forge: provider payload saved to ${resolvedPath} (${capture.chars} chars, ~${capture.approxTokens} tokens)`, "info");
			}
		}

		if (displayTarget === "web") {
			ctx.ui.notify(`pi-forge: provider payload captured for web editor (${capture.chars} chars, ~${capture.approxTokens} tokens).`, "info");
			return;
		}

		if (ctx.hasUI) {
			await ctx.ui.editor(`pi-forge: provider payload (${capture.chars} chars, ~${capture.approxTokens} tokens)`, capture.text);
			return;
		}

		console.log(capture.text);
	});

	pi.registerTool({
		name: "forge_state_set",
		label: "Set Prompt State",
		description: "Batch update persistent prompt state for future turns. Only names starting with 'agent.' can be written by the agent.",
		promptSnippet: "Batch update agent-scoped prompt state for cross-turn continuity. Use this when durable state should be visible in the prompt_state slot on future turns.",
		promptGuidelines: [
			"Use forge_state_set to persist concise cross-turn state such as task progress, story state, open questions, or durable facts the user asked you to remember.",
			`Only state names starting with '${AGENT_VAR_PREFIX}' are writable by the agent. User and stack configuration state are read-only to the agent.`,
			"Prefer one batch update at natural checkpoints instead of many small updates. Do not store secrets or large transcripts.",
			"State written by this tool is primarily for future turns; the current prompt has already been built.",
		],
		parameters: Type.Object({
			updates: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: `State name (must start with '${AGENT_VAR_PREFIX}')` }),
				value: Type.Unknown({ description: "JSON-compatible value: string, number, boolean, null, array, or object" }),
				reason: Type.Optional(Type.String({ description: "Brief reason for the update" })),
			}))),
			clears: Type.Optional(Type.Array(Type.String({ description: `State names to clear (must start with '${AGENT_VAR_PREFIX}')` }))),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const updatesRaw = Array.isArray(params.updates) ? params.updates : [];
			const clears = Array.isArray(params.clears) ? params.clears.filter((name): name is string => typeof name === "string") : [];
			const updates: StateUpdateInput[] = [];

			for (const raw of updatesRaw) {
				if (!raw || typeof raw !== "object") {
					return {
						content: [{ type: "text", text: "Error: every update must be an object." }],
						details: { error: "invalid update" },
					};
				}
				const update = raw as { name?: unknown; value?: unknown; reason?: unknown };
				if (typeof update.name !== "string") {
					return {
						content: [{ type: "text", text: "Error: every update needs a string name." }],
						details: { error: "invalid update name" },
					};
				}
				if (!isPromptStateValue(update.value)) {
					return {
						content: [{ type: "text", text: `Error: ${update.name} value is not JSON-compatible.` }],
						details: { error: "invalid value", name: update.name },
					};
				}
				updates.push({
					name: update.name,
					value: update.value,
					reason: typeof update.reason === "string" ? update.reason : undefined,
				});
			}

			if (updates.length === 0 && clears.length === 0) {
				return {
					content: [{ type: "text", text: "No state updates or clears provided." }],
					details: { updated: 0, cleared: 0 },
				};
			}

			const result = applyStatePatch(updates, clears, "agent");
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { error: result.error },
				};
			}

			return {
				content: [{ type: "text", text: `State updated: ${result.updated} set, ${result.cleared} cleared.` }],
				details: { updated: updates.map(({ name, value, reason }) => ({ name, value, reason })), cleared: clears },
			};
		},
	});

	pi.registerTool({
		name: "forge_set_var",
		label: "Set Prompt Variable",
		description: "Compatibility alias for forge_state_set. Set one persistent agent-scoped state value. Only variables starting with 'agent.' can be written by the agent.",
		promptSnippet: "Compatibility alias for forge_state_set. Prefer forge_state_set for batch prompt state updates.",
		promptGuidelines: [
			"Prefer forge_state_set when updating prompt state. forge_set_var only exists for compatibility with older prompt stacks.",
			`Only variable names starting with '${AGENT_VAR_PREFIX}' are writable.`,
		],
		parameters: Type.Object({
			name: Type.String({ description: `Variable name (must start with '${AGENT_VAR_PREFIX}')` }),
			value: Type.String({ description: "Variable value" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyStatePatch([{ name: params.name, value: params.value }], [], "agent");
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { error: result.error, name: params.name },
				};
			}
			return {
				content: [{ type: "text", text: `Variable ${params.name} set.` }],
				details: { name: params.name, value: params.value },
			};
		},
	});

	function armPayloadIntercept(ctx: ExtensionCommandContext, savePath?: string, displayTarget: PayloadDisplayTarget = "editor"): void {
		interceptNextProviderPayload = true;
		interceptPayloadSavePath = savePath;
		interceptPayloadDisplayTarget = displayTarget;
		payloadCaptureArmedAt = new Date().toISOString();
		latestProviderPayloadCapture = undefined;
		ctx.ui.setStatus("pi-forge-intercept", ctx.ui.theme.fg("warning", savePath ? "payload:armed+save" : "payload:armed"));
		if (displayTarget === "web") {
			ctx.ui.notify(savePath ? `pi-forge: next provider payload will be captured in the web editor and saved to ${savePath}.` : "pi-forge: next provider payload will be captured in the web editor.", "info");
			return;
		}
		ctx.ui.notify(savePath ? `pi-forge: next provider payload will be displayed and saved to ${savePath}.` : "pi-forge: next provider payload will be displayed before sending.", "info");
	}

	function clearPayloadCapture(ctx: ExtensionCommandContext): void {
		interceptNextProviderPayload = false;
		interceptPayloadSavePath = undefined;
		interceptPayloadDisplayTarget = "editor";
		payloadCaptureArmedAt = undefined;
		latestProviderPayloadCapture = undefined;
		ctx.ui.setStatus("pi-forge-intercept", undefined);
	}

	pi.registerCommand("intercept", {
		description: "Display the next provider payload before it is sent",
		handler: async (_args, ctx) => {
			armPayloadIntercept(ctx);
		},
	});

	pi.registerCommand("payload", {
		description: "Inspect or save provider payloads: /payload next [save=<path>]",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				return ["next"].filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			if (parts[0] === "next" && parts.length <= 2) {
				const suggestion = "save=.pi/forge/payloads/last.json";
				return suggestion.startsWith(parts[1] ?? "") ? [{ value: `next ${suggestion}`, label: suggestion }] : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [command = "next", ...rest] = args.trim() ? args.trim().split(/\s+/) : ["next"];
			if (command !== "next") {
				ctx.ui.notify(`Unknown /payload subcommand: ${command}`, "warning");
				return;
			}
			const saveArg = rest.find((arg) => arg.startsWith("save="));
			const savePath = saveArg?.slice("save=".length).trim() || undefined;
			armPayloadIntercept(ctx, savePath);
		},
	});

	pi.registerCommand("preset", {
		description: "Manage pi-forge prompt stacks: list, use, preview, validate, reload, vars, ui",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				const commands = ["list", "use", "preview", "validate", "diagnostics", "reload", "status", "vars", "import-silly", "migrate-stacks", "ui"];
				return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			const first = parts[0];
			if (["use", "preview", "validate"].includes(first)) {
				const fragment = parts[1] ?? "";
				const ids = ["none", ...stacks.map((loaded) => loaded.stack.id)];
				return ids.filter((id) => id.startsWith(fragment)).map((id) => ({ value: `${first} ${id}`, label: id }));
			}
			if (first === "vars") {
				const sub = parts[1] ?? "";
				if (parts.length <= 2 && !prefix.endsWith(" ")) {
					const subs = ["set", "get", "clear", "list"];
					return subs.filter((s) => s.startsWith(sub)).map((s) => ({ value: `vars ${s}`, label: s }));
				}
				if (["set", "get", "clear"].includes(sub) && parts.length <= 3) {
					const fragment = parts[2] ?? "";
					const names = Object.keys(sessionVariables);
					return names.filter((n) => n.startsWith(fragment)).map((n) => ({ value: `vars ${sub} ${n}`, label: n }));
				}
			}
			if (first === "ui" && parts.length <= 2) {
				const fragment = parts[1] ?? "";
				const subs = ["stop", "restart"];
				return subs.filter((s) => s.startsWith(fragment)).map((s) => ({ value: `ui ${s}`, label: s }));
			}
			if (first === "migrate-stacks") {
				const fragment = parts[parts.length - 1] ?? "";
				const flags = ["--dry-run", "--overwrite", "--delete-legacy"];
				return flags.filter((flag) => flag.startsWith(fragment)).map((flag) => ({ value: `${parts.slice(0, -1).join(" ")} ${flag}`.trim(), label: flag }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			await handlePresetCommand(args, ctx);
		},
	});

	pi.registerCommand("state", {
		description: "Manage pi-forge prompt state",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				const commands = ["list", "set", "get", "clear"];
				return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			const first = parts[0];
			if (["get", "clear"].includes(first) && parts.length <= 2) {
				const fragment = parts[1] ?? "";
				return Object.keys(sessionVariables)
					.filter((name) => name.startsWith(fragment))
					.map((name) => ({ value: `${first} ${name}`, label: name }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			await handleStateCommand(args, ctx);
		},
	});

	async function handlePresetCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];

		switch (command) {
			case "list":
			case "status":
				await showText(ctx, "pi-forge prompt stacks", renderStackList(ctx));
				return;

			case "reload":
				reloadStacks(ctx, selectedActiveId());
				ctx.ui.notify(`pi-forge: reloaded ${stacks.length} prompt stack(s).`, "info");
				return;

			case "ui": {
				const sub = rest[0];
				if (sub === "stop") {
					await stopWebEditor(ctx);
					return;
				}
				await openWebEditor(ctx, sub === "restart" ? "restart" : "open");
				return;
			}

			case "vars": {
				const sub = rest[0];

				if (sub === "set") {
					const name = rest[1];
					const value = rest.slice(2).join(" ");
					if (!name || value === "") {
						ctx.ui.notify("Usage: /preset vars set <name> <value>", "warning");
						return;
					}
					const result = applyStatePatch([{ name, value }], [], "user");
					if (!result.ok) {
						ctx.ui.notify(`pi-forge variable error: ${result.error}`, "error");
						return;
					}
					ctx.ui.notify(`pi-forge: set session variable ${name} = ${JSON.stringify(value)}`, "info");
					return;
				}

				if (sub === "get") {
					const name = rest[1];
					if (!name) {
						ctx.ui.notify("Usage: /preset vars get <name>", "warning");
						return;
					}
					const value = sessionVariables[name];
					if (value === undefined) {
						await showText(ctx, `pi-forge variable: ${name}`, `# ${name}\n\n(not set)`);
					} else {
						await showText(ctx, `pi-forge variable: ${name}`, `# ${name}\n\n${formatStateValue(value)}`);
					}
					return;
				}

				if (sub === "clear") {
					const name = rest[1];
					const clears = name ? [name] : Object.keys(sessionVariables);
					const result = applyStatePatch([], clears, "user");
					if (!result.ok) {
						ctx.ui.notify(`pi-forge variable error: ${result.error}`, "error");
						return;
					}
					ctx.ui.notify(name ? `pi-forge: cleared session variable ${name}` : "pi-forge: cleared all session variables", "info");
					return;
				}

				// No subcommand or "list" — show all variables
				await showText(ctx, "pi-forge variables", renderVariablesList());
				return;
			}

			case "use": {
				const id = rest[0];
				if (!id) {
					ctx.ui.notify("Usage: /preset use <id|none>", "warning");
					return;
				}
				if (!setActive(id, ctx)) {
					ctx.ui.notify(`Unknown prompt stack: ${id}`, "error");
					return;
				}
				ctx.ui.notify(active ? `pi-forge: active prompt stack ${active.stack.id}` : "pi-forge: prompt stack disabled", "info");
				return;
			}

			case "preview": {
				const target = rest[0] ? stacks.find((loaded) => loaded.stack.id === rest[0]) : active;
				if (!target) {
					ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
					return;
				}
				await showText(ctx, `pi-forge preview: ${target.stack.id}`, renderPreview(ctx, target));
				return;
			}

			case "validate": {
				const target = rest[0] ? stacks.find((loaded) => loaded.stack.id === rest[0]) : active;
				if (!target) {
					ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
					return;
				}
				await showText(ctx, `pi-forge validation: ${target.stack.id}`, renderDiagnostics(target.diagnostics));
				return;
			}

			case "diagnostics": {
				await showText(ctx, "pi-forge diagnostics", renderCurrentDiagnostics());
				return;
			}

			case "migrate-stacks": {
				const flags = new Set(rest);
				const dryRun = flags.has("--dry-run");
				if (!ctx.isProjectTrusted() && !dryRun) {
					ctx.ui.notify("pi-forge: project is not trusted; refusing to migrate prompt stacks.", "warning");
					return;
				}
				const report = migrateLegacyPromptStacks(ctx.cwd, {
					dryRun,
					overwrite: flags.has("--overwrite"),
					deleteLegacy: flags.has("--delete-legacy"),
				});
				if (!dryRun) reloadStacks(ctx, selectedActiveId());
				const changed = report.copied + report.overwritten;
				const summary = dryRun
					? `pi-forge: migration dry run found ${report.files.length} legacy stack file(s).`
					: `pi-forge: migrated ${changed} legacy stack file(s), skipped ${report.skipped}, errors ${report.errors}.`;
				ctx.ui.notify(summary, report.errors ? "warning" : "info");
				await showText(ctx, "pi-forge prompt-stack migration", renderMigrationReport(report));
				return;
			}

			case "import-silly": {
				if (!ctx.isProjectTrusted()) {
					ctx.ui.notify("pi-forge: project is not trusted; refusing to write imported prompt stacks.", "warning");
					return;
				}

				const sourcePath = rest[0];
				if (!sourcePath) {
					ctx.ui.notify("Usage: /preset import-silly <path> [character_id] [--dry-run] [--overwrite]", "warning");
					return;
				}

				const charIdToken = rest[1]?.startsWith("--") ? undefined : rest[1];
				const flags = new Set(rest.slice(charIdToken ? 2 : 1));
				const dryRun = flags.has("--dry-run");
				let overwrite = flags.has("--overwrite");

				const resolvedPath = sourcePath.startsWith("/") ? sourcePath : join(ctx.cwd, sourcePath);
				if (!existsSync(resolvedPath)) {
					ctx.ui.notify(`File not found: ${resolvedPath}`, "error");
					return;
				}

				const charId = charIdToken ? Number(charIdToken) : undefined;
				if (charIdToken && (Number.isNaN(charId) || !Number.isFinite(charId))) {
					ctx.ui.notify(`Invalid character_id: ${charIdToken}`, "error");
					return;
				}

				const result = importSillyTavernPreset(resolvedPath, charId);
				if ("error" in result) {
					ctx.ui.notify(`pi-forge import error: ${result.error}`, "error");
					return;
				}

				const existingStack = stacks.find((candidate) => candidate.stack.id === result.stack.id);
				const stackPath = existingStack?.filePath ?? promptStackPath(ctx.cwd, result.stack.id);
				const stacksDir = dirname(stackPath);
				const reportDir = join(ctx.cwd, ".pi", "forge", "import-reports");
				const reportPath = join(reportDir, `${result.stack.id}.md`);

				if (dryRun) {
					await showText(ctx, `pi-forge import dry run: ${result.stack.id}`, `Would write stack to: ${stackPath}\nWould write report to: ${reportPath}\n\n## Generated stack JSON\n\n\`\`\`json\n${JSON.stringify(result.stack, null, 2)}\n\`\`\`\n\n${result.report}`);
					return;
				}

				const existingPaths = [stackPath, reportPath].filter((path) => existsSync(path));
				if (existingPaths.length > 0 && !overwrite) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`pi-forge: import would overwrite existing file(s): ${existingPaths.join(", ")}. Re-run with --overwrite.`, "error");
						return;
					}
					overwrite = await ctx.ui.confirm("Overwrite pi-forge import output?", `These file(s) already exist:\n${existingPaths.join("\n")}\n\nOverwrite them?`);
					if (!overwrite) {
						ctx.ui.notify("pi-forge: import cancelled; existing files were left unchanged.", "info");
						return;
					}
				}

				if (!existsSync(stacksDir)) mkdirSync(stacksDir, { recursive: true });
				writeFileSync(stackPath, JSON.stringify(result.stack, null, 2), "utf8");

				if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
				writeFileSync(reportPath, result.report, "utf8");

				// Reload stacks to pick up the new one
				reloadStacks(ctx, selectedActiveId());

				ctx.ui.notify(`pi-forge: imported ${result.stack.id} (${result.stack.items.length} items)`, "info");
				await showText(ctx, `pi-forge import report: ${result.stack.id}`, `Stack written to: ${stackPath}\nReport written to: ${reportPath}\n\n${result.report}`);
				return;
			}

			default:
				ctx.ui.notify(`Unknown /preset subcommand: ${command}`, "warning");
				return;
		}
	}

	async function handleStateCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];

		switch (command) {
			case "list":
			case "status":
				await showText(ctx, "pi-forge state", renderVariablesList());
				return;

			case "set": {
				const name = rest[0];
				const rawValue = rest.slice(1).join(" ");
				if (!name || rawValue === "") {
					ctx.ui.notify("Usage: /state set <name> <json-or-text-value>", "warning");
					return;
				}
				const value = parseStateCommandValue(rawValue);
				const result = applyStatePatch([{ name, value }], [], "user");
				if (!result.ok) {
					ctx.ui.notify(`pi-forge state error: ${result.error}`, "error");
					return;
				}
				ctx.ui.notify(`pi-forge: set state ${name} = ${JSON.stringify(value)}`, "info");
				return;
			}

			case "get": {
				const name = rest[0];
				if (!name) {
					ctx.ui.notify("Usage: /state get <name>", "warning");
					return;
				}
				const value = sessionVariables[name];
				await showText(ctx, `pi-forge state: ${name}`, value === undefined ? `# ${name}\n\n(not set)` : `# ${name}\n\n${formatStateValue(value)}`);
				return;
			}

			case "clear": {
				const name = rest[0];
				const clears = name ? [name] : Object.keys(sessionVariables);
				const result = applyStatePatch([], clears, "user");
				if (!result.ok) {
					ctx.ui.notify(`pi-forge state error: ${result.error}`, "error");
					return;
				}
				ctx.ui.notify(name ? `pi-forge: cleared state ${name}` : "pi-forge: cleared all session state", "info");
				return;
			}

			default:
				ctx.ui.notify(`Unknown /state subcommand: ${command}`, "warning");
				return;
		}
	}

	function renderStackList(ctx: ExtensionCommandContext): string {
		const lines = [
			"Prompt stack directories:",
			...promptStackReadDirs(ctx.cwd).map((dir, index) => `  ${index === 0 ? "primary" : "legacy"}: ${dir}`),
			`Active stack: ${active?.stack.id ?? "(none)"}`,
			"",
		];

		if (stacks.length === 0) {
			lines.push("No prompt stacks found.", "Create .pi/forge/prompt-stacks/default.json to auto-activate a stack.");
			return lines.join("\n");
		}

		for (const loaded of stacks) {
			const marker = loaded === active ? "*" : " ";
			const errors = loaded.diagnostics.filter((d) => d.level === "error").length;
			const warnings = loaded.diagnostics.filter((d) => d.level === "warning").length;
			const suffix = errors || warnings ? ` (${errors} errors, ${warnings} warnings)` : "";
			lines.push(`${marker} ${loaded.stack.id}${loaded.stack.name ? ` — ${loaded.stack.name}` : ""}${suffix}`);
			lines.push(`  ${loaded.filePath}`);
		}

		lines.push("", "Commands:", "  /preset use <id|none>", "  /preset preview [id]", "  /preset validate [id]", "  /preset diagnostics", "  /preset reload", "  /preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]", "  /preset ui [stop|restart]", "  /state [list|set <name> <value>|get <name>|clear [name]]", "  /preset vars [set <name> <value>|get <name>|clear [name]]");
		return lines.join("\n");
	}

	function renderCurrentDiagnostics(): string {
		const lines = ["# pi-forge diagnostics", ""];
		lines.push("## Active stack load/validation diagnostics", "");
		lines.push(active ? renderDiagnostics(active.diagnostics) : "No active prompt stack.");
		lines.push("", "## Latest runtime compile diagnostics", "");
		lines.push(renderDiagnostics(latestCompileDiagnostics));
		return lines.join("\n");
	}

	function renderVariablesList(): string {
		const lines = ["# pi-forge state", "", "## Session state", ""];
		const sessionEntries = Object.entries(sessionVariables).sort(([a], [b]) => a.localeCompare(b));
		if (sessionEntries.length === 0) lines.push("(none)");
		else for (const [key, value] of sessionEntries) lines.push(`${key} = ${JSON.stringify(value)}`);

		lines.push("", "## Active stack static variables", "");
		const staticEntries = Object.entries(active?.stack.variables ?? {}).sort(([a], [b]) => a.localeCompare(b));
		if (staticEntries.length === 0) lines.push("(none)");
		else for (const [key, value] of staticEntries) lines.push(`${key} = ${JSON.stringify(value)}`);

		const definitions = Object.entries(active?.stack.state?.definitions ?? {}).sort(([a], [b]) => a.localeCompare(b));
		if (definitions.length > 0) {
			lines.push("", "## Active stack state definitions", "");
			for (const [name, definition] of definitions) {
				const details = [
					definition.type ? `type=${definition.type}` : undefined,
					definition.scope ? `scope=${definition.scope}` : undefined,
					definition.agentWritable !== undefined ? `agentWritable=${definition.agentWritable}` : undefined,
					definition.userWritable !== undefined ? `userWritable=${definition.userWritable}` : undefined,
				].filter(Boolean).join(", ");
				lines.push(`${name}${details ? ` (${details})` : ""}${definition.description ? ` — ${definition.description}` : ""}`);
			}
		}

		lines.push("", "Turn variables are cleared for each user message and are only visible during prompt compilation.");
		return lines.join("\n");
	}

	function webStateSnapshot(): WebEditorStateSnapshot {
		return {
			activeStackId: active?.stack.id,
			session: { ...sessionVariables },
			definitions: { ...(active?.stack.state?.definitions ?? {}) },
		};
	}

	function webPayloadSnapshot(): WebEditorPayloadSnapshot {
		if (interceptNextProviderPayload) {
			return {
				status: "armed",
				armedAt: payloadCaptureArmedAt,
				savePath: interceptPayloadSavePath,
			};
		}
		if (latestProviderPayloadCapture) {
			return {
				status: "captured",
				capture: latestProviderPayloadCapture,
			};
		}
		return { status: "idle" };
	}

	function renderPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack): string {
		return buildPreview(ctx, target).text;
	}

	function buildPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack): { text: string; preview: WebEditorPreview; diagnostics: PromptStackDiagnostic[] } {
		const options = ctx.getSystemPromptOptions();
		const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const latestUserMessage = getLatestUserMessage(sessionContext.messages);
		const previewVariables = createPromptVariableStore(sessionVariables);
		const runtime = { options, ctx, latestUserMessage, now: new Date(), variables: previewVariables };
		const system = compileSystemPrompt(target.stack, runtime, ctx.getSystemPrompt());
		const messages = compileMessages(target.stack, runtime, sessionContext.messages);
		const diagnostics = [...target.diagnostics, ...system.diagnostics, ...messages.diagnostics];
		const messageSections = messages.messages.map((message, index) => {
			const content = agentMessageToPreviewText(message);
			return previewSection(`message-${index}`, `${index + 1}. ${message.role}`, content, message.role);
		});
		const systemSection = previewSection("system", "System prompt", system.systemPrompt || "(empty)");
		const totalChars = systemSection.chars + messageSections.reduce((sum, section) => sum + section.chars, 0);
		const preview: WebEditorPreview = {
			stackId: target.stack.id,
			generatedAt: new Date().toISOString(),
			system: systemSection,
			messages: messageSections,
			totalChars,
			approxTokens: estimatePayloadTokens(`${system.systemPrompt}\n${messageSections.map((section) => section.content).join("\n")}`),
		};

		const text = [
			`# Prompt stack preview: ${target.stack.id}`,
			"",
			"## System prompt",
			"",
			system.systemPrompt || "(empty)",
			"",
			"## Message layout",
			"",
			renderPreviewMessages(messages.messages),
			"",
			"## Diagnostics",
			"",
			renderDiagnostics(diagnostics),
		].join("\n");

		return { text, preview, diagnostics };
	}

	function previewSection(id: string, title: string, content: string, role?: string): WebEditorPreviewSection {
		return {
			id,
			title,
			role,
			content,
			chars: content.length,
			approxTokens: estimatePayloadTokens(content),
		};
	}

	function renderDiagnostics(diagnostics: PromptStackDiagnostic[]): string {
		if (diagnostics.length === 0) return "No diagnostics.";
		return diagnostics.map((d) => `${d.level.toUpperCase()}${d.itemId ? ` [${d.itemId}]` : ""}: ${d.message}`).join("\n");
	}

	async function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
		if (ctx.hasUI) {
			await ctx.ui.editor(title, text);
			return;
		}
		console.log(text);
	}

	function captureProviderPayload(value: unknown, savePath?: string): WebEditorPayloadCapture {
		const capture = createProviderPayloadCapture(value, { stackId: active?.stack.id, savePath });
		latestProviderPayloadCapture = capture;
		return capture;
	}
}
