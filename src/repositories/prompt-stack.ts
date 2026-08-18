import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createPromptStackFault, parsePromptStack, serializePromptStack } from "../codecs/prompt-stack.ts";
import type { ResourceScope } from "../resource-identity.ts";
import {
	globalPromptStacksDir,
	isSafeGlobalPromptStackMutationPath,
	isSafePromptStackMutationPath,
	legacyPromptStacksDir,
	promptStackPath,
	promptStackReadDirs,
} from "../storage.ts";
import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "../types.ts";

export type RepositoryScope = Extract<ResourceScope, "project" | "global">;

export type PromptStackWriteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "exists" | "io"; error: string };

export type PromptStackDeleteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "missing" | "io"; error: string };

// ---------------------------------------------------------------------------
// Read (the only scoped read path).
// ---------------------------------------------------------------------------

export function readPromptStacks(cwd: string): LoadedPromptStack[] {
	const loaded = promptStackFiles(promptStackReadDirs(cwd), "project").map((file) => loadPromptStackFile(file, "project"));
	annotateDuplicateStackIds(loaded);
	return loaded;
}

export function readPromptStacksScoped(cwd: string, globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	const loaded = [
		...promptStackFiles([globalDir], "global").map((file) => loadPromptStackFile(file, "global")),
		...promptStackFiles(promptStackReadDirs(cwd), "project").map((file) => loadPromptStackFile(file, "project")),
	];
	annotateDuplicateStackIds(loaded);
	return loaded;
}

export function readGlobalPromptStacks(globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	const loaded = promptStackFiles([globalDir], "global").map((file) => loadPromptStackFile(file, "global"));
	annotateDuplicateStackIds(loaded);
	return loaded;
}

function promptStackFiles(dirs: string[], scope: "global" | "project"): string[] {
	const files: string[] = [];
	const shadowedNames = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const name of entries.sort()) {
			if (shadowedNames.has(name)) continue;
			shadowedNames.add(name);
			files.push(join(dir, name));
		}
	}
	return files;
}

function loadPromptStackFile(filePath: string, scope: "global" | "project"): LoadedPromptStack {
	let source: string;
	try {
		source = readFileSync(filePath, "utf8");
	} catch (error) {
		return createPromptStackFault(
			filePath,
			scope,
			`Failed to read prompt stack: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parsePromptStack(source, filePath, scope);
}

function annotateDuplicateStackIds(stacks: LoadedPromptStack[]): void {
	const byScopeId = new Map<string, LoadedPromptStack[]>();
	for (const loaded of stacks) {
		const key = `${loaded.scope}\0${loaded.stack.id}`;
		const matches = byScopeId.get(key) ?? [];
		matches.push(loaded);
		byScopeId.set(key, matches);
	}
	for (const matches of byScopeId.values()) {
		if (matches.length <= 1) continue;
		const id = matches[0]!.stack.id;
		const scope = matches[0]!.scope;
		const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
		for (const loaded of matches) {
			loaded.diagnostics.push({
				level: "error",
				message: `Duplicate ${scope} stack id: ${id} appears in multiple files (${files}).`,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Write / delete (the only scoped mutation path).
// ---------------------------------------------------------------------------

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
		if (code === "EEXIST") return { ok: false, reason: "exists", error: `Prompt stack already exists: ${filePath}` };
		return { ok: false, reason: "io", error: `Failed to write prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
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
	if (!existsSync(filePath)) return { ok: false, reason: "missing", error: `Prompt stack does not exist: ${filePath}` };
	try {
		unlinkSync(filePath);
		return { ok: true, filePath };
	} catch (error) {
		return { ok: false, reason: "io", error: `Failed to delete prompt stack ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}


// ---------------------------------------------------------------------------
// Legacy migration (byte-preserving exception).
//
// Migration moves legacy `.pi/prompt-stacks/*.json` into canonical storage as
// raw bytes so v1 files round-trip unmodified; canonicalization (parse/
// normalize/validate/serialize) happens on every subsequent read through the
// codec. The raw IO still lives in this repository, never at the adapter layer.
// ---------------------------------------------------------------------------

export interface LegacyPromptStackSource {
	name: string;
	sourcePath: string;
}

export function readLegacyPromptStackSources(cwd: string): LegacyPromptStackSource[] {
	const dir = legacyPromptStacksDir(cwd);
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	return entries.map((name) => ({ name, sourcePath: join(dir, name) }));
}

export type LegacyCopyResult =
	| { ok: true; filePath: string; action: "copy" | "overwrite" }
	| { ok: false; reason: "invalid-path" | "exists" | "io"; error: string };

export function copyLegacyPromptStackFile(
	cwd: string,
	sourcePath: string,
	targetPath: string,
	options: { overwrite: boolean; dryRun?: boolean },
): LegacyCopyResult {
	if (!isSafePromptStackMutationPath(cwd, sourcePath) || !isSafePromptStackMutationPath(cwd, targetPath)) {
		return { ok: false, reason: "invalid-path", error: "Legacy migration path is outside prompt-stack storage or traverses a symbolic link." };
	}
	const targetExists = existsSync(targetPath);
	if (targetExists && !options.overwrite) {
		return { ok: false, reason: "exists", error: `Target already exists: ${targetPath}` };
	}
	if (!options.dryRun) {
		try {
			mkdirSync(dirname(targetPath), { recursive: true });
			copyFileSync(sourcePath, targetPath);
		} catch (error) {
			return { ok: false, reason: "io", error: `Failed to copy ${sourcePath} -> ${targetPath}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return { ok: true, filePath: targetPath, action: targetExists ? "overwrite" : "copy" };
}

export type LegacyDeleteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "invalid-path" | "missing" | "io"; error: string };

export function deleteLegacyPromptStackFile(
	cwd: string,
	sourcePath: string,
	options: { dryRun?: boolean } = {},
): LegacyDeleteResult {
	if (!isSafePromptStackMutationPath(cwd, sourcePath)) {
		return { ok: false, reason: "invalid-path", error: "Legacy delete path is outside prompt-stack storage or traverses a symbolic link." };
	}
	if (!existsSync(sourcePath)) return { ok: false, reason: "missing", error: `Legacy source does not exist: ${sourcePath}` };
	if (!options.dryRun) {
		try {
			unlinkSync(sourcePath);
		} catch (error) {
			return { ok: false, reason: "io", error: `Failed to delete ${sourcePath}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return { ok: true, filePath: sourcePath };
}
