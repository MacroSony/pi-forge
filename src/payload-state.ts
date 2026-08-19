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

export function createPayloadState(): PayloadState {
	return {
		interceptNextProviderPayload: false,
		interceptPayloadDisplayTarget: "editor",
	};
}

export function clearPayloadState(state: PayloadState): void {
	state.interceptNextProviderPayload = false;
	state.interceptPayloadSavePath = undefined;
	state.interceptPayloadDisplayTarget = "editor";
	state.payloadCaptureArmedAt = undefined;
	state.latestProviderPayloadCapture = undefined;
}
