import { randomUUID } from "node:crypto";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	createExecutionRuntime,
	type ExecutionBackend,
	type ExecutionIntent,
	type ExecutionRuntime,
	type PreparedRun,
	type PromptRuntime,
	type RunResult,
} from "@zihanw/pi-subagent-runtime";
import {
	PI_READ_ONLY_TOOL_CATALOG,
	PiSubprocessBackend,
	sanitizePiSubprocessRunReport,
	type PiSubprocessBackendOptions,
	type PiSubprocessRunReport,
} from "@zihanw/pi-subagent-runtime/backends/subprocess";
import {
	PiRpcBackend,
	type PiRpcBackendOptions,
} from "@zihanw/pi-subagent-runtime/backends/rpc";
import type { PiForgeRuntimeState } from "../runtime-state.ts";
import { DEFAULT_SUBAGENT_BACKEND_ID } from "../forge-config.ts";
import {
	SUBAGENT_CONTRACT_VERSION,
	createAgentExecutionPlan,
	hasSubagentErrors,
	negotiateSubagentTools,
	type AgentExecutionPlan,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightAccepted,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
	type SubagentPreparedMessage,
	type SubagentPreparationOutput,
} from "../subagent/contract.ts";
import { prepareSubagentHostPlan, resolveSubagentHostProfile } from "../subagent-host.ts";

export interface ForgeSubagentPreparedRun {
	request: AgentRequest;
	preflight: BackendPreflightAccepted;
	plan: AgentExecutionPlan;
	diagnostics: SubagentDiagnostic[];
}

export type ForgeSubagentPreparationResult =
	| { ok: true; prepared: ForgeSubagentPreparedRun }
	| { ok: false; diagnostics: SubagentDiagnostic[] };

/** Host-facing execution update; phases match the runtime's run events. */
export interface SubagentBackendExecutionUpdate {
	phase: "starting" | "message" | "tool-result" | "finishing";
	message: string;
	details?: unknown;
}

export interface ForgeSubagentRuntime {
	/** Registered backend IDs, known without an extension context. */
	backendIds(): string[];
	descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
	prepare(profileId: string, task: string, ctx: ExtensionContext, run?: { backendId?: string }): Promise<ForgeSubagentPreparationResult>;
	discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
	execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse>;
	takeReport?(runId: string): PiSubprocessRunReport | undefined;
	dispose(): Promise<void>;
}

interface ReportCapableBackend extends ExecutionBackend {
	takeReport(preparedRunId: string): PiSubprocessRunReport | undefined;
	dispose(): Promise<void>;
}

export interface ForgeSubagentRuntimeOptions {
	/** Backend that executes prepared runs; defaults to the subprocess backend. */
	backendId?: string;
	subprocess?: Omit<PiSubprocessBackendOptions, "modelRegistry" | "cwd">;
	rpc?: Omit<PiRpcBackendOptions, "modelRegistry" | "cwd">;
}

interface RuntimeGeneration {
	runtime: ExecutionRuntime;
	backends: Map<string, ReportCapableBackend>;
	modelRegistry: ModelRegistry;
	cwd: string;
}

interface PreparedRecord {
	generation: RuntimeGeneration;
	handle: PreparedRun;
	backend: ReportCapableBackend;
}

