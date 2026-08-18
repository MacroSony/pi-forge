import { resolveResourceSelector } from "./catalog.ts";
import { parseResourceSelector } from "./resource-identity.ts";
import { globalPromptStacksDir, promptStackReadDirs } from "./storage.ts";
import {
	readGlobalPromptStacks as readGlobalStacks,
	readPromptStacks as readProjectStacks,
	readPromptStacksScoped as readScopedStacks,
} from "./repositories/prompt-stack.ts";
import type { LoadedPromptStack } from "./types.ts";

export {
	globalPromptStacksDir,
	isInsideGlobalPromptStackStorage,
	isInsidePromptStackStorage,
	isSafeGlobalPromptStackMutationPath,
	isSafePromptStackMutationPath,
	legacyPromptStacksDir,
	promptStackPath,
	promptStackReadDirs,
	promptStacksDir,
} from "./storage.ts";

export { isValidResourceId as isValidPromptStackId } from "./resource-identity.ts";

export { validatePromptStack } from "./codecs/prompt-stack.ts";

/** Read project stacks (delegated to the repository read path). */
export function loadPromptStacks(cwd: string): LoadedPromptStack[] {
	return readProjectStacks(cwd);
}

/** Read both global and project stacks (delegated to the repository read path). */
export function loadPromptStacksScoped(cwd: string, globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	return readScopedStacks(cwd, globalDir);
}

/** Read only the user-owned global stacks (delegated to the repository read path). */
export function loadGlobalPromptStacks(globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	return readGlobalStacks(globalDir);
}

export function chooseDefaultStack(
	stacks: LoadedPromptStack[],
	preferredId?: string,
): LoadedPromptStack | undefined {
	if (isDisabledPromptStackId(preferredId)) return undefined;
	if (preferredId) {
		const parsed = parseResourceSelector(preferredId);
		if (parsed.ok) {
			const preferred = resolveResourceSelector(stacks, parsed.selector);
			if (preferred && isUsablePromptStack(preferred)) return preferred;
		}
	}
	return chooseAutoActivateStack(stacks);
}

/**
 * Standalone prompt-stack auto-activation with project-over-global scope
 * precedence. Only `autoActivate: true` participates. A project scope with
 * an invalid or ambiguous candidate fails closed instead of falling back to
 * a global candidate.
 */
export function chooseAutoActivateStack(stacks: LoadedPromptStack[]): LoadedPromptStack | undefined {
	const projectCandidates = stacks.filter((loaded) => loaded.scope === "project" && loaded.stack.autoActivate === true);
	if (projectCandidates.length > 0) {
		return projectCandidates.length === 1 && isUsablePromptStack(projectCandidates[0]!)
			? projectCandidates[0]
			: undefined;
	}
	const projectIds = new Set(
		stacks.filter((loaded) => loaded.scope === "project").map((loaded) => loaded.stack.id),
	);
	const globalCandidates = stacks.filter(
		(loaded) => loaded.scope === "global" && loaded.stack.autoActivate === true && !projectIds.has(loaded.stack.id),
	);
	return globalCandidates.length === 1 && isUsablePromptStack(globalCandidates[0]!)
		? globalCandidates[0]
		: undefined;
}

export function isUsablePromptStack(loaded: LoadedPromptStack): boolean {
	return !loaded.diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function isDisabledPromptStackId(id: string | undefined): boolean {
	return id === "none" || id === "off";
}
