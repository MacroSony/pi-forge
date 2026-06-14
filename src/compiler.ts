import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompileMessagesResult,
	CompileSystemPromptResult,
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
	PromptStackRole,
	PromptStackSlotItem,
	PromptStateScope,
	PromptStateValue,
	PromptVariableStore,
} from "./types.ts";
import { SUPPORTED_SLOTS } from "./types.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createPromptVariableStore(sessionVariables: Record<string, PromptStateValue> = {}): PromptVariableStore {
	return { turn: {}, session: { ...sessionVariables }, sessionDirty: false };
}

export function resetTurnVariables(store: PromptVariableStore): void {
	store.turn = {};
	store.sessionDirty = false;
}

export function markSessionVariablesClean(store: PromptVariableStore): void {
	store.sessionDirty = false;
}

export function compileSystemPrompt(
	stack: PromptStack,
	runtime: PromptRuntime,
	baseSystemPrompt: string,
): CompileSystemPromptResult {
	const diagnostics: PromptStackDiagnostic[] = [];
	const parts: string[] = [];

	for (const item of enabledItems(stack)) {
		if (item.role !== "system") continue;

		if (item.kind === "block") {
			const text = expandMacros(item.content, stack, runtime, diagnostics, item.id).trim();
			if (text) parts.push(text);
			continue;
		}

		if (item.slot === "chat-history") {
			diagnostics.push({ level: "warning", message: "chat-history slot cannot be placed in the system prompt.", itemId: item.id });
			continue;
		}

		const rendered = renderSlotText(item, stack, runtime, diagnostics).trim();
		if (rendered) parts.push(rendered);
	}

	const compiled = parts.join("\n\n");
	const mode = stack.mode ?? "replace";

	if (!compiled) {
		diagnostics.push({ level: "warning", message: "Compiled system prompt is empty; preserving base system prompt." });
		return { systemPrompt: baseSystemPrompt, diagnostics };
	}

	if (mode === "append") {
		return { systemPrompt: compiled ? `${baseSystemPrompt}\n\n${compiled}` : baseSystemPrompt, diagnostics };
	}

	if (mode === "prepend") {
		return { systemPrompt: compiled ? `${compiled}\n\n${baseSystemPrompt}` : baseSystemPrompt, diagnostics };
	}

	return { systemPrompt: compiled, diagnostics };
}

export function compileMessages(
	stack: PromptStack,
	runtime: PromptRuntime,
	originalMessages: AgentMessage[],
): CompileMessagesResult {
	const diagnostics: PromptStackDiagnostic[] = [];
	const messages: AgentMessage[] = [];
	let insertedHistory = false;

	for (const item of enabledItems(stack)) {
		if (item.kind === "slot" && item.slot === "chat-history") {
			if (insertedHistory && !stack.context?.allowDuplicateChatHistory) {
				diagnostics.push({
					level: "warning",
					message: "Skipped duplicate chat-history slot.",
					itemId: item.id,
				});
				continue;
			}
			messages.push(...getChatHistoryMessages(originalMessages, item));
			insertedHistory = true;
			continue;
		}

		if (!item.role || item.role === "system") continue;

		const content = item.kind === "block"
			? expandMacros(item.content, stack, runtime, diagnostics, item.id)
			: renderSlotText(item, stack, runtime, diagnostics);

		if (!content.trim()) continue;
		messages.push(createSyntheticMessage(item.role, content, stack, runtime));
	}

	if (!insertedHistory) {
		messages.push(...originalMessages);
	}

	return { messages, diagnostics };
}

export function getLatestUserMessage(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user") {
			const text = contentToText((message as { content?: unknown }).content);
			if (text.trim()) return text;
		}
	}
	return undefined;
}

