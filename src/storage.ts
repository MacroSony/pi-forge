import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Development/test override for the user-owned global Forge root. */
export const GLOBAL_FORGE_DIR_ENV = "PI_FORGE_GLOBAL_DIR";

export function promptStacksDir(cwd: string): string {
	return join(cwd, ".pi", "forge", "prompt-stacks");
}

export function agentProfilesDir(cwd: string): string {
	return join(cwd, ".pi", "forge", "agent-profiles");
}

export function agentProfilePath(cwd: string, id: string): string {
	return join(agentProfilesDir(cwd), `${id}.json`);
}

export function isInsideAgentProfileStorage(cwd: string, filePath: string): boolean {
	return isInsideDir(agentProfilesDir(cwd), filePath);
}

export function isSafeAgentProfileMutationPath(cwd: string, filePath: string): boolean {
	if (!isInsideAgentProfileStorage(cwd, filePath)) return false;
	return pathTraversesNoSymlink(cwd, filePath);
}

export function forgeDir(cwd: string): string {
	return join(cwd, ".pi", "forge");
}

export function forgeExtensionsDir(cwd: string): string {
	return join(forgeDir(cwd), "extensions");
}

export function globalForgeDir(): string {
	return process.env[GLOBAL_FORGE_DIR_ENV] ?? join(homedir(), ".pi", "forge");
}

export function globalPromptStacksDir(): string {
	return join(globalForgeDir(), "prompt-stacks");
}

export function globalAgentProfilesDir(): string {
	return join(globalForgeDir(), "agent-profiles");
}

export function globalAgentProfilePath(id: string): string {
	return join(globalAgentProfilesDir(), `${id}.json`);
}

export function globalForgeExtensionsDir(): string {
	return join(globalForgeDir(), "extensions");
}

export function isInsideGlobalAgentProfileStorage(filePath: string): boolean {
	return isInsideDir(globalAgentProfilesDir(), filePath);
}

export function isSafeGlobalAgentProfileMutationPath(filePath: string): boolean {
	if (!isInsideGlobalAgentProfileStorage(filePath)) return false;
	return pathTraversesNoSymlink(globalForgeDir(), filePath);
}

export function legacyPromptStacksDir(cwd: string): string {
	return join(cwd, ".pi", "prompt-stacks");
}

export function promptStackReadDirs(cwd: string): string[] {
	return [promptStacksDir(cwd), legacyPromptStacksDir(cwd)];
}

export function promptStackPath(cwd: string, id: string): string {
	return join(promptStacksDir(cwd), `${id}.json`);
}

export function isInsidePromptStackStorage(cwd: string, filePath: string): boolean {
	return promptStackReadDirs(cwd).some((dir) => isInsideDir(dir, filePath));
}

export function isSafePromptStackMutationPath(cwd: string, filePath: string): boolean {
	if (!isInsidePromptStackStorage(cwd, filePath)) return false;
	return pathTraversesNoSymlink(cwd, filePath);
}

export function isInsideGlobalPromptStackStorage(filePath: string): boolean {
	return isInsideDir(globalPromptStacksDir(), filePath);
}

export function isSafeGlobalPromptStackMutationPath(filePath: string): boolean {
	if (!isInsideGlobalPromptStackStorage(filePath)) return false;
	return pathTraversesNoSymlink(globalForgeDir(), filePath);
}

function isInsideDir(rootDir: string, filePath: string): boolean {
	const root = resolve(rootDir);
	const target = resolve(filePath);
	const rel = relative(root, target);
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function pathTraversesNoSymlink(root: string, filePath: string): boolean {
	const resolvedRoot = resolve(root);
	const target = resolve(filePath);
	let current = resolvedRoot;
	for (const segment of relative(resolvedRoot, target).split(sep)) {
		current = join(current, segment);
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) return false;
	}
	return true;
}
