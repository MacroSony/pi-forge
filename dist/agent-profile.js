import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { resourcePatternMatches } from "./policy.js";
import { agentProfilesDir } from "./storage.js";
export const AGENT_PROFILE_TYPE = "pi-forge.agent-profile";
export const AGENT_PROFILE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const VALID_THINKING_LEVELS = new Set(AGENT_PROFILE_THINKING_LEVELS);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILE_FIELDS = new Set(["schemaVersion", "type", "id", "name", "description", "model", "thinkingLevel", "promptStack", "autoActivate"]);
const MODEL_FIELDS = new Set(["provider", "id"]);
export { agentProfilePath, agentProfilesDir } from "./storage.js";
export function isValidAgentProfileId(id) {
    return PROFILE_ID_PATTERN.test(id);
}
export function loadAgentProfiles(cwd) {
    const dir = agentProfilesDir(cwd);
    if (!existsSync(dir))
        return [];
    let entries;
    try {
        entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    }
    catch {
        return [];
    }
    const profiles = entries.map((name) => loadAgentProfileFile(join(dir, name)));
    annotateDuplicateProfileIds(profiles);
    annotateAutoActivateConflicts(profiles);
    return profiles;
}
export function chooseAutoActivateAgentProfile(profiles) {
    const candidates = profiles.filter((loaded) => loaded.profile.autoActivate === true);
    return candidates.length === 1 ? candidates[0] : undefined;
}
export function hasAutoActivateAgentProfile(profiles) {
    return profiles.some((loaded) => loaded.profile.autoActivate === true);
}
export function loadAgentProfileFile(filePath) {
    const diagnostics = [];
    let raw;
    try {
        raw = JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch (error) {
        return {
            filePath,
            profile: fallbackProfile(filePath),
            diagnostics: [{
                    level: "error",
                    message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                }],
        };
    }
    const profile = normalizeAgentProfile(raw, filePath, diagnostics);
    diagnostics.push(...validateAgentProfile(profile));
    return { filePath, profile, diagnostics };
}
export function validateAgentProfile(profile) {
    const diagnostics = [];
    if (profile.schemaVersion !== 1)
        diagnostics.push({ level: "error", field: "schemaVersion", message: "schemaVersion must be 1." });
    if (profile.type !== AGENT_PROFILE_TYPE)
        diagnostics.push({ level: "error", field: "type", message: `type must be "${AGENT_PROFILE_TYPE}".` });
    if (!isValidAgentProfileId(profile.id)) {
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
export function resolveAgentProfile(loaded, resources) {
    const diagnostics = [...loaded.diagnostics];
    const reference = loaded.profile.model;
    const model = findModel(resources.models, reference);
    let effectiveThinkingLevel = loaded.profile.thinkingLevel;
    if (!model) {
        diagnostics.push({
            level: "error",
            field: "model",
            message: `Unknown model: ${reference.provider}/${reference.id}`,
        });
    }
    else {
        if (resources.availableModels && !findModel(resources.availableModels, reference)) {
            diagnostics.push({
                level: "error",
                field: "model",
                message: `Model ${reference.provider}/${reference.id} has no configured authentication.`,
            });
        }
        effectiveThinkingLevel = clampThinkingLevel(model, loaded.profile.thinkingLevel);
        if (effectiveThinkingLevel !== loaded.profile.thinkingLevel) {
            diagnostics.push({
                level: "error",
                field: "thinkingLevel",
                message: `Model ${reference.provider}/${reference.id} does not support thinking level ${loaded.profile.thinkingLevel}; Pi would clamp it to ${effectiveThinkingLevel}.`,
            });
        }
    }
    let promptStack;
    if (loaded.profile.promptStack !== null) {
        promptStack = resources.promptStacks.find((candidate) => candidate.stack.id === loaded.profile.promptStack);
        if (!promptStack) {
            diagnostics.push({
                level: "error",
                field: "promptStack",
                message: `Unknown prompt stack: ${loaded.profile.promptStack}`,
            });
        }
        else {
            for (const diagnostic of promptStack.diagnostics) {
                diagnostics.push({
                    level: diagnostic.level,
                    field: "promptStack",
                    message: `Prompt stack ${promptStack.stack.id}: ${diagnostic.message}`,
                });
            }
            const allowedPatterns = promptStack.stack.tools?.allow?.filter((pattern) => pattern !== "*") ?? [];
            if (resources.toolNames && !promptStack.stack.tools?.allow?.includes("*")) {
                for (const pattern of allowedPatterns) {
                    if (resources.toolNames.some((name) => resourcePatternMatches(name, pattern)))
                        continue;
                    diagnostics.push({
                        level: "warning",
                        field: "promptStack",
                        message: `Prompt stack ${promptStack.stack.id} allows tool pattern "${pattern}", but it matches no registered tools.`,
                    });
                }
            }
        }
    }
    return { loaded, model, promptStack, effectiveThinkingLevel, diagnostics };
}
export function isUsableAgentProfile(loaded) {
    return !hasAgentProfileErrors(loaded.diagnostics);
}
export function isResolvedAgentProfileUsable(resolved) {
    return !hasAgentProfileErrors(resolved.diagnostics) && !!resolved.model;
}
export function hasAgentProfileErrors(diagnostics) {
    return diagnostics.some((diagnostic) => diagnostic.level === "error");
}
export function renderAgentProfileDiagnostics(diagnostics) {
    if (diagnostics.length === 0)
        return "No diagnostics.";
    return diagnostics
        .map((diagnostic) => `${diagnostic.level.toUpperCase()}: ${diagnostic.field ? `${diagnostic.field}: ` : ""}${diagnostic.message}`)
        .join("\n");
}
export function agentProfileFingerprint(profile) {
    return JSON.stringify(profile);
}
export function isAgentProfileProvenance(value) {
    if (!isPlainObject(value) || !isPlainObject(value.snapshot) || !isPlainObject(value.snapshot.model))
        return false;
    return typeof value.profileId === "string"
        && isValidAgentProfileId(value.profileId)
        && typeof value.sourcePath === "string"
        && typeof value.sourceFingerprint === "string"
        && typeof value.appliedAt === "string"
        && !!nonEmptyString(value.snapshot.model.provider)
        && !!nonEmptyString(value.snapshot.model.id)
        && typeof value.snapshot.thinkingLevel === "string"
        && VALID_THINKING_LEVELS.has(value.snapshot.thinkingLevel)
        && (value.snapshot.promptStack === null || !!nonEmptyString(value.snapshot.promptStack));
}
function findModel(models, reference) {
    return models.find((model) => model.provider === reference.provider && model.id === reference.id);
}
function annotateDuplicateProfileIds(profiles) {
    const byId = new Map();
    for (const loaded of profiles) {
        const matches = byId.get(loaded.profile.id) ?? [];
        matches.push(loaded);
        byId.set(loaded.profile.id, matches);
    }
    for (const [id, matches] of byId) {
        if (matches.length <= 1)
            continue;
        const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
        for (const loaded of matches) {
            loaded.diagnostics.push({ level: "error", message: `Duplicate profile id: ${id} appears in multiple files (${files}).` });
        }
    }
}
function annotateAutoActivateConflicts(profiles) {
    const candidates = profiles.filter((loaded) => loaded.profile.autoActivate === true);
    if (candidates.length <= 1)
        return;
    const files = candidates.map((loaded) => basename(loaded.filePath)).join(", ");
    for (const loaded of candidates) {
        loaded.diagnostics.push({
            level: "error",
            field: "autoActivate",
            message: `Multiple profiles request auto-activation (${files}); exactly one is allowed.`,
        });
    }
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
//# sourceMappingURL=agent-profile.js.map