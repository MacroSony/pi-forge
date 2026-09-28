import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import {
	agentMessageToPreviewText,
	dedupeDiagnostics,
	getLatestUserMessage,
	PromptCompilationContext,
} from "./compiler.ts";
import { estimatePayloadTokens } from "./payload-capture.ts";
import { hashText } from "./context-diff.ts";
import { isTrulyEmptySystemSection, previewSectionText } from "./preview-text.ts";
import { promptRuntimeFromCompileOptions } from "./prompt-runtime.ts";
import {
	getPiBasePrompt,
	projectCapabilityMessages,
	projectPresetSystemPrompt,
} from "./capability-projection.ts";
import { getCurrentBranchEntries, readCapabilitySession } from "./session-adapter.ts";
import { isCapabilityDelivery } from "./capability-protocol.ts";
import { materializeCapabilityAnchors } from "./capability-anchors.ts";
import { reduceCapabilityEvents } from "./capability-events.ts";
import {
	buildSectionInspection,
	createInspectionTracker,
	resolveInspectionScope,
} from "./preview-inspection.ts";
import type { CompileMessageSource, LoadedPromptStack, PromptCompileOptions, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "./web-editor/index.ts";

/**
 * Render preview for a prompt stack against current session context.
 * Evaluates the selected draft against current session capability snapshots without
 * mutating runtime state, applying tool policy, or marking preparation.
 */
export function renderPreview(
	ctx: ExtensionCommandContext,
	target: LoadedPromptStack,
): string {
	return buildPreview(ctx, target, ctx.getSystemPromptOptions()).text;
}

/**
 * Build a structured preview and text rendering for a prompt stack.
 *
 * Evaluates the selected draft against current session capability snapshots:
 * 1. Restores compaction base System and Pi base prompt.
 * 2. Matches live compile -> base projection -> capability projection ordering.
 * 3. Fails closed for active capabilities when project is untrusted.
 * 4. Preserves untouched message provenance and labels synthesized updates.
 * 5. Avoids duplicating leading compiled base between preview.system and preview.messages.
 * 6. Separates actual text from named-section operations and historical tool declarations.
 * Pure and non-mutating: zero persistence, tool sync, or model inference side effects.
 */
export function buildPreview(
	ctx: ExtensionContext,
	target: LoadedPromptStack,
	options: PromptCompileOptions,
): { text: string; preview: WebEditorPreview; diagnostics: PromptStackDiagnostic[] } {
	const sessionMessages = getPreviewSessionMessages(ctx);
	const latestUserMessage = getLatestUserMessage(sessionMessages);
	const runtime = promptRuntimeFromCompileOptions(
		options,
		ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
		latestUserMessage,
	);
	const compilation = new PromptCompilationContext(target.stack, runtime);
	const basePrompt = getPiBasePrompt(sessionMessages, ctx.getSystemPrompt());
	const system = compilation.compileSystemPrompt(basePrompt);
	const messages = compilation.compileMessages(sessionMessages);

	const baseProjected = projectPresetSystemPrompt(messages.messages, system.systemPrompt ?? "");
	// Base projection clones every System and may insert one new leading System.
	// Preserve provenance by position here, before capability projection inserts/removes entries.
	// Multiple history slots can output identical message references; track a list per reference
	// so duplicate slots retain their distinct slot instance identities and do not cross-pair.
	const originalMessageSources = new Map<AgentMessage, CompileMessageSource[]>();
	const baseOffset = baseProjected.length - messages.messages.length;
	for (let i = 0; i < messages.messages.length; i++) {
		const msg = baseProjected[i + baseOffset];
		const list = originalMessageSources.get(msg) ?? [];
		list.push(messages.messageSources[i]);
		originalMessageSources.set(msg, list);
	}
	const beforeCapabilityProjection = new Set(baseProjected);
	const history = readCapabilitySession(ctx);
	const trusted = ctx.isProjectTrusted?.() === true;
	const reduced = reduceCapabilityEvents(history.events);
	if (!reduced.ok) {
		throw new Error(`Invalid Forge capability event ${reduced.index}: ${reduced.error}`);
	}
	if (!trusted && reduced.active.length > 0) {
		throw new Error("Active capabilities require a trusted project. Use /capability reset to clear them, or trust the project.");
	}

	const native = (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
	const capabilityUpdates = new Map<AgentMessage, NonNullable<WebEditorPreviewSection["capabilityUpdate"]>>();
	const projected = projectCapabilityMessages(baseProjected, history, native, (message, update) => {
		capabilityUpdates.set(message, update);
	});
	// Match the runtime's untrusted, inactive recovery path without replaying old rules.
	const previewMessages = trusted ? projected.messages : baseProjected.filter(message => !isCapabilityDelivery(message));

	const diagnostics = dedupeDiagnostics([target.diagnostics, system.diagnostics, messages.diagnostics]);
	let hasFinalize = false;
	let hasRequestFrequency = false;
	for (const rule of target.stack.regex?.rules ?? []) {
		if (rule.enabled === false) continue;
		if (rule.effect === "finalize") hasFinalize = true;
		if ((rule.effect ?? "outgoing") === "outgoing" && rule.frequency === "request") hasRequestFrequency = true;
	}
	if (hasFinalize) {
		diagnostics.push({
			level: "info",
			message: "finalize regex rules are not represented in preview.",
		});
	}
	if (hasRequestFrequency) {
		diagnostics.push({
			level: "info",
			message: 'request-frequency regex rules also run on tool-result follow-up requests; only the first request of a turn is previewed.',
		});
	}

	const inspectionTracker = createInspectionTracker();
	const leadingSystem = previewMessages[0]?.role === "system" ? previewMessages[0] as SystemMessage : undefined;
	const systemSection = leadingSystem
		? previewMessageSection(leadingSystem, "system", "System prompt", "system")
		: previewSection("system", "System prompt", "", undefined, "system");
	if (leadingSystem) {
		const capabilityUpdate = capabilityUpdates.get(leadingSystem);
		if (capabilityUpdate) systemSection.capabilityUpdate = capabilityUpdate;
	}
	systemSection.inspection = buildSectionInspection(leadingSystem, "system", inspectionTracker);

	const messagesToDisplay = leadingSystem ? previewMessages.slice(1) : previewMessages;
	const diffKeyOccurrences = new Map<string, number>();
	const messageSections: WebEditorPreviewSection[] = [];
	const sourceUsageCounts = new Map<AgentMessage, number>();
	for (const [index, message] of messagesToDisplay.entries()) {
		const sourceList = originalMessageSources.get(message);
		const usageIndex = sourceUsageCounts.get(message) ?? 0;
		sourceUsageCounts.set(message, usageIndex + 1);
		const source = sourceList ? sourceList[usageIndex] : undefined;
		const isForgeUpdate = !beforeCapabilityProjection.has(message);
		const section = previewMessageSection(message, `message-${index}`, previewMessageTitle(source, index, isForgeUpdate));
		const capabilityUpdate = capabilityUpdates.get(message);
		if (capabilityUpdate) section.capabilityUpdate = capabilityUpdate;
		// Display-only omission: never remove events or mutate the request projection.
		if (isTrulyEmptySystemSection(section)) continue;
		const baseDiffKey = previewMessageDiffKey(source, previewSectionText(section), message.role, isForgeUpdate);
		const occurrence = (diffKeyOccurrences.get(baseDiffKey) ?? 0) + 1;
		diffKeyOccurrences.set(baseDiffKey, occurrence);
		section.diffKey = `${baseDiffKey}:${occurrence}`;

		const scope = resolveInspectionScope(source, message.role, isForgeUpdate);
		section.inspection = buildSectionInspection(message, scope, inspectionTracker);

		messageSections.push(section);
	}

	const totalChars = systemSection.chars + messageSections.reduce((sum, section) => sum + section.chars, 0);
	const preview: WebEditorPreview = {
		stackId: target.stack.id,
		generatedAt: new Date().toISOString(),
		system: systemSection,
		messages: messageSections,
		...(options.selectedTools === undefined ? {} : { selectedTools: [...options.selectedTools] }),
		totalChars,
		approxTokens: totalChars ? estimatePayloadTokens([systemSection, ...messageSections].map(previewSectionText).filter(Boolean).join("\n")) : 0,
	};

	const text = [
		`# Preset preview: ${target.stack.id}`,
		"",
		"## System prompt",
		"",
		previewSectionText(systemSection) || "(No leading system text; any System updates appear in the message layout.)",
		"",
		"## Message layout",
		"",
		renderPreviewSectionText(messageSections),
		"",
		"## Structured metadata (inspection only; not prompt prose)",
		"",
		renderPreviewMetadata(preview),
		"",
		"## Diagnostics",
		"",
		renderDiagnostics(diagnostics),
	].join("\n");

	return { text, preview, diagnostics };
}

/** Keep System body/section values distinct from protocol declarations. */
function previewMessageSection(message: AgentMessage, id: string, title: string, diffKey?: string): WebEditorPreviewSection {
	const system = message.role === "system" ? message as SystemMessage : undefined;
	const section = previewSection(id, title, system ? contentText(system.content) : agentMessageToPreviewText(message), message.role, diffKey);
	if (system?.sections && Object.keys(system.sections).length) section.sections = { ...system.sections };
	if (system && (system.toolsAdded?.length || system.toolsRemoved?.length)) {
		section.toolChanges = {
			added: (system.toolsAdded ?? []).map(tool => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				...(tool.parameters === undefined ? {} : { parameters: structuredClone(tool.parameters) }),
			})),
			removed: (system.toolsRemoved ?? []).map(tool => tool.name),
		};
	}
	const text = previewSectionText(section);
	section.chars = text.length;
	section.approxTokens = text.length ? estimatePayloadTokens(text) : 0;
	return section;
}

