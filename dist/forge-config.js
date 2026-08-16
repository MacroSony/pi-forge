import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidAgentProfileId } from "./agent-profile.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { globalForgeDir } from "./storage.js";
/** Backend used when neither a per-run override nor a configured default applies. */
export const DEFAULT_SUBAGENT_BACKEND_ID = "pi-subprocess-readonly";
/** Preserve the original foreground-run timeout unless the user configures one. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 60_000;
export const MIN_SUBAGENT_TIMEOUT_MS = 1_000;
export const MAX_SUBAGENT_TIMEOUT_MS = 3_600_000;
/**
 * Development/test override for the global config location. Keeps automated
 * tests hermetic regardless of the developer's real ~/.pi/forge/config.json.
 * Not part of the supported user-facing configuration surface.
 */
export const GLOBAL_FORGE_CONFIG_PATH_ENV = "PI_FORGE_GLOBAL_CONFIG_PATH";
/**
 * Resolve the effective backend for one run: explicit per-run override, then
 * a matching-scope per-profile override, then trusted-project/global defaults,
 * then the built-in subprocess backend. There is deliberately no fallback when
 * the resolved backend is missing or rejects the intent.
 */
export function resolveSubagentBackend(settings, explicitBackend, profileId) {
    if (explicitBackend)
        return { id: explicitBackend, source: "explicit" };
    const profile = profileId ? configuredProfileForSelector(settings, profileId) : undefined;
    if (profile?.backend)
        return { id: profile.backend, source: profile.backendSource ?? "project-profile" };
    if (settings.backend)
        return { id: settings.backend, source: settings.backendSource ?? "global" };
    return { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" };
}
export function resolveSubagentTimeout(settings, profileId) {
    const profile = profileId ? configuredProfileForSelector(settings, profileId) : undefined;
    if (profile?.timeoutMs !== undefined) {
        return { milliseconds: profile.timeoutMs, source: profile.timeoutSource ?? "project-profile" };
    }
    return { milliseconds: settings.timeoutMs, source: settings.timeoutSource };
}
export function resolveSubagentProfilePolicy(settings, profileId, explicitBackend) {
    const profile = configuredProfileForSelector(settings, profileId);
    return {
        profileId,
        enabled: profile?.enabled === true,
        enabledSource: profile?.enabledSource ?? "built-in",
        backend: resolveSubagentBackend(settings, explicitBackend, profileId),
        timeout: resolveSubagentTimeout(settings, profileId),
    };
}
export function loadForgeSubagentSettings(ctx) {
    const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
    const globalConfigPath = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] ?? join(globalForgeDir(), "config.json");
    const settings = {
        allowAgentInvocationWithoutApproval: false,
        timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
        timeoutSource: "built-in",
        summaryInToolDescription: false,
        profiles: Object.create(null),
        configPath,
        globalConfigPath,
        warnings: [],
    };
    // The global config is user-owned and always applies. Its `profiles` map
    // authorizes `global:<id>` profiles only. The project config is honored
    // only for trusted projects; its `profiles` map authorizes `project:<id>`
    // profiles only. Same-ID profiles never inherit policy from each other.
    const globalSection = readSubagentsSection(globalConfigPath, settings.warnings);
    applyBackend(globalSection, globalConfigPath, "global", settings);
    applyTimeout(globalSection, globalConfigPath, "global", settings);
    applyEmbedProfileSummary(globalSection, globalConfigPath, "global", settings);
    applyProfiles(globalSection, globalConfigPath, "global-profile", "global", settings);
    if (!ctx.isProjectTrusted())
        return settings;
    const projectSection = readSubagentsSection(configPath, settings.warnings);
    applyBackend(projectSection, configPath, "project", settings);
    applyTimeout(projectSection, configPath, "project", settings);
    applyEmbedProfileSummary(projectSection, configPath, "project", settings);
    applyProfiles(projectSection, configPath, "project-profile", "project", settings);
    applyUnattended(projectSection, configPath, settings);
    return settings;
}
function readSubagentsSection(configPath, warnings) {
    if (!existsSync(configPath))
        return undefined;
    let raw;
    try {
        raw = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch (error) {
        warnings.push(`pi-forge: failed to read ${configPath}; its subagent settings are ignored. ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    if (!isPlainObject(raw)) {
        warnings.push(`pi-forge: ${configPath} must be a JSON object; its subagent settings are ignored.`);
        return undefined;
    }
    if (raw.subagents === undefined)
        return undefined;
    if (!isPlainObject(raw.subagents)) {
        warnings.push(`pi-forge: ${configPath} subagents must be a JSON object; its subagent settings are ignored.`);
        return undefined;
    }
    return raw.subagents;
}
function applyBackend(section, configPath, source, settings) {
    if (!section || section.backend === undefined)
        return;
    const value = section.backend;
    if (typeof value !== "string" || !value.trim()) {
        settings.warnings.push(`pi-forge: ${configPath} subagents.backend must be a non-empty string; the configured value is ignored.`);
        return;
    }
    settings.backend = value;
    settings.backendSource = source;
}
function applyTimeout(section, configPath, source, settings) {
    if (!section || section.timeoutMs === undefined)
        return;
    const value = section.timeoutMs;
    if (!isValidSubagentTimeoutMs(value)) {
        settings.warnings.push(`pi-forge: ${configPath} subagents.timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; the configured value is ignored.`);
        return;
    }
    settings.timeoutMs = value;
    settings.timeoutSource = source;
}
function applyEmbedProfileSummary(section, configPath, source, settings) {
    if (!section || section.summaryInToolDescription === undefined)
        return;
    const value = section.summaryInToolDescription;
    if (typeof value !== "boolean") {
        settings.warnings.push(`pi-forge: ${configPath} subagents.summaryInToolDescription must be boolean; the configured value is ignored.`);
        return;
    }
    settings.summaryInToolDescription = value;
    settings.summaryInToolDescriptionSource = source;
}
function applyProfiles(section, configPath, source, scope, settings) {
    if (!section || section.profiles === undefined)
        return;
    if (!isPlainObject(section.profiles)) {
        settings.warnings.push(`pi-forge: ${configPath} subagents.profiles must be a JSON object; its per-profile settings are ignored.`);
        return;
    }
    for (const [profileId, rawProfile] of Object.entries(section.profiles)) {
        const path = `subagents.profiles.${profileId}`;
        if (!isValidAgentProfileId(profileId)) {
            settings.warnings.push(`pi-forge: ${configPath} ${path} has an invalid profile id; the entry is ignored.`);
            continue;
        }
        if (!isPlainObject(rawProfile)) {
            settings.warnings.push(`pi-forge: ${configPath} ${path} must be a JSON object; the entry is ignored.`);
            continue;
        }
        for (const field of Object.keys(rawProfile)) {
            if (field === "enabled" || field === "backend" || field === "timeoutMs")
                continue;
            settings.warnings.push(`pi-forge: ${configPath} ${path}.${field} is unsupported and ignored.`);
        }
        const key = formatResourceKey({ scope, id: profileId });
        const target = configuredProfile(settings, key) ?? {};
        if (rawProfile.enabled !== undefined) {
            if (typeof rawProfile.enabled !== "boolean") {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.enabled must be boolean; the configured value is ignored.`);
            }
            else {
                target.enabled = rawProfile.enabled;
                target.enabledSource = source;
            }
        }
        if (rawProfile.backend !== undefined) {
            if (typeof rawProfile.backend !== "string" || !rawProfile.backend.trim()) {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.backend must be a non-empty string; the configured value is ignored.`);
            }
            else {
                target.backend = rawProfile.backend;
                target.backendSource = source;
            }
        }
        if (rawProfile.timeoutMs !== undefined) {
            if (!isValidSubagentTimeoutMs(rawProfile.timeoutMs)) {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; the configured value is ignored.`);
            }
            else {
                target.timeoutMs = rawProfile.timeoutMs;
                target.timeoutSource = source;
            }
        }
        if (Object.keys(target).length > 0)
            settings.profiles[key] = target;
    }
}
function applyUnattended(section, configPath, settings) {
    if (!section || section.allowAgentInvocationWithoutApproval === undefined)
        return;
    const value = section.allowAgentInvocationWithoutApproval;
    if (typeof value !== "boolean") {
        settings.warnings.push(`pi-forge: ${configPath} subagents.allowAgentInvocationWithoutApproval must be boolean; per-run subagent approval remains required.`);
        return;
    }
    settings.allowAgentInvocationWithoutApproval = value;
}
export function isValidSubagentTimeoutMs(value) {
    return Number.isSafeInteger(value)
        && value >= MIN_SUBAGENT_TIMEOUT_MS
        && value <= MAX_SUBAGENT_TIMEOUT_MS;
}
export function globalForgeConfigPath() {
    return process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] ?? join(globalForgeDir(), "config.json");
}
export function projectForgeConfigPath(cwd) {
    return join(cwd, ".pi", "forge", "config.json");
}
/**
 * Update `subagents.profiles.<id>` in the selected scope's config file,
 * preserving unknown top-level, `subagents`, and per-entry fields. Project
 * config updates must be gated on project trust by the caller; global config
 * is user-owned and always writable.
 */
