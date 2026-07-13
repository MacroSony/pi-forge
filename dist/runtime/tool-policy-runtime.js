import { applyResourcePolicy, hasResourcePolicy } from "../policy.js";
export function createToolPolicyRuntime(pi, state) {
    let baseline;
    let lastApplied;
    function filterKnownTools(names) {
        const known = new Set(pi.getAllTools().map((tool) => tool.name));
        if (known.size === 0)
            return names;
        return names.filter((name) => known.has(name));
    }
    function sync(ctx) {
        const policy = state.active?.stack.tools;
        if (!hasResourcePolicy(policy)) {
            restore(ctx);
            return;
        }
        const currentTools = filterKnownTools(pi.getActiveTools());
        if (baseline && lastApplied)
            baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
        const sourceTools = baseline ?? currentTools;
        baseline ??= [...sourceTools];
        const nextTools = applyResourcePolicy(filterKnownTools(sourceTools), policy);
        if (!sameStringSet(currentTools, nextTools))
            pi.setActiveTools(nextTools);
        lastApplied = [...nextTools];
        if (ctx) {
            const label = nextTools.length > 0 ? `tools:${nextTools.length}` : "tools:none";
            ctx.ui.setStatus("pi-forge-tools", ctx.ui.theme.fg(nextTools.length > 0 ? "accent" : "warning", label));
        }
    }
    function restore(ctx) {
        if (baseline) {
            const currentTools = filterKnownTools(pi.getActiveTools());
            if (lastApplied)
                baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
            const restoredTools = filterKnownTools(baseline);
            if (!sameStringSet(currentTools, restoredTools))
                pi.setActiveTools(restoredTools);
            baseline = undefined;
        }
        lastApplied = undefined;
        if (ctx)
            ctx.ui.setStatus("pi-forge-tools", undefined);
    }
    function blockReason(toolName) {
        const active = state.active;
        if (!active || !hasResourcePolicy(active.stack.tools))
            return undefined;
        if (applyResourcePolicy([toolName], active.stack.tools).includes(toolName))
            return undefined;
        return `Tool "${toolName}" is blocked by prompt stack "${active.stack.id}".`;
    }
    function previewToolNames(stack) {
        const sourceTools = filterKnownTools(baseline ?? pi.getActiveTools());
        return stack && hasResourcePolicy(stack.tools) ? applyResourcePolicy(sourceTools, stack.tools) : sourceTools;
    }
    function previewOptions(ctx, stack) {
        const base = ctx.getSystemPromptOptions();
        const baseSelectedTools = Array.isArray(base.selectedTools) ? base.selectedTools : pi.getActiveTools();
        const policyActive = hasResourcePolicy(stack.tools);
        const baselineTools = policyActive ? (baseline ?? pi.getActiveTools()) : baseSelectedTools;
        const selectedTools = policyActive
            ? applyResourcePolicy(filterKnownTools(baselineTools), stack.tools)
            : baseSelectedTools;
        const selectedToolSet = new Set(selectedTools);
        const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
        const toolInfos = pi.getAllTools();
        for (const tool of toolInfos) {
            const name = stringValue(tool.name);
            if (!name || !selectedToolSet.has(name) || toolSnippets[name])
                continue;
            const snippet = stringValue(tool.promptSnippet);
            if (snippet)
                toolSnippets[name] = snippet;
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
    function policyResources(ctx) {
        const options = ctx.getSystemPromptOptions();
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
export function reconcileToolPolicyBaseline(baseline, lastApplied, current) {
    const baselineSet = new Set(baseline);
    const lastAppliedSet = new Set(lastApplied);
    const currentSet = new Set(current);
    for (const name of current) {
        if (!lastAppliedSet.has(name))
            baselineSet.add(name);
    }
    for (const name of lastApplied) {
        if (!currentSet.has(name))
            baselineSet.delete(name);
    }
    return [
        ...baseline.filter((name) => baselineSet.has(name)),
        ...current.filter((name) => baselineSet.has(name) && !baseline.includes(name)),
    ];
}
function filterToolSnippets(snippets, selectedTools) {
    const filtered = {};
    for (const [name, snippet] of Object.entries(snippets)) {
        if (selectedTools.has(name) && snippet)
            filtered[name] = snippet;
    }
    return filtered;
}
function normalizeToolResource(tool, activeTools, snippets) {
    const name = String(tool.name ?? "");
    return {
        name,
        description: stringValue(tool.description) ?? stringValue(tool.promptSnippet) ?? snippets[name],
        source: sourceLabel(tool.sourceInfo),
        active: activeTools.has(name),
    };
}
function normalizeSkillResource(skill) {
    return {
        name: String(skill.name ?? ""),
        description: stringValue(skill.description),
        source: stringValue(skill.filePath),
        hidden: skill.disableModelInvocation === true,
    };
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function stringArrayValue(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && !!item.trim()) : [];
}
function sourceLabel(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const source = stringValue(value.source);
    const path = stringValue(value.path);
    if (source && path)
        return `${source}: ${path}`;
    return source ?? path;
}
function comparePolicyResource(a, b) {
    return a.name.localeCompare(b.name);
}
function hasPolicyResourceName(resource) {
    return !!resource.name.trim();
}
function sameStringSet(left, right) {
    if (left.length !== right.length)
        return false;
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
}
//# sourceMappingURL=tool-policy-runtime.js.map