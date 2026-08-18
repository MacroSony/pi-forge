import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serializePromptStack } from "../codecs/prompt-stack.ts";
import type { ResourceScope } from "../resource-identity.ts";
import {
	globalPromptStacksDir,
	isSafeGlobalPromptStackMutationPath,
	isSafePromptStackMutationPath,
	promptStackPath,
} from "../storage.ts";
import type { PromptStack } from "../types.ts";

export type RepositoryScope = Extract<ResourceScope, "project" | "global">;

export type PromptStackWriteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "exists" | "io"; error: string };

export type PromptStackDeleteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "missing" | "io"; error: string };

export function promptStackTargetPath(cwd: string, scope: RepositoryScope, id: string): string {
	return scope === "global" ? join(globalPromptStacksDir(), `${id}.json`) : promptStackPath(cwd, id);
}

function isSafeTarget(cwd: string, scope: RepositoryScope, filePath: string): boolean {
	return scope === "project"
		? isSafePromptStackMutationPath(cwd, filePath)
		: isSafeGlobalPromptStackMutationPath(filePath);
}

function targetError(scope: RepositoryScope, filePath: string): string {
	return `Prompt stack path is outside ${scope} prompt-stack storage or traverses a symbolic link: ${filePath}`;
}

/**
 * Write a prompt stack. This is the only write path for prompt-stack domain
 * resources. `overwrite: false` refuses to clobber an existing file, matching
 * the current replacement semantics (no expected-fingerprint conflict or atomic
 * replacement is introduced yet).
 */
export function writePromptStackFile(
	cwd: string,
	scope: RepositoryScope,
	filePath: string,
	stack: PromptStack,
	options: { overwrite: boolean },
): PromptStackWriteResult {
	if (!isSafeTarget(cwd, scope, filePath)) {
		return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
	}
	if (!options.overwrite && existsSync(filePath)) {
		return { ok: false, reason: "exists", error: `Prompt stack already exists: ${filePath}` };
	}

	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, serializePromptStack(stack), { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
		return { ok: true, filePath };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "EEXIST") {
			return { ok: false, reason: "exists", error: `Prompt stack already exists: ${filePath}` };
		}
		return {
			ok: false,
			reason: "io",
			error: `Failed to write prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function deletePromptStackFile(
	cwd: string,
	scope: RepositoryScope,
	filePath: string,
): PromptStackDeleteResult {
	if (!isSafeTarget(cwd, scope, filePath)) {
		return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
	}
	if (!existsSync(filePath)) {
		return { ok: false, reason: "missing", error: `Prompt stack does not exist: ${filePath}` };
	}

	try {
		unlinkSync(filePath);
		return { ok: true, filePath };
	} catch (error) {
		return {
			ok: false,
			reason: "io",
			error: `Failed to delete prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