export function updateForgeSubagentProfileConfig(cwd, profileId, update, options = {}) {
    const scope = options.scope ?? "project";
    if (!isValidAgentProfileId(profileId)) {
        return { ok: false, error: `Invalid agent profile id: ${profileId}` };
    }
    if (update.backend !== undefined && update.backend !== null && (typeof update.backend !== "string" || !update.backend.trim())) {
        return { ok: false, error: "subagent backend must be a non-empty string or null to clear the override." };
    }
    if (update.timeoutMs !== undefined && update.timeoutMs !== null && !isValidSubagentTimeoutMs(update.timeoutMs)) {
        return {
            ok: false,
            error: `subagent timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} or null to clear the override.`,
        };
    }
    const configPath = scope === "project" ? projectForgeConfigPath(cwd) : globalForgeConfigPath();
    let root = {};
    if (existsSync(configPath)) {
        let raw;
        try {
            raw = JSON.parse(readFileSync(configPath, "utf8"));
        }
        catch (error) {
            return {
                ok: false,
                error: `Refusing to update unreadable ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (!isPlainObject(raw)) {
            return { ok: false, error: `Refusing to update ${configPath}: the config root must be a JSON object.` };
        }
        root = raw;
    }
    if (root.subagents !== undefined && !isPlainObject(root.subagents)) {
        return { ok: false, error: `Refusing to update ${configPath}: subagents must be a JSON object.` };
    }
    const subagents = isPlainObject(root.subagents) ? root.subagents : {};
    if (subagents.profiles !== undefined && !isPlainObject(subagents.profiles)) {
        return { ok: false, error: `Refusing to update ${configPath}: subagents.profiles must be a JSON object.` };
    }
    const profiles = isPlainObject(subagents.profiles) ? subagents.profiles : {};
    if (profiles[profileId] !== undefined && !isPlainObject(profiles[profileId])) {
        return { ok: false, error: `Refusing to update ${configPath}: subagents.profiles.${profileId} must be a JSON object.` };
    }
    const entry = isPlainObject(profiles[profileId]) ? { ...profiles[profileId] } : {};
    if (update.enabled !== undefined) {
        if (update.enabled)
            entry.enabled = true;
        else
            delete entry.enabled;
    }
    if (update.backend !== undefined) {
        if (typeof update.backend === "string" && update.backend.trim())
            entry.backend = update.backend.trim();
        else
            delete entry.backend;
    }
    if (update.timeoutMs !== undefined) {
        if (update.timeoutMs === null)
            delete entry.timeoutMs;
        else
            entry.timeoutMs = update.timeoutMs;
    }
    if (Object.keys(entry).length > 0)
        profiles[profileId] = entry;
    else
        delete profiles[profileId];
    if (Object.keys(profiles).length > 0)
        subagents.profiles = profiles;
    else
        delete subagents.profiles;
    if (Object.keys(subagents).length > 0)
        root.subagents = subagents;
    else
        delete root.subagents;
    try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
        return { ok: true, configPath };
    }
    catch (error) {
        return { ok: false, error: `Failed to write ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
}
/**
 * Resolve the configured per-profile settings for a profile selector. Bare
 * selectors use project-first effective lookup; qualified selectors address
 * the exact scope. Returns undefined for unknown or malformed selectors.
 */
export function configuredProfileForSelector(settings, profileId) {
    const parsed = parseResourceSelector(profileId);
    if (!parsed.ok)
        return undefined;
    if (parsed.selector.scope) {
        return configuredProfile(settings, formatResourceKey({ scope: parsed.selector.scope, id: parsed.selector.id }));
    }
    // A bare selector is intentionally project-only here. Callers that resolve
    // a bare ID to a loaded global profile must pass the exact `global:<id>`
    // selector; never infer global delegation authority from a bare ID.
    return configuredProfile(settings, formatResourceKey({ scope: "project", id: parsed.selector.id }));
}
function configuredProfile(settings, key) {
    return Object.hasOwn(settings.profiles, key) ? settings.profiles[key] : undefined;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=forge-config.js.map