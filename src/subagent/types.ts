import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentProfile, AgentProfileModelReference } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import type {
	AccessCapabilities,
	AccessLevel,
	AccessReceipt,
	AccessRequest,
	BackendCapabilities,
	BackendDescriptor,
	BackendTool,
	Diagnostic,
	DiagnosticLevel,
	EnforcedLimit,
	Fingerprint,
	LimitEnforcement,
	LimitName,
	LimitReceipt,
	LimitRequest,
	LimitRequirement,
	LimitRequirementLevel,
	MediaReference,
	MountMapping,
	NetworkPolicy,
	WorkspaceMode,
	WorkspaceRequest,
	WorkingDirectoryRequest,
	PreparedContentPart,
	PreparedMessage,
	PreparedMessageRole,
	PromptRuntime,
	PromptRuntimeOptions,
	PromptRuntimeSkill,
	RunError,
	RunUsage,
	ToolEffect,
	ExecutionBoundary,
} from "@zihanw/pi-subagent-runtime";

export const SUBAGENT_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Portable execution leaves owned by @zihanw/pi-subagent-runtime core.
//
// The runtime package is the single source of truth for the portable
// execution contract (intent, access, limits, tools, prepared messages,
// prompt runtime, diagnostics, usage, enforcement receipts). Forge re-exports
// them here under the `Subagent`-prefixed names the 0.4 host contract already
// used, so existing imports stay source-compatible without maintaining a
// parallel portable definition.
// ---------------------------------------------------------------------------

export type SubagentFingerprint = Fingerprint;
export { FINGERPRINT_PREFIX as SUBAGENT_FINGERPRINT_PREFIX } from "@zihanw/pi-subagent-runtime";
export type SubagentDiagnosticLevel = DiagnosticLevel;
export type SubagentDiagnostic = Diagnostic;
export type SubagentMediaReference = MediaReference;
export type SubagentAccessLevel = AccessLevel;
export type SubagentWorkspaceMode = WorkspaceMode;
export type SubagentNetworkPolicy = NetworkPolicy;
export type SubagentExecutionBoundary = ExecutionBoundary;
export type SubagentWorkspaceRequest = WorkspaceRequest;
export type SubagentWorkingDirectoryRequest = WorkingDirectoryRequest;
export type SubagentAccessRequest = AccessRequest;
export type SubagentLimitName = LimitName;
export type SubagentLimitEnforcementPreference = LimitRequirementLevel;
export type SubagentLimitRequirement = LimitRequirement;
export type SubagentLimitRequest = LimitRequest;
export type SubagentToolEffect = ToolEffect;
export type SubagentBackendTool = BackendTool;
export type SubagentAccessCapabilities = AccessCapabilities;
export type SubagentLimitEnforcement = LimitEnforcement;
export type SubagentMountMapping = MountMapping;
export type SubagentEnforcedLimit = EnforcedLimit;
export type SubagentLimitReceipt = LimitReceipt;
export type SubagentPreparedMessageRole = PreparedMessageRole;
export type SubagentPreparedContentPart = PreparedContentPart;
export type SubagentPromptRuntimeSkill = PromptRuntimeSkill;
export type SubagentPromptRuntimeOptions = PromptRuntimeOptions;
export type SubagentUsage = RunUsage;
export type SubagentError = RunError;
export type SubagentAccessReceipt = AccessReceipt;
export type SubagentPreparationRuntime = PromptRuntime;

// ---------------------------------------------------------------------------
// Forge host extensions over the runtime portable contract.
//
// The runtime's portable descriptor carries no artifact/trace capability
// (those were treated as speculative and dropped from the portable surface).
// Forge advertises the two extra booleans as host-side contract terms that
// the shipped process backends always set false, and the profile-snapshot
// host validators still recognize them. Prepared messages additionally carry
// host-only `protectedTask`/`source` bookkeeping that the runtime's portable
// message does not need.
// ---------------------------------------------------------------------------

export type SubagentBackendCapabilities = BackendCapabilities & {
	traceInspection: boolean;
	artifactRetention: boolean;
};

