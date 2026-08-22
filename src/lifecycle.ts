import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	compileMessages,
	getLatestUserMessage,
} from "./compiler.ts";
import { PromptCompilationContext } from "./compiler.ts";
import { applyFinalizeRegexRulesToMessage } from "./regex.ts";
import { promptRuntimeFromPi } from "./prompt-runtime.ts";
import { resetCompileCycle, type CompileCycleState } from "./compile-cycle.ts";
import { getCurrentBranchEntries, getLegacyVariableStateDiagnostic, getRestoredActiveId, getRestoredProfileProvenance } from "./session-adapter.ts";
import type { ForgeWorkspace } from "./workspace.ts";
import type { PromptStackDiagnostic } from "./types.ts";

export interface LifecycleDeps {
	reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: { deferToolPolicy?: boolean; suppressAutoActivate?: boolean }): Promise<void>;
	disposePromptStackRuntime(): PromptStackDiagnostic[];
	activateFreshSessionDefaults(ctx: ExtensionContext): Promise<void>;
	refreshWebEditorHost(ctx: ExtensionContext, promptOptions?: BuildSystemPromptOptions): void;
	notifyActivePreset(ctx: ExtensionContext, detail: string): void;
	syncActiveToolPolicy(ctx?: ExtensionContext): void;
	restoreActiveToolPolicy(): void;
	toolPolicyBlockReason(toolName: string): string | undefined;
	persistActiveSelection(): void;
	recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
	restorePersistedActiveId(id?: string): void;
	reloadForgeWorkspace(ctx: ExtensionContext): void;
	disposeForgeWorkspace(): void;
	recordProviderResponseUsage(message: AssistantMessage): void;
}

export function registerLifecycleHandlers(
	pi: ExtensionAPI,
	workspace: ForgeWorkspace,
	compileCycle: CompileCycleState,
	deps: LifecycleDeps,
): void {
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
			await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps, { deferToolPolicy: true, suppressAutoActivate: freshSession });
			if (freshSession) await deps.activateFreshSessionDefaults(ctx);
		} catch (error) {
			startupToolPolicyPending = false;
			throw error;
		}
		deps.reloadForgeWorkspace(ctx);
		deps.refreshWebEditorHost(ctx);
		deps.notifyActivePreset(ctx, "after session " + event.reason);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		if (!startupToolPolicyPending) return;
		startupToolPolicyPending = false;
		deps.syncActiveToolPolicy(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps);
		deps.reloadForgeWorkspace(ctx);
		deps.refreshWebEditorHost(ctx);
		deps.notifyActivePreset(ctx, "after tree navigation");
	});

	pi.on("session_compact", async (_event, ctx) => {
		await restoreBranchScopedRuntime(ctx, workspace, compileCycle, deps);
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
		compileCycle.currentSystemPromptOptions = event.systemPromptOptions;
		deps.refreshWebEditorHost(ctx, event.systemPromptOptions);
		compileCycle.currentLatestUserMessage = event.prompt;
		compileCycle.contextRewritePending = true;

		const active = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!active) return;

		const compilationRuntime = promptRuntimeFromPi(event.systemPromptOptions, ctx, event.prompt);
		compileCycle.currentCompilationContext = new PromptCompilationContext(active.stack, compilationRuntime);
		const result = compileCycle.currentCompilationContext.compileSystemPrompt(event.systemPrompt);
		deps.recordCompileDiagnostics(ctx, result.diagnostics);

		return { systemPrompt: result.systemPrompt };
	});

	pi.on("context", async (event, ctx) => {
		const active = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!active || !compileCycle.currentSystemPromptOptions || !compileCycle.contextRewritePending) return;

		// Rewrite the message layout only for the first provider request of a user-submitted prompt.
		// Tool-result follow-up turns must receive Pi's natural context; otherwise post-history
		// prompt blocks such as COT / {{lastUserMessage}} are re-appended after every tool call
		// and the model restarts its planning instead of continuing from the tool result.
		compileCycle.contextRewritePending = false;

		const latestUserMessage = getLatestUserMessage(event.messages) ?? compileCycle.currentLatestUserMessage;
		compileCycle.currentCompilationContext?.setLatestUserMessage(latestUserMessage ?? "");
		const result = compileCycle.currentCompilationContext
			? compileCycle.currentCompilationContext.compileMessages(event.messages)
			: compileMessages(
				active.stack,
				promptRuntimeFromPi(compileCycle.currentSystemPromptOptions, ctx, latestUserMessage),
				event.messages,
			);
		deps.recordCompileDiagnostics(ctx, [...compileCycle.latestCompileDiagnostics, ...result.diagnostics]);
		return { messages: result.messages };
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") deps.recordProviderResponseUsage(event.message);
		const active = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!active) return;
		const diagnostics: PromptStackDiagnostic[] = [];
		const message = applyFinalizeRegexRulesToMessage(active.stack, event.message, diagnostics);
		if (diagnostics.length > 0) deps.recordCompileDiagnostics(ctx, [...compileCycle.latestCompileDiagnostics, ...diagnostics]);
		if (!message) return;
		return { message };
	});

	pi.on("agent_end", async () => {
		resetCompileCycle(compileCycle);
	});
}

async function restoreBranchScopedRuntime(
	ctx: ExtensionContext,
	workspace: ForgeWorkspace,
	compileCycle: CompileCycleState,
	deps: LifecycleDeps,
	options?: { deferToolPolicy?: boolean; suppressAutoActivate?: boolean },
): Promise<void> {
	const restoredProfile = getRestoredProfileProvenance(ctx);
	compileCycle.currentCompilationContext = undefined;
	compileCycle.latestCompileDiagnostics = getLegacyVariableStateDiagnostic(ctx);
	const restoredActiveId = getRestoredActiveId(ctx);
	deps.restorePersistedActiveId(restoredActiveId);
	await deps.reloadStacks(ctx, restoredActiveId, options);
	workspace.setLastAppliedProfile(restoredProfile);
}

function shouldAutoActivateForSessionStart(event: SessionStartEvent, ctx: ExtensionContext): boolean {
	if (event.reason === "new") return true;
	if (event.reason !== "startup") return false;
	return isFreshStartupBranch(getCurrentBranchEntries(ctx));
}

function isFreshStartupBranch(entries: unknown[]): boolean {
	if (entries.length === 0) return true;

	let modelChanges = 0;
	let thinkingLevelChanges = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") return false;
		const type = (entry as { type?: unknown }).type;
		if (type === "model_change") {
			modelChanges += 1;
			if (modelChanges > 1) return false;
			continue;
		}
		if (type === "thinking_level_change") {
			thinkingLevelChanges += 1;
			if (thinkingLevelChanges > 1) return false;
			continue;
		}
		if (type === "session_info") continue;
		return false;
	}

	// Pi 0.82 writes the initial thinking level, and the model when one is
	// selected, before extensions receive the first startup event. A previously
	// opened empty session receives another bootstrap pair, so the count limits
	// above keep it from being mistaken for a newly created session.
	return thinkingLevelChanges === 1;
}
