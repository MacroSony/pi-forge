import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentProfileId } from "./agent-profile.js";
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
 * a trusted-project per-profile override, then trusted-project/global defaults,
 * then the built-in subprocess backend. There is deliberately no fallback when
 * the resolved backend is missing or rejects the intent.
 */
export function resolveSubagentBackend(settings, explicitBackend, profileId) {
    if (explicitBackend)
        return { id: explicitBackend, source: "explicit" };
    const profile = profileId ? configuredProfile(settings, profileId) : undefined;
    if (profile?.backend)
        return { id: profile.backend, source: profile.backendSource ?? "project-profile" };
    if (settings.backend)
        return { id: settings.backend, source: settings.backendSource ?? "global" };
    return { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" };
}
export function resolveSubagentTimeout(settings, profileId) {
    const profile = profileId ? configuredProfile(settings, profileId) : undefined;
    if (profile?.timeoutMs !== undefined) {
        return { milliseconds: profile.timeoutMs, source: profile.timeoutSource ?? "project-profile" };
    }
    return { milliseconds: settings.timeoutMs, source: settings.timeoutSource };
}
export function resolveSubagentProfilePolicy(settings, profileId, explicitBackend) {
    const profile = configuredProfile(settings, profileId);
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
        profiles: Object.create(null),
        configPath,
        globalConfigPath,
        warnings: [],
    };
    // The global config is user-owned and always applies. The project config is
    // honored only for trusted projects and overrides global values.
    const globalSection = readSubagentsSection(globalConfigPath, settings.warnings);
    applyBackend(globalSection, globalConfigPath, "global", settings);
    applyTimeout(globalSection, globalConfigPath, "global", settings);
    warnIgnoredGlobalProfiles(globalSection, globalConfigPath, settings);
    if (!ctx.isProjectTrusted())
        return settings;
    const projectSection = readSubagentsSection(configPath, settings.warnings);
    applyBackend(projectSection, configPath, "project", settings);
    applyTimeout(projectSection, configPath, "project", settings);
    applyProjectProfiles(projectSection, configPath, settings);
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
function warnIgnoredGlobalProfiles(section, configPath, settings) {
    if (!section || section.profiles === undefined)
        return;
    settings.warnings.push(`pi-forge: ${configPath} subagents.profiles is project-only and ignored; configure profile delegation in the trusted project's .pi/forge/config.json.`);
}
function applyProjectProfiles(section, configPath, settings) {
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
        const target = configuredProfile(settings, profileId) ?? {};
        const profileSource = "project-profile";
        if (rawProfile.enabled !== undefined) {
            if (typeof rawProfile.enabled !== "boolean") {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.enabled must be boolean; the configured value is ignored.`);
            }
            else {
                target.enabled = rawProfile.enabled;
                target.enabledSource = profileSource;
            }
        }
        if (rawProfile.backend !== undefined) {
            if (typeof rawProfile.backend !== "string" || !rawProfile.backend.trim()) {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.backend must be a non-empty string; the configured value is ignored.`);
            }
            else {
                target.backend = rawProfile.backend;
                target.backendSource = profileSource;
            }
        }
        if (rawProfile.timeoutMs !== undefined) {
            if (!isValidSubagentTimeoutMs(rawProfile.timeoutMs)) {
                settings.warnings.push(`pi-forge: ${configPath} ${path}.timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; the configured value is ignored.`);
            }
            else {
                target.timeoutMs = rawProfile.timeoutMs;
                target.timeoutSource = profileSource;
            }
        }
        if (Object.keys(target).length > 0)
            settings.profiles[profileId] = target;
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
function configuredProfile(settings, profileId) {
    return Object.hasOwn(settings.profiles, profileId) ? settings.profiles[profileId] : undefined;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=forge-config.js.map