import { FORGE_V1_FILTERS } from "./types.ts";
import type {
	TemplateAnalyzeResult,
	TemplateDependency,
	TemplateNode,
	TemplatePredicate,
	TemplateSourceSpan,
} from "./types.ts";

const ROOTS = new Set(["runtime", "parameters", "extensions"]);
const LEGACY_RUNTIME_FIELDS = new Set([
	"cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);

export function analyze(nodes: readonly TemplateNode[]): TemplateAnalyzeResult {
	const dependencies: TemplateDependency[] = [];
	const errors: TemplateAnalyzeResult["errors"] = [];

	const walk = (nodeList: readonly TemplateNode[]): void => {
		for (const node of nodeList) {
			if (node.kind === "text") continue;
			if (node.kind === "output") {
				addDependency(node.path, node.span);
				for (const filter of node.filters) {
					if (!FORGE_V1_FILTERS.includes(filter as (typeof FORGE_V1_FILTERS)[number])) {
						errors.push({ kind: "filter", message: `Unknown forge-v1 filter: ${filter}`, span: node.span });
					} else {
						dependencies.push({ kind: "filter", filter, span: node.span });
					}
				}
				continue;
			}
			if (node.kind === "if") {
				addDependency(node.predicate.path, node.predicate.span);
				walk(node.thenBody);
				if (node.elseBody) walk(node.elseBody);
			}
		}
	};

	const addDependency = (path: readonly string[], span: TemplateSourceSpan | undefined): void => {
		const root = path[0];
		if (!root) return;
		if (ROOTS.has(root)) {
			dependencies.push({ kind: root as "runtime" | "parameters" | "extensions", path, span });
		} else if (path.length === 1 && LEGACY_RUNTIME_FIELDS.has(root)) {
			dependencies.push({ kind: "legacy", path, span });
		} else {
			dependencies.push({ kind: "legacy", path, span });
		}
	};

	walk(nodes);
	return { dependencies, errors };
}
