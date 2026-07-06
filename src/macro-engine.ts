import type {
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
	PromptVariableValue,
} from "./types.ts";
import { applyResourcePolicy } from "./policy.ts";

type PromptVariableScope = "static" | "session" | "turn";

interface MacroExpansionState {
	stack: PromptStack;
	runtime: PromptRuntime;
	unknown: Set<string>;
}

interface MacroRenderContext {
	command: string;
	stack: PromptStack;
	runtime: PromptRuntime;
	rawArgs: readonly string[];
	expandArg: (index: number) => string;
	expandJoinedArgs: (startIndex: number) => string;
}

type MacroHandler = (context: MacroRenderContext) => string | undefined;

const BUILTIN_MACROS = new Map<string, MacroHandler>();

registerMacro("cwd", ({ runtime }) => runtime.options.cwd);
registerMacro("date", ({ runtime }) => formatDate(runtime.now));
registerMacro("time", ({ runtime }) => formatTime(runtime.now));
registerMacro("lastUserMessage", ({ runtime }) => runtime.latestUserMessage ?? "");
registerMacro("selectedTools", renderSelectedTools);
registerMacro("tools", renderSelectedTools);
registerMacro("activeModel", ({ runtime }) => {
	const model = runtime.ctx?.model;
	return model ? `${model.provider}/${model.id}` : "";
});

registerMacro("setvar", renderSetVariable);
registerMacro("setturnvar", renderSetVariable);
registerMacro("setsessionvar", renderSetVariable);
registerMacro("getvar", renderGetVariable);
registerMacro("var", renderGetVariable);
registerMacro("getturnvar", renderGetVariable);
registerMacro("getsessionvar", renderGetVariable);
registerMacro("clearvar", renderClearVariable);
registerMacro("clearturnvar", renderClearVariable);
registerMacro("clearsessionvar", renderClearVariable);

registerMacro("trim", ({ expandArg }) => expandArg(0).trim());
registerMacro("upper", ({ expandArg }) => expandArg(0).toUpperCase());
registerMacro("lower", ({ expandArg }) => expandArg(0).toLowerCase());
registerMacro("json", ({ expandArg }) => JSON.stringify(expandArg(0)));
registerMacro("xml", ({ expandArg }) => escapeXml(expandArg(0)));

export function expandMacros(
	text: string,
	stack: PromptStack,
	runtime: PromptRuntime,
	diagnostics: PromptStackDiagnostic[],
	itemId: string,
): string {
	const policy = stack.defaults?.unresolvedMacroPolicy ?? "warn";
	const state: MacroExpansionState = { stack, runtime, unknown: new Set<string>() };
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

function registerMacro(name: string, handler: MacroHandler): void {
	BUILTIN_MACROS.set(name, handler);
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
	const handler = BUILTIN_MACROS.get(command);
	if (handler) {
		const value = handler(createMacroRenderContext(command, rawArgs, state));
		if (value !== undefined) return value;
		state.unknown.add(expression);
		return fullMacro;
	}

	const variableValue = getRuntimeVariable(state.runtime, state.stack, command);
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
): MacroRenderContext {
	const expandedArgs = new Map<number, string>();

	const expandArg = (index: number): string => {
		if (!expandedArgs.has(index)) {
			expandedArgs.set(index, expandMacroText(rawArgs[index] ?? "", state));
		}
		return expandedArgs.get(index) ?? "";
	};

	return {
		command,
		stack: state.stack,
		runtime: state.runtime,
		rawArgs,
		expandArg,
		expandJoinedArgs: (startIndex: number) =>
			rawArgs.slice(startIndex).map((_, offset) => expandArg(startIndex + offset)).join("::"),
	};
}

function renderSetVariable(context: MacroRenderContext): string | undefined {
	const scoped = context.command === "setvar" && isVariableScope(context.expandArg(0).trim());
	const scope = context.command === "setsessionvar" || (scoped && context.expandArg(0).trim() === "session")
		? "session"
		: "turn";
	const nameIndex = scoped ? 1 : 0;
	const valueIndex = nameIndex + 1;
	const name = context.expandArg(nameIndex).trim();
	if (!name) return undefined;

	setRuntimeVariable(context.runtime, scope, name, context.expandJoinedArgs(valueIndex));
	return "";
}

function renderGetVariable(context: MacroRenderContext): string | undefined {
	const name = context.expandArg(0).trim();
	if (!name) return undefined;

	if (context.command === "getturnvar") return variableValueToMacroText(context.runtime.variables?.turn[name]);
	if (context.command === "getsessionvar") return variableValueToMacroText(context.runtime.variables?.session[name]);
	return variableValueToMacroText(getRuntimeVariable(context.runtime, context.stack, name));
}

function renderClearVariable(context: MacroRenderContext): string | undefined {
	const scoped = context.command === "clearvar" && isVariableScope(context.expandArg(0).trim());
	const scope = context.command === "clearsessionvar" || (scoped && context.expandArg(0).trim() === "session")
		? "session"
		: "turn";
	const name = context.expandArg(scoped ? 1 : 0).trim();
	if (!name) return undefined;

	clearRuntimeVariable(context.runtime, scope, name);
	return "";
}

function renderSelectedTools({ stack, runtime }: MacroRenderContext): string {
	return applyResourcePolicy(runtime.options.selectedTools ?? [], stack.tools).join(", ");
}

function isVariableScope(value: string): value is PromptVariableScope {
	return value === "turn" || value === "session";
}

function variableValueToMacroText(value: PromptVariableValue | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function getRuntimeVariable(runtime: PromptRuntime, stack: PromptStack, name: string): PromptVariableValue | undefined {
	if (runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.turn, name)) return runtime.variables.turn[name];
	if (runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.session, name)) return runtime.variables.session[name];
	const staticVariables = collectStaticVariables(stack);
	if (Object.prototype.hasOwnProperty.call(staticVariables, name)) return staticVariables[name];
	return undefined;
}

function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue> {
	return { ...(stack.variables ?? {}) };
}

function setRuntimeVariable(runtime: PromptRuntime, scope: PromptVariableScope, name: string, value: string): void {
	if (!runtime.variables) return;
	if (scope === "session") {
		if (runtime.variables.session[name] !== value) {
			runtime.variables.session[name] = value;
			runtime.variables.sessionDirty = true;
		}
		return;
	}
	runtime.variables.turn[name] = value;
}

function clearRuntimeVariable(runtime: PromptRuntime, scope: PromptVariableScope, name: string): void {
	if (!runtime.variables) return;
	if (scope === "session") {
		if (Object.prototype.hasOwnProperty.call(runtime.variables.session, name)) {
			delete runtime.variables.session[name];
			runtime.variables.sessionDirty = true;
		}
		return;
	}
	delete runtime.variables.turn[name];
}

function formatDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatTime(now: Date): string {
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
