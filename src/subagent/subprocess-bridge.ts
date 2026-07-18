import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackendPreflightAccepted, SubagentPreparedMessage } from "./contract.ts";

export const PI_FORGE_SUBPROCESS_INPUT_ENV = "PI_FORGE_SUBAGENT_BRIDGE_INPUT";

export interface SubprocessBridgeInput {
	marker: string;
	systemPrompt: string;
	messages: SubagentPreparedMessage[];
	model: BackendPreflightAccepted["model"];
	effectiveToolNames: string[];
}

export function loadSubprocessBridgeInput(path = process.env[PI_FORGE_SUBPROCESS_INPUT_ENV]): SubprocessBridgeInput {
	if (!path) throw new Error(`Missing ${PI_FORGE_SUBPROCESS_INPUT_ENV}.`);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SubprocessBridgeInput>;
	if (typeof parsed.marker !== "string" || !parsed.marker) throw new Error("Subprocess bridge input is missing its marker.");
	if (typeof parsed.systemPrompt !== "string") throw new Error("Subprocess bridge input is missing its system prompt.");
	if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) throw new Error("Subprocess bridge input has no prepared messages.");
	if (!parsed.model || typeof parsed.model.provider !== "string" || typeof parsed.model.id !== "string") throw new Error("Subprocess bridge input has no model receipt.");
	if (!Array.isArray(parsed.effectiveToolNames) || parsed.effectiveToolNames.some((name) => typeof name !== "string")) throw new Error("Subprocess bridge input has an invalid tool allowlist.");
	return parsed as SubprocessBridgeInput;
}

export function createSubprocessBridge(input: SubprocessBridgeInput) {
	return (pi: ExtensionAPI): void => {
		let markerObserved = false;
		pi.on("before_agent_start", () => ({ systemPrompt: input.systemPrompt }));
		pi.on("context", (event) => {
			const markerIndex = event.messages.findIndex((message) => isMarkerMessage(message, input.marker));
			if (markerIndex === -1) {
				if (!markerObserved) throw new Error("Pi Forge subprocess marker was absent before the first provider request.");
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

function isMarkerMessage(message: AgentMessage, marker: string): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content === marker;
	return message.content.length === 1 && message.content[0]?.type === "text" && message.content[0].text === marker;
}

function preparedMessageToAgentMessage(
	message: SubagentPreparedMessage,
	model: BackendPreflightAccepted["model"],
	index: number,
): AgentMessage {
	if (message.content.some((part) => part.type === "media")) throw new Error("Subprocess media preparation is not implemented.");
	const content = message.content.map((part) => ({ type: "text" as const, text: part.type === "text" ? part.text : "" }));
	if (message.role === "user") return { role: "user", content: content.length === 1 ? content[0]!.text : content, timestamp: index } as AgentMessage;
	if (message.role === "custom") return { role: "custom", customType: "pi-forge-subagent", content, display: false, details: {}, timestamp: index } as AgentMessage;
	return {
		role: "assistant",
		content,
		api: "unknown",
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: index,
	} as AgentMessage;
}

export default function subprocessBridge(pi: ExtensionAPI): void {
	createSubprocessBridge(loadSubprocessBridgeInput())(pi);
}
