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
export declare function createResourceCatalog<T extends ScopedResource>(all: T[]): ResourceCatalog<T>;
export declare function computeEffectiveView<T extends ScopedResource>(all: T[]): T[];
/**
 * Project-over-global effective resolution. A project definition shadows a
 * same-ID global definition even when the project definition is invalid; an
 * ambiguous project scope (duplicate IDs) fails closed instead of falling
 * back to the global resource.
 */
export declare function resolveEffectiveResource<T extends ScopedResource>(all: readonly T[], id: string): T | undefined;
export declare function resolveExactResource<T extends ScopedResource>(all: readonly T[], key: ResourceKey): T | undefined;
export declare function resolveResourceSelector<T extends ScopedResource>(all: readonly T[], selector: ResourceSelector): T | undefined;
export declare function scopedResourceId(key: ResourceKey): string;
//# sourceMappingURL=catalog.d.ts.map