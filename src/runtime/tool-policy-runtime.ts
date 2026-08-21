import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyResourcePolicy, hasResourcePolicy } from "../policy.ts";
import type { LoadedPromptStack } from "../types.ts";
import type { PromptStack } from "../types.ts";
import type { WebEditorPolicyResource, WebEditorPolicyResources } from "../web-editor/index.ts";

export interface ToolPolicyRuntime {
	sync(ctx?: ExtensionContext): void;
	restore(ctx?: ExtensionContext): void;
	blockReason(toolName: string): string | undefined;
	previewToolNames(stack: PromptStack | undefined): string[];
	previewOptions(base: BuildSystemPromptOptions, stack: PromptStack): BuildSystemPromptOptions;
	policyResources(options: BuildSystemPromptOptions): WebEditorPolicyResources;
}

export function createToolPolicyRuntime(pi: ExtensionAPI, getActiveStack: () => LoadedPromptStack | undefined): ToolPolicyRuntime {
	let baseline: string[] | undefined;
	let lastApplied: string[] | undefined;

	function filterKnownTools(names: string[]): string[] {
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		if (known.size === 0) return names;
		return names.filter((name) => known.has(name));
	}

	function policySourceTools(policy: PromptStack["tools"], activeBaseline: string[]): string[] {
		const hasSelectiveAllow = Array.isArray(policy?.allow)
			&& policy.allow.length > 0
			&& !policy.allow.includes("*");
		return hasSelectiveAllow
			? pi.getAllTools().map((tool) => tool.name).filter((name): name is string => typeof name === "string" && !!name)
			: filterKnownTools(activeBaseline);
	}

	function sync(ctx?: ExtensionContext): void {
		const policy = getActiveStack()?.stack.tools;
		if (!hasResourcePolicy(policy)) {
			restore(ctx);
			return;
		}

		const currentTools = filterKnownTools(pi.getActiveTools());
		if (baseline && lastApplied) baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
		const sourceTools = baseline ?? currentTools;
		baseline ??= [...sourceTools];
		const nextTools = applyResourcePolicy(policySourceTools(policy, sourceTools), policy);
		if (!sameStringSet(currentTools, nextTools)) pi.setActiveTools(nextTools);
		lastApplied = [...nextTools];
		if (ctx) {
			const label = nextTools.length > 0 ? `tools:${nextTools.length}` : "tools:none";
			ctx.ui.setStatus("pi-forge-tools", ctx.ui.theme.fg(nextTools.length > 0 ? "accent" : "warning", label));
		}
	}

	function restore(ctx?: ExtensionContext): void {
		if (baseline) {
			const currentTools = filterKnownTools(pi.getActiveTools());
			if (lastApplied) baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
			const restoredTools = filterKnownTools(baseline);
			if (!sameStringSet(currentTools, restoredTools)) pi.setActiveTools(restoredTools);
			baseline = undefined;
		}
		lastApplied = undefined;
		if (ctx) ctx.ui.setStatus("pi-forge-tools", undefined);
	}

	function blockReason(toolName: string): string | undefined {
		const active = getActiveStack();
		if (!active || !hasResourcePolicy(active.stack.tools)) return undefined;
		if (applyResourcePolicy([toolName], active.stack.tools).includes(toolName)) return undefined;
		return `Tool "${toolName}" is blocked by prompt stack "${active.stack.id}".`;
	}

	function previewToolNames(stack: PromptStack | undefined): string[] {
		const sourceTools = filterKnownTools(baseline ?? pi.getActiveTools());
		return stack && hasResourcePolicy(stack.tools)
			? applyResourcePolicy(policySourceTools(stack.tools, sourceTools), stack.tools)
			: sourceTools;
	}

	function previewOptions(base: BuildSystemPromptOptions, stack: PromptStack): BuildSystemPromptOptions {
		const baseSelectedTools = Array.isArray(base.selectedTools) ? base.selectedTools : pi.getActiveTools();
		const policyActive = hasResourcePolicy(stack.tools);
		const baselineTools = policyActive ? (baseline ?? pi.getActiveTools()) : baseSelectedTools;
		const selectedTools = policyActive
			? applyResourcePolicy(policySourceTools(stack.tools, filterKnownTools(baselineTools)), stack.tools)
			: baseSelectedTools;
		const selectedToolSet = new Set(selectedTools);
		const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
		const toolInfos = pi.getAllTools();
		for (const tool of toolInfos) {
			const name = stringValue(tool.name);
			if (!name || !selectedToolSet.has(name) || toolSnippets[name]) continue;
			const snippet = stringValue((tool as { promptSnippet?: unknown }).promptSnippet);
			if (snippet) toolSnippets[name] = snippet;
		}

		const mappedGuidelines = toolInfos
			.filter((tool) => {
				const name = stringValue(tool.name);
				return !!name && selectedToolSet.has(name);
			})
			.flatMap((tool) => stringArrayValue(tool.promptGuidelines));
		const promptGuidelines = policyActive && !sameStringSet(baseSelectedTools, selectedTools)
			? mappedGuidelines
			: (base.promptGuidelines ?? mappedGuidelines);

		return { ...base, selectedTools, toolSnippets, promptGuidelines };
	}

	function policyResources(options: BuildSystemPromptOptions): WebEditorPolicyResources {
		const activeTools = new Set(pi.getActiveTools());
		const snippets = options.toolSnippets ?? {};
		const tools = pi.getAllTools()
			.map((tool) => normalizeToolResource(tool, activeTools, snippets))
			.filter(hasPolicyResourceName)
			.sort(comparePolicyResource);
		const skills = (options.skills ?? [])
			.map(normalizeSkillResource)
			.filter(hasPolicyResourceName)
			.sort(comparePolicyResource);
		return { tools, skills };
	}

	return { sync, restore, blockReason, previewToolNames, previewOptions, policyResources };
}

