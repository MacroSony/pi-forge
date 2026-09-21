export const INSTRUCTION_EVENT_ENTRY = "pi-forge-instruction-event";
export const INSTRUCTION_TOOLS_ENTRY = "pi-forge-instruction-tools";
export const INSTRUCTION_DELIVERY_TYPE = "pi-forge-instruction-delivery";
export function isInstructionDelivery(message) {
    if (!message || typeof message !== "object")
        return false;
    const value = message;
    return value.role === "custom" && value.customType === INSTRUCTION_DELIVERY_TYPE;
}
/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export function isInstructionControlMessage(message) {
    return !!message && typeof message === "object"
        && (message.role === "system" || isInstructionDelivery(message));
}
//# sourceMappingURL=instruction-protocol.js.map