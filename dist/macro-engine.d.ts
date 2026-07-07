import type { PromptRuntime, PromptStack, PromptStackDiagnostic } from "./types.ts";
import { type PromptRenderHelpers, type PromptVariableAccess } from "./render-helpers.ts";
import { type PromptExtensionArgumentDefinition, type PromptRegistryEntry } from "./extension-registry.ts";
export interface PromptMacroRenderContext {
    name: string;
    command: string;
    stack: PromptStack;
    runtime: PromptRuntime;
    rawArgs: readonly string[];
    expandArg: (index: number) => string;
    expandJoinedArgs: (startIndex: number) => string;
    helpers: PromptRenderHelpers;
    variables: PromptVariableAccess;
}
export type PromptMacroRenderer = (context: PromptMacroRenderContext) => string | undefined;
export interface PromptMacroDefinition extends PromptRegistryEntry {
    args?: readonly PromptExtensionArgumentDefinition[];
    render: PromptMacroRenderer;
}
export declare function expandMacros(text: string, stack: PromptStack, runtime: PromptRuntime, diagnostics: PromptStackDiagnostic[], itemId: string): string;
export declare function registerMacro(definition: PromptMacroDefinition): () => void;
export declare function getRegisteredMacros(): readonly PromptMacroDefinition[];
//# sourceMappingURL=macro-engine.d.ts.map