export function renderPreviewMessages(messages: AgentMessage[], maxChars = 8000): string {
	let text = "";
	for (const message of messages) {
		const role = message.role;
		text += `\n--- ${role} ---\n`;
		text += contentToText((message as { content?: unknown; summary?: string; command?: string; output?: string }).content);
		if (role === "bashExecution") {
			const bash = message as { command?: string; output?: string };
			text += `Ran ${bash.command ?? ""}\n${bash.output ?? ""}`;
		}
		if (role === "branchSummary" || role === "compactionSummary") {
			text += (message as { summary?: string }).summary ?? "";
		}
		text += "\n";
		if (text.length > maxChars) return `${text.slice(0, maxChars)}\n\n[preview truncated]`;
	}
	return text.trimStart();
}

function getChatHistoryMessages(messages: AgentMessage[], item: PromptStackSlotItem): AgentMessage[] {
	if (item.options?.includeLastUserMessage !== false) return messages;

	const lastUserIndex = findLastUserMessageIndex(messages);
	if (lastUserIndex === -1) return messages;

	return messages.filter((_message, index) => index !== lastUserIndex);
}

function findLastUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

function enabledItems(stack: PromptStack): PromptStackItem[] {
	return stack.items.filter((item) => item.enabled !== false);
}

function renderSlotText(
	item: PromptStackSlotItem,
	stack: PromptStack,
	runtime: PromptRuntime,
	diagnostics: PromptStackDiagnostic[],
): string {
	const slot = item.slot;

	if (!SUPPORTED_SLOTS.has(slot as any)) {
		diagnostics.push({ level: "warning", message: `Unsupported slot: ${slot}`, itemId: item.id });
		return "";
	}

	switch (slot) {
		case "tools":
			return renderTools(runtime);
		case "tool-guidelines":
			return renderToolGuidelines(runtime);
		case "skills":
			return renderSkills(runtime);
		case "project-context":
			return renderProjectContext(runtime);
		case "append-system-prompt":
			return runtime.options.appendSystemPrompt ?? "";
		case "date":
			return `Current date: ${formatDate(runtime.now)}`;
		case "cwd":
			return `Current working directory: ${runtime.options.cwd.replace(/\\/g, "/")}`;
		case "date-cwd":
			return [`Current date: ${formatDate(runtime.now)}`, `Current working directory: ${runtime.options.cwd.replace(/\\/g, "/")}`].join("\n");
		case "active-model": {
			const model = runtime.ctx?.model;
			return model ? `Current model: ${model.provider}/${model.id}` : "Current model: (none)";
		}
		case "pi-docs":
			return renderPiDocsGuidance();
		case "variables":
			return renderVariables(item, stack, runtime);
		case "chat-history":
			return "";
		default:
			return "";
	}
}

function renderTools(runtime: PromptRuntime): string {
	const tools = runtime.options.selectedTools ?? [];
	const snippets = runtime.options.toolSnippets ?? {};
	const lines = ["<available_tools>"];

	if (tools.length === 0) {
		lines.push("  (none)");
	} else {
		for (const name of tools) {
			const snippet = snippets[name] ?? "No prompt snippet provided.";
			lines.push(`  <tool name=\"${escapeXml(name)}\">${escapeXml(snippet)}</tool>`);
		}
	}

	lines.push("</available_tools>");
	return lines.join("\n");
}

function renderToolGuidelines(runtime: PromptRuntime): string {
	const tools = runtime.options.selectedTools ?? [];
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const add = (line: string) => {
		const normalized = line.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		guidelines.push(normalized);
	};

	if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
		add("Use bash for file operations like ls, rg, find.");
	}

	for (const guideline of runtime.options.promptGuidelines ?? []) add(guideline);

	if (guidelines.length === 0) return "";
	return ["<tool_guidelines>", ...guidelines.map((line) => `- ${line}`), "</tool_guidelines>"].join("\n");
}

