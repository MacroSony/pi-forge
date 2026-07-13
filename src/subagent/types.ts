import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentProfile, AgentProfileModelReference } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";

export const SUBAGENT_CONTRACT_VERSION = 1 as const;

export const SUBAGENT_FINGERPRINT_PREFIX = "sha256:v1:" as const;

export type SubagentFingerprint = `${typeof SUBAGENT_FINGERPRINT_PREFIX}${string}`;

export type SubagentDiagnosticLevel = "error" | "warning" | "info";

export interface SubagentDiagnostic {
	level: SubagentDiagnosticLevel;
	code: string;
	message: string;
	path?: string;
}

export interface SubagentMediaReference {
	id: string;
	kind: "image";
	mimeType: string;
	digest: SubagentFingerprint;
	resourceHandle: string;
}

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

export type SubagentAccessLevel = "none" | "read-only" | "workspace-write";

export type SubagentWorkspaceMode = "read-only" | "read-write";

export type SubagentNetworkPolicy = "deny" | "allow";

export interface SubagentWorkspaceRequest {
	handle: string;
	mode: SubagentWorkspaceMode;
}

export interface SubagentWorkingDirectoryRequest {
	workspaceHandle: string;
	path: string;
}

export interface SubagentAccessRequest {
	level: SubagentAccessLevel;
	workspaces: SubagentWorkspaceRequest[];
	workingDirectory?: SubagentWorkingDirectoryRequest;
	network: SubagentNetworkPolicy;
	allowProcess?: boolean;
}

export type SubagentLimitName = "timeoutMs" | "maxTurns" | "tokenBudget" | "maxOutputBytes";

export type SubagentLimitEnforcementPreference = "required" | "best-effort";

export interface SubagentLimitRequirement {
	value: number;
	enforcement: SubagentLimitEnforcementPreference;
}

export type SubagentLimitRequest = Partial<Record<SubagentLimitName, SubagentLimitRequirement>>;

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
	profile: AgentProfile;
	promptStack: PromptStack | null;
	dependencies: SubagentPromptDependency[];
	profileFingerprint: SubagentFingerprint;
	promptStackFingerprint: SubagentFingerprint | null;
}

export type SubagentToolEffect = "filesystem-read" | "filesystem-write" | "process" | "network";

export interface SubagentBackendTool {
	id: string;
	name: string;
	description?: string;
	promptSnippet?: string;
	effects: SubagentToolEffect[];
	adapterMapping?: string;
}

export interface SubagentAccessCapabilities {
	readOnlyMountIsolation: boolean;
	readWriteMountIsolation: boolean;
	symlinkSafeContainment: boolean;
	processIsolation: boolean;
	agentNetworkIsolation: boolean;
}

export type SubagentLimitEnforcement = "backend-hard" | "host-abort" | "best-effort" | "unsupported";

export interface SubagentBackendCapabilities {
	access: SubagentAccessCapabilities;
	limits: Record<SubagentLimitName, SubagentLimitEnforcement[]>;
	cancellation: boolean;
	mediaMimeTypes: string[];
	traceInspection: boolean;
	artifactRetention: boolean;
	remoteTransport: boolean;
	promptRuntimeFidelity: "exact-preflight" | "backend-assisted" | "partial";
}

export interface SubagentBackendDescriptor {
	id: string;
	version: string;
	capabilities: SubagentBackendCapabilities;
}

export interface SubagentMountMapping {
	workspaceHandle: string;
	mountId: string;
	mode: SubagentWorkspaceMode;
}

export interface SubagentAccessReceipt {
	level: SubagentAccessLevel;
	mounts: SubagentMountMapping[];
	workingDirectory?: { mountId: string; path: string };
	network: SubagentNetworkPolicy;
	process: boolean;
	enforcement: SubagentAccessCapabilities;
}

export interface SubagentEnforcedLimit {
	value: number;
	enforcement: Exclude<SubagentLimitEnforcement, "unsupported">;
}

export type SubagentLimitReceipt = Partial<Record<SubagentLimitName, SubagentEnforcedLimit>>;

export interface BackendPreflightAccepted {
	status: "accepted";
	preflightId: string;
	backend: SubagentBackendDescriptor;
	model: AgentProfileModelReference;
	thinkingLevel: ThinkingLevel;
	toolCatalog: SubagentBackendTool[];
	access: SubagentAccessReceipt;
	limits: SubagentLimitReceipt;
	diagnostics: SubagentDiagnostic[];
}

export interface BackendPreflightRejected {
	status: "rejected";
	preflightId: string;
	backend: SubagentBackendDescriptor;
	diagnostics: SubagentDiagnostic[];
}

export type BackendPreflightResult = BackendPreflightAccepted | BackendPreflightRejected;

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

export type SubagentPreparedMessageRole = "user" | "assistant" | "custom";

export type SubagentPreparedContentPart =
	| { type: "text"; text: string }
	| { type: "media"; mediaId: string; mimeType: string; digest: SubagentFingerprint; backendResourceId?: string };

export interface SubagentPreparedMessage {
	role: SubagentPreparedMessageRole;
	content: SubagentPreparedContentPart[];
	protectedTask?: boolean;
	source?: "selected-context" | "prompt-stack" | "delegated-task";
}

export interface SubagentPreparationRuntime {
	baseSystemPrompt: string;
	promptRuntimeFingerprint: SubagentFingerprint;
	fidelity: "exact-preflight" | "backend-assisted";
}

export interface SubagentPreparationInput {
	request: AgentRequest;
	snapshot: AgentProfileSnapshot;
	preflight: BackendPreflightAccepted;
	runtime: SubagentPreparationRuntime;
}

export interface SubagentPreparationOutput {
	systemPrompt: string;
	messages: SubagentPreparedMessage[];
	toolNegotiation: SubagentToolNegotiationResult;
	contextBudget?: SubagentContextBudgetReceipt;
	diagnostics: SubagentDiagnostic[];
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

export interface SubagentUsage {
	tokens?: {
		input: number;
		output: number;
		total: number;
		tokenizer?: string;
	};
	cost?: { amount: number; currency: string };
}

export interface SubagentError {
	code: string;
	message: string;
	retryable?: boolean;
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
