import type { EditorPromptStack, WebEditorPolicyResource } from "./types.ts";
export interface PolicyEditorDependencies {
    getStack(): EditorPromptStack | null;
    getResources(): {
        tools: WebEditorPolicyResource[];
        skills: WebEditorPolicyResource[];
    };
    markDirty(): void;
    setStatus(text: string, tone?: string): void;
}
export declare function createPolicyEditor(deps: PolicyEditorDependencies): {
    renderTab: () => void;
    reset: () => void;
    getError: () => string;
};
//# sourceMappingURL=policy-editor.d.ts.map