import { randomUUID } from "node:crypto";
import { createResourceCatalog } from "./catalog.ts";
import { hasAgentProfileErrors, type AgentProfileProvenance, type LoadedAgentProfile } from "./agent-profile.ts";
import { readAgentProfilesScoped, readGlobalAgentProfiles } from "./repositories/agent-profile.ts";
import { readGlobalPromptStacks, readPromptStacksScoped } from "./repositories/prompt-stack.ts";
import { chooseDefaultStack, isDisabledPromptStackId } from "./loader.ts";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.ts";
import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "./forge-extensions.ts";
import type { LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";
import {
	validateListProfilesRequest,
	validatePrepareRequest,
	validatePrepareResponse,
	validateResolveProfileRequest,
	validateResolveProfileResponse,
	ForgeHost,
	type ForgeHostPortResult,
	type ForgeHostTransport,
	type ForgePrepareRequest,
	type ForgePrepareResponse,
} from "./subagent/host-port.ts";
import {
	currentSubagentPromptRegistrationCatalog,
	prepareForgeDelegation,
	resolveSubagentHostProfile,
	type ForgeProfileSnapshot,
} from "./subagent-host.ts";

export interface ForgeWorkspaceSnapshot {
	cwd: string;
	stacks: readonly LoadedPromptStack[];
	profiles: readonly LoadedAgentProfile[];
	activeStackId: string | null;
	active?: LoadedPromptStack;
	lastAppliedProfile?: AgentProfileProvenance;
	extensionDiagnostics: readonly PromptStackDiagnostic[];
	extensionPaths: readonly string[];
	capturedAt: string;
}

export interface ForgeWorkspaceReloadOptions {
	trusted?: boolean;
	activeStackId?: string | null;
	lastAppliedProfile?: AgentProfileProvenance;
	suppressAutoActivate?: boolean;
}

/**
 * Single owner of the Forge resource graph.
 *
 * Owns one coherent, deep-frozen snapshot containing stacks, profiles, active
 * selection, profile provenance, and extension lifecycle state. All readers
 * (commands, web UI, lifecycle, tool policy, preview, host port) consume
 * `snapshot()` instead of separate mutable bags.
 */
export class ForgeWorkspace {
	private readonly extensionState = createForgeExtensionState();
	private current?: ForgeWorkspaceSnapshot;
	private host?: ForgeHost;

	get snapshotKnown(): boolean {
		return this.current !== undefined;
	}

	reload(cwd: string, options: ForgeWorkspaceReloadOptions = {}): ForgeWorkspaceSnapshot {
		const trusted = options.trusted !== false;
		const stacks = trusted ? readPromptStacksScoped(cwd) : readGlobalPromptStacks();
		if (this.extensionDiagnostics.length > 0) {
			for (const loaded of stacks) loaded.diagnostics.unshift(...this.extensionDiagnostics);
		}
		const profiles = trusted ? readAgentProfilesScoped(cwd) : readGlobalAgentProfiles();
		const active = this.resolveActive(stacks, options);
		const activeStackId = active ? formatResourceKey(active.key) : (options.activeStackId != null && isDisabledPromptStackId(options.activeStackId) ? "none" : null);
		const snapshot: ForgeWorkspaceSnapshot = {
			cwd,
			stacks,
			profiles,
			activeStackId,
			active,
			lastAppliedProfile: options.lastAppliedProfile ?? this.current?.lastAppliedProfile,
			extensionDiagnostics: this.extensionDiagnostics,
			extensionPaths: this.extensionPaths,
			capturedAt: new Date().toISOString(),
		};
		this.current = deepFreeze(structuredClone(snapshot));
		return this.current;
	}

	reloadProfiles(cwd: string, trusted = true): ForgeWorkspaceSnapshot {
		if (!this.current) throw new Error("ForgeWorkspace has not been reloaded.");
		const profiles = trusted ? readAgentProfilesScoped(cwd) : readGlobalAgentProfiles();
		return this.publish({
			...this.current,
			profiles,
			capturedAt: new Date().toISOString(),
		});
	}

	async loadExtensions(cwd: string): Promise<{ diagnostics: PromptStackDiagnostic[]; loadedPaths: string[] }> {
		const result = await reloadForgeExtensions(cwd, this.extensionState);
		this.extensionDiagnostics = result.diagnostics;
		this.extensionPaths = result.loadedPaths;
		return result;
	}

	disposeExtensions(): PromptStackDiagnostic[] {
		const diagnostics = unloadForgeExtensions(this.extensionState);
		this.extensionDiagnostics = diagnostics;
		this.extensionPaths = [];
		return diagnostics;
	}

	setActiveStack(id: string | undefined): boolean {
		if (!this.current) return false;
		if (!id || isDisabledPromptStackId(id)) {
			this.publish({
				...this.current,
				activeStackId: "none",
				active: undefined,
				capturedAt: new Date().toISOString(),
			});
			return true;
		}
		const parsed = parseResourceSelector(id);
		if (!parsed.ok) return false;
		const found = createResourceCatalog<LoadedPromptStack>([...this.current.stacks]).resolveSelector(parsed.selector);
		if (!found) return false;
		this.publish({
			...this.current,
			activeStackId: formatResourceKey(found.key),
			active: found,
			capturedAt: new Date().toISOString(),
		});
		return true;
	}

	setLastAppliedProfile(profile: AgentProfileProvenance | undefined): void {
		if (!this.current) throw new Error("ForgeWorkspace has not been reloaded.");
		this.publish({
			...this.current,
			lastAppliedProfile: profile,
			capturedAt: new Date().toISOString(),
		});
	}

	// Read/write view used by profile-service's AgentProfileApplicationState.
	get active(): LoadedPromptStack | undefined {
		return this.current?.active;
	}

	set active(value: LoadedPromptStack | undefined) {
		if (!value) {
			this.setActiveStack(undefined);
			return;
		}
		if (!this.current) throw new Error("ForgeWorkspace has not been reloaded.");
		this.publish({
			...this.current,
			activeStackId: formatResourceKey(value.key),
			active: value,
			capturedAt: new Date().toISOString(),
		});
	}

	get lastAppliedProfile(): AgentProfileProvenance | undefined {
		return this.current?.lastAppliedProfile;
	}

	set lastAppliedProfile(value: AgentProfileProvenance | undefined) {
		this.setLastAppliedProfile(value);
	}

	snapshot(): ForgeWorkspaceSnapshot {
		if (!this.current) throw new Error("ForgeWorkspace has not been reloaded.");
		return this.current;
	}

	/**
	 * Register the host port for the current snapshot. Idempotent: the host is
	 * only started once the first snapshot exists, so `available` never implies
	 * an unloaded workspace. On reload the live host is kept (its generation
	 * only changes via dispose).
	 */
	startHostPort(transport: ForgeHostTransport): ForgeHost {
		if (!this.current) throw new Error("ForgeWorkspace must be reloaded before starting the host port.");
		if (this.host?.isLive) return this.host;
		const host = new ForgeHost(transport, {
			capabilities: ["listProfiles", "resolveProfile", "prepare"],
			handle: (operation, payload) => this.operate(operation, payload),
		});
		this.host = host;
		host.start();
		return host;
	}

	/** Invoke the minimal-operation surface against the current snapshot. */
	operate(operation: string, payload: unknown): ForgeHostPortResult {
		if (operation === "listProfiles") return this.listProfiles(payload);
		if (operation === "resolveProfile") return this.resolveProfile(payload);
		if (operation === "prepare") return this.prepare(payload);
		return { ok: false, error: `Unknown Forge host operation: ${operation}` };
	}

	private listProfiles(payload: unknown): ForgeHostPortResult {
		const validated = validateListProfilesRequest(payload);
		if (!validated.ok) return { ok: false, error: validated.error };
		try {
			const snapshot = this.snapshot();
			return {
				ok: true,
				data: {
					profiles: snapshot.profiles.map((loaded) => stripUndefined({
						profileId: loaded.profile.id,
						scope: loaded.scope,
						name: loaded.profile.name,
						description: loaded.profile.description,
						autoActivate: loaded.profile.autoActivate,
						model: { provider: loaded.profile.model.provider, id: loaded.profile.model.id },
						thinkingLevel: loaded.profile.thinkingLevel,
						promptStack: loaded.profile.promptStack,
						usable: !hasAgentProfileErrors(loaded.diagnostics),
						diagnostics: loaded.diagnostics,
					}) as Record<string, unknown>),
				},
			};
		} catch (error) {
			return { ok: false, error: `listProfiles failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private resolveProfile(payload: unknown): ForgeHostPortResult {
		const validated = validateResolveProfileRequest(payload);
		if (!validated.ok) return { ok: false, error: validated.error };
		const request = validated.data;
		try {
			const snapshot = this.resolveProfilePlan(request.profile);
			const response = { snapshot };
			const responseValidated = validateResolveProfileResponse(stripUndefined(response));
			if (!responseValidated.ok) return { ok: false, error: responseValidated.error };
			return { ok: true, data: stripUndefined(response) };
		} catch (error) {
			return { ok: false, error: `resolveProfile failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	/** Host-owned profile resolution returns the immutable profile snapshot artifact. */
	private resolveProfilePlan(profile: string): ForgeProfileSnapshot {
		const snapshot = this.snapshot();
		const parsed = parseResourceSelector(profile);
		if (!parsed.ok) throw new Error(`Invalid profile selector ${profile}: ${parsed.error}`);
		const loaded = createResourceCatalog<LoadedAgentProfile>([...snapshot.profiles]).resolveSelector(parsed.selector);
		if (!loaded) throw new Error(`Unknown profile: ${profile}`);
		if (hasAgentProfileErrors(loaded.diagnostics)) throw new Error(`Profile ${profile} failed loading validation.`);
		const resolved = resolveSubagentHostProfile(loaded, {
			promptStacks: snapshot.stacks,
			registrations: currentSubagentPromptRegistrationCatalog(),
		});
		if (!resolved.snapshot) throw new Error(`Profile ${profile} could not be resolved.`);
		return resolved.snapshot;
	}

	private prepare(payload: unknown): ForgeHostPortResult {
		const validated = validatePrepareRequest(payload);
		if (!validated.ok) return { ok: false, error: validated.error };
		const request = validated.data;
		let response: ForgePrepareResponse;
		try {
			response = stripUndefined(this.preparePlan(request)) as ForgePrepareResponse;
		} catch (error) {
			return { ok: false, error: `Prepare failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		const responseValidated = validatePrepareResponse(response);
		if (!responseValidated.ok) return { ok: false, error: responseValidated.error };
		return { ok: true, data: response };
	}

	/** Host owns profile/stack resolution and prompt compilation. */
	private preparePlan(request: ForgePrepareRequest): ForgePrepareResponse {
		const snapshot = this.snapshot();
		const parsed = parseResourceSelector(request.profile);
		if (!parsed.ok) throw new Error(`Invalid profile selector ${request.profile}: ${parsed.error}`);
		const loaded = createResourceCatalog<LoadedAgentProfile>([...snapshot.profiles]).resolveSelector(parsed.selector);
		if (!loaded) throw new Error(`Unknown profile: ${request.profile}`);
		if (hasAgentProfileErrors(loaded.diagnostics)) throw new Error(`Profile ${request.profile} failed loading validation.`);

		const resolved = resolveSubagentHostProfile(loaded, {
			promptStacks: snapshot.stacks,
			registrations: currentSubagentPromptRegistrationCatalog(),
		});
		if (!resolved.snapshot) throw new Error(`Profile ${request.profile} could not be resolved for preparation.`);

		const prepared = prepareForgeDelegation({
			snapshot: resolved.snapshot,
			task: request.task,
			access: request.access,
			backend: request.backend,
			cwd: snapshot.cwd,
		});

		return {
			profileId: request.profile,
			model: { ...request.backend.model },
			thinkingLevel: request.backend.thinkingLevel,
			systemPrompt: prepared.systemPrompt,
			messages: prepared.messages,
			effectiveToolIds: prepared.effectiveToolIds,
			effectiveToolNames: prepared.effectiveToolNames,
			diagnostics: prepared.diagnostics,
			profileSnapshot: resolved.snapshot,
			preparedAt: prepared.preparedAt,
		};
	}

	dispose(): void {
		this.disposeExtensions();
		if (this.host?.isLive) this.host.stop();
		this.host = undefined;
		this.current = undefined;
	}

	private resolveActive(stacks: readonly LoadedPromptStack[], options: ForgeWorkspaceReloadOptions): LoadedPromptStack | undefined {
		if (options.suppressAutoActivate && options.activeStackId == null) return undefined;
		if (options.activeStackId != null) {
			if (isDisabledPromptStackId(options.activeStackId)) return undefined;
			const parsed = parseResourceSelector(options.activeStackId);
			if (parsed.ok) {
				const found = createResourceCatalog<LoadedPromptStack>([...stacks]).resolveSelector(parsed.selector);
				if (found) return found;
			}
			// Persisted selection no longer resolves; fall back to the default stack
			// rather than silently starting with no active stack.
			return chooseDefaultStack([...stacks]);
		}
		return chooseDefaultStack([...stacks]);
	}

	private publish(next: ForgeWorkspaceSnapshot): ForgeWorkspaceSnapshot {
		this.current = deepFreeze(structuredClone(next));
		return this.current;
	}

	private get extensionDiagnostics(): PromptStackDiagnostic[] {
		return this.extensionDiagnosticsValue;
	}

	private set extensionDiagnostics(value: PromptStackDiagnostic[]) {
		this.extensionDiagnosticsValue = value;
	}

	private get extensionPaths(): string[] {
		return this.extensionPathsValue;
	}

	private set extensionPaths(value: string[]) {
		this.extensionPathsValue = value;
	}

	private extensionDiagnosticsValue: PromptStackDiagnostic[] = [];
	private extensionPathsValue: string[] = [];
}

function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			result[key] = stripUndefined(item);
		}
		return result;
	}
	return value;
}

function deepFreeze<T>(value: T): T {
	const freeze = (current: unknown): void => {
		if (current === null || typeof current !== "object") return;
		for (const key of Object.keys(current)) freeze((current as Record<string, unknown>)[key]);
		Object.freeze(current);
	};
	freeze(value);
	return value;
}
