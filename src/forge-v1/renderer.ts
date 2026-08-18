import type {
	ForgeV1Error,
	PromptEnvironment,
	PromptEnvironmentValue,
	TemplateNode,
	TemplatePredicate,
	TemplateRenderResult,
	TemplateSourceSpan,
} from "./types.ts";
import { FORGE_V1_MAX_TEMPLATE_OUTPUT } from "./types.ts";

const ROOTS = new Set(["runtime", "parameters", "extensions"]);

const LEGACY_RUNTIME = new Map<string, readonly string[]>([
	["cwd", ["runtime", "cwd"]],
	["date", ["runtime", "date"]],
	["time", ["runtime", "time"]],
	["lastUserMessage", ["runtime", "lastUserMessage"]],
	["selectedTools", ["runtime", "selectedToolsText"]],
	["tools", ["runtime", "selectedToolsText"]],
	["activeModel", ["runtime", "activeModel"]],
]);

export function render(
	nodes: readonly TemplateNode[],
	environment: PromptEnvironment,
	options: { templateLimit?: number } = {},
): TemplateRenderResult {
	const limit = options.templateLimit ?? FORGE_V1_MAX_TEMPLATE_OUTPUT;
	try {
		const text = renderNodeList(nodes, environment, limit, 0);
		return { ok: true, text };
	} catch (error) {
		if (isForgeError(error)) return { ok: false, error };
		throw error;
	}
}

function renderNodeList(
	nodes: readonly TemplateNode[],
	environment: PromptEnvironment,
	limit: number,
	depth: number,
): string {
	if (depth > 64) {
		throw { kind: "recursion", message: "forge-v1 template nesting exceeds 64 levels." } as ForgeV1Error;
	}
	let result = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			result += node.text;
		} else if (node.kind === "output") {
			const raw = evaluatePath(node.path, environment, node.span) as PromptEnvironmentValue;
			let value: PromptEnvironmentValue = raw;
			for (const filter of node.filters) {
				value = applyFilter(filter, value, node.span);
			}
			result += valueToString(value);
		} else if (node.kind === "if") {
			const branch = evaluatePredicate(node.predicate, environment) ? node.thenBody : node.elseBody;
			if (branch) result += renderNodeList(branch, environment, limit, depth + 1);
		}
		if (result.length > limit) {
			throw {
				kind: "output-limit",
				message: `forge-v1 template output exceeds ${limit} characters.`,
			} as ForgeV1Error;
		}
	}
	return result;
}

function evaluatePath(
	path: readonly string[],
	environment: PromptEnvironment,
	span: TemplateSourceSpan | undefined,
	allowUndefined = false,
): PromptEnvironmentValue | undefined {
	if (path.length === 0) return undefined;
	const first = path[0]!;

	let cursor: unknown;
	if (ROOTS.has(first)) {
		if (first === "runtime") cursor = environment.runtime;
		else if (first === "parameters") cursor = environment.parameters;
		else cursor = environment.extensions;
		const rest = path.slice(1);
		for (const segment of rest) {
			if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !(segment in (cursor as Record<string, unknown>))) {
				if (allowUndefined) return undefined;
				throw undefinedError(path, span);
			}
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor as PromptEnvironmentValue | undefined;
	}

	if (path.length === 1) {
		if (Object.prototype.hasOwnProperty.call(environment.parameters, first)) {
			return environment.parameters[first];
		}
		const legacyRoot = LEGACY_RUNTIME.get(first);
		if (legacyRoot) {
			return evaluatePath(legacyRoot, environment, span, allowUndefined);
		}
		if (Object.prototype.hasOwnProperty.call(environment.extensions, first)) {
			return environment.extensions[first];
		}
	}
	if (allowUndefined) return undefined;
	throw undefinedError(path, span);
}

function undefinedError(path: readonly string[], span: TemplateSourceSpan | undefined): ForgeV1Error {
	return {
		kind: "undefined",
		message: `Undefined forge-v1 path: {{${path.join(".")}}}`,
		span,
	};
}

function evaluatePredicate(predicate: TemplatePredicate, environment: PromptEnvironment): boolean {
	if (predicate.kind === "truthy") {
		const value = evaluatePath(predicate.path, environment, predicate.span, true);
		return isTruthy(value);
	}
	const value = evaluatePath(predicate.path, environment, predicate.span, false);
	const actual = valueToString(value);
	if (predicate.kind === "eq") return actual === predicate.expected;
	return actual !== predicate.expected;
}

function isTruthy(value: PromptEnvironmentValue | undefined): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.length > 0;
	if (typeof value === "number") return value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	return Object.keys(value).length > 0;
}

function applyFilter(name: string, value: PromptEnvironmentValue, span: TemplateSourceSpan | undefined): PromptEnvironmentValue {
	switch (name) {
		case "trim":
			return String(value).trim();
		case "upper":
			return String(value).toUpperCase();
		case "lower":
			return String(value).toLowerCase();
		case "json":
			return JSON.stringify(value);
		case "xml":
			return escapeXml(String(value));
		default:
			throw {
				kind: "filter",
				message: `Unknown forge-v1 filter: ${name}`,
				span,
			} as ForgeV1Error;
	}
}

export function valueToString(value: PromptEnvironmentValue | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function isForgeError(value: unknown): value is ForgeV1Error {
	return !!value && typeof value === "object" && typeof (value as ForgeV1Error).kind === "string";
}
