import { isAgentProfileProvenance } from "./agent-profile.js";
export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
/**
 * Session persistence bookkeeping. This owns reading/writing pi-forge's custom
 * session entries so lifecycle, profile-service, and stack runtime do not each
 * reach into the session format.
 */
export function getCurrentBranchEntries(ctx) {
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === null)
        return [];
    const sessionManager = ctx.sessionManager;
    return sessionManager.getBranch ? sessionManager.getBranch(leafId ?? undefined) : sessionManager.getEntries();
}
export function getRestoredActiveId(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
            return typeof entry.data?.activeStackId === "string" ? entry.data.activeStackId : undefined;
        }
    }
    return undefined;
}
export function getRestoredProfileProvenance(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY_TYPE)
            continue;
        if (entry.data?.provenance === null)
            return undefined;
        return isAgentProfileProvenance(entry.data?.provenance) ? entry.data.provenance : undefined;
    }
    return undefined;
}
export function getLegacyVariableStateDiagnostic(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    const hasLegacyVariableState = entries.some((entry) => {
        const candidate = entry;
        return candidate?.type === "custom" && candidate?.customType === "pi-forge-variable-state";
    });
    if (!hasLegacyVariableState)
        return [];
    return [{
            level: "info",
            message: "Legacy pi-forge-variable-state entries are ignored; mutable session variables were removed in 0.5.0.",
        }];
}
export function persistActiveSelection(pi, activeStackId) {
    pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId });
}
export function persistProfileProvenance(pi, provenance) {
    pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance });
}
//# sourceMappingURL=session-adapter.js.map