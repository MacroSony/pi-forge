import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CompileMessageSource,
	CompileMessagesResult,
	CompileSystemPromptResult,
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
	PromptStackRole,
	PromptStackSlotItem,
	PromptStackSlotFormat,
	PromptVariableValue,
	PromptVariableStore,
} from "./types.ts";
import { applyResourcePolicy } from "./policy.ts";
import { applyRegexRulesToMessages, applyRegexRulesToString } from "./regex.ts";
import { SUPPORTED_SLOTS } from "./types.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type PromptVariableScope = "static" | "session" | "turn";

const SUMMARY_ROLES = new Set(["branchSummary", "compactionSummary"]);

export function createPromptVariableStore(sessionVariables: Record<string, PromptVariableValue> = {}): PromptVariableStore {
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

	let systemPrompt: string;
	if (!compiled) {
		diagnostics.push({ level: "warning", message: "Compiled system prompt is empty; preserving base system prompt." });
		systemPrompt = baseSystemPrompt;
	} else if (mode === "append") {
		systemPrompt = compiled ? `${baseSystemPrompt}\n\n${compiled}` : baseSystemPrompt;
	} else if (mode === "prepend") {
		systemPrompt = compiled ? `${compiled}\n\n${baseSystemPrompt}` : baseSystemPrompt;
	} else {
		systemPrompt = compiled;
	}

	systemPrompt = applyRegexRulesToString(stack, systemPrompt, "compiled", "system", diagnostics);
	return { systemPrompt, diagnostics };
}

export function compileMessages(
	stack: PromptStack,
	runtime: PromptRuntime,
	originalMessages: AgentMessage[],
): CompileMessagesResult {
	const diagnostics: PromptStackDiagnostic[] = [];
	let messages: AgentMessage[] = [];
	let messageSources: CompileMessageSource[] = [];
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
			const historyMessages = getChatHistoryMessages(originalMessages, item, diagnostics);
			const transformedHistory = applyRegexRulesToMessages(stack, historyMessages, "history", diagnostics);
			messages.push(...transformedHistory);
			messageSources.push(...chatHistoryMessageSources(transformedHistory, item));
			insertedHistory = true;
			continue;
		}

		if (!item.role || item.role === "system") continue;

		const content = item.kind === "block"
			? expandMacros(item.content, stack, runtime, diagnostics, item.id)
			: renderSlotText(item, stack, runtime, diagnostics);

		if (!content.trim()) continue;
		const message = createSyntheticMessage(item.role, content, stack, runtime);
		messages.push(message);
		messageSources.push(stackItemMessageSource(message, item));
	}

	if (!insertedHistory) {
		messages.push(...originalMessages);
		messageSources.push(...implicitHistoryMessageSources(originalMessages));
	}

	messages = applyRegexRulesToMessages(stack, messages, "compiled", diagnostics);
	return { messages, messageSources, diagnostics };
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

export function agentMessageToPreviewText(message: AgentMessage): string {
	let text = contentToText((message as { content?: unknown; summary?: string; command?: string; output?: string }).content);
	const role = message.role;
	if (role === "bashExecution") {
		const bash = message as { command?: string; output?: string };
		text += `Ran ${bash.command ?? ""}\n${bash.output ?? ""}`;
	}
	if (role === "branchSummary" || role === "compactionSummary") {
		text += (message as { summary?: string }).summary ?? "";
	}
	return text;
}

function getChatHistoryMessages(
	messages: AgentMessage[],
	item: PromptStackSlotItem,
	diagnostics: PromptStackDiagnostic[],
): AgentMessage[] {
	let result = messages;
	const options = item.options ?? {};
	let shouldRepairToolPairs = false;

	if (options.includeLastUserMessage === false) {
		const lastUserIndex = findLastUserMessageIndex(result);
		if (lastUserIndex !== -1) result = result.filter((_message, index) => index !== lastUserIndex);
	}

	if (options.includeSummaries === false) {
		const next = result.filter((message) => !isSummaryMessage(message));
		addHistoryFilterDiagnostic(diagnostics, item.id, "summary", result.length, next.length);
		result = next;
	}

	if (isStringArray(options.roles) && options.roles.length > 0) {
		const allowedRoles = new Set(options.roles);
		const next = result.filter((message) => allowedRoles.has(messageRole(message)));
		addHistoryFilterDiagnostic(diagnostics, item.id, "role", result.length, next.length);
		result = next;
		shouldRepairToolPairs = true;
	}

	if (options.toolMode === "drop") {
		result = dropToolHistory(result, diagnostics, item.id);
	} else if (options.toolMode !== undefined && options.toolMode !== "keep") {
		diagnostics.push({ level: "warning", message: `Unsupported chat-history toolMode: ${String(options.toolMode)}.`, itemId: item.id });
	}

	if (options.stripAssistantThinking === true) {
		result = stripAssistantThinkingFromHistory(result, diagnostics, item.id);
	}

	const limited = limitChatHistory(result, options, diagnostics, item.id);
	if (limited !== result) {
		result = limited;
		shouldRepairToolPairs = true;
	}

	if (shouldRepairToolPairs && options.toolMode !== "drop") {
		result = repairToolHistory(result, diagnostics, item.id);
	}

	return result;
}

function findLastUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

function limitChatHistory(
	messages: AgentMessage[],
	options: NonNullable<PromptStackSlotItem["options"]>,
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): AgentMessage[] {
	let result = messages;
	const maxMessages = positiveIntegerOption(options.maxMessages);
	const maxChars = positiveIntegerOption(options.maxChars);

	if (maxMessages !== undefined && result.length > maxMessages) {
		const next = result.slice(-maxMessages);
		diagnostics.push({
			level: "info",
			message: `Trimmed chat history from ${result.length} to ${next.length} message(s) by maxMessages.`,
			itemId,
		});
		result = next;
	}

	if (maxChars !== undefined) {
		const next = takeRecentMessagesWithinChars(result, maxChars);
		if (next.length < result.length) {
			diagnostics.push({
				level: "info",
				message: `Trimmed chat history from ${result.length} to ${next.length} message(s) by maxChars.`,
				itemId,
			});
			result = next;
		}
	}

	return result;
}

function takeRecentMessagesWithinChars(messages: AgentMessage[], maxChars: number): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let chars = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		const messageChars = agentMessageToPreviewText(message).length;
		if (selected.length > 0 && chars + messageChars > maxChars) break;
		selected.push(message);
		chars += messageChars;
	}
	return selected.reverse();
}

function addHistoryFilterDiagnostic(
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
	filter: string,
	before: number,
	after: number,
): void {
	if (before === after) return;
	diagnostics.push({
		level: "info",
		message: `Filtered ${before - after} chat-history message(s) by ${filter}.`,
		itemId,
	});
}

function dropToolHistory(
	messages: AgentMessage[],
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): AgentMessage[] {
	let removedToolCalls = 0;
	let droppedToolResults = 0;
	let droppedEmptyMessages = 0;
	let changed = false;
	const result: AgentMessage[] = [];

	for (const message of messages) {
		if (isToolResultMessage(message)) {
			droppedToolResults++;
			changed = true;
			continue;
		}
		const stripped = stripToolCallParts(message, () => false);
		removedToolCalls += stripped.removedCalls;
		if (stripped.message !== message) changed = true;
		if (!stripped.message) {
			droppedEmptyMessages++;
			continue;
		}
		result.push(stripped.message);
	}

	if (!changed) return messages;
	diagnostics.push({
		level: "info",
		message: `Dropped tool history from chat-history: removed ${removedToolCalls} tool call(s), dropped ${droppedToolResults} tool result message(s)` +
			(droppedEmptyMessages > 0 ? `, and dropped ${droppedEmptyMessages} empty message(s).` : "."),
		itemId,
	});
	return result;
}

function repairToolHistory(
	messages: AgentMessage[],
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): AgentMessage[] {
	const includedCallIds = new Set<string>();
	const includedResultIds = new Set<string>();
	for (const message of messages) {
		for (const id of toolCallIdsForMessage(message)) includedCallIds.add(id);
		const resultId = toolResultMessageId(message);
		if (resultId) includedResultIds.add(resultId);
	}

	let removedToolCalls = 0;
	let droppedToolResults = 0;
	let droppedEmptyMessages = 0;
	let changed = false;
	const result: AgentMessage[] = [];

	for (const message of messages) {
		if (isToolResultMessage(message)) {
			const resultId = toolResultMessageId(message);
			if (!resultId || !includedCallIds.has(resultId)) {
				droppedToolResults++;
				changed = true;
				continue;
			}
			result.push(message);
			continue;
		}

		const stripped = stripToolCallParts(message, (id) => !!id && includedResultIds.has(id));
		removedToolCalls += stripped.removedCalls;
		if (stripped.message !== message) changed = true;
		if (!stripped.message) {
			droppedEmptyMessages++;
			continue;
		}
		result.push(stripped.message);
	}

	if (!changed) return messages;
	diagnostics.push({
		level: "info",
		message: `Repaired tool history after chat-history filtering: removed ${removedToolCalls} dangling tool call(s), dropped ${droppedToolResults} dangling tool result message(s)` +
			(droppedEmptyMessages > 0 ? `, and dropped ${droppedEmptyMessages} empty message(s).` : "."),
		itemId,
	});
	return result;
}

