import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ResourceKey } from "./resource-identity.ts";
import type { ForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
export declare function registerForgeSubagentCommand(pi: ExtensionAPI, runtime: ForgeSubagentRuntime, profileIds: () => string[], resolveProfileKey: (selector: string) => ResourceKey | undefined): void;
//# sourceMappingURL=subagent-command.d.ts.map