export type SubagentBackendDescriptor = Omit<BackendDescriptor, "capabilities"> & {
	capabilities: SubagentBackendCapabilities;
};

export type SubagentPreparedMessage = PreparedMessage & {
	protectedTask?: boolean;
	source?: "selected-context" | "prompt-stack" | "delegated-task";
};

// ---------------------------------------------------------------------------
// Forge host-side contract. These product types are not portable execution
// artifacts: they layer Forge's profile/prompt-stack surface over the runtime
// contract. Their component portable types (above) come from the runtime.
// ---------------------------------------------------------------------------

export interface SubagentTaskInput {
	text: string;
	media?: SubagentMediaReference[];
}

export type SubagentContextItemKind = "summary" | "user-excerpt" | "assistant-excerpt" | "tool-result-excerpt" | "resource-excerpt";

export interface SubagentContextProvenance {
	source: string;
	reference?: string;
}

export interface SubagentContextItem {
	id: string;
	kind: SubagentContextItemKind;
	text: string;
	required?: boolean;
	provenance: SubagentContextProvenance;
}

export interface SubagentSelectedContext {
	maxBytes: number;
	items: SubagentContextItem[];
}

export interface AgentRequest {
	schemaVersion: typeof SUBAGENT_CONTRACT_VERSION;
	requestId: string;
	profileId: string;
	expectedProfileFingerprint?: SubagentFingerprint;
	input: SubagentTaskInput;
	selectedContext?: SubagentSelectedContext;
	access: SubagentAccessRequest;
	limits: SubagentLimitRequest;
	resultProjection: { maxChars: number };
	parent: {
		runId?: string;
		sessionId?: string;
		depth: number;
		maxDepth: number;
	};
	remoteEgressConsent: boolean;
}

export type SubagentDependencyKind = "macro" | "slot";

export interface SubagentPromptDependency {
	kind: SubagentDependencyKind;
	name: string;
	identity: string;
	source?: string;
}

export interface AgentProfileSnapshot {
	schemaVersion: typeof SUBAGENT_CONTRACT_VERSION;
	/** Canonical scoped selector of the resolved profile (`project:<id>` or `global:<id>`). */
	profileId: string;
	profile: AgentProfile;
	/** Canonical scoped selector of the resolved prompt stack, or null. */
	promptStackId: string | null;
	promptStack: PromptStack | null;
	dependencies: SubagentPromptDependency[];
	profileFingerprint: SubagentFingerprint;
	promptStackFingerprint: SubagentFingerprint | null;
}

export interface SubagentToolNegotiationResult {
	effectiveToolIds: string[];
	effectiveToolNames: string[];
	stackSelectedToolNames: string[];
	unmatchedAllowPatterns: string[];
	diagnostics: SubagentDiagnostic[];
}

export interface SubagentContextBudgetReceipt {
	maxBytes: number;
	includedBytes: number;
	includedItemIds: string[];
	omittedItemIds: string[];
}

export interface BackendPreflightAccepted {
	status: "accepted";
	preflightId: string;
	backend: SubagentBackendDescriptor;
	model: AgentProfileModelReference;
	thinkingLevel: ThinkingLevel;
	toolCatalog: SubagentBackendTool[];
	access: SubagentAccessReceipt;
	limits: SubagentLimitReceipt;
	promptRuntime?: SubagentPreparationRuntime;
	diagnostics: SubagentDiagnostic[];
}

export interface BackendPreflightRejected {
	status: "rejected";
	preflightId: string;
	backend: SubagentBackendDescriptor;
	diagnostics: SubagentDiagnostic[];
}

export type BackendPreflightResult = BackendPreflightAccepted | BackendPreflightRejected;

export interface SubagentPreparationBaseInput {
	request: AgentRequest;
	snapshot: AgentProfileSnapshot;
	preflight: BackendPreflightAccepted;
}

export interface SubagentPreparationInput extends SubagentPreparationBaseInput {
	runtime: SubagentPreparationRuntime;
}

export interface SubagentPreparationOutput {
	systemPrompt: string;
	messages: SubagentPreparedMessage[];
	toolNegotiation: SubagentToolNegotiationResult;
	contextBudget?: SubagentContextBudgetReceipt;
	diagnostics: SubagentDiagnostic[];
}

