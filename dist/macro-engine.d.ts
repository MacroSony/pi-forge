import type { PromptEnvironment } from "./forge-v1/types.ts";
import type { PromptRenderHelpers } from "./render-helpers.ts";
import { type PromptRegistryEntry } from "./extension-registry.ts";
export interface PromptMacroRenderContext {
    env: PromptEnvironment;
    helpers: PromptRenderHelpers;
}
export type PromptMacroRenderer = (context: PromptMacroRenderContext) => string;
export interface PromptMacroDefinition extends PromptRegistryEntry {
    /** Environment paths this renderer reads (e.g. "parameters.x", "extensions.y"). */
    dependencies?: string[];
    render: PromptMacroRenderer;
}
export declare function registerMacro(definition: PromptMacroDefinition): () => void;
export declare function getRegisteredMacros(): readonly PromptMacroDefinition[];
export declare function getRegisteredMacro(name: string): PromptMacroDefinition | undefined;
export declare function createMacroRenderContext(env: PromptEnvironment): PromptMacroRenderContext;
//# sourceMappingURL=macro-engine.d.ts.map