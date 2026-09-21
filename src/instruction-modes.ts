import type { ResourceCatalog } from "./catalog.ts";
import {
	applyInstructionModeOverrides,
	isUsableInstructionMode,
	validateInstructionModeBinding,
	type InstructionMode,
	type InstructionModeBinding,
	type LoadedInstructionMode,
} from "./codecs/instruction-mode.ts";
import {
	formatResourceKey,
	isResourceScope,
	isValidResourceId,
	parseResourceSelector,
	type ResourceKey,
	type ResourceScope,
} from "./resource-identity.ts";

export const MAX_INSTRUCTION_MODE_BINDINGS = 256;

export interface ResolvedInstructionModeBinding {
	id: string;
	ref: ResourceKey;
	preset: ResourceKey;
	modelCallable: boolean;
	mode: InstructionMode;
}

export type ResolveInstructionModeResult =
	| { ok: true; loaded: LoadedInstructionMode }
	| { ok: false; error: string };

export type ResolveInstructionModeBindingsResult =
	| { ok: true; bindings: readonly ResolvedInstructionModeBinding[] }
	| { ok: false; error: string; index?: number };

/**
 * Resolve an instruction mode for direct browse/use from a catalog.
 * Bare selector uses project-over-global shadowing. Exact selector targets specific scope.
 * Ambiguity or unusable shadowed modes fail closed without global fallback.
 */
export function resolveInstructionMode(
	catalog: ResourceCatalog<LoadedInstructionMode>,
	selector: string,
): ResolveInstructionModeResult {
	if (!catalog || !Array.isArray(catalog.all)) return { ok: false, error: "Invalid resource catalog." };
	if (typeof selector !== "string") return { ok: false, error: "Instruction mode selector must be a string." };
	const parsed = parseResourceSelector(selector);
	if (!parsed.ok) return { ok: false, error: parsed.error };

	const { scope, id } = parsed.selector;
	const checkScope = (targetScope: ResourceScope): ResolveInstructionModeResult | null => {
		const matches = catalog.all.filter((m) => m.key.scope === targetScope && m.key.id === id);
		if (matches.length > 1) {
			return { ok: false, error: `Ambiguous instruction mode "${targetScope}:${id}": multiple definitions found.` };
		}
		if (matches.length === 1) {
			const loaded = matches[0];
			if (!isUsableInstructionMode(loaded)) {
				const detail = loaded.diagnostics.find((d) => d.level === "error")?.message ?? "Instruction mode has errors.";
				return { ok: false, error: `Instruction mode "${targetScope}:${id}" has errors: ${detail}` };
			}
			return { ok: true, loaded: deepFreeze(cloneLoadedInstructionMode(loaded)) };
		}
		return null;
	};

	if (scope) {
		const res = checkScope(scope);
		return res ?? { ok: false, error: `Instruction mode "${formatResourceKey({ scope, id })}" not found.` };
	}

	return checkScope("project") ?? checkScope("global") ?? { ok: false, error: `Instruction mode "${id}" not found.` };
}

/**
 * Resolve instruction mode bindings for a prompt stack preset.
 * Bare refs strictly inherit preset scope. Global presets cannot bind project modes.
 * Validates preset key, binding schemas, and duplicate effective IDs before resolving.
 */
