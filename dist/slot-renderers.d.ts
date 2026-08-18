import type { PromptEnvironment } from "./forge-v1/types.ts";
import type { PromptRuntime, PromptStack, PromptStackDiagnostic, PromptStackSlotFormat, PromptStackSlotItem } from "./types.ts";
import { type PromptRenderHelpers, type PromptVariableAccess } from "./render-helpers.ts";
import { type PromptExtensionOptionsSchema, type PromptRegistryEntry } from "./extension-registry.ts";
export interface PromptSlotRenderContext {
    item: PromptStackSlotItem;
    options: Record<string, unknown>;
    env: PromptEnvironment;
    helpers: PromptRenderHelpers;
}
/** Internal context used by built-in slots; not part of the public extension contract. */
export interface BuiltInSlotRenderContext extends PromptSlotRenderContext {
    stack: PromptStack;
    runtime: PromptRuntime;
    diagnostics: PromptStackDiagnostic[];
    variables: PromptVariableAccess;
    format: (options?: {
        allowJson?: boolean;
    }) => PromptStackSlotFormat;
}
/** Internal registration shape accepted for built-in slots. */
export interface BuiltInSlotDefinition extends Omit<PromptSlotDefinition, "render"> {
    render: (context: BuiltInSlotRenderContext) => string;
}
export type PromptSlotRenderer = (context: PromptSlotRenderContext) => string | undefined;
export interface PromptSlotDefinition extends PromptRegistryEntry {
    /** Environment paths this renderer reads (e.g. "parameters.x", "extensions.y"). */
    dependencies?: string[];
    options?: PromptExtensionOptionsSchema;
    render: PromptSlotRenderer;
}
export declare const SUPPORTED_SLOTS: Set<string>;
export declare function renderSlotText(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime, diagnostics: PromptStackDiagnostic[], env: PromptEnvironment): string;
export declare function registerSlot(definition: BuiltInSlotDefinition): () => void;
export declare function registerSlot(definition: PromptSlotDefinition): () => void;
export declare function getRegisteredSlots(): readonly PromptSlotDefinition[];
export declare function getRegisteredSlot(name: string): PromptSlotDefinition | undefined;
//# sourceMappingURL=slot-renderers.d.ts.map