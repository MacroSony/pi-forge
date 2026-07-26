import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import {
	fingerprint,
	type Fingerprint,
} from "@zihanw/pi-subagent-runtime";
import type { AgentExecutionPlan, SubagentPreparationRuntime } from "./types.ts";

/**
 * Canonical serialization and fingerprints are owned by
 * @zihanw/pi-subagent-runtime core. Forge re-exports them under the
 * `Subagent`-prefixed names the 0.4 host contract always used, so callers
 * stay source-compatible while the single portable definition lives in the
 * runtime package. The exposed algorithms are identical, so existing
 * fingerprint values are unchanged.
 */
export { canonicalJson as canonicalSubagentJson } from "@zihanw/pi-subagent-runtime";
export { fingerprint as subagentFingerprint } from "@zihanw/pi-subagent-runtime";
export { FINGERPRINT_PREFIX as SUBAGENT_FINGERPRINT_PREFIX } from "@zihanw/pi-subagent-runtime";

export function subagentSourceProfileFingerprint(profile: AgentProfile): Fingerprint {
	return fingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): Fingerprint {
	return fingerprint(stack);
}

export function subagentPromptRuntimeFingerprint(
	runtime: Omit<SubagentPreparationRuntime, "promptRuntimeFingerprint"> | SubagentPreparationRuntime,
): Fingerprint {
	const { promptRuntimeFingerprint: _ignored, ...behavior } =
		runtime as SubagentPreparationRuntime;
	return fingerprint(behavior);
}

export function subagentExecutionFingerprint(
	plan: Omit<AgentExecutionPlan, "executionFingerprint"> | AgentExecutionPlan,
): Fingerprint {
	const { executionFingerprint: _ignored, ...behavior } =
		plan as AgentExecutionPlan;
	return fingerprint(behavior);
}