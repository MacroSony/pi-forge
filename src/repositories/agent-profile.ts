import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentProfile } from "../agent-profile.ts";
import { serializeAgentProfile } from "../codecs/agent-profile.ts";
import type { ResourceScope } from "../resource-identity.ts";
import {
	agentProfilePath,
	globalAgentProfilePath,
	isSafeAgentProfileMutationPath,
	isSafeGlobalAgentProfileMutationPath,
} from "../storage.ts";

export type RepositoryScope = Extract<ResourceScope, "project" | "global">;

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
