import { FORGE_V1_FILTERS } from "./types.js";
const ROOTS = new Set(["runtime", "parameters", "extensions"]);
const LEGACY_RUNTIME_FIELDS = new Set([
    "cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);
export function analyze(nodes) {
    const dependencies = [];
    const errors = [];
    const walk = (nodeList) => {
        for (const node of nodeList) {
            if (node.kind === "text")
                continue;
            if (node.kind === "output") {
                addDependency(node.path, node.span);
                for (const filter of node.filters) {
                    if (!FORGE_V1_FILTERS.includes(filter)) {
                        errors.push({ kind: "filter", message: `Unknown forge-v1 filter: ${filter}`, span: node.span });
                    }
                    else {
                        dependencies.push({ kind: "filter", filter, span: node.span });
                    }
                }
                continue;
            }
            if (node.kind === "if") {
                addDependency(node.predicate.path, node.predicate.span);
                walk(node.thenBody);
                if (node.elseBody)
                    walk(node.elseBody);
            }
        }
    };
    const addDependency = (path, span) => {
        const root = path[0];
        if (!root)
            return;
        if (ROOTS.has(root)) {
            dependencies.push({ kind: root, path, span });
        }
        else if (path.length === 1 && LEGACY_RUNTIME_FIELDS.has(root)) {
            dependencies.push({ kind: "legacy", path, span });
        }
        else {
            dependencies.push({ kind: "legacy", path, span });
        }
    };
    walk(nodes);
    return { dependencies, errors };
}
//# sourceMappingURL=analyzer.js.map