function renderSkills(runtime: PromptRuntime): string {
	const skills = (runtime.options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function renderProjectContext(runtime: PromptRuntime): string {
	const contextFiles = runtime.options.contextFiles ?? [];
	if (contextFiles.length === 0) return "";

	const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
	for (const file of contextFiles) {
		lines.push(`<project_instructions path=\"${escapeXml(file.path)}\">`);
		lines.push(file.content);
		lines.push("</project_instructions>", "");
	}
	lines.push("</project_context>");
	return lines.join("\n");
}

function renderPiDocsGuidance(): string {
	return [
		"Pi documentation guidance:",
		"- Read Pi documentation only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI.",
		"- Resolve docs/... against Pi's installed documentation directory and examples/... against Pi's installed examples directory.",
	].join("\n");
}

function renderVariables(
	item: PromptStackSlotItem,
	stack: PromptStack,
	runtime: PromptRuntime,
): string {
	const options = item.options ?? {};
	const scopes = selectedVariableScopes(options);
	const includeMetadata = options.includeMetadata === true;
	const format = options.format === "json" ? "json" : "xml";
	const includeNamespaces = normalizeStringArray(options.includeNamespaces);
	const excludeNamespaces = normalizeStringArray(options.excludeNamespaces);
	const maxValueChars = typeof options.maxValueChars === "number" && Number.isFinite(options.maxValueChars) && options.maxValueChars > 0
		? Math.floor(options.maxValueChars)
		: undefined;
	const store = runtime.variables;
	const grouped: Record<PromptStateScope, Record<string, PromptStateValue>> = {
		static: {},
		session: {},
		turn: {},
	};

	if (scopes.has("static")) {
		grouped.static = collectStaticVariables(stack);
	}
	if (scopes.has("session")) {
		grouped.session = { ...collectDefaultVariables(stack, "session"), ...(store?.session ?? {}) };
	}
	if (scopes.has("turn")) {
		grouped.turn = { ...collectDefaultVariables(stack, "turn"), ...(store?.turn ?? {}) };
	}

	for (const scope of ["static", "session", "turn"] as const) {
		grouped[scope] = Object.fromEntries(
			Object.entries(grouped[scope]).filter(([name]) => shouldRenderVariable(name, includeNamespaces, excludeNamespaces)),
		);
	}

	if (!Object.values(grouped).some((values) => Object.keys(values).length > 0)) return "";

	if (format === "json") {
		const payload: Record<string, unknown> = {};
		for (const scope of ["static", "session", "turn"] as const) {
			if (Object.keys(grouped[scope]).length === 0) continue;
			payload[scope] = includeMetadata
				? Object.fromEntries(Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [
					name,
					{
						value,
						...metadataForVariable(stack, name),
					},
				]))
				: Object.fromEntries(Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b)));
		}
		return `<prompt_state format=\"json\">\n${escapeXml(JSON.stringify(payload, null, 2))}\n</prompt_state>`;
	}

	const parts: string[] = ["<prompt_state>"];

	for (const scope of ["static", "session", "turn"] as const) {
		const entries = Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) continue;
		parts.push(`  <${scope}>`);
		for (const [name, value] of entries) {
			const metadata = includeMetadata ? metadataForVariable(stack, name) : {};
			const attrs = [
				`name=\"${escapeXml(name)}\"`,
				`type=\"${escapeXml(metadata.type ?? inferStateValueType(value))}\"`,
			];
			if (metadata.description) attrs.push(`description=\"${escapeXml(metadata.description)}\"`);
			if (metadata.agentWritable !== undefined) attrs.push(`agentWritable=\"${metadata.agentWritable ? "true" : "false"}\"`);
			if (metadata.userWritable !== undefined) attrs.push(`userWritable=\"${metadata.userWritable ? "true" : "false"}\"`);
			parts.push(`    <var ${attrs.join(" ")}>${escapeXml(truncateValue(stateValueToPromptText(value), maxValueChars))}</var>`);
		}
		parts.push(`  </${scope}>`);
	}

	parts.push("</prompt_state>");
	return parts.join("\n");
}

function selectedVariableScopes(options: Record<string, unknown>): Set<PromptStateScope> {
	const explicit = normalizeStringArray(options.includeScopes).filter(isStateScope);
	if (explicit.length > 0) return new Set(explicit);

	const scopes = new Set<PromptStateScope>();
	if (options.includeStatic !== false) scopes.add("static");
	if (options.includeSession !== false) scopes.add("session");
	if (options.includeTurn !== false) scopes.add("turn");
	return scopes;
}

