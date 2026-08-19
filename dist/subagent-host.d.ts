import type { LoadedAgentProfile } from "./agent-profile.ts";
import type { AgentProfile } from "./codecs/agent-profile.ts";
import { type SubagentFingerprint } from "./subagent/fingerprints.ts";
import type { ForgeBackendFacts, ForgeBackendTool, ForgePromptAccessFacts } from "./subagent/host-port.ts";
import type { LoadedPromptStack, PromptResourcePolicy, PromptStack } from "./types.ts";
/**
 * Host-owned diagnostic shape for delegation resolution and preparation.
 * Structurally compatible with the optional package's contract diagnostics.
 */
export interface ForgeDelegationDiagnostic {
    level: "error" | "warning" | "info";
    code: string;
    path?: string;
    message: string;
}
export type ForgePromptDependencyKind = "macro" | "slot";
export interface ForgePromptDependency {
    kind: ForgePromptDependencyKind;
    name: string;
    identity: string;
    source?: string;
}
/**
 * Host-owned immutable profile snapshot artifact returned by `resolveProfile`
 * and embedded in `prepare` responses. The optional package validates and
 * binds it into execution plans; the wire schema version is shared with the
 * execution contract by design.
 */
export declare const FORGE_PROFILE_SNAPSHOT_VERSION: 1;
export interface ForgeProfileSnapshot {
    schemaVersion: typeof FORGE_PROFILE_SNAPSHOT_VERSION;
    /** Canonical scoped selector of the resolved profile (`project:<id>` or `global:<id>`). */
    profileId: string;
    profile: AgentProfile;
    /** Canonical scoped selector of the resolved prompt stack, or null. */
    promptStackId: string | null;
    promptStack: PromptStack | null;
    dependencies: ForgePromptDependency[];
    profileFingerprint: SubagentFingerprint;
    promptStackFingerprint: SubagentFingerprint | null;
}
/**
 * Host-compiled delegation message. Text-only on the host side; the optional
 * package projects these onto the runtime's portable prepared messages.
 */
export interface ForgeDelegationMessage {
    role: "user" | "assistant" | "custom";
    content: Array<{
        type: "text";
        text: string;
    }>;
    protectedTask?: boolean;
    source?: "prompt-stack" | "delegated-task";
}
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
    snapshot?: ForgeProfileSnapshot;
    dependencies: ForgePromptDependency[];
    missingDependencies: Array<{
        kind: ForgePromptDependencyKind;
        name: string;
    }>;
    diagnostics: ForgeDelegationDiagnostic[];
}
export interface ForgeDelegationPreparationInput {
    snapshot: ForgeProfileSnapshot;
    task: {
        text: string;
    };
    access: ForgePromptAccessFacts;
    backend: ForgeBackendFacts;
    cwd: string;
}
export interface ForgeDelegationPreparation {
    systemPrompt: string;
    messages: ForgeDelegationMessage[];
    effectiveToolIds: string[];
    effectiveToolNames: string[];
    diagnostics: ForgeDelegationDiagnostic[];
    preparedAt: string;
}
export declare function currentSubagentPromptRegistrationCatalog(): SubagentPromptRegistrationCatalog;
export declare function resolveSubagentHostProfile(loaded: LoadedAgentProfile, resources: {
    promptStacks: readonly LoadedPromptStack[];
    registrations?: SubagentPromptRegistrationCatalog;
}): SubagentHostResolution;
/**
 * Forge-native host-owned preparation: negotiate the client tool catalog
 * against stack policy and access facts, compile the resolved stack through
 * one compilation context, and append the protected delegated task. No
 * execution/runtime material (AgentRequest, preflight, limits, or plan
 * fingerprints) is involved; the optional package owns those.
 */
export declare function prepareForgeDelegation(input: ForgeDelegationPreparationInput): ForgeDelegationPreparation;
interface ForgeToolNegotiation {
    effectiveToolIds: string[];
    effectiveToolNames: string[];
    diagnostics: ForgeDelegationDiagnostic[];
}
/**
 * Intersect the client-supplied tool catalog with stack tool policy and the
 * prompt-compilation access facts. Semantics mirror the execution contract's
 * tool negotiation in the optional package, which recomputes them as the
 * plan-creation integrity check.
 */
export declare function negotiateForgeDelegationTools(catalog: readonly ForgeBackendTool[], policy: PromptResourcePolicy | undefined, access: ForgePromptAccessFacts): ForgeToolNegotiation;
export declare function collectSubagentPromptDependencies(stack: PromptStack, registrations?: SubagentPromptRegistrationCatalog): {
    dependencies: ForgePromptDependency[];
    missingDependencies: Array<{
        kind: ForgePromptDependencyKind;
        name: string;
    }>;
    diagnostics: ForgeDelegationDiagnostic[];
};
export {};
//# sourceMappingURL=subagent-host.d.ts.map