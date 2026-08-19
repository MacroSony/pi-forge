import { createHash } from "node:crypto";
import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";

/**
 * Forge-owned canonical JSON + `sha256:v1` fingerprints.
 *
 * Vendored from @zihanw/pi-subagent-runtime's canonical implementation so the
 * main package carries no runtime dependency. The algorithm is byte-for-byte
 * identical (key-sorted plain objects, undefined properties omitted, finite
 * numbers only, -0 normalized, no cycles/sparse arrays/non-plain objects), so
 * fingerprints the host issues into profile snapshots stay comparable with
 * values the optional package recomputes through the runtime. Golden vectors
 * are pinned in tests/subagent-host.test.ts.
 *
 * The host never computes conversation/execution fingerprints; those are
 * issued by the runtime during plan sealing in the optional package.
 */

export const SUBAGENT_FINGERPRINT_PREFIX = "sha256:v1:" as const;
export type SubagentFingerprint = `${typeof SUBAGENT_FINGERPRINT_PREFIX}${string}`;

export function canonicalSubagentJson(value: unknown): string {
	return canonicalize(value, "$", new Set());
}

export function subagentFingerprint(value: unknown): SubagentFingerprint {
	const digest = createHash("sha256")
		.update(canonicalSubagentJson(value))
		.digest("hex");
	return `${SUBAGENT_FINGERPRINT_PREFIX}${digest}`;
}

/** Host-owned source provenance: profile and prompt-stack content fingerprints. */
export function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint {
	return subagentFingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint {
	return subagentFingerprint(stack);
}

function canonicalize(value: unknown, path: string, ancestors: Set<unknown>): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(`Cannot fingerprint non-finite number at ${path}.`);
		}
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (typeof value !== "object" || value === undefined) {
		throw new TypeError(`Cannot fingerprint ${typeof value} at ${path}.`);
	}
	if (ancestors.has(value)) {
		throw new TypeError(`Cannot fingerprint cyclic value at ${path}.`);
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const items: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) {
					throw new TypeError(`Cannot fingerprint sparse array item at ${path}[${index}].`);
				}
				items.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
			}
			return `[${items.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`Cannot fingerprint non-plain object at ${path}.`);
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		const properties = keys.map((key) => {
			const property = canonicalize(record[key], `${path}.${key}`, ancestors);
			return `${JSON.stringify(key)}:${property}`;
		});
		return `{${properties.join(",")}}`;
	}
	finally {
		ancestors.delete(value);
	}
}
