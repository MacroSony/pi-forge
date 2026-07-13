import { randomUUID } from "node:crypto";
import {
	SUBAGENT_CONTRACT_VERSION,
	canonicalSubagentJson,
	hasSubagentErrors,
	validateAgentExecutionPlan,
	validateAgentProfileSnapshot,
	validateAgentRequest,
	validateAgentResponse,
	validateBackendPreflight,
	validateSubagentTraceReference,
	type AgentExecutionPlan,
	type AgentProfileSnapshot,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightAccepted,
	type BackendPreflightResult,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
	type SubagentHostPlanPreparer,
	type SubagentPreparationInput,
	type SubagentPreparationOutput,
	type SubagentTraceReference,
} from "./contract.ts";

type WithoutTrace<T> = T extends AgentResponse ? Omit<T, "trace"> : never;

export interface SubagentBackendTraceResult {
	id: string;
	expiresAt?: string;
}

export type SubagentBackendExecutionResult = WithoutTrace<AgentResponse> & {
	trace?: SubagentBackendTraceResult;
};

export interface SubagentBackendPreflightInput {
	request: AgentRequest;
	snapshot: AgentProfileSnapshot;
	signal?: AbortSignal;
}

export interface SubagentBackendPreparationContext {
	signal?: AbortSignal;
	prepare: SubagentHostPlanPreparer;
}

export interface SubagentBackendExecutionContext {
	signal: AbortSignal;
}

export interface SubagentBackendCancelInput {
	runId: string;
	reason: string;
}

export interface SubagentBackendTraceInput {
	traceId: string;
	signal?: AbortSignal;
}

export interface SubagentBackend {
	readonly descriptor: SubagentBackendDescriptor;
	preflight(input: SubagentBackendPreflightInput): Promise<BackendPreflightResult> | BackendPreflightResult;
	prepare?(input: SubagentPreparationInput, context: SubagentBackendPreparationContext): Promise<SubagentPreparationOutput> | SubagentPreparationOutput;
	execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult> | SubagentBackendExecutionResult;
	cancel?(input: SubagentBackendCancelInput): Promise<void> | void;
	inspectTrace?(input: SubagentBackendTraceInput): Promise<unknown> | unknown;
}

export interface SubagentBackendRegistryOptions {
	idFactory?: (kind: "preflight" | "trace") => string;
	now?: () => number;
}

export interface SubagentExecutionOptions {
	authorizationScope: string;
	signal?: AbortSignal;
}

interface AcceptedPreflightRecord {
	backendId: string;
	requestId: string;
	profileFingerprint: string;
}

interface TraceRecord {
	reference: SubagentTraceReference;
	backendTraceId: string;
}

interface ActiveRun {
	backend: SubagentBackend;
	plan: AgentExecutionPlan;
	controller: AbortController;
	settled: boolean;
	requestCancellation?: (kind: "cancelled" | "timed-out", reason: string) => void;
	cancelPromise?: Promise<void>;
}

export class SubagentBackendRegistryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SubagentBackendRegistryError";
		this.code = code;
	}
}

export class SubagentBackendRegistry {
	readonly #backends = new Map<string, SubagentBackend>();
	readonly #preflights = new Map<string, AcceptedPreflightRecord>();
	readonly #traces = new Map<string, TraceRecord>();
	readonly #activeRuns = new Map<string, ActiveRun>();
	readonly #idFactory: (kind: "preflight" | "trace") => string;
	readonly #now: () => number;

	constructor(options: SubagentBackendRegistryOptions = {}) {
		this.#idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
		this.#now = options.now ?? Date.now;
	}

	get size(): number {
		return this.#backends.size;
	}

