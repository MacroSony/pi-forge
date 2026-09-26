import { type ResourceKey, type ResourceScope } from "../resource-identity.ts";
export declare const CAPABILITY_TYPE: "pi-forge.capability";
export declare const MAX_CONTENT_LENGTH = 100000;
export declare const MAX_TOOL_ARRAY_LENGTH = 256;
export declare const MAX_TOOL_NAME_LENGTH = 128;
export declare const MAX_CAPABILITY_NAME_LENGTH = 1000;
export interface CapabilityToolPatch {
    add: string[];
    remove: string[];
}
export interface Capability {
    schemaVersion: 1;
    type: typeof CAPABILITY_TYPE;
    id: string;
    name?: string;
    description?: string;
    content: string;
    tools: CapabilityToolPatch;
}
export interface CapabilityOverrides {
    content?: string;
    appendContent?: string;
    tools?: {
        add?: string[];
        remove?: string[];
    };
}
export interface CapabilityBinding {
    ref: string;
    id?: string;
    modelCallable?: boolean;
    overrides?: CapabilityOverrides;
}
export type DiagnosticLevel = "error" | "warning" | "info";
export interface Diagnostic {
    level: DiagnosticLevel;
    message: string;
    field?: string;
}
export interface LoadedCapability {
    /** Raw source revision from the same bytes as capability; never persisted into the resource. */
    sourceRevision?: string;
    capability: Capability;
    filePath: string;
    scope: ResourceScope;
    key: ResourceKey;
    diagnostics: Diagnostic[];
}
/** Check if tool name is non-empty, contains no whitespace/control/wildcards, and is <= 128 chars. */
export declare function isValidToolName(name: string): boolean;
/** Check if loaded capability has no error diagnostics. */
export declare function isUsableCapability(loaded: LoadedCapability): boolean;
/** Build a fail-closed LoadedCapability when reading or parsing fails. */
export declare function createCapabilityFault(filePath: string, scope: ResourceScope, message: string): LoadedCapability;
/** Single canonical serializer for capabilities. */
export declare function serializeCapability(capability: Capability): string;
/** Parse, normalize, and validate a capability from serialized JSON text. */
export declare function parseCapability(source: string, filePath: string, scope: ResourceScope): LoadedCapability;
/** Validate a capability or raw candidate object. */
export declare function validateCapability(capability: unknown): Diagnostic[];
/** Validate a capability binding against scope and reference rules. */
export declare function validateCapabilityBinding(raw: unknown, ownerScope: ResourceScope): Diagnostic[];
/** Apply limited capability overrides immutably. Fails closed if the base capability is invalid. */
export declare function applyCapabilityOverrides(capability: Capability, overrides?: CapabilityOverrides): {
    ok: true;
    capability: Capability;
} | {
    ok: false;
    diagnostics: Diagnostic[];
};
//# sourceMappingURL=capability.d.ts.map