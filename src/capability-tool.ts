import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapabilityRuntime } from "./runtime/capability-runtime.ts";

export const FORGE_CAPABILITY_TOOL_NAME = "forge_capability";

export const ForgeCapabilityParameters = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("list"),
				Type.Literal("status"),
				Type.Literal("enable"),
				Type.Literal("disable"),
			],
			{ description: "Capability action: list, status, enable, or disable." },
		),
		id: Type.Optional(
			Type.String({ maxLength: 128, description: "Preset-bound capability binding ID to enable or disable." }),
		),
	},
	{ additionalProperties: false },
);

export type ForgeCapabilityParams = Static<typeof ForgeCapabilityParameters>;

export function registerCapabilityTool(pi: ExtensionAPI, runtime: CapabilityRuntime): void {
	pi.registerTool({
		name: FORGE_CAPABILITY_TOOL_NAME,
		label: "Capability",
		description:
			"Use only capabilities authorized by the active Preset: list, status, enable by binding ID, or disable your own Agent-owned activation. Requires a trusted project and current authorization on every call. Cannot add arbitrary rules, reset, or stop human-owned capabilities.",
		parameters: ForgeCapabilityParameters,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			if (!ctx) throw new Error("forge_capability requires an active extension context.");
			return await runtime.executeAgentTool(ctx, params);
		},
	});
}