export function createForgeSubagentRuntime(
	state: PiForgeRuntimeState,
	options: ForgeSubagentRuntimeOptions = {},
): ForgeSubagentRuntime {
	let generation: RuntimeGeneration | undefined;
	const prepared = new Map<string, PreparedRecord>();
	const reports = new Map<string, { backend: ReportCapableBackend; preparedRunId: string }>();
	// Backend IDs are fixed at construction; keep them available without an
	// extension context for command completions and settings validation.
	const backendIds = ["pi-subprocess-readonly", "pi-rpc-readonly"];

	function ensure(ctx: ExtensionContext): RuntimeGeneration {
		if (generation && generation.modelRegistry === ctx.modelRegistry && generation.cwd === ctx.cwd) return generation;
		if (generation) {
			void generation.runtime.dispose();
			for (const backend of generation.backends.values()) void backend.dispose();
		}
		const runtime = createExecutionRuntime();
		const subprocess = new PiSubprocessBackend({
			modelRegistry: ctx.modelRegistry,
			cwd: ctx.cwd,
			...options.subprocess,
		});
		const rpc = new PiRpcBackend({
			modelRegistry: ctx.modelRegistry,
			cwd: ctx.cwd,
			...options.rpc,
		});
		const backends = new Map<string, ReportCapableBackend>([
			[subprocess.descriptor.id, subprocess],
			[rpc.descriptor.id, rpc],
		]);
		for (const backend of backends.values()) runtime.registerBackend(backend);
		generation = { runtime, backends, modelRegistry: ctx.modelRegistry, cwd: ctx.cwd };
		return generation;
	}

	function descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[] {
		return ensure(ctx).runtime.listBackends().map(descriptorForHost);
	}

	async function prepare(profileId: string, task: string, ctx: ExtensionContext, run?: { backendId?: string }): Promise<ForgeSubagentPreparationResult> {
		const diagnostics: SubagentDiagnostic[] = [];
		if (!ctx.isProjectTrusted()) return { ok: false, diagnostics: [error("host.trust", "Project is not trusted; subagent profiles remain disabled.")] };
		const matches = state.profiles.filter((candidate) => candidate.profile.id === profileId);
		if (matches.length !== 1) {
			return { ok: false, diagnostics: [error(matches.length === 0 ? "host.profile-missing" : "host.profile-ambiguous", matches.length === 0 ? `Unknown agent profile: ${profileId}` : `Agent profile id is ambiguous: ${profileId}`)] };
		}
		const resolution = resolveSubagentHostProfile(matches[0]!, { promptStacks: state.stacks });
		diagnostics.push(...resolution.diagnostics);
		if (!resolution.snapshot || hasSubagentErrors(diagnostics)) return { ok: false, diagnostics };
		const snapshot = resolution.snapshot;

		const request: AgentRequest = {
			schemaVersion: SUBAGENT_CONTRACT_VERSION,
			requestId: `request:${randomUUID()}`,
			profileId,
			expectedProfileFingerprint: snapshot.profileFingerprint,
			input: { text: task },
			access: {
				level: "read-only",
				workspaces: [{ handle: "project", mode: "read-only" }],
				workingDirectory: { workspaceHandle: "project", path: "." },
				network: "allow",
				executionBoundary: "shared-user",
			},
			limits: { timeoutMs: { value: 60_000, enforcement: "best-effort" } },
			resultProjection: { maxChars: 12_000 },
			parent: { sessionId: ctx.sessionManager.getSessionId(), depth: 0, maxDepth: 1 },
			// The command layer obtains explicit user consent before execution. A dry plan
			// never transports data but prepares the exact request that would be executable.
			remoteEgressConsent: true,
		};
		const current = ensure(ctx);
		const backendId = run?.backendId ?? options.backendId ?? DEFAULT_SUBAGENT_BACKEND_ID;
		const backend = current.backends.get(backendId);
		if (!backend) return { ok: false, diagnostics: [error("host.backend", `Backend is not registered: ${backendId}`)] };
		const intent = executionIntentFor(request, snapshot);

		let hostPreparation: SubagentPreparationOutput | undefined;
		let handle: PreparedRun;
		try {
			handle = await prepareWithAbort(
				current.runtime.prepare({
					backendId,
					intent,
					compile: async (promptRuntime) => {
						const output = prepareSubagentHostPlan({
							request,
							snapshot,
							preflight: hostCompilePreflight(request, intent),
							runtime: promptRuntime,
						});
						hostPreparation = output;
						return {
							systemPrompt: output.systemPrompt,
							messages: output.messages.map(portableMessage),
						};
					},
				}),
				ctx.signal,
			);
		} catch (prepareError) {
			diagnostics.push(error("host.preparation", prepareError instanceof Error ? prepareError.message : String(prepareError)));
			return { ok: false, diagnostics };
		}

		const sealed = handle.snapshot();
		diagnostics.push(...sealed.preflight.diagnostics);
		if (!hostPreparation) {
			await handle.discard();
			diagnostics.push(error("host.preparation", "Host compilation did not complete."));
			return { ok: false, diagnostics };
		}
		diagnostics.push(...hostPreparation.diagnostics, ...hostPreparation.toolNegotiation.diagnostics);
		const planned = createAgentExecutionPlan({
			runId: handle.id,
			request,
			snapshot,
			preflight: preflightForHost(sealed.preflight),
			preparation: hostPreparation,
			runtime: sealed.promptRuntime,
		});
		diagnostics.push(...planned.diagnostics);
		if (!planned.plan || hasSubagentErrors(diagnostics)) {
			await handle.discard();
			return { ok: false, diagnostics };
		}
		// The runtime owns the execution fingerprint; the sealed value is the
		// single source of truth displayed for approval and bound to execution.
		planned.plan.executionFingerprint = sealed.executionFingerprint;
		prepared.set(handle.id, { generation: current, handle, backend });
		return { ok: true, prepared: { request, preflight: planned.plan.preflight, plan: planned.plan, diagnostics } };
	}

	async function discard(preparedRun: ForgeSubagentPreparedRun): Promise<void> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) return;
		prepared.delete(preparedRun.plan.runId);
		await record.handle.discard();
	}

	async function execute(preparedRun: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) throw new Error("Subagent prepared run is unknown to this runtime generation.");
		const current = ensure(ctx);
		if (record.generation !== current) throw new Error("Subagent prepared run belongs to a previous runtime generation.");
		prepared.delete(preparedRun.plan.runId);
		const run = current.runtime.execute(record.handle);
		reports.set(run.id, { backend: record.backend, preparedRunId: record.handle.id });
		if (onUpdate) {
			run.subscribe((event) => {
				onUpdate({
					phase: event.phase,
					message: event.message,
					...(event.details === undefined ? {} : { details: event.details }),
				});
			});
		}
		if (signal) {
			const cancel = () => { void run.cancel(cancelReason(signal)); };
			if (signal.aborted) cancel();
			else signal.addEventListener("abort", cancel, { once: true });
		}
		const result = await run.result;
		return responseForHost(preparedRun, result);
	}

	function takeReport(runId: string): PiSubprocessRunReport | undefined {
		const location = reports.get(runId);
		if (!location) return undefined;
		reports.delete(runId);
		const report = location.backend.takeReport(location.preparedRunId);
		return report ? sanitizePiSubprocessRunReport(report) : undefined;
	}

	async function dispose(): Promise<void> {
		prepared.clear();
		reports.clear();
		if (!generation) return;
		await generation.runtime.dispose();
		await Promise.all([...generation.backends.values()].map((backend) => backend.dispose()));
		generation = undefined;
	}

	return { backendIds: () => [...backendIds], descriptors, prepare, discard, execute, takeReport, dispose };
}

