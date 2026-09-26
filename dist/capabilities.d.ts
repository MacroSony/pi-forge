import type { ResourceCatalog } from "./catalog.ts";
import { type Capability, type CapabilityBinding, type LoadedCapability } from "./codecs/capability.ts";
import { type ResourceKey } from "./resource-identity.ts";
export declare const MAX_CAPABILITY_BINDINGS = 256;
export interface ResolvedCapabilityBinding {
    id: string;
    ref: ResourceKey;
    preset: ResourceKey;
    modelCallable: boolean;
    capability: Capability;
}
export type ResolveCapabilityResult = {
    ok: true;
    loaded: LoadedCapability;
} | {
    ok: false;
    error: string;
};
export type ResolveCapabilityBindingsResult = {
    ok: true;
    bindings: readonly ResolvedCapabilityBinding[];
} | {
    ok: false;
    error: string;
    index?: number;
};
/**
 * Resolve a capability for direct browse/enable from a catalog.
 * Bare selector uses project-over-global shadowing. Exact selector targets specific scope.
 * Ambiguity or unusable shadowed capabilities fail closed without global fallback.
 */
export declare function resolveCapability(catalog: ResourceCatalog<LoadedCapability>, selector: string): ResolveCapabilityResult;
/**
 * Resolve capability bindings for a prompt stack preset.
 * Bare refs strictly inherit preset scope. Global presets cannot bind project capabilities.
 * Validates preset key, binding schemas, and duplicate effective IDs before resolving.
 */
export declare function resolveCapabilityBindings(catalog: ResourceCatalog<LoadedCapability>, preset: ResourceKey, bindings: readonly CapabilityBinding[]): ResolveCapabilityBindingsResult;
//# sourceMappingURL=capabilities.d.ts.map