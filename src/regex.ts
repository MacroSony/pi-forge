import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	PromptRegexEffect,
	PromptRegexRule,
	PromptRegexStage,
	PromptRegexTarget,
	PromptStack,
	PromptStackDiagnostic,
} from "./types.ts";

const ALLOWED_REGEX_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const VALID_STAGES = new Set(["history", "compiled"]);
const VALID_EFFECTS = new Set(["outgoing", "display", "both", "finalize"]);
const VALID_TARGETS = new Set(["system", "messages"]);

interface CompiledRegexRule {
	id: string;
	stage: PromptRegexStage;
	effect: PromptRegexEffect;
	targets?: PromptRegexTarget[];
	roles?: string[];
	maxMessages?: number;
	maxChars?: number;
	regexp: RegExp;
	replace: string;
}

interface StringTransformResult {
	text: string;
	matches: number;
	changed: boolean;
}

interface RegexStats {
	matches: number;
	changedSegments: number;
}

export function validateRegexConfig(config: unknown): PromptStackDiagnostic[] {
	const diagnostics: PromptStackDiagnostic[] = [];
	if (config === undefined) return diagnostics;
	if (!isPlainObject(config)) {
		diagnostics.push({ level: "warning", message: "regex must be an object when provided." });
		return diagnostics;
	}

	if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
		diagnostics.push({ level: "warning", message: "Missing or unsupported regex.schemaVersion; assuming 1." });
	}

	const rawRules = config.rules;
	if (rawRules === undefined) return diagnostics;
	if (!Array.isArray(rawRules)) {
		diagnostics.push({ level: "error", message: "regex.rules must be an array when provided." });
		return diagnostics;
	}

	const seenIds = new Set<string>();
	for (const [index, rawRule] of rawRules.entries()) {
		validateRule(rawRule, index, seenIds, diagnostics);
	}
	return diagnostics;
}

export function applyRegexRulesToString(
	stack: PromptStack,
	text: string,
	stage: PromptRegexStage,
	target: PromptRegexTarget,
	diagnostics: PromptStackDiagnostic[],
): string {
	let result = text;
	for (const rule of regexRulesFor(stack, stage, target, "outgoing", diagnostics)) {
		const transformed = transformString(result, rule);
		result = transformed.text;
		addRuleStats(diagnostics, rule, stage, target, {
			matches: transformed.matches,
			changedSegments: transformed.changed ? 1 : 0,
		});
	}
	return result;
}

export function applyRegexRulesToMessages(
	stack: PromptStack,
	messages: AgentMessage[],
	stage: PromptRegexStage,
	diagnostics: PromptStackDiagnostic[],
): AgentMessage[] {
	let result = messages;
	for (const rule of regexRulesFor(stack, stage, "messages", "outgoing", diagnostics)) {
		const stats: RegexStats = { matches: 0, changedSegments: 0 };
		result = transformMessages(result, rule, stats);
		addRuleStats(diagnostics, rule, stage, "messages", stats);
	}
	return result;
}

export function applyFinalizeRegexRulesToMessage(
	stack: PromptStack,
	message: AgentMessage,
	diagnostics: PromptStackDiagnostic[],
): AgentMessage | undefined {
	if (String((message as { role?: unknown }).role) !== "assistant") return undefined;

	let result = message;
	for (const rule of regexRulesFor(stack, "compiled", "messages", "finalize", diagnostics)) {
		const stats: RegexStats = { matches: 0, changedSegments: 0 };
		const [next = result] = transformMessages([result], rule, stats);
		result = next;
		addRuleStats(diagnostics, rule, "finalize", "messages", stats);
	}

	if (result === message) return undefined;
	diagnostics.push({
		level: "warning",
		message: "Finalize regex replaced finalized assistant message content; original model output is not preserved in the stored transcript.",
	});
	return result;
}

