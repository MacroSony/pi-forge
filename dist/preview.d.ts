import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPromptStack, PromptStackDiagnostic, PromptVariableValue } from "./types.ts";
import type { WebEditorPreview } from "./web-editor/index.ts";
export declare function renderPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack, sessionVariables: Record<string, PromptVariableValue>): string;
export declare function buildPreview(ctx: ExtensionContext, target: LoadedPromptStack, sessionVariables: Record<string, PromptVariableValue>, options: BuildSystemPromptOptions): {
    text: string;
    preview: WebEditorPreview;
    diagnostics: PromptStackDiagnostic[];
};
export declare function renderDiagnostics(diagnostics: PromptStackDiagnostic[]): string;
export declare function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void>;
//# sourceMappingURL=preview.d.ts.map