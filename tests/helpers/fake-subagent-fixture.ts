import assert from "node:assert/strict";
import { AGENT_PROFILE_TYPE, type AgentProfile } from "../../src/agent-profile.ts";
import {
	SUBAGENT_CONTRACT_VERSION,
	createAgentExecutionPlan,
	negotiateSubagentTools,
	prepareSubagentInitialMessages,
	subagentFingerprint,
	subagentPromptStackFingerprint,
	subagentPromptRuntimeFingerprint,
	subagentSourceProfileFingerprint,
	type AgentExecutionPlan,
	type AgentProfileSnapshot,
	type AgentRequest,
	type BackendPreflightAccepted,
	type SubagentAccessCapabilities,
	type SubagentBackendTool,
	type SubagentPreparationOutput,
	type SubagentPreparationRuntime,
} from "../../src/subagent-contract.ts";
import type { PromptStack } from "../../src/types.ts";

export const FAKE_DIGEST = subagentFingerprint("fake-subagent-fixture");

const ACCESS_CAPABILITIES: SubagentAccessCapabilities = {
	readOnlyMountIsolation: true,
	readWriteMountIsolation: true,
	symlinkSafeContainment: true,
	processIsolation: true,
	agentNetworkIsolation: true,
};

export const FAKE_TOOL_CATALOG: SubagentBackendTool[] = [
	{ id: "tool.echo", name: "echo", effects: [] },
	{ id: "tool.read", name: "read", effects: ["filesystem-read"] },
	{ id: "tool.write", name: "write", effects: ["filesystem-write"] },
	{ id: "tool.shell", name: "shell", effects: ["process"] },
	{ id: "tool.web", name: "web", effects: ["network"] },
];

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
		schemaVersion: 1,
		profile,
		promptStack,
		dependencies: [],
		profileFingerprint: subagentSourceProfileFingerprint(profile),
		promptStackFingerprint: subagentPromptStackFingerprint(promptStack),
	};
}

export function fakePromptRuntime(fidelity: SubagentPreparationRuntime["fidelity"] = "backend-assisted"): SubagentPreparationRuntime {
	const runtime: Omit<SubagentPreparationRuntime, "promptRuntimeFingerprint"> = {
		baseSystemPrompt: "Base fake system prompt.",
		options: {
			selectedTools: ["echo", "read", "write", "shell", "web"],
			toolSnippets: { echo: "Echo input." },
			promptGuidelines: ["Use tools only when needed."],
			cwd: ".",
			contextFiles: [],
			skills: [],
		},
		model: { provider: "test", id: "model" },
		preparedAt: "2026-07-14T00:00:00.000Z",
		fidelity,
	};
	return { ...runtime, promptRuntimeFingerprint: subagentPromptRuntimeFingerprint(runtime) };
}

export function fakeAcceptedPreflight(input: {
	request?: AgentRequest;
	snapshot?: AgentProfileSnapshot;
} = {}): BackendPreflightAccepted {
	const request = input.request ?? fakeRequest();
	const snapshot = input.snapshot ?? fakeSnapshot();
	return {
		status: "accepted",
		preflightId: "fake-preflight-1",
		backend: {
			id: "fake-backend",
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
				remoteTransport: false,
				promptRuntimeFidelity: "backend-assisted",
			},
		},
		model: structuredClone(snapshot.profile.model),
		thinkingLevel: snapshot.profile.thinkingLevel,
		toolCatalog: structuredClone(FAKE_TOOL_CATALOG),
		access: accessReceipt(request),
		limits: {},
		diagnostics: [],
	};
}

export function createFakeExecutionPlan(input: {
	request?: AgentRequest;
	snapshot?: AgentProfileSnapshot;
	preflight?: BackendPreflightAccepted;
	runId?: string;
}): { request: AgentRequest; snapshot: AgentProfileSnapshot; preflight: BackendPreflightAccepted; preparation: SubagentPreparationOutput; plan: AgentExecutionPlan } {
	const request = input.request ?? fakeRequest();
	const snapshot = input.snapshot ?? fakeSnapshot();
	const preflight = input.preflight ?? fakeAcceptedPreflight({ request, snapshot });
	const initial = prepareSubagentInitialMessages(request, [
		{ role: "assistant", content: [{ type: "text", text: "Prepared stack message." }], source: "prompt-stack" },
	]);
	const preparation: SubagentPreparationOutput = {
		systemPrompt: "Prepared fake system prompt.",
		messages: initial.messages,
		contextBudget: initial.contextBudget,
		toolNegotiation: negotiateSubagentTools(preflight.toolCatalog, snapshot.promptStack?.tools, request.access),
		diagnostics: initial.diagnostics,
	};
	const planned = createAgentExecutionPlan({
		runId: input.runId ?? "run-1",
		request,
		snapshot,
		preflight,
		preparation,
		runtime: fakePromptRuntime("backend-assisted"),
	});
	assert.ok(planned.plan, planned.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
	return { request, snapshot, preflight, preparation, plan: planned.plan };
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
