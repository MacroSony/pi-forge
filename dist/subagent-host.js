import { getRegisteredMacros, } from "./macro-engine.js";
import { getRegisteredSlots, } from "./slot-renderers.js";
import { compileMessages } from "./compiler.js";
import { subagentPromptStackFingerprint, subagentSourceProfileFingerprint, } from "./subagent/contract.js";
const BUILT_IN_MACROS = new Set([
    "cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
    "setvar", "setturnvar", "setsessionvar", "getvar", "var", "getturnvar", "getsessionvar",
    "clearvar", "clearturnvar", "clearsessionvar", "trim", "upper", "lower", "json", "xml",
    "ifvar", "ifeq", "iftools", "ifslot",
]);
const BUILT_IN_SLOTS = new Set([
    "chat-history", "tools", "tool-guidelines", "skills", "project-context", "append-system-prompt",
    "date", "cwd", "date-cwd", "active-model", "pi-docs", "variables",
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
    if (loaded.profile.promptStack !== null) {
        const matches = resources.promptStacks.filter((candidate) => candidate.stack.id === loaded.profile.promptStack);
        if (matches.length !== 1) {
            diagnostics.push({
                level: "error",
                code: matches.length === 0 ? "profile.stack-missing" : "profile.stack-ambiguous",
                path: "profile.promptStack",
                message: matches.length === 0
                    ? `Unknown prompt stack: ${loaded.profile.promptStack}`
                    : `Prompt stack id is ambiguous: ${loaded.profile.promptStack}`,
            });
        }
        else {
            promptStack = matches[0];
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
    const dependencyResult = promptStack
        ? collectSubagentPromptDependencies(promptStack.stack, registrations)
        : { dependencies: [], missingDependencies: [], diagnostics: [] };
    diagnostics.push(...dependencyResult.diagnostics);
    const resolution = {
        profileId: loaded.profile.id,
        dependencies: dependencyResult.dependencies,
        missingDependencies: dependencyResult.missingDependencies,
        diagnostics,
    };
    if (!diagnostics.some((diagnostic) => diagnostic.level === "error")) {
        resolution.snapshot = {
            schemaVersion: 1,
            profile: structuredClone(loaded.profile),
            promptStack: promptStack ? structuredClone(promptStack.stack) : null,
            dependencies: structuredClone(dependencyResult.dependencies),
            profileFingerprint: subagentSourceProfileFingerprint(loaded.profile),
            promptStackFingerprint: promptStack ? subagentPromptStackFingerprint(promptStack.stack) : null,
        };
    }
    return resolution;
}
export function collectSubagentPromptDependencies(stack, registrations = currentSubagentPromptRegistrationCatalog()) {
    const diagnostics = [];
    const dependencies = new Map();
    const missing = new Map();
    const macroCatalog = new Map(registrations.macros.map((entry) => [entry.name, entry]));
    const slotCatalog = new Map(registrations.slots.map((entry) => [entry.name, entry]));
    const staticVariables = new Set(Object.keys(stack.variables ?? {}));
    for (const item of stack.items) {
        if (item.kind === "slot") {
            if (BUILT_IN_SLOTS.has(item.slot))
                continue;
            addDependency("slot", item.slot, slotCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
            continue;
        }
        for (const name of collectMacroCommandNames(item.content)) {
            if (BUILT_IN_MACROS.has(name) || staticVariables.has(name))
                continue;
            addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
        }
    }
    return {
        dependencies: [...dependencies.values()].sort(compareDependencies),
        missingDependencies: [...missing.values()].sort(compareDependencies),
        diagnostics,
    };
}
export function collectMacroCommandNames(text) {
    const names = new Set();
    collectMacroCommandsInto(text, names);
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
    return { name: definition.name, source: definition.source };
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
function collectMacroCommandsInto(text, names) {
    let index = 0;
    while (index < text.length) {
        const start = text.indexOf("{{", index);
        if (start === -1)
            return;
        const end = findMacroEnd(text, start + 2);
        if (end === undefined)
            return;
        const expression = text.slice(start + 2, end).trim();
        const parts = splitMacroExpression(expression);
        const command = parts[0]?.trim();
        if (command && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(command))
            names.add(command);
        for (const argument of parts.slice(1))
            collectMacroCommandsInto(argument, names);
        index = end + 2;
    }
}
function findMacroEnd(text, start) {
    let depth = 1;
    for (let index = start; index < text.length - 1; index++) {
        const pair = text.slice(index, index + 2);
        if (pair === "{{") {
            depth++;
            index++;
        }
        else if (pair === "}}") {
            depth--;
            if (depth === 0)
                return index;
            index++;
        }
    }
    return undefined;
}
function splitMacroExpression(expression) {
    const parts = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < expression.length - 1; index++) {
        const pair = expression.slice(index, index + 2);
        if (pair === "{{") {
            depth++;
            index++;
        }
        else if (pair === "}}" && depth > 0) {
            depth--;
            index++;
        }
        else if (pair === "::" && depth === 0) {
            parts.push(expression.slice(start, index));
            start = index + 2;
            index++;
        }
    }
    parts.push(expression.slice(start));
    return parts;
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
function compareDependencies(left, right) {
    return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}
//# sourceMappingURL=subagent-host.js.map