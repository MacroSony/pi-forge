import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LoadedAgentProfile } from "./agent-profile.ts";
import { type AgentProfileSnapshot, type SubagentDependencyKind, type SubagentDiagnostic, type SubagentPromptDependency, type SubagentPreparationInput, type SubagentPreparationOutput } from "./subagent/contract.ts";
import type { LoadedPromptStack, PromptRuntime, PromptStack } from "./types.ts";
export interface SubagentPromptRegistration {
    name: string;
    source?: string;
    dependencies?: string[];
}
export interface SubagentPromptRegistrationCatalog {
    macros: SubagentPromptRegistration[];
    slots: SubagentPromptRegistration[];
}
export interface SubagentHostResolution {
    profileId: string;
    snapshot?: AgentProfileSnapshot;
    dependencies: SubagentPromptDependency[];
    missingDependencies: Array<{
        kind: SubagentDependencyKind;
        name: string;
    }>;
    diagnostics: SubagentDiagnostic[];
}
export declare function currentSubagentPromptRegistrationCatalog(): SubagentPromptRegistrationCatalog;
export declare function resolveSubagentHostProfile(loaded: LoadedAgentProfile, resources: {
    promptStacks: readonly LoadedPromptStack[];
    registrations?: SubagentPromptRegistrationCatalog;
}): SubagentHostResolution;
export declare function prepareSubagentHostPlan(input: SubagentPreparationInput): SubagentPreparationOutput;
export declare function collectSubagentPromptDependencies(stack: PromptStack, registrations?: SubagentPromptRegistrationCatalog): {
    dependencies: SubagentPromptDependency[];
    missingDependencies: Array<{
        kind: SubagentDependencyKind;
        name: string;
    }>;
    diagnostics: SubagentDiagnostic[];
};
export declare function collectMacroCommandNames(text: string): string[];
export declare function appendProtectedAgentTask(compiledMessages: readonly AgentMessage[], protectedTask: AgentMessage): AgentMessage[];
export declare function compileProtectedAgentTaskMessages(stack: LoadedPromptStack, runtime: PromptRuntime, originalMessages: readonly AgentMessage[]): {
    messages: AgentMessage[];
    diagnostics: import("./types.ts").PromptStackDiagnostic[];
};
export declare function isProtectedAgentTaskPreserved(messages: readonly AgentMessage[], task: AgentMessage): boolean;
//# sourceMappingURL=subagent-host.d.ts.map