import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
export declare function createProviderPayloadCapture(value: unknown, options?: {
    stackId?: string;
    savePath?: string;
}): WebEditorPayloadCapture;
export declare function formatProviderPayload(value: unknown): {
    payload?: unknown;
    text: string;
    chars: number;
    approxTokens: number;
    truncated: boolean;
    error?: string;
};
export declare function estimatePayloadTokens(payload: string): number;
//# sourceMappingURL=payload-capture.d.ts.map