function validateRule(rawRule: unknown, index: number, seenIds: Set<string>, diagnostics: PromptStackDiagnostic[]): void {
	const label = `regex rule ${index + 1}`;
	if (!isPlainObject(rawRule)) {
		diagnostics.push({ level: "error", message: `${label} must be an object.` });
		return;
	}

	const id = typeof rawRule.id === "string" ? rawRule.id.trim() : "";
	if (!id) {
		diagnostics.push({ level: "error", message: `${label} must have a non-empty id.` });
	} else if (seenIds.has(id)) {
		diagnostics.push({ level: "error", message: `Duplicate regex rule id: ${id}.` });
	} else {
		seenIds.add(id);
	}

	if (rawRule.enabled !== undefined && typeof rawRule.enabled !== "boolean") {
		diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} enabled must be a boolean when provided.` });
	}

	if (!VALID_STAGES.has(rawRule.stage as string)) {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} stage must be "history" or "compiled".` });
	}

	const effect = typeof rawRule.effect === "string" ? rawRule.effect : undefined;
	if (rawRule.effect !== undefined) {
		if (!VALID_EFFECTS.has(rawRule.effect as string)) {
			diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect must be "outgoing", "display", "both", or "finalize".` });
		} else if (rawRule.effect === "display") {
			diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "display" is not a runtime effect in pi-forge yet and will be ignored. Use "finalize" only when destructive transcript cleanup is intended.` });
		} else if (rawRule.effect === "both") {
			diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "both" is not implemented and will be ignored; use separate outgoing and finalize rules.` });
		} else if (rawRule.effect === "finalize") {
			diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "finalize" rewrites finalized assistant messages and replaces the original model output in the stored transcript.` });
		}
	}
	if (effect === "finalize" && rawRule.stage !== "compiled") {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect "finalize" requires stage "compiled".` });
	}

	if (typeof rawRule.pattern !== "string" || rawRule.pattern.length === 0) {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} pattern must be a non-empty string.` });
	} else {
		const flagsError = validateRegexFlags(rawRule.flags, id, index);
		if (flagsError) diagnostics.push({ level: "error", message: flagsError });
		else {
			try {
				new RegExp(rawRule.pattern, typeof rawRule.flags === "string" ? rawRule.flags : "");
			} catch (error) {
				diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} pattern failed to compile: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
	}

	if (rawRule.replace !== undefined && typeof rawRule.replace !== "string") {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} replace must be a string when provided.` });
	}
	if (rawRule.roles !== undefined && !isStringArray(rawRule.roles)) {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} roles must be an array of strings when provided.` });
	}
	if (rawRule.targets !== undefined) {
		if (!isStringArray(rawRule.targets)) {
			diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} targets must be an array of strings when provided.` });
		} else {
			for (const target of rawRule.targets) {
				if (!VALID_TARGETS.has(target)) {
					diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} target must be "system" or "messages": ${target}.` });
				} else if (effect === "finalize" && target !== "messages") {
					diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect "finalize" only supports target "messages": ${target}.` });
				}
			}
		}
	}
	if (effect === "finalize" && isStringArray(rawRule.roles) && !rawRule.roles.includes("assistant")) {
		diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "finalize" only runs for finalized assistant messages, but roles does not include "assistant".` });
	}
	if (rawRule.maxMessages !== undefined && !isPositiveInteger(rawRule.maxMessages)) {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxMessages must be a positive integer when provided.` });
	}
	if (rawRule.maxChars !== undefined && !isPositiveInteger(rawRule.maxChars)) {
		diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxChars must be a positive integer when provided.` });
	}
}

function regexRulesFor(
	stack: PromptStack,
	stage: PromptRegexStage,
	target: PromptRegexTarget,
	effect: PromptRegexEffect,
	diagnostics: PromptStackDiagnostic[],
): CompiledRegexRule[] {
	const rules = Array.isArray(stack.regex?.rules) ? stack.regex.rules : [];
	const compiled: CompiledRegexRule[] = [];

	for (const rawRule of rules) {
		if (!isPlainObject(rawRule)) continue;
		if (rawRule.enabled === false) continue;
		if ((rawRule.effect ?? "outgoing") !== effect) continue;
		if (rawRule.stage !== stage) continue;
		if (stage === "compiled" && Array.isArray(rawRule.targets) && !rawRule.targets.includes(target)) continue;

		const rule = compileRuntimeRule(rawRule as unknown as PromptRegexRule, diagnostics);
		if (rule) compiled.push(rule);
	}

	return compiled;
}

function compileRuntimeRule(rule: PromptRegexRule, diagnostics: PromptStackDiagnostic[]): CompiledRegexRule | undefined {
	if (typeof rule.id !== "string" || !rule.id.trim()) return undefined;
	if (rule.stage !== "history" && rule.stage !== "compiled") return undefined;
	const effect = rule.effect ?? "outgoing";
	if (!VALID_EFFECTS.has(effect)) return undefined;
	if (typeof rule.pattern !== "string" || rule.pattern.length === 0) return undefined;
	const flags = typeof rule.flags === "string" ? rule.flags : "";
	const flagsError = validateRegexFlags(flags, rule.id, -1);
	if (flagsError) return undefined;
	try {
		return {
			id: rule.id.trim(),
			stage: rule.stage,
			effect,
			targets: normalizeTargets(rule.targets),
			roles: isStringArray(rule.roles) ? rule.roles : undefined,
			maxMessages: isPositiveInteger(rule.maxMessages) ? Math.floor(rule.maxMessages) : undefined,
			maxChars: isPositiveInteger(rule.maxChars) ? Math.floor(rule.maxChars) : undefined,
			regexp: new RegExp(rule.pattern, flags),
			replace: typeof rule.replace === "string" ? rule.replace : "",
		};
	} catch (error) {
		diagnostics.push({ level: "error", message: `Regex rule ${rule.id} failed to compile: ${error instanceof Error ? error.message : String(error)}` });
		return undefined;
	}
}

