import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidAgentProfileId } from "./agent-profile.ts";
import { globalForgeDir } from "./storage.ts";

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

export type ForgeSubagentBackendSource =
	| "explicit"
	| "project-profile"
	| "project"
	| "global"
	| "built-in";
export type ForgeSubagentConfigSource = "project" | "global";
export type ForgeSubagentProfileSource = "project-profile";

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
	/** Per-profile delegation allowlist and execution overrides. Unlisted profiles are not delegatable. */
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
	profileId: string;
	enabled: boolean;
	enabledSource: ForgeSubagentProfileSource | "built-in";
	backend: ResolvedSubagentBackend;
	timeout: ResolvedSubagentTimeout;
}

/**
 * Resolve the effective backend for one run: explicit per-run override, then
 * a trusted-project per-profile override, then trusted-project/global defaults,
 * then the built-in subprocess backend. There is deliberately no fallback when
 * the resolved backend is missing or rejects the intent.
 */
export function resolveSubagentBackend(
	settings: ForgeSubagentSettings,
	explicitBackend?: string,
	profileId?: string,
): ResolvedSubagentBackend {
	if (explicitBackend) return { id: explicitBackend, source: "explicit" };
	const profile = profileId ? configuredProfile(settings, profileId) : undefined;
	if (profile?.backend) return { id: profile.backend, source: profile.backendSource ?? "project-profile" };
	if (settings.backend) return { id: settings.backend, source: settings.backendSource ?? "global" };
	return { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" };
}

export function resolveSubagentTimeout(settings: ForgeSubagentSettings, profileId?: string): ResolvedSubagentTimeout {
	const profile = profileId ? configuredProfile(settings, profileId) : undefined;
	if (profile?.timeoutMs !== undefined) {
		return { milliseconds: profile.timeoutMs, source: profile.timeoutSource ?? "project-profile" };
	}
	return { milliseconds: settings.timeoutMs, source: settings.timeoutSource };
}

export function resolveSubagentProfilePolicy(
	settings: ForgeSubagentSettings,
	profileId: string,
	explicitBackend?: string,
): ResolvedSubagentProfilePolicy {
	const profile = configuredProfile(settings, profileId);
	return {
		profileId,
		enabled: profile?.enabled === true,
		enabledSource: profile?.enabledSource ?? "built-in",
		backend: resolveSubagentBackend(settings, explicitBackend, profileId),
		timeout: resolveSubagentTimeout(settings, profileId),
	};
}

export function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings {
	const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
	const globalConfigPath = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] ?? join(globalForgeDir(), "config.json");
	const settings: ForgeSubagentSettings = {
		allowAgentInvocationWithoutApproval: false,
		timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
		timeoutSource: "built-in",
		summaryInToolDescription: false,
		profiles: Object.create(null) as Record<string, ForgeSubagentProfileSettings>,
		configPath,
		globalConfigPath,
		warnings: [],
	};

	// The global config is user-owned and always applies. The project config is
	// honored only for trusted projects and overrides global values.
	const globalSection = readSubagentsSection(globalConfigPath, settings.warnings);
	applyBackend(globalSection, globalConfigPath, "global", settings);
	applyTimeout(globalSection, globalConfigPath, "global", settings);
	applyEmbedProfileSummary(globalSection, globalConfigPath, "global", settings);
	warnIgnoredGlobalProfiles(globalSection, globalConfigPath, settings);
	if (!ctx.isProjectTrusted()) return settings;
	const projectSection = readSubagentsSection(configPath, settings.warnings);
	applyBackend(projectSection, configPath, "project", settings);
	applyTimeout(projectSection, configPath, "project", settings);
	applyEmbedProfileSummary(projectSection, configPath, "project", settings);
	applyProjectProfiles(projectSection, configPath, settings);
	applyUnattended(projectSection, configPath, settings);
	return settings;
}

