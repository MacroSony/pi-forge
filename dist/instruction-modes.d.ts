import type { ResourceCatalog } from "./catalog.ts";
import { type InstructionMode, type InstructionModeBinding, type LoadedInstructionMode } from "./codecs/instruction-mode.ts";
import { type ResourceKey } from "./resource-identity.ts";
export declare const MAX_INSTRUCTION_MODE_BINDINGS = 256;
export interface ResolvedInstructionModeBinding {
    id: string;
    ref: ResourceKey;
    preset: ResourceKey;
    modelCallable: boolean;
    mode: InstructionMode;
}
export type ResolveInstructionModeResult = {
    ok: true;
    loaded: LoadedInstructionMode;
} | {
    ok: false;
    error: string;
};
export type ResolveInstructionModeBindingsResult = {
    ok: true;
    bindings: readonly ResolvedInstructionModeBinding[];
} | {
    ok: false;
    error: string;
    index?: number;
};
/**
 * Resolve an instruction mode for direct browse/use from a catalog.
 * Bare selector uses project-over-global shadowing. Exact selector targets specific scope.
 * Ambiguity or unusable shadowed modes fail closed without global fallback.
 */
export declare function resolveInstructionMode(catalog: ResourceCatalog<LoadedInstructionMode>, selector: string): ResolveInstructionModeResult;
/**
 * Resolve instruction mode bindings for a prompt stack preset.
 * Bare refs strictly inherit preset scope. Global presets cannot bind project modes.
 * Validates preset key, binding schemas, and duplicate effective IDs before resolving.
 */
export declare function resolveInstructionModeBindings(catalog: ResourceCatalog<LoadedInstructionMode>, preset: ResourceKey, bindings: readonly InstructionModeBinding[]): ResolveInstructionModeBindingsResult;
//# sourceMappingURL=instruction-modes.d.ts.map