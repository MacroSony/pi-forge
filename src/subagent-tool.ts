import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import type { AgentResponse, SubagentDiagnostic } from "./subagent/contract.ts";
import type { SubagentBackendExecutionUpdate } from "./subagent/backend-registry.ts";
import type { PiSubprocessRunReport } from "./subagent/pi-subprocess-backend.ts";

const APPROVE = "Approve and run";
const VIEW_FULL_PROMPT = "View full prompt";
const REJECT = "Reject";
const MAX_PROGRESS_ITEMS = 100;

const ForgeSubagentParameters = Type.Object({
	profileId: Type.String({
		minLength: 1,
		description: "ID of a loaded Pi Forge agent profile.",
	}),
	task: Type.String({
		minLength: 1,
		description: "The focused task to delegate to the subagent.",
	}),
});

export interface ForgeSubagentApprovalReceipt {
	required: true;
	approved: boolean;
	viewedFullPrompt: boolean;
	executionFingerprint?: string;
	approvedAt?: string;
}

export interface ForgeSubagentPlanSummary {
	backendId: string;
	profileId: string;
	promptStackId: string | null;
	provider: string;
	model: string;
	thinkingLevel: string;
	effectiveToolIds: string[];
	executionBoundary: string;
	workingDirectory: string;
	systemPromptChars: number;
	messageCount: number;
	messageRoles: string[];
	promptRuntimeFingerprint: string;
	executionFingerprint: string;
}

export interface ForgeSubagentToolDetails {
	status: "preparing" | "awaiting-approval" | "cancelled" | "running" | "completed" | "failed" | "timed-out";
	profileId: string;
	task: string;
	plan?: ForgeSubagentPlanSummary;
	approval: ForgeSubagentApprovalReceipt;
	diagnostics: SubagentDiagnostic[];
	progress: SubagentBackendExecutionUpdate[];
	response?: AgentResponse;
	report?: PiSubprocessRunReport;
}

export interface ForgeSubagentApprovalResult {
	approved: boolean;
	viewedFullPrompt: boolean;
}