function stripToolCallParts(
	message: AgentMessage,
	keep: (id: string | undefined) => boolean,
): { message?: AgentMessage; removedCalls: number } {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message, removedCalls: 0 };

	const nextContent = content.filter((part) => !isToolCallContent(part) || keep(toolCallPartId(part)));
	const removedCalls = content.length - nextContent.length;
	if (removedCalls === 0) return { message, removedCalls: 0 };
	if (nextContent.length === 0) return { removedCalls };
	return { message: { ...message, content: nextContent } as AgentMessage, removedCalls };
}

function toolCallIdsForMessage(message: AgentMessage): string[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.map((part) => toolCallPartId(part))
		.filter((id): id is string => !!id);
}

function isToolCallContent(value: unknown): boolean {
	return isPlainObject(value) && value.type === "toolCall";
}

function toolCallPartId(value: unknown): string | undefined {
	if (!isPlainObject(value)) return undefined;
	return firstString(value.id, value.toolCallId, value.callId);
}

function isToolResultMessage(message: AgentMessage): boolean {
	return messageRole(message) === "toolResult";
}

function toolResultMessageId(message: AgentMessage): string | undefined {
	if (!isToolResultMessage(message)) return undefined;
	const raw = message as unknown as Record<string, unknown>;
	return firstString(raw.toolCallId, raw.id, raw.callId);
}

function isSummaryMessage(message: AgentMessage): boolean {
	return SUMMARY_ROLES.has(messageRole(message));
}

function messageRole(message: AgentMessage): string {
	return String((message as { role?: unknown }).role ?? "");
}

function positiveIntegerOption(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function chatHistoryMessageSources(messages: AgentMessage[], item: PromptStackSlotItem): CompileMessageSource[] {
	return messages.map((message, index) => ({
		kind: "chat-history",
		itemId: item.id,
		itemName: item.name,
		slot: item.slot,
		historyIndex: index + 1,
		historyCount: messages.length,
		role: String((message as { role?: unknown }).role ?? ""),
	}));
}

function implicitHistoryMessageSources(messages: AgentMessage[]): CompileMessageSource[] {
	return messages.map((message, index) => ({
		kind: "implicit-history",
		itemName: "Conversation history",
		slot: "chat-history",
		historyIndex: index + 1,
		historyCount: messages.length,
		role: String((message as { role?: unknown }).role ?? ""),
	}));
}

function stackItemMessageSource(message: AgentMessage, item: PromptStackItem): CompileMessageSource {
	return {
		kind: "stack-item",
		itemId: item.id,
		itemName: item.name,
		role: String((message as { role?: unknown }).role ?? ""),
	};
}

function stripAssistantThinkingFromHistory(
	messages: AgentMessage[],
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): AgentMessage[] {
	let strippedBlocks = 0;
	let changedMessages = 0;
	let droppedMessages = 0;
	let changed = false;
	const result: AgentMessage[] = [];

	for (const message of messages) {
		const stripped = stripAssistantThinkingFromMessage(message);
		if (stripped.message !== message) {
			changed = true;
			strippedBlocks += stripped.removedBlocks;
			changedMessages++;
		}
		if (!stripped.message) {
			droppedMessages++;
			continue;
		}
		result.push(stripped.message);
	}

	if (!changed) return messages;

	diagnostics.push({
		level: "info",
		message: `Stripped ${strippedBlocks} assistant thinking block(s) from ${changedMessages} chat-history message(s)` +
			(droppedMessages > 0 ? ` and dropped ${droppedMessages} empty assistant message(s).` : "."),
		itemId,
	});
	return result;
}

function stripAssistantThinkingFromMessage(message: AgentMessage): { message?: AgentMessage; removedBlocks: number } {
	if (message.role !== "assistant") return { message, removedBlocks: 0 };
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message, removedBlocks: 0 };

	const nextContent = content.filter((part) => !isThinkingContent(part));
	const removedBlocks = content.length - nextContent.length;
	if (removedBlocks === 0) return { message, removedBlocks: 0 };
	if (nextContent.length === 0) return { removedBlocks };
	return { message: { ...message, content: nextContent } as AgentMessage, removedBlocks };
}

