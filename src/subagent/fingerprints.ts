import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import {
	canonicalJson,
	fingerprintJson,
	JSON_FINGERPRINT_PREFIX,
	type JsonFingerprint,
} from "../json-fingerprint.ts";

/** Legacy host names retain their byte-identical public wire contract. */
export const SUBAGENT_FINGERPRINT_PREFIX = JSON_FINGERPRINT_PREFIX;
export type SubagentFingerprint = JsonFingerprint;

export function canonicalSubagentJson(value: unknown): string {
	return canonicalJson(value);
}

export function subagentFingerprint(value: unknown): SubagentFingerprint {
	return fingerprintJson(value);
}

/** Host-owned source provenance: profile and prompt-stack content fingerprints. */
export function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint {
	return subagentFingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint {
	return subagentFingerprint(stack);
}
