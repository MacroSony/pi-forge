import { createContextDiffHistory } from "./context-diff-history.js";
export function createPayloadState() {
    return {
        interceptNextProviderPayload: false,
        interceptPayloadDisplayTarget: "editor",
        contextDiffHistory: createContextDiffHistory(),
    };
}
export function clearPayloadState(state) {
    state.interceptNextProviderPayload = false;
    state.interceptPayloadSavePath = undefined;
    state.interceptPayloadDisplayTarget = "editor";
    state.payloadCaptureArmedAt = undefined;
    state.latestProviderPayloadCapture = undefined;
    state.contextDiffHistory = createContextDiffHistory();
}
//# sourceMappingURL=payload-state.js.map