export const CAPABILITY_EVENT_ENTRY = "pi-forge-capability-event";
export const CAPABILITY_TOOLS_ENTRY = "pi-forge-capability-tools";
export const CAPABILITY_DELIVERY_TYPE = "pi-forge-capability-delivery";
export function isCapabilityDelivery(message) {
    if (!message || typeof message !== "object")
        return false;
    const value = message;
    return value.role === "custom" && value.customType === CAPABILITY_DELIVERY_TYPE;
}
/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export function isCapabilityControlMessage(message) {
    return !!message && typeof message === "object"
        && (message.role === "system" || isCapabilityDelivery(message));
}
//# sourceMappingURL=capability-protocol.js.map