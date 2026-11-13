import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
export interface ProviderPayloadCaptureWithSerialization {
    capture: WebEditorPayloadCapture;
    /**
     * Secret-redacted JSON without the display capture's lossy limits. Inline
     * media (data URLs, long base64 blobs) is replaced by a compact placeholder
     * carrying its length and a content fingerprint, so diff identity still
     * changes when media changes but snapshots never retain the raw bytes.
     */
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
/**
 * Replace inline binary payloads with a bounded placeholder. Returns undefined
 * for ordinary strings. Provider payloads carry images, audio and files as
 * `data:<mime>;base64,...` URLs (OpenAI, Codex Responses) or as bare base64
 * (Anthropic `source.data`, Gemini `inlineData.data`).
 */
export declare function elideInlineMedia(value: string): string | undefined;
//# sourceMappingURL=payload-capture.d.ts.map