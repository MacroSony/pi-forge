import { randomUUID } from "node:crypto";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PiForgeRuntimeState } from "../runtime-state.ts";
import {
	SUBAGENT_CONTRACT_VERSION,
	createAgentExecutionPlan,
	hasSubagentErrors,
	type AgentExecutionPlan,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightResult,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
} from "../subagent/contract.ts";
import { prepareSubagentHostPlan, resolveSubagentHostProfile } from "../subagent-host.ts";
import { SubagentBackendRegistry, type SubagentBackendExecutionUpdate } from "../subagent/backend-registry.ts";
import { PiSubprocessBackend, type PiSubprocessRunReport } from "../subagent/pi-subprocess-backend.ts";

export interface ForgeSubagentPreparedRun {
	request: AgentRequest;
	preflight: Extract<BackendPreflightResult, { status: "accepted" }>;
	plan: AgentExecutionPlan;
	diagnostics: SubagentDiagnostic[];
}

export type ForgeSubagentPreparationResult =
	| { ok: true; prepared: ForgeSubagentPreparedRun }
	| { ok: false; diagnostics: SubagentDiagnostic[] };

export interface ForgeSubagentRuntime {
	descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
	prepare(profileId: string, task: string, ctx: ExtensionContext): Promise<ForgeSubagentPreparationResult>;
	discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
	execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse>;
	takeReport?(runId: string): PiSubprocessRunReport | undefined;
	dispose(): Promise<void>;
}

export function createForgeSubagentRuntime(state: PiForgeRuntimeState): ForgeSubagentRuntime {
	let modelRegistry: ModelRegistry | undefined;
	let cwd: string | undefined;
	let registry: SubagentBackendRegistry | undefined;
	let backend: PiSubprocessBackend | undefined;

	function ensure(ctx: ExtensionContext): { registry: SubagentBackendRegistry; backend: PiSubprocessBackend } {
		if (registry && backend && modelRegistry === ctx.modelRegistry && cwd === ctx.cwd) return { registry, backend };
		if (backend) void backend.dispose();
		modelRegistry = ctx.modelRegistry;
		cwd = ctx.cwd;
		registry = new SubagentBackendRegistry();
		backend = new PiSubprocessBackend({ modelRegistry, cwd });
		registry.register(backend);
		return { registry, backend };
	}

	function descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[] {
		return ensure(ctx).registry.descriptors();
	}

	async function prepare(profileId: string, task: string, ctx: ExtensionContext): Promise<ForgeSubagentPreparationResult> {
		const diagnostics: SubagentDiagnostic[] = [];
		if (!ctx.isProjectTrusted()) return { ok: false, diagnostics: [error("host.trust", "Project is not trusted; subagent profiles remain disabled.")] };
		const matches = state.profiles.filter((candidate) => candidate.profile.id === profileId);
		if (matches.length !== 1) {
			return { ok: false, diagnostics: [error(matches.length === 0 ? "host.profile-missing" : "host.profile-ambiguous", matches.length === 0 ? `Unknown agent profile: ${profileId}` : `Agent profile id is ambiguous: ${profileId}`)] };
		}
		const resolution = resolveSubagentHostProfile(matches[0]!, { promptStacks: state.stacks });
		diagnostics.push(...resolution.diagnostics);
		if (!resolution.snapshot || hasSubagentErrors(diagnostics)) return { ok: false, diagnostics };

		const request: AgentRequest = {
			schemaVersion: SUBAGENT_CONTRACT_VERSION,
			requestId: `request:${randomUUID()}`,
			profileId,
			expectedProfileFingerprint: resolution.snapshot.profileFingerprint,
			input: { text: task },
			access: {
				level: "read-only",
				workspaces: [{ handle: "project", mode: "read-only" }],
				workingDirectory: { workspaceHandle: "project", path: "." },
				network: "allow",
			},
			limits: { timeoutMs: { value: 60_000, enforcement: "best-effort" } },
			resultProjection: { maxChars: 12_000 },
			parent: { sessionId: ctx.sessionManager.getSessionId(), depth: 0, maxDepth: 1 },
			// The command layer obtains explicit user consent before execution. A dry plan
			// never transports data but prepares the exact request that would be executable.
			remoteEgressConsent: true,
		};
		const current = ensure(ctx);
		const preflight = await current.registry.preflight(current.backend.descriptor.id, request, resolution.snapshot, ctx.signal);
		diagnostics.push(...preflight.diagnostics);
		if (preflight.status === "rejected") return { ok: false, diagnostics };

		try {
			const prepared = await current.registry.prepare(
				current.backend.descriptor.id,
				{ request, snapshot: resolution.snapshot, preflight },
				prepareSubagentHostPlan,
				ctx.signal,
			);
			diagnostics.push(...prepared.preparation.diagnostics, ...prepared.preparation.toolNegotiation.diagnostics);
			const planned = createAgentExecutionPlan({
				runId: `run:${randomUUID()}`,
				request,
				snapshot: resolution.snapshot,
				preflight,
				preparation: prepared.preparation,
				runtime: prepared.runtime,
			});
			diagnostics.push(...planned.diagnostics);
			if (!planned.plan || hasSubagentErrors(diagnostics)) {
				await current.registry.discard(preflight.preflightId);
				return { ok: false, diagnostics };
			}
			return { ok: true, prepared: { request, preflight, plan: planned.plan, diagnostics } };
		} catch (preparationError) {
			await current.registry.discard(preflight.preflightId);
			diagnostics.push(error("host.preparation", preparationError instanceof Error ? preparationError.message : String(preparationError)));
			return { ok: false, diagnostics };
		}
	}

	async function discard(prepared: ForgeSubagentPreparedRun): Promise<void> {
		if (!registry) return;
		await registry.discard(prepared.preflight.preflightId);
	}

	async function execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse> {
		const current = ensure(ctx);
		return current.registry.execute(prepared.plan, {
			authorizationScope: `session.${ctx.sessionManager.getSessionId().replace(/[^A-Za-z0-9._-]/g, "-")}`,
			signal,
			onUpdate,
		});
	}

	function takeReport(runId: string): PiSubprocessRunReport | undefined {
		return backend?.takeReport(runId);
	}

	async function dispose(): Promise<void> {
		await backend?.dispose();
		backend = undefined;
		registry = undefined;
		modelRegistry = undefined;
		cwd = undefined;
	}

	return { descriptors, prepare, discard, execute, takeReport, dispose };
}

function error(code: string, message: string): SubagentDiagnostic {
	return { level: "error", code, message };
}
