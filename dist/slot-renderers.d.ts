import type { PromptEnvironment } from "./forge-v1/types.ts";
import type { PromptRuntime, PromptStack, PromptStackDiagnostic, PromptStackSlotFormat, PromptStackSlotItem } from "./types.ts";
import { type PromptRenderHelpers, type PromptVariableAccess } from "./render-helpers.ts";
import { type PromptExtensionOptionsSchema, type PromptRegistryEntry } from "./extension-registry.ts";
export interface PromptSlotRenderContext {
    item: PromptStackSlotItem;
    stack: PromptStack;
    runtime: PromptRuntime;
    env: PromptEnvironment;
    diagnostics: PromptStackDiagnostic[];
    options: Record<string, unknown>;
    helpers: PromptRenderHelpers;
    variables: PromptVariableAccess;
    format: (options?: {
        allowJson?: boolean;
    }) => PromptStackSlotFormat;
}
export type PromptSlotRenderer = (context: PromptSlotRenderContext) => string | undefined;
export interface PromptSlotDefinition extends PromptRegistryEntry {
    options?: PromptExtensionOptionsSchema;
    render: PromptSlotRenderer;
}
export declare const SUPPORTED_SLOTS: Set<string>;
export declare function renderSlotText(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime, diagnostics: PromptStackDiagnostic[], env: PromptEnvironment): string;
export declare function registerSlot(definition: PromptSlotDefinition): () => void;
export declare function getRegisteredSlots(): readonly PromptSlotDefinition[];
//# sourceMappingURL=slot-renderers.d.ts.map