import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentProfileProvenance } from "./agent-profile.ts";
import type { PromptStackDiagnostic } from "./types.ts";
export declare const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export declare const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
/**
 * Session persistence bookkeeping. This owns reading/writing pi-forge's custom
 * session entries so lifecycle, profile-service, and stack runtime do not each
 * reach into the session format.
 */
export declare function getCurrentBranchEntries(ctx: ExtensionContext): unknown[];
export declare function getRestoredActiveId(ctx: ExtensionContext): string | undefined;
export declare function getRestoredProfileProvenance(ctx: ExtensionContext): AgentProfileProvenance | undefined;
export declare function getLegacyVariableStateDiagnostic(ctx: ExtensionContext): PromptStackDiagnostic[];
export declare function persistActiveSelection(pi: ExtensionAPI, activeStackId: string): void;
export declare function persistProfileProvenance(pi: ExtensionAPI, provenance: AgentProfileProvenance | null): void;
//# sourceMappingURL=session-adapter.d.ts.map