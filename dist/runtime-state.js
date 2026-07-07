export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
export function createRuntimeState() {
    return {
        stacks: [],
        contextRewritePending: false,
        sessionVariables: {},
        latestCompileDiagnostics: [],
        interceptNextProviderPayload: false,
        interceptPayloadDisplayTarget: "editor",
    };
}
//# sourceMappingURL=runtime-state.js.map