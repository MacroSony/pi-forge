import { applyResourcePolicy } from "./policy.ts";
import type {
	PromptRuntime,
	PromptStack,
	PromptStackSlotFormat,
	PromptStackSlotItem,
	PromptVariableValue,
} from "./types.ts";

export type PromptVariableScope = "static" | "session" | "turn";
export type PromptWritableVariableScope = "session" | "turn";

export interface PromptVariableAccess {
	get(name: string, scope?: PromptVariableScope | "any"): PromptVariableValue | undefined;
	set(scope: PromptWritableVariableScope, name: string, value: string): void;
	clear(scope: PromptWritableVariableScope, name: string): void;
	toMacroText(value: PromptVariableValue | undefined): string;
	toPromptText(value: PromptVariableValue): string;
}

export interface PromptRenderHelpers {
	escapeXml(value: string): string;
	formatDate(now: Date): string;
	formatTime(now: Date): string;
	normalizePath(value: string): string;
	selectedToolNames(stack: PromptStack, runtime: PromptRuntime): string[];
	slotTextFormat(item: PromptStackSlotItem, options?: { allowJson?: boolean }): PromptStackSlotFormat;
	plainBullet(label: string, value: string): string;
	plainContinuation(value: string, indent: string): string;
	indentPlainBlock(value: string, indent: string): string;
}

export const promptRenderHelpers: PromptRenderHelpers = {
	escapeXml,
	formatDate,
	formatTime,
	normalizePath,
	selectedToolNames,
	slotTextFormat,
	plainBullet,
	plainContinuation,
	indentPlainBlock,
};

export function createVariableAccess(runtime: PromptRuntime, stack: PromptStack): PromptVariableAccess {
	return {
		get: (name, scope = "any") => getRuntimeVariable(runtime, stack, name, scope),
		set: (scope, name, value) => setRuntimeVariable(runtime, scope, name, value),
		clear: (scope, name) => clearRuntimeVariable(runtime, scope, name),
		toMacroText: variableValueToMacroText,
		toPromptText: variableValueToPromptText,
	};
}

export function selectedToolNames(stack: PromptStack, runtime: PromptRuntime): string[] {
	return applyResourcePolicy(runtime.options.selectedTools ?? [], stack.tools);
}

export function slotTextFormat(item: PromptStackSlotItem, options: { allowJson?: boolean } = {}): PromptStackSlotFormat {
	const format = item.options?.format;
	if (format === "plain") return "plain";
	if (format === "json" && options.allowJson) return "json";
	return "xml";
}

export function selectedVariableScopes(options: Record<string, unknown>): PromptVariableScope[] {
	const scopes: PromptVariableScope[] = [];
	if (options.includeStatic !== false) scopes.push("static");
	if (options.includeSession !== false) scopes.push("session");
	if (options.includeTurn !== false) scopes.push("turn");
	return scopes;
}

export function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue> {
	return { ...(stack.variables ?? {}) };
}

export function getRuntimeVariable(
	runtime: PromptRuntime,
	stack: PromptStack,
	name: string,
	scope: PromptVariableScope | "any" = "any",
): PromptVariableValue | undefined {
	if ((scope === "turn" || scope === "any") && runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.turn, name)) {
		return runtime.variables.turn[name];
	}
	if ((scope === "session" || scope === "any") && runtime.variables && Object.prototype.hasOwnProperty.call(runtime.variables.session, name)) {
		return runtime.variables.session[name];
	}
	if (scope === "static" || scope === "any") {
		const staticVariables = collectStaticVariables(stack);
		if (Object.prototype.hasOwnProperty.call(staticVariables, name)) return staticVariables[name];
	}
	return undefined;
}

export function setRuntimeVariable(runtime: PromptRuntime, scope: PromptWritableVariableScope, name: string, value: string): void {
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

export function clearRuntimeVariable(runtime: PromptRuntime, scope: PromptWritableVariableScope, name: string): void {
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

export function variableValueToMacroText(value: PromptVariableValue | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function variableValueToPromptText(value: PromptVariableValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

export function plainBullet(label: string, value: string): string {
	return `- ${label}: ${plainContinuation(value, "  ")}`;
}

export function plainContinuation(value: string, indent: string): string {
	return value.split("\n").map((line, index) => index === 0 ? line : `${indent}${line}`).join("\n");
}

export function indentPlainBlock(value: string, indent: string): string {
	return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}

export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function formatDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function formatTime(now: Date): string {
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
