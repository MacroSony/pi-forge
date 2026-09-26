import { MAX_CAPABILITY_NAME_LENGTH, type CapabilityToolPatch } from "./codecs/capability.ts";
import { type ResourceKey } from "./resource-identity.ts";
export declare const CAPABILITY_SNAPSHOT_TYPE: "pi-forge.capability-snapshot";
export declare const FINGERPRINT_PATTERN: RegExp;
export declare const MAX_ID_LENGTH = 128;
export { MAX_CAPABILITY_NAME_LENGTH };
export declare const MAX_NAME_LENGTH = 1000;
export type CapabilitySource = {
    kind: "manual";
} | {
    kind: "capability";
    key: ResourceKey;
    binding?: {
        preset: ResourceKey;
        id: string;
    };
};
export interface CapabilitySnapshot {
    activationId: string;
    source: CapabilitySource;
    name?: string;
    content: string;
    tools: CapabilityToolPatch;
    fingerprint: string;
}
export interface CapabilityActivateEvent {
    schemaVersion: 1;
    eventId: string;
    op: "activate";
    actor: "user" | "agent";
    createdAt: number;
    snapshot: CapabilitySnapshot;
}
export interface CapabilityDeactivateEvent {
    schemaVersion: 1;
    eventId: string;
    op: "deactivate";
    actor: "user" | "agent" | "lifecycle";
    createdAt: number;
    activationId: string;
}
export interface CapabilityResetEvent {
    schemaVersion: 1;
    eventId: string;
    op: "reset";
    actor: "user";
    createdAt: number;
}
export type CapabilityEvent = CapabilityActivateEvent | CapabilityDeactivateEvent | CapabilityResetEvent;
export interface ActiveCapability {
    snapshot: CapabilitySnapshot;
    actor: "user" | "agent";
    eventId: string;
    createdAt: number;
}
export declare function createCapabilitySnapshot(input: Omit<CapabilitySnapshot, "fingerprint">): CapabilitySnapshot;
export declare function decodeCapabilityEvent(raw: unknown): {
    ok: true;
    event: CapabilityEvent;
} | {
    ok: false;
    error: string;
};
/**
 * Reduce an ordered event stream into active capability states.
 * Note: Current reducer only validates event shape and historical actor ownership.
 * It does not validate current Preset.modelCallable, registered tools, or top-level policy;
 * these are deferred to downstream services, and complete authorization checking is not claimed here.
 */
export declare function reduceCapabilityEvents(events: readonly unknown[]): {
    ok: true;
    active: readonly ActiveCapability[];
    lastEventId?: string;
} | {
    ok: false;
    index: number;
    error: string;
};
//# sourceMappingURL=capability-events.d.ts.map