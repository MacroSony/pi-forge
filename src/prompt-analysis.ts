import { forgeV1 } from "./forge-v1/index.ts";
import type { ForgeV1Error, TemplateDependency, TemplateNode } from "./forge-v1/types.ts";
import type { PromptStack } from "./types.ts";

export interface PromptBlockAnalysis {
	itemId: string;
	ast: TemplateNode[];
	dependencies: TemplateDependency[];
	diagnostics: ForgeV1Error[];
}

export interface PromptAnalysis {
	blocks: PromptBlockAnalysis[];
	slotDependencies: Map<string, string[]>;
	transitiveExtensions: Set<string>;
	diagnostics: ForgeV1Error[];
}

export interface PromptRegistrationLike {
	name: string;
	dependencies?: string[];
}

export interface PromptAnalysisRegistrations {
	macros: readonly PromptRegistrationLike[];
	slots: readonly PromptRegistrationLike[];
}

export function analyzePromptStack(
	stack: PromptStack,
	registrations: PromptAnalysisRegistrations = { macros: [], slots: [] },
): PromptAnalysis {
	const blocks: PromptBlockAnalysis[] = [];
	const slotDependencies = new Map<string, string[]>();
	const diagnostics: ForgeV1Error[] = [];

	for (const item of stack.items) {
		if (item.enabled === false) continue;
		if (item.kind === "block") {
			const parsed = forgeV1.parse(item.content);
			if (!parsed.ok) {
				diagnostics.push(parsed.error);
				continue;
			}
			const analyzed = forgeV1.analyze(parsed.ast);
			diagnostics.push(...analyzed.errors);
			blocks.push({
				itemId: item.id,
				ast: parsed.ast,
				dependencies: analyzed.dependencies,
				diagnostics: analyzed.errors,
			});
			continue;
		}
		const definition = registrations.slots.find((slot) => slot.name === item.slot);
		if (definition?.dependencies?.length) slotDependencies.set(item.slot, definition.dependencies);
	}

	const transitiveExtensions = new Set<string>();
	const visit = (name: string, path: Set<string>): void => {
		if (transitiveExtensions.has(name)) return;
		if (path.has(name)) return;
		const definition = registrations.macros.find((macro) => macro.name === name);
		path.add(name);
		if (definition?.dependencies) {
			for (const dependency of definition.dependencies) {
				const depName = parseExtensionDependency(dependency);
				if (depName) visit(depName, path);
			}
		}
		path.delete(name);
		transitiveExtensions.add(name);
	};
	for (const block of blocks) {
		for (const dependency of block.dependencies) {
			const name = dependency.kind === "extensions" ? dependency.path?.[1] : undefined;
			if (name) visit(name, new Set());
		}
	}
	for (const deps of slotDependencies.values()) {
		for (const dependency of deps) {
			const name = parseExtensionDependency(dependency);
			if (name) visit(name, new Set());
		}
	}

	return { blocks, slotDependencies, transitiveExtensions, diagnostics };
}

function parseExtensionDependency(dependency: string): string | undefined {
	const trimmed = dependency.trim();
	if (trimmed.startsWith("extensions.")) {
		const name = trimmed.slice("extensions.".length).trim();
		return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
	}
	return undefined;
}