function readSubagentsSection(configPath: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(configPath)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		warnings.push(`pi-forge: failed to read ${configPath}; its subagent settings are ignored. ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isPlainObject(raw)) {
		warnings.push(`pi-forge: ${configPath} must be a JSON object; its subagent settings are ignored.`);
		return undefined;
	}
	if (raw.subagents === undefined) return undefined;
	if (!isPlainObject(raw.subagents)) {
		warnings.push(`pi-forge: ${configPath} subagents must be a JSON object; its subagent settings are ignored.`);
		return undefined;
	}
	return raw.subagents;
}

function applyBackend(
	section: Record<string, unknown> | undefined,
	configPath: string,
	source: ForgeSubagentConfigSource,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.backend === undefined) return;
	const value = section.backend;
	if (typeof value !== "string" || !value.trim()) {
		settings.warnings.push(`pi-forge: ${configPath} subagents.backend must be a non-empty string; the configured value is ignored.`);
		return;
	}
	settings.backend = value;
	settings.backendSource = source;
}

function applyTimeout(
	section: Record<string, unknown> | undefined,
	configPath: string,
	source: ForgeSubagentConfigSource,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.timeoutMs === undefined) return;
	const value = section.timeoutMs;
	if (!isValidSubagentTimeoutMs(value)) {
		settings.warnings.push(
			`pi-forge: ${configPath} subagents.timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; the configured value is ignored.`,
		);
		return;
	}
	settings.timeoutMs = value;
	settings.timeoutSource = source;
}

function applyEmbedProfileSummary(
	section: Record<string, unknown> | undefined,
	configPath: string,
	source: ForgeSubagentConfigSource,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.summaryInToolDescription === undefined) return;
	const value = section.summaryInToolDescription;
	if (typeof value !== "boolean") {
		settings.warnings.push(
			`pi-forge: ${configPath} subagents.summaryInToolDescription must be boolean; the configured value is ignored.`,
		);
		return;
	}
	settings.summaryInToolDescription = value;
	settings.summaryInToolDescriptionSource = source;
}

function warnIgnoredGlobalProfiles(
	section: Record<string, unknown> | undefined,
	configPath: string,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.profiles === undefined) return;
	settings.warnings.push(
		`pi-forge: ${configPath} subagents.profiles is project-only and ignored; configure profile delegation in the trusted project's .pi/forge/config.json.`,
	);
}

function applyProjectProfiles(
	section: Record<string, unknown> | undefined,
	configPath: string,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.profiles === undefined) return;
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
			if (field === "enabled" || field === "backend" || field === "timeoutMs") continue;
			settings.warnings.push(`pi-forge: ${configPath} ${path}.${field} is unsupported and ignored.`);
		}
		const target = configuredProfile(settings, profileId) ?? {};
		const profileSource: ForgeSubagentProfileSource = "project-profile";
		if (rawProfile.enabled !== undefined) {
			if (typeof rawProfile.enabled !== "boolean") {
				settings.warnings.push(`pi-forge: ${configPath} ${path}.enabled must be boolean; the configured value is ignored.`);
			} else {
				target.enabled = rawProfile.enabled;
				target.enabledSource = profileSource;
			}
		}
		if (rawProfile.backend !== undefined) {
			if (typeof rawProfile.backend !== "string" || !rawProfile.backend.trim()) {
				settings.warnings.push(`pi-forge: ${configPath} ${path}.backend must be a non-empty string; the configured value is ignored.`);
			} else {
				target.backend = rawProfile.backend;
				target.backendSource = profileSource;
			}
		}
		if (rawProfile.timeoutMs !== undefined) {
			if (!isValidSubagentTimeoutMs(rawProfile.timeoutMs)) {
				settings.warnings.push(
					`pi-forge: ${configPath} ${path}.timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; the configured value is ignored.`,
				);
			} else {
				target.timeoutMs = rawProfile.timeoutMs;
				target.timeoutSource = profileSource;
			}
		}
		if (Object.keys(target).length > 0) settings.profiles[profileId] = target;
	}
}

