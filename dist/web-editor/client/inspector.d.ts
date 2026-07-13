import type { EditorRequestInit } from "./api.ts";
import type { EditorPromptStack, PromptStackDiagnostic } from "./types.ts";
export interface InspectorDependencies {
    api<T = any>(path: string, options?: EditorRequestInit): Promise<T>;
    getSelectedId(): string;
    stackForSubmit(): EditorPromptStack;
    renderDiagnostics(diagnostics: PromptStackDiagnostic[]): void;
    renderItemList(): void;
    setStatus(text: string, tone?: string): void;
}
export declare function createInspector(deps: InspectorDependencies): {
    validateStack: () => Promise<void>;
    previewStack: () => Promise<void>;
    refreshPayloadCapture: (options?: any) => Promise<void>;
    armPayloadCapture: (showInspector?: any) => Promise<void>;
    clearPayloadCapture: () => Promise<void>;
    openPayloadCapture: () => Promise<void>;
    hidePreview: () => void;
    copyPreviewText: (index: any) => Promise<void>;
    copyTextToClipboard: (text: any) => Promise<void>;
};
//# sourceMappingURL=inspector.d.ts.map