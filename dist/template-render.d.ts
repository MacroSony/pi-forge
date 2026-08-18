import type { PromptEnvironment } from "./forge-v1/types.ts";
import type { PromptRuntime, PromptStack, PromptStackDiagnostic } from "./types.ts";
export declare class ForgeTemplateRenderer {
    private readonly base;
    private readonly extensions;
    private readonly stack;
    constructor(stack: PromptStack, runtime: PromptRuntime);
    render(text: string, diagnostics: PromptStackDiagnostic[], itemId?: string): string;
    environment(): PromptEnvironment;
    private resolveExtensions;
    private expandExtensionNames;
    private resolveExtensionValue;
}
export declare function buildPromptEnvironment(stack: PromptStack, runtime: PromptRuntime): PromptEnvironment;
export declare function freezeEnvironment(environment: PromptEnvironment): PromptEnvironment;
//# sourceMappingURL=template-render.d.ts.map