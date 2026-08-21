import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
export interface ProviderPayloadCaptureWithSerialization {
    capture: WebEditorPayloadCapture;
    /** Secret-redacted JSON without the display capture's lossy limits. */
    serializedPayload: string;
}
export declare function createProviderPayloadCapture(value: unknown, options?: {
    stackId?: string;
    savePath?: string;
}): WebEditorPayloadCapture;
export declare function createProviderPayloadCaptureWithSerialization(value: unknown, options?: {
    stackId?: string;
    savePath?: string;
}): ProviderPayloadCaptureWithSerialization;
export declare function formatProviderPayload(value: unknown): {
    payload?: unknown;
    text: string;
    chars: number;
    approxTokens: number;
    truncated: boolean;
    serializedPayload: string;
    error?: string;
};
export declare function estimatePayloadTokens(payload: string): number;
//# sourceMappingURL=payload-capture.d.ts.map