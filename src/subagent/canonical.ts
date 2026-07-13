import { createHash } from "node:crypto";
import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import { SUBAGENT_FINGERPRINT_PREFIX, type AgentExecutionPlan, type SubagentFingerprint } from "./types.ts";

export function canonicalSubagentJson(value: unknown): string {
	return canonicalize(value, "$", new Set<object>());
}

export function subagentFingerprint(value: unknown): SubagentFingerprint {
	return `${SUBAGENT_FINGERPRINT_PREFIX}${createHash("sha256").update(canonicalSubagentJson(value)).digest("hex")}`;
}

export function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint {
	return subagentFingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint {
	return subagentFingerprint(stack);
}

export function subagentExecutionFingerprint(plan: Omit<AgentExecutionPlan, "executionFingerprint"> | AgentExecutionPlan): SubagentFingerprint {
	const { executionFingerprint: _ignored, ...behavior } = plan as AgentExecutionPlan;
	return subagentFingerprint(behavior);
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`Cannot fingerprint non-finite number at ${path}.`);
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (typeof value !== "object") throw new TypeError(`Cannot fingerprint ${typeof value} at ${path}.`);
	if (ancestors.has(value)) throw new TypeError(`Cannot fingerprint cyclic value at ${path}.`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors)).join(",")}]`;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Cannot fingerprint non-plain object at ${path}.`);
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, ancestors)}`).join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}
