import type { PromptResourcePolicy } from "./types.ts";

export function hasResourcePolicy(policy: PromptResourcePolicy | undefined): boolean {
	return !!policy && (hasEffectiveAllowPolicy(policy.allow) || hasPatterns(policy.deny));
}

export function applyResourcePolicy(names: string[], policy: PromptResourcePolicy | undefined): string[] {
	if (!hasResourcePolicy(policy)) return names;
	if (hasEffectiveAllowPolicy(policy?.allow)) {
		return names.filter((name) => matchesAnyPattern(name, policy.allow!));
	}
	if (hasPatterns(policy?.deny)) {
		return names.filter((name) => !matchesAnyPattern(name, policy.deny!));
	}
	return names;
}

export function matchesAnyPattern(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => resourcePatternMatches(name, pattern));
}

export function resourcePatternMatches(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	const escaped = pattern
		.split("*")
		.map(escapeRegExp)
		.join(".*");
	return new RegExp(`^${escaped}$`).test(name);
}

function hasPatterns(value: string[] | undefined): value is string[] {
	return Array.isArray(value) && value.length > 0;
}

function hasEffectiveAllowPolicy(value: string[] | undefined): value is string[] {
	return hasPatterns(value) && value.some((pattern) => pattern !== "*");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
