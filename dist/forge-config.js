import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function loadForgeSubagentSettings(ctx) {
    const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
    const defaults = { allowAgentInvocationWithoutApproval: false, configPath, warnings: [] };
    if (!ctx.isProjectTrusted() || !existsSync(configPath))
        return defaults;
    let raw;
    try {
        raw = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch (error) {
        return {
            ...defaults,
            warnings: [`pi-forge: failed to read ${configPath}; per-run subagent approval remains required. ${error instanceof Error ? error.message : String(error)}`],
        };
    }
    if (!isPlainObject(raw)) {
        return { ...defaults, warnings: [`pi-forge: ${configPath} must be a JSON object; per-run subagent approval remains required.`] };
    }
    if (raw.subagents === undefined)
        return defaults;
    if (!isPlainObject(raw.subagents)) {
        return { ...defaults, warnings: [`pi-forge: ${configPath} subagents must be a JSON object; per-run subagent approval remains required.`] };
    }
    const value = raw.subagents.allowAgentInvocationWithoutApproval;
    if (value === undefined)
        return defaults;
    if (typeof value !== "boolean") {
        return {
            ...defaults,
            warnings: [`pi-forge: ${configPath} subagents.allowAgentInvocationWithoutApproval must be boolean; per-run subagent approval remains required.`],
        };
    }
    return { ...defaults, allowAgentInvocationWithoutApproval: value };
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=forge-config.js.map