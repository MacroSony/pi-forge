import { Type } from "@earendil-works/pi-ai";
export const FORGE_SYSTEM_UPDATE_TOOL_NAME = "forge_system_update";
export const ForgeSystemUpdateParameters = Type.Object({
    action: Type.Union([
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("use"),
        Type.Literal("off"),
    ], { description: "Instruction mode action to perform: list, status, use, or off." }),
    id: Type.Optional(Type.String({ maxLength: 128, description: "Identifier of the preset-bound instruction mode to use or turn off." })),
}, { additionalProperties: false });
export function registerInstructionTool(pi, runtime) {
    pi.registerTool({
        name: FORGE_SYSTEM_UPDATE_TOOL_NAME,
        label: "System Update",
        description: "Use only instruction modes authorized by the active Preset: list, status, use by binding ID, or off your own Agent-owned activation. Requires a trusted project and current authorization on every call. Cannot add arbitrary rules, reset, or stop human-owned instructions.",
        parameters: ForgeSystemUpdateParameters,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
            if (!ctx) {
                throw new Error("forge_system_update requires an active extension context.");
            }
            return await runtime.executeAgentTool(ctx, params);
        },
    });
}
//# sourceMappingURL=instruction-tool.js.map