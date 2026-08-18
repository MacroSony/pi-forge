import { forgeV1, FORGE_V1_MAX_EXTENSION_OUTPUT } from "./forge-v1/index.js";
import { createMacroRenderContext, getRegisteredMacro } from "./macro-engine.js";
import { selectedToolNames } from "./render-helpers.js";
const LEGACY_RUNTIME_FIELDS = new Set([
    "cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);
export class ForgeTemplateRenderer {
    base;
    extensions = new Map();
    stack;
    constructor(stack, runtime) {
        this.stack = stack;
        this.base = buildPromptEnvironment(stack, runtime);
    }
    render(text, diagnostics, itemId) {
        const parsed = forgeV1.parse(text);
        if (!parsed.ok) {
            diagnostics.push({
                level: "error",
                message: `forge-v1 parse error: ${parsed.error.message}`,
                itemId,
            });
            return "";
        }
        const analyzed = forgeV1.analyze(parsed.ast);
        if (analyzed.errors.length > 0) {
            for (const error of analyzed.errors) {
                diagnostics.push({ level: "error", message: error.message, itemId });
            }
            return "";
        }
        try {
            const before = diagnostics.length;
            const env = this.resolveExtensions(parsed.ast, analyzed.dependencies, diagnostics, itemId);
            if (diagnostics.length > before)
                return "";
            const result = forgeV1.render(parsed.ast, env);
            if (!result.ok) {
                diagnostics.push({
                    level: "error",
                    message: `forge-v1 render error: ${result.error.message}`,
                    itemId,
                });
                return "";
            }
            return result.text;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            diagnostics.push({ level: "error", message: `forge-v1 compile error: ${detail}`, itemId });
            return "";
        }
    }
    environment() {
        return this.resolveExtensions([], [], [], undefined);
    }
    resolveExtensions(_nodes, dependencies, diagnostics, itemId) {
        const direct = new Set();
        for (const dependency of dependencies) {
            if (dependency.kind === "extensions") {
                direct.add(dependency.path?.[1] ?? "");
            }
            else if (dependency.kind === "legacy") {
                const name = dependency.path?.[0];
                if (!name)
                    continue;
                if (LEGACY_RUNTIME_FIELDS.has(name))
                    continue;
                if (Object.prototype.hasOwnProperty.call(this.base.parameters, name))
                    continue;
                // Only attempt extension resolution when a macro is actually registered;
                // otherwise the renderer reports a strict undefined path.
                if (getRegisteredMacro(name))
                    direct.add(name);
            }
        }
        const names = this.expandExtensionNames(direct, diagnostics, itemId);
        const workingExtensions = {};
        const visited = new Set();
        for (const name of names) {
            if (!name)
                continue;
            const value = this.resolveExtensionValue(name, workingExtensions, visited, diagnostics, itemId);
            if (value !== undefined)
                workingExtensions[name] = value;
        }
        return freezeEnvironment({
            runtime: this.base.runtime,
            parameters: this.base.parameters,
            extensions: workingExtensions,
        });
    }
    expandExtensionNames(initial, diagnostics, itemId) {
        const ordered = [];
        const seen = new Set();
        const path = new Set();
        const visit = (name) => {
            if (seen.has(name))
                return;
            if (path.has(name)) {
                diagnostics.push({ level: "error", message: `forge-v1 extension cycle detected at: ${name}`, itemId });
                return;
            }
            if (path.size >= 32) {
                diagnostics.push({ level: "error", message: "forge-v1 extension dependency graph is too deep.", itemId });
                return;
            }
            const definition = getRegisteredMacro(name);
            path.add(name);
            if (definition?.dependencies) {
                for (const dependency of definition.dependencies) {
                    const depName = parseExtensionDependency(dependency);
                    if (depName)
                        visit(depName);
                }
            }
            path.delete(name);
            seen.add(name);
            ordered.push(name);
        };
        for (const name of initial)
            visit(name);
        return ordered;
    }
    resolveExtensionValue(name, working, visited, diagnostics, itemId) {
        const cached = this.extensions.get(name);
        if (cached !== undefined)
            return cached;
        if (visited.has(name)) {
            diagnostics.push({ level: "error", message: `forge-v1 extension cycle detected at: ${name}`, itemId });
            return undefined;
        }
        const definition = getRegisteredMacro(name);
        if (!definition) {
            diagnostics.push({ level: "error", message: `Unknown forge-v1 extension: ${name}`, itemId });
            return undefined;
        }
        visited.add(name);
        const env = freezeEnvironment({
            runtime: this.base.runtime,
            parameters: this.base.parameters,
            extensions: { ...working, ...Object.fromEntries(this.extensions) },
        });
        let value;
        try {
            value = definition.render(createMacroRenderContext(env));
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            diagnostics.push({
                level: "error",
                message: `forge-v1 extension ${name} failed: ${detail}`,
                itemId,
            });
            visited.delete(name);
            return undefined;
        }
        visited.delete(name);
        if (value.length > FORGE_V1_MAX_EXTENSION_OUTPUT) {
            diagnostics.push({
                level: "error",
                message: `forge-v1 extension ${name} exceeds ${FORGE_V1_MAX_EXTENSION_OUTPUT} characters.`,
                itemId,
            });
            return undefined;
        }
        this.extensions.set(name, value);
        working[name] = value;
        return value;
    }
}
export function buildPromptEnvironment(stack, runtime) {
    const tools = selectedToolNames(stack, runtime);
    const toolBooleans = {};
    for (const name of tools)
        toolBooleans[name] = true;
    const slotBooleans = {};
    for (const item of stack.items) {
        if (item.kind === "slot" && item.enabled !== false && item.slot)
            slotBooleans[item.slot] = true;
    }
    const params = {};
    if (stack.schemaVersion === 2) {
        Object.assign(params, stack.parameters ?? {});
    }
    else {
        for (const [key, value] of Object.entries(stack.variables ?? {}))
            params[key] = value;
    }
    const model = runtime.ctx?.model;
    const env = {
        runtime: {
            cwd: runtime.options.cwd,
            date: formatDate(runtime.now),
            time: formatTime(runtime.now),
            lastUserMessage: runtime.latestUserMessage ?? "",
            selectedTools: tools,
            selectedToolsText: tools.join(", "),
            activeModel: model ? `${model.provider}/${model.id}` : "",
            populatedAt: runtime.now.toISOString(),
            timezone: "local",
            tool: toolBooleans,
            slot: slotBooleans,
        },
        parameters: params,
        extensions: {},
    };
    return env;
}
export function freezeEnvironment(environment) {
    const clone = structuredClone(environment);
    const freeze = (value) => {
        if (value === null || typeof value !== "object")
            return value;
        if (Array.isArray(value)) {
            value.forEach((item) => freeze(item));
            return Object.freeze(value);
        }
        const record = value;
        for (const key of Object.keys(record))
            record[key] = freeze(record[key]);
        return Object.freeze(record);
    };
    freeze(clone);
    return clone;
}
function formatDate(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function formatTime(now) {
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
}
function parseExtensionDependency(dependency) {
    const trimmed = dependency.trim();
    if (trimmed.startsWith("extensions.")) {
        const name = trimmed.slice("extensions.".length).trim();
        return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
    }
    return undefined;
}
//# sourceMappingURL=template-render.js.map