function isThinkingContent(value: unknown): boolean {
	return !!value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "thinking";
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
			return renderTools(item, stack, runtime);
		case "tool-guidelines":
			return renderToolGuidelines(item, stack, runtime);
		case "skills":
			return renderSkills(item, stack, runtime);
		case "project-context":
			return renderProjectContext(item, runtime);
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

function renderTools(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	const snippets = runtime.options.toolSnippets ?? {};
	const tools = item.options?.onlyWithSnippets === true
		? scopedToolNames(stack, runtime).filter((name) => !!snippets[name])
		: scopedToolNames(stack, runtime);

	if (slotTextFormat(item) === "plain") {
		const lines = ["Available tools:"];
		if (tools.length === 0) {
			lines.push(item.options?.onlyWithSnippets === true ? "(none)" : "- (none)");
		} else {
			for (const name of tools) {
				lines.push(plainBullet(name, snippets[name] ?? "No prompt snippet provided."));
			}
		}
		return lines.join("\n");
	}

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

function renderToolGuidelines(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	const tools = scopedToolNames(stack, runtime);
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const add = (line: string) => {
		const normalized = line.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		guidelines.push(normalized);
	};

	if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
		add(item.options?.piStyle === true ? "Use bash for file operations like ls, rg, find" : "Use bash for file operations like ls, rg, find.");
	}

	for (const guideline of runtime.options.promptGuidelines ?? []) add(guideline);
	if (item.options?.includePiDefaultGuidelines === true) {
		add("Be concise in your responses");
		add("Show file paths clearly when working with files");
	}

	if (guidelines.length === 0) return "";
	if (slotTextFormat(item) === "plain") {
		const heading = typeof item.options?.heading === "string" ? item.options.heading.trim() : "Tool guidelines:";
		return [
			...(heading ? [heading] : []),
			...guidelines.map((line) => `- ${plainContinuation(line, "  ")}`),
		].join("\n");
	}
	return ["<tool_guidelines>", ...guidelines.map((line) => `- ${line}`), "</tool_guidelines>"].join("\n");
}

function renderSkills(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	if (item.options?.requireReadTool === true && !scopedToolNames(stack, runtime).includes("read")) return "";
	const skills = (runtime.options.skills ?? [])
		.filter((skill) => !skill.disableModelInvocation)
		.filter((skill) => applyResourcePolicy([skill.name], stack.skills).length > 0);
	if (skills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
	];

	if (slotTextFormat(item) === "plain") {
		lines.push("Available skills:");
		for (const skill of skills) {
			lines.push(plainBullet(skill.name, skill.description));
			lines.push(`  Location: ${plainContinuation(skill.filePath, "  ")}`);
		}
		return lines.join("\n");
	}

	lines.push("<available_skills>");
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

function scopedToolNames(stack: PromptStack, runtime: PromptRuntime): string[] {
	return applyResourcePolicy(runtime.options.selectedTools ?? [], stack.tools);
}

function renderProjectContext(item: PromptStackSlotItem, runtime: PromptRuntime): string {
	const contextFiles = runtime.options.contextFiles ?? [];
	if (contextFiles.length === 0) return "";

	if (slotTextFormat(item) === "plain") {
		const lines = ["Project context:", "", "Project-specific instructions and guidelines:", ""];
		for (const file of contextFiles) {
			lines.push(`Path: ${file.path}`);
			lines.push(indentPlainBlock(file.content, "  "), "");
		}
		return lines.join("\n").trimEnd();
	}

	const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
	for (const file of contextFiles) {
		lines.push(`<project_instructions path=\"${escapeXml(file.path)}\">`);
		lines.push(file.content);
		lines.push("</project_instructions>", "");
	}
	lines.push("</project_context>");
	return lines.join("\n");
}

function slotTextFormat(item: PromptStackSlotItem, options: { allowJson?: boolean } = {}): PromptStackSlotFormat {
	const format = item.options?.format;
	if (format === "plain") return "plain";
	if (format === "json" && options.allowJson) return "json";
	return "xml";
}

function renderPiDocsGuidance(): string {
	const paths = piDocsPaths();
	return [
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${paths.readme}`,
		`- Additional docs: ${paths.docs}`,
		`- Examples: ${paths.examples} (extensions, custom tools, SDK)`,
		"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
		"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");
}

function piDocsPaths(): { readme: string; docs: string; examples: string } {
	const fallbackRoot = "@earendil-works/pi-coding-agent";
	try {
		const resolve = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
		if (!resolve) throw new Error("import.meta.resolve unavailable");
		const resolved = resolve("@earendil-works/pi-coding-agent");
		if (!resolved.startsWith("file:")) throw new Error("non-file package resolution");
		const packageRoot = dirname(dirname(fileURLToPath(resolved)));
		return {
			readme: join(packageRoot, "README.md"),
			docs: join(packageRoot, "docs"),
			examples: join(packageRoot, "examples"),
		};
	} catch {
		return {
			readme: `${fallbackRoot}/README.md`,
			docs: `${fallbackRoot}/docs`,
			examples: `${fallbackRoot}/examples`,
		};
	}
}

function renderVariables(
	item: PromptStackSlotItem,
	stack: PromptStack,
	runtime: PromptRuntime,
): string {
	const options = item.options ?? {};
	const scopes = selectedVariableScopes(options);
	const format = slotTextFormat(item);
	const store = runtime.variables;
	const grouped: Record<PromptVariableScope, Record<string, PromptVariableValue>> = {
		static: {},
		session: {},
		turn: {},
	};

	if (scopes.includes("static")) grouped.static = collectStaticVariables(stack);
	if (scopes.includes("session")) grouped.session = { ...(store?.session ?? {}) };
	if (scopes.includes("turn")) grouped.turn = { ...(store?.turn ?? {}) };

	const hasVariables = Object.values(grouped).some((values) => Object.keys(values).length > 0);
	if (!hasVariables) return "";

	if (format === "plain") {
		return renderPlainVariables(grouped);
	}

	const parts: string[] = ["<variables>"];

	for (const scope of scopes) {
		const entries = Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) continue;
		parts.push(`  <${scope}>`);
		for (const [name, value] of entries) {
			parts.push(`    <var name=\"${escapeXml(name)}\">${escapeXml(variableValueToPromptText(value))}</var>`);
		}
		parts.push(`  </${scope}>`);
	}

	parts.push("</variables>");
	return parts.join("\n");
}

function renderPlainVariables(
	grouped: Record<PromptVariableScope, Record<string, PromptVariableValue>>,
): string {
	const parts: string[] = ["Variables:"];

	for (const scope of ["static", "session", "turn"] as const) {
		const entries = Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) continue;
		parts.push(`${scope}:`);
		for (const [name, value] of entries) {
			parts.push(plainBullet(name, variableValueToPromptText(value)));
		}
	}

	return parts.join("\n");
}

