import { MAX_MODE_NAME_LENGTH, type InstructionToolPatch } from "./codecs/instruction-mode.ts";
import { type ResourceKey } from "./resource-identity.ts";
export declare const INSTRUCTION_SNAPSHOT_TYPE: "pi-forge.instruction-snapshot";
export declare const FINGERPRINT_PATTERN: RegExp;
export declare const MAX_ID_LENGTH = 128;
export { MAX_MODE_NAME_LENGTH };
export declare const MAX_NAME_LENGTH = 1000;
export type InstructionSource = {
    kind: "manual";
} | {
    kind: "mode";
    key: ResourceKey;
    binding?: {
        preset: ResourceKey;
        id: string;
    };
};
export interface InstructionSnapshot {
    activationId: string;
    source: InstructionSource;
    name?: string;
    content: string;
    tools: InstructionToolPatch;
    fingerprint: string;
}
export interface InstructionActivateEvent {
    schemaVersion: 1;
    eventId: string;
    op: "activate";
    actor: "user" | "agent";
    createdAt: number;
    snapshot: InstructionSnapshot;
}
export interface InstructionDeactivateEvent {
    schemaVersion: 1;
    eventId: string;
    op: "deactivate";
    actor: "user" | "agent" | "lifecycle";
    createdAt: number;
    activationId: string;
}
export interface InstructionResetEvent {
    schemaVersion: 1;
    eventId: string;
    op: "reset";
    actor: "user";
    createdAt: number;
}
export type InstructionEvent = InstructionActivateEvent | InstructionDeactivateEvent | InstructionResetEvent;
export interface ActiveInstruction {
    snapshot: InstructionSnapshot;
    actor: "user" | "agent";
    eventId: string;
    createdAt: number;
}
export declare function createInstructionSnapshot(input: Omit<InstructionSnapshot, "fingerprint">): InstructionSnapshot;
export declare function decodeInstructionEvent(raw: unknown): {
    ok: true;
    event: InstructionEvent;
} | {
    ok: false;
    error: string;
};
/**
 * Reduce an ordered event stream into active instruction states.
 * Note: Current reducer only validates event shape and historical actor ownership.
 * It does not validate current Preset.modelCallable, registered tools, or top-level policy;
 * these are deferred to downstream services, and complete authorization checking is not claimed here.
 */
export declare function reduceInstructionEvents(events: readonly unknown[]): {
    ok: true;
    active: readonly ActiveInstruction[];
    lastEventId?: string;
} | {
    ok: false;
    index: number;
    error: string;
};
//# sourceMappingURL=instruction-events.d.ts.map