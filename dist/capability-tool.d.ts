import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapabilityRuntime } from "./runtime/capability-runtime.ts";
export declare const FORGE_CAPABILITY_TOOL_NAME = "forge_capability";
export declare const ForgeCapabilityParameters: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"list">, Type.TLiteral<"status">, Type.TLiteral<"enable">, Type.TLiteral<"disable">]>;
    id: Type.TOptional<Type.TString>;
}>;
export type ForgeCapabilityParams = Static<typeof ForgeCapabilityParameters>;
export declare function registerCapabilityTool(pi: ExtensionAPI, runtime: CapabilityRuntime): void;
//# sourceMappingURL=capability-tool.d.ts.map