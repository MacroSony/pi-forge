import { basename } from "node:path";
import { hasResourcePolicy } from "../policy.js";
import { validateRegexConfig } from "../regex.js";
import { isValidResourceId } from "../resource-identity.js";
import { SUPPORTED_SLOTS } from "../types.js";
const VALID_ROLES = new Set(["system", "user", "assistant", "custom"]);
const VALID_CHAT_HISTORY_TOOL_MODES = new Set(["keep", "drop"]);
/**
 * Parse, normalize, and validate a prompt stack from its serialized source.
 * This is the single entry point for turning stack JSON text into a
 * LoadedPromptStack; loaders only add file-system concerns on top.
 */
export function parsePromptStack(source, filePath, scope) {
    const diagnostics = [];
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch (error) {
        return createPromptStackFault(filePath, scope, `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    diagnostics.push(...validateRawPromptStackShape(raw));
    const stack = normalizeStack(raw, filePath, diagnostics);
    diagnostics.push(...validatePromptStack(stack));
    if (basename(filePath) === "default.json"
        && isPlainObject(raw)
        && !Object.prototype.hasOwnProperty.call(raw, "autoActivate")) {
        diagnostics.push({
            level: "warning",
            message: 'default.json no longer auto-activates by filename; set "autoActivate": true to keep auto-activating this stack.',
        });
    }
    // validateRawPromptStackShape runs over the raw input and validatePromptStack
    // re-runs shape validation over the normalized stack; fields such as
    // defaults.* and context.* pass through normalization unchanged, so collapse
    // exact duplicates before surfacing diagnostics.
    return { filePath, scope, key: { scope, id: stack.id }, stack, diagnostics: dedupeDiagnostics(diagnostics) };
}
function dedupeDiagnostics(diagnostics) {
    const seen = new Set();
    const result = [];
    for (const diagnostic of diagnostics) {
        const key = `${diagnostic.level}\0${diagnostic.message}\0${diagnostic.itemId ?? ""}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(diagnostic);
    }
    return result;
}
/** Build a fail-closed LoadedPromptStack when the source cannot be read or parsed. */
export function createPromptStackFault(filePath, scope, message) {
    return {
        filePath,
        scope,
        key: { scope, id: basename(filePath, ".json") },
        stack: fallbackStack(filePath),
        diagnostics: [{ level: "error", message }],
    };
}
/**
 * Single canonical serializer for prompt stacks. Every writer (web host,
 * repository, migration tooling) must go through this function so serialized
 * output stays identical across all write paths.
 */
export function serializePromptStack(stack) {
    return `${JSON.stringify(stack, null, 2)}\n`;
}
function fallbackStack(filePath) {
    return {
        schemaVersion: 1,
        type: "pi-forge.prompt-stack",
        id: basename(filePath, ".json"),
        name: basename(filePath),
        items: [],
    };
}
function normalizeStack(raw, filePath, diagnostics) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        diagnostics.push({ level: "error", message: "Prompt stack root must be a JSON object." });
        return fallbackStack(filePath);
    }
    const obj = raw;
    const rawId = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : undefined;
    const id = rawId && isValidResourceId(rawId) ? rawId : basename(filePath, ".json");
    if (rawId && !isValidResourceId(rawId)) {
        diagnostics.push({
            level: "error",
            message: `Stack id ${rawId} must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens; falling back to ${id}.`,
        });
    }
    let schemaVersion = 1;
    if (obj.schemaVersion === 2) {
        schemaVersion = 2;
    }
    else if (obj.schemaVersion !== undefined && obj.schemaVersion !== 1) {
        diagnostics.push({ level: "warning", message: `Unsupported schemaVersion; assuming 1.` });
    }
    const items = Array.isArray(obj.items) ? obj.items.map((item, index) => normalizeItem(item, index, diagnostics)) : [];
    if (!Array.isArray(obj.items)) {
        diagnostics.push({ level: "error", message: "Prompt stack must contain an items array." });
    }
    if (isPlainObject(obj.state) && Object.keys(obj.state).length > 0) {
        diagnostics.push({
            level: "info",
            message: "state is no longer supported and was ignored; use stack.variables and template interpolation instead.",
        });
    }
    return {
        schemaVersion,
        type: obj.type === "pi-forge.prompt-stack" ? "pi-forge.prompt-stack" : undefined,
        id,
        name: typeof obj.name === "string" ? obj.name : undefined,
        description: typeof obj.description === "string" ? obj.description : undefined,
        autoActivate: typeof obj.autoActivate === "boolean" ? obj.autoActivate : undefined,
        mode: obj.mode === "append" || obj.mode === "prepend" || obj.mode === "replace" ? obj.mode : undefined,
        defaults: isPlainObject(obj.defaults) ? obj.defaults : undefined,
        context: isPlainObject(obj.context) ? obj.context : undefined,
        tools: normalizeResourcePolicy(obj.tools, "tools", diagnostics),
        skills: normalizeResourcePolicy(obj.skills, "skills", diagnostics),
        variables: schemaVersion === 1 ? normalizeStringRecord(obj.variables) : undefined,
        parameters: schemaVersion === 2 ? normalizeParameterRecord(obj.parameters, diagnostics) : undefined,
        regex: normalizeRegexConfig(obj.regex, diagnostics),
        items,
        import: isPlainObject(obj.import) ? obj.import : undefined,
    };
}
function normalizeItem(raw, index, diagnostics) {
    const fallbackId = `item-${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        diagnostics.push({ level: "error", message: `Item ${index + 1} must be an object.`, itemId: fallbackId });
        return { kind: "block", id: fallbackId, enabled: false, content: "" };
    }
    const obj = raw;
    const kind = obj.kind === "slot" ? "slot" : "block";
    const id = normalizeId(obj.id, fallbackId);
    const base = {
        kind,
        id,
        name: typeof obj.name === "string" ? obj.name : undefined,
        enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
        role: VALID_ROLES.has(obj.role) ? obj.role : undefined,
        tags: Array.isArray(obj.tags) ? obj.tags.filter((tag) => typeof tag === "string") : undefined,
        source: isPlainObject(obj.source) ? obj.source : undefined,
    };
    if (kind === "slot") {
        return {
            ...base,
            kind: "slot",
            slot: typeof obj.slot === "string" ? obj.slot : "",
            options: isPlainObject(obj.options) ? obj.options : undefined,
        };
    }
    return {
        ...base,
        kind: "block",
        content: typeof obj.content === "string" ? obj.content : "",
    };
}
export function validatePromptStack(stack) {
    const diagnostics = validateRawPromptStackShape(stack);
    const ids = new Set();
    let chatHistoryCount = 0;
    if (!stack.id.trim())
        diagnostics.push({ level: "error", message: "Stack id must not be empty." });
    let seenNonSystemItem = false;
    for (const item of stack.items) {
        if (ids.has(item.id))
            diagnostics.push({ level: "error", message: `Duplicate item id: ${item.id}`, itemId: item.id });
        ids.add(item.id);
        if (item.role && !VALID_ROLES.has(item.role)) {
            diagnostics.push({ level: "error", message: `Invalid role: ${item.role}`, itemId: item.id });
        }
        if (item.enabled !== false) {
            if (item.role === "system") {
                if (seenNonSystemItem) {
                    diagnostics.push({
                        level: "warning",
                        message: "System item appears after non-system items; item position across the system/message channels has no effect on compilation. Use a user-role item for in-conversation injection.",
                        itemId: item.id,
                    });
                }
            }
            else if (item.role === "user" || item.role === "assistant" || item.role === "custom") {
                seenNonSystemItem = true;
            }
        }
        if (item.kind === "slot") {
            if (!SUPPORTED_SLOTS.has(item.slot)) {
                diagnostics.push({ level: "warning", message: `Unsupported slot: ${item.slot}`, itemId: item.id });
            }
            if (item.enabled !== false && item.slot === "chat-history")
                chatHistoryCount++;
            if (item.slot === "chat-history")
                validateChatHistoryOptions(item, diagnostics);
        }
        if (item.kind === "block" && item.role !== "system" && item.enabled !== false && !item.role) {
            diagnostics.push({ level: "warning", message: "Enabled block has no role and will be ignored.", itemId: item.id });
        }
    }
    if (chatHistoryCount === 0) {
        diagnostics.push({
            level: "warning",
            message: "No enabled chat-history slot found; Pi chat context will be appended at the end.",
        });
    }
    else if (chatHistoryCount > 1 && !stack.context?.allowDuplicateChatHistory) {
        diagnostics.push({
            level: "warning",
            message: "Multiple enabled chat-history slots found; only the first will be expanded unless context.allowDuplicateChatHistory is true.",
        });
    }
    diagnostics.push(...validateResourcePolicy(stack.tools, "tools"));
    diagnostics.push(...validateResourcePolicy(stack.skills, "skills"));
    const hasSkillPolicy = hasResourcePolicy(stack.skills);
    if (hasSkillPolicy) {
        diagnostics.push({
            level: "info",
            message: "skills policy only filters model-visible skills rendered by pi-forge skills slots; it does not disable explicit skill invocation and is not a security boundary.",
        });
    }
    if ((stack.mode === "append" || stack.mode === "prepend") && hasSkillPolicy) {
        diagnostics.push({
            level: "warning",
            message: "skills policy only filters pi-forge skills slots. Use mode \"replace\" if you need the base Pi prompt to omit filtered skills.",
        });
    }
    diagnostics.push(...validateRegexConfig(stack.regex));
    return diagnostics;
}
function validateRawPromptStackShape(raw) {
    const diagnostics = [];
    if (!isPlainObject(raw))
        return diagnostics;
    if (typeof raw.id !== "string" || !raw.id.trim()) {
        diagnostics.push({ level: "error", message: "Stack id must be a non-empty string." });
    }
    if (raw.type !== undefined && raw.type !== "pi-forge.prompt-stack") {
        diagnostics.push({ level: "error", message: 'Stack type must be "pi-forge.prompt-stack" when provided.' });
    }
    validateOptionalString(raw, "name", "Stack name", diagnostics);
    validateOptionalString(raw, "description", "Stack description", diagnostics);
    validateOptionalBoolean(raw, "autoActivate", "Stack autoActivate", diagnostics);
    if (raw.mode !== undefined && raw.mode !== "append" && raw.mode !== "prepend" && raw.mode !== "replace") {
        diagnostics.push({ level: "error", message: 'Stack mode must be "append", "prepend", or "replace" when provided.' });
    }
    validateRawDefaults(raw.defaults, diagnostics);
    validateRawContext(raw.context, diagnostics);
    validateRawVariables(raw.variables, diagnostics);
    validateRawParameters(raw, diagnostics);
    if (!Array.isArray(raw.items))
        return diagnostics;
    for (const [index, item] of raw.items.entries()) {
        if (!isPlainObject(item))
            continue;
        const fallbackId = `item-${index + 1}`;
        const itemId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId;
        if (item.kind !== "block" && item.kind !== "slot") {
            diagnostics.push({ level: "error", message: `Item ${index + 1} kind must be "block" or "slot".`, itemId });
        }
        if (typeof item.id !== "string" || !item.id.trim()) {
            diagnostics.push({ level: "error", message: `Item ${index + 1} id must be a non-empty string.`, itemId });
        }
        if (item.name !== undefined && typeof item.name !== "string") {
            diagnostics.push({ level: "error", message: "Item name must be a string when provided.", itemId });
        }
        if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
            diagnostics.push({ level: "error", message: "Item enabled must be a boolean when provided.", itemId });
        }
        if (item.role !== undefined && !VALID_ROLES.has(item.role)) {
            diagnostics.push({ level: "error", message: `Invalid role: ${String(item.role)}`, itemId });
        }
        if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string"))) {
            diagnostics.push({ level: "error", message: "Item tags must be an array of strings when provided.", itemId });
        }
        if (item.source !== undefined && !isPlainObject(item.source)) {
            diagnostics.push({ level: "error", message: "Item source must be an object when provided.", itemId });
        }
        if (item.kind === "block" && typeof item.content !== "string") {
            diagnostics.push({ level: "error", message: "Block content must be a string.", itemId });
        }
        if (item.kind === "slot") {
            if (typeof item.slot !== "string" || !item.slot.trim()) {
                diagnostics.push({ level: "error", message: "Slot name must be a non-empty string.", itemId });
            }
            if (item.options !== undefined && !isPlainObject(item.options)) {
                diagnostics.push({ level: "error", message: "Slot options must be an object when provided.", itemId });
            }
        }
    }
    return diagnostics;
}
function validateRawDefaults(value, diagnostics) {
    if (value === undefined)
        return;
    if (!isPlainObject(value)) {
        diagnostics.push({ level: "error", message: "Stack defaults must be an object when provided." });
        return;
    }
    validateOptionalBoolean(value, "syntheticMessagesVisible", "defaults.syntheticMessagesVisible", diagnostics);
    if (value.unresolvedMacroPolicy !== undefined && !["warn", "keep", "error"].includes(String(value.unresolvedMacroPolicy))) {
        diagnostics.push({ level: "error", message: 'defaults.unresolvedMacroPolicy must be "warn", "keep", or "error" when provided.' });
    }
}
function validateRawContext(value, diagnostics) {
    if (value === undefined)
        return;
    if (!isPlainObject(value)) {
        diagnostics.push({ level: "error", message: "Stack context must be an object when provided." });
        return;
    }
    validateOptionalBoolean(value, "allowDuplicateChatHistory", "context.allowDuplicateChatHistory", diagnostics);
    validateOptionalBoolean(value, "mergeConsecutiveRoles", "context.mergeConsecutiveRoles", diagnostics);
    validateOptionalString(value, "mergeSeparator", "context.mergeSeparator", diagnostics);
}
function validateRawVariables(value, diagnostics) {
    if (value === undefined)
        return;
    if (!isPlainObject(value)) {
        diagnostics.push({ level: "error", message: "Stack variables must be an object when provided." });
        return;
    }
    for (const [name, variable] of Object.entries(value)) {
        if (typeof variable !== "string") {
            diagnostics.push({ level: "error", message: `Stack variable ${name} must be a string.` });
        }
    }
}
function validateRawParameters(raw, diagnostics) {
    const schemaVersion = raw.schemaVersion === 2 ? 2 : 1;
    if (schemaVersion === 2 && raw.variables !== undefined) {
        diagnostics.push({ level: "warning", message: "schemaVersion 2 stacks use parameters; variables is ignored." });
    }
    if (schemaVersion === 1 && raw.parameters !== undefined) {
        diagnostics.push({ level: "warning", message: "schemaVersion 1 stacks use variables; parameters is ignored." });
    }
    if (raw.parameters === undefined)
        return;
    if (!isPlainObject(raw.parameters)) {
        diagnostics.push({ level: "error", message: "Stack parameters must be an object when provided." });
        return;
    }
    for (const [name, value] of Object.entries(raw.parameters)) {
        if (!isPromptVariableValue(value)) {
            diagnostics.push({ level: "error", message: `Stack parameter ${name} must be a JSON-compatible value.` });
        }
    }
}
function validateOptionalString(value, key, label, diagnostics) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
        diagnostics.push({ level: "error", message: `${label} must be a string when provided.` });
    }
}
function validateOptionalBoolean(value, key, label, diagnostics) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
        diagnostics.push({ level: "error", message: `${label} must be a boolean when provided.` });
    }
}
function validateChatHistoryOptions(item, diagnostics) {
    const options = item.options;
    if (!options)
        return;
    for (const key of ["includeLastUserMessage", "stripAssistantThinking", "includeSummaries"]) {
        const value = options[key];
        if (value !== undefined && typeof value !== "boolean") {
            diagnostics.push({ level: "warning", message: `chat-history option ${key} should be a boolean.`, itemId: item.id });
        }
    }
    if (options.roles !== undefined && !isStringArray(options.roles)) {
        diagnostics.push({ level: "error", message: "chat-history option roles must be an array of strings.", itemId: item.id });
    }
    if (options.toolMode !== undefined && (typeof options.toolMode !== "string" || !VALID_CHAT_HISTORY_TOOL_MODES.has(options.toolMode))) {
        diagnostics.push({ level: "error", message: 'chat-history option toolMode must be "keep" or "drop".', itemId: item.id });
    }
    for (const key of ["maxMessages", "maxChars"]) {
        const value = options[key];
        if (value !== undefined && !isPositiveInteger(value)) {
            diagnostics.push({ level: "error", message: `chat-history option ${key} must be a positive integer.`, itemId: item.id });
        }
    }
}
function normalizeId(value, fallback) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return fallback;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeParameterRecord(value, diagnostics) {
    if (!isPlainObject(value))
        return undefined;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
        if (isPromptVariableValue(raw))
            result[key] = raw;
    }
    return result;
}
function isPromptVariableValue(value) {
    if (value === null)
        return true;
    const type = typeof value;
    if (type === "string" || type === "boolean")
        return true;
    if (type === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isPromptVariableValue);
    if (!value || typeof value !== "object")
        return false;
    return Object.values(value).every(isPromptVariableValue);
}
function normalizeStringRecord(value) {
    if (!isPlainObject(value))
        return undefined;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === "string")
            result[key] = raw;
    }
    return result;
}
function normalizeResourcePolicy(value, label, diagnostics) {
    if (value === undefined)
        return undefined;
    if (!isPlainObject(value)) {
        diagnostics.push({ level: "error", message: `${label} policy must be an object when provided.` });
        return undefined;
    }
    const allow = normalizePolicyPatterns(value.allow, `${label}.allow`, diagnostics);
    const deny = normalizePolicyPatterns(value.deny, `${label}.deny`, diagnostics);
    if (allow && deny) {
        diagnostics.push({ level: "error", message: `${label} policy must use either allow or deny, not both.` });
        return { allow };
    }
    if (allow)
        return { allow };
    if (deny)
        return { deny };
    return {};
}
function normalizePolicyPatterns(value, label, diagnostics) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        diagnostics.push({ level: "error", message: `${label} must be an array of strings when provided.` });
        return undefined;
    }
    const patterns = [];
    for (const [index, item] of value.entries()) {
        if (typeof item !== "string" || !item.trim()) {
            diagnostics.push({ level: "error", message: `${label}[${index}] must be a non-empty string.` });
            continue;
        }
        patterns.push(item.trim());
    }
    return patterns.length > 0 ? patterns : undefined;
}
function validateResourcePolicy(policy, label) {
    const diagnostics = [];
    if ((policy?.allow?.length ?? 0) > 0 && (policy?.deny?.length ?? 0) > 0) {
        diagnostics.push({ level: "error", message: `${label} policy must use either allow or deny, not both.` });
    }
    for (const key of ["allow", "deny"]) {
        const values = policy?.[key];
        if (!values)
            continue;
        const seen = new Set();
        for (const value of values) {
            if (seen.has(value)) {
                diagnostics.push({ level: "warning", message: `Duplicate ${label}.${key} pattern: ${value}.` });
            }
            seen.add(value);
        }
    }
    return diagnostics;
}
function normalizeRegexConfig(value, diagnostics) {
    if (value === undefined)
        return undefined;
    if (!isPlainObject(value)) {
        diagnostics.push({ level: "warning", message: "regex must be an object when provided." });
        return undefined;
    }
    return value;
}
//# sourceMappingURL=prompt-stack.js.map