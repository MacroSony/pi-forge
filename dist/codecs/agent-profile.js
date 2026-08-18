import { basename } from "node:path";
import { isValidResourceId, parseResourceSelector, } from "../resource-identity.js";
export const AGENT_PROFILE_TYPE = "pi-forge.agent-profile";
export const AGENT_PROFILE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const VALID_THINKING_LEVELS = new Set(AGENT_PROFILE_THINKING_LEVELS);
const PROFILE_FIELDS = new Set(["schemaVersion", "type", "id", "name", "description", "model", "thinkingLevel", "promptStack", "autoActivate"]);
const MODEL_FIELDS = new Set(["provider", "id"]);
/**
 * Parse, normalize, and validate an agent profile from its serialized source.
 * This is the single entry point for turning profile JSON text into a
 * LoadedAgentProfile; loaders only add file-system concerns on top.
 */
export function parseAgentProfile(source, filePath, scope) {
    const diagnostics = [];
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch (error) {
        return createAgentProfileFault(filePath, scope, `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const profile = normalizeAgentProfile(raw, filePath, diagnostics);
    diagnostics.push(...validateAgentProfile(profile));
    return { filePath, scope, key: { scope, id: profile.id }, profile, diagnostics };
}
/** Build a fail-closed LoadedAgentProfile when the source cannot be read or parsed. */
export function createAgentProfileFault(filePath, scope, message) {
    return {
        filePath,
        scope,
        key: { scope, id: basename(filePath, ".json") },
        profile: fallbackProfile(filePath),
        diagnostics: [{ level: "error", message }],
    };
}
/**
 * Single canonical serializer for agent profiles. Every writer (profile
 * service, command, repository) must go through this function so serialized
 * output stays identical across all write paths.
 */
export function serializeAgentProfile(profile) {
    return `${JSON.stringify(profile, null, 2)}\n`;
}
function normalizeAgentProfile(raw, filePath, diagnostics) {
    if (!isPlainObject(raw)) {
        diagnostics.push({ level: "error", message: "Agent profile root must be a JSON object." });
        return fallbackProfile(filePath);
    }
    for (const field of Object.keys(raw)) {
        if (!PROFILE_FIELDS.has(field))
            diagnostics.push({ level: "error", field, message: `Unsupported profile field: ${field}` });
    }
    if (raw.schemaVersion !== 1)
        diagnostics.push({ level: "error", field: "schemaVersion", message: "schemaVersion must be 1." });
    if (raw.type !== AGENT_PROFILE_TYPE)
        diagnostics.push({ level: "error", field: "type", message: `type must be "${AGENT_PROFILE_TYPE}".` });
    const id = nonEmptyString(raw.id);
    if (!id)
        diagnostics.push({ level: "error", field: "id", message: "Profile id must be a non-empty string." });
    const model = normalizeModelReference(raw.model, diagnostics);
    const thinkingLevel = normalizeThinkingLevel(raw.thinkingLevel, diagnostics);
    const promptStack = normalizePromptStackReference(raw, diagnostics);
    if (raw.name !== undefined && typeof raw.name !== "string")
        diagnostics.push({ level: "error", field: "name", message: "name must be a string when provided." });
    if (raw.description !== undefined && typeof raw.description !== "string") {
        diagnostics.push({ level: "error", field: "description", message: "description must be a string when provided." });
    }
    if (raw.autoActivate !== undefined && typeof raw.autoActivate !== "boolean") {
        diagnostics.push({ level: "error", field: "autoActivate", message: "autoActivate must be a boolean when provided." });
    }
    return {
        schemaVersion: 1,
        type: AGENT_PROFILE_TYPE,
        id: id ?? basename(filePath, ".json"),
        name: typeof raw.name === "string" ? raw.name : undefined,
        description: typeof raw.description === "string" ? raw.description : undefined,
        autoActivate: typeof raw.autoActivate === "boolean" ? raw.autoActivate : undefined,
        model,
        thinkingLevel,
        promptStack,
    };
}
function normalizeModelReference(raw, diagnostics) {
    if (!isPlainObject(raw)) {
        diagnostics.push({ level: "error", field: "model", message: "model must be an object containing provider and id." });
        return { provider: "", id: "" };
    }
    for (const field of Object.keys(raw)) {
        if (!MODEL_FIELDS.has(field))
            diagnostics.push({ level: "error", field: `model.${field}`, message: `Unsupported model field: ${field}` });
    }
    const provider = nonEmptyString(raw.provider);
    const id = nonEmptyString(raw.id);
    return { provider: provider ?? "", id: id ?? "" };
}
function normalizeThinkingLevel(raw, diagnostics) {
    if (typeof raw === "string" && VALID_THINKING_LEVELS.has(raw))
        return raw;
    diagnostics.push({
        level: "error",
        field: "thinkingLevel",
        message: `thinkingLevel must be one of: ${AGENT_PROFILE_THINKING_LEVELS.join(", ")}.`,
    });
    return "off";
}
function normalizePromptStackReference(raw, diagnostics) {
    if (!Object.prototype.hasOwnProperty.call(raw, "promptStack")) {
        diagnostics.push({ level: "error", field: "promptStack", message: "promptStack is required and must be a stack id or null." });
        return null;
    }
    if (raw.promptStack === null)
        return null;
    const id = nonEmptyString(raw.promptStack);
    if (id)
        return id;
    diagnostics.push({ level: "error", field: "promptStack", message: "promptStack must be a non-empty stack id or null." });
    return null;
}
function fallbackProfile(filePath) {
    return {
        schemaVersion: 1,
        type: AGENT_PROFILE_TYPE,
        id: basename(filePath, ".json"),
        model: { provider: "", id: "" },
        thinkingLevel: "off",
        promptStack: null,
    };
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validateAgentProfile(profile) {
    const diagnostics = [];
    if (profile.schemaVersion !== 1)
        diagnostics.push({ level: "error", field: "schemaVersion", message: "schemaVersion must be 1." });
    if (profile.type !== AGENT_PROFILE_TYPE)
        diagnostics.push({ level: "error", field: "type", message: `type must be "${AGENT_PROFILE_TYPE}".` });
    if (!isValidResourceId(profile.id)) {
        diagnostics.push({
            level: "error",
            field: "id",
            message: "Profile id must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.",
        });
    }
    if (!profile.model.provider.trim())
        diagnostics.push({ level: "error", field: "model.provider", message: "model.provider must not be empty." });
    if (!profile.model.id.trim())
        diagnostics.push({ level: "error", field: "model.id", message: "model.id must not be empty." });
    if (!VALID_THINKING_LEVELS.has(profile.thinkingLevel)) {
        diagnostics.push({ level: "error", field: "thinkingLevel", message: `Unsupported thinkingLevel: ${String(profile.thinkingLevel)}` });
    }
    if (profile.promptStack !== null && !profile.promptStack.trim()) {
        diagnostics.push({ level: "error", field: "promptStack", message: "promptStack must be a non-empty stack id or null." });
    }
    return diagnostics;
}
export function validateAgentProfilePromptStackScope(profile, scope) {
    if (profile.promptStack === null)
        return [];
    const parsed = parseResourceSelector(profile.promptStack);
    if (!parsed.ok) {
        return [{ level: "error", field: "promptStack", message: parsed.error }];
    }
    if (scope === "global" && parsed.selector.scope === "project") {
        return [{
                level: "error",
                field: "promptStack",
                message: `Global profile ${profile.id} cannot reference project prompt stack ${parsed.selector.id}.`,
            }];
    }
    return [];
}
//# sourceMappingURL=agent-profile.js.map