import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidToolName, type InstructionToolPatch } from "../codecs/instruction-mode.ts";
import { applyResourcePolicy, hasResourcePolicy } from "../policy.ts";
import type { LoadedPromptStack } from "../types.ts";
import type { PromptStack } from "../types.ts";
import type { WebEditorPolicyResource, WebEditorPolicyResources } from "../web-editor/index.ts";

export interface ToolPolicySnapshot {
	baseline: string[];
	lastApplied: string[];
}

export interface ToolPolicyRuntime {
	sync(ctx?: ExtensionContext): void;
	restore(ctx?: ExtensionContext): void;
	blockReason(toolName: string): string | undefined;
	previewToolNames(stack: PromptStack | undefined): string[];
	previewOptions(base: BuildSystemPromptOptions, stack: PromptStack): BuildSystemPromptOptions;
	policyResources(options: BuildSystemPromptOptions): WebEditorPolicyResources;
	snapshot(): ToolPolicySnapshot;
	setInstructionModes(patches: readonly InstructionToolPatch[], restored?: ToolPolicySnapshot): void;
	validateInstructionModes(patches: readonly InstructionToolPatch[]): string | undefined;
}

export function createToolPolicyRuntime(pi: ExtensionAPI, getActiveStack: () => LoadedPromptStack | undefined): ToolPolicyRuntime {
	let baseline: string[] | undefined;
	let lastApplied: string[] | undefined;
	let instructionPatches: InstructionToolPatch[] = [];

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

	function computeEffectiveTools(policy: PromptStack["tools"] | undefined, sourceBaseline: string[]): string[] {
		const policyActive = hasResourcePolicy(policy);
		const sourceTools = filterKnownTools(sourceBaseline);
		const baseList = policyActive
			? applyResourcePolicy(policySourceTools(policy, sourceTools), policy)
			: sourceTools;

		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const effective = [...baseList];
		for (const patch of instructionPatches) {
			for (const name of patch.add) {
				if (registered.has(name) && !effective.includes(name)) {
					effective.push(name);
				}
			}
		}

		const allRemoved = new Set<string>();
		for (const patch of instructionPatches) {
			for (const name of patch.remove) {
				allRemoved.add(name);
			}
		}

		let result = effective.filter((name) => !allRemoved.has(name));
		if (policyActive) {
			result = applyResourcePolicy(result, policy);
		}
		result = result.filter((name) => !allRemoved.has(name));
		return result;
	}

	function sync(ctx?: ExtensionContext): void {
		const policy = getActiveStack()?.stack.tools;
		const policyActive = hasResourcePolicy(policy);
		const modesActive = instructionPatches.length > 0;

		if (!policyActive && !modesActive) {
			restore(ctx);
			return;
		}

		const currentTools = filterKnownTools(pi.getActiveTools());
		if (baseline && lastApplied) baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
		const sourceTools = baseline ?? currentTools;
		baseline ??= [...sourceTools];
		const nextTools = computeEffectiveTools(policy, sourceTools);
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
		instructionPatches = [];
		if (ctx) ctx.ui.setStatus("pi-forge-tools", undefined);
	}

	function snapshot(): ToolPolicySnapshot {
		return {
			baseline: baseline ? [...baseline] : [...pi.getActiveTools()],
			lastApplied: lastApplied ? [...lastApplied] : [...pi.getActiveTools()],
		};
	}

	function validateInstructionModes(patches: readonly InstructionToolPatch[]): string | undefined {
		if (!Array.isArray(patches)) {
			return "Instruction mode patches must be an array.";
		}
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const activeStack = getActiveStack();
		const policy = activeStack?.stack.tools;
		const policyActive = hasResourcePolicy(policy);

		for (const patch of patches) {
			if (!patch || typeof patch !== "object") {
				return "Instruction mode patch must be an object.";
			}
			if (!Array.isArray(patch.add) || !Array.isArray(patch.remove)) {
				return "Instruction mode patch must have add and remove arrays.";
			}
			for (const name of patch.remove) {
				if (typeof name !== "string" || !isValidToolName(name)) {
					return `Invalid tool name "${name}" in instruction mode remove list.`;
				}
			}
			for (const name of patch.add) {
				if (typeof name !== "string" || !isValidToolName(name)) {
					return `Invalid tool name "${name}" in instruction mode add list.`;
				}
				if (!registered.has(name)) {
					return `Tool "${name}" is not registered.`;
				}
				if (policyActive && activeStack && !applyResourcePolicy([name], policy).includes(name)) {
					return `Tool "${name}" is blocked by prompt stack "${activeStack.stack.id}".`;
				}
			}
		}
		return undefined;
	}

	function setInstructionModes(patches: readonly InstructionToolPatch[], restored?: ToolPolicySnapshot): void {
		const validationError = validateInstructionModes(patches);
		if (validationError) throw new Error(validationError);
		if (restored !== undefined) {
			if (!restored || typeof restored !== "object" || !Array.isArray(restored.baseline) || !Array.isArray(restored.lastApplied)) {
				throw new Error("Invalid tool policy snapshot: baseline and lastApplied must be arrays.");
			}
			for (const name of [...restored.baseline, ...restored.lastApplied]) {
				if (typeof name !== "string" || !name || name.length > 1024 || /[\x00-\x1f\x7f]/.test(name)) {
					throw new Error("Invalid tool name in tool policy snapshot.");
				}
			}
			baseline = [...restored.baseline];
			lastApplied = [...restored.lastApplied];
		}
		instructionPatches = patches.map((patch) => ({ add: [...patch.add], remove: [...patch.remove] }));
		if (restored) {
			const current = filterKnownTools(pi.getActiveTools());
			const expected = computeEffectiveTools(getActiveStack()?.stack.tools, restored.baseline);
			// A crash can land before or after the executable-selection update. Neither
			// known side of this transition is an external tool change. Reconcile only
			// distinguishable third-party differences against the saved applied set.
			if (sameStringSet(current, restored.lastApplied) || sameStringSet(current, expected)) lastApplied = [...current];
		}
	}

	function blockReason(toolName: string): string | undefined {
		const active = getActiveStack();
		if (active && hasResourcePolicy(active.stack.tools)) {
			if (!applyResourcePolicy([toolName], active.stack.tools).includes(toolName)) {
				return `Tool "${toolName}" is blocked by prompt stack "${active.stack.id}".`;
			}
		}
		const allRemoved = new Set<string>();
		for (const patch of instructionPatches) {
			for (const name of patch.remove) {
				allRemoved.add(name);
			}
		}
		if (allRemoved.has(toolName)) {
			return `Tool "${toolName}" is blocked by active instruction mode.`;
		}
		return undefined;
	}

	function previewToolNames(stack: PromptStack | undefined): string[] {
		const sourceTools = filterKnownTools(baseline ?? pi.getActiveTools());
		return computeEffectiveTools(stack?.tools, sourceTools);
	}

	function previewOptions(base: BuildSystemPromptOptions, stack: PromptStack): BuildSystemPromptOptions {
		// Captured prompt options may predate activation OR restoration. The live
		// baseline/current selection is authoritative, including an empty selection.
		const sessionTools = filterKnownTools(baseline ?? pi.getActiveTools());
		const selectedTools = computeEffectiveTools(stack.tools, sessionTools);
		const selectedToolSet = new Set(selectedTools);
		const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
		const toolInfos = pi.getAllTools();
		for (const tool of toolInfos) {
			const name = stringValue(tool.name);
			if (!name || !selectedToolSet.has(name) || toolSnippets[name]) continue;
			// ToolInfo does not carry promptSnippet; fall back to the tool
			// description so the preview never shows placeholder text.
			const snippet = stringValue((tool as { promptSnippet?: unknown }).promptSnippet)
				?? stringValue((tool as { description?: unknown }).description);
			if (snippet) toolSnippets[name] = snippet;
		}

		const mappedGuidelines = toolInfos
			.filter((tool) => {
				const name = stringValue(tool.name);
				return !!name && selectedToolSet.has(name);
			})
			.flatMap((tool) => stringArrayValue(tool.promptGuidelines));
		const promptGuidelines = baseline || instructionPatches.length > 0 || !sameStringSet(base.selectedTools ?? sessionTools, selectedTools)
			? mappedGuidelines
			: (base.promptGuidelines?.length ? [...base.promptGuidelines] : mappedGuidelines);

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

	return {
		sync,
		restore,
		blockReason,
		previewToolNames,
		previewOptions,
		policyResources,
		snapshot,
		setInstructionModes,
		validateInstructionModes,
	};
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
