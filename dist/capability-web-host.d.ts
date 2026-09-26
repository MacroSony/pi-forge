import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LoadedCapability } from "./codecs/capability.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorCapabilityOperation, WebEditorCapabilityResult } from "./web-editor/types.ts";
export interface CapabilityWebResources {
    readCapabilities?(): readonly LoadedCapability[];
    getStacks(): LoadedPromptStack[];
}
/** Optional Web adapter; Workspace/repositories and the existing resolver retain ownership. */
export declare function capabilityOperation(ctx: ExtensionContext, runtime: CapabilityWebResources, action: WebEditorCapabilityOperation, selector?: string, input?: unknown): WebEditorCapabilityResult;
//# sourceMappingURL=capability-web-host.d.ts.map