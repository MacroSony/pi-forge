import { buildSessionContext, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
	getLatestUserMessage,
	markSessionVariablesClean,
	renderPreviewMessages,
	resetTurnVariables,
} from "./compiler.ts";
import { chooseDefaultStack, loadPromptStacks, promptStacksDir } from "./loader.ts";
import type { LoadedPromptStack, PromptStackDiagnostic, PromptVariableStore } from "./types.ts";

const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";

export default function piForge(pi: ExtensionAPI) {
	let stacks: LoadedPromptStack[] = [];
	let active: LoadedPromptStack | undefined;
	let currentSystemPromptOptions: BuildSystemPromptOptions | undefined;
	let currentLatestUserMessage: string | undefined;
	let currentVariableStore: PromptVariableStore | undefined;
	let sessionVariables: Record<string, string> = {};
	let lastPersistedActiveId: string | undefined;
	let interceptNextProviderPayload = false;

	function activeId(): string | undefined {
		return active?.stack.id;
	}

	function setActive(id: string | undefined, ctx?: ExtensionContext): boolean {
		if (!id || id === "none" || id === "off") {
			active = undefined;
			if (ctx) updateStatus(ctx);
			return true;
		}

		const found = stacks.find((candidate) => candidate.stack.id === id);
		if (!found) return false;
		active = found;
		if (ctx) updateStatus(ctx);
		return true;
	}

	function reloadStacks(ctx: ExtensionContext, preferredId?: string): void {
		if (!ctx.isProjectTrusted()) {
			stacks = [];
			active = undefined;
			ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
			updateStatus(ctx);
			return;
		}

		stacks = loadPromptStacks(ctx.cwd);
		active = chooseDefaultStack(stacks, preferredId);
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (active) {
			ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", `stack:${active.stack.id}`));
		} else {
			ctx.ui.setStatus("pi-forge", undefined);
		}
	}

	function getRestoredActiveId(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { activeStackId?: unknown } };
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
				return typeof entry.data?.activeStackId === "string" ? entry.data.activeStackId : undefined;
			}
		}
		return undefined;
	}

	function getRestoredVariables(ctx: ExtensionContext): Record<string, string> {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { variables?: unknown } };
			if (entry.type !== "custom" || entry.customType !== VARIABLE_ENTRY_TYPE) continue;
			if (!entry.data || typeof entry.data.variables !== "object" || Array.isArray(entry.data.variables)) return {};
			return normalizeStringRecord(entry.data.variables as Record<string, unknown>);
		}
		return {};
	}

	function persistVariablesIfDirty(store: PromptVariableStore | undefined): void {
		if (!store?.sessionDirty) return;
		sessionVariables = { ...store.session };
		pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: sessionVariables });
		markSessionVariablesClean(store);
	}

	function normalizeStringRecord(value: Record<string, unknown>): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [key, raw] of Object.entries(value)) {
			if (typeof raw === "string") result[key] = raw;
		}
		return result;
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionVariables = getRestoredVariables(ctx);
		currentVariableStore = undefined;
		reloadStacks(ctx, getRestoredActiveId(ctx));
		if (active) {
			const errorCount = active.diagnostics.filter((d) => d.level === "error").length;
			const warningCount = active.diagnostics.filter((d) => d.level === "warning").length;
			const suffix = errorCount || warningCount ? ` (${errorCount} errors, ${warningCount} warnings)` : "";
			ctx.ui.notify(`pi-forge: active prompt stack ${active.stack.id}${suffix}`, errorCount ? "error" : "info");
		}
	});

	pi.on("turn_start", async () => {
		const id = activeId();
		if (id && id !== lastPersistedActiveId) {
			pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: id });
			lastPersistedActiveId = id;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentSystemPromptOptions = event.systemPromptOptions;
		currentLatestUserMessage = event.prompt;
		currentVariableStore = createPromptVariableStore(sessionVariables);
		resetTurnVariables(currentVariableStore);

		if (!active) return;

		const result = compileSystemPrompt(
			active.stack,
			{ options: event.systemPromptOptions, ctx, latestUserMessage: event.prompt, now: new Date(), variables: currentVariableStore },
			event.systemPrompt,
		);
		persistVariablesIfDirty(currentVariableStore);

		return { systemPrompt: result.systemPrompt };
	});

	pi.on("context", async (event, ctx) => {
		if (!active || !currentSystemPromptOptions) return;

		if (!currentVariableStore) currentVariableStore = createPromptVariableStore(sessionVariables);
		const latestUserMessage = getLatestUserMessage(event.messages) ?? currentLatestUserMessage;
		const result = compileMessages(
			active.stack,
			{ options: currentSystemPromptOptions, ctx, latestUserMessage, now: new Date(), variables: currentVariableStore },
			event.messages,
		);
		persistVariablesIfDirty(currentVariableStore);
		return { messages: result.messages };
	});

	pi.on("agent_end", async () => {
		persistVariablesIfDirty(currentVariableStore);
		currentSystemPromptOptions = undefined;
		currentLatestUserMessage = undefined;
		currentVariableStore = undefined;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!interceptNextProviderPayload) return;
		interceptNextProviderPayload = false;
		ctx.ui.setStatus("pi-forge-intercept", undefined);

		const payload = safeStringify(event.payload);
		if (ctx.hasUI) {
			await ctx.ui.editor("pi-forge: provider payload", payload);
			return;
		}

		console.log(payload);
	});

	pi.registerCommand("intercept", {
		description: "Display the next provider payload before it is sent",
		handler: async (_args, ctx) => {
			interceptNextProviderPayload = true;
			ctx.ui.setStatus("pi-forge-intercept", ctx.ui.theme.fg("warning", "intercept:armed"));
			ctx.ui.notify("pi-forge: next provider payload will be displayed before sending.", "info");
		},
	});

	pi.registerCommand("preset", {
		description: "Manage pi-forge prompt stacks: list, use, preview, validate, reload, vars",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				const commands = ["list", "use", "preview", "validate", "reload", "status", "vars"];
				return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			const first = parts[0];
			if (["use", "preview", "validate"].includes(first)) {
				const fragment = parts[1] ?? "";
				const ids = ["none", ...stacks.map((loaded) => loaded.stack.id)];
				return ids.filter((id) => id.startsWith(fragment)).map((id) => ({ value: id, label: id }));
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
				reloadStacks(ctx, activeId());
				ctx.ui.notify(`pi-forge: reloaded ${stacks.length} prompt stack(s).`, "info");
				return;

			case "vars": {
				if (rest[0] === "clear") {
					const name = rest[1];
					if (name) delete sessionVariables[name];
					else sessionVariables = {};
					currentVariableStore = createPromptVariableStore(sessionVariables);
					pi.appendEntry(VARIABLE_ENTRY_TYPE, { variables: sessionVariables });
					ctx.ui.notify(name ? `pi-forge: cleared session variable ${name}` : "pi-forge: cleared all session variables", "info");
					return;
				}
				await showText(ctx, "pi-forge variables", renderVariables());
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

			default:
				ctx.ui.notify(`Unknown /preset subcommand: ${command}`, "warning");
				return;
		}
	}

	function renderStackList(ctx: ExtensionCommandContext): string {
		const lines = [
			`Prompt stack directory: ${promptStacksDir(ctx.cwd)}`,
			`Active stack: ${active?.stack.id ?? "(none)"}`,
			"",
		];

		if (stacks.length === 0) {
			lines.push("No prompt stacks found.", "Create .pi/prompt-stacks/default.json to auto-activate a stack.");
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

		lines.push("", "Commands:", "  /preset use <id|none>", "  /preset preview [id]", "  /preset validate [id]", "  /preset reload", "  /preset vars [clear [name]]");
		return lines.join("\n");
	}

	function renderVariables(): string {
		const lines = ["# pi-forge variables", "", "## Session variables", ""];
		const sessionEntries = Object.entries(sessionVariables).sort(([a], [b]) => a.localeCompare(b));
		if (sessionEntries.length === 0) lines.push("(none)");
		else for (const [key, value] of sessionEntries) lines.push(`${key} = ${JSON.stringify(value)}`);

		lines.push("", "## Active stack static variables", "");
		const staticEntries = Object.entries(active?.stack.variables ?? {}).sort(([a], [b]) => a.localeCompare(b));
		if (staticEntries.length === 0) lines.push("(none)");
		else for (const [key, value] of staticEntries) lines.push(`${key} = ${JSON.stringify(value)}`);

		lines.push("", "Turn variables are cleared for each user message and are only visible during prompt compilation.");
		return lines.join("\n");
	}

	function renderPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack): string {
		const options = ctx.getSystemPromptOptions();
		const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const latestUserMessage = getLatestUserMessage(sessionContext.messages);
		const previewVariables = createPromptVariableStore(sessionVariables);
		const runtime = { options, ctx, latestUserMessage, now: new Date(), variables: previewVariables };
		const system = compileSystemPrompt(target.stack, runtime, ctx.getSystemPrompt());
		const messages = compileMessages(target.stack, runtime, sessionContext.messages);
		const diagnostics = [...target.diagnostics, ...system.diagnostics, ...messages.diagnostics];

		return [
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

	function safeStringify(value: unknown): string {
		try {
			return JSON.stringify(value, null, 2);
		} catch (error) {
			return `Failed to stringify provider payload: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
