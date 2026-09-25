import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Intentional public surface (0.5.0): the default Pi extension factory plus
 * the trusted-extension API (`registerMacro`/`registerSlot` and their contract
 * types). Other intentional entries are the /subagent and /ui-contribution ports
 * and the local /command-contribution contract. Everything else is internal.
 */
export { registerMacro, type PromptMacroDefinition, type PromptMacroRenderContext, type PromptMacroRenderer, } from "./macro-engine.ts";
export { registerSlot, type PromptSlotDefinition, type PromptSlotRenderContext, type PromptSlotRenderer, } from "./slot-renderers.ts";
export type { PromptExtensionArgumentDefinition, PromptExtensionOptionDefinition, PromptExtensionOptionsSchema, PromptExtensionOptionType, PromptRegistryEntry, } from "./extension-registry.ts";
export type { PromptEnvironment, PromptEnvironmentValue, } from "./forge-v1/index.ts";
export type { PromptRenderHelpers, } from "./render-helpers.ts";
export type { ForgeExtensionApi, ForgeExtensionRegister, } from "./forge-extensions.ts";
export default function piForge(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map