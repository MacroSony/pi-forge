import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Intentional public surface (0.5.0): the default Pi extension factory plus
 * the trusted-extension API (`registerMacro`/`registerSlot` and their contract
 * types). Everything else is internal; the only other entry point is
 * `@zihanw/pi-forge/subagent`, the versioned host port.
 */
export { registerMacro, type PromptMacroDefinition, type PromptMacroRenderContext, type PromptMacroRenderer, } from "./macro-engine.ts";
export { registerSlot, type PromptSlotDefinition, type PromptSlotRenderContext, type PromptSlotRenderer, } from "./slot-renderers.ts";
export type { PromptExtensionArgumentDefinition, PromptExtensionOptionDefinition, PromptExtensionOptionsSchema, PromptExtensionOptionType, PromptRegistryEntry, } from "./extension-registry.ts";
export type { PromptEnvironment, PromptEnvironmentValue, } from "./forge-v1/index.ts";
export type { PromptRenderHelpers, } from "./render-helpers.ts";
export type { ForgeExtensionApi, ForgeExtensionRegister, } from "./forge-extensions.ts";
export default function piForge(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map