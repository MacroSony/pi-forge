import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPromptStack, PromptCompileOptions, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorPreview } from "./web-editor/index.ts";
/**
 * Render preview for a prompt stack against current session context.
 * Evaluates the selected draft against current session mode snapshots without
 * mutating runtime state, applying tool policy, or marking preparation.
 */
export declare function renderPreview(ctx: ExtensionCommandContext, target: LoadedPromptStack): string;
/**
 * Build a structured preview and text rendering for a prompt stack.
 *
 * Evaluates the selected draft against current session mode snapshots:
 * 1. Restores compaction base System and Pi base prompt.
 * 2. Matches live compile -> base projection -> mode projection ordering.
 * 3. Fails closed for active modes when project is untrusted.
 * 4. Preserves untouched message provenance and labels synthesized updates.
 * 5. Avoids duplicating leading compiled base between preview.system and preview.messages.
 * 6. Separates actual text from named-section operations and historical tool declarations.
 * Pure and non-mutating: zero persistence, tool sync, or model inference side effects.
 */
export declare function buildPreview(ctx: ExtensionContext, target: LoadedPromptStack, options: PromptCompileOptions): {
    text: string;
    preview: WebEditorPreview;
    diagnostics: PromptStackDiagnostic[];
};
export declare function renderDiagnostics(diagnostics: PromptStackDiagnostic[]): string;
export declare function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void>;
//# sourceMappingURL=preview.d.ts.map