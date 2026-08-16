import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { resourcePatternMatches } from "./policy.js";
import { formatResourceKey, isResourceScope, isValidResourceId, parseResourceSelector } from "./resource-identity.js";
import { agentProfilesDir, globalAgentProfilesDir } from "./storage.js";
export const AGENT_PROFILE_TYPE = "pi-forge.agent-profile";
export const AGENT_PROFILE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const VALID_THINKING_LEVELS = new Set(AGENT_PROFILE_THINKING_LEVELS);
const PROFILE_FIELDS = new Set(["schemaVersion", "type", "id", "name", "description", "model", "thinkingLevel", "promptStack", "autoActivate"]);
const MODEL_FIELDS = new Set(["provider", "id"]);
export { agentProfilePath, agentProfilesDir } from "./storage.js";
export function isValidAgentProfileId(id) {
    return isValidResourceId(id);
}
export function loadAgentProfiles(cwd) {
    const profiles = loadAgentProfilesFromDir(agentProfilesDir(cwd), "project");
    annotateDuplicateProfileIds(profiles);
    annotateAutoActivateConflicts(profiles);
    return profiles;
}
/**
 * Load both global and project profiles. Global definitions are user-owned
 * and always load; project definitions load from the trusted project dirs.
 * The caller decides whether project trust applies before calling.
 */
