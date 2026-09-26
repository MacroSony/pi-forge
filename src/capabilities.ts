import type { ResourceCatalog } from "./catalog.ts";
import {
	applyCapabilityOverrides,
	isUsableCapability,
	validateCapabilityBinding,
	type Capability,
	type CapabilityBinding,
	type LoadedCapability,
} from "./codecs/capability.ts";
import {
	formatResourceKey,
	isResourceScope,
	isValidResourceId,
	parseResourceSelector,
	type ResourceKey,
	type ResourceScope,
} from "./resource-identity.ts";

export const MAX_CAPABILITY_BINDINGS = 256;

export interface ResolvedCapabilityBinding {
	id: string;
	ref: ResourceKey;
	preset: ResourceKey;
	modelCallable: boolean;
	capability: Capability;
}

export type ResolveCapabilityResult =
	| { ok: true; loaded: LoadedCapability }
	| { ok: false; error: string };

export type ResolveCapabilityBindingsResult =
	| { ok: true; bindings: readonly ResolvedCapabilityBinding[] }
	| { ok: false; error: string; index?: number };

/**
 * Resolve a capability for direct browse/enable from a catalog.
 * Bare selector uses project-over-global shadowing. Exact selector targets specific scope.
 * Ambiguity or unusable shadowed capabilities fail closed without global fallback.
 */
export function resolveCapability(
	catalog: ResourceCatalog<LoadedCapability>,
	selector: string,
): ResolveCapabilityResult {
	if (!catalog || !Array.isArray(catalog.all)) return { ok: false, error: "Invalid resource catalog." };
	if (typeof selector !== "string") return { ok: false, error: "Capability capability selector must be a string." };
	const parsed = parseResourceSelector(selector);
	if (!parsed.ok) return { ok: false, error: parsed.error };

	const { scope, id } = parsed.selector;
	const checkScope = (targetScope: ResourceScope): ResolveCapabilityResult | null => {
		const matches = catalog.all.filter((m) => m.key.scope === targetScope && m.key.id === id);
		if (matches.length > 1) {
			return { ok: false, error: `Ambiguous capability "${targetScope}:${id}": multiple definitions found.` };
		}
		if (matches.length === 1) {
			const loaded = matches[0];
			if (!isUsableCapability(loaded)) {
				const detail = loaded.diagnostics.find((d) => d.level === "error")?.message ?? "Capability capability has errors.";
				return { ok: false, error: `Capability capability "${targetScope}:${id}" has errors: ${detail}` };
			}
			return { ok: true, loaded: deepFreeze(cloneLoadedCapability(loaded)) };
		}
		return null;
	};

	if (scope) {
		const res = checkScope(scope);
		return res ?? { ok: false, error: `Capability capability "${formatResourceKey({ scope, id })}" not found.` };
	}

	return checkScope("project") ?? checkScope("global") ?? { ok: false, error: `Capability capability "${id}" not found.` };
}

/**
 * Resolve capability bindings for a prompt stack preset.
 * Bare refs strictly inherit preset scope. Global presets cannot bind project capabilities.
 * Validates preset key, binding schemas, and duplicate effective IDs before resolving.
 */
export function resolveCapabilityBindings(
	catalog: ResourceCatalog<LoadedCapability>,
	preset: ResourceKey,
	bindings: readonly CapabilityBinding[],
): ResolveCapabilityBindingsResult {
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
	if (bindings.length > MAX_CAPABILITY_BINDINGS) {
		return {
			ok: false,
			error: `Exceeded maximum bindings limit of ${MAX_CAPABILITY_BINDINGS} (got ${bindings.length}).`,
		};
	}
	if (!catalog || !Array.isArray(catalog.all)) return { ok: false, error: "Invalid resource catalog." };

	// 1. Validate each binding schema
	for (let i = 0; i < bindings.length; i++) {
		const diags = validateCapabilityBinding(bindings[i], preset.scope);
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
	const resolvedList: ResolvedCapabilityBinding[] = [];
	for (let i = 0; i < bindings.length; i++) {
		const b = bindings[i];
		const parsed = parseResourceSelector(b.ref);
		const targetScope: ResourceScope = parsed.ok && parsed.selector.scope ? parsed.selector.scope : preset.scope;
		const targetId = parsed.ok ? parsed.selector.id : "";
		const qualifiedTarget = formatResourceKey({ scope: targetScope, id: targetId });
		const effectiveId = b.id ?? targetId;

		const directResolve = resolveCapability(catalog, qualifiedTarget);
		if (!directResolve.ok) {
			return { ok: false, error: directResolve.error, index: i };
		}
		const loaded = directResolve.loaded;

		const overrideResult = applyCapabilityOverrides(loaded.capability, b.overrides);
		if (!overrideResult.ok) {
			const detail = overrideResult.diagnostics.find((d) => d.level === "error")?.message ?? "Failed to apply overrides.";
			return { ok: false, error: `Failed to apply overrides to "${effectiveId}": ${detail}`, index: i };
		}

		const resolved: ResolvedCapabilityBinding = {
			id: effectiveId,
			ref: { scope: targetScope, id: targetId },
			preset: { scope: preset.scope, id: preset.id },
			modelCallable: b.modelCallable === true,
			capability: cloneCapability(overrideResult.capability),
		};
		deepFreeze(resolved);
		resolvedList.push(resolved);
	}

	return { ok: true, bindings: Object.freeze(resolvedList) };
}

function cloneLoadedCapability(loaded: LoadedCapability): LoadedCapability {
	return {
		filePath: loaded.filePath,
		scope: loaded.scope,
		key: { scope: loaded.key.scope, id: loaded.key.id },
		capability: cloneCapability(loaded.capability),
		diagnostics: loaded.diagnostics.map((d) => ({ ...d })),
	};
}

function cloneCapability(capability: Capability): Capability {
	return {
		schemaVersion: capability.schemaVersion,
		type: capability.type,
		id: capability.id,
		...(capability.name !== undefined ? { name: capability.name } : {}),
		...(capability.description !== undefined ? { description: capability.description } : {}),
		content: capability.content,
		tools: {
			add: [...capability.tools.add],
			remove: [...capability.tools.remove],
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
