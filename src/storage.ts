import { isAbsolute, join, relative, resolve } from "node:path";

export function promptStacksDir(cwd: string): string {
	return join(cwd, ".pi", "forge", "prompt-stacks");
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
