import { type Capability, type LoadedCapability } from "../codecs/capability.ts";
import { type ResourceScope } from "../resource-identity.ts";
export { type Capability, type LoadedCapability };
export type CapabilityMutationResult = {
    ok: true;
} | {
    ok: false;
    reason: "invalid-path" | "invalid-capability" | "conflict" | "io-error";
    error: string;
};
export type CapabilityWriteResult = CapabilityMutationResult;
export type CapabilityDeleteResult = CapabilityMutationResult;
export declare const MAX_CAPABILITY_SOURCE_SIZE: number;
export declare function globalCapabilitiesDir(): string;
export declare function capabilitiesDir(cwd: string): string;
/**
 * Read global capabilities.
 * Returns empty array if directory does not exist (ENOENT).
 * Throws on real directory read errors (e.g. permission denied) to fail closed.
 */
export declare function readGlobalCapabilities(globalDir?: string): LoadedCapability[];
/**
 * Read scoped capabilities (global and project).
 * Returns empty array for missing directory (ENOENT); throws on real directory read errors.
 * Preserves faults for shadowed resolution and attaches errors to same-scope duplicate IDs.
 */
export declare function readCapabilitiesScoped(cwd: string, globalDir?: string): LoadedCapability[];
/**
 * Read a single capability file.
 * Returns a LoadedCapability fault if reading or parsing fails, or if file exceeds 1MiB.
 */
export declare function readSingleCapabilityFile(filePath: string, scope?: ResourceScope): LoadedCapability;
/**
 * Compute the sha256 revision hash of raw capability file bytes.
 * Throws ENOENT if missing or an Error if size exceeds 1MiB limit.
 */
export declare function capabilityRevision(filePath: string): string;
/**
 * Write a capability file.
 * Creates exclusively with "wx" when overwrite is false.
 * Updates atomically with expectedSourceRevision check when overwrite is true.
 */
export declare function writeCapabilityFile(cwd: string, scope: ResourceScope, filePath: string, capability: Capability, options: {
    overwrite: boolean;
    expectedSourceRevision?: string;
}): CapabilityWriteResult;
/**
 * Delete a capability file with expectedSourceRevision check.
 */
export declare function deleteCapabilityFile(cwd: string, scope: ResourceScope, filePath: string, options: {
    expectedSourceRevision: string;
}): CapabilityDeleteResult;
//# sourceMappingURL=capability.d.ts.map