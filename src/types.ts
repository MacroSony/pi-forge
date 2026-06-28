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
	roles?: string[];
	targets?: PromptRegexTarget[];
	maxMessages?: number;
	maxChars?: number;
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
	/** Include only these scopes. Overrides includeStatic/includeSession/includeTurn when present. */
	includeScopes?: PromptStateScope[];
	/** Include variable names matching these exact names or wildcard prefixes, e.g. agent.*. */
	includeNamespaces?: string[];
	/** Exclude variable names matching these exact names or wildcard prefixes. */
	excludeNamespaces?: string[];
	/** Include type and description metadata from stack.state.definitions. Default: false. */
	includeMetadata?: boolean;
	/** Render format. Default: xml. */
	format?: PromptStackSlotFormat;
	/** Truncate each rendered value after this many characters. */
	maxValueChars?: number;
}

export interface PromptStackSlotOptions {
	/** For chat-history: include the latest user message in the expanded history. Default: true. */
	includeLastUserMessage?: boolean;
	/** For variables: control which variable scopes are included. */
	includeStatic?: boolean;
	includeSession?: boolean;
	includeTurn?: boolean;
	includeScopes?: PromptStateScope[];
	includeNamespaces?: string[];
	excludeNamespaces?: string[];
	includeMetadata?: boolean;
	format?: PromptStackSlotFormat;
	maxValueChars?: number;
	[key: string]: unknown;
}

export interface PromptStackSlotItem extends PromptStackBaseItem {
	kind: "slot";
	slot: PromptStackSlot | string;
	options?: PromptStackSlotOptions;
}

export type PromptStackItem = PromptStackBlockItem | PromptStackSlotItem;

export type PromptStatePrimitive = string | number | boolean | null;

export type PromptStateValue = PromptStatePrimitive | PromptStateValue[] | { [key: string]: PromptStateValue };

export type PromptStateScope = "static" | "session" | "turn";

export interface PromptStateDefinition {
	type?: string;
	scope?: PromptStateScope;
	description?: string;
	agentWritable?: boolean;
	userWritable?: boolean;
	default?: PromptStateValue;
}

export interface PromptStateConfig {
	schemaVersion?: 1;
	definitions?: Record<string, PromptStateDefinition>;
}

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
	state?: PromptStateConfig;
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
	turn: Record<string, PromptStateValue>;
	session: Record<string, PromptStateValue>;
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
	"variables",
]);
