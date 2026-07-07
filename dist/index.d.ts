import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { getRegisteredMacros, registerMacro, type PromptMacroDefinition, type PromptMacroRenderContext, type PromptMacroRenderer, } from "./macro-engine.ts";
export { getRegisteredSlots, registerSlot, type PromptSlotDefinition, type PromptSlotRenderContext, type PromptSlotRenderer, } from "./slot-renderers.ts";
export { type PromptExtensionArgumentDefinition, type PromptExtensionOptionDefinition, type PromptExtensionOptionsSchema, type PromptExtensionOptionType, type PromptRegistryEntry, } from "./extension-registry.ts";
export { type ForgeExtensionApi, type ForgeExtensionRegister, } from "./forge-extensions.ts";
export { createVariableAccess, promptRenderHelpers, type PromptRenderHelpers, type PromptVariableAccess, type PromptVariableScope, type PromptWritableVariableScope, } from "./render-helpers.ts";
export default function piForge(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map