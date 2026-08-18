import { getRegisteredMacros, } from "./macro-engine.js";
import { getRegisteredSlots, } from "./slot-renderers.js";
import { compileMessages, PromptCompilationContext } from "./compiler.js";
import { subagentPromptStackFingerprint, subagentSourceProfileFingerprint, negotiateSubagentTools, prepareSubagentInitialMessages, } from "./subagent/contract.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { forgeV1 } from "./forge-v1/index.js";
import { analyzePromptStack } from "./prompt-analysis.js";
const BUILT_IN_SLOTS = new Set([
    "chat-history", "tools", "tool-guidelines", "skills", "project-context", "append-system-prompt",
    "date", "cwd", "date-cwd", "active-model", "pi-docs",
]);
export function currentSubagentPromptRegistrationCatalog() {
    return {
        macros: getRegisteredMacros().map(registrationEntry),
        slots: getRegisteredSlots().map(registrationEntry),
    };
}
export function resolveSubagentHostProfile(loaded, resources) {
    const diagnostics = loaded.diagnostics.map((diagnostic) => ({
        level: diagnostic.level,
        code: "profile.validation",
        path: diagnostic.field ? `profile.${diagnostic.field}` : "profile",
        message: diagnostic.message,
    }));
    const registrations = resources.registrations ?? currentSubagentPromptRegistrationCatalog();
    let promptStack;
    let promptStackId = null;
    if (loaded.profile.promptStack !== null) {
        const reference = loaded.profile.promptStack;
        const parsed = parseResourceSelector(reference);
        if (!parsed.ok) {
            diagnostics.push({
                level: "error",
                code: "profile.stack-reference",
                path: "profile.promptStack",
                message: parsed.error,
            });
        }
        else if (loaded.scope === "global" && parsed.selector.scope === "project") {
            diagnostics.push({
                level: "error",
                code: "profile.stack-reference",
                path: "profile.promptStack",
                message: `Global profile ${loaded.profile.id} cannot reference project prompt stack ${parsed.selector.id}.`,
            });
        }
        else {
            const scope = parsed.selector.scope ?? loaded.scope;
            const matches = resources.promptStacks.filter((candidate) => candidate.scope === scope && candidate.stack.id === parsed.selector.id);
            if (matches.length !== 1) {
                diagnostics.push({
                    level: "error",
                    code: matches.length === 0 ? "profile.stack-missing" : "profile.stack-ambiguous",
                    path: "profile.promptStack",
                    message: matches.length === 0
                        ? `Unknown prompt stack: ${reference}`
                        : `Prompt stack id is ambiguous: ${reference}`,
                });
            }
            else {
                promptStack = matches[0];
                promptStackId = formatResourceKey({ scope, id: parsed.selector.id });
                for (const diagnostic of promptStack.diagnostics) {
                    diagnostics.push({
                        level: diagnostic.level,
                        code: "profile.stack-validation",
                        path: diagnostic.itemId ? `promptStack.items.${diagnostic.itemId}` : "promptStack",
                        message: diagnostic.message,
                    });
                }
                if (!promptStack.stack.mode || !["replace", "append", "prepend"].includes(promptStack.stack.mode)) {
                    if (promptStack.stack.mode !== undefined)
                        diagnostics.push({ level: "error", code: "profile.stack-mode", path: "promptStack.mode", message: `Unsupported prompt stack mode: ${String(promptStack.stack.mode)}` });
                }
            }
        }
    }
    const dependencyResult = promptStack
        ? collectSubagentPromptDependencies(promptStack.stack, registrations)
        : { dependencies: [], missingDependencies: [], diagnostics: [] };
    diagnostics.push(...dependencyResult.diagnostics);
    const resolution = {
        profileId: formatResourceKey(loaded.key),
        dependencies: dependencyResult.dependencies,
        missingDependencies: dependencyResult.missingDependencies,
        diagnostics,
    };
    if (!diagnostics.some((diagnostic) => diagnostic.level === "error")) {
        resolution.snapshot = {
            schemaVersion: 1,
            profileId: formatResourceKey(loaded.key),
            profile: structuredClone(loaded.profile),
            promptStackId,
            promptStack: promptStack ? structuredClone(promptStack.stack) : null,
            dependencies: structuredClone(dependencyResult.dependencies),
            profileFingerprint: subagentSourceProfileFingerprint(loaded.profile),
            promptStackFingerprint: promptStack ? subagentPromptStackFingerprint(promptStack.stack) : null,
        };
    }
    return resolution;
}
export function prepareSubagentHostPlan(input) {
    const toolNegotiation = negotiateSubagentTools(input.preflight.toolCatalog, input.snapshot.promptStack?.tools, input.request.access);
    const options = {
        ...structuredClone(input.runtime.options),
        selectedTools: [...toolNegotiation.effectiveToolNames],
        toolSnippets: Object.fromEntries(Object.entries(input.runtime.options.toolSnippets)
            .filter(([name]) => toolNegotiation.effectiveToolNames.includes(name))),
        promptGuidelines: toolNegotiation.effectiveToolNames.length > 0
            ? [...input.runtime.options.promptGuidelines]
            : [],
        skills: structuredClone(input.runtime.options.skills),
        contextFiles: [...input.runtime.options.contextFiles],
    };
    const model = {
        provider: input.runtime.model.provider,
        id: input.runtime.model.id,
        api: "unknown",
    };
    const runtime = {
        options,
        ctx: { model },
        latestUserMessage: input.request.input.text,
        now: new Date(input.runtime.preparedAt),
    };
    let systemPrompt = input.runtime.baseSystemPrompt;
    let stackMessages = [];
    const diagnostics = [];
    if (input.snapshot.promptStack) {
        const compilation = new PromptCompilationContext(input.snapshot.promptStack, runtime);
        const system = compilation.compileSystemPrompt(input.runtime.baseSystemPrompt);
        systemPrompt = system.systemPrompt;
        diagnostics.push(...system.diagnostics.map((item) => promptDiagnostic("system", item)));
        const messages = compilation.compileMessages([]);
        stackMessages = messages.messages.map(preparedPromptStackMessage);
        diagnostics.push(...messages.diagnostics.map((item) => promptDiagnostic("messages", item)));
    }
    const initial = prepareSubagentInitialMessages(input.request, stackMessages);
    return {
        systemPrompt,
        messages: initial.messages,
        contextBudget: initial.contextBudget,
        toolNegotiation,
        diagnostics: [...diagnostics, ...initial.diagnostics],
    };
}
export function collectSubagentPromptDependencies(stack, registrations = currentSubagentPromptRegistrationCatalog()) {
    const diagnostics = [];
    const dependencies = new Map();
    const missing = new Map();
    const macroCatalog = new Map(registrations.macros.map((entry) => [entry.name, entry]));
    const slotCatalog = new Map(registrations.slots.map((entry) => [entry.name, entry]));
    const parameters = new Set([
        ...Object.keys(stack.parameters ?? {}),
        ...Object.keys(stack.variables ?? {}),
    ]);
    const analysis = analyzePromptStack(stack, registrations);
    for (const error of analysis.diagnostics) {
        diagnostics.push({
            level: "error",
            code: "prompt-stack.template-analyze",
            path: "promptStack",
            message: error.message,
        });
    }
    for (const item of stack.items) {
        if (item.kind === "slot") {
            if (BUILT_IN_SLOTS.has(item.slot))
                continue;
            addDependency("slot", item.slot, slotCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
        }
    }
    for (const block of analysis.blocks) {
        for (const dependency of block.dependencies) {
            let name;
            if (dependency.kind === "extensions")
                name = dependency.path?.[1];
            if (dependency.kind === "legacy") {
                const candidate = dependency.path?.[0];
                if (!candidate || parameters.has(candidate) || LEGACY_BUILTIN_RUNTIME.has(candidate))
                    continue;
                name = candidate;
            }
            if (!name)
                continue;
            addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, `promptStack.items.${block.itemId}`);
        }
    }
    for (const name of analysis.transitiveExtensions) {
        if (!name || macroCatalog.has(name))
            continue;
        addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, "promptStack");
    }
    return {
        dependencies: [...dependencies.values()].sort(compareDependencies),
        missingDependencies: [...missing.values()].sort(compareDependencies),
        diagnostics,
    };
}
const LEGACY_BUILTIN_RUNTIME = new Set([
    "cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);
export function collectMacroCommandNames(text) {
    const parsed = forgeV1.parse(text);
    if (!parsed.ok)
        return [];
    const analyzed = forgeV1.analyze(parsed.ast);
    const names = new Set();
    for (const dependency of analyzed.dependencies) {
        if (dependency.kind === "extensions")
            names.add(dependency.path?.[1] ?? "");
        if (dependency.kind === "legacy") {
            const candidate = dependency.path?.[0];
            if (candidate && !LEGACY_BUILTIN_RUNTIME.has(candidate))
                names.add(candidate);
        }
    }
    return [...names].sort();
}
export function appendProtectedAgentTask(compiledMessages, protectedTask) {
    if (protectedTask.role !== "user")
        throw new Error("Protected delegated task must be a user message.");
    return [...structuredClone(compiledMessages), structuredClone(protectedTask)];
}
export function compileProtectedAgentTaskMessages(stack, runtime, originalMessages) {
    const taskIndex = findLastUserMessageIndex(originalMessages);
    if (taskIndex === -1)
        throw new Error("Delegated context contains no final user task.");
    const protectedTask = structuredClone(originalMessages[taskIndex]);
    const history = originalMessages.filter((_message, index) => index !== taskIndex);
    const compiled = compileMessages(stack.stack, runtime, history);
    return { messages: appendProtectedAgentTask(compiled.messages, protectedTask), diagnostics: compiled.diagnostics };
}
export function isProtectedAgentTaskPreserved(messages, task) {
    if (!messages.length || task.role !== "user")
        return false;
    const finalMessage = messages.at(-1);
    if (finalMessage?.role !== "user")
        return false;
    return normalizeUserContent(finalMessage.content)
        === normalizeUserContent(task.content);
}
function registrationEntry(definition) {
    return { name: definition.name, source: definition.source, dependencies: definition.dependencies };
}
function addDependency(kind, name, catalog, dependencies, missing, diagnostics, path) {
    const key = `${kind}:${name}`;
    const registration = catalog.get(name);
    if (!registration) {
        missing.set(key, { kind, name });
        diagnostics.push({ level: "error", code: "profile.dependency-missing", path, message: `Missing required custom ${kind}: ${name}` });
        return;
    }
    const identity = `${kind}:${registration.source ?? "anonymous"}:${name}`;
    dependencies.set(key, { kind, name, identity, source: registration.source });
    if (!registration.source)
        diagnostics.push({ level: "warning", code: "profile.dependency-anonymous", path, message: `Custom ${kind} ${name} has no stable source identity.` });
}
function findLastUserMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === "user")
            return index;
    }
    return -1;
}
function normalizeUserContent(content) {
    const normalized = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [content];
    return JSON.stringify(normalized);
}
function preparedPromptStackMessage(message) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") {
        throw new Error(`Unsupported prompt-stack message role for subagent preparation: ${message.role}`);
    }
    const rawContent = message.content;
    const parts = typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : Array.isArray(rawContent)
            ? rawContent.filter((part) => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
            : [];
    return {
        role: message.role,
        content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
        source: "prompt-stack",
    };
}
function promptDiagnostic(stage, diagnostic) {
    return {
        level: diagnostic.level,
        code: `preparation.${stage}`,
        path: diagnostic.itemId ? `promptStack.items.${diagnostic.itemId}` : "promptStack",
        message: diagnostic.message,
    };
}
function compareDependencies(left, right) {
    return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}
//# sourceMappingURL=subagent-host.js.map