function collectStaticVariables(stack: PromptStack): Record<string, PromptStateValue> {
	return {
		...collectDefaultVariables(stack, "static"),
		...(stack.variables ?? {}),
	};
}

function collectDefaultVariables(stack: PromptStack, scope: PromptStateScope): Record<string, PromptStateValue> {
	const values: Record<string, PromptStateValue> = {};
	for (const [name, definition] of Object.entries(stack.state?.definitions ?? {})) {
		if ((definition.scope ?? "session") !== scope) continue;
		if (definition.default !== undefined) values[name] = definition.default;
	}
	return values;
}

function shouldRenderVariable(name: string, includePatterns: string[], excludePatterns: string[]): boolean {
	if (includePatterns.length > 0 && !includePatterns.some((pattern) => matchesNamespace(name, pattern))) return false;
	if (excludePatterns.some((pattern) => matchesNamespace(name, pattern))) return false;
	return true;
}

function matchesNamespace(name: string, pattern: string): boolean {
	if (!pattern) return false;
	if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
	return name === pattern;
}

function metadataForVariable(stack: PromptStack, name: string): {
	type?: string;
	description?: string;
	agentWritable?: boolean;
	userWritable?: boolean;
} {
	const definition = stack.state?.definitions?.[name];
	if (!definition) return {};
	return {
		type: definition.type,
		description: definition.description,
		agentWritable: definition.agentWritable,
		userWritable: definition.userWritable,
	};
}

function normalizeStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isStateScope(value: string): value is PromptStateScope {
	return value === "static" || value === "session" || value === "turn";
}

