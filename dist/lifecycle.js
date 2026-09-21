import { getPiBasePrompt, projectPresetSystemPrompt } from "./instruction-projection.js";
import { getLatestUserMessage, } from "./compiler.js";
import { PromptCompilationContext, dedupeDiagnostics } from "./compiler.js";
import { applyFinalizeRegexRulesToMessage, applyRequestFrequencyRulesToMessages, hasRequestFrequencyRules } from "./regex.js";
import { promptRuntimeFromPi } from "./prompt-runtime.js";
import { formatResourceKey } from "./resource-identity.js";
import { resetCompileCycle } from "./compile-cycle.js";
import { getCurrentBranchEntries, getLegacyVariableStateDiagnostic, getRestoredActiveId, getRestoredProfileProvenance } from "./session-adapter.js";
export function registerLifecycleHandlers(pi, workspace, compileCycle, deps) {
    let startupToolPolicyPending = false;
    let runFailed = false;
    pi.on("session_shutdown", async () => {
        runFailed = false;
        deps.setInstructionAgentBusy?.(false);
        // Publish a final cleared active-state snapshot before teardown so optional
        // consumers do not retain appearance context from the retiring session.
        // Active-state is optional, so a throwing transport/listener must never
        // block tool-policy restoration or workspace teardown.
        disposeActiveStateSafely(deps);
        startupToolPolicyPending = false;
        // Every teardown step runs even if a preceding one throws (for example
        // when an optional bus transport rejects emit/unsubscribe). The first
        // failure is rethrown only after all cleanup has been attempted.
        let firstError;
        for (const step of [
            // A shared editor may outlive this runtime; stale hosts must stop accepting controls.
            () => deps.disposeInstructions?.(),
            // Pi carries the old runtime's active built-in tool names into a
            // replacement runtime. Restore the pre-policy set before reload/session
            // replacement so the replacement can capture a complete baseline.
            () => deps.restoreActiveToolPolicy(),
            // Tear down the host first so a throwing subagent disposal cannot leak
            // a live host that keeps advertising the stale snapshot.
            () => deps.disposeForgeWorkspace(),
            () => deps.disposePromptStackRuntime(),
        ]) {
            try {
                step();
            }
            catch (error) {
                firstError ??= error;
            }
        }
        if (firstError !== undefined)
            throw firstError;
    });
    pi.on("session_start", async (event, ctx) => {
        runFailed = false;
        deps.setInstructionAgentBusy?.(false);
        startupToolPolicyPending = true;
        // Suspend before any workspace reload so intermediate snapshots cannot be
        // published under the still-bound old session id.
        deps.suspendActiveState();
        try {
            const freshSession = shouldAutoActivateForSessionStart(event, ctx);
            await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps, { deferToolPolicy: true, suppressAutoActivate: freshSession });
            if (freshSession)
                await deps.activateFreshSessionDefaults(ctx);
            deps.reloadForgeWorkspace(ctx);
            deps.refreshWebEditorHost(ctx);
            deps.notifyActivePreset(ctx, "after session " + event.reason);
            // Resume and bind only once the restored workspace is complete.
            deps.bindActiveState(ctx);
        }
        catch (error) {
            startupToolPolicyPending = false;
            // A failed restore leaves the old binding stale; detach/clear instead
            // of publishing it under a foreign workspace.
            disposeActiveStateSafely(deps);
            throw error;
        }
    });
    pi.on("resources_discover", async (_event, ctx) => {
        if (!startupToolPolicyPending)
            return;
        startupToolPolicyPending = false;
        deps.syncActiveToolPolicy(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
        runFailed = false;
        deps.setInstructionAgentBusy?.(false);
        deps.suspendActiveState();
        try {
            await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps);
            deps.reloadForgeWorkspace(ctx);
            deps.refreshWebEditorHost(ctx);
            deps.notifyActivePreset(ctx, "after tree navigation");
            deps.bindActiveState(ctx);
        }
        catch (error) {
            disposeActiveStateSafely(deps);
            throw error;
        }
    });
    pi.on("session_compact", async (_event, ctx) => {
        runFailed = false;
        deps.setInstructionAgentBusy?.(false);
        deps.suspendActiveState();
        try {
            await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps);
            deps.reloadForgeWorkspace(ctx);
            deps.refreshWebEditorHost(ctx);
            deps.notifyActivePreset(ctx, "after compaction");
            // Same session: bindSession keeps the live instance and revision
            // epoch, so compaction does not clear/recreate cosmetic state.
            deps.bindActiveState(ctx);
        }
        catch (error) {
            disposeActiveStateSafely(deps);
            throw error;
        }
    });
    pi.on("turn_start", async (_event, ctx) => {
        deps.syncActiveToolPolicy(ctx);
        deps.persistActiveSelection();
    });
    pi.on("input", async (_event, ctx) => {
        deps.syncActiveToolPolicy(ctx);
    });
    pi.on("tool_call", async (event) => {
        const reason = deps.toolPolicyBlockReason(event.toolName);
        return reason ? { block: true, reason } : undefined;
    });
    pi.on("before_agent_start", async (event, ctx) => {
        runFailed = false;
        deps.setInstructionAgentBusy?.(true);
        compileCycle.currentSystemPromptOptions = event.systemPromptOptions;
        deps.refreshWebEditorHost(ctx, event.systemPromptOptions);
        compileCycle.currentLatestUserMessage = event.prompt;
        compileCycle.contextRewritePending = true;
        compileCycle.currentBaseSystemPrompt = event.systemPrompt;
        compileCycle.currentCompiledSystemPrompt = undefined;
        compileCycle.currentCompiledStackKey = undefined;
        compileCycle.currentPromptInputKey = undefined;
        compileCycle.currentCompilationContext = undefined;
        compileCycle.currentCompilationRuntime = promptRuntimeFromPi(event.systemPromptOptions, ctx, event.prompt);
        // Never return a forced full systemPrompt: Pi reapplies it AFTER context hooks,
        // which would silently suppress native instruction sections on tool follow-ups.
    });
    pi.on("context", async (event, ctx) => {
        try {
            deps.syncActiveToolPolicy(ctx);
            let messages = event.messages;
            messages = deps.prepareInstructionMessages?.(messages, ctx) ?? messages;
            const active = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
            if (active && compileCycle.currentSystemPromptOptions) {
                const options = deps.toolPromptOptions?.(compileCycle.currentSystemPromptOptions) ?? compileCycle.currentSystemPromptOptions;
                const runtime = promptRuntimeFromPi(options, ctx, compileCycle.currentLatestUserMessage, compileCycle.currentCompilationRuntime?.now);
                const basePrompt = getPiBasePrompt(event.messages, compileCycle.currentBaseSystemPrompt ?? "");
                const key = JSON.stringify([active.stack, runtime.options, runtime.model, basePrompt]);
                if (!compileCycle.currentCompilationContext || compileCycle.currentPromptInputKey !== key) {
                    compileCycle.currentCompilationRuntime = runtime;
                    compileCycle.currentCompilationContext = new PromptCompilationContext(active.stack, runtime);
                    const result = compileCycle.currentCompilationContext.compileSystemPrompt(basePrompt);
                    compileCycle.currentBaseSystemPrompt = basePrompt;
                    compileCycle.currentCompiledSystemPrompt = result.systemPrompt;
                    compileCycle.currentCompiledStackKey = formatResourceKey(active.key);
                    compileCycle.currentPromptInputKey = key;
                    deps.recordCompileDiagnostics(ctx, result.diagnostics);
                }
                if (compileCycle.contextRewritePending) {
                    compileCycle.contextRewritePending = false;
                    const latest = getLatestUserMessage(messages) ?? compileCycle.currentLatestUserMessage;
                    compileCycle.currentCompilationContext.setLatestUserMessage(latest ?? "");
                    const result = compileCycle.currentCompilationContext.compileMessages(messages);
                    messages = result.messages;
                    deps.recordCompileDiagnostics(ctx, dedupeDiagnostics([compileCycle.latestCompileDiagnostics, result.diagnostics]));
                }
                else if (hasRequestFrequencyRules(active.stack)) {
                    const diagnostics = [];
                    messages = applyRequestFrequencyRulesToMessages(active.stack, messages, diagnostics);
                    if (diagnostics.length)
                        deps.recordCompileDiagnostics(ctx, diagnostics);
                }
                messages = projectPresetSystemPrompt(messages, compileCycle.currentCompiledSystemPrompt ?? "");
            }
            messages = deps.projectInstructions?.(messages, ctx) ?? messages;
            return messages === event.messages ? undefined : { messages };
        }
        catch (error) {
            // Pi logs hook exceptions and may otherwise dispatch the unmodified context.
            // Abort explicitly so malformed state never yields text/tool half-application.
            runFailed = true;
            ctx.abort();
            throw error;
        }
    });
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role === "assistant")
            deps.recordProviderResponseUsage(event.message);
        const active = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
        if (!active)
            return;
        const diagnostics = [];
        const message = applyFinalizeRegexRulesToMessage(active.stack, event.message, diagnostics);
        if (diagnostics.length > 0)
            deps.recordCompileDiagnostics(ctx, dedupeDiagnostics([compileCycle.latestCompileDiagnostics, diagnostics]));
        if (!message)
            return;
        return { message };
    });
    pi.on("agent_end", async (_event, ctx) => {
        try {
            deps.setInstructionAgentBusy?.(false);
            if (!runFailed && ctx) {
                deps.commitEndInstructionAnchors?.(ctx);
            }
        }
        finally {
            resetCompileCycle(compileCycle);
        }
    });
}
function disposeActiveStateSafely(deps) {
    try {
        deps.disposeActiveState();
    }
    catch {
        // Optional active-state observers must never block lifecycle cleanup.
    }
}
async function restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps, options) {
    deps.setInstructionAgentBusy?.(false);
    deps.prepareInstructionRestore?.(ctx);
    const restoredProfile = getRestoredProfileProvenance(ctx);
    compileCycle.currentCompilationContext = undefined;
    compileCycle.currentCompilationRuntime = undefined;
    compileCycle.currentBaseSystemPrompt = undefined;
    compileCycle.currentCompiledSystemPrompt = undefined;
    compileCycle.currentCompiledStackKey = undefined;
    compileCycle.currentPromptInputKey = undefined;
    compileCycle.latestCompileDiagnostics = getLegacyVariableStateDiagnostic(ctx);
    const restoredActiveId = getRestoredActiveId(ctx);
    deps.restorePersistedActiveId(restoredActiveId);
    await deps.reloadStacks(ctx, restoredActiveId, { ...options, deferToolPolicy: true });
    workspace.setLastAppliedProfile(restoredProfile);
    deps.restoreInstructions?.(ctx, options);
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
//# sourceMappingURL=lifecycle.js.map