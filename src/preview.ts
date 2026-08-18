import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentMessageToPreviewText,
	getLatestUserMessage,
	PromptCompilationContext,
} from "./compiler.ts";
import { estimatePayloadTokens } from "./payload-capture.ts";
import type { CompileMessageSource, LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "./web-editor/index.ts";

export function renderPreview(
	ctx: ExtensionCommandContext,
	target: LoadedPromptStack,
): string {
	return buildPreview(ctx, target, ctx.getSystemPromptOptions()).text;
}

export function buildPreview(
	ctx: ExtensionContext,
	target: LoadedPromptStack,
	options: BuildSystemPromptOptions,
): { text: string; preview: WebEditorPreview; diagnostics: PromptStackDiagnostic[] } {
	const sessionMessages = getPreviewSessionMessages(ctx);
	const latestUserMessage = getLatestUserMessage(sessionMessages);
	const runtime = { options, ctx, latestUserMessage, now: new Date() };
	const compilation = new PromptCompilationContext(target.stack, runtime);
	const system = compilation.compileSystemPrompt(ctx.getSystemPrompt());
	const messages = compilation.compileMessages(sessionMessages);
	const diagnostics = [...target.diagnostics, ...system.diagnostics, ...messages.diagnostics];
	for (const rule of target.stack.regex?.rules ?? []) {
		if (rule.effect === "finalize" && rule.enabled !== false) {
			diagnostics.push({
				level: "info",
				message: "finalize regex rules are not represented in preview.",
			});
		}
	}
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

interface SessionEntryLike {
	id?: unknown;
	parentId?: unknown;
	type?: unknown;
	timestamp?: unknown;
	message?: unknown;
	summary?: unknown;
	firstKeptEntryId?: unknown;
	tokensBefore?: unknown;
	fromId?: unknown;
	customType?: unknown;
	content?: unknown;
	display?: unknown;
	details?: unknown;
}

function getPreviewSessionMessages(ctx: ExtensionContext): AgentMessage[] {
	const entries = getCurrentBranchEntries(ctx).map(asSessionEntry);
	const compaction = latestCompactionEntry(entries);
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntryLike): void => {
		if (entry.type === "message" && isAgentMessage(entry.message)) {
			messages.push(entry.message);
			return;
		}
		if (entry.type === "custom_message" && typeof entry.customType === "string") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : "",
				display: entry.display === true,
				details: entry.details,
				timestamp: entryTimestamp(entry),
			} as AgentMessage);
			return;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary) {
			messages.push({
				role: "branchSummary",
				summary: entry.summary,
				fromId: typeof entry.fromId === "string" ? entry.fromId : "",
				timestamp: entryTimestamp(entry),
			} as AgentMessage);
		}
	};

	if (compaction && typeof compaction.summary === "string") {
		messages.push({
			role: "compactionSummary",
			summary: compaction.summary,
			tokensBefore: typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : 0,
			timestamp: entryTimestamp(compaction),
		} as AgentMessage);

		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index++) {
			const entry = entries[index]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(entry);
		}
		for (let index = compactionIndex + 1; index < entries.length; index++) {
			appendMessage(entries[index]!);
		}
		return messages;
	}

	for (const entry of entries) appendMessage(entry);
	return messages;
}

function latestCompactionEntry(entries: SessionEntryLike[]): SessionEntryLike | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "compaction") return entry;
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

function asSessionEntry(value: unknown): SessionEntryLike {
	return value && typeof value === "object" ? value as SessionEntryLike : {};
}

function isAgentMessage(value: unknown): value is AgentMessage {
	return !!value && typeof value === "object" && typeof (value as { role?: unknown }).role === "string";
}

function entryTimestamp(entry: SessionEntryLike): number {
	if (typeof entry.timestamp === "number") return entry.timestamp;
	if (typeof entry.timestamp === "string") {
		const timestamp = new Date(entry.timestamp).getTime();
		if (Number.isFinite(timestamp)) return timestamp;
	}
	return Date.now();
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

export function renderDiagnostics(diagnostics: PromptStackDiagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics.map((d) => `${d.level.toUpperCase()}${d.itemId ? ` [${d.itemId}]` : ""}: ${d.message}`).join("\n");
}

export async function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	if (ctx.hasUI) {
		await ctx.ui.editor(title, text);
		return;
	}
	console.log(text);
}
