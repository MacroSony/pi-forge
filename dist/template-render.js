import { forgeV1, FORGE_V1_MAX_EXTENSION_OUTPUT } from "./forge-v1/index.js";
import { createMacroRenderContext, getRegisteredMacro } from "./macro-engine.js";
import { selectedToolNames } from "./render-helpers.js";
const LEGACY_RUNTIME_FIELDS = new Set([
    "cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);
export class ForgeTemplateRenderer {
    base;
    extensions = new Map();
    workingExtensions = {};
    resolving = new Set();
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
            const env = freezeEnvironment({
                runtime: this.base.runtime,
                parameters: this.base.parameters,
                extensions: { ...this.workingExtensions },
            });
            const result = forgeV1.render(parsed.ast, env, {
                resolveExtension: (name) => this.resolveExtensionForRender(name, diagnostics, itemId),
            });
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
        return freezeEnvironment({
            runtime: this.base.runtime,
            parameters: this.base.parameters,
            extensions: { ...this.workingExtensions },
        });
    }
    environmentForDependencies(dependencies, diagnostics, itemId) {
        for (const dependency of dependencies) {
            const name = parseExtensionDependency(dependency);
            if (!name)
                continue;
            try {
                this.resolveExtensionForRender(name, diagnostics, itemId);
            }
            catch (error) {
                const message = error && typeof error === "object" && "message" in error
                    ? String(error.message)
                    : String(error);
                diagnostics.push({ level: "error", message, itemId });
            }
        }
        return this.environment();
    }
    setLatestUserMessage(message) {
        this.base.runtime.lastUserMessage = message;
    }
    resolveExtensionForRender(name, diagnostics, itemId) {
        const cached = this.extensions.get(name);
        if (cached !== undefined)
            return cached;
        if (this.resolving.has(name)) {
            const forgeError = {
                kind: "evaluate",
                message: `forge-v1 extension cycle detected at: ${name}`,
            };
            throw forgeError;
        }
        if (this.resolving.size >= 32) {
            const forgeError = {
                kind: "evaluate",
                message: "forge-v1 extension dependency graph is too deep.",
            };
            throw forgeError;
        }
        const definition = getRegisteredMacro(name);
        if (!definition)
            return undefined;
        this.resolving.add(name);
        try {
            // Resolve declared extension dependencies first so the macro's frozen env
            // contains the dependency snapshot it declared.
            if (definition.dependencies) {
                for (const dependency of definition.dependencies) {
                    const depName = parseExtensionDependency(dependency);
                    if (depName)
                        this.resolveExtensionForRender(depName, diagnostics, itemId);
                }
            }
            const env = freezeEnvironment({
                runtime: this.base.runtime,
                parameters: this.base.parameters,
                extensions: { ...this.workingExtensions },
            });
            let value;
            try {
                value = definition.render(createMacroRenderContext(env));
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw {
                    kind: "evaluate",
                    message: `forge-v1 extension ${name} failed: ${detail}`,
                };
            }
            if (value.length > FORGE_V1_MAX_EXTENSION_OUTPUT) {
                const forgeError = {
                    kind: "extension-limit",
                    message: `forge-v1 extension ${name} exceeds ${FORGE_V1_MAX_EXTENSION_OUTPUT} characters.`,
                };
                throw forgeError;
            }
            this.extensions.set(name, value);
            this.workingExtensions[name] = value;
            return value;
        }
        finally {
            this.resolving.delete(name);
        }
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
function parseExtensionDependency(dependency) {
    const trimmed = dependency.trim();
    if (trimmed.startsWith("extensions.")) {
        const name = trimmed.slice("extensions.".length).trim();
        return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
    }
    return undefined;
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
//# sourceMappingURL=template-render.js.map