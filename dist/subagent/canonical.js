import { fingerprint, } from "@zihanw/pi-subagent-runtime";
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
export function subagentSourceProfileFingerprint(profile) {
    return fingerprint(profile);
}
export function subagentPromptStackFingerprint(stack) {
    return fingerprint(stack);
}
export function subagentPromptRuntimeFingerprint(runtime) {
    const { promptRuntimeFingerprint: _ignored, ...behavior } = runtime;
    return fingerprint(behavior);
}
export function subagentExecutionFingerprint(plan) {
    const { executionFingerprint: _ignored, ...behavior } = plan;
    return fingerprint(behavior);
}
//# sourceMappingURL=canonical.js.map