function transformMessages(messages: AgentMessage[], rule: CompiledRegexRule, stats: RegexStats): AgentMessage[] {
	const eligible = eligibleMessageIndexes(messages, rule);
	const eligibleSet = new Set(rule.maxMessages ? eligible.slice(-rule.maxMessages) : eligible);
	let changed = false;

	const transformed = messages.map((message, index) => {
		if (!eligibleSet.has(index)) return message;
		const next = transformMessage(message, rule, stats);
		if (next !== message) changed = true;
		return next;
	});

	return changed ? transformed : messages;
}

function eligibleMessageIndexes(messages: AgentMessage[], rule: CompiledRegexRule): number[] {
	const indexes: number[] = [];
	for (const [index, message] of messages.entries()) {
		if (!rule.roles || rule.roles.includes(String((message as { role?: unknown }).role))) indexes.push(index);
	}
	return indexes;
}

function transformMessage(message: AgentMessage, rule: CompiledRegexRule, stats: RegexStats): AgentMessage {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		const result = transformString(content, rule);
		mergeStringStats(stats, result);
		return result.changed ? { ...message, content: result.text } as AgentMessage : message;
	}

	if (!Array.isArray(content)) return message;
	let changed = false;
	const nextContent = content.map((part) => {
		if (!isPlainObject(part) || part.type !== "text" || typeof part.text !== "string") return part;
		const result = transformString(part.text, rule);
		mergeStringStats(stats, result);
		if (!result.changed) return part;
		changed = true;
		return { ...part, text: result.text };
	});

	return changed ? { ...message, content: nextContent } as AgentMessage : message;
}

function transformString(text: string, rule: CompiledRegexRule): StringTransformResult {
	const headLength = rule.maxChars && text.length > rule.maxChars ? text.length - rule.maxChars : 0;
	const head = headLength > 0 ? text.slice(0, headLength) : "";
	const body = headLength > 0 ? text.slice(headLength) : text;
	const matches = countReplacementMatches(body, rule.regexp);
	const replaced = body.replace(rule.regexp, rule.replace);
	const result = head + replaced;
	return {
		text: result,
		matches,
		changed: result !== text,
	};
}

function countReplacementMatches(text: string, regexp: RegExp): number {
	if (!regexp.global) return new RegExp(regexp.source, regexp.flags.replace("g", "")).test(text) ? 1 : 0;

	const matcher = new RegExp(regexp.source, regexp.flags);
	let count = 0;
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(text)) !== null) {
		count++;
		if (match[0] === "") matcher.lastIndex++;
	}
	return count;
}

function mergeStringStats(stats: RegexStats, result: StringTransformResult): void {
	stats.matches += result.matches;
	if (result.changed) stats.changedSegments++;
}

function addRuleStats(
	diagnostics: PromptStackDiagnostic[],
	rule: CompiledRegexRule,
	stage: string,
	target: PromptRegexTarget,
	stats: RegexStats,
): void {
	if (stats.matches === 0) return;
	diagnostics.push({
		level: "info",
		message: `Regex rule ${rule.id} matched ${stats.matches} time(s) and changed ${stats.changedSegments} text segment(s) in ${stage}/${target}.`,
	});
}

function validateRegexFlags(value: unknown, id: string, index: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return `${regexRuleLabel(id, index)} flags must be a string when provided.`;
	const seen = new Set<string>();
	for (const flag of value) {
		if (!ALLOWED_REGEX_FLAGS.has(flag)) return `${regexRuleLabel(id, index)} has unsupported regex flag: ${flag}.`;
		if (seen.has(flag)) return `${regexRuleLabel(id, index)} has duplicate regex flag: ${flag}.`;
		seen.add(flag);
	}
	return undefined;
}

function normalizeTargets(value: unknown): PromptRegexTarget[] | undefined {
	if (!isStringArray(value)) return undefined;
	return value.filter((target): target is PromptRegexTarget => target === "system" || target === "messages");
}

function regexRuleLabel(id: string, index: number): string {
	return id ? `Regex rule ${id}` : `regex rule ${index + 1}`;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
