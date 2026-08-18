export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
export function createRuntimeState() {
    return {
        stacks: [],
        profiles: [],
        contextRewritePending: false,
        latestCompileDiagnostics: [],
        forgeExtensionDiagnostics: [],
        forgeExtensionPaths: [],
        interceptNextProviderPayload: false,
        interceptPayloadDisplayTarget: "editor",
    };
}
//# sourceMappingURL=runtime-state.js.map