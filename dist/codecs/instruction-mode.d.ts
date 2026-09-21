import { type ResourceKey, type ResourceScope } from "../resource-identity.ts";
export declare const INSTRUCTION_MODE_TYPE: "pi-forge.instruction-mode";
export declare const MAX_CONTENT_LENGTH = 100000;
export declare const MAX_TOOL_ARRAY_LENGTH = 256;
export declare const MAX_TOOL_NAME_LENGTH = 128;
export declare const MAX_MODE_NAME_LENGTH = 1000;
export interface InstructionToolPatch {
    add: string[];
    remove: string[];
}
export interface InstructionMode {
    schemaVersion: 1;
    type: typeof INSTRUCTION_MODE_TYPE;
    id: string;
    name?: string;
    description?: string;
    content: string;
    tools: InstructionToolPatch;
}
export interface InstructionModeOverrides {
    content?: string;
    appendContent?: string;
    tools?: {
        add?: string[];
        remove?: string[];
    };
}
export interface InstructionModeBinding {
    ref: string;
    id?: string;
    modelCallable?: boolean;
    overrides?: InstructionModeOverrides;
}
export type DiagnosticLevel = "error" | "warning" | "info";
export interface Diagnostic {
    level: DiagnosticLevel;
    message: string;
    field?: string;
}
export interface LoadedInstructionMode {
    /** Raw source revision from the same bytes as mode; never persisted into the resource. */
    sourceRevision?: string;
    mode: InstructionMode;
    filePath: string;
    scope: ResourceScope;
    key: ResourceKey;
    diagnostics: Diagnostic[];
}
/** Check if tool name is non-empty, contains no whitespace/control/wildcards, and is <= 128 chars. */
export declare function isValidToolName(name: string): boolean;
/** Check if loaded instruction mode has no error diagnostics. */
export declare function isUsableInstructionMode(loaded: LoadedInstructionMode): boolean;
/** Build a fail-closed LoadedInstructionMode when reading or parsing fails. */
export declare function createInstructionModeFault(filePath: string, scope: ResourceScope, message: string): LoadedInstructionMode;
/** Single canonical serializer for instruction modes. */
export declare function serializeInstructionMode(mode: InstructionMode): string;
/** Parse, normalize, and validate an instruction mode from serialized JSON text. */
export declare function parseInstructionMode(source: string, filePath: string, scope: ResourceScope): LoadedInstructionMode;
/** Validate an instruction mode or raw candidate object. */
export declare function validateInstructionMode(mode: unknown): Diagnostic[];
/** Validate an instruction mode binding against scope and reference rules. */
export declare function validateInstructionModeBinding(raw: unknown, ownerScope: ResourceScope): Diagnostic[];
/** Apply limited instruction mode overrides immutably. Fails closed if base mode is invalid. */
export declare function applyInstructionModeOverrides(mode: InstructionMode, overrides?: InstructionModeOverrides): {
    ok: true;
    mode: InstructionMode;
} | {
    ok: false;
    diagnostics: Diagnostic[];
};
//# sourceMappingURL=instruction-mode.d.ts.map