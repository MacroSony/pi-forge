import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
	const root = resolve(cwd);
	const target = resolve(filePath);
	let current = root;
	for (const segment of relative(root, target).split(sep)) {
		current = join(current, segment);
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) return false;
	}
	return true;
}

export function forgeDir(cwd: string): string {
	return join(cwd, ".pi", "forge");
}

export function forgeExtensionsDir(cwd: string): string {
	return join(forgeDir(cwd), "extensions");
}

export function globalForgeDir(): string {
	return join(homedir(), ".pi", "forge");
}

export function globalForgeExtensionsDir(): string {
	return join(globalForgeDir(), "extensions");
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

function isInsideDir(rootDir: string, filePath: string): boolean {
	const root = resolve(rootDir);
	const target = resolve(filePath);
	const rel = relative(root, target);
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