export function registerForgeSubagentTool(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	profileIds: () => string[],
): void {
	pi.registerTool({
		name: "forge_subagent",
		label: "Forge Subagent",
		description: [
			"Delegate one foreground task to a loaded Pi Forge agent profile.",
			"Every run requires human approval after the exact prompt is prepared and before provider transport.",
			"The child receives only approved read tools, but runs with the invoking user's OS permissions; read-only is not a sandbox.",
			"Use the final report as evidence and do not repeatedly request the same rejected delegation.",
		].join(" "),
		parameters: ForgeSubagentParameters,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ForgeSubagentToolDetails>> {
			const baseDetails: ForgeSubagentToolDetails = {
				status: "preparing",
				profileId: params.profileId,
				task: params.task,
				approval: { required: true, approved: false, viewedFullPrompt: false },
				diagnostics: [],
				progress: [],
			};
			if (!ctx.hasUI) {
				return toolResult("Subagent invocation was not run: interactive human approval is unavailable.", { ...baseDetails, status: "cancelled" });
			}
			if (!profileIds().includes(params.profileId)) {
				const available = profileIds().join(", ") || "none";
				return toolResult(`Unknown Pi Forge agent profile: ${params.profileId}. Available profiles: ${available}.`, { ...baseDetails, status: "failed" }, true);
			}

			onUpdate?.(toolResult("Preparing the exact subagent prompt; provider transport is still closed.", baseDetails));
			let prepared: ForgeSubagentPreparedRun | undefined;
			try {
				const preparation = await runtime.prepare(params.profileId, params.task, ctx);
				if (!preparation.ok) {
					return toolResult(
						`Subagent preparation failed:\n${renderDiagnostics(preparation.diagnostics)}`,
						{ ...baseDetails, status: "failed", diagnostics: preparation.diagnostics },
						true,
					);
				}
				prepared = preparation.prepared;
				const plan = summarizeForgeSubagentPlan(prepared, ctx.cwd);
				const awaiting: ForgeSubagentToolDetails = {
					...baseDetails,
					status: "awaiting-approval",
					plan,
					diagnostics: prepared.diagnostics,
				};
				onUpdate?.(toolResult("The exact plan is ready and awaiting human approval.", awaiting));
				const approval = await requestForgeSubagentApproval(prepared, params.task, ctx, signal);
				if (!approval.approved) {
					await runtime.discard(prepared);
					prepared = undefined;
					return toolResult("Subagent invocation was rejected by the human before provider transport.", {
						...awaiting,
						status: "cancelled",
						approval: { required: true, approved: false, viewedFullPrompt: approval.viewedFullPrompt },
					});
				}

				const approvedAt = new Date().toISOString();
				const progress: SubagentBackendExecutionUpdate[] = [];
				const running: ForgeSubagentToolDetails = {
					...awaiting,
					status: "running",
					approval: {
						required: true,
						approved: true,
						viewedFullPrompt: approval.viewedFullPrompt,
						executionFingerprint: prepared.plan.executionFingerprint,
						approvedAt,
					},
					progress,
				};
				const response = await runtime.execute(prepared, ctx, signal, (update) => {
					progress.push(structuredClone(update));
					if (progress.length > MAX_PROGRESS_ITEMS) progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
					onUpdate?.(toolResult(truncate(update.message, 2_000), { ...running, progress: [...progress] }));
				});
				prepared = undefined;
				const report = runtime.takeReport?.(response.runId);
				const finalDetails: ForgeSubagentToolDetails = {
					...running,
					status: toolStatus(response),
					progress: [...progress],
					response,
					report,
				};
				return toolResult(renderResponseForModel(response), finalDetails, response.status === "failed");
			} catch (error) {
				if (prepared) await runtime.discard(prepared).catch(() => undefined);
				const message = error instanceof Error ? error.message : String(error);
				return toolResult(`Subagent invocation failed: ${message}`, { ...baseDetails, status: "failed" }, true);
			}
		},

		renderCall(args, theme) {
			const task = truncate(args.task.replace(/\s+/g, " ").trim(), 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("forge subagent "))}${theme.fg("accent", args.profileId)}\n${theme.fg("dim", task)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details;
			if (!details) return new Text(textContent(result) || "(no subagent result)", 0, 0);
			if (!expanded) return renderCollapsedResult(result, details, isPartial, theme);
			return renderExpandedResult(result, details, theme);
		},
	});
}

