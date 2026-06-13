import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PromptStackMode = "replace" | "append" | "prepend";

export type PromptStackRole = "system" | "user" | "assistant" | "custom";

export type PromptStackSlot =
	| "chat-history"
	| "tools"
	| "tool-guidelines"
	| "skills"
	| "project-context"
	| "append-system-prompt"
	| "date"
	| "cwd"
	| "date-cwd"
	| "active-model"
	| "pi-docs";

export interface PromptStackDefaults {
	syntheticMessagesVisible?: boolean;
	unresolvedMacroPolicy?: "warn" | "keep" | "error";
}

export interface PromptStackContextOptions {
	allowDuplicateChatHistory?: boolean;
}

export interface PromptStackBaseItem {
	kind: "block" | "slot";
	id: string;
	name?: string;
	enabled?: boolean;
	role?: PromptStackRole;
	tags?: string[];
	source?: Record<string, unknown>;
}

export interface PromptStackBlockItem extends PromptStackBaseItem {
	kind: "block";
	content: string;
}

export interface PromptStackSlotItem extends PromptStackBaseItem {
	kind: "slot";
	slot: PromptStackSlot | string;
}

export type PromptStackItem = PromptStackBlockItem | PromptStackSlotItem;

export interface PromptStack {
	schemaVersion: 1;
	type?: "pi-forge.prompt-stack";
	id: string;
	name?: string;
	description?: string;
	autoActivate?: boolean;
	mode?: PromptStackMode;
	defaults?: PromptStackDefaults;
	context?: PromptStackContextOptions;
	variables?: Record<string, string>;
	items: PromptStackItem[];
	import?: Record<string, unknown>;
}

export interface LoadedPromptStack {
	stack: PromptStack;
	filePath: string;
	diagnostics: PromptStackDiagnostic[];
}

export type PromptStackDiagnosticLevel = "error" | "warning" | "info";

export interface PromptStackDiagnostic {
	level: PromptStackDiagnosticLevel;
	message: string;
	itemId?: string;
}

export interface PromptRuntime {
	options: BuildSystemPromptOptions;
	ctx?: ExtensionContext;
	latestUserMessage?: string;
	now: Date;
}

export interface CompileSystemPromptResult {
	systemPrompt: string;
	diagnostics: PromptStackDiagnostic[];
}

export interface CompileMessagesResult {
	messages: AgentMessage[];
	diagnostics: PromptStackDiagnostic[];
}

export const SUPPORTED_SLOTS = new Set<PromptStackSlot>([
	"chat-history",
	"tools",
	"tool-guidelines",
	"skills",
	"project-context",
	"append-system-prompt",
	"date",
	"cwd",
	"date-cwd",
	"active-model",
	"pi-docs",
]);
