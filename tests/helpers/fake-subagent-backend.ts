import assert from "node:assert/strict";
import { AGENT_PROFILE_TYPE, type AgentProfile } from "../../src/agent-profile.ts";
import {
	SUBAGENT_CONTRACT_VERSION,
	appendProtectedSubagentTask,
	createAgentExecutionPlan,
	negotiateSubagentTools,
	prepareSubagentInitialMessages,
	subagentFingerprint,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentExecutionPlan,
	type AgentProfileSnapshot,
	type AgentRequest,
	type BackendPreflightAccepted,
	type BackendPreflightResult,
	type SubagentAccessCapabilities,
	type SubagentBackendDescriptor,
	type SubagentBackendTool,
	type SubagentLimitEnforcement,
	type SubagentLimitName,
	type SubagentPreparationInput,
	type SubagentPreparationOutput,
} from "../../src/subagent-contract.ts";
import type {
	SubagentBackend,
	SubagentBackendCancelInput,
	SubagentBackendExecutionContext,
	SubagentBackendExecutionResult,
	SubagentBackendPreparationContext,
	SubagentBackendPreflightInput,
	SubagentBackendTraceInput,
} from "../../src/subagent/backend-registry.ts";
import { SubagentBackendRegistry } from "../../src/subagent/backend-registry.ts";
import type { PromptStack } from "../../src/types.ts";

export const FAKE_DIGEST = subagentFingerprint("fake-subagent-fixture");

export type FakeExecutionMode = "completed" | "failed" | "throw" | "delayed" | "limit-reached" | "artifact-trace" | "invalid";
export type FakePreflightMode = "accepted" | "rejected" | "omit-limits" | "under-enforced-access" | "mismatched-descriptor";

const ACCESS_CAPABILITIES: SubagentAccessCapabilities = {
	readOnlyMountIsolation: true,
	readWriteMountIsolation: true,
	symlinkSafeContainment: true,
	processIsolation: true,
	agentNetworkIsolation: true,
};

const TOOL_CATALOG: SubagentBackendTool[] = [
	{ id: "tool.echo", name: "echo", effects: [] },
	{ id: "tool.read", name: "read", effects: ["filesystem-read"] },
	{ id: "tool.write", name: "write", effects: ["filesystem-write"] },
	{ id: "tool.shell", name: "shell", effects: ["process"] },
	{ id: "tool.web", name: "web", effects: ["network"] },
];

export interface FakeBackendOptions {
	id?: string;
	fidelity?: SubagentBackendDescriptor["capabilities"]["promptRuntimeFidelity"];
	remoteTransport?: boolean;
	limitEnforcement?: Partial<Record<SubagentLimitName, Exclude<SubagentLimitEnforcement, "unsupported">>>;
}

export class DeterministicFakeSubagentBackend implements SubagentBackend {
	readonly descriptor: SubagentBackendDescriptor;
	preflightMode: FakePreflightMode = "accepted";
	executionMode: FakeExecutionMode = "completed";
	readonly preflightCalls: SubagentBackendPreflightInput[] = [];
	readonly preparationCalls: SubagentPreparationInput[] = [];
	readonly executionCalls: AgentExecutionPlan[] = [];
	readonly cancelCalls: SubagentBackendCancelInput[] = [];
	readonly traceCalls: SubagentBackendTraceInput[] = [];
	readonly executionStarted: Promise<void>;
	#resolveExecutionStarted!: () => void;
	#preflightCounter = 0;
	#releaseDelayed!: () => void;
	#delayed = new Promise<void>((resolve) => { this.#releaseDelayed = resolve; });
	readonly #limitEnforcement: FakeBackendOptions["limitEnforcement"];