function inferStateValueType(value: PromptStateValue): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function truncateValue(value: string, maxChars: number | undefined): string {
	if (!maxChars || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n[truncated]`;
}

function stateValueToPromptText(value: PromptStateValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function stateValueToMacroText(value: PromptStateValue | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function expandMacros(
	text: string,
	stack: PromptStack,
	runtime: PromptRuntime,
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): string {
	const policy = stack.defaults?.unresolvedMacroPolicy ?? "warn";
	const unknown = new Set<string>();

	const result = text.replace(/\{\{([^{}]+)\}\}/g, (full, rawName: string) => {
		const expression = rawName.trim();
		const parts = expression.split("::");
		const command = parts[0]?.trim();

		if (!command) return full;

		// SillyTavern-style mutable variables. By default, setvar is turn-scoped and returns empty text.
		if (command === "setvar" || command === "setturnvar" || command === "setsessionvar") {
			const scoped = command === "setvar" && (parts[1] === "turn" || parts[1] === "session");
			const scope = command === "setsessionvar" || (scoped && parts[1] === "session") ? "session" : "turn";
			const nameIndex = scoped ? 2 : 1;
			const valueIndex = nameIndex + 1;
			const name = parts[nameIndex]?.trim();
			const value = parts.slice(valueIndex).join("::");
			if (!name) {
				unknown.add(expression);
				return full;
			}
			setRuntimeVariable(runtime, scope, name, value);
			return "";
		}

		if (command === "getvar" || command === "var" || command === "getturnvar" || command === "getsessionvar") {
			const name = parts[1]?.trim();
			if (!name) {
				unknown.add(expression);
				return full;
			}
			if (command === "getturnvar") return stateValueToMacroText(runtime.variables?.turn[name]);
			if (command === "getsessionvar") return stateValueToMacroText(runtime.variables?.session[name]);
			return stateValueToMacroText(getRuntimeVariable(runtime, stack, name));
		}

		if (command === "clearvar" || command === "clearturnvar" || command === "clearsessionvar") {
			const scoped = command === "clearvar" && (parts[1] === "turn" || parts[1] === "session");
			const scope = command === "clearsessionvar" || (scoped && parts[1] === "session") ? "session" : "turn";
			const name = parts[scoped ? 2 : 1]?.trim();
			if (!name) {
				unknown.add(expression);
				return full;
			}
			clearRuntimeVariable(runtime, scope, name);
			return "";
		}

		const dynamicValue = getBuiltinMacro(command, runtime);
		if (dynamicValue !== undefined) return dynamicValue;

		const variableValue = getRuntimeVariable(runtime, stack, command);
		if (variableValue !== undefined) return stateValueToMacroText(variableValue);

		unknown.add(expression);
		return full;
	});

	for (const name of unknown) {
		if (policy === "keep") continue;
		diagnostics.push({
			level: policy === "error" ? "error" : "warning",
			message: `Unresolved macro: {{${name}}}`,
			itemId,
		});
	}

	return result;
}

function getBuiltinMacro(name: string, runtime: PromptRuntime): string | undefined {
	switch (name) {
		case "cwd":
			return runtime.options.cwd;
		case "date":
			return formatDate(runtime.now);
		case "time":
			return formatTime(runtime.now);
		case "lastUserMessage":
			return runtime.latestUserMessage ?? "";
		case "selectedTools":
		case "tools":
			return (runtime.options.selectedTools ?? []).join(", ");
		case "activeModel": {
			const model = runtime.ctx?.model;
			return model ? `${model.provider}/${model.id}` : "";
		}
		default:
			return undefined;
	}
}

function getRuntimeVariable(runtime: PromptRuntime, stack: PromptStack, name: string): PromptStateValue | undefined {
	if (runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.turn, name)) return runtime.variables.turn[name];
	if (runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.session, name)) return runtime.variables.session[name];
	const staticVariables = collectStaticVariables(stack);
	if (Object.prototype.hasOwnProperty.call(staticVariables, name)) return staticVariables[name];
	return undefined;
}

function setRuntimeVariable(runtime: PromptRuntime, scope: "turn" | "session", name: string, value: string): void {
	if (!runtime.variables) return;
	if (scope === "session") {
		if (runtime.variables.session[name] !== value) {
			runtime.variables.session[name] = value;
			runtime.variables.sessionDirty = true;
		}
		return;
	}
	runtime.variables.turn[name] = value;
}

function clearRuntimeVariable(runtime: PromptRuntime, scope: "turn" | "session", name: string): void {
	if (!runtime.variables) return;
	if (scope === "session") {
		if (Object.prototype.hasOwnProperty.call(runtime.variables.session, name)) {
			delete runtime.variables.session[name];
			runtime.variables.sessionDirty = true;
		}
		return;
	}
	delete runtime.variables.turn[name];
}

function createSyntheticMessage(role: Exclude<PromptStackRole, "system">, content: string, stack: PromptStack, runtime: PromptRuntime): AgentMessage {
	const timestamp = runtime.now.getTime();
	const visible = stack.defaults?.syntheticMessagesVisible ?? false;

	if (role === "custom") {
		return {
			role: "custom",
			customType: "pi-forge",
			content: [{ type: "text", text: content }],
			display: visible,
			details: { stackId: stack.id },
			timestamp,
		} as AgentMessage;
	}

	if (role === "assistant") {
		const model = runtime.ctx?.model;
		return {
			role: "assistant",
			content: [{ type: "text", text: content }],
			api: model?.api ?? "unknown",
			provider: model?.provider ?? "unknown",
			model: model?.id ?? "unknown",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp,
		} as AgentMessage;
	}

	return {
		role: "user",
		content: [{ type: "text", text: content }],
		timestamp,
	} as AgentMessage;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const obj = part as Record<string, unknown>;
			if (obj.type === "text" && typeof obj.text === "string") return obj.text;
			if (obj.type === "thinking" && typeof obj.thinking === "string") return `<thinking>\n${obj.thinking}\n</thinking>`;
			if (obj.type === "toolCall") return `[toolCall: ${String(obj.name ?? "unknown")}]`;
			if (obj.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatTime(now: Date): string {
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
