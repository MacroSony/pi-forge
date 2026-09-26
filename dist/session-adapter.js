import { isAgentProfileProvenance } from "./agent-profile.js";
import { decodeCapabilityEvent, reduceCapabilityEvents } from "./capability-events.js";
import { CAPABILITY_DELIVERY_TYPE, CAPABILITY_EVENT_ENTRY, CAPABILITY_TOOLS_ENTRY, } from "./capability-protocol.js";
import { validateCapabilityAnchorData } from "./capability-anchors.js";
export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
/**
 * Session persistence bookkeeping. This owns reading/writing pi-forge's custom
 * session entries so lifecycle, profile-service, and stack runtime do not each
 * reach into the session format.
 */
export function getCurrentBranchEntries(ctx) {
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === null)
        return [];
    const sessionManager = ctx.sessionManager;
    return sessionManager.getBranch ? sessionManager.getBranch(leafId ?? undefined) : sessionManager.getEntries();
}
export function getRestoredActiveId(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
            return typeof entry.data?.activeStackId === "string" ? entry.data.activeStackId : undefined;
        }
    }
    return undefined;
}
export function getRestoredProfileProvenance(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY_TYPE)
            continue;
        if (entry.data?.provenance === null)
            return undefined;
        return isAgentProfileProvenance(entry.data?.provenance) ? entry.data.provenance : undefined;
    }
    return undefined;
}
export function getLegacyVariableStateDiagnostic(ctx) {
    const entries = getCurrentBranchEntries(ctx);
    const hasLegacyVariableState = entries.some((entry) => {
        const candidate = entry;
        return candidate?.type === "custom" && candidate?.customType === "pi-forge-variable-state";
    });
    if (!hasLegacyVariableState)
        return [];
    return [{
            level: "info",
            message: "Legacy pi-forge-variable-state entries are ignored; mutable session variables were removed in 0.5.0.",
        }];
}
export function persistActiveSelection(pi, activeStackId) {
    pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId });
}
export function persistProfileProvenance(pi, provenance) {
    pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance });
}
/** Branch-local semantic history; compaction positions, not wall clocks, cut the checkpoint. */
export function readCapabilitySession(ctx) {
    const events = [];
    let checkpointThrough;
    let toolsData;
    let lastNewEventId;
    const seenEvents = new Set();
    const eventIndexMap = new Map();
    let lastAnchoredIndex = -1;
    for (const raw of getCurrentBranchEntries(ctx)) {
        if (!raw || typeof raw !== "object")
            continue;
        const entry = raw;
        if (entry.type === "compaction")
            checkpointThrough = lastNewEventId;
        if (entry.type === "custom") {
            if (entry.customType === "pi-forge-instruction-event" || entry.customType === "pi-forge-instruction-tools" || entry.customType === "pi-forge-instruction-delivery") {
                throw new Error("This session contains legacy pre-capability state. Start a new session; old capability state is not restored.");
            }
            if (entry.customType === CAPABILITY_EVENT_ENTRY) {
                const decoded = decodeCapabilityEvent(entry.data);
                if (!decoded.ok)
                    throw new Error(`Invalid Forge capability history: ${decoded.error}`);
                events.push(decoded.event);
                if (!seenEvents.has(decoded.event.eventId)) {
                    seenEvents.add(decoded.event.eventId);
                    lastNewEventId = decoded.event.eventId;
                    eventIndexMap.set(decoded.event.eventId, events.length - 1);
                }
            }
            else if (entry.customType === CAPABILITY_TOOLS_ENTRY) {
                toolsData = entry.data;
            }
            else if (entry.customType === CAPABILITY_DELIVERY_TYPE) {
                const anchorData = validateCapabilityAnchorData(entry.data);
                const cursorIndex = eventIndexMap.get(anchorData.throughEventId);
                if (cursorIndex === undefined) {
                    throw new Error(`Invalid Forge capability delivery anchor: unknown or future cursor "${anchorData.throughEventId}"`);
                }
                if (cursorIndex < lastAnchoredIndex) {
                    throw new Error(`Invalid Forge capability delivery anchor: out-of-order cursor "${anchorData.throughEventId}" (index ${cursorIndex} < ${lastAnchoredIndex})`);
                }
                lastAnchoredIndex = cursorIndex;
            }
        }
        else if (entry.type === "custom_message" && entry.customType === "pi-forge-instruction-delivery") {
            throw new Error("This session contains legacy pre-capability delivery state. Start a new session; old capability state is not restored.");
        }
        else if (entry.type === "custom_message" && entry.customType === CAPABILITY_DELIVERY_TYPE) {
            const details = entry.details;
            if (details && typeof details === "object" && "throughEventId" in details) {
                const cursorId = details.throughEventId;
                if (typeof cursorId === "string") {
                    const cursorIndex = eventIndexMap.get(cursorId);
                    if (cursorIndex !== undefined) {
                        if (cursorIndex >= lastAnchoredIndex) {
                            lastAnchoredIndex = cursorIndex;
                        }
                    }
                }
            }
        }
    }
    const reduced = reduceCapabilityEvents(events);
    if (!reduced.ok)
        throw new Error(`Invalid Forge capability event ${reduced.index}: ${reduced.error}`);
    return {
        events,
        checkpointThrough,
        lastAnchoredIndex,
        ...(toolsData === undefined ? {} : { tools: decodeCapabilityTools(toolsData) }),
    };
}
export function persistCapabilityDelivery(pi, throughEventId) {
    const data = {
        schemaVersion: 1,
        throughEventId,
    };
    validateCapabilityAnchorData(data);
    pi.appendEntry(CAPABILITY_DELIVERY_TYPE, data);
}
export function persistCapabilityEvent(pi, event) {
    const decoded = decodeCapabilityEvent(event);
    if (!decoded.ok)
        throw new Error(decoded.error);
    pi.appendEntry(CAPABILITY_EVENT_ENTRY, decoded.event);
}
export function persistCapabilityTools(pi, snapshot) {
    const data = { schemaVersion: 1, baseline: [...snapshot.baseline], lastApplied: [...snapshot.lastApplied] };
    decodeCapabilityTools(data);
    pi.appendEntry(CAPABILITY_TOOLS_ENTRY, data);
}
function decodeCapabilityTools(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid Forge tool baseline.");
    const data = raw;
    if (data.schemaVersion !== 1 || Object.keys(data).some((key) => !["schemaVersion", "baseline", "lastApplied"].includes(key))) {
        throw new Error("Unsupported Forge tool baseline schema.");
    }
    for (const key of ["baseline", "lastApplied"]) {
        if (!Array.isArray(data[key]) || data[key].length > 4096
            || data[key].some((value) => typeof value !== "string" || !value || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))) {
            throw new Error(`Invalid Forge tool baseline ${key}.`);
        }
    }
    return { baseline: [...data.baseline], lastApplied: [...data.lastApplied] };
}
//# sourceMappingURL=session-adapter.js.map