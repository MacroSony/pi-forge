import type { PromptResourcePolicy } from "../types.ts";
import type { SubagentAccessRequest, SubagentBackendTool, SubagentToolNegotiationResult } from "./types.ts";
export declare function negotiateSubagentTools(catalog: readonly SubagentBackendTool[], policy: PromptResourcePolicy | undefined, access: SubagentAccessRequest): SubagentToolNegotiationResult;
//# sourceMappingURL=tools.d.ts.map