function renderPreviewMetadata(preview: WebEditorPreview): string {
	const lines: string[] = [];
	lines.push(preview.selectedTools === undefined
		? "Preview tool selection is unavailable."
		: `Preview tool selection (draft policy + session rules): ${preview.selectedTools.join(", ") || "(none)"}`);
	for (const section of [preview.system, ...preview.messages]) {
		for (const [name, value] of Object.entries(section.sections ?? {})) {
			lines.push(`[${section.id}] ${value === null ? `Removed system prompt section "${name}".` : `Named system section "${name}" (${value.length ? "set" : "set empty"}).`}`);
		}
		if (section.toolChanges) {
			lines.push(`[${section.id}] Historical transcript tool declarations (not current selection): +[${section.toolChanges.added.map(t => t.name).join(", ")}] -[${section.toolChanges.removed.join(", ")}].`);
		}
	}
	return lines.join("\n");
}

function getPreviewSessionMessages(ctx: ExtensionContext): AgentMessage[] {
	const entries = (ctx.sessionManager.getEntries ? ctx.sessionManager.getEntries() : getCurrentBranchEntries(ctx)) as SessionEntry[];
	const leafId = ctx.sessionManager.getLeafId ? ctx.sessionManager.getLeafId() : undefined;
	const projection = buildSessionProjection(entries, leafId);
	return materializeCapabilityAnchors(entries, projection.messages, leafId);
}

