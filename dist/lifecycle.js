import { compileMessages, getLatestUserMessage, } from "./compiler.js";
import { PromptCompilationContext } from "./compiler.js";
import { applyFinalizeRegexRulesToMessage } from "./regex.js";
import { isAgentProfileProvenance } from "./agent-profile.js";
import { PROFILE_ENTRY_TYPE, STATE_ENTRY_TYPE } from "./runtime-state.js";
export function registerLifecycleHandlers(pi, state, deps) {
    let startupToolPolicyPending = false;
    pi.on("session_shutdown", async () => {
        // Pi carries the old runtime's active built-in tool names into a replacement
        // runtime. Restore the pre-policy set before reload/session replacement so the
        // replacement pi-forge instance can capture a complete baseline.
        startupToolPolicyPending = false;
        deps.restoreActiveToolPolicy();
        // Tear down the host first so a throwing subagent disposal cannot leak a
        // live host that keeps advertising the stale snapshot.
        deps.disposeForgeWorkspace();
        deps.disposePromptStackRuntime();
    });
    pi.on("session_start", async (event, ctx) => {
        startupToolPolicyPending = true;
        try {
            const freshSession = shouldAutoActivateForSessionStart(event, ctx);
            await restoreBranchScopedRuntime(ctx, state, deps, { deferToolPolicy: true, suppressAutoActivate: freshSession });
            if (freshSession)
                await deps.activateFreshSessionDefaults(ctx);
        }
        catch (error) {
            startupToolPolicyPending = false;
            throw error;
        }
        deps.reloadForgeWorkspace(ctx);
        deps.refreshWebEditorHost(ctx);
        deps.notifyActivePreset(ctx, "after session " + event.reason);
    });
    pi.on("resources_discover", async (_event, ctx) => {
        if (!startupToolPolicyPending)
            return;
        startupToolPolicyPending = false;
        deps.syncActiveToolPolicy(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
        await restoreBranchScopedRuntime(ctx, state, deps);
        deps.reloadForgeWorkspace(ctx);
        deps.refreshWebEditorHost(ctx);
        deps.notifyActivePreset(ctx, "after tree navigation");
    });
    pi.on("session_compact", async (_event, ctx) => {
        await restoreBranchScopedRuntime(ctx, state, deps);
        deps.reloadForgeWorkspace(ctx);
        deps.refreshWebEditorHost(ctx);
        deps.notifyActivePreset(ctx, "after compaction");
    });
    pi.on("turn_start", async () => {
        deps.syncActiveToolPolicy();
        deps.persistActiveSelection();
    });
    pi.on("input", async () => {
        deps.syncActiveToolPolicy();
    });
    pi.on("tool_call", async (event) => {
        const reason = deps.toolPolicyBlockReason(event.toolName);
        return reason ? { block: true, reason } : undefined;
    });
    pi.on("before_agent_start", async (event, ctx) => {
        state.currentSystemPromptOptions = event.systemPromptOptions;
        deps.refreshWebEditorHost(ctx, event.systemPromptOptions);
        state.currentLatestUserMessage = event.prompt;
        state.contextRewritePending = true;
        if (!state.active)
            return;
        const compilationRuntime = { options: event.systemPromptOptions, ctx, latestUserMessage: event.prompt, now: new Date() };
        state.currentCompilationContext = new PromptCompilationContext(state.active.stack, compilationRuntime);
        const result = state.currentCompilationContext.compileSystemPrompt(event.systemPrompt);
        deps.recordCompileDiagnostics(ctx, result.diagnostics);
        return { systemPrompt: result.systemPrompt };
    });
    pi.on("context", async (event, ctx) => {
        if (!state.active || !state.currentSystemPromptOptions || !state.contextRewritePending)
            return;
        // Rewrite the message layout only for the first provider request of a user-submitted prompt.
        // Tool-result follow-up turns must receive Pi's natural context; otherwise post-history
        // prompt blocks such as COT / {{lastUserMessage}} are re-appended after every tool call
        // and the model restarts its planning instead of continuing from the tool result.
        state.contextRewritePending = false;
        const latestUserMessage = getLatestUserMessage(event.messages) ?? state.currentLatestUserMessage;
        state.currentCompilationContext?.setLatestUserMessage(latestUserMessage ?? "");
        const result = state.currentCompilationContext
            ? state.currentCompilationContext.compileMessages(event.messages)
            : compileMessages(state.active.stack, { options: state.currentSystemPromptOptions, ctx, latestUserMessage, now: new Date() }, event.messages);
        deps.recordCompileDiagnostics(ctx, [...state.latestCompileDiagnostics, ...result.diagnostics]);
        return { messages: result.messages };
    });
    pi.on("message_end", async (event, ctx) => {
        if (!state.active)
            return;
        const diagnostics = [];
        const message = applyFinalizeRegexRulesToMessage(state.active.stack, event.message, diagnostics);
        if (diagnostics.length > 0)
            deps.recordCompileDiagnostics(ctx, [...state.latestCompileDiagnostics, ...diagnostics]);
        if (!message)
            return;
        return { message };
    });
    pi.on("agent_end", async () => {
        state.currentSystemPromptOptions = undefined;
        state.currentLatestUserMessage = undefined;
        state.currentCompilationContext = undefined;
        state.contextRewritePending = false;
    });
}
async function restoreBranchScopedRuntime(ctx, state, deps, options) {
    state.lastAppliedProfile = getRestoredProfileProvenance(ctx);
    state.currentCompilationContext = undefined;
    state.latestCompileDiagnostics = getLegacyVariableStateDiagnostic(ctx);
    const restoredActiveId = getRestoredActiveId(ctx);
    state.lastPersistedActiveId = restoredActiveId;
    await deps.reloadStacks(ctx, restoredActiveId, options);
}
function shouldAutoActivateForSessionStart(event, ctx) {
    if (event.reason === "new")
        return true;
    if (event.reason !== "startup")
        return false;
    return isFreshStartupBranch(getCurrentBranchEntries(ctx));
}
function isFreshStartupBranch(entries) {
    if (entries.length === 0)
        return true;
    let modelChanges = 0;
    let thinkingLevelChanges = 0;
    for (const entry of entries) {
        if (!entry || typeof entry !== "object")
            return false;
        const type = entry.type;
        if (type === "model_change") {
            modelChanges += 1;
            if (modelChanges > 1)
                return false;
            continue;
        }
        if (type === "thinking_level_change") {
            thinkingLevelChanges += 1;
            if (thinkingLevelChanges > 1)
                return false;
            continue;
        }
        if (type === "session_info")
            continue;
        return false;
    }
    // Pi 0.82 writes the initial thinking level, and the model when one is
    // selected, before extensions receive the first startup event. A previously
    // opened empty session receives another bootstrap pair, so the count limits
    // above keep it from being mistaken for a newly created session.
    return thinkingLevelChanges === 1;
}
function getLegacyVariableStateDiagnostic(ctx) {
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
function getRestoredProfileProvenance(ctx) {
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
function getCurrentBranchEntries(ctx) {
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === null)
        return [];
    const sessionManager = ctx.sessionManager;
    return sessionManager.getBranch ? sessionManager.getBranch(leafId ?? undefined) : sessionManager.getEntries();
}
function getRestoredActiveId(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
            return typeof entry.data?.activeStackId === "string" ? entry.data.activeStackId : undefined;
        }
    }
    return undefined;
}
//# sourceMappingURL=lifecycle.js.map