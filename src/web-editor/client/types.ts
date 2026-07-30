import type {
	PromptRegexRule,
	PromptResourcePolicy,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
} from "../../types.ts";
import type {
	WebEditorPayloadSnapshot,
	WebEditorPolicyResource,
	WebEditorProfileCollection,
	WebEditorProfileEntry,
	WebEditorProfileModelOption,
	WebEditorProfileMutation,
	WebEditorProfileValidation,
	WebEditorStackSummary,
	WebEditorSubagentPolicyUpdate,
	WebEditorSubagentProfilePolicy,
	WebEditorSubagentSummary,
} from "../types.ts";

export type EditorJsonObject = Record<string, any>;
export type EditorPromptStackItem = PromptStackItem & EditorJsonObject;
export type EditorPromptStack = Omit<PromptStack, "items"> & EditorJsonObject & {
	items: EditorPromptStackItem[];
};
export type EditorRegexRule = PromptRegexRule & EditorJsonObject;

export interface EditorState {
	stacks: WebEditorStackSummary[];
	cwd: string;
	selectedId: string;
	currentStack: EditorPromptStack | null;
	currentFilePath: string;
	selectedItemIndex: number;
	dirty: boolean;
	dragIndex: number;
	dragDropIndex: number;
	dragScrollFrame: number;
	dragScrollSpeed: number;
	dragClientY: number;
	optionsText: string;
	optionsError: string;
	sidebarCollapsed: boolean;
	slotOptionsMode: "form" | "json";
	previewCopyTexts: string[];
	payloadSnapshot: WebEditorPayloadSnapshot;
	policyResources: { tools: WebEditorPolicyResource[]; skills: WebEditorPolicyResource[] };
	latestDiagnostics: PromptStackDiagnostic[];
	stackVariablesError: string;
	regexRulesError: string;
	stackPolicyError: string;
	activeTab: "items" | "regex" | "policy" | "stack";
	metadataCollapsed: boolean;
	currentTheme: "light" | "dark";
}

export interface EditorModalOptions {
	bodyClass?: string;
}

export interface EditorSelectOptions {
	keepDirty?: boolean;
}

export interface EditorPayloadRefreshOptions {
	open?: boolean;
	autoOpen?: boolean;
}

export interface EditorCreateOptions {
	activate?: boolean;
	overwrite?: boolean;
}

export interface EditorImportReport {
	text?: string;
	markdown?: string;
	[key: string]: unknown;
}

export type {
	PromptRegexRule,
	PromptResourcePolicy,
	PromptStackDiagnostic,
	WebEditorPayloadSnapshot,
	WebEditorPolicyResource,
	WebEditorProfileCollection,
	WebEditorProfileEntry,
	WebEditorProfileModelOption,
	WebEditorProfileMutation,
	WebEditorProfileValidation,
	WebEditorStackSummary,
	WebEditorSubagentPolicyUpdate,
	WebEditorSubagentProfilePolicy,
	WebEditorSubagentSummary,
};
