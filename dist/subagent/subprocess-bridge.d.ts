import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackendPreflightAccepted, SubagentPreparedMessage } from "./contract.ts";
export declare const PI_FORGE_SUBPROCESS_INPUT_ENV = "PI_FORGE_SUBAGENT_BRIDGE_INPUT";
export interface SubprocessBridgeInput {
    marker: string;
    systemPrompt: string;
    messages: SubagentPreparedMessage[];
    model: BackendPreflightAccepted["model"];
    effectiveToolNames: string[];
}
export declare function loadSubprocessBridgeInput(path?: string | undefined): SubprocessBridgeInput;
export declare function createSubprocessBridge(input: SubprocessBridgeInput): (pi: ExtensionAPI) => void;
export default function subprocessBridge(pi: ExtensionAPI): void;
//# sourceMappingURL=subprocess-bridge.d.ts.map