import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isInsidePromptStackStorage,
	promptStackPath,
	validatePromptStack,
} from "./loader.ts";
import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "./types.ts";
import type {
	WebEditorCreateStackOptions,
	WebEditorHost,
	WebEditorOperationResult,
	WebEditorPayloadSnapshot,
	WebEditorPreview,
	WebEditorStackSummary,
} from "./web-editor/index.ts";

export interface WebHostRuntime {
	getStacks(): LoadedPromptStack[];
	getActive(): LoadedPromptStack | undefined;
	getActiveId(): string | undefined;
	getSelectedActiveId(): string | undefined;
	setActive(id: string | undefined): boolean;
	reloadStacks(preferredId?: string): void;
	buildPreview(target: LoadedPromptStack): {
		text: string;
		preview: WebEditorPreview;
		diagnostics: PromptStackDiagnostic[];
	};
	getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
}

export function createWebEditorHost(ctx: ExtensionCommandContext, runtime: WebHostRuntime): WebEditorHost {
	return {
		cwd: ctx.cwd,
		listStacks: () => stackSummaries(runtime.getStacks(), runtime.getActive()),
		getStack: (id) => {
			const loaded = runtime.getStacks().find((candidate) => candidate.stack.id === id);
			return loaded ? { stack: loaded.stack, filePath: loaded.filePath, diagnostics: loaded.diagnostics } : undefined;
		},
		createStack: (stack, options) => createStackFile(ctx, runtime, stack, options),
		saveStack: (id, stack) => saveStackFile(ctx, runtime, id, stack),
		deleteStack: (id) => deleteStackFile(ctx, runtime, id),
		validateStack: (stack) => validatePromptStack(stack),
		previewStack: (id, stack) => {
			const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
			if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
			const diagnostics = validatePromptStack(stack);
			const preview = runtime.buildPreview({ stack, filePath: target.filePath, diagnostics });
			return { ok: true, text: preview.text, preview: preview.preview, diagnostics: preview.diagnostics };
		},
		getPayload: () => runtime.getPayload(),
		armPayload: (savePath) => runtime.armPayload(savePath),
		clearPayload: () => runtime.clearPayload(),
		activateStack: (id) => {
			if (!runtime.setActive(id)) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
		disableStacks: () => {
			runtime.setActive("none");
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
		reloadStacks: () => {
			runtime.reloadStacks(runtime.getSelectedActiveId());
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
	};
}

export function stackSummary(loaded: LoadedPromptStack, active: LoadedPromptStack | undefined): WebEditorStackSummary {
	const errors = loaded.diagnostics.filter((d) => d.level === "error").length;
	const warnings = loaded.diagnostics.filter((d) => d.level === "warning").length;
	return {
		id: loaded.stack.id,
		name: loaded.stack.name,
		filePath: loaded.filePath,
		active: loaded === active,
		autoActivate: loaded.stack.autoActivate,
		mode: loaded.stack.mode ?? "replace",
		itemCount: loaded.stack.items.length,
		errors,
		warnings,
		diagnostics: loaded.diagnostics,
	};
}

export function stackSummaries(stacks: LoadedPromptStack[], active: LoadedPromptStack | undefined): WebEditorStackSummary[] {
	return stacks.map((loaded) => stackSummary(loaded, active));
}

export function loadWebEditorSettings(ctx: ExtensionCommandContext): { preferredPort?: number; configPath: string; warnings: string[] } {
	const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
	if (!ctx.isProjectTrusted() || !existsSync(configPath)) {
		return { configPath, warnings: [] };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		return {
			configPath,
			warnings: [`pi-forge: failed to read ${configPath}; using an available editor port. ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	if (!isPlainObject(raw)) {
		return {
			configPath,
			warnings: [`pi-forge: ${configPath} must be a JSON object; using an available editor port.`],
		};
	}

	const webEditorConfig = isPlainObject(raw.webEditor) ? raw.webEditor : undefined;
	const rawPort = webEditorConfig?.port ?? raw.webEditorPort;
	if (rawPort === undefined) return { configPath, warnings: [] };

	if (typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) {
		return { preferredPort: rawPort, configPath, warnings: [] };
	}

	return {
		configPath,
		warnings: [`pi-forge: ${configPath} webEditor.port must be an integer from 1 to 65535; using an available editor port.`],
	};
}

function saveStackFile(
	ctx: ExtensionCommandContext,
	runtime: WebHostRuntime,
	id: string,
	stack: PromptStack,
): WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to save prompt stacks." };
	}

	const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
	if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
	if (!isInsidePromptStackStorage(ctx.cwd, target.filePath)) {
		return { ok: false, status: 403, error: "Refusing to save outside prompt-stack storage." };
	}

	writeFileSync(target.filePath, `${JSON.stringify(stack, null, 2)}\n`, "utf8");
	const preferredId = runtime.getActive()?.stack.id === id ? stack.id : runtime.getSelectedActiveId();
	runtime.reloadStacks(preferredId);
	const saved = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id) ?? runtime.getStacks().find((candidate) => candidate.filePath === target.filePath);
	if (!saved) return { ok: false, status: 500, error: "Saved stack could not be reloaded." };
	return { ok: true, stack: stackSummary(saved, runtime.getActive()), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

function createStackFile(
	ctx: ExtensionCommandContext,
	runtime: WebHostRuntime,
	stack: PromptStack,
	options: WebEditorCreateStackOptions,
): WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to create prompt stacks." };
	}

	const idError = validateWebStackId(stack.id);
	if (idError) return { ok: false, status: 400, error: idError };

	const existingById = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id);
	if (existingById && !options.overwrite) {
		return { ok: false, status: 409, error: `Prompt stack already exists: ${stack.id}` };
	}

	const targetPath = existingById && options.overwrite ? existingById.filePath : promptStackPath(ctx.cwd, stack.id);
	if (!isInsidePromptStackStorage(ctx.cwd, targetPath)) {
		return { ok: false, status: 403, error: "Refusing to create outside prompt-stack storage." };
	}

	if (!existingById && existsSync(targetPath) && !options.overwrite) {
		return { ok: false, status: 409, error: `Prompt stack already exists: ${stack.id}` };
	}

	const previousSelection = runtime.getSelectedActiveId();
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(stack, null, 2)}\n`, "utf8");
	runtime.reloadStacks(options.activate ? stack.id : (previousSelection ?? "none"));
	if (options.activate) runtime.setActive(stack.id);

	const created = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id);
	if (!created) return { ok: false, status: 500, error: "Created stack could not be reloaded." };
	return { ok: true, stack: stackSummary(created, runtime.getActive()), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

function deleteStackFile(
	ctx: ExtensionCommandContext,
	runtime: WebHostRuntime,
	id: string,
): WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to delete prompt stacks." };
	}

	const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
	if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
	if (!isInsidePromptStackStorage(ctx.cwd, target.filePath)) {
		return { ok: false, status: 403, error: "Refusing to delete outside prompt-stack storage." };
	}

	const wasActive = runtime.getActive()?.stack.id === id;
	unlinkSync(target.filePath);
	if (wasActive) {
		runtime.setActive("none");
		runtime.reloadStacks("none");
	} else {
		runtime.reloadStacks(runtime.getSelectedActiveId());
	}
	return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

function validateWebStackId(id: string): string | undefined {
	if (!id.trim()) return "Stack id must not be empty.";
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		return "Stack id may only contain letters, numbers, underscore, and dash.";
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
