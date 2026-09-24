import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LoadedInstructionMode } from "./codecs/instruction-mode.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorModeOperation, WebEditorModeResult } from "./web-editor/types.ts";
export interface InstructionWebResources {
    readInstructionModes?(): readonly LoadedInstructionMode[];
    getStacks(): LoadedPromptStack[];
}
/** Optional Web adapter; Workspace/repositories and the existing resolver retain ownership. */
export declare function instructionModeOperation(ctx: ExtensionContext, runtime: InstructionWebResources, action: WebEditorModeOperation, selector?: string, input?: unknown): WebEditorModeResult;
//# sourceMappingURL=instruction-web-host.d.ts.map