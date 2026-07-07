import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PayloadDisplayTarget, PiForgeRuntimeState } from "./runtime-state.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorPayloadSnapshot } from "./web-editor/index.ts";
export declare function registerPayloadCommands(pi: ExtensionAPI, state: PiForgeRuntimeState): void;
export declare function registerPayloadRequestHandler(pi: ExtensionAPI, state: PiForgeRuntimeState, getActive: () => LoadedPromptStack | undefined): void;
export declare function armPayloadIntercept(state: PiForgeRuntimeState, ctx: ExtensionCommandContext, savePath?: string, displayTarget?: PayloadDisplayTarget): void;
export declare function clearPayloadCapture(state: PiForgeRuntimeState, ctx: ExtensionCommandContext): void;
export declare function webPayloadSnapshot(state: PiForgeRuntimeState): WebEditorPayloadSnapshot;
//# sourceMappingURL=payload-command.d.ts.map