function applyUnattended(
	section: Record<string, unknown> | undefined,
	configPath: string,
	settings: ForgeSubagentSettings,
): void {
	if (!section || section.allowAgentInvocationWithoutApproval === undefined) return;
	const value = section.allowAgentInvocationWithoutApproval;
	if (typeof value !== "boolean") {
		settings.warnings.push(`pi-forge: ${configPath} subagents.allowAgentInvocationWithoutApproval must be boolean; per-run subagent approval remains required.`);
		return;
	}
	settings.allowAgentInvocationWithoutApproval = value;
}

export function isValidSubagentTimeoutMs(value: unknown): value is number {
	return Number.isSafeInteger(value)
		&& (value as number) >= MIN_SUBAGENT_TIMEOUT_MS
		&& (value as number) <= MAX_SUBAGENT_TIMEOUT_MS;
}

/**
 * One trusted-project per-profile delegation update. `enabled: false`,
 * `backend: null`, and `timeoutMs: null` remove the explicit value; entries
 * that become empty are removed so the file only records real overrides.
 */
export interface ForgeSubagentProfileConfigUpdate {
	enabled?: boolean;
	backend?: string | null;
	timeoutMs?: number | null;
}

export type ForgeSubagentProfileConfigResult =
	| { ok: true; configPath: string }
	| { ok: false; error: string };

/**
 * Update `subagents.profiles.<id>` in the project's `.pi/forge/config.json`,
 * preserving unknown top-level, `subagents`, and per-entry fields. Callers
 * must gate this on project trust; the project config is ignored otherwise.
 */
export function updateForgeSubagentProfileConfig(
	cwd: string,
	profileId: string,
	update: ForgeSubagentProfileConfigUpdate,
): ForgeSubagentProfileConfigResult {
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

	const configPath = join(cwd, ".pi", "forge", "config.json");
	let root: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (error) {
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
	const subagents: Record<string, unknown> = isPlainObject(root.subagents) ? root.subagents : {};
	if (subagents.profiles !== undefined && !isPlainObject(subagents.profiles)) {
		return { ok: false, error: `Refusing to update ${configPath}: subagents.profiles must be a JSON object.` };
	}
	const profiles: Record<string, unknown> = isPlainObject(subagents.profiles) ? subagents.profiles : {};
	if (profiles[profileId] !== undefined && !isPlainObject(profiles[profileId])) {
		return { ok: false, error: `Refusing to update ${configPath}: subagents.profiles.${profileId} must be a JSON object.` };
	}
	const entry: Record<string, unknown> = isPlainObject(profiles[profileId]) ? { ...profiles[profileId] } : {};

	if (update.enabled !== undefined) {
		if (update.enabled) entry.enabled = true;
		else delete entry.enabled;
	}
	if (update.backend !== undefined) {
		if (typeof update.backend === "string" && update.backend.trim()) entry.backend = update.backend.trim();
		else delete entry.backend;
	}
	if (update.timeoutMs !== undefined) {
		if (update.timeoutMs === null) delete entry.timeoutMs;
		else entry.timeoutMs = update.timeoutMs;
	}

	if (Object.keys(entry).length > 0) profiles[profileId] = entry;
	else delete profiles[profileId];
	if (Object.keys(profiles).length > 0) subagents.profiles = profiles;
	else delete subagents.profiles;
	if (Object.keys(subagents).length > 0) root.subagents = subagents;
	else delete root.subagents;

	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
		return { ok: true, configPath };
	} catch (error) {
		return { ok: false, error: `Failed to write ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function configuredProfile(settings: ForgeSubagentSettings, profileId: string): ForgeSubagentProfileSettings | undefined {
	return Object.hasOwn(settings.profiles, profileId) ? settings.profiles[profileId] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