export interface SubagentPreparationResult {
	runtime: SubagentPreparationRuntime;
	preparation: SubagentPreparationOutput;
}

export type SubagentHostPlanPreparer = (input: SubagentPreparationInput) => Promise<SubagentPreparationOutput> | SubagentPreparationOutput;

export interface AgentExecutionPlan {
	schemaVersion: typeof SUBAGENT_CONTRACT_VERSION;
	runId: string;
	requestId: string;
	backendId: string;
	preflightId: string;
	preflight: BackendPreflightAccepted;
	profile: AgentProfileSnapshot;
	model: AgentProfileModelReference;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	messages: SubagentPreparedMessage[];
	effectiveToolIds: string[];
	access: SubagentAccessReceipt;
	limits: SubagentLimitReceipt;
	contextBudget?: SubagentContextBudgetReceipt;
	resultProjection: AgentRequest["resultProjection"];
	promptRuntimeFingerprint: SubagentFingerprint;
	/** Runtime-issued fingerprint of the sealed system prompt and ordered messages. */
	conversationFingerprint: SubagentFingerprint;
	/**
	 * Runtime-issued fingerprint binding the sealed conversation to the
	 * accepted backend, preflight, tools, and limits. The host never computes
	 * this value; it displays and propagates the sealed fingerprint so approval
	 * and execution stay bound to the exact plan the runtime sealed.
	 */
	executionFingerprint: SubagentFingerprint;
}

export type SubagentArtifactLifetime = "run" | "session" | "persistent";

export type SubagentArtifactAuthorization = "read" | "write";

export interface SubagentArtifactReference {
	id: string;
	workspaceNamespace: string;
	path: string;
	authorization: SubagentArtifactAuthorization;
	lifetime: SubagentArtifactLifetime;
	cleanup: "backend" | "host" | "user";
}

export interface SubagentTraceReference {
	handle: string;
	backendId: string;
	authorizationScope: string;
	expiresAt?: string;
}

export interface AgentResponseCommon {
	schemaVersion: typeof SUBAGENT_CONTRACT_VERSION;
	requestId: string;
	runId: string;
	backendId: string;
	profileFingerprint: SubagentFingerprint;
	executionFingerprint: SubagentFingerprint;
	model: AgentProfileModelReference;
	effectiveToolIds: string[];
	enforcement: {
		access: SubagentAccessReceipt;
		limits: SubagentLimitReceipt;
	};
	durationMs: number;
	artifacts: SubagentArtifactReference[];
	trace?: SubagentTraceReference;
	usage?: SubagentUsage;
}

export interface AgentResponseCompleted extends AgentResponseCommon {
	status: "completed";
	output?: { text: string; partial: false };
}

export interface AgentResponseFailed extends AgentResponseCommon {
	status: "failed";
	error: SubagentError;
	output?: { text: string; partial: true };
}

export interface AgentResponseCancelled extends AgentResponseCommon {
	status: "cancelled";
	reason: string;
	output?: { text: string; partial: true };
}

export interface AgentResponseTimedOut extends AgentResponseCommon {
	status: "timed-out";
	reason: string;
	enforcedTimeoutMs: number;
	output?: { text: string; partial: true };
}

export interface AgentResponseLimitReached extends AgentResponseCommon {
	status: "limit-reached";
	reachedLimit: SubagentLimitName;
	output?: { text: string; partial: true };
}

export type AgentResponse =
	| AgentResponseCompleted
	| AgentResponseFailed
	| AgentResponseCancelled
	| AgentResponseTimedOut
	| AgentResponseLimitReached;

export interface SubagentContextBudgetResult {
	items: SubagentContextItem[];
	receipt: SubagentContextBudgetReceipt;
	diagnostics: SubagentDiagnostic[];
}

export interface SubagentInitialMessagesResult {
	messages: SubagentPreparedMessage[];
	contextBudget?: SubagentContextBudgetReceipt;
	diagnostics: SubagentDiagnostic[];
}