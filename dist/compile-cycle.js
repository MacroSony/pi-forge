export function createCompileCycleState() {
    return {
        contextRewritePending: false,
        latestCompileDiagnostics: [],
    };
}
export function resetCompileCycle(state) {
    state.currentSystemPromptOptions = undefined;
    state.currentLatestUserMessage = undefined;
    state.currentCompilationContext = undefined;
    state.contextRewritePending = false;
}
//# sourceMappingURL=compile-cycle.js.map