import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
export type PayloadDisplayTarget = "editor" | "web";
/**
 * Payload capture/debug state. Separate from resource state and compile-cycle
 * state so the generic central bag can be removed.
 */
export interface PayloadState {
    interceptNextProviderPayload: boolean;
    interceptPayloadSavePath?: string;
    interceptPayloadDisplayTarget: PayloadDisplayTarget;
    payloadCaptureArmedAt?: string;
    latestProviderPayloadCapture?: WebEditorPayloadCapture;
}
export declare function createPayloadState(): PayloadState;
export declare function clearPayloadState(state: PayloadState): void;
//# sourceMappingURL=payload-state.d.ts.map