import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentProfile } from "../agent-profile.ts";
import {
	createAgentProfileFault,
	parseAgentProfile,
	serializeAgentProfile,
	type AgentProfileDiagnostic,
	type LoadedAgentProfile,
} from "../codecs/agent-profile.ts";
import type { ResourceScope } from "../resource-identity.ts";
import {
	agentProfilePath,
	agentProfilesDir,
	globalAgentProfilePath,
	globalAgentProfilesDir,
	isSafeAgentProfileMutationPath,
	isSafeGlobalAgentProfileMutationPath,
} from "../storage.ts";

export type RepositoryScope = Extract<ResourceScope, "project" | "global">;

// ---------------------------------------------------------------------------
// Read (the only scoped read path).
// ---------------------------------------------------------------------------

export function readAgentProfiles(cwd: string): LoadedAgentProfile[] {
	const profiles = loadAgentProfilesFromDir(agentProfilesDir(cwd), "project");
	annotateDuplicateProfileIds(profiles);
	annotateAutoActivateConflicts(profiles);
	return profiles;
}

export function readAgentProfilesScoped(cwd: string, globalDir: string = globalAgentProfilesDir()): LoadedAgentProfile[] {
	const profiles = [
		...loadAgentProfilesFromDir(globalDir, "global"),
		...loadAgentProfilesFromDir(agentProfilesDir(cwd), "project"),
	];
	annotateDuplicateProfileIds(profiles);
	annotateAutoActivateConflicts(profiles);
	return profiles;
}

export function readGlobalAgentProfiles(globalDir: string = globalAgentProfilesDir()): LoadedAgentProfile[] {
	const profiles = loadAgentProfilesFromDir(globalDir, "global");
	annotateDuplicateProfileIds(profiles);
	annotateAutoActivateConflicts(profiles);
	return profiles;
}

export function readSingleAgentProfileFile(filePath: string, scope: "global" | "project" = "project"): LoadedAgentProfile {
	let source: string;
	try {
		source = readFileSync(filePath, "utf8");
	} catch (error) {
		return createAgentProfileFault(
			filePath,
			scope,
			`Failed to read agent profile: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseAgentProfile(source, filePath, scope);
}

function loadAgentProfilesFromDir(dir: string, scope: "global" | "project"): LoadedAgentProfile[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	return entries.map((name) => readSingleAgentProfileFile(join(dir, name), scope));
}

function annotateDuplicateProfileIds(profiles: LoadedAgentProfile[]): void {
	const byScopeId = new Map<string, LoadedAgentProfile[]>();
	for (const loaded of profiles) {
		const key = `${loaded.scope}\0${loaded.profile.id}`;
		const matches = byScopeId.get(key) ?? [];
		matches.push(loaded);
		byScopeId.set(key, matches);
	}
	for (const matches of byScopeId.values()) {
		if (matches.length <= 1) continue;
		const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
		for (const loaded of matches) {
			loaded.diagnostics.push({
				level: "error",
				message: `Duplicate ${loaded.scope} profile id: ${loaded.profile.id} appears in multiple files (${files}).`,
			});
		}
	}
}

function annotateAutoActivateConflicts(profiles: LoadedAgentProfile[]): void {
	const byScope = new Map<"global" | "project", LoadedAgentProfile[]>();
	for (const loaded of profiles) {
		if (loaded.profile.autoActivate !== true) continue;
		const matches = byScope.get(loaded.scope) ?? [];
		matches.push(loaded);
		byScope.set(loaded.scope, matches);
	}
	for (const [scope, candidates] of byScope) {
		if (candidates.length <= 1) continue;
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

export type AgentProfileWriteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "exists" | "io"; error?: string };

export type AgentProfileDeleteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "missing" | "io"; error?: string };

export function agentProfileTargetPath(cwd: string, scope: RepositoryScope, id: string): string {
	return scope === "global" ? globalAgentProfilePath(id) : agentProfilePath(cwd, id);
}

function isSafeTarget(cwd: string, scope: RepositoryScope, filePath: string): boolean {
	return scope === "project"
		? isSafeAgentProfileMutationPath(cwd, filePath)
		: isSafeGlobalAgentProfileMutationPath(filePath);
}

function targetError(scope: RepositoryScope, filePath: string): string {
	return `Profile path is outside ${scope} agent-profile storage or traverses a symbolic link: ${filePath}`;
}

/**
 * Write an agent profile. This is the only write path for agent-profile domain
 * resources. `overwrite: false` refuses to clobber an existing file, matching
 * the current replacement semantics (no expected-fingerprint conflict or atomic
 * replacement is introduced yet).
 */
export function writeAgentProfileFile(
	cwd: string,
	scope: RepositoryScope,
	filePath: string,
	profile: AgentProfile,
	options: { overwrite: boolean },
): AgentProfileWriteResult {
	if (!isSafeTarget(cwd, scope, filePath)) {
		return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
	}
	if (!options.overwrite && existsSync(filePath)) {
		return { ok: false, reason: "exists", error: `Agent profile already exists: ${filePath}` };
	}

	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, serializeAgentProfile(profile), { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
		return { ok: true, filePath };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "EEXIST") {
			return { ok: false, reason: "exists", error: `Agent profile already exists: ${filePath}` };
		}
		return {
			ok: false,
			reason: "io",
			error: `Failed to write agent profile ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function deleteAgentProfileFile(
	cwd: string,
	scope: RepositoryScope,
	filePath: string,
): AgentProfileDeleteResult {
	if (!isSafeTarget(cwd, scope, filePath)) {
		return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
	}
	if (!existsSync(filePath)) {
		return { ok: false, reason: "missing", error: `Agent profile does not exist: ${filePath}` };
	}

	try {
		unlinkSync(filePath);
		return { ok: true, filePath };
	} catch (error) {
		return {
			ok: false,
			reason: "io",
			error: `Failed to delete agent profile ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
