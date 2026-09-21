/** Exact input validation is shared by HTTP and direct application callers. */
export function isInstructionStateMutation(value) {
    if (!plain(value))
        return false;
    const keys = value.action === "off" ? ["action", "activationId", "guard"] : ["action", "guard"];
    if (value.action !== "off" && value.action !== "reset")
        return false;
    if (Object.keys(value).some((key) => !keys.includes(key)))
        return false;
    if (value.action === "off" && !text(value.activationId, 128))
        return false;
    const guard = value.guard;
    return plain(guard) && Object.keys(guard).length === 3
        && Object.keys(guard).every((key) => ["sessionId", "leafId", "revision"].includes(key))
        && text(guard.sessionId, 1024) && (guard.leafId === null || text(guard.leafId, 1024))
        && text(guard.revision, 256);
}
function text(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function plain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
//# sourceMappingURL=instruction-state.js.map