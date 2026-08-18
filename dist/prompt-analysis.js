import { forgeV1 } from "./forge-v1/index.js";
export function analyzePromptStack(stack, registrations = { macros: [], slots: [] }) {
    const blocks = [];
    const slotDependencies = new Map();
    const diagnostics = [];
    for (const item of stack.items) {
        if (item.enabled === false)
            continue;
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
        if (definition?.dependencies?.length)
            slotDependencies.set(item.slot, definition.dependencies);
    }
    const transitiveExtensions = new Set();
    const visit = (name, path) => {
        if (transitiveExtensions.has(name))
            return;
        if (path.has(name))
            return;
        const definition = registrations.macros.find((macro) => macro.name === name);
        path.add(name);
        if (definition?.dependencies) {
            for (const dependency of definition.dependencies) {
                const depName = parseExtensionDependency(dependency);
                if (depName)
                    visit(depName, path);
            }
        }
        path.delete(name);
        transitiveExtensions.add(name);
    };
    for (const block of blocks) {
        for (const dependency of block.dependencies) {
            const name = dependency.kind === "extensions" ? dependency.path?.[1] : undefined;
            if (name)
                visit(name, new Set());
        }
    }
    for (const deps of slotDependencies.values()) {
        for (const dependency of deps) {
            const name = parseExtensionDependency(dependency);
            if (name)
                visit(name, new Set());
        }
    }
    return { blocks, slotDependencies, transitiveExtensions, diagnostics };
}
function parseExtensionDependency(dependency) {
    const trimmed = dependency.trim();
    if (trimmed.startsWith("extensions.")) {
        const name = trimmed.slice("extensions.".length).trim();
        return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
    }
    return undefined;
}
//# sourceMappingURL=prompt-analysis.js.map