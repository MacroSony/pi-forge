import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import {
	fingerprint,
	type Fingerprint,
} from "@zihanw/pi-subagent-runtime";

/**
 * Canonical serialization and fingerprints are owned by
 * @zihanw/pi-subagent-runtime core. Forge re-exports them under the
 * `Subagent`-prefixed names the 0.4 host contract always used, so callers
 * stay source-compatible while the single portable definition lives in the
 * runtime package. The exposed algorithms are identical, so existing
 * fingerprint values are unchanged.
 *
 * Note: conversation and execution fingerprints are issued only by the
 * runtime during plan sealing; the host never computes them. The helpers
 * below cover host-owned source provenance (profiles and prompt stacks).
 */
export { canonicalJson as canonicalSubagentJson } from "@zihanw/pi-subagent-runtime";
export { fingerprint as subagentFingerprint } from "@zihanw/pi-subagent-runtime";
export { FINGERPRINT_PREFIX as SUBAGENT_FINGERPRINT_PREFIX } from "@zihanw/pi-subagent-runtime";
export { promptRuntimeFingerprint as subagentPromptRuntimeFingerprint } from "@zihanw/pi-subagent-runtime";

export function subagentSourceProfileFingerprint(profile: AgentProfile): Fingerprint {
	return fingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): Fingerprint {
	return fingerprint(stack);
}