function plainBullet(label: string, value: string): string {
	return `- ${label}: ${plainContinuation(value, "  ")}`;
}

function plainContinuation(value: string, indent: string): string {
	return value.split("\n").map((line, index) => index === 0 ? line : `${indent}${line}`).join("\n");
}

function indentPlainBlock(value: string, indent: string): string {
	return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function selectedVariableScopes(options: Record<string, unknown>): PromptVariableScope[] {
	const scopes: PromptVariableScope[] = [];
	if (options.includeStatic !== false) scopes.push("static");
	if (options.includeSession !== false) scopes.push("session");
	if (options.includeTurn !== false) scopes.push("turn");
	return scopes;
}

function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue> {
	return { ...(stack.variables ?? {}) };
}

function variableValueToPromptText(value: PromptVariableValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function variableValueToMacroText(value: PromptVariableValue | undefined): string {
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
			if (command === "getturnvar") return variableValueToMacroText(runtime.variables?.turn[name]);
			if (command === "getsessionvar") return variableValueToMacroText(runtime.variables?.session[name]);
			return variableValueToMacroText(getRuntimeVariable(runtime, stack, name));
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

		const dynamicValue = getBuiltinMacro(command, stack, runtime);
		if (dynamicValue !== undefined) return dynamicValue;

		const variableValue = getRuntimeVariable(runtime, stack, command);
		if (variableValue !== undefined) return variableValueToMacroText(variableValue);

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

function getBuiltinMacro(name: string, stack: PromptStack, runtime: PromptRuntime): string | undefined {
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
			return scopedToolNames(stack, runtime).join(", ");
		case "activeModel": {
			const model = runtime.ctx?.model;
			return model ? `${model.provider}/${model.id}` : "";
		}
		default:
			return undefined;
	}
}

function getRuntimeVariable(runtime: PromptRuntime, stack: PromptStack, name: string): PromptVariableValue | undefined {
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
