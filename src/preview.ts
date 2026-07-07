import { buildSessionContext, type BuildSystemPromptOptions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	agentMessageToPreviewText,
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
	getLatestUserMessage,
} from "./compiler.ts";
import { estimatePayloadTokens } from "./payload-capture.ts";
import type { CompileMessageSource, LoadedPromptStack, PromptStackDiagnostic, PromptVariableValue } from "./types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "./web-editor/index.ts";

export function renderPreview(
	ctx: ExtensionCommandContext,
	target: LoadedPromptStack,
	sessionVariables: Record<string, PromptVariableValue>,
): string {
	return buildPreview(ctx, target, sessionVariables).text;
}

export function buildPreview(
	ctx: ExtensionCommandContext,
	target: LoadedPromptStack,
	sessionVariables: Record<string, PromptVariableValue>,
	optionsOverride?: BuildSystemPromptOptions,
): { text: string; preview: WebEditorPreview; diagnostics: PromptStackDiagnostic[] } {
	const options = optionsOverride ?? ctx.getSystemPromptOptions();
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
