export function createPayloadState() {
    return {
        interceptNextProviderPayload: false,
        interceptPayloadDisplayTarget: "editor",
    };
}
export function clearPayloadState(state) {
    state.interceptNextProviderPayload = false;
    state.interceptPayloadSavePath = undefined;
    state.interceptPayloadDisplayTarget = "editor";
    state.payloadCaptureArmedAt = undefined;
    state.latestProviderPayloadCapture = undefined;
}
//# sourceMappingURL=payload-state.js.map