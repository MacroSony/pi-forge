import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InstructionRuntime } from "./runtime/instruction-runtime.ts";
export declare const FORGE_SYSTEM_UPDATE_TOOL_NAME = "forge_system_update";
export declare const ForgeSystemUpdateParameters: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"list">, Type.TLiteral<"status">, Type.TLiteral<"use">, Type.TLiteral<"off">]>;
    id: Type.TOptional<Type.TString>;
}>;
export type ForgeSystemUpdateParams = Static<typeof ForgeSystemUpdateParameters>;
export declare function registerInstructionTool(pi: ExtensionAPI, runtime: InstructionRuntime): void;
//# sourceMappingURL=instruction-tool.d.ts.map