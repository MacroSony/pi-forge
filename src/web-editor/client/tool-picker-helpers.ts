import type { WebEditorPolicyResource } from "./types.ts";

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resourcePatternMatches(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	const escaped = pattern
		.split("*")
		.map(escapeRegExp)
		.join(".*");
	return new RegExp(`^${escaped}$`).test(name);
}

export function matchesAnyPattern(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => resourcePatternMatches(name, pattern));
}

export interface ToolGroup {
	id: string;
	label: string;
	tools: WebEditorPolicyResource[];
}

export function getToolGroupInfo(
	tool: WebEditorPolicyResource,
	otherLabel: string,
): { id: string; label: string } {
	if (tool.group?.id && typeof tool.group.id === "string" && tool.group.id.trim()) {
		return {
			id: tool.group.id.trim(),
			label: (tool.group.label && typeof tool.group.label === "string" && tool.group.label.trim())
				? tool.group.label.trim()
				: tool.group.id.trim(),
		};
	}
	// No group metadata => localized Other; no guessed prefix grouping!
	return {
		id: "other",
		label: otherLabel,
	};
}

export function groupTools(
	resources: WebEditorPolicyResource[],
	otherLabel: string,
): ToolGroup[] {
	const groupsMap = new Map<string, ToolGroup>();
	let otherGroup: ToolGroup | null = null;

	for (const tool of resources) {
		const { id, label } = getToolGroupInfo(tool, otherLabel);
		if (id === "other") {
			if (!otherGroup) {
				otherGroup = { id: "other", label, tools: [] };
			}
			otherGroup.tools.push(tool);
		} else {
			let group = groupsMap.get(id);
			if (!group) {
				group = { id, label, tools: [] };
				groupsMap.set(id, group);
			}
			group.tools.push(tool);
		}
	}

	const result = Array.from(groupsMap.values());
	if (otherGroup) {
		result.push(otherGroup);
	}
	return result;
}

export function seedDefaultTools(
	resources: WebEditorPolicyResource[],
	mode: "none" | "allow" | "deny",
	patterns: string[],
): string[] {
	if (!Array.isArray(resources) || resources.length === 0) {
		return [];
	}

	// Active baseline strictly consists of tools where active === true.
	// Never guess or fall back to all catalog tools if active tools is empty!
	const activeBaseline = resources.filter((tool) => tool.baselineActive ?? tool.active === true);

	if (mode === "allow") {
		const hasSelectiveAllow = patterns.length > 0 && !patterns.includes("*");
		if (hasSelectiveAllow) {
			// Selective allow matches all registered catalog tools against patterns
			return resources
				.filter((tool) => matchesAnyPattern(tool.name, patterns))
				.map((tool) => tool.name);
		}
		// Unrestricted baseline: allow:['*'] or empty allow in backend does not enable all or empty
		return activeBaseline.map((tool) => tool.name);
	}

	if (mode === "deny" && patterns.length > 0) {
		return activeBaseline
			.filter((tool) => !matchesAnyPattern(tool.name, patterns))
			.map((tool) => tool.name);
	}

	return activeBaseline.map((tool) => tool.name);
}

export function toolTooltip(
	tool: WebEditorPolicyResource,
	labels: {
		sourceLabel?: (source: string) => string;
		currentlyActive?: string;
		registeredInactive?: string;
		hiddenFromModel?: string;
	} = {},
): string {
	const parts: string[] = [];
	if (tool.description) parts.push(tool.description);
	if (tool.source) {
		parts.push(labels.sourceLabel ? labels.sourceLabel(tool.source) : `Source: ${tool.source}`);
	}
	if (tool.active && labels.currentlyActive) {
		parts.push(labels.currentlyActive);
	} else if (!tool.active && labels.registeredInactive) {
		parts.push(labels.registeredInactive);
	}
	if (tool.hidden && labels.hiddenFromModel) {
		parts.push(labels.hiddenFromModel);
	}
	return parts.join("\n") || tool.name;
}

export function deduplicateToolNames(names: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}
