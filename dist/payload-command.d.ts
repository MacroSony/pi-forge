import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PayloadDisplayTarget, PayloadState } from "./payload-state.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorPayloadSnapshot } from "./web-editor/index.ts";
export declare function registerPayloadCommands(pi: ExtensionAPI, state: PayloadState): void;
export declare function registerPayloadRequestHandler(pi: ExtensionAPI, state: PayloadState, getActive: () => LoadedPromptStack | undefined): void;
export declare function armPayloadIntercept(state: PayloadState, ctx: ExtensionContext, savePath?: string, displayTarget?: PayloadDisplayTarget): void;
export declare function clearPayloadCapture(state: PayloadState, ctx: ExtensionContext): void;
export declare function webPayloadSnapshot(state: PayloadState): WebEditorPayloadSnapshot;
//# sourceMappingURL=payload-command.d.ts.map