export async function requestForgeSubagentApproval(
	prepared: ForgeSubagentPreparedRun,
	task: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ForgeSubagentApprovalResult> {
	let viewedFullPrompt = false;
	while (!signal?.aborted) {
		const choice = await ctx.ui.select(
			renderApprovalSummary(prepared, task, ctx.cwd),
			[APPROVE, VIEW_FULL_PROMPT, REJECT],
			{ signal },
		);
		if (choice === VIEW_FULL_PROMPT) {
			viewedFullPrompt = true;
			await ctx.ui.editor(
				`Exact subagent prompt: ${prepared.plan.profile.profile.id} (view only; edits are ignored)`,
				renderFullForgeSubagentPrompt(prepared),
			);
			continue;
		}
		return { approved: choice === APPROVE, viewedFullPrompt };
	}
	return { approved: false, viewedFullPrompt };
}

export function summarizeForgeSubagentPlan(prepared: ForgeSubagentPreparedRun, cwd: string): ForgeSubagentPlanSummary {
	const plan = prepared.plan;
	return {
		backendId: plan.backendId,
		profileId: plan.profile.profile.id,
		promptStackId: plan.profile.promptStack?.id ?? null,
		provider: plan.model.provider,
		model: plan.model.id,
		thinkingLevel: plan.thinkingLevel,
		effectiveToolIds: [...plan.effectiveToolIds],
		executionBoundary: plan.access.executionBoundary ?? "isolated",
		workingDirectory: cwd,
		systemPromptChars: plan.systemPrompt.length,
		messageCount: plan.messages.length,
		messageRoles: plan.messages.map((message) => message.role),
		promptRuntimeFingerprint: plan.promptRuntimeFingerprint,
		executionFingerprint: plan.executionFingerprint,
	};
}

export function renderApprovalSummary(prepared: ForgeSubagentPreparedRun, task: string, cwd: string): string {
	const plan = prepared.plan;
	const summary = summarizeForgeSubagentPlan(prepared, cwd);
	return [
		`Run foreground subagent ${summary.profileId}?`,
		"",
		"Agent prompt:",
		indent(truncate(task, 2_000)),
		"",
		`Provider: ${summary.provider}`,
		`Model: ${summary.model}`,
		`Thinking: ${summary.thinkingLevel}`,
		`Prompt stack: ${summary.promptStackId ?? "none"}`,
		`Tools: ${toolNames(plan).join(", ") || "none"}`,
		`Working directory: ${summary.workingDirectory}`,
		`Boundary: ${summary.executionBoundary} (read-only tool policy; no OS sandbox)`,
		`Full payload: ${summary.systemPromptChars} system chars + ${summary.messageCount} messages`,
		`Execution fingerprint: ${summary.executionFingerprint}`,
		"",
		"The provider receives the compiled prompt and any files the read tools access.",
		"The subprocess retains your user permissions even though write/process tools are unavailable.",
	].join("\n");
}

export function renderFullForgeSubagentPrompt(prepared: ForgeSubagentPreparedRun): string {
	const plan = prepared.plan;
	const messages = plan.messages.flatMap((message, index) => [
		`## Message ${index + 1}: ${message.role}${message.protectedTask ? " (protected delegated task)" : ""}${message.source ? ` [${message.source}]` : ""}`,
		"",
		message.content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} media ${part.mediaId}]`).join("\n"),
		"",
	]);
	return [
		`# Exact provider-bound subagent prompt`,
		"",
		`Backend: ${plan.backendId}`,
		`Profile: ${plan.profile.profile.id}`,
		`Provider/model: ${plan.model.provider}/${plan.model.id}`,
		`Thinking: ${plan.thinkingLevel}`,
		`Tools: ${toolNames(plan).join(", ") || "none"}`,
		`Execution fingerprint: ${plan.executionFingerprint}`,
		"",
		"## System prompt",
		"",
		plan.systemPrompt,
		"",
		...messages,
	].join("\n");
}

