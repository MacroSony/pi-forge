import { readFileSync } from "node:fs";
export const PI_FORGE_SUBPROCESS_INPUT_ENV = "PI_FORGE_SUBAGENT_BRIDGE_INPUT";
export function loadSubprocessBridgeInput(path = process.env[PI_FORGE_SUBPROCESS_INPUT_ENV]) {
    if (!path)
        throw new Error(`Missing ${PI_FORGE_SUBPROCESS_INPUT_ENV}.`);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.marker !== "string" || !parsed.marker)
        throw new Error("Subprocess bridge input is missing its marker.");
    if (typeof parsed.systemPrompt !== "string")
        throw new Error("Subprocess bridge input is missing its system prompt.");
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0)
        throw new Error("Subprocess bridge input has no prepared messages.");
    if (!parsed.model || typeof parsed.model.provider !== "string" || typeof parsed.model.id !== "string")
        throw new Error("Subprocess bridge input has no model receipt.");
    if (!Array.isArray(parsed.effectiveToolNames) || parsed.effectiveToolNames.some((name) => typeof name !== "string"))
        throw new Error("Subprocess bridge input has an invalid tool allowlist.");
    return parsed;
}
export function createSubprocessBridge(input) {
    return (pi) => {
        let markerObserved = false;
        pi.on("before_agent_start", () => ({ systemPrompt: input.systemPrompt }));
        pi.on("context", (event) => {
            const markerIndex = event.messages.findIndex((message) => isMarkerMessage(message, input.marker));
            if (markerIndex === -1) {
                if (!markerObserved)
                    throw new Error("Pi Forge subprocess marker was absent before the first provider request.");
                return;
            }
            markerObserved = true;
            return {
                messages: [
                    ...event.messages.slice(0, markerIndex),
                    ...input.messages.map((message, index) => preparedMessageToAgentMessage(message, input.model, index)),
                    ...event.messages.slice(markerIndex + 1),
                ],
            };
        });
        pi.on("tool_call", (event) => {
            if (!input.effectiveToolNames.includes(event.toolName)) {
                return { block: true, reason: `Tool ${event.toolName} is outside the approved Pi Forge subprocess allowlist.` };
            }
        });
    };
}
function isMarkerMessage(message, marker) {
    if (message.role !== "user")
        return false;
    if (typeof message.content === "string")
        return message.content === marker;
    return message.content.length === 1 && message.content[0]?.type === "text" && message.content[0].text === marker;
}
function preparedMessageToAgentMessage(message, model, index) {
    if (message.content.some((part) => part.type === "media"))
        throw new Error("Subprocess media preparation is not implemented.");
    const content = message.content.map((part) => ({ type: "text", text: part.type === "text" ? part.text : "" }));
    if (message.role === "user")
        return { role: "user", content: content.length === 1 ? content[0].text : content, timestamp: index };
    if (message.role === "custom")
        return { role: "custom", customType: "pi-forge-subagent", content, display: false, details: {}, timestamp: index };
    return {
        role: "assistant",
        content,
        api: "unknown",
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: index,
    };
}
export default function subprocessBridge(pi) {
    createSubprocessBridge(loadSubprocessBridgeInput())(pi);
}
//# sourceMappingURL=subprocess-bridge.js.map