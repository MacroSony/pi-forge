import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
/** Backend used when neither a per-run override nor a configured default applies. */
export declare const DEFAULT_SUBAGENT_BACKEND_ID = "pi-subprocess-readonly";
/** Preserve the original foreground-run timeout unless the user configures one. */
export declare const DEFAULT_SUBAGENT_TIMEOUT_MS = 60000;
export declare const MIN_SUBAGENT_TIMEOUT_MS = 1000;
export declare const MAX_SUBAGENT_TIMEOUT_MS = 3600000;
/**
 * Development/test override for the global config location. Keeps automated
 * tests hermetic regardless of the developer's real ~/.pi/forge/config.json.
 * Not part of the supported user-facing configuration surface.
 */
export declare const GLOBAL_FORGE_CONFIG_PATH_ENV = "PI_FORGE_GLOBAL_CONFIG_PATH";
export type ForgeSubagentBackendSource = "explicit" | "project" | "global" | "built-in";
export interface ForgeSubagentSettings {
    allowAgentInvocationWithoutApproval: boolean;
    /** Configured default backend ID; a trusted project config wins over the global config. */
    backend?: string;
    backendSource?: Exclude<ForgeSubagentBackendSource, "explicit" | "built-in">;
    /** Best-effort foreground timeout; a trusted project config wins over the global config. */
    timeoutMs: number;
    timeoutSource: Exclude<ForgeSubagentBackendSource, "explicit">;
    configPath: string;
    globalConfigPath: string;
    warnings: string[];
}
export interface ResolvedSubagentBackend {
    id: string;
    source: ForgeSubagentBackendSource;
}
/**
 * Resolve the effective backend for one run: explicit per-run override, then a
 * trusted project config default, then the user-owned global config default,
 * then the built-in subprocess backend. There is deliberately no fallback to
 * another backend when the resolved one is missing or rejects the intent.
 */
export declare function resolveSubagentBackend(settings: ForgeSubagentSettings, explicitBackend?: string): ResolvedSubagentBackend;
export declare function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings;
export declare function isValidSubagentTimeoutMs(value: unknown): value is number;
//# sourceMappingURL=forge-config.d.ts.map