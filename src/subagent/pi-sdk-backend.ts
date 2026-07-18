import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	type ModelRuntime,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_CONTRACT_VERSION,
	canonicalSubagentJson,
	subagentPromptRuntimeFingerprint,
	type AgentExecutionPlan,
	type BackendPreflightAccepted,
	type BackendPreflightResult,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
	type SubagentPreparationResult,
	type SubagentPreparationRuntime,
	type SubagentPreparedMessage,
} from "./contract.ts";
import type {
	SubagentBackend,
	SubagentBackendCancelInput,
	SubagentBackendExecutionContext,
	SubagentBackendExecutionResult,
	SubagentBackendPreparationContext,
	SubagentBackendPreflightInput,
} from "./backend-registry.ts";
import { modelRuntimeFromRegistry } from "./pi-model-runtime.ts";

export const PI_SDK_ISOLATED_BACKEND_ID = "pi-sdk-isolated";

const ISOLATED_BASE_PROMPT = [
	"You are an isolated subagent.",
	"Complete the delegated task using only the supplied prompt and context.",
	"You have no tools, filesystem access, process access, or agent-controlled network access.",
].join("\n");

const ACCESS_CAPABILITIES = {
	readOnlyMountIsolation: false,
	readWriteMountIsolation: false,
	symlinkSafeContainment: false,
	processIsolation: false,
	agentNetworkIsolation: true,
} as const;

export const PI_SDK_ISOLATED_BACKEND_DESCRIPTOR: SubagentBackendDescriptor = {
	id: PI_SDK_ISOLATED_BACKEND_ID,
	version: "0.1.0",
	capabilities: {
		access: { ...ACCESS_CAPABILITIES },
		limits: {
			timeoutMs: ["host-abort"],
			maxTurns: ["unsupported"],
			tokenBudget: ["unsupported"],
			maxOutputBytes: ["unsupported"],
		},
		cancellation: true,
		mediaMimeTypes: [],
		traceInspection: false,
		artifactRetention: false,
		remoteTransport: true,
		promptRuntimeFidelity: "backend-assisted",
	},
};

interface PrimedPiSdkRun {
	preflightId: string;
	requestId: string;
	result: SubagentPreparationResult;
	session: AgentSession;
	tempDir: string;
	providerGate: Deferred<void>;
	execution: Promise<PiSdkTerminalResult>;
	runId?: string;
	disposed: boolean;
}

interface PiSdkTerminalResult {
	status: "completed" | "failed" | "cancelled";
	output?: string;
	error?: string;
}

export interface PiSdkIsolatedBackendOptions {
	modelRegistry: ModelRegistry;
	modelRuntime?: ModelRuntime;
	now?: () => Date;
	idFactory?: () => string;
}

export class PiSdkIsolatedBackend implements SubagentBackend {
	readonly descriptor = structuredClone(PI_SDK_ISOLATED_BACKEND_DESCRIPTOR);
	readonly #modelRegistry: ModelRegistry;
	readonly #modelRuntime: ModelRuntime;
	readonly #now: () => Date;
	readonly #idFactory: () => string;
	readonly #primed = new Map<string, PrimedPiSdkRun>();
	readonly #active = new Map<string, PrimedPiSdkRun>();

	constructor(options: PiSdkIsolatedBackendOptions) {
		this.#modelRegistry = options.modelRegistry;
		this.#modelRuntime = options.modelRuntime ?? modelRuntimeFromRegistry(options.modelRegistry);
		this.#now = options.now ?? (() => new Date());
		this.#idFactory = options.idFactory ?? (() => `pi-sdk-preflight:${randomUUID()}`);
	}

	preflight(input: SubagentBackendPreflightInput): BackendPreflightResult {
		const diagnostics: SubagentDiagnostic[] = [];
		if (input.request.access.level !== "none" || input.request.access.workspaces.length > 0 || input.request.access.allowProcess === true) {
			diagnostics.push(errorDiagnostic("pi-sdk.access", "The isolated Pi SDK backend currently accepts only access none without workspaces or process access.", "access"));
		}
		if (input.request.access.network !== "deny") diagnostics.push(errorDiagnostic("pi-sdk.network", "The isolated Pi SDK backend requires agent network policy deny.", "access.network"));
		if ((input.request.input.media?.length ?? 0) > 0) diagnostics.push(errorDiagnostic("pi-sdk.media", "The first isolated Pi SDK backend iteration supports text tasks only.", "input.media"));
		for (const name of ["maxTurns", "tokenBudget", "maxOutputBytes"] as const) {
			const requirement = input.request.limits[name];
			if (requirement?.enforcement === "required") diagnostics.push(errorDiagnostic("pi-sdk.limit", `${name} cannot be enforced by the isolated Pi SDK backend.`, `limits.${name}`));
			else if (requirement) diagnostics.push(warningDiagnostic("pi-sdk.limit-ignored", `${name} is unsupported and will not be accepted.`, `limits.${name}`));
		}

		const model = this.#modelRegistry.find(input.snapshot.profile.model.provider, input.snapshot.profile.model.id);
		if (!model) diagnostics.push(errorDiagnostic("pi-sdk.model", `Unknown model: ${input.snapshot.profile.model.provider}/${input.snapshot.profile.model.id}`, "profile.model"));
		else {
			if (!this.#modelRegistry.hasConfiguredAuth(model)) diagnostics.push(errorDiagnostic("pi-sdk.auth", `Model ${model.provider}/${model.id} has no configured authentication.`, "profile.model"));
			const effectiveThinking = clampThinkingLevel(model, input.snapshot.profile.thinkingLevel);
			if (effectiveThinking !== input.snapshot.profile.thinkingLevel) diagnostics.push(errorDiagnostic("pi-sdk.thinking", `Model ${model.provider}/${model.id} would clamp thinking level ${input.snapshot.profile.thinkingLevel} to ${effectiveThinking}.`, "profile.thinkingLevel"));
		}

		const preflightId = this.#idFactory();
		if (diagnostics.some((diagnostic) => diagnostic.level === "error") || !model) {
			return { status: "rejected", preflightId, backend: structuredClone(this.descriptor), diagnostics };
		}
		const limits: BackendPreflightAccepted["limits"] = {};
		if (input.request.limits.timeoutMs) limits.timeoutMs = { value: input.request.limits.timeoutMs.value, enforcement: "host-abort" };
		return {
			status: "accepted",
			preflightId,
			backend: structuredClone(this.descriptor),
			model: { provider: model.provider, id: model.id },
			thinkingLevel: input.snapshot.profile.thinkingLevel,
			toolCatalog: [],
			access: {
				level: "none",
				mounts: [],
				network: "deny",
				process: false,
				enforcement: { ...ACCESS_CAPABILITIES },
			},
			limits,
			diagnostics,
		};
	}

	async prepare(input: Parameters<NonNullable<SubagentBackend["prepare"]>>[0], context: SubagentBackendPreparationContext): Promise<SubagentPreparationResult> {
		if (this.#primed.has(input.preflight.preflightId)) throw new Error(`Pi SDK preflight is already prepared: ${input.preflight.preflightId}`);
		const model = this.#requireModel(input.preflight.model.provider, input.preflight.model.id);
		const tempDir = mkdtempSync(join(tmpdir(), "pi-forge-subagent-"));
		const providerGate = deferred<void>();
		const preparationReady = deferred<SubagentPreparationResult>();
		let prepared: SubagentPreparationResult | undefined;
		let session: AgentSession | undefined;
		try {
			const settingsManager = SettingsManager.create(tempDir, tempDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				settingsManager,
				extensionFactories: [{
					name: "pi-forge-subagent-runtime",
					factory: this.#compilerBridge(input, context, providerGate, preparationReady, (result) => { prepared = result; }),
				}],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: ISOLATED_BASE_PROMPT,
			});
			await resourceLoader.reload();
			const created = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				modelRuntime: this.#modelRuntime,
				model,
				thinkingLevel: input.preflight.thinkingLevel,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				noTools: "all",
				tools: [],
			});
			session = created.session;
			session.setActiveToolsByName([]);
			const execution = this.#startPrompt(session, input.request.input.text, preparationReady);
			const result = await abortable(preparationReady.promise, context.signal);
			if (!prepared || canonicalSubagentJson(prepared) !== canonicalSubagentJson(result)) throw new Error("Pi SDK preparation bridge returned inconsistent host preparation.");
			const primed: PrimedPiSdkRun = {
				preflightId: input.preflight.preflightId,
				requestId: input.request.requestId,
				result,
				session,
				tempDir,
				providerGate,
				execution,
				disposed: false,
			};
			this.#primed.set(input.preflight.preflightId, primed);
			return structuredClone(result);
		} catch (error) {
			providerGate.resolve();
			if (session) {
				await session.abort().catch(() => undefined);
				session.dispose();
			}
			rmSync(tempDir, { recursive: true, force: true });
			throw error;
		}
	}

	async execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult> {
		const primed = this.#primed.get(plan.preflightId);
		if (!primed || primed.requestId !== plan.requestId) throw new Error("Pi SDK execution has no matching prepared session.");
		if (primed.result.runtime.promptRuntimeFingerprint !== plan.promptRuntimeFingerprint
			|| primed.result.preparation.systemPrompt !== plan.systemPrompt
			|| canonicalSubagentJson(primed.result.preparation.messages) !== canonicalSubagentJson(plan.messages)) {
			this.#primed.delete(plan.preflightId);
			primed.providerGate.resolve();
			await primed.session.abort().catch(() => undefined);
			this.#disposePrimed(primed);
			throw new Error("Pi SDK execution plan does not match the prepared SDK session.");
		}
		primed.runId = plan.runId;
		this.#active.set(plan.runId, primed);
		const abort = () => { void primed.session.abort(); };
		if (context.signal.aborted) abort();
		else context.signal.addEventListener("abort", abort, { once: true });
		primed.providerGate.resolve();
		try {
			const terminal = await primed.execution;
			const common = backendResponseCommon(plan);
			if (terminal.status === "completed") {
				return {
					...common,
					status: "completed",
					output: terminal.output === undefined ? undefined : { text: terminal.output.slice(0, plan.resultProjection.maxChars), partial: false },
				};
			}
			if (terminal.status === "cancelled") return { ...common, status: "cancelled", reason: terminal.error ?? "SDK session aborted" };
			return { ...common, status: "failed", error: { code: "provider", message: terminal.error ?? "Provider execution failed.", retryable: false }, output: terminal.output ? { text: terminal.output.slice(0, plan.resultProjection.maxChars), partial: true } : undefined };
		} finally {
			context.signal.removeEventListener("abort", abort);
			this.#active.delete(plan.runId);
			this.#primed.delete(plan.preflightId);
			this.#disposePrimed(primed);
		}
	}

	async cancel(input: SubagentBackendCancelInput): Promise<void> {
		const primed = this.#active.get(input.runId);
		if (!primed) return;
		primed.providerGate.resolve();
		await primed.session.abort().catch(() => undefined);
	}

	async discard(preflightId: string): Promise<boolean> {
		const primed = this.#primed.get(preflightId);
		if (!primed) return false;
		this.#primed.delete(preflightId);
		primed.providerGate.resolve();
		await primed.session.abort().catch(() => undefined);
		this.#disposePrimed(primed);
		return true;
	}

	async dispose(): Promise<void> {
		for (const primed of [...this.#primed.values()]) {
			primed.providerGate.resolve();
			await primed.session.abort().catch(() => undefined);
			this.#disposePrimed(primed);
		}
		this.#primed.clear();
		this.#active.clear();
	}

	#compilerBridge(
		input: Parameters<NonNullable<SubagentBackend["prepare"]>>[0],
		context: SubagentBackendPreparationContext,
		providerGate: Deferred<void>,
		preparationReady: Deferred<SubagentPreparationResult>,
		setPrepared: (result: SubagentPreparationResult) => void,
	): ExtensionFactory {
		return (pi: ExtensionAPI) => {
			let prepared: SubagentPreparationResult | undefined;
			pi.on("before_agent_start", async (event) => {
				try {
					const runtime = this.#runtimeSnapshot(input.preflight, event.systemPrompt, event.systemPromptOptions);
					prepared = await context.prepare(runtime);
					setPrepared(prepared);
					preparationReady.resolve(prepared);
					return { systemPrompt: prepared.preparation.systemPrompt };
				} catch (error) {
					preparationReady.reject(error);
					providerGate.resolve();
					throw error;
				}
			});
			pi.on("context", () => {
				if (!prepared) throw new Error("Pi SDK context event arrived before host preparation.");
				return { messages: prepared.preparation.messages.map((message, index) => preparedMessageToAgentMessage(message, input.preflight, index)) };
			});
			pi.on("before_provider_request", async () => {
				await providerGate.promise;
			});
		};
	}

	#runtimeSnapshot(
		preflight: BackendPreflightAccepted,
		baseSystemPrompt: string,
		options: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
	): SubagentPreparationRuntime {
		const runtime: Omit<SubagentPreparationRuntime, "promptRuntimeFingerprint"> = {
			baseSystemPrompt,
			options: {
				customPrompt: options.customPrompt,
				selectedTools: [],
				toolSnippets: {},
				promptGuidelines: [],
				appendSystemPrompt: options.appendSystemPrompt,
				cwd: ".",
				contextFiles: [],
				skills: [],
			},
			model: structuredClone(preflight.model),
			preparedAt: this.#now().toISOString(),
			fidelity: "backend-assisted",
		};
		return { ...runtime, promptRuntimeFingerprint: subagentPromptRuntimeFingerprint(runtime) };
	}

	async #startPrompt(session: AgentSession, task: string, preparationReady: Deferred<SubagentPreparationResult>): Promise<PiSdkTerminalResult> {
		try {
			await session.prompt(task, { source: "extension" });
			await session.waitForIdle();
			return terminalResult(session);
		} catch (error) {
			preparationReady.reject(error);
			return { status: "failed", error: error instanceof Error ? error.message : String(error), output: session.getLastAssistantText() || undefined };
		}
	}

	#requireModel(provider: string, id: string): Model<any> {
		const model = this.#modelRegistry.find(provider, id);
		if (!model) throw new Error(`Pi SDK model disappeared after preflight: ${provider}/${id}`);
		return model;
	}

	#disposePrimed(primed: PrimedPiSdkRun): void {
		if (primed.disposed) return;
		primed.disposed = true;
		primed.session.dispose();
		rmSync(primed.tempDir, { recursive: true, force: true });
	}
}

function preparedMessageToAgentMessage(message: SubagentPreparedMessage, preflight: BackendPreflightAccepted, index: number): AgentMessage {
	if (message.content.some((part) => part.type === "media")) throw new Error("Media preparation is not implemented by the first Pi SDK backend iteration.");
	const content = message.content.map((part) => ({ type: "text" as const, text: part.type === "text" ? part.text : "" }));
	const timestamp = index;
	if (message.role === "user") return { role: "user", content: content.length === 1 ? content[0]!.text : content, timestamp } as AgentMessage;
	if (message.role === "custom") return { role: "custom", customType: "pi-forge-subagent", content, display: false, details: {}, timestamp } as AgentMessage;
	return {
		role: "assistant",
		content,
		api: "unknown",
		provider: preflight.model.provider,
		model: preflight.model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

function terminalResult(session: AgentSession): PiSdkTerminalResult {
	const assistant = [...session.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
	const output = session.getLastAssistantText() || undefined;
	if (assistant?.stopReason === "aborted") return { status: "cancelled", error: assistant.errorMessage ?? "SDK session aborted", output };
	if (assistant?.stopReason === "error" || assistant?.errorMessage) return { status: "failed", error: assistant.errorMessage ?? "Provider returned an error.", output };
	return { status: "completed", output };
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
		durationMs: 0,
		artifacts: [],
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new Error("Pi SDK preparation was cancelled.");
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("Pi SDK preparation was cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function errorDiagnostic(code: string, message: string, path?: string): SubagentDiagnostic {
	return { level: "error", code, message, path };
}

function warningDiagnostic(code: string, message: string, path?: string): SubagentDiagnostic {
	return { level: "warning", code, message, path };
}