function previewMessageTitle(
	source: CompileMessageSource | undefined,
	index: number,
	isForgeUpdate = false,
): string {
	if (isForgeUpdate) {
		return "Forge capability update";
	}
	if (source?.kind === "stack-item") {
		if (source.mergedItems?.length) {
			return source.mergedItems.map((item) => item.itemName?.trim() || item.itemId || "item").join(" + ");
		}
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

function renderPreviewSectionText(sections: WebEditorPreviewSection[]): string {
	let text = "";
	for (const section of sections) {
		const role = section.role ? ` (${section.role})` : "";
		text += `\n--- ${section.title}${role} ---\n`;
		text += previewSectionText(section);
		text += "\n";
	}
	return text.trimStart();
}

function previewMessageDiffKey(
	source: CompileMessageSource | undefined,
	content: string,
	role: string,
	isForgeUpdate = false,
): string {
	if (isForgeUpdate) {
		return `forge-capability-update:${hashText(`${role}\0${content}`)}`;
	}
	if (source?.kind === "stack-item" && source.mergedItems?.length) {
		return `stack-items:${source.mergedItems.map((item) => item.itemId ?? "").join("+")}`;
	}
	if (source?.kind === "stack-item" && source.itemId) return `stack-item:${source.itemId}`;
	const sourceKey = source?.kind === "chat-history"
		? `chat-history:${source.itemId ?? source.slot ?? "history"}`
		: "implicit-history";
	return `${sourceKey}:${hashText(`${role}\0${content}`)}`;
}

function previewSection(id: string, title: string, content: string, role?: string, diffKey?: string): WebEditorPreviewSection {
	return {
		id,
		diffKey,
		title,
		role,
		content,
		chars: content.length,
		approxTokens: content.length ? estimatePayloadTokens(content) : 0,
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
