import { canonicalJson, fingerprintJson, JSON_FINGERPRINT_PREFIX, } from "../json-fingerprint.js";
/** Legacy host names retain their byte-identical public wire contract. */
export const SUBAGENT_FINGERPRINT_PREFIX = JSON_FINGERPRINT_PREFIX;
export function canonicalSubagentJson(value) {
    return canonicalJson(value);
}
export function subagentFingerprint(value) {
    return fingerprintJson(value);
}
/** Host-owned source provenance: profile and prompt-stack content fingerprints. */
export function subagentSourceProfileFingerprint(profile) {
    return subagentFingerprint(profile);
}
export function subagentPromptStackFingerprint(stack) {
    return subagentFingerprint(stack);
}
//# sourceMappingURL=fingerprints.js.map