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
    // Keep the last compiled system prompt/runtime available to /preset use and
    // /profile use after agent_end; those commands are normally issued while idle.
    state.contextRewritePending = false;
}
//# sourceMappingURL=compile-cycle.js.map