export function loadAgentProfilesScoped(cwd, globalDir = globalAgentProfilesDir()) {
    const profiles = [
        ...loadAgentProfilesFromDir(globalDir, "global"),
        ...loadAgentProfilesFromDir(agentProfilesDir(cwd), "project"),
    ];
    annotateDuplicateProfileIds(profiles);
    annotateAutoActivateConflicts(profiles);
    return profiles;
}
/** Load only the user-owned global profiles, used by untrusted projects. */
export function loadGlobalAgentProfiles(globalDir = globalAgentProfilesDir()) {
    const profiles = loadAgentProfilesFromDir(globalDir, "global");
    annotateDuplicateProfileIds(profiles);
    annotateAutoActivateConflicts(profiles);
    return profiles;
}
function loadAgentProfilesFromDir(dir, scope) {
    if (!existsSync(dir))
        return [];
    let entries;
    try {
        entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    }
    catch {
        return [];
    }
    return entries.map((name) => loadAgentProfileFile(join(dir, name), scope));
}
export function chooseAutoActivateAgentProfile(profiles) {
    // Project auto-activation has explicit precedence. An invalid or ambiguous
    // project candidate fails closed instead of falling back to a global one.
    const projectCandidates = profiles.filter((loaded) => loaded.scope === "project" && loaded.profile.autoActivate === true);
    if (projectCandidates.length > 0) {
        return projectCandidates.length === 1 && !hasAgentProfileErrors(projectCandidates[0].diagnostics)
            ? projectCandidates[0]
            : undefined;
    }
    const globalCandidates = profiles.filter((loaded) => loaded.scope === "global" && loaded.profile.autoActivate === true);
    return globalCandidates.length === 1 && !hasAgentProfileErrors(globalCandidates[0].diagnostics)
        ? globalCandidates[0]
        : undefined;
}
export function hasAutoActivateAgentProfile(profiles) {
    return profiles.some((loaded) => loaded.profile.autoActivate === true);
}
export function loadAgentProfileFile(filePath, scope = "project") {
    const diagnostics = [];
    let raw;
    try {
        raw = JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch (error) {
        return {
            filePath,
            scope,
            key: { scope, id: basename(filePath, ".json") },
            profile: fallbackProfile(filePath),
            diagnostics: [{
                    level: "error",
                    message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                }],
        };
    }
    const profile = normalizeAgentProfile(raw, filePath, diagnostics);
    diagnostics.push(...validateAgentProfile(profile));
    return { filePath, scope, key: { scope, id: profile.id }, profile, diagnostics };
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
/**
 * Validate the profile's stored `promptStack` selector against the profile's
 * own scope. Bare references stay scope-relative; only global profiles are
 * prohibited from referencing project stacks explicitly. Used by write paths
 * so edited JSON cannot persist a scope-unsafe dependency.
 */
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
        const resolution = resolveProfilePromptStack(loaded, resources.promptStacks);
        diagnostics.push(...resolution.diagnostics);
        promptStack = resolution.stack;
        if (promptStack) {
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
        && (value.scope === undefined || isResourceScope(value.scope))
        && typeof value.sourcePath === "string"
        && typeof value.sourceFingerprint === "string"
        && typeof value.appliedAt === "string"
        && !!nonEmptyString(value.snapshot.model.provider)
        && !!nonEmptyString(value.snapshot.model.id)
        && typeof value.snapshot.thinkingLevel === "string"
        && VALID_THINKING_LEVELS.has(value.snapshot.thinkingLevel)
        && (value.snapshot.promptStack === null || !!nonEmptyString(value.snapshot.promptStack));
}
/**
 * Resolve a profile's stored `promptStack` reference relative to the profile's
 * own scope. Bare IDs resolve to the profile scope; explicit qualification
 * overrides that scope. A global profile can never reference a project stack.
 */
function resolveProfilePromptStack(loaded, promptStacks) {
    const diagnostics = [];
    const reference = loaded.profile.promptStack;
    const parsed = parseResourceSelector(reference);
    if (!parsed.ok) {
        diagnostics.push({ level: "error", field: "promptStack", message: parsed.error });
        return { stack: undefined, diagnostics };
    }
    if (loaded.scope === "global" && parsed.selector.scope === "project") {
        diagnostics.push({
            level: "error",
            field: "promptStack",
            message: `Global profile ${loaded.profile.id} cannot reference project prompt stack ${parsed.selector.id}.`,
        });
        return { stack: undefined, diagnostics };
    }
    const scope = parsed.selector.scope ?? loaded.scope;
    const matches = promptStacks.filter((candidate) => candidate.scope === scope && candidate.stack.id === parsed.selector.id);
    if (matches.length === 1)
        return { stack: matches[0], diagnostics };
    if (matches.length === 0) {
        const suggestion = loaded.scope === "project" && scope === "project"
            && promptStacks.some((candidate) => candidate.scope === "global" && candidate.stack.id === parsed.selector.id)
            ? ` Use ${formatResourceKey({ scope: "global", id: parsed.selector.id })} to reference the global stack.`
            : "";
        diagnostics.push({
            level: "error",
            field: "promptStack",
            message: `Unknown prompt stack: ${reference}.${suggestion}`,
        });
        return { stack: undefined, diagnostics };
    }
    diagnostics.push({
        level: "error",
        field: "promptStack",
        message: `Prompt stack id is ambiguous: ${reference}`,
    });
    return { stack: undefined, diagnostics };
}
function findModel(models, reference) {
    return models.find((model) => model.provider === reference.provider && model.id === reference.id);
}
function annotateDuplicateProfileIds(profiles) {
    const byScopeId = new Map();
    for (const loaded of profiles) {
        const key = `${loaded.scope}\0${loaded.profile.id}`;
        const matches = byScopeId.get(key) ?? [];
        matches.push(loaded);
        byScopeId.set(key, matches);
    }
    for (const matches of byScopeId.values()) {
        if (matches.length <= 1)
            continue;
        const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
        for (const loaded of matches) {
            loaded.diagnostics.push({
                level: "error",
                message: `Duplicate ${loaded.scope} profile id: ${loaded.profile.id} appears in multiple files (${files}).`,
            });
        }
    }
}
function annotateAutoActivateConflicts(profiles) {
    const byScope = new Map();
    for (const loaded of profiles) {
        if (loaded.profile.autoActivate !== true)
            continue;
        const matches = byScope.get(loaded.scope) ?? [];
        matches.push(loaded);
        byScope.set(loaded.scope, matches);
    }
    for (const [scope, candidates] of byScope) {
        if (candidates.length <= 1)
            continue;
        const files = candidates.map((loaded) => basename(loaded.filePath)).join(", ");
        for (const loaded of candidates) {
            loaded.diagnostics.push({
                level: "error",
                field: "autoActivate",
                message: `Multiple ${scope} profiles request auto-activation (${files}); exactly one is allowed.`,
            });
        }
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