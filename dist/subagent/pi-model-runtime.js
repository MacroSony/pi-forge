/**
 * Pi 0.80.10 exposes ModelRegistry to extensions as a compatibility facade,
 * while createAgentSession requires the canonical ModelRuntime. The facade
 * retains that runtime internally but does not yet publish a typed accessor.
 */
export function modelRuntimeFromRegistry(modelRegistry) {
    const candidate = modelRegistry.runtime;
    if (!isModelRuntime(candidate)) {
        throw new Error("Pi Forge cannot access the Pi 0.80.10 model runtime required to preserve parent authentication. "
            + "Use the exact supported Pi version and restart Pi before invoking a subagent.");
    }
    return candidate;
}
function isModelRuntime(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return typeof candidate.getModel === "function"
        && typeof candidate.getAuth === "function"
        && typeof candidate.streamSimple === "function";
}
//# sourceMappingURL=pi-model-runtime.js.map