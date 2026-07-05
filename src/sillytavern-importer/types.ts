import type { PromptRegexRule, PromptStack, PromptStackItem } from "../types.ts";

export interface StPreset {
	prompts?: StPromptDef[];
	prompt_order?: StPromptOrderEntry[];
	extensions?: {
		regex_scripts?: unknown[];
		[key: string]: unknown;
	};
	names_behavior?: number;
	preset_name?: string;
	name?: string;
	[key: string]: unknown;
}

export interface StPromptDef {
	identifier: string;
	name?: string;
	role?: string;
	content?: string;
	system_prompt?: boolean;
	marker?: boolean;
	enabled?: boolean;
}

export interface StPromptOrderEntry {
	character_id: number;
	order?: StOrderItem[];
}

export interface StOrderItem {
	identifier: string;
	enabled: boolean;
}

export interface StRegexScript {
	script_name?: string;
	scriptName?: string;
	name?: string;
	disabled?: boolean;
	promptOnly?: boolean;
	markdownOnly?: boolean;
	findRegex?: string;
	replaceString?: string;
	trimStrings?: unknown;
	substituteRegex?: unknown;
	placement?: unknown;
	minDepth?: unknown;
	maxDepth?: unknown;
	runOnEdit?: unknown;
	[key: string]: unknown;
}

export interface StConversionItem {
	def: StPromptDef;
	orderEnabled: boolean;
	orderIndex: number;
}

export type RegexScriptMode = "prompt-only" | "markdown-only" | "prompt+markdown" | "unspecified" | "disabled";

export interface RegexScriptReportEntry {
	name: string;
	mode: RegexScriptMode;
	enabled: boolean;
	promptOnly: boolean;
	markdownOnly: boolean;
	findRegex?: string;
	replaceString?: string;
	trimStrings?: string[];
	placement?: number[];
	substituteRegex?: number;
	minDepth?: number;
	maxDepth?: number;
	convertedRuleId?: string;
	conversionNote?: string;
	conversionWarnings: string[];
}

export interface RegexScriptReport {
	total: number;
	enabled: number;
	disabled: number;
	promptOnly: number;
	markdownOnly: number;
	mixed: number;
	unspecified: number;
	converted: number;
	scripts: RegexScriptReportEntry[];
	rules: PromptRegexRule[];
}

export interface PromptConversionDisabledCounts {
	marker: number;
	empty: number;
	orderDisable: number;
}

export interface PromptConversionResult {
	items: PromptStackItem[];
	usesLastUserMessage: boolean;
	disabledCount: PromptConversionDisabledCounts;
}

export interface SillyTavernImportResult {
	stack: PromptStack;
	report: string;
}

export interface SillyTavernImportError {
	error: string;
}

export type SillyTavernImportOutcome = SillyTavernImportResult | SillyTavernImportError;

export interface SillyTavernConvertOptions {
	sourceName?: string;
	sourcePath?: string;
	characterId?: number;
}