export function resolveInstructionModeBindings(
	catalog: ResourceCatalog<LoadedInstructionMode>,
	preset: ResourceKey,
	bindings: readonly InstructionModeBinding[],
): ResolveInstructionModeBindingsResult {
	if (!isPlainObject(preset)) return { ok: false, error: "Preset key must be a plain object." };
	const presetKeys = Object.keys(preset);
	if (presetKeys.length !== 2 || !("scope" in preset) || !("id" in preset)) {
		return { ok: false, error: "Preset key must only contain scope and id." };
	}
	if (!isResourceScope(preset.scope)) {
		return { ok: false, error: 'Invalid preset scope. Expected "global" or "project".' };
	}
	if (typeof preset.id !== "string" || !isValidResourceId(preset.id)) {
		return { ok: false, error: "Invalid preset id; expected the resource ID grammar." };
	}
	if (bindings === null || bindings === undefined || !Array.isArray(bindings)) {
		return { ok: false, error: "Bindings must be an array." };
	}
	if (bindings.length > MAX_INSTRUCTION_MODE_BINDINGS) {
		return {
			ok: false,
			error: `Exceeded maximum bindings limit of ${MAX_INSTRUCTION_MODE_BINDINGS} (got ${bindings.length}).`,
		};
	}
	if (!catalog || !Array.isArray(catalog.all)) return { ok: false, error: "Invalid resource catalog." };

	// 1. Validate each binding schema
	for (let i = 0; i < bindings.length; i++) {
		const diags = validateInstructionModeBinding(bindings[i], preset.scope);
		const err = diags.find((d) => d.level === "error");
		if (err) return { ok: false, error: err.message, index: i };
	}

	// 2. Check duplicate effective binding IDs
	const seenIds = new Set<string>();
	for (let i = 0; i < bindings.length; i++) {
		const b = bindings[i];
		const parsed = parseResourceSelector(b.ref);
		const effectiveId = b.id ?? (parsed.ok ? parsed.selector.id : "");
		if (seenIds.has(effectiveId)) {
			return { ok: false, error: `Duplicate binding id "${effectiveId}" at index ${i}.`, index: i };
		}
		seenIds.add(effectiveId);
	}

	// 3. Resolve resources and apply overrides via direct exact resolve
	const resolvedList: ResolvedInstructionModeBinding[] = [];
	for (let i = 0; i < bindings.length; i++) {
		const b = bindings[i];
		const parsed = parseResourceSelector(b.ref);
		const targetScope: ResourceScope = parsed.ok && parsed.selector.scope ? parsed.selector.scope : preset.scope;
		const targetId = parsed.ok ? parsed.selector.id : "";
		const qualifiedTarget = formatResourceKey({ scope: targetScope, id: targetId });
		const effectiveId = b.id ?? targetId;

		const directResolve = resolveInstructionMode(catalog, qualifiedTarget);
		if (!directResolve.ok) {
			return { ok: false, error: directResolve.error, index: i };
		}
		const loaded = directResolve.loaded;

		const overrideResult = applyInstructionModeOverrides(loaded.mode, b.overrides);
		if (!overrideResult.ok) {
			const detail = overrideResult.diagnostics.find((d) => d.level === "error")?.message ?? "Failed to apply overrides.";
			return { ok: false, error: `Failed to apply overrides to "${effectiveId}": ${detail}`, index: i };
		}

		const resolved: ResolvedInstructionModeBinding = {
			id: effectiveId,
			ref: { scope: targetScope, id: targetId },
			preset: { scope: preset.scope, id: preset.id },
			modelCallable: b.modelCallable === true,
			mode: cloneInstructionMode(overrideResult.mode),
		};
		deepFreeze(resolved);
		resolvedList.push(resolved);
	}

	return { ok: true, bindings: Object.freeze(resolvedList) };
}

function cloneLoadedInstructionMode(loaded: LoadedInstructionMode): LoadedInstructionMode {
	return {
		filePath: loaded.filePath,
		scope: loaded.scope,
		key: { scope: loaded.key.scope, id: loaded.key.id },
		mode: cloneInstructionMode(loaded.mode),
		diagnostics: loaded.diagnostics.map((d) => ({ ...d })),
	};
}

function cloneInstructionMode(mode: InstructionMode): InstructionMode {
	return {
		schemaVersion: mode.schemaVersion,
		type: mode.type,
		id: mode.id,
		...(mode.name !== undefined ? { name: mode.name } : {}),
		...(mode.description !== undefined ? { description: mode.description } : {}),
		content: mode.content,
		tools: {
			add: [...mode.tools.add],
			remove: [...mode.tools.remove],
		},
	};
}

function deepFreeze<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Object.isFrozen(obj)) return obj;
	for (const key of Object.keys(obj as object)) {
		const val = (obj as Record<string, unknown>)[key];
		if (val !== null && typeof val === "object") {
			deepFreeze(val);
		}
	}
	return Object.freeze(obj);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
