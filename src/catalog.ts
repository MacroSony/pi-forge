import type { ResourceKey, ResourceScope, ResourceSelector } from "./resource-identity.ts";

export interface ScopedResource {
	key: ResourceKey;
}

export interface ResourceCatalog<T extends ScopedResource> {
	/** Every loaded scoped definition, including shadowed resources. */
	all: T[];
	/** One resource per unqualified ID after project-over-global shadowing. */
	effective: T[];
	resolveExact(key: ResourceKey): T | undefined;
	resolveExact(scope: ResourceScope, id: string): T | undefined;
	resolveEffective(id: string): T | undefined;
	resolveSelector(selector: ResourceSelector): T | undefined;
}

export function createResourceCatalog<T extends ScopedResource>(all: T[]): ResourceCatalog<T> {
	const effective = computeEffectiveView(all);

	function resolveExact(key: ResourceKey): T | undefined;
	function resolveExact(scope: ResourceScope, id: string): T | undefined;
	function resolveExact(scopeOrKey: ResourceScope | ResourceKey, maybeId?: string): T | undefined {
		const scope = typeof scopeOrKey === "string" ? scopeOrKey : scopeOrKey.scope;
		const id = typeof scopeOrKey === "string" ? maybeId! : scopeOrKey.id;
		const matches = all.filter((item) => item.key.scope === scope && item.key.id === id);
		return matches.length === 1 ? matches[0] : undefined;
	}

	function resolveEffective(id: string): T | undefined {
		return resolveEffectiveResource(all, id);
	}

	function resolveSelector(selector: ResourceSelector): T | undefined {
		if (selector.scope) return resolveExact(selector.scope, selector.id);
		return resolveEffective(selector.id);
	}

	return { all, effective, resolveExact, resolveEffective, resolveSelector };
}

export function computeEffectiveView<T extends ScopedResource>(all: T[]): T[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const item of all) {
		if (seen.has(item.key.id)) continue;
		seen.add(item.key.id);
		ids.push(item.key.id);
	}
	return ids
		.map((id) => resolveEffectiveResource(all, id))
		.filter((item): item is T => item !== undefined);
}

/**
 * Project-over-global effective resolution. A project definition shadows a
 * same-ID global definition even when the project definition is invalid; an
 * ambiguous project scope (duplicate IDs) fails closed instead of falling
 * back to the global resource.
 */
export function resolveEffectiveResource<T extends ScopedResource>(all: readonly T[], id: string): T | undefined {
	const projectMatches = all.filter((item) => item.key.id === id && item.key.scope === "project");
	if (projectMatches.length === 1) return projectMatches[0];
	if (projectMatches.length > 1) return undefined;
	const globalMatches = all.filter((item) => item.key.id === id && item.key.scope === "global");
	return globalMatches.length === 1 ? globalMatches[0] : undefined;
}

export function resolveExactResource<T extends ScopedResource>(all: readonly T[], key: ResourceKey): T | undefined {
	const matches = all.filter((item) => item.key.scope === key.scope && item.key.id === key.id);
	return matches.length === 1 ? matches[0] : undefined;
}

export function resolveResourceSelector<T extends ScopedResource>(all: readonly T[], selector: ResourceSelector): T | undefined {
	if (selector.scope) return resolveExactResource(all, { scope: selector.scope, id: selector.id });
	return resolveEffectiveResource(all, selector.id);
}

export function scopedResourceId(key: ResourceKey): string {
	return `${key.scope}:${key.id}`;
}