function renderCollapsedResult(
	result: AgentToolResult<ForgeSubagentToolDetails>,
	details: ForgeSubagentToolDetails,
	isPartial: boolean,
	theme: Theme,
) {
	const icon = details.status === "completed"
		? theme.fg("success", "✓")
		: details.status === "failed"
			? theme.fg("error", "✗")
			: details.status === "cancelled" || details.status === "timed-out"
				? theme.fg("warning", "○")
				: theme.fg("accent", "●");
	const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(details.profileId))} ${theme.fg("muted", `[${details.status}${isPartial ? ", live" : ""}]`)}`];
	if (details.plan) lines.push(theme.fg("dim", `${details.plan.provider}/${details.plan.model} · ${details.plan.thinkingLevel} · ${details.plan.executionBoundary}`));
	const output = textContent(result);
	if (output) lines.push(theme.fg(details.status === "failed" ? "error" : "toolOutput", truncateLines(output, 8, 2_000)));
	if (details.report) lines.push(theme.fg("dim", usageText(details.report)));
	if (details.report && details.report.messages.length > 0) lines.push(theme.fg("muted", "Ctrl+O to view the full subagent transcript"));
	return new Text(lines.join("\n"), 0, 0);
}

function renderExpandedResult(
	result: AgentToolResult<ForgeSubagentToolDetails>,
	details: ForgeSubagentToolDetails,
	theme: Theme,
) {
	const container = new Container();
	container.addChild(new Text(theme.fg("toolTitle", theme.bold(`${details.profileId} [${details.status}]`)), 0, 0));
	if (details.plan) {
		container.addChild(new Text([
			`${theme.fg("muted", "Model:")} ${details.plan.provider}/${details.plan.model} (${details.plan.thinkingLevel})`,
			`${theme.fg("muted", "Boundary:")} ${details.plan.executionBoundary}; read-only model tools`,
			`${theme.fg("muted", "Tools:")} ${details.plan.effectiveToolIds.join(", ") || "none"}`,
			`${theme.fg("muted", "Fingerprint:")} ${details.plan.executionFingerprint}`,
			`${theme.fg("muted", "Approval:")} ${details.approval.approved ? `approved${details.approval.viewedFullPrompt ? " after full-prompt review" : ""}` : "not approved"}`,
		].join("\n"), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Delegated task ───"), 0, 0));
	container.addChild(new Text(details.task, 0, 0));

	if (details.report?.messages.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Full subagent transcript ───"), 0, 0));
		for (const message of details.report.messages) appendMessage(container, message, theme);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageText(details.report)), 0, 0));
		if (details.report.stderr.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("warning", `stderr:\n${details.report.stderr.trim()}`), 0, 0));
		}
	} else {
		const output = textContent(result);
		if (output) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
			container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
		}
	}
	return container;
}

function appendMessage(
	container: Container,
	value: unknown,
	theme: Theme,
): void {
	if (!isRecord(value)) return;
	if (value.role === "assistant" && Array.isArray(value.content)) {
		for (const part of value.content) {
			if (!isRecord(part)) continue;
			if (part.type === "toolCall") {
				const name = typeof part.name === "string" ? part.name : "tool";
				const args = isRecord(part.arguments) ? JSON.stringify(part.arguments) : "{}";
				container.addChild(new Text(`${theme.fg("muted", "→")} ${theme.fg("accent", name)} ${theme.fg("dim", args)}`, 0, 0));
			} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
				container.addChild(new Markdown(part.text.trim(), 0, 0, getMarkdownTheme()));
			}
		}
		return;
	}
	if (value.role === "toolResult") {
		const name = typeof value.toolName === "string" ? value.toolName : "tool";
		const header = value.isError === true ? theme.fg("error", `← ${name} failed`) : theme.fg("muted", `← ${name}`);
		container.addChild(new Text(header, 0, 0));
		const content = messageText(value.content);
		if (content) container.addChild(new Text(theme.fg("toolOutput", content), 1, 0));
	}
}

function toolResult(text: string, details: ForgeSubagentToolDetails, _isError = false): AgentToolResult<ForgeSubagentToolDetails> {
	return { content: [{ type: "text", text }], details: structuredClone(details) };
}

function renderResponseForModel(response: AgentResponse): string {
	if (response.status === "completed") return response.output?.text || "Subagent completed without a textual report.";
	if (response.status === "failed") return `Subagent failed (${response.error.code}): ${response.error.message}${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
	if (response.status === "cancelled" || response.status === "timed-out") return `Subagent ${response.status}: ${response.reason}${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
	return `Subagent stopped after reaching ${response.reachedLimit}.${response.output?.text ? `\n\nPartial report:\n${response.output.text}` : ""}`;
}

function toolStatus(response: AgentResponse): ForgeSubagentToolDetails["status"] {
	if (response.status === "completed") return "completed";
	if (response.status === "failed" || response.status === "limit-reached") return "failed";
	return response.status;
}

function renderDiagnostics(diagnostics: readonly SubagentDiagnostic[]): string {
	return diagnostics.map((item) => `${item.level.toUpperCase()} ${item.code}: ${item.message}`).join("\n") || "No diagnostics.";
}

function toolNames(plan: ForgeSubagentPreparedRun["plan"]): string[] {
	const names = new Map(plan.preflight.toolCatalog.map((tool) => [tool.id, tool.name]));
	return plan.effectiveToolIds.map((id) => names.get(id) ?? id);
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("\n");
}

function usageText(report: PiSubprocessRunReport): string {
	const usage = report.usage;
	return `${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${usage.input} input · ${usage.output} output · ${usage.totalTokens} total · $${usage.cost.toFixed(4)}`;
}

function indent(text: string): string {
	return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function truncateLines(text: string, maxLines: number, maxChars: number): string {
	return truncate(text.split("\n").slice(0, maxLines).join("\n"), maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
