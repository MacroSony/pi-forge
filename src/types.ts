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
	| "pi-docs"
	| "variables";

export type PromptStackSlotFormat = "xml" | "json" | "plain";

export type PromptRegexStage = "history" | "compiled";

export type PromptRegexEffect = "outgoing" | "display" | "both" | "finalize";

export type PromptRegexTarget = "system" | "messages";

export interface PromptRegexRule {
	id: string;
	name?: string;
	enabled?: boolean;
	stage: PromptRegexStage;
	effect?: PromptRegexEffect;
	pattern: string;
	flags?: string;
	replace?: string;
	trimStrings?: string[];
	roles?: string[];
	targets?: PromptRegexTarget[];
	maxMessages?: number;
	maxChars?: number;
	minDepth?: number;
	maxDepth?: number;
	source?: Record<string, unknown>;
}

export interface PromptRegexConfig {
	schemaVersion?: 1;
	rules?: PromptRegexRule[];
}

export type PromptResourcePolicy =
	| { allow?: string[]; deny?: never }
	| { allow?: never; deny?: string[] };

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

export interface VariablesSlotOptions {
	/** Include static stack variables. Default: true. */
	includeStatic?: boolean;
	/** Include session variables. Default: true. */
	includeSession?: boolean;
	/** Include turn variables. Default: true. */
	includeTurn?: boolean;
	/** Render format. Default: xml. */
	format?: Exclude<PromptStackSlotFormat, "json">;
}

export interface PromptStackSlotOptions {
	/** For chat-history: include the latest user message in the expanded history. Default: true. */
	includeLastUserMessage?: boolean;
	/** For chat-history: remove assistant thinking content blocks from inserted history. Default: false. */
	stripAssistantThinking?: boolean;
	/** For chat-history: keep only messages with these roles. Default: all roles. */
	roles?: string[];
	/** For chat-history: include Pi branch/compaction summaries. Default: true. */
	includeSummaries?: boolean;
	/** For chat-history: keep or drop tool-call/tool-result history. Default: keep. */
	toolMode?: "keep" | "drop";
	/** For chat-history: keep only the most recent N messages after filtering. */
	maxMessages?: number;
	/** For chat-history: keep only the most recent messages within an approximate character budget. */
	maxChars?: number;
	/** For variables: control which variable scopes are included. */
	includeStatic?: boolean;
	includeSession?: boolean;
	includeTurn?: boolean;
	format?: PromptStackSlotFormat;
	[key: string]: unknown;
}

export interface PromptStackSlotItem extends PromptStackBaseItem {
	kind: "slot";
	slot: PromptStackSlot | string;
	options?: PromptStackSlotOptions;
}

export type PromptStackItem = PromptStackBlockItem | PromptStackSlotItem;

export type PromptVariablePrimitive = string | number | boolean | null;

export type PromptVariableValue = PromptVariablePrimitive | PromptVariableValue[] | { [key: string]: PromptVariableValue };

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
	tools?: PromptResourcePolicy;
	skills?: PromptResourcePolicy;
	variables?: Record<string, string>;
	regex?: PromptRegexConfig;
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

export interface PromptVariableStore {
	turn: Record<string, PromptVariableValue>;
	session: Record<string, PromptVariableValue>;
	sessionDirty?: boolean;
}

export interface PromptRuntime {
	options: BuildSystemPromptOptions;
	ctx?: ExtensionContext;
	latestUserMessage?: string;
	now: Date;
	variables?: PromptVariableStore;
}

export interface CompileSystemPromptResult {
	systemPrompt: string;
	diagnostics: PromptStackDiagnostic[];
}

export type CompileMessageSourceKind = "stack-item" | "chat-history" | "implicit-history";

export interface CompileMessageSource {
	kind: CompileMessageSourceKind;
	itemId?: string;
	itemName?: string;
	slot?: string;
	historyIndex?: number;
	historyCount?: number;
	role?: string;
}

export interface CompileMessagesResult {
	messages: AgentMessage[];
	messageSources: CompileMessageSource[];
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
	"variables",
]);
