import type {
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
} from "./types.ts";
import {
	createVariableAccess,
	escapeXml,
	formatDate,
	formatTime,
	promptRenderHelpers,
	selectedToolNames,
	type PromptRenderHelpers,
	type PromptVariableAccess,
	variableValueToMacroText,
} from "./render-helpers.ts";
import { assertRegistryName, type PromptExtensionArgumentDefinition, type PromptRegistryEntry } from "./extension-registry.ts";

interface MacroExpansionState {
	stack: PromptStack;
	runtime: PromptRuntime;
	diagnostics: PromptStackDiagnostic[];
	itemId: string;
	unknown: Set<string>;
}

export interface PromptMacroRenderContext {
	name: string;
	command: string;
	stack: PromptStack;
	runtime: PromptRuntime;
	rawArgs: readonly string[];
	expandArg: (index: number) => string;
	expandJoinedArgs: (startIndex: number) => string;
	helpers: PromptRenderHelpers;
	variables: PromptVariableAccess;
}

export type PromptMacroRenderer = (context: PromptMacroRenderContext) => string | undefined;

export interface PromptMacroDefinition extends PromptRegistryEntry {
	args?: readonly PromptExtensionArgumentDefinition[];
	render: PromptMacroRenderer;
}

interface PromptMacroRegistryState {
	macros: Map<string, PromptMacroDefinition>;
}

type PromptMacroGlobal = typeof globalThis & {
	__piForgeMacroRegistry?: PromptMacroRegistryState;
};

function macroRegistryState(): PromptMacroRegistryState {
	const globalScope = globalThis as PromptMacroGlobal;
	globalScope.__piForgeMacroRegistry ??= { macros: new Map() };
	return globalScope.__piForgeMacroRegistry;
}

const MACROS = macroRegistryState().macros;
let registeringBuiltInMacros = true;

registerMacro({ name: "cwd", description: "Current working directory.", render: ({ runtime }) => runtime.options.cwd });
registerMacro({ name: "date", description: "Current date in YYYY-MM-DD format.", render: ({ runtime }) => formatDate(runtime.now) });
registerMacro({ name: "time", description: "Current time in HH:MM:SS format.", render: ({ runtime }) => formatTime(runtime.now) });
registerMacro({ name: "lastUserMessage", description: "Latest user message text.", render: ({ runtime }) => runtime.latestUserMessage ?? "" });
registerMacro({ name: "selectedTools", description: "Comma-separated selected tool names after stack policy.", render: renderSelectedTools });
registerMacro({ name: "tools", description: "Alias for selectedTools.", render: renderSelectedTools });
registerMacro({ name: "activeModel", description: "Current model as provider/id.", render: ({ runtime }) => {
	const model = runtime.ctx?.model;
	return model ? `${model.provider}/${model.id}` : "";
} });

registerMacro({ name: "trim", description: "Trim whitespace from an expanded argument.", args: [{ name: "value", required: true }], render: ({ expandArg }) => expandArg(0).trim() });
registerMacro({ name: "upper", description: "Uppercase an expanded argument.", args: [{ name: "value", required: true }], render: ({ expandArg }) => expandArg(0).toUpperCase() });
registerMacro({ name: "lower", description: "Lowercase an expanded argument.", args: [{ name: "value", required: true }], render: ({ expandArg }) => expandArg(0).toLowerCase() });
registerMacro({ name: "json", description: "JSON-string escape an expanded argument.", args: [{ name: "value", required: true }], render: ({ expandArg }) => JSON.stringify(expandArg(0)) });
registerMacro({ name: "xml", description: "XML-escape an expanded argument.", args: [{ name: "value", required: true }], render: ({ expandArg }) => escapeXml(expandArg(0)) });
registerMacro({ name: "iftools", description: "Render a lazy branch based on whether a tool is selected.", render: renderIfTool });
registerMacro({ name: "ifslot", description: "Render a lazy branch based on whether an enabled slot exists in the stack.", render: renderIfSlot });
registeringBuiltInMacros = false;

export function expandMacros(
	text: string,
	stack: PromptStack,
	runtime: PromptRuntime,
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): string {
	const policy = stack.defaults?.unresolvedMacroPolicy ?? "warn";
	const state: MacroExpansionState = { stack, runtime, diagnostics, itemId, unknown: new Set<string>() };
	const result = expandMacroText(text, state);

	for (const name of state.unknown) {
		if (policy === "keep") continue;
		diagnostics.push({
			level: policy === "error" ? "error" : "warning",
			message: `Unresolved macro: {{${name}}}`,
			itemId,
		});
	}

	return result;
}