	register(backend: SubagentBackend): () => boolean {
		validateRegistration(backend);
		const id = backend.descriptor.id;
		if (this.#backends.has(id)) throw new SubagentBackendRegistryError("backend.duplicate", `A subagent backend is already registered as ${id}.`);
		this.#backends.set(id, backend);
		return () => this.unregister(id);
	}

	unregister(backendId: string): boolean {
		if ([...this.#activeRuns.values()].some((run) => run.backend.descriptor.id === backendId)) {
			throw new SubagentBackendRegistryError("backend.active", `Cannot unregister backend ${backendId} while one of its runs is active or draining.`);
		}
		const removed = this.#backends.delete(backendId);
		if (!removed) return false;
		for (const [id, record] of this.#preflights) if (record.backendId === backendId) this.#preflights.delete(id);
		for (const [handle, record] of this.#traces) if (record.reference.backendId === backendId) this.#traces.delete(handle);
		return true;
	}

	descriptors(): SubagentBackendDescriptor[] {
		return [...this.#backends.values()]
			.map((backend) => structuredClone(backend.descriptor))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	async preflight(backendId: string, request: AgentRequest, snapshot: AgentProfileSnapshot, signal?: AbortSignal): Promise<BackendPreflightResult> {
		const backend = this.#requireBackend(backendId);
		const inputDiagnostics = [...validateAgentRequest(request), ...validateAgentProfileSnapshot(snapshot)];
		if (hasSubagentErrors(inputDiagnostics)) return this.#rejectedPreflight(backend, inputDiagnostics);
		if (signal?.aborted) return this.#rejectedPreflight(backend, [diagnostic("preflight.cancelled", "Preflight was cancelled before backend discovery.")]);

		let result: BackendPreflightResult;
		try {
			result = await backend.preflight({ request: structuredClone(request), snapshot: structuredClone(snapshot), signal });
		} catch (error) {
			return this.#rejectedPreflight(backend, [diagnostic("preflight.backend-error", errorMessage(error))]);
		}

		const diagnostics = validateBackendPreflight(result, request, snapshot);
		if (result.backend?.id !== backendId || !sameDescriptor(result.backend, backend.descriptor)) {
			diagnostics.push(diagnostic("preflight.backend-identity", "Backend preflight descriptor does not match its registered identity.", "backend"));
		}
		if (this.#preflights.has(result.preflightId)) diagnostics.push(diagnostic("preflight.duplicate-id", "Backend reused an existing preflightId.", "preflightId"));
		if (hasSubagentErrors(diagnostics)) return this.#rejectedPreflight(backend, diagnostics, validOpaqueId(result.preflightId) ? result.preflightId : undefined);
		if (result.status === "accepted") {
			this.#preflights.set(result.preflightId, {
				backendId,
				requestId: request.requestId,
				profileFingerprint: snapshot.profileFingerprint,
			});
		}
		return structuredClone(result);
	}

	async prepare(
		backendId: string,
		input: SubagentPreparationInput,
		hostPreparer: SubagentHostPlanPreparer,
		signal?: AbortSignal,
	): Promise<SubagentPreparationOutput> {
		const backend = this.#requireBackend(backendId);
		this.#assertPreflightBinding(input.preflight, input.request, input.snapshot);
		if (signal?.aborted) throw new SubagentBackendRegistryError("preparation.cancelled", "Preparation was cancelled before it started.");
		const fidelity = backend.descriptor.capabilities.promptRuntimeFidelity;
		if (fidelity === "partial") throw new SubagentBackendRegistryError("preparation.partial", "A partial prompt runtime cannot prepare an execution plan.");
		if (fidelity === "exact-preflight") return structuredClone(await hostPreparer(structuredClone(input)));
		if (!backend.prepare) throw new SubagentBackendRegistryError("preparation.unsupported", `Backend ${backendId} advertises backend-assisted preparation but has no prepare method.`);
		return structuredClone(await backend.prepare(structuredClone(input), { signal, prepare: hostPreparer }));
	}

	async execute(plan: AgentExecutionPlan, options: SubagentExecutionOptions): Promise<AgentResponse> {
		const backend = this.#requireBackend(plan.backendId);
		const planDiagnostics = validateAgentExecutionPlan(plan);
		if (hasSubagentErrors(planDiagnostics)) throw new SubagentBackendRegistryError("execution.invalid-plan", summarizeDiagnostics(planDiagnostics));
		const preflightRecord = this.#preflights.get(plan.preflightId);
		if (!preflightRecord
			|| preflightRecord.backendId !== plan.backendId
			|| preflightRecord.requestId !== plan.requestId
			|| preflightRecord.profileFingerprint !== plan.profile.profileFingerprint) {
			throw new SubagentBackendRegistryError("execution.unbound-preflight", "Execution plan is not bound to an accepted registry preflight.");
		}
		if (!validNamespace(options.authorizationScope)) throw new SubagentBackendRegistryError("execution.authorization", "authorizationScope must be a normalized namespace.");
		if (this.#activeRuns.has(plan.runId)) throw new SubagentBackendRegistryError("execution.duplicate-run", `Run ${plan.runId} is already active.`);

		const startedAt = this.#now();
		const controller = new AbortController();
		let resolveTerminal!: (response: AgentResponse) => void;
		const terminal = new Promise<AgentResponse>((resolve) => { resolveTerminal = resolve; });
		const active: ActiveRun = { backend, plan, controller, settled: false };
		this.#activeRuns.set(plan.runId, active);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let externalAbort: (() => void) | undefined;

		const settle = (response: AgentResponse): boolean => {
			if (active.settled) return false;
			active.settled = true;
			if (timeout) clearTimeout(timeout);
			if (externalAbort && options.signal) options.signal.removeEventListener("abort", externalAbort);
			resolveTerminal(response);
			return true;
		};

		const cancelRun = (kind: "cancelled" | "timed-out", reason: string): void => {
			if (active.settled) return;
			controller.abort(reason);
			active.cancelPromise = Promise.resolve(backend.cancel?.({ runId: plan.runId, reason })).catch(() => undefined);
			const durationMs = elapsed(this.#now(), startedAt);
			settle(kind === "timed-out"
				? { ...responseCommon(plan, durationMs), status: "timed-out", reason, enforcedTimeoutMs: plan.limits.timeoutMs!.value }
				: { ...responseCommon(plan, durationMs), status: "cancelled", reason });
		};
		active.requestCancellation = cancelRun;

		if (options.signal) {
			externalAbort = () => cancelRun("cancelled", abortReason(options.signal, "user"));
			if (options.signal.aborted) externalAbort();
			else options.signal.addEventListener("abort", externalAbort, { once: true });
		}
		const timeoutLimit = plan.limits.timeoutMs;
		if (!active.settled && timeoutLimit?.enforcement === "host-abort") {
			timeout = setTimeout(() => cancelRun("timed-out", "host timeout"), timeoutLimit.value);
		}

		const backendExecution = Promise.resolve()
			.then(() => backend.execute(structuredClone(plan), { signal: controller.signal }))
			.then((result) => {
				if (active.settled) return;
				settle(this.#normalizeBackendResponse(result, plan, options.authorizationScope, elapsed(this.#now(), startedAt)));
			})
			.catch((error) => {
				if (active.settled) return;
				settle({
					...responseCommon(plan, elapsed(this.#now(), startedAt)),
					status: "failed",
					error: { code: "backend-execution", message: errorMessage(error), retryable: false },
				});
			})
			.finally(() => {
				if (timeout) clearTimeout(timeout);
				if (externalAbort && options.signal) options.signal.removeEventListener("abort", externalAbort);
				if (this.#activeRuns.get(plan.runId) === active) this.#activeRuns.delete(plan.runId);
			});

		void backendExecution;
		return terminal;
	}

	async cancel(runId: string, reason = "user"): Promise<boolean> {
		const active = this.#activeRuns.get(runId);
		if (!active || active.settled) return false;
		active.requestCancellation?.("cancelled", reason);
		await active.cancelPromise;
		return true;
	}

	async inspectTrace(reference: SubagentTraceReference, authorizationScope: string, signal?: AbortSignal): Promise<unknown> {
		const diagnostics = validateSubagentTraceReference(reference);
		if (hasSubagentErrors(diagnostics)) throw new SubagentBackendRegistryError("trace.invalid", summarizeDiagnostics(diagnostics));
		const record = this.#traces.get(reference.handle);
		if (!record || !sameTraceReference(record.reference, reference)) throw new SubagentBackendRegistryError("trace.unknown", "Trace handle is unknown or does not match its registered route.");
		if (reference.authorizationScope !== authorizationScope) throw new SubagentBackendRegistryError("trace.forbidden", "Trace authorization scope does not match the caller.");
		if (reference.expiresAt && Date.parse(reference.expiresAt) <= this.#now()) {
			this.#traces.delete(reference.handle);
			throw new SubagentBackendRegistryError("trace.expired", "Trace handle has expired.");
		}
		const backend = this.#requireBackend(reference.backendId);
		if (!backend.descriptor.capabilities.traceInspection || !backend.inspectTrace) {
			throw new SubagentBackendRegistryError("trace.unsupported", `Backend ${reference.backendId} does not support trace inspection.`);
		}
		return backend.inspectTrace({ traceId: record.backendTraceId, signal });
	}

	forgetTrace(handle: string): boolean {
		return this.#traces.delete(handle);
	}

	#requireBackend(backendId: string): SubagentBackend {
		const backend = this.#backends.get(backendId);
		if (!backend) throw new SubagentBackendRegistryError("backend.unknown", `Unknown subagent backend: ${backendId}`);
		return backend;
	}

	#assertPreflightBinding(preflight: BackendPreflightAccepted, request: AgentRequest, snapshot: AgentProfileSnapshot): void {
		const record = this.#preflights.get(preflight.preflightId);
		if (!record
			|| record.backendId !== preflight.backend.id
			|| record.requestId !== request.requestId
			|| record.profileFingerprint !== snapshot.profileFingerprint) {
			throw new SubagentBackendRegistryError("preparation.unbound-preflight", "Preparation input is not bound to an accepted registry preflight.");
		}
	}

	#rejectedPreflight(backend: SubagentBackend, diagnostics: SubagentDiagnostic[], preflightId?: string): BackendPreflightResult {
		return {
			status: "rejected",
			preflightId: preflightId ?? this.#idFactory("preflight"),
			backend: structuredClone(backend.descriptor),
			diagnostics: ensureErrorDiagnostics(diagnostics),
		};
	}

	#normalizeBackendResponse(
		result: SubagentBackendExecutionResult,
		plan: AgentExecutionPlan,
		authorizationScope: string,
		durationMs: number,
	): AgentResponse {
		let trace: SubagentTraceReference | undefined;
		if (result.trace) {
			if (!validOpaqueId(result.trace.id) || (result.trace.expiresAt !== undefined && !validIsoDate(result.trace.expiresAt))) {
				return invalidBackendResponse(plan, durationMs, "Backend returned malformed trace routing metadata.");
			}
			trace = {
				handle: this.#uniqueId("trace", this.#traces),
				backendId: plan.backendId,
				authorizationScope,
				expiresAt: result.trace.expiresAt,
			};
		}
		const { trace: _backendTrace, ...responseFields } = result;
		const response = { ...responseFields, durationMs, trace } as AgentResponse;
		const diagnostics = validateAgentResponse(response, { plan });
		if (hasSubagentErrors(diagnostics)) return invalidBackendResponse(plan, durationMs, summarizeDiagnostics(diagnostics));
		if (trace && result.trace) this.#traces.set(trace.handle, { reference: trace, backendTraceId: result.trace.id });
		return structuredClone(response);
	}

	#uniqueId(kind: "preflight" | "trace", values: Map<string, unknown>): string {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const id = this.#idFactory(kind);
			if (validOpaqueId(id) && !values.has(id)) return id;
		}
		throw new SubagentBackendRegistryError(`${kind}.id`, `Could not allocate a unique valid ${kind} identifier.`);
	}
}

function validateRegistration(backend: SubagentBackend): void {
	if (!backend || typeof backend !== "object") throw new SubagentBackendRegistryError("backend.type", "Subagent backend must be an object.");
	if (typeof backend.preflight !== "function" || typeof backend.execute !== "function") {
		throw new SubagentBackendRegistryError("backend.methods", "Subagent backend must implement preflight and execute.");
	}
	const diagnostics = validateBackendPreflight({
		status: "rejected",
		preflightId: "descriptor-check",
		backend: backend.descriptor,
		diagnostics: [diagnostic("backend.descriptor-check", "Descriptor validation sentinel.")],
	});
	if (hasSubagentErrors(diagnostics)) throw new SubagentBackendRegistryError("backend.descriptor", summarizeDiagnostics(diagnostics));
	if (backend.descriptor.capabilities.promptRuntimeFidelity === "backend-assisted" && typeof backend.prepare !== "function") {
		throw new SubagentBackendRegistryError("backend.prepare", "A backend-assisted backend must implement prepare.");
	}
	if (backend.descriptor.capabilities.traceInspection && typeof backend.inspectTrace !== "function") {
		throw new SubagentBackendRegistryError("backend.trace", "A trace-inspection backend must implement inspectTrace.");
	}
}

function responseCommon(plan: AgentExecutionPlan, durationMs: number) {
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
		durationMs,
		artifacts: [],
	};
}

function invalidBackendResponse(plan: AgentExecutionPlan, durationMs: number, detail: string): AgentResponse {
	return {
		...responseCommon(plan, durationMs),
		status: "failed",
		error: { code: "backend-invalid-response", message: detail, retryable: false },
	};
}

function diagnostic(code: string, message: string, path?: string): SubagentDiagnostic {
	return { level: "error", code, message, path };
}

function ensureErrorDiagnostics(diagnostics: readonly SubagentDiagnostic[]): SubagentDiagnostic[] {
	const cloned = structuredClone(diagnostics);
	if (cloned.some((item) => item.level === "error")) return [...cloned];
	return [diagnostic("registry.rejected", "Registry rejected the backend operation."), ...cloned];
}

function summarizeDiagnostics(diagnostics: readonly SubagentDiagnostic[]): string {
	return diagnostics.filter((item) => item.level === "error").slice(0, 4).map((item) => `${item.code}: ${item.message}`).join("; ") || "Subagent validation failed.";
}

function sameDescriptor(left: SubagentBackendDescriptor, right: SubagentBackendDescriptor): boolean {
	try {
		return canonicalSubagentJson(left) === canonicalSubagentJson(right);
	} catch {
		return false;
	}
}

function sameTraceReference(left: SubagentTraceReference, right: SubagentTraceReference): boolean {
	return left.handle === right.handle
		&& left.backendId === right.backendId
		&& left.authorizationScope === right.authorizationScope
		&& left.expiresAt === right.expiresAt;
}

function validOpaqueId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validNamespace(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validIsoDate(value: string): boolean {
	return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function elapsed(now: number, start: number): number {
	return Math.max(0, now - start);
}

function abortReason(signal: AbortSignal | undefined, fallback: string): string {
	if (!signal) return fallback;
	return typeof signal.reason === "string" && signal.reason.trim() ? signal.reason : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
