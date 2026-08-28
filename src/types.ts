import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResourceKey, ResourceScope } from "./resource-identity.ts";

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

export type PromptStackSlotFormat = "xml" | "json" | "plain";

export type PromptRegexStage = "history" | "compiled";

export type PromptRegexEffect = "outgoing" | "finalize";

export type PromptRegexTarget = "system" | "messages";

/**
 * `"turn"` (default): the rule runs during the full compilation on the first
 * provider request of a user turn. `"request"`: an outgoing message rule also
 * runs on tool-result follow-up requests, applied to Pi's full natural
 * context. Meaningless for finalize rules and system-only targets.
 */
export type PromptRegexFrequency = "turn" | "request";

export interface PromptRegexRule {
	id: string;
	name?: string;
	enabled?: boolean;
	stage: PromptRegexStage;
	effect?: PromptRegexEffect;
	frequency?: PromptRegexFrequency;
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
	/** Merge runs of consecutive stack-item messages that share the same declared role into one message. Default: false. */
	mergeConsecutiveRoles?: boolean;
	/** Separator inserted between merged message texts. Default: "\n\n". */
	mergeSeparator?: string;
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
	format?: PromptStackSlotFormat;
	/** For tools: only render tools that provide prompt snippets, matching Pi's default prompt builder. */
	onlyWithSnippets?: boolean;
	/** For date/date-cwd: include the exact current time. Default: false. */
	includeTime?: boolean;
	/** For tool-guidelines: override the plain-format section heading. */
	heading?: string;
	/** For tool-guidelines: include Pi's default concise/file-path guideline bullets. */
	includePiDefaultGuidelines?: boolean;
	/** For tool-guidelines: match Pi's default wording where it differs from pi-forge's generic wording. */
	piStyle?: boolean;
	/** For skills: omit the skills section unless the read tool is active, matching Pi's default prompt builder. */
	requireReadTool?: boolean;
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
	schemaVersion: 1 | 2;
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
	parameters?: Record<string, PromptVariableValue>;
	regex?: PromptRegexConfig;
	items: PromptStackItem[];
	import?: Record<string, unknown>;
}

export interface LoadedPromptStack {
	stack: PromptStack;
	filePath: string;
	scope: ResourceScope;
	key: ResourceKey;
	diagnostics: PromptStackDiagnostic[];
}

export type PromptStackDiagnosticLevel = "error" | "warning" | "info";

export interface PromptStackDiagnostic {
	level: PromptStackDiagnosticLevel;
	message: string;
	itemId?: string;
}

/**
 * Host-neutral prompt compilation input.
 *
 * This deliberately avoids Pi runtime types such as `ExtensionContext` and
 * `BuildSystemPromptOptions`. Pi/preview/subagent adapters convert their
 * runtime facts into this small snapshot before entering the compiler.
 */
export interface PromptCompileOptions {
	cwd: string;
	selectedTools?: readonly string[];
	toolSnippets?: Readonly<Record<string, string>>;
	promptGuidelines?: readonly string[];
	appendSystemPrompt?: string;
	contextFiles?: readonly { path: string; content: string }[];
	skills?: readonly {
		name: string;
		description: string;
		filePath: string;
		baseDir?: string;
		sourceInfo?: unknown;
		disableModelInvocation: boolean;
	}[];
}

export interface PromptRuntimeSnapshot {
	options: PromptCompileOptions;
	/** Host-neutral model identity; used for `activeModel` and synthetic assistant messages. */
	model?: { provider: string; id: string; api?: string };
	latestUserMessage?: string;
	now: Date;
}

/** @deprecated Use {@link PromptRuntimeSnapshot} for new code. */
export type PromptRuntime = PromptRuntimeSnapshot;

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
	/** Present when consecutive-role merging combined several stack items into this message. */
	mergedItems?: { itemId?: string; itemName?: string }[];
}

export interface CompileMessagesResult {
	messages: AgentMessage[];
	messageSources: CompileMessageSource[];
	diagnostics: PromptStackDiagnostic[];
}

export { SUPPORTED_SLOTS } from "./slot-renderers.ts";
