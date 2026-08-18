import { analyze } from "./analyzer.ts";
import { parse } from "./parser.ts";
import { render } from "./renderer.ts";
import type {
	ForgeV1TemplateEngine,
	PromptEnvironment,
	PromptEnvironmentValue,
	TemplateAnalyzeResult,
	TemplateDependency,
	TemplateNode,
	TemplateParseResult,
	TemplateRenderResult,
} from "./types.ts";
import {
	FORGE_V1_FILTERS,
	FORGE_V1_MAX_EXTENSION_OUTPUT,
	FORGE_V1_MAX_TEMPLATE_OUTPUT,
} from "./types.ts";

export const forgeV1: ForgeV1TemplateEngine = {
	id: "forge-v1",
	version: 1,
	parse: parse,
	analyze: (nodes: readonly TemplateNode[]): TemplateAnalyzeResult => analyze(nodes),
	render: render,
};

export {
	FORGE_V1_FILTERS,
	FORGE_V1_MAX_EXTENSION_OUTPUT,
	FORGE_V1_MAX_TEMPLATE_OUTPUT,
};
export type {
	ForgeV1TemplateEngine,
	PromptEnvironment,
	PromptEnvironmentValue,
	TemplateAnalyzeResult,
	TemplateDependency,
	TemplateDependencyKind,
	TemplateNode,
	TemplateOutputNode,
	TemplateParseResult,
	TemplatePredicate,
	TemplateRenderResult,
	TemplateSourceSpan,
	TemplateTextNode,
	ForgeV1Error,
	ForgeV1ErrorKind,
} from "./types.ts";
