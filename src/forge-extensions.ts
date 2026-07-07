import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	getRegisteredMacros,
	registerMacro,
	type PromptMacroDefinition,
} from "./macro-engine.ts";
import { promptRenderHelpers, type PromptRenderHelpers } from "./render-helpers.ts";
import {
	getRegisteredSlots,
	registerSlot,
	type PromptSlotDefinition,
} from "./slot-renderers.ts";
import { forgeDir, forgeExtensionsDir, globalForgeDir, globalForgeExtensionsDir } from "./storage.ts";
import type { PromptStackDiagnostic } from "./types.ts";

export interface ForgeExtensionApi {
	cwd: string;
	forgeDir: string;
	extensionPath: string;
	helpers: PromptRenderHelpers;
	registerMacro(definition: PromptMacroDefinition): () => void;
	registerSlot(definition: PromptSlotDefinition): () => void;
	getRegisteredMacros: typeof getRegisteredMacros;
	getRegisteredSlots: typeof getRegisteredSlots;
}

export type ForgeExtensionRegister = (api: ForgeExtensionApi) => void | (() => void) | Promise<void | (() => void)>;

export interface ForgeExtensionState {
	unregister: Array<() => void>;
	loadVersion: number;
}

export interface ForgeExtensionLoadResult {
	diagnostics: PromptStackDiagnostic[];
	loadedPaths: string[];
}

interface ForgeExtensionCandidate {
	filePath: string;
	forgeDir: string;
}

export function createForgeExtensionState(): ForgeExtensionState {
	return { unregister: [], loadVersion: 0 };
}

export async function reloadForgeExtensions(cwd: string, state: ForgeExtensionState): Promise<ForgeExtensionLoadResult> {
	const diagnostics = unloadForgeExtensions(state);
	state.loadVersion++;
	const loadedPaths: string[] = [];

	for (const candidate of discoverForgeExtensionCandidates(cwd)) {
		const result = await loadForgeExtensionFile(cwd, candidate.forgeDir, candidate.filePath, state.loadVersion);
		diagnostics.push(...result.diagnostics);
		if (result.loaded) {
			state.unregister.push(...result.unregister);
			loadedPaths.push(candidate.filePath);
		}
	}

	return { diagnostics, loadedPaths };
}

export function unloadForgeExtensions(state: ForgeExtensionState): PromptStackDiagnostic[] {
	const diagnostics: PromptStackDiagnostic[] = [];
	for (const unregister of state.unregister.splice(0).reverse()) {
		try {
			unregister();
		} catch (error) {
			diagnostics.push({
				level: "warning",
				message: `Failed to unload pi-forge extension: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return diagnostics;
}

export function discoverForgeExtensionFiles(cwd: string): string[] {
	return discoverForgeExtensionCandidates(cwd).map((candidate) => candidate.filePath);
}

function discoverForgeExtensionCandidates(cwd: string): ForgeExtensionCandidate[] {
	const dirs = [
		{ dir: globalForgeExtensionsDir(), forgeDir: globalForgeDir() },
		{ dir: forgeExtensionsDir(cwd), forgeDir: forgeDir(cwd) },
	];
	const seenDirs = new Set<string>();
	return dirs.flatMap(({ dir, forgeDir }) => {
		if (seenDirs.has(dir)) return [];
		seenDirs.add(dir);
		return discoverForgeExtensionFilesInDir(dir).map((filePath) => ({ filePath, forgeDir }));
	});
}

function discoverForgeExtensionFilesInDir(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	for (const name of entries.sort()) {
		if (name.startsWith(".")) continue;
		const fullPath = join(dir, name);
		let stats;
		try {
			stats = statSync(fullPath);
		} catch {
			continue;
		}

		if (stats.isFile() && isForgeExtensionFile(fullPath)) {
			files.push(fullPath);
			continue;
		}

		if (!stats.isDirectory()) continue;
		for (const indexName of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
			const indexPath = join(fullPath, indexName);
			if (existsSync(indexPath)) {
				files.push(indexPath);
				break;
			}
		}
	}

	return files;
}

async function loadForgeExtensionFile(
	cwd: string,
	forgeDirPath: string,
	filePath: string,
	loadVersion: number,
): Promise<{ loaded: boolean; unregister: Array<() => void>; diagnostics: PromptStackDiagnostic[] }> {
	const unregister: Array<() => void> = [];
	const diagnostics: PromptStackDiagnostic[] = [];
	try {
		const module = await import(`${pathToFileURL(filePath).href}?piForgeReload=${loadVersion}`);
		const register = readRegisterFunction(module);
		if (!register) {
			return {
				loaded: false,
				unregister,
				diagnostics: [{
					level: "warning",
					message: `pi-forge extension ${extensionLabel(filePath)} must export a default function or named register function.`,
				}],
			};
		}

		const cleanup = await register(createForgeExtensionApi(cwd, forgeDirPath, filePath, unregister));
		if (typeof cleanup === "function") unregister.push(once(cleanup));
		return { loaded: true, unregister, diagnostics };
	} catch (error) {
		for (const cleanup of unregister.splice(0).reverse()) {
			try {
				cleanup();
			} catch {
				// Preserve the original load error; cleanup failures are secondary.
			}
		}
		diagnostics.push({
			level: "warning",
			message: `Failed to load pi-forge extension ${extensionLabel(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { loaded: false, unregister: [], diagnostics };
	}
}

function createForgeExtensionApi(cwd: string, forgeDirPath: string, extensionPath: string, unregister: Array<() => void>): ForgeExtensionApi {
	return {
		cwd,
		forgeDir: forgeDirPath,
		extensionPath,
		helpers: promptRenderHelpers,
		registerMacro: (definition) => trackUnregister(unregister, registerMacro(definition)),
		registerSlot: (definition) => trackUnregister(unregister, registerSlot(definition)),
		getRegisteredMacros,
		getRegisteredSlots,
	};
}

function trackUnregister(unregisters: Array<() => void>, unregister: () => void): () => void {
	const tracked = once(unregister);
	unregisters.push(tracked);
	return tracked;
}

function once(callback: () => void): () => void {
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		callback();
	};
}

function readRegisterFunction(module: unknown): ForgeExtensionRegister | undefined {
	const record = module && typeof module === "object" ? module as { default?: unknown; register?: unknown } : {};
	if (typeof record.default === "function") return record.default as ForgeExtensionRegister;
	if (typeof record.register === "function") return record.register as ForgeExtensionRegister;
	if (record.default && typeof record.default === "object" && typeof (record.default as { register?: unknown }).register === "function") {
		return (record.default as { register: ForgeExtensionRegister }).register;
	}
	return undefined;
}

function isForgeExtensionFile(filePath: string): boolean {
	return (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) && !filePath.endsWith(".d.ts");
}

function extensionLabel(filePath: string): string {
	return basename(filePath);
}
