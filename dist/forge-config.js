import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalForgeDir } from "./storage.js";
/** Backend used when neither a per-run override nor a configured default applies. */
export const DEFAULT_SUBAGENT_BACKEND_ID = "pi-subprocess-readonly";
/**
 * Development/test override for the global config location. Keeps automated
 * tests hermetic regardless of the developer's real ~/.pi/forge/config.json.
 * Not part of the supported user-facing configuration surface.
 */
export const GLOBAL_FORGE_CONFIG_PATH_ENV = "PI_FORGE_GLOBAL_CONFIG_PATH";
/**
 * Resolve the effective backend for one run: explicit per-run override, then a
 * trusted project config default, then the user-owned global config default,
 * then the built-in subprocess backend. There is deliberately no fallback to
 * another backend when the resolved one is missing or rejects the intent.
 */
export function resolveSubagentBackend(settings, explicitBackend) {
    if (explicitBackend)
        return { id: explicitBackend, source: "explicit" };
    if (settings.backend)
        return { id: settings.backend, source: settings.backendSource ?? "global" };
    return { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" };
}
export function loadForgeSubagentSettings(ctx) {
    const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
    const globalConfigPath = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] ?? join(globalForgeDir(), "config.json");
    const settings = {
        allowAgentInvocationWithoutApproval: false,
        configPath,
        globalConfigPath,
        warnings: [],
    };
    // The global config is user-owned and always applies. The project config is
    // honored only for trusted projects and overrides global values.
    applyBackend(readSubagentsSection(globalConfigPath, settings.warnings), globalConfigPath, "global", settings);
    if (!ctx.isProjectTrusted())
        return settings;
    const projectSection = readSubagentsSection(configPath, settings.warnings);
    applyBackend(projectSection, configPath, "project", settings);
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
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=forge-config.js.map