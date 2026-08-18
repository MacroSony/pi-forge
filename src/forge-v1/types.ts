export type PromptEnvironmentValue =
	| string
	| number
	| boolean
	| null
	| PromptEnvironmentValue[]
	| { [key: string]: PromptEnvironmentValue };

/**
 * Deep-frozen, JSON-compatible snapshot passed to forge-v1 rendering.
 * Public contract: `runtime.*`, `parameters.*`, and `extensions.*`.
 */
export interface PromptEnvironment {
	runtime: Record<string, PromptEnvironmentValue>;
	parameters: Record<string, PromptEnvironmentValue>;
	extensions: Record<string, string>;
}

export interface TemplateSourceSpan {
	start: number;
	end: number;
}

export type TemplateNode = TemplateTextNode | TemplateOutputNode | TemplateIfNode;

export interface TemplateTextNode {
	kind: "text";
	text: string;
	span: TemplateSourceSpan;
}

export interface TemplateOutputNode {
	kind: "output";
	path: readonly string[];
	filters: readonly string[];
	span: TemplateSourceSpan;
}

export interface TemplateIfNode {
	kind: "if";
	predicate: TemplatePredicate;
	thenBody: TemplateNode[];
	elseBody: TemplateNode[] | null;
	span: TemplateSourceSpan;
}

export type TemplatePredicateKind = "truthy" | "eq" | "ne";

export interface TemplatePredicate {
	kind: TemplatePredicateKind;
	path: readonly string[];
	expected?: string;
	span: TemplateSourceSpan;
}

export type TemplateParseResult = {
	ok: true;
	ast: TemplateNode[];
} | {
	ok: false;
	error: ForgeV1Error;
};

export type TemplateDependencyKind = "runtime" | "parameters" | "extensions" | "legacy" | "filter";

export interface TemplateDependency {
	kind: TemplateDependencyKind;
	path?: readonly string[];
	filter?: string;
	span?: TemplateSourceSpan;
}

export interface TemplateAnalyzeResult {
	dependencies: TemplateDependency[];
	errors: ForgeV1Error[];
}

export type TemplateRenderResult = {
	ok: true;
	text: string;
} | {
	ok: false;
	error: ForgeV1Error;
};

export type ForgeV1ErrorKind =
	| "parse"
	| "evaluate"
	| "undefined"
	| "filter"
	| "output-limit"
	| "extension-limit"
	| "recursion";

export interface ForgeV1Error {
	kind: ForgeV1ErrorKind;
	message: string;
	span?: TemplateSourceSpan;
}

export interface ForgeV1TemplateEngine {
	readonly id: "forge-v1";
	readonly version: 1;
	parse(source: string): TemplateParseResult;
	analyze(ast: readonly TemplateNode[]): TemplateAnalyzeResult;
	render(ast: readonly TemplateNode[], environment: PromptEnvironment, options?: { templateLimit?: number; resolveExtension?: (name: string) => PromptEnvironmentValue | undefined }): TemplateRenderResult;
}

export const FORGE_V1_FILTERS = ["trim", "upper", "lower", "json", "xml"] as const;

export const FORGE_V1_MAX_TEMPLATE_OUTPUT = 100_000;
export const FORGE_V1_MAX_EXTENSION_OUTPUT = 16_384;
