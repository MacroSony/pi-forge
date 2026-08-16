import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ResourceScope } from "./resource-identity.ts";
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
export type ForgeSubagentBackendSource = "explicit" | "project-profile" | "global-profile" | "project" | "global" | "built-in";
export type ForgeSubagentConfigSource = "project" | "global";
export type ForgeSubagentProfileSource = "project-profile" | "global-profile";
export interface ForgeSubagentProfileSettings {
    enabled?: boolean;
    enabledSource?: ForgeSubagentProfileSource;
    backend?: string;
    backendSource?: ForgeSubagentProfileSource;
    timeoutMs?: number;
    timeoutSource?: ForgeSubagentProfileSource;
}
export interface ForgeSubagentSettings {
    allowAgentInvocationWithoutApproval: boolean;
    /** Configured default backend ID; a trusted project config wins over the global config. */
    backend?: string;
    backendSource?: ForgeSubagentConfigSource;
    /** Best-effort foreground timeout; a trusted project config wins over the global config. */
    timeoutMs: number;
    timeoutSource: ForgeSubagentConfigSource | "built-in";
    /**
     * Embed a compact summary of enabled subagent profiles directly in the
     * forge_subagent tool description so the parent model does not need a
     * discovery call for a small set of frequently used profiles. Opt-in
     * because the summary rides in every request; the discovery tool remains
     * the authoritative surface.
     */
    summaryInToolDescription: boolean;
    summaryInToolDescriptionSource?: ForgeSubagentConfigSource;
    /**
     * Per-profile delegation allowlist and execution overrides, keyed by
     * canonical scoped selector (`global:<id>` or `project:<id>`). Unlisted
     * profiles are not delegatable.
     */
    profiles: Record<string, ForgeSubagentProfileSettings>;
    configPath: string;
    globalConfigPath: string;
    warnings: string[];
}
export interface ResolvedSubagentBackend {
    id: string;
    source: ForgeSubagentBackendSource;
}
export interface ResolvedSubagentTimeout {
    milliseconds: number;
    source: Exclude<ForgeSubagentBackendSource, "explicit">;
}
export interface ResolvedSubagentProfilePolicy {
    /** The selector used to resolve this policy, e.g. `reviewer` or `global:reviewer`. */
    profileId: string;
    enabled: boolean;
    enabledSource: ForgeSubagentProfileSource | "built-in";
    backend: ResolvedSubagentBackend;
    timeout: ResolvedSubagentTimeout;
}
/**
 * Resolve the effective backend for one run: explicit per-run override, then
 * a matching-scope per-profile override, then trusted-project/global defaults,
 * then the built-in subprocess backend. There is deliberately no fallback when
 * the resolved backend is missing or rejects the intent.
 */
export declare function resolveSubagentBackend(settings: ForgeSubagentSettings, explicitBackend?: string, profileId?: string): ResolvedSubagentBackend;
export declare function resolveSubagentTimeout(settings: ForgeSubagentSettings, profileId?: string): ResolvedSubagentTimeout;
export declare function resolveSubagentProfilePolicy(settings: ForgeSubagentSettings, profileId: string, explicitBackend?: string): ResolvedSubagentProfilePolicy;
export declare function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings;
export declare function isValidSubagentTimeoutMs(value: unknown): value is number;
/**
 * One scoped per-profile delegation update. `enabled: false`,
 * `backend: null`, and `timeoutMs: null` remove the explicit value; entries
 * that become empty are removed so the file only records real overrides.
 */
export interface ForgeSubagentProfileConfigUpdate {
    enabled?: boolean;
    backend?: string | null;
    timeoutMs?: number | null;
}
export type ForgeSubagentProfileConfigResult = {
    ok: true;
    configPath: string;
} | {
    ok: false;
    error: string;
};
export declare function globalForgeConfigPath(): string;
export declare function projectForgeConfigPath(cwd: string): string;
/**
 * Update `subagents.profiles.<id>` in the selected scope's config file,
 * preserving unknown top-level, `subagents`, and per-entry fields. Project
 * config updates must be gated on project trust by the caller; global config
 * is user-owned and always writable.
 */
export declare function updateForgeSubagentProfileConfig(cwd: string, profileId: string, update: ForgeSubagentProfileConfigUpdate, options?: {
    scope?: ResourceScope;
}): ForgeSubagentProfileConfigResult;
/**
 * Resolve the configured per-profile settings for a profile selector. Bare
 * selectors use project-first effective lookup; qualified selectors address
 * the exact scope. Returns undefined for unknown or malformed selectors.
 */
export declare function configuredProfileForSelector(settings: ForgeSubagentSettings, profileId: string): ForgeSubagentProfileSettings | undefined;
//# sourceMappingURL=forge-config.d.ts.map