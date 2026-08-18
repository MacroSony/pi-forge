import { applyResourcePolicy } from "./policy.ts";
import type {
	PromptRuntime,
	PromptStack,
	PromptStackSlotFormat,
	PromptStackSlotItem,
	PromptVariableValue,
} from "./types.ts";

export interface PromptVariableAccess {
	get(name: string): PromptVariableValue | undefined;
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

export function createVariableAccess(_runtime: PromptRuntime, stack: PromptStack): PromptVariableAccess {
	return {
		get: (name) => collectStaticVariables(stack)[name],
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

export function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue> {
	return { ...(stack.variables ?? {}) };
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