export function registerMacro(definition: PromptMacroDefinition): () => void {
	assertRegistryName("Macro", definition.name);
	if (MACROS.has(definition.name)) {
		if (registeringBuiltInMacros) return () => {};
		throw new Error(`Macro is already registered: ${definition.name}`);
	}
	MACROS.set(definition.name, definition);
	return () => {
		if (MACROS.get(definition.name) === definition) MACROS.delete(definition.name);
	};
}

export function getRegisteredMacros(): readonly PromptMacroDefinition[] {
	return [...MACROS.values()];
}

function expandMacroText(text: string, state: MacroExpansionState): string {
	let result = "";
	let index = 0;

	while (index < text.length) {
		const start = text.indexOf("{{", index);
		if (start === -1) {
			result += text.slice(index);
			break;
		}

		result += text.slice(index, start);
		const end = findMacroEnd(text, start + 2);
		if (end === undefined) {
			result += "{{";
			index = start + 2;
			continue;
		}

		const expression = text.slice(start + 2, end);
		const fullMacro = text.slice(start, end + 2);
		result += renderMacro(expression, fullMacro, state);
		index = end + 2;
	}

	return result;
}

function findMacroEnd(text: string, start: number): number | undefined {
	let depth = 1;

	for (let index = start; index < text.length - 1; index++) {
		const pair = text.slice(index, index + 2);
		if (pair === "{{") {
			depth++;
			index++;
			continue;
		}
		if (pair === "}}") {
			depth--;
			if (depth === 0) return index;
			index++;
		}
	}

	return undefined;
}

function renderMacro(rawExpression: string, fullMacro: string, state: MacroExpansionState): string {
	const expression = rawExpression.trim();
	if (!expression) return fullMacro;

	const parts = splitMacroExpression(expression);
	const command = parts[0]?.trim();
	if (!command) return fullMacro;

	const rawArgs = parts.slice(1);
	const definition = MACROS.get(command);
	if (definition) {
		let value: string | undefined;
		try {
			value = definition.render(createMacroRenderContext(command, rawArgs, state));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			state.diagnostics.push({
				level: "error",
				message: `Macro {{${command}}} failed: ${detail}`,
				itemId: state.itemId,
			});
			return fullMacro;
		}
		if (value !== undefined) return value;
		state.unknown.add(expression);
		return fullMacro;
	}

	const variableValue = createVariableAccess(state.runtime, state.stack).get(command);
	if (variableValue !== undefined) return variableValueToMacroText(variableValue);

	state.unknown.add(expression);
	return fullMacro;
}

function splitMacroExpression(expression: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;

	for (let index = 0; index < expression.length - 1; index++) {
		const pair = expression.slice(index, index + 2);
		if (pair === "{{") {
			depth++;
			index++;
			continue;
		}
		if (pair === "}}" && depth > 0) {
			depth--;
			index++;
			continue;
		}
		if (pair === "::" && depth === 0) {
			parts.push(expression.slice(start, index));
			start = index + 2;
			index++;
		}
	}

	parts.push(expression.slice(start));
	return parts;
}

function createMacroRenderContext(
	command: string,
	rawArgs: readonly string[],
	state: MacroExpansionState,
): PromptMacroRenderContext {
	const expandedArgs = new Map<number, string>();

	const expandArg = (index: number): string => {
		if (!expandedArgs.has(index)) {
			expandedArgs.set(index, expandMacroText(rawArgs[index] ?? "", state));
		}
		return expandedArgs.get(index) ?? "";
	};

	return {
		name: command,
		command,
		stack: state.stack,
		runtime: state.runtime,
		rawArgs,
		expandArg,
		expandJoinedArgs: (startIndex: number) =>
			rawArgs.slice(startIndex).map((_, offset) => expandArg(startIndex + offset)).join("::"),
		helpers: promptRenderHelpers,
		variables: createVariableAccess(state.runtime, state.stack),
	};
}




function renderSelectedTools({ stack, runtime }: PromptMacroRenderContext): string {
	return selectedToolNames(stack, runtime).join(", ");
}



function renderIfTool(context: PromptMacroRenderContext): string | undefined {
	const name = context.expandArg(0).trim();
	if (!name) return undefined;

	return renderConditionalBranch(context, selectedToolNames(context.stack, context.runtime).includes(name), 1, 2);
}

function renderIfSlot(context: PromptMacroRenderContext): string | undefined {
	const name = context.expandArg(0).trim();
	if (!name) return undefined;

	const hasSlot = context.stack.items.some((item) => item.enabled !== false && item.kind === "slot" && item.slot === name);
	return renderConditionalBranch(context, hasSlot, 1, 2);
}

function renderConditionalBranch(
	context: PromptMacroRenderContext,
	condition: boolean,
	thenIndex: number,
	elseIndex: number,
): string {
	return condition ? context.expandArg(thenIndex) : context.expandArg(elseIndex);
}
