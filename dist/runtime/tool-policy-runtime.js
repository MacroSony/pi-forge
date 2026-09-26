import { basename } from "node:path";
import { isValidToolName } from "../codecs/capability.js";
import { applyResourcePolicy, hasResourcePolicy, hasToolSelectionPolicy } from "../policy.js";
export function createToolPolicyRuntime(pi, getActiveStack) {
    let baseline;
    let lastApplied;
    let capabilityPatches = [];
    function filterKnownTools(names) {
        const known = new Set(pi.getAllTools().map((tool) => tool.name));
        if (known.size === 0)
            return names;
        return names.filter((name) => known.has(name));
    }
    function policySourceTools(policy, activeBaseline) {
        const hasSelectiveAllow = Array.isArray(policy?.allow)
            && policy.allow.length > 0
            && !policy.allow.includes("*");
        return hasSelectiveAllow
            ? pi.getAllTools().map((tool) => tool.name).filter((name) => typeof name === "string" && !!name)
            : filterKnownTools(activeBaseline);
    }
    function computeEffectiveTools(policy, sourceBaseline) {
        const policyActive = hasResourcePolicy(policy);
        const sourceTools = filterKnownTools(sourceBaseline);
        const registered = new Set(pi.getAllTools().map((tool) => tool.name));
        const baseList = Array.isArray(policy?.initial)
            ? policy.initial.filter((name) => registered.has(name))
            : policyActive
                ? applyResourcePolicy(policySourceTools(policy, sourceTools), policy)
                : sourceTools;
        const effective = [...baseList];
        for (const patch of capabilityPatches) {
            for (const name of patch.add) {
                if (registered.has(name) && !effective.includes(name)) {
                    effective.push(name);
                }
            }
        }
        const allRemoved = new Set();
        for (const patch of capabilityPatches) {
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
    function sync(ctx) {
        const policy = getActiveStack()?.stack.tools;
        const selectionActive = hasToolSelectionPolicy(policy);
        const capabilitiesActive = capabilityPatches.length > 0;
        if (!selectionActive && !capabilitiesActive) {
            restore(ctx);
            return;
        }
        const currentTools = filterKnownTools(pi.getActiveTools());
        if (baseline && lastApplied)
            baseline = reconcileToolPolicyBaseline(baseline, lastApplied, currentTools);
        const sourceTools = baseline ?? currentTools;
        baseline ??= [...sourceTools];
        const nextTools = computeEffectiveTools(policy, sourceTools);
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
        capabilityPatches = [];
        if (ctx)
            ctx.ui.setStatus("pi-forge-tools", undefined);
    }
    function snapshot() {
        return {
            baseline: baseline ? [...baseline] : [...pi.getActiveTools()],
            lastApplied: lastApplied ? [...lastApplied] : [...pi.getActiveTools()],
        };
    }
    function validateCapabilities(patches, options) {
        if (!Array.isArray(patches)) {
            return "Capability capability patches must be an array.";
        }
        const registered = new Set(pi.getAllTools().map((tool) => tool.name));
        const activeStack = options ? options.prospectiveStack : getActiveStack();
        const policy = activeStack?.stack.tools;
        const policyActive = hasResourcePolicy(policy);
        for (const patch of patches) {
            if (!patch || typeof patch !== "object") {
                return "Capability capability patch must be an object.";
            }
            if (!Array.isArray(patch.add) || !Array.isArray(patch.remove)) {
                return "Capability capability patch must have add and remove arrays.";
            }
            for (const name of patch.remove) {
                if (typeof name !== "string" || !isValidToolName(name)) {
                    return `Invalid tool name "${name}" in capability remove list.`;
                }
            }
            for (const name of patch.add) {
                if (typeof name !== "string" || !isValidToolName(name)) {
                    return `Invalid tool name "${name}" in capability add list.`;
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
    function setCapabilities(patches, restored) {
        const validationError = validateCapabilities(patches);
        if (validationError)
            throw new Error(validationError);
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
        capabilityPatches = patches.map((patch) => ({ add: [...patch.add], remove: [...patch.remove] }));
        if (restored) {
            const current = filterKnownTools(pi.getActiveTools());
            const expected = computeEffectiveTools(getActiveStack()?.stack.tools, restored.baseline);
            // A crash can land before or after the executable-selection update. Neither
            // known side of this transition is an external tool change. Reconcile only
            // distinguishable third-party differences against the saved applied set.
            if (sameStringSet(current, restored.lastApplied) || sameStringSet(current, expected))
                lastApplied = [...current];
        }
    }
    function blockReason(toolName) {
        const active = getActiveStack();
        if (active && hasResourcePolicy(active.stack.tools)) {
            if (!applyResourcePolicy([toolName], active.stack.tools).includes(toolName)) {
                return `Tool "${toolName}" is blocked by prompt stack "${active.stack.id}".`;
            }
        }
        const allRemoved = new Set();
        for (const patch of capabilityPatches) {
            for (const name of patch.remove) {
                allRemoved.add(name);
            }
        }
        if (allRemoved.has(toolName)) {
            return `Tool "${toolName}" is blocked by active capability.`;
        }
        return undefined;
    }
    function previewToolNames(stack) {
        const sourceTools = filterKnownTools(baseline ?? pi.getActiveTools());
        return computeEffectiveTools(stack?.tools, sourceTools);
    }
    function previewOptions(base, stack) {
        // Captured prompt options may predate activation OR restoration. The live
        // baseline/current selection is authoritative, including an empty selection.
        const sessionTools = filterKnownTools(baseline ?? pi.getActiveTools());
        const selectedTools = computeEffectiveTools(stack.tools, sessionTools);
        const selectedToolSet = new Set(selectedTools);
        const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
        const toolInfos = pi.getAllTools();
        for (const tool of toolInfos) {
            const name = stringValue(tool.name);
            if (!name || !selectedToolSet.has(name) || toolSnippets[name])
                continue;
            // ToolInfo does not carry promptSnippet; fall back to the tool
            // description so the preview never shows placeholder text.
            const snippet = stringValue(tool.promptSnippet)
                ?? stringValue(tool.description);
            if (snippet)
                toolSnippets[name] = snippet;
        }
        const mappedGuidelines = toolInfos
            .filter((tool) => {
            const name = stringValue(tool.name);
            return !!name && selectedToolSet.has(name);
        })
            .flatMap((tool) => stringArrayValue(tool.promptGuidelines));
        const promptGuidelines = baseline || capabilityPatches.length > 0 || !sameStringSet(base.selectedTools ?? sessionTools, selectedTools)
            ? mappedGuidelines
            : (base.promptGuidelines?.length ? [...base.promptGuidelines] : mappedGuidelines);
        return { ...base, selectedTools, toolSnippets, promptGuidelines };
    }
    function policyResources(options) {
        const current = filterKnownTools(pi.getActiveTools());
        const activeTools = new Set(current);
        const sourceBaseline = baseline && lastApplied
            ? reconcileToolPolicyBaseline(baseline, lastApplied, current)
            : baseline ?? current;
        const baselineTools = new Set(sourceBaseline);
        const snippets = options.toolSnippets ?? {};
        const tools = pi.getAllTools()
            .map((tool) => normalizeToolResource(tool, activeTools, snippets, baselineTools))
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
        setCapabilities,
        validateCapabilities,
    };
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
function normalizeToolResource(tool, activeTools, snippets, baselineTools) {
    const name = String(tool.name ?? "");
    return {
        name,
        description: stringValue(tool.description) ?? stringValue(tool.promptSnippet) ?? snippets[name],
        source: sourceLabel(tool.sourceInfo),
        group: sourceGroup(tool.sourceInfo),
        active: activeTools.has(name),
        baselineActive: baselineTools.has(name),
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
function sourceGroup(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const info = value;
    const source = stringValue(info.source);
    const path = stringValue(info.path);
    const scope = stringValue(info.scope);
    const origin = stringValue(info.origin);
    const baseDir = stringValue(info.baseDir);
    if (source === "builtin" || path?.startsWith("<builtin:")) {
        return { id: "builtin", label: "Pi" };
    }
    if (origin === "package") {
        if (scope && source && baseDir)
            return { id: JSON.stringify(["package", scope, source, baseDir]), label: source };
        if (path)
            return { id: JSON.stringify(["package-path", scope, source, path]), label: source ?? path };
        return undefined;
    }
    if (origin === "top-level" && path) {
        return { id: JSON.stringify(["top-level", scope, source, path]), label: `${basename(path)}${scope ? ` (${scope})` : ""}` };
    }
    return undefined;
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