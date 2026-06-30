import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSessionContext, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
	agentMessageToPreviewText,
	getLatestUserMessage,
	markSessionVariablesClean,
	resetTurnVariables,
} from "./compiler.ts";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks, promptStackPath, promptStackReadDirs } from "./loader.ts";
import { createProviderPayloadCapture, estimatePayloadTokens } from "./payload-capture.ts";
import { applyResourcePolicy, hasResourcePolicy } from "./policy.ts";
import { applyFinalizeRegexRulesToMessage } from "./regex.ts";
import { importSillyTavernPreset } from "./sillytavern-importer.ts";
import { migrateLegacyPromptStacks, renderMigrationReport } from "./stack-migration.ts";
import type { CompileMessageSource, LoadedPromptStack, PromptStackDiagnostic, PromptVariableValue, PromptVariableStore } from "./types.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "./web-host.ts";
import { startWebEditorServer, type WebEditorPayloadCapture, type WebEditorPayloadSnapshot, type WebEditorPreview, type WebEditorPreviewSection, type WebEditorServer } from "./web-editor/index.ts";

const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";

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

export default function piForge(pi: ExtensionAPI) {
	const sharedWebEditors = getSharedWebEditorRegistry();
	let stacks: LoadedPromptStack[] = [];
	let active: LoadedPromptStack | undefined;
	let currentSystemPromptOptions: BuildSystemPromptOptions | undefined;
	let currentLatestUserMessage: string | undefined;
	let currentVariableStore: PromptVariableStore | undefined;
	let contextRewritePending = false;
	let sessionVariables: Record<string, PromptVariableValue> = {};
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

	function persistVariablesIfDirty(store: PromptVariableStore | undefined): void {
		if (!store?.sessionDirty) return;
		sessionVariables = { ...store.session };
		pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: sessionVariables });
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

	function restoreBranchScopedRuntime(ctx: ExtensionContext): void {
		sessionVariables = getRestoredVariables(ctx);
		currentVariableStore = undefined;
		const restoredActiveId = getRestoredActiveId(ctx);
		lastPersistedActiveId = restoredActiveId;
		reloadStacks(ctx, restoredActiveId);
	}

	pi.on("session_start", async (event, ctx) => {
		restoreBranchScopedRuntime(ctx);
		refreshWebEditorHost(ctx);
		notifyActivePreset(ctx, "after session " + event.reason);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreBranchScopedRuntime(ctx);
		refreshWebEditorHost(ctx);
		notifyActivePreset(ctx, "after tree navigation");
	});

	pi.on("session_compact", async (_event, ctx) => {
		restoreBranchScopedRuntime(ctx);
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
		description: "Manage pi-forge prompt stacks: list, use, preview, validate, reload, ui",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				const commands = ["list", "use", "preview", "validate", "diagnostics", "reload", "status", "import-silly", "migrate-stacks", "ui"];
				return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			const first = parts[0];
			if (["use", "preview", "validate"].includes(first)) {
				const fragment = parts[1] ?? "";
				const ids = ["none", ...stacks.map((loaded) => loaded.stack.id)];
				return ids.filter((id) => id.startsWith(fragment)).map((id) => ({ value: `${first} ${id}`, label: id }));
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

		lines.push("", "Commands:", "  /preset use <id|none>", "  /preset preview [id]", "  /preset validate [id]", "  /preset diagnostics", "  /preset reload", "  /preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]", "  /preset ui [stop|restart]");
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
			const source = messages.messageSources[index];
			return previewSection(`message-${index}`, previewMessageTitle(source, index), content, message.role);
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
			renderPreviewSectionText(messageSections),
			"",
			"## Diagnostics",
			"",
			renderDiagnostics(diagnostics),
		].join("\n");

		return { text, preview, diagnostics };
	}

	function previewMessageTitle(source: CompileMessageSource | undefined, index: number): string {
		if (source?.kind === "stack-item") {
			return source.itemName?.trim() || source.itemId || `Stack item ${index + 1}`;
		}
		if (source?.kind === "chat-history") {
			const label = source.itemName?.trim() || "Chat history";
			return `${label} #${source.historyIndex ?? index + 1}`;
		}
		if (source?.kind === "implicit-history") {
			return `Conversation history #${source.historyIndex ?? index + 1}`;
		}
		return `Message ${index + 1}`;
	}

	function renderPreviewSectionText(sections: WebEditorPreviewSection[], maxChars = 8000): string {
		let text = "";
		for (const section of sections) {
			const role = section.role ? ` (${section.role})` : "";
			text += `\n--- ${section.title}${role} ---\n`;
			text += section.content;
			text += "\n";
			if (text.length > maxChars) return `${text.slice(0, maxChars)}\n\n[preview truncated]`;
		}
		return text.trimStart();
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
