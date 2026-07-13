import type { EditorPromptStack } from "./types.ts";
export interface RegexEditorDependencies {
    getStack(): EditorPromptStack | null;
    markDirty(): void;
    setStatus(text: string, tone?: string): void;
    showModal(title: string, meta: string, body: string, options?: {
        bodyClass?: string;
    }): void;
    run(action: () => void | Promise<void>): Promise<void>;
    validateStack(): Promise<void>;
}
export declare function createRegexEditor(deps: RegexEditorDependencies): {
    open: () => void;
    renderBody: () => string;
    bind: () => void;
    reset: () => void;
    getError: () => string;
};
//# sourceMappingURL=regex-editor.d.ts.map