function executionIntentFor(request: AgentRequest, snapshot: import("../subagent/contract.ts").AgentProfileSnapshot): ExecutionIntent {
	const negotiation = negotiateSubagentTools(
		forgeToolCatalog(),
		snapshot.promptStack?.tools,
		request.access,
	);
	return {
		model: structuredClone(snapshot.profile.model),
		thinkingLevel: snapshot.profile.thinkingLevel,
		requestedTools: negotiation.effectiveToolNames,
		access: {
			level: request.access.level,
			executionBoundary: "shared-user",
			workspaces: structuredClone(request.access.workspaces),
			...(request.access.workingDirectory ? { workingDirectory: structuredClone(request.access.workingDirectory) } : {}),
			network: request.access.network,
			...(request.access.allowProcess === undefined ? {} : { allowProcess: request.access.allowProcess }),
		},
		limits: structuredClone(request.limits),
		provenance: {
			profile: snapshot.profileFingerprint,
			profileId: snapshot.profile.id,
			...(snapshot.promptStackFingerprint ? { promptStack: snapshot.promptStackFingerprint } : {}),
		},
	};
}

/** Minimal accepted preflight for the host compiler; only toolCatalog is read. */
function hostCompilePreflight(request: AgentRequest, intent: ExecutionIntent): BackendPreflightAccepted {
	return {
		status: "accepted",
		preflightId: "host-compile",
		backend: {
			id: "host-compile",
			version: "0",
			capabilities: {
				access: {
					readOnlyMountIsolation: false,
					readWriteMountIsolation: false,
					symlinkSafeContainment: false,
					processIsolation: false,
					agentNetworkIsolation: false,
				},
				executionBoundaries: ["shared-user"],
				limits: { timeoutMs: ["host-abort"], maxTurns: ["unsupported"], tokenBudget: ["unsupported"], maxOutputBytes: ["unsupported"] },
				cancellation: true,
				mediaMimeTypes: [],
				traceInspection: false,
				artifactRetention: false,
				remoteTransport: true,
				promptRuntimeFidelity: "backend-assisted",
			},
		},
		model: structuredClone(intent.model),
		thinkingLevel: (intent.thinkingLevel ?? "medium") as BackendPreflightAccepted["thinkingLevel"],
		toolCatalog: forgeToolCatalog(),
		access: {
			level: request.access.level,
			mounts: request.access.workspaces.map((workspace) => ({ workspaceHandle: workspace.handle, mountId: "host-workspace", mode: workspace.mode })),
			...(request.access.workingDirectory ? { workingDirectory: { mountId: "host-workspace", path: request.access.workingDirectory.path } } : {}),
			network: request.access.network,
			process: request.access.allowProcess === true,
			executionBoundary: "shared-user",
			enforcement: {
				readOnlyMountIsolation: false,
				readWriteMountIsolation: false,
				symlinkSafeContainment: false,
				processIsolation: false,
				agentNetworkIsolation: false,
			},
		},
		limits: {},
		diagnostics: [],
	};
}

function forgeToolCatalog(): BackendPreflightAccepted["toolCatalog"] {
	return PI_READ_ONLY_TOOL_CATALOG.map((tool) => ({
		...structuredClone(tool),
		effects: [...tool.effects],
	})) as BackendPreflightAccepted["toolCatalog"];
}

function preflightForHost(preflight: import("@zihanw/pi-subagent-runtime").BackendPreflightAccepted): BackendPreflightAccepted {
	return {
		status: "accepted",
		preflightId: preflight.preflightId,
		backend: descriptorForHost(preflight.backend),
		model: structuredClone(preflight.model),
		thinkingLevel: (preflight.thinkingLevel ?? "medium") as BackendPreflightAccepted["thinkingLevel"],
		toolCatalog: structuredClone(preflight.toolCatalog) as BackendPreflightAccepted["toolCatalog"],
		access: structuredClone(preflight.access) as BackendPreflightAccepted["access"],
		limits: structuredClone(preflight.limits) as BackendPreflightAccepted["limits"],
		...(preflight.promptRuntime ? { promptRuntime: preflight.promptRuntime } : {}),
		diagnostics: [...preflight.diagnostics].map((diagnostic) => ({ ...diagnostic })),
	};
}

function descriptorForHost(descriptor: import("@zihanw/pi-subagent-runtime").BackendDescriptor): SubagentBackendDescriptor {
	return {
		id: descriptor.id,
		version: descriptor.version,
		capabilities: {
			access: structuredClone(descriptor.capabilities.access),
			executionBoundaries: [...descriptor.capabilities.executionBoundaries],
			limits: structuredClone(descriptor.capabilities.limits) as SubagentBackendDescriptor["capabilities"]["limits"],
			cancellation: descriptor.capabilities.cancellation,
			mediaMimeTypes: [...descriptor.capabilities.mediaMimeTypes],
			traceInspection: false,
			artifactRetention: false,
			remoteTransport: descriptor.capabilities.remoteTransport,
			promptRuntimeFidelity: descriptor.capabilities.promptRuntimeFidelity,
		},
	};
}

function portableMessage(message: SubagentPreparedMessage): import("@zihanw/pi-subagent-runtime").PreparedMessage {
	return { role: message.role, content: structuredClone(message.content) };
}

function responseForHost(prepared: ForgeSubagentPreparedRun, result: RunResult): AgentResponse {
	const common = {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		requestId: prepared.request.requestId,
		runId: result.runId,
		backendId: result.backendId,
		profileFingerprint: prepared.plan.profile.profileFingerprint,
		executionFingerprint: result.executionFingerprint,
		model: structuredClone(result.model),
		effectiveToolIds: [...result.effectiveToolIds],
		enforcement: {
			access: structuredClone(result.enforcement.access) as AgentResponse["enforcement"]["access"],
			limits: structuredClone(result.enforcement.limits) as AgentResponse["enforcement"]["limits"],
		},
		durationMs: result.durationMs,
		artifacts: [],
		...(result.usage ? { usage: structuredClone(result.usage) } : {}),
	};
	const partialOutput = result.output ? { text: result.output.text, partial: true as const } : undefined;
	switch (result.status) {
		case "completed":
			return { ...common, status: "completed", output: { text: result.output.text, partial: false } };
		case "failed":
			return {
				...common,
				status: "failed",
				error: structuredClone(result.error),
				...(partialOutput ? { output: partialOutput } : {}),
			};
		case "cancelled":
			return {
				...common,
				status: "cancelled",
				reason: result.reason,
				...(partialOutput ? { output: partialOutput } : {}),
			};
		case "timed-out":
			return {
				...common,
				status: "timed-out",
				reason: result.reason,
				enforcedTimeoutMs: result.enforcedTimeoutMs,
				...(partialOutput ? { output: partialOutput } : {}),
			};
		case "limit-reached":
			return {
				...common,
				status: "limit-reached",
				reachedLimit: result.reachedLimit,
				...(partialOutput ? { output: partialOutput } : {}),
			};
	}
}

async function prepareWithAbort(promise: Promise<PreparedRun>, signal?: AbortSignal): Promise<PreparedRun> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.then((handle) => handle.discard()).catch(() => undefined);
		throw new Error("Subagent preparation was cancelled.");
	}
	return new Promise<PreparedRun>((resolve, reject) => {
		const onAbort = (): void => {
			void promise.then((handle) => handle.discard()).catch(() => undefined);
			reject(new Error("Subagent preparation was cancelled."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(handle) => {
				signal.removeEventListener("abort", onAbort);
				resolve(handle);
			},
			(prepareError) => {
				signal.removeEventListener("abort", onAbort);
				reject(prepareError);
			},
		);
	});
}

function cancelReason(signal: AbortSignal): string {
	return typeof signal.reason === "string" && signal.reason ? signal.reason : "Subagent execution cancelled.";
}

function error(code: string, message: string): SubagentDiagnostic {
	return { level: "error", code, message };
}