export function reconcileToolPolicyBaseline(baseline: string[], lastApplied: string[], current: string[]): string[] {
	const baselineSet = new Set(baseline);
	const lastAppliedSet = new Set(lastApplied);
	const currentSet = new Set(current);

	for (const name of current) {
		if (!lastAppliedSet.has(name)) baselineSet.add(name);
	}
	for (const name of lastApplied) {
		if (!currentSet.has(name)) baselineSet.delete(name);
	}

	return [
		...baseline.filter((name) => baselineSet.has(name)),
		...current.filter((name) => baselineSet.has(name) && !baseline.includes(name)),
	];
}

function filterToolSnippets(snippets: Record<string, string | undefined>, selectedTools: Set<string>): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [name, snippet] of Object.entries(snippets)) {
		if (selectedTools.has(name) && snippet) filtered[name] = snippet;
	}
	return filtered;
}

function normalizeToolResource(
	tool: { name?: unknown; description?: unknown; promptSnippet?: unknown; sourceInfo?: unknown },
	activeTools: Set<string>,
	snippets: Record<string, string | undefined>,
): WebEditorPolicyResource {
	const name = String(tool.name ?? "");
	return {
		name,
		description: stringValue(tool.description) ?? stringValue(tool.promptSnippet) ?? snippets[name],
		source: sourceLabel(tool.sourceInfo),
		active: activeTools.has(name),
	};
}

function normalizeSkillResource(skill: { name?: unknown; description?: unknown; filePath?: unknown; disableModelInvocation?: unknown }): WebEditorPolicyResource {
	return {
		name: String(skill.name ?? ""),
		description: stringValue(skill.description),
		source: stringValue(skill.filePath),
		hidden: skill.disableModelInvocation === true,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
}

function sourceLabel(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = stringValue((value as { source?: unknown }).source);
	const path = stringValue((value as { path?: unknown }).path);
	if (source && path) return `${source}: ${path}`;
	return source ?? path;
}

function comparePolicyResource(a: WebEditorPolicyResource, b: WebEditorPolicyResource): number {
	return a.name.localeCompare(b.name);
}

function hasPolicyResourceName(resource: WebEditorPolicyResource): boolean {
	return !!resource.name.trim();
}

function sameStringSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every((value) => rightSet.has(value));
}