	constructor(options: FakeBackendOptions = {}) {
		this.#limitEnforcement = options.limitEnforcement ?? {};
		this.descriptor = {
			id: options.id ?? "fake-backend",
			version: "1.0.0",
			capabilities: {
				access: { ...ACCESS_CAPABILITIES },
				limits: {
					timeoutMs: ["backend-hard", "host-abort"],
					maxTurns: ["backend-hard"],
					tokenBudget: ["backend-hard"],
					maxOutputBytes: ["backend-hard"],
				},
				cancellation: true,
				mediaMimeTypes: ["image/png"],
				traceInspection: true,
				artifactRetention: true,
				remoteTransport: options.remoteTransport ?? false,
				promptRuntimeFidelity: options.fidelity ?? "backend-assisted",
			},
		};
		this.executionStarted = new Promise<void>((resolve) => { this.#resolveExecutionStarted = resolve; });
	}

	preflight(input: SubagentBackendPreflightInput): BackendPreflightResult {
		this.preflightCalls.push(structuredClone(input));
		const preflightId = `preflight-${++this.#preflightCounter}`;
		if (this.preflightMode === "rejected") {
			return {
				status: "rejected",
				preflightId,
				backend: structuredClone(this.descriptor),
				diagnostics: [{ level: "error", code: "fake.rejected", message: "Fake backend rejected the request." }],
			};
		}
		const limits: BackendPreflightAccepted["limits"] = {};
		if (this.preflightMode !== "omit-limits") {
			for (const name of ["timeoutMs", "maxTurns", "tokenBudget", "maxOutputBytes"] as const) {
				const requirement = input.request.limits[name];
				if (!requirement) continue;
				limits[name] = {
					value: requirement.value,
					enforcement: this.#limitEnforcement?.[name] ?? "backend-hard",
				};
			}
		}
		const access = accessReceipt(input.request);
		if (this.preflightMode === "under-enforced-access") access.enforcement.readOnlyMountIsolation = false;
		const descriptor = structuredClone(this.descriptor);
		if (this.preflightMode === "mismatched-descriptor") descriptor.version = "unexpected";
		return {
			status: "accepted",
			preflightId,
			backend: descriptor,
			model: structuredClone(input.snapshot.profile.model),
			thinkingLevel: input.snapshot.profile.thinkingLevel,
			toolCatalog: structuredClone(TOOL_CATALOG),
			access,
			limits,
			diagnostics: [],
		};
	}

	async prepare(input: SubagentPreparationInput, context: SubagentBackendPreparationContext): Promise<SubagentPreparationOutput> {
		this.preparationCalls.push(structuredClone(input));
		return context.prepare(input);
	}

	async execute(plan: AgentExecutionPlan, _context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult> {
		this.executionCalls.push(structuredClone(plan));
		this.#resolveExecutionStarted();
		if (this.executionMode === "throw") throw new Error("Fake provider transport failed.");
		if (this.executionMode === "delayed") await this.#delayed;
		const common = backendResponseCommon(plan);
		if (this.executionMode === "failed") {
			return { ...common, status: "failed", error: { code: "provider", message: "Fake provider failed.", retryable: true } };
		}
		if (this.executionMode === "limit-reached") {
			return { ...common, status: "limit-reached", reachedLimit: "maxTurns" };
		}
		if (this.executionMode === "artifact-trace") {
			return {
				...common,
				status: "completed",
				output: { text: "artifact complete", partial: false },
				artifacts: [{
					id: "artifact-1",
					workspaceNamespace: "workspace.main",
					path: "reports/result.md",
					authorization: "read",
					lifetime: "run",
					cleanup: "backend",
				}],
				trace: { id: "backend-trace-1", expiresAt: "2099-01-01T00:00:00.000Z" },
			};
		}
		if (this.executionMode === "invalid") {
			return { ...common, requestId: "wrong-request", status: "completed", output: { text: "invalid", partial: false } };
		}
		return { ...common, status: "completed", output: { text: "fake complete", partial: false } };
	}

	cancel(input: SubagentBackendCancelInput): void {
		this.cancelCalls.push(structuredClone(input));
	}

	inspectTrace(input: SubagentBackendTraceInput): unknown {
		this.traceCalls.push(structuredClone(input));
		return { backendTraceId: input.traceId, events: ["prepared", "executed"] };
	}

	releaseDelayedExecution(): void {
		this.#releaseDelayed();
	}
}

export function fakeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		requestId: "request-1",
		profileId: "worker",
		input: { text: "Perform the delegated task." },
		access: { level: "none", workspaces: [], network: "deny" },
		limits: {},
		resultProjection: { maxChars: 4_000 },
		parent: { depth: 0, maxDepth: 2 },
		remoteEgressConsent: false,
		...overrides,
	};
}

export function fakeSnapshot(stackOverrides: Partial<PromptStack> = {}): AgentProfileSnapshot {
	const profile: AgentProfile = {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "worker",
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		promptStack: "worker",
	};
	const promptStack: PromptStack = {
		schemaVersion: 1,
		id: "worker",
		mode: "replace",
		tools: { allow: ["echo", "read", "write", "shell", "web"] },
		items: [{ kind: "block", id: "system", role: "system", content: "You are a fake worker." }],
		...stackOverrides,
	};
	return {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		profile,
		promptStack,
		dependencies: [],
		profileFingerprint: subagentSourceProfileFingerprint(profile),
		promptStackFingerprint: subagentPromptStackFingerprint(promptStack),
	};
}

export async function createFakeExecutionPlan(input: {
	registry: SubagentBackendRegistry;
	backend: DeterministicFakeSubagentBackend;
	request?: AgentRequest;
	snapshot?: AgentProfileSnapshot;
	runId?: string;
}): Promise<{ request: AgentRequest; snapshot: AgentProfileSnapshot; preflight: BackendPreflightAccepted; preparation: SubagentPreparationOutput; plan: AgentExecutionPlan }> {
	const request = input.request ?? fakeRequest();
	const snapshot = input.snapshot ?? fakeSnapshot();
	const preflight = await input.registry.preflight(input.backend.descriptor.id, request, snapshot);
	assert.equal(preflight.status, "accepted", preflight.diagnostics.map((item) => item.message).join("; "));
	const runtime = {
		baseSystemPrompt: "Base fake system prompt.",
		promptRuntimeFingerprint: FAKE_DIGEST,
		fidelity: input.backend.descriptor.capabilities.promptRuntimeFidelity === "backend-assisted" ? "backend-assisted" as const : "exact-preflight" as const,
	};
	const preparationInput = { request, snapshot, preflight, runtime };
	const preparation = await input.registry.prepare(input.backend.descriptor.id, preparationInput, (candidate) => {
		const messages = prepareSubagentInitialMessages(candidate.request, [
			{ role: "assistant", content: [{ type: "text", text: "Prepared stack message." }], source: "prompt-stack" },
		]);
		return {
			systemPrompt: "Prepared fake system prompt.",
			messages: messages.messages,
			contextBudget: messages.contextBudget,
			toolNegotiation: negotiateSubagentTools(candidate.preflight.toolCatalog, candidate.snapshot.promptStack?.tools, candidate.request.access),
			diagnostics: messages.diagnostics,
		};
	});
	const planned = createAgentExecutionPlan({
		runId: input.runId ?? "run-1",
		request,
		snapshot,
		preflight,
		preparation,
		runtime,
	});
	assert.ok(planned.plan, planned.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
	return { request, snapshot, preflight, preparation, plan: planned.plan };
}

export function deterministicRegistry(): SubagentBackendRegistry {
	let preflight = 0;
	let trace = 0;
	return new SubagentBackendRegistry({
		idFactory: (kind) => kind === "preflight" ? `registry-preflight-${++preflight}` : `trace-${++trace}`,
	});
}

function accessReceipt(request: AgentRequest): BackendPreflightAccepted["access"] {
	const mounts = request.access.workspaces.map((workspace, index) => ({
		workspaceHandle: workspace.handle,
		mountId: `mount-${index + 1}`,
		mode: workspace.mode,
	}));
	const requestedWorkingDirectory = request.access.workingDirectory;
	const workingMount = requestedWorkingDirectory
		? mounts.find((mount) => mount.workspaceHandle === requestedWorkingDirectory.workspaceHandle)
		: undefined;
	return {
		level: request.access.level,
		mounts,
		workingDirectory: requestedWorkingDirectory && workingMount
			? { mountId: workingMount.mountId, path: requestedWorkingDirectory.path }
			: undefined,
		network: request.access.network,
		process: request.access.allowProcess === true,
		enforcement: { ...ACCESS_CAPABILITIES },
	};
}

function backendResponseCommon(plan: AgentExecutionPlan) {
	return {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		requestId: plan.requestId,
		runId: plan.runId,
		backendId: plan.backendId,
		profileFingerprint: plan.profile.profileFingerprint,
		executionFingerprint: plan.executionFingerprint,
		model: structuredClone(plan.model),
		effectiveToolIds: [...plan.effectiveToolIds],
		enforcement: { access: structuredClone(plan.access), limits: structuredClone(plan.limits) },
		durationMs: 999,
		artifacts: [],
	};
}
