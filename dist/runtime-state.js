export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
export const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
export function createRuntimeState() {
    return {
        stacks: [],
        profiles: [],
        contextRewritePending: false,
        sessionVariables: {},
        latestCompileDiagnostics: [],
        forgeExtensionDiagnostics: [],
        forgeExtensionPaths: [],
        interceptNextProviderPayload: false,
        interceptPayloadDisplayTarget: "editor",
    };
}
//# sourceMappingURL=runtime-state.js.map