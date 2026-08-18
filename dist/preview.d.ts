import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorPreview } from "./web-editor/index.ts";
export declare function renderPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack): string;
export declare function buildPreview(ctx: ExtensionContext, target: LoadedPromptStack, options: BuildSystemPromptOptions): {
    text: string;
    preview: WebEditorPreview;
    diagnostics: PromptStackDiagnostic[];
};
export declare function renderDiagnostics(diagnostics: PromptStackDiagnostic[]): string;
export declare function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void>;
//# sourceMappingURL=preview.d.ts.map