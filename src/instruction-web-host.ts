import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { serializeInstructionMode, type InstructionMode, type InstructionModeBinding, type LoadedInstructionMode } from "./codecs/instruction-mode.ts";
import { createResourceCatalog } from "./catalog.ts";
import { resolveInstructionMode, resolveInstructionModeBindings } from "./instruction-modes.ts";
import { formatResourceKey, parseResourceSelector, isValidResourceId } from "./resource-identity.ts";
import { deleteInstructionModeFile, globalInstructionModesDir, instructionModesDir, writeInstructionModeFile } from "./repositories/instruction-mode.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorInstructionModeEntry, WebEditorModeOperation, WebEditorModeResult } from "./web-editor/types.ts";

export interface InstructionWebResources {
	readInstructionModes?(): readonly LoadedInstructionMode[];
	getStacks(): LoadedPromptStack[];
}

function objectWithKeys(input: unknown, keys: string[]): input is Record<string, unknown> {
	return !!input && typeof input === "object" && !Array.isArray(input)
		&& Object.keys(input).every(key => keys.includes(key));
}

/** Optional Web adapter; Workspace/repositories and the existing resolver retain ownership. */
export function instructionModeOperation(ctx: ExtensionContext, runtime: InstructionWebResources,
	action: WebEditorModeOperation, selector?: string, input?: unknown): WebEditorModeResult {
	try {
		const trusted = ctx.isProjectTrusted();
		if (!runtime.readInstructionModes) return { ok: false, status: 503, error: "Instruction mode resources unavailable." };
		if (["create", "save", "delete"].includes(action) && !trusted) return { ok: false, status: 403, error: "Project is not trusted; mode writes are disabled." };
		const modes = runtime.readInstructionModes().filter(mode => trusted || mode.scope === "global");
		const catalog = createResourceCatalog([...modes]);
		const entry = (loaded: LoadedInstructionMode): WebEditorInstructionModeEntry => {
			const sourceRevision = loaded.sourceRevision ?? "";
			return { selector: formatResourceKey(loaded.key), scope: loaded.scope, filePath: loaded.filePath,
				mode: loaded.mode, diagnostics: loaded.diagnostics, sourceRevision };
		};
		if (action === "list") return { ok: true, trusted, modes: modes.map(entry) };
		if (action === "effective") {
			if (!objectWithKeys(input, ["presetSelector", "bindings"]) || typeof input.presetSelector !== "string" || !Array.isArray(input.bindings)) {
				return { ok: false, status: 400, error: "Expected presetSelector and bindings." };
			}
			const preset = runtime.getStacks().filter(stack => formatResourceKey(stack.key) === input.presetSelector && (trusted || stack.scope === "global"));
			if (preset.length !== 1) return { ok: false, status: 404, error: "Unknown or ambiguous qualified Preset selector." };
			const resolved = resolveInstructionModeBindings(catalog, preset[0]!.key, input.bindings as InstructionModeBinding[]);
			if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
			return { ok: true, bindings: resolved.bindings.map(binding => {
				const source = resolveInstructionMode(catalog, formatResourceKey(binding.ref));
				if (!source.ok) throw new Error(source.error);
				return { id: binding.id, ref: formatResourceKey(binding.ref), modelCallable: binding.modelCallable,
					source: source.loaded.mode, effective: binding.mode };
			}) };
		}
		if (action === "create") {
			if (!objectWithKeys(input, ["scope", "mode"]) || (input.scope !== "global" && input.scope !== "project") || !input.mode || typeof input.mode !== "object") {
				return { ok: false, status: 400, error: "Expected explicit scope and mode." };
			}
			const mode = input.mode as InstructionMode;
			if (typeof mode.id !== "string" || !isValidResourceId(mode.id)) return { ok: false, status: 400, error: "Invalid mode ID." };
			if (modes.some(item => item.scope === input.scope && item.key.id === mode.id)) return { ok: false, status: 409, error: "Mode ID already exists in this scope." };
			const path = join(input.scope === "global" ? globalInstructionModesDir() : instructionModesDir(ctx.cwd), `${mode.id}.json`);
			const result = writeInstructionModeFile(ctx.cwd, input.scope, path, mode, { overwrite: false });
			if (!result.ok) return mutationFailure(result);
			runtime.readInstructionModes();
			return {
				ok: true,
				changed: formatResourceKey({scope: input.scope, id: mode.id}),
				sourceRevision: createHash("sha256").update(serializeInstructionMode(mode)).digest("hex"),
			};
		}
		const parsed = parseResourceSelector(selector ?? "");
		if (!parsed.ok || !parsed.selector.scope) return { ok: false, status: 400, error: "A qualified mode selector is required." };
		const matches = modes.filter(item => formatResourceKey(item.key) === selector);
		if (matches.length !== 1) return { ok: false, status: matches.length ? 409 : 404, error: "Unknown or ambiguous instruction mode." };
		const loaded = matches[0]!;
		if (action === "get") return { ok: true, ...entry(loaded) };
		if (!objectWithKeys(input, action === "delete" ? ["expectedSourceRevision"] : ["mode", "expectedSourceRevision"])
			|| typeof input.expectedSourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSourceRevision)) {
			return { ok: false, status: 400, error: "A valid expectedSourceRevision is required." };
		}
		if (action === "save" && (!input.mode || typeof input.mode !== "object" || (input.mode as InstructionMode).id !== loaded.mode.id)) {
			return { ok: false, status: 400, error: "Mode ID is immutable during save." };
		}
		const options = { overwrite: true, expectedSourceRevision: input.expectedSourceRevision };
		const result = action === "delete"
			? deleteInstructionModeFile(ctx.cwd, loaded.scope, loaded.filePath, options)
			: writeInstructionModeFile(ctx.cwd, loaded.scope, loaded.filePath, input.mode as InstructionMode, options);
		if (!result.ok) return mutationFailure(result);
		runtime.readInstructionModes();
		return {
			ok: true,
			changed: selector!,
			...(action === "save" ? {
				sourceRevision: createHash("sha256").update(serializeInstructionMode(input.mode as InstructionMode)).digest("hex"),
			} : {}),
		};
	} catch (error) {
		return { ok: false, status: 503, error: error instanceof Error ? error.message : "Instruction mode resources unavailable." };
	}
}

function mutationFailure(result: {reason: string; error: string}): WebEditorModeResult {
	return { ok: false, status: result.reason === "conflict" ? 409 : result.reason === "invalid-path" ? 403 : result.reason === "invalid-mode" ? 400 : 500, error: result.error };
}
