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
export declare const SUBAGENT_FINGERPRINT_PREFIX: "sha256:v1:";
export type SubagentFingerprint = `${typeof SUBAGENT_FINGERPRINT_PREFIX}${string}`;
export declare function canonicalSubagentJson(value: unknown): string;
export declare function subagentFingerprint(value: unknown): SubagentFingerprint;
/** Host-owned source provenance: profile and prompt-stack content fingerprints. */
export declare function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint;
export declare function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint;
//# sourceMappingURL=fingerprints.d.ts.map