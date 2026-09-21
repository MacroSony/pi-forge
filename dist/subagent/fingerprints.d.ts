import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import { type JsonFingerprint } from "../json-fingerprint.ts";
/** Legacy host names retain their byte-identical public wire contract. */
export declare const SUBAGENT_FINGERPRINT_PREFIX: "sha256:v1:";
export type SubagentFingerprint = JsonFingerprint;
export declare function canonicalSubagentJson(value: unknown): string;
export declare function subagentFingerprint(value: unknown): SubagentFingerprint;
/** Host-owned source provenance: profile and prompt-stack content fingerprints. */
export declare function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint;
export declare function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint;
//# sourceMappingURL=fingerprints.d.ts.map