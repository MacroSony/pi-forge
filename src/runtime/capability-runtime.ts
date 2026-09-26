import { randomUUID } from "node:crypto";
import { summarizeSessionCacheUsage } from "../session-usage.ts";
import { fingerprintJson } from "../json-fingerprint.ts";
import {
	isCapabilityStateMutation,
	isCapabilityEnableRequest,
	type CapabilityAvailableResult,
	type CapabilityChoice,
	type CapabilityStateGuard,
	type CapabilityStateResult,
	type CapabilityStateView,
} from "../capability-state.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createResourceCatalog } from "../catalog.ts";
import { createCapabilitySnapshot, reduceCapabilityEvents, MAX_ID_LENGTH, type ActiveCapability, type CapabilityEvent } from "../capability-events.ts";
import { resolveCapability, resolveCapabilityBindings, type ResolvedCapabilityBinding } from "../capabilities.ts";
import { isUsableCapability } from "../codecs/capability.ts";
import { projectCapabilityMessages } from "../capability-projection.ts";
import { isCapabilityDelivery } from "../capability-protocol.ts";
import { formatResourceKey, parseResourceSelector, type ResourceKey } from "../resource-identity.ts";
import { hasToolSelectionPolicy } from "../policy.ts";
import {
	buildSessionProjection,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	hasPendingCapabilityToolCalls,
	capabilityContextMatches,
	materializeCapabilityAnchors,
} from "../capability-anchors.ts";
import {
	getCurrentBranchEntries,
	persistCapabilityDelivery,
	persistCapabilityEvent,
	persistCapabilityTools,
	readCapabilitySession,
} from "../session-adapter.ts";
import type { ForgeWorkspace } from "../workspace.ts";
import type { ToolPolicyRuntime, ToolPolicySnapshot } from "./tool-policy-runtime.ts";

export type ReadBindingsResult =
	| { ok: true; preset: ResourceKey | null; bindings: readonly ResolvedCapabilityBinding[] }
	| { ok: false; error: string };

export type EnableBoundResult =
	| { ok: true; activationId: string; idempotent?: boolean; message: string }
	| { ok: false; error: string };

export type DisableBoundResult =
	| { ok: true; activationId: string; message: string }
	| { ok: false; error: string };

export interface CapabilityCompletionCapability {
	id: string;
	label: string;
}

export interface CapabilityCompletionBinding {
	id: string;
	label: string;
	modelCallable: boolean;
}

export interface CapabilityCompletionActivation {
	id: string;
	label: string;
}

export type CapabilityCompletionViewResult =
	| {
			ok: true;
			trusted: boolean;
			capturedAt: string;
			capabilities: readonly CapabilityCompletionCapability[];
			bindings: readonly CapabilityCompletionBinding[];
			active: readonly CapabilityCompletionActivation[];
		}
	| { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Branch entries are authoritative. This service only coordinates the existing tool owner and delivery. */
export function createCapabilityRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, tools: ToolPolicyRuntime) {
	const instanceId = randomUUID();
	let context: ExtensionContext | undefined;
	let restoring = false;
	let preparedRevision: string | undefined;
	let preparedModel: string | undefined;
	let lastToolRecord: string | undefined;
	let restoredTools: ToolPolicySnapshot | undefined;
	let agentBusy = false;
	let disposed = false;
	let lifecycleRevision = 0;

	function setAgentBusy(busy: boolean): void {
		agentBusy = busy;
	}

	function isBusy(ctx?: ExtensionContext): boolean {
		if (agentBusy) return true;
		const targetCtx = ctx ?? context;
		if (targetCtx && typeof targetCtx.isIdle === "function") {
			return !targetCtx.isIdle();
		}
		return false;
	}

	function view(ctx: ExtensionContext) {
		const history = readCapabilitySession(ctx);
		const state = reduceCapabilityEvents(history.events);
		if (!state.ok) throw new Error(state.error);
		return { history, state };
	}

	function rememberTools(ctx: ExtensionContext): void {
		const history = readCapabilitySession(ctx);
		if (!history.events.length && !history.tools && !hasToolSelectionPolicy(workspace.snapshotKnown ? workspace.snapshot().active?.stack.tools : undefined)) return;
		const snapshot = tools.snapshot();
		const serialized = JSON.stringify(snapshot);
		if (serialized !== lastToolRecord) {
			persistCapabilityTools(pi, snapshot);
			lastToolRecord = serialized;
		}
	}

	function prepareRestore(ctx: ExtensionContext): void {
		disposed = false;
		lifecycleRevision++;
		context = ctx;
		restoring = true;
		preparedRevision = undefined;
		preparedModel = undefined;
		lastToolRecord = undefined;
		agentBusy = false;
		const history = readCapabilitySession(ctx);
		// A branch without a durable baseline must not replace an existing pristine
		// baseline with the currently filtered selection. Let its owner reconcile it.
		restoredTools = history.tools;
		tools.setCapabilities([]);
	}

	function restore(ctx: ExtensionContext, options?: { deferToolPolicy?: boolean }): void {
		if (disposed) return;
		context = ctx;
		restoring = false;
		agentBusy = false;
		if (!options?.deferToolPolicy) sync(ctx);
	}

	function sync(ctx: ExtensionContext | undefined = context): void {
		if (restoring) return;
		if (!ctx) { tools.sync(ctx); return; }
		context = ctx;
		let current = view(ctx);
		const preset = workspace.snapshotKnown && workspace.snapshot().active;
		const presetKey = preset ? formatResourceKey(preset.key) : undefined;
		let lastRetired: string | undefined;
		for (const item of current.state.active) {
			const source = item.snapshot.source;
			if (source.kind !== "capability" || !source.binding || formatResourceKey(source.binding.preset) === presetKey) continue;
			const event: CapabilityEvent = {
				schemaVersion: 1, eventId: randomUUID(), op: "deactivate", actor: "lifecycle",
				createdAt: Date.now(), activationId: item.snapshot.activationId,
			};
			persistCapabilityEvent(pi, event);
			lastRetired = event.eventId;
		}
		if (lastRetired) {
			if (!isBusy(ctx)) persistPendingAnchors(ctx);
			current = view(ctx);
		}
		if (!ctx.isProjectTrusted() && current.state.active.length) {
			throw new Error("Active capabilities require a trusted project. Use /capability reset to clear them, or trust the project.");
		}
		const patches = current.state.active.map((item) => item.snapshot.tools);
		const error = tools.validateCapabilities(patches);
		if (error) throw new Error(error);
		tools.setCapabilities(patches, restoredTools);
		restoredTools = undefined;
		tools.sync(ctx);
		rememberTools(ctx);
	}

	function pendingEvents(ctx: ExtensionContext): CapabilityEvent[] {
		const history = readCapabilitySession(ctx);
		const checkpoint = history.events.findIndex(event => event.eventId === history.checkpointThrough);
		const through = Math.max(history.lastAnchoredIndex, checkpoint);
		const seen = new Set<string>();
		return history.events.filter((event, index) => {
			if (seen.has(event.eventId)) return false;
			seen.add(event.eventId);
			return index > through;
		});
	}

	function persistPendingAnchors(ctx: ExtensionContext): void {
		// Do not collapse a saved-but-unanchored activate/off sequence into net state.
		for (const event of pendingEvents(ctx)) persistCapabilityDelivery(pi, event.eventId);
	}

	function canonicalSessionMessages(ctx: ExtensionContext): AgentMessage[] {
		return buildSessionProjection(getCurrentBranchEntries(ctx) as SessionEntry[]).messages;
	}

	function prepareMessages(raw: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		context = ctx;
		if (pendingEvents(ctx).length > 0) {
			// Context hooks should run after a complete batch. Never project pending
			// deltas into an unresolved current batch if that invariant is broken.
			if (hasPendingCapabilityToolCalls(raw)) {
				throw new Error("Cannot prepare capability anchors during an incomplete tool batch.");
			}
			if (!capabilityContextMatches(canonicalSessionMessages(ctx), raw)) {
				throw new Error("Cannot materialize capability anchors: context has no unique session alignment (possible preceding extension rewrite or deferred custom messages)");
			}
			persistPendingAnchors(ctx);
		}
		return materializeCapabilityAnchors(getCurrentBranchEntries(ctx), raw);
	}

	function project(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		const { history, state } = view(ctx);
		if (!ctx.isProjectTrusted()) return messages.filter((message) => !isCapabilityDelivery(message));
		const native = (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
		const projected = projectCapabilityMessages(messages, history, native);
		preparedRevision = projected.throughEventId;
		preparedModel = modelKey(ctx);
		if (state.lastEventId) ctx.ui.setStatus("pi-forge-capabilities", `${state.active.length} capability(s) · request prepared`);
		return projected.messages;
	}

	function commit(ctx: ExtensionContext, event: CapabilityEvent): void {
		const current = view(ctx);
		const next = reduceCapabilityEvents([...current.history.events, event]);
		if (!next.ok) throw new Error(next.error);
		const problem = tools.validateCapabilities(next.active.map((item) => item.snapshot.tools));
		if (problem) throw new Error(problem);
		// Persist the pristine/reconciled baseline before a branch can land on the activation entry.
		tools.sync(ctx);
		const before = tools.snapshot();
		if (JSON.stringify(current.history.tools) !== JSON.stringify(before)) {
			persistCapabilityTools(pi, before);
			lastToolRecord = JSON.stringify(before);
		}
		persistCapabilityEvent(pi, event);
		// Any failure after saving intent remains recoverable; never imply rollback.
		try {
			if (!isBusy(ctx)) persistPendingAnchors(ctx);
			sync(ctx);
			ctx.ui.setStatus("pi-forge-capabilities", `${next.active.length} capability(s) · pending request`);
		} catch (error) {
			preparedRevision = undefined;
			throw new Error(`Capability event saved but application is pending: ${error instanceof Error ? error.message : "delivery failure"}`);
		}
	}

	function library(ctx: ExtensionContext): string {
		const capabilities = workspace.reloadCapabilities(ctx.cwd, ctx.isProjectTrusted()).capabilities;
		return capabilities.length ? capabilities.map((loaded) => {
			const errors = loaded.diagnostics.filter((d) => d.level === "error").map((d) => d.message);
			return `${formatResourceKey(loaded.key)}${loaded.capability.name ? ` — ${loaded.capability.name}` : ""}${errors.length ? ` [invalid: ${errors.join("; ")}]` : ""}`;
		}).join("\n") : "No capabilities. Place JSON in .pi/forge/capabilities/ or ~/.pi/forge/capabilities/.";
	}

	/**
	 * Completion-only projection. It deliberately consumes the current session
	 * and the last published workspace snapshot; unlike library()/readBindings()
	 * it never reloads files or publishes a snapshot on a keystroke.
	 */
	function completionView(ctx?: ExtensionContext): CapabilityCompletionViewResult {
		const target = ctx ?? context;
		if (disposed || restoring || !target || (ctx && !sameContext(context!, ctx))) {
			return { ok: false, error: "Capability runtime is not active for this session." };
		}
		try {
			const trusted = target.isProjectTrusted();
			const snapshot = workspace.snapshot();
			if (!workspace.snapshotKnown || snapshot.cwd !== target.cwd) return { ok: false, error: "Workspace completion snapshot does not match the current project." };
			const { state } = view(target);
			const active = state.active.map((item) => {
				const source = sourceLabel(item);
				const name = item.snapshot.name;
				return {
					id: item.snapshot.activationId,
					label: `${source}${name ? ` — ${name}` : ""} [${item.actor}]`,
				};
			});
			if (!trusted) {
				return { ok: true, trusted: false, capturedAt: snapshot.capturedAt, capabilities: [], bindings: [], active };
			}

			const capabilities = snapshot.capabilities
				.filter((loaded) => isUsableCapability(loaded))
				.map((loaded) => ({
					id: formatResourceKey(loaded.key),
					label: `${formatResourceKey(loaded.key)}${loaded.capability.name ? ` — ${loaded.capability.name}` : ""}`,
				}));
			const bindings: CapabilityCompletionBinding[] = [];
			const preset = snapshot.active;
			if (preset && (preset.stack.capabilities?.length ?? 0) > 0) {
				const resolved = resolveCapabilityBindings(
					createResourceCatalog([...snapshot.capabilities]),
					preset.key,
					preset.stack.capabilities ?? [],
				);
				if (!resolved.ok) return { ok: false, error: resolved.error };
				for (const binding of resolved.bindings) {
					const readable = binding.capability.name ?? formatResourceKey(binding.ref);
					bindings.push({
						id: binding.id,
						modelCallable: binding.modelCallable,
						label: `${binding.id} — ${readable}${binding.modelCallable ? "" : " [human-only]"}`,
					});
				}
			}
			return { ok: true, trusted: true, capturedAt: snapshot.capturedAt, capabilities, bindings, active };
		} catch (error) {
			return { ok: false, error: `Capability completion unavailable: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	function modelKey(ctx: ExtensionContext): string {
		return JSON.stringify([ctx.model?.provider, ctx.model?.id, (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true]);
	}

	/** Reading the browser view must never append entries, sync tools or start inference. */
	function readState(): CapabilityStateResult {
		const ctx = context;
		if (!ctx) return { ok: false, status: 503, error: "No active Forge session." };
		try {
			const { history, state } = view(ctx);
			const active = state.active.map((item) => ({
				activationId: item.snapshot.activationId,
				source: sourceLabel(item),
				...(item.snapshot.name === undefined ? {} : { name: item.snapshot.name }),
				actor: item.actor,
				content: item.snapshot.content,
				tools: { add: [...item.snapshot.tools.add], remove: [...item.snapshot.tools.remove] },
			}));
			const trusted = ctx.isProjectTrusted();
			const effectiveTools = [...pi.getActiveTools()];
			const model = modelKey(ctx);
			const delivery = !state.lastEventId ? "none" : preparedRevision === state.lastEventId && preparedModel === model ? "prepared" : "pending";
			const problem = tools.validateCapabilities(active.map((item) => item.tools));
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const preset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
			const revision = fingerprintJson({ domain: "forge-capability-view-v1", instanceId, lifecycleRevision, sessionId, leafId,
				lastEventId: state.lastEventId, active, effectiveTools, trusted, restoring, model, delivery,
				preset: preset ? { key: preset.key, tools: preset.stack.tools, capabilities: preset.stack.capabilities ?? [] } : null, baseline: history.tools });
			const result: CapabilityStateView = {
				guard: { sessionId, leafId, revision }, trusted, restoring, delivery,
				...(preset ? { presetRevision: fingerprintJson({ domain: "forge-inspection-preset-v1", key: preset.key, stack: preset.stack }) } : {}),
				textPresentation: (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true ? "native" : "user",
				effectiveTools, active, ...(problem ? { problem } : {}),
				// Derived from persisted usage only; leafId already changes the guard for each new request.
				cacheUsage: summarizeSessionCacheUsage(getCurrentBranchEntries(ctx)),
			};
			return { ok: true, state: result };
		} catch (error) {
			return { ok: false, status: 503, error: `Capability state unavailable: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	function choiceForCapability(kind: "capability" | "binding", id: string, capability: { content: string; tools: { add: string[]; remove: string[] }; name?: string }, source: Parameters<typeof createCapabilitySnapshot>[0]["source"]): CapabilityChoice {
		const snapshot = createCapabilitySnapshot({
			activationId: randomUUID(),
			source,
			...(capability.name === undefined ? {} : { name: capability.name }),
			content: capability.content,
			tools: capability.tools,
		});
		const problem = tools.validateCapabilities([capability.tools]);
		return {
			kind,
			id,
			label: capability.name ?? id,
			content: capability.content,
			tools: { add: [...capability.tools.add], remove: [...capability.tools.remove] },
			fingerprint: snapshot.fingerprint,
			...(problem ? { problem } : {}),
		};
	}

	/** Read-only resource discovery for the human web client. */
	function readAvailableCapabilities(): CapabilityAvailableResult {
		const stateResult = readState();
		if (!stateResult.ok) return stateResult;
		const ctx = context;
		if (!ctx) return { ok: false, status: 503, error: "No active Forge session." };
		if (!stateResult.state.trusted) return { ok: false, status: 403, error: "Project is not trusted." };
		if (stateResult.state.restoring || disposed) return { ok: false, status: 503, error: "Capability session is restoring." };
		try {
			if (!ctx.isProjectTrusted()) return { ok: false, status: 403, error: "Project is not trusted." };
			const capabilities = workspace.reloadCapabilities(ctx.cwd, ctx.isProjectTrusted()).capabilities;
			const choices: CapabilityChoice[] = [];
			for (const loaded of capabilities) {
				if (!isUsableCapability(loaded)) continue;
				choices.push(choiceForCapability("capability", formatResourceKey(loaded.key), loaded.capability, { kind: "capability", key: loaded.key }));
			}
			const bindings = readBindings(ctx);
			if (!bindings.ok) return { ok: false, status: 409, error: bindings.error };
			for (const binding of bindings.bindings) {
				choices.push(choiceForCapability("binding", binding.id, binding.capability, {
					kind: "capability",
					key: binding.ref,
					binding: { preset: binding.preset, id: binding.id },
				}));
			}
			const finalState = readState();
			if (!finalState.ok) return finalState;
			if (!sameGuard(stateResult.state.guard, finalState.state.guard)) return { ok: false, status: 409, error: "Session changed during resource discovery. Refresh and review." };
			return { ok: true, state: finalState.state, choices };
		} catch (error) {
			return { ok: false, status: 503, error: `Capability choices unavailable: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	/** Guarded, explicit human web activation. It never retries or infers. */
	function enableCapability(input: unknown): CapabilityStateResult {
		if (!isCapabilityEnableRequest(input)) return { ok: false, status: 400, error: "Invalid capability activation payload." };
		const initial = readState();
		if (!initial.ok) return initial;
		if (disposed || initial.state.restoring) return { ok: false, status: 503, error: "Capability session is restoring." };
		if (!initial.state.trusted) return { ok: false, status: 403, error: "Project is not trusted." };
		if (!sameGuard(input.guard, initial.state.guard)) return { ok: false, status: 409, error: "Session, branch or capability state changed. Refresh and review before trying again." };
		const ctx = context;
		if (!ctx) return { ok: false, status: 503, error: "No active Forge session." };
		try {
			let expected = "";
			if (input.kind === "capability") {
				const parsed = parseResourceSelector(input.id);
				if (!parsed.ok || !parsed.selector.scope) return { ok: false, status: 409, error: "Direct capability IDs must be qualified resource IDs." };
				if (!ctx.isProjectTrusted()) return { ok: false, status: 403, error: "Project is not trusted." };
				const capabilities = workspace.reloadCapabilities(ctx.cwd, ctx.isProjectTrusted()).capabilities;
				const resolved = resolveCapability(createResourceCatalog([...capabilities]), input.id);
				if (!resolved.ok) return { ok: false, status: 409, error: resolved.error };
				const capability = resolved.loaded.capability;
				expected = choiceForCapability("capability", input.id, capability, { kind: "capability", key: resolved.loaded.key }).fingerprint;
				if (expected !== input.fingerprint) return { ok: false, status: 409, error: "Capability source changed. Refresh and review before trying again." };
			} else {
				const bindings = readBindings(ctx);
				if (!bindings.ok) return { ok: false, status: 409, error: bindings.error };
				const binding = bindings.bindings.find((candidate) => candidate.id === input.id);
				if (!binding) return { ok: false, status: 409, error: "Capability binding changed or is no longer available. Refresh and review before trying again." };
				expected = choiceForCapability("binding", binding.id, binding.capability, {
					kind: "capability", key: binding.ref, binding: { preset: binding.preset, id: binding.id },
				}).fingerprint;
				if (expected !== input.fingerprint) return { ok: false, status: 409, error: "Capability binding changed. Refresh and review before trying again." };
			}
			const checked = readState();
			if (!checked.ok) return checked;
			if (checked.state.restoring || !checked.state.trusted || !sameGuard(input.guard, checked.state.guard)) {
				return { ok: false, status: checked.state.trusted ? 409 : 403, error: checked.state.trusted ? "Session, branch or capability state changed. Refresh and review before trying again." : "Project is not trusted." };
			}
			if (input.kind === "binding") {
				const result = enableBound(ctx, input.id, "user", expected, input.guard);
				if (!result.ok) {
					try {
						if (!ctx.isProjectTrusted()) return { ok: false, status: 403, error: result.error };
					} catch {
						return { ok: false, status: 503, error: "Capability session is unavailable." };
					}
					return { ok: false, status: 409, error: result.error };
				}
			} else {
				change(ctx, "enable", input.id, expected, input.guard);
			}
			return readState();
		} catch (error) {
			try {
				if (!ctx.isProjectTrusted()) return { ok: false, status: 403, error: "Project is not trusted." };
			} catch {
				return { ok: false, status: 503, error: "Capability session is unavailable." };
			}
			return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Human Web controls share CLI semantics, with an exact displayed-view guard. */
	function mutateState(input: unknown): CapabilityStateResult {
		if (!isCapabilityStateMutation(input)) return { ok: false, status: 400, error: "Invalid capability state operation." };
		const current = readState();
		if (!current.ok) return current;
		if (!current.state.trusted) return { ok: false, status: 403, error: "Project is not trusted. Use the human CLI for recovery." };
		const guard = current.state.guard;
		if (current.state.restoring || input.guard.sessionId !== guard.sessionId || input.guard.leafId !== guard.leafId || input.guard.revision !== guard.revision) {
			return { ok: false, status: 409, error: "Session, branch or capability state changed. Refresh and review before trying again." };
		}
		if (input.action === "disable" && !current.state.active.some((item) => item.activationId === input.activationId)) {
			return { ok: false, status: 404, error: "No active capability with that activation ID." };
		}
		try {
			// No await between checking the guard and committing to the current session.
			change(context!, input.action, input.action === "disable" ? input.activationId : "");
			return readState();
		} catch (error) {
			return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
		}
	}

	function status(ctx: ExtensionContext, includeRuleContent = true): string {
		const { state } = view(ctx);
		const presentation = (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true ? "native system sections" : "attributed user updates";
		const delivery = !state.lastEventId ? "none" : preparedRevision === state.lastEventId && preparedModel === modelKey(ctx) ? "request prepared (not a model-obedience or delivery acknowledgment)" : "pending next request";
		return [
			`Capability capabilities: ${state.active.length}; ${presentation}; ${delivery}`,
			`Currently selected tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
			"Tool transport is provider-managed: native text does not guarantee incremental tools. Full schema resubmission and cache changes are possible; prepared does not guarantee delivery or cache hits.",
			...state.active.flatMap((item) => [
				`${item.snapshot.activationId} · ${sourceLabel(item)} · ${item.actor}`,
				`  +tools: ${item.snapshot.tools.add.join(", ") || "(none)"}; -tools: ${item.snapshot.tools.remove.join(", ") || "(none)"}`,
				...(includeRuleContent ? [item.snapshot.content] : []),
			]),
		].join("\n");
	}

	function change(ctx: ExtensionContext, command: "add" | "enable" | "enable-bound" | "disable" | "reset", value: string, expectedFingerprint?: string, expectedGuard?: CapabilityStateGuard): string {
		if (disposed || restoring || (context !== undefined && !sameContext(context, ctx))) throw new Error("Capability runtime is no longer active for this session.");
		context = ctx;
		const { state } = view(ctx);
		if ((command === "add" || command === "enable" || command === "enable-bound") && !ctx.isProjectTrusted()) throw new Error("Project is not trusted; refusing to activate an capability.");
		const common = { schemaVersion: 1 as const, eventId: randomUUID(), actor: "user" as const, createdAt: Date.now() };
		if (command === "reset") {
			if (!state.active.length) return "No active capabilities to reset.";
			commit(ctx, { ...common, op: "reset" });
			return "Capabilities stopped; tools recomputed. Historical messages and completed work are not undone.";
		}
		if (!value.trim()) throw new Error(`Usage: /capability ${command} <${command === "add" ? "text" : "id"}>`);
		if (command === "enable-bound") {
			const res = enableBound(ctx, value.trim(), "user");
			if (!res.ok) throw new Error(res.error);
			return res.message;
		}
		if (command === "disable") {
			const matches = state.active.filter((item) => item.snapshot.activationId === value || sourceLabel(item) === value
				|| (item.snapshot.source.kind === "capability" && item.snapshot.source.key.id === value)
				|| (item.snapshot.source.kind === "capability" && item.snapshot.source.binding && item.snapshot.source.binding.id === value));
			if (!matches.length) return "No matching active capability (already disabled or unknown ID).";
			if (matches.length !== 1) throw new Error("Ambiguous capability name; use the activation ID from /capability status.");
			commit(ctx, { ...common, op: "deactivate", activationId: matches[0]!.snapshot.activationId });
			return `Stopped ${matches[0]!.snapshot.activationId}; tools recomputed, stop notice pending next request.`;
		}
		let input: Parameters<typeof createCapabilitySnapshot>[0];
		if (command === "add") {
			input = { activationId: randomUUID(), source: { kind: "manual" }, content: value, tools: { add: [], remove: [] } };
		} else {
			const capabilities = workspace.reloadCapabilities(ctx.cwd, ctx.isProjectTrusted()).capabilities;
			const resolved = resolveCapability(createResourceCatalog([...capabilities]), value);
			if (!resolved.ok) throw new Error(resolved.error);
			assertActivationGuard(expectedGuard);
			const existing = state.active.find((item) => item.snapshot.source.kind === "capability" && !item.snapshot.source.binding
				&& formatResourceKey(item.snapshot.source.key) === formatResourceKey(resolved.loaded.key));
			if (existing) return `Already selected as ${existing.snapshot.activationId}; source edits do not change this snapshot. Disable/enable to reapply.`;
			const capability = resolved.loaded.capability;
			input = { activationId: randomUUID(), source: { kind: "capability", key: resolved.loaded.key }, content: capability.content, tools: capability.tools,
				...(capability.name === undefined ? {} : { name: capability.name }) };
		}
		const snapshot = createCapabilitySnapshot(input);
		if (expectedFingerprint !== undefined && snapshot.fingerprint !== expectedFingerprint) {
			throw new Error("Capability source changed. Refresh and review before trying again.");
		}
		commit(ctx, { ...common, op: "activate", snapshot });
		return selectedMessage(snapshot);
	}

	function readBindings(ctx: ExtensionContext): ReadBindingsResult {
		if (!ctx.isProjectTrusted()) {
			return { ok: false, error: "Project is not trusted; cannot read capability bindings." };
		}
		const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!activePreset) {
			return { ok: true, preset: null, bindings: [] };
		}
		const declaredBindings = activePreset.stack.capabilities ?? [];
		const presetMarker = fingerprintJson({ key: activePreset.key, stack: activePreset.stack });
		if (declaredBindings.length === 0) {
			return { ok: true, preset: activePreset.key, bindings: [] };
		}
		const capabilities = workspace.reloadCapabilities(ctx.cwd, ctx.isProjectTrusted()).capabilities;
		const afterReload = workspace.snapshot().active;
		if (!afterReload || fingerprintJson({ key: afterReload.key, stack: afterReload.stack }) !== presetMarker) {
			return { ok: false, error: "Active preset changed while resolving capability bindings. Refresh and try again." };
		}
		const catalog = createResourceCatalog([...capabilities]);
		const res = resolveCapabilityBindings(catalog, activePreset.key, declaredBindings);
		if (!res.ok) {
			return { ok: false, error: res.error };
		}
		return { ok: true, preset: activePreset.key, bindings: res.bindings };
	}

	function enableBound(ctx: ExtensionContext, id: string, actor: "user" | "agent" = "user", expectedFingerprint?: string, expectedGuard?: CapabilityStateGuard): EnableBoundResult {
		if (disposed || restoring || (context !== undefined && !sameContext(context, ctx))) {
			return { ok: false, error: "Capability runtime is no longer active for this session." };
		}
		context = ctx;
		if (!ctx.isProjectTrusted()) {
			return { ok: false, error: "Project is not trusted; refusing to activate an capability." };
		}
		if (typeof id !== "string" || !id.trim()) {
			return { ok: false, error: "Binding ID must be a non-empty string." };
		}
		const targetId = id.trim();
		if (targetId.length > MAX_ID_LENGTH) {
			return { ok: false, error: `Binding ID must be at most ${MAX_ID_LENGTH} characters.` };
		}
		const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!activePreset) {
			return { ok: false, error: "No active preset; cannot activate a bound capability." };
		}
		const bindingsRes = readBindings(ctx);
		if (!bindingsRes.ok) {
			return { ok: false, error: bindingsRes.error };
		}
		const binding = bindingsRes.bindings.find((b) => b.id === targetId);
		if (!binding) {
			return {
				ok: false,
				error: `Capability "${targetId}" is not bound to active preset "${formatResourceKey(activePreset.key)}".`,
			};
		}

		if (actor === "agent") {
			if (!binding.modelCallable) {
				return {
					ok: false,
					error: `Capability "${targetId}" is not authorized for agent use (modelCallable is not true).`,
				};
			}
			if (binding.capability.tools.remove.includes("forge_capability")) {
				return {
					ok: false,
					error: `Cannot activate capability "${targetId}": agent cannot remove control tool "forge_capability".`,
				};
			}
			const allTools = pi.getAllTools();
			const activeTools = pi.getActiveTools();
			if (
				!allTools.some((t) => t.name === "forge_capability") ||
				!activeTools.includes("forge_capability") ||
				tools.blockReason("forge_capability") !== undefined
			) {
				return { ok: false, error: 'Control tool "forge_capability" is not available or blocked by policy.' };
			}
		}

		const policyErr = tools.validateCapabilities([binding.capability.tools]);
		if (policyErr) {
			return { ok: false, error: `Cannot activate capability "${targetId}": ${policyErr}` };
		}

		try { assertActivationGuard(expectedGuard); } catch (error) { return {ok: false, error: String(error)}; }
		// Repeated use idempotent/no owner takeover
		const { state } = view(ctx);
		const existing = state.active.find(
			(item) =>
				item.snapshot.source.kind === "capability" &&
				item.snapshot.source.binding &&
				formatResourceKey(item.snapshot.source.binding.preset) === formatResourceKey(binding.preset) &&
				item.snapshot.source.binding.id === binding.id &&
				formatResourceKey(item.snapshot.source.key) === formatResourceKey(binding.ref),
		);
		const stale = state.active.find(
			(item) =>
				item.snapshot.source.kind === "capability" &&
				item.snapshot.source.binding &&
				formatResourceKey(item.snapshot.source.binding.preset) === formatResourceKey(binding.preset) &&
				item.snapshot.source.binding.id === binding.id,
		);
		if (stale && !existing) {
			return {
				ok: false,
				error: `Capability "${targetId}" has a stale binding identity; disable the old activation before reusing it.`,
			};
		}
		if (existing) {
			return {
				ok: true,
				activationId: existing.snapshot.activationId,
				idempotent: true,
				message: `Capability "${targetId}" is already active as ${existing.snapshot.activationId}. Repeated use is idempotent and does not change ownership.`,
			};
		}

		const snapshot = createCapabilitySnapshot({
			activationId: randomUUID(),
			source: {
				kind: "capability",
				key: binding.ref,
				binding: {
					preset: binding.preset,
					id: binding.id,
				},
			},
			content: binding.capability.content,
			tools: binding.capability.tools,
			...(binding.capability.name !== undefined ? { name: binding.capability.name } : {}),
		});
		if (expectedFingerprint !== undefined && snapshot.fingerprint !== expectedFingerprint) {
			return { ok: false, error: "Capability source or binding changed. Refresh and review before trying again." };
		}

		try {
			commit(ctx, {
				schemaVersion: 1,
				eventId: randomUUID(),
				op: "activate",
				actor,
				createdAt: Date.now(),
				snapshot,
			});
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		return {
			ok: true,
			activationId: snapshot.activationId,
			message: selectedMessage(snapshot),
		};
	}

	function selectedMessage(snapshot: { activationId: string; content: string }): string {
		const delivery = snapshot.content.trim().length === 0
			? "tools prepared; tool-only capability, no instruction text is sent."
			: "tools prepared, instruction pending next model request.";
		return `Selected ${snapshot.activationId}; ${delivery} Use /capability disable ${snapshot.activationId} to stop.`;
	}

	function disableBound(ctx: ExtensionContext, id: string, actor: "user" | "agent" = "user"): DisableBoundResult {
		if (disposed || restoring || (context !== undefined && !sameContext(context, ctx))) {
			return { ok: false, error: "Capability runtime is no longer active for this session." };
		}
		context = ctx;
		if (!ctx.isProjectTrusted()) {
			return { ok: false, error: "Project is not trusted; refusing to deactivate an capability." };
		}
		if (typeof id !== "string" || !id.trim()) {
			return { ok: false, error: "Invalid capability id." };
		}
		const targetId = id.trim();
		if (targetId.length > MAX_ID_LENGTH) {
			return { ok: false, error: `Capability ID must be at most ${MAX_ID_LENGTH} characters.` };
		}
		const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;

		if (actor === "agent") {
			const allTools = pi.getAllTools();
			const activeTools = pi.getActiveTools();
			if (
				!allTools.some((t) => t.name === "forge_capability") ||
				!activeTools.includes("forge_capability") ||
				tools.blockReason("forge_capability") !== undefined
			) {
				return { ok: false, error: 'Control tool "forge_capability" is not available or blocked by policy.' };
			}
			if (!activePreset) {
				return { ok: false, error: "forge_capability disable requires an active preset with bound capabilities." };
			}
		}

		const { state } = view(ctx);
		const matches = state.active.filter(
			(item) =>
				item.snapshot.activationId === targetId ||
				sourceLabel(item) === targetId ||
				(item.snapshot.source.kind === "capability" && item.snapshot.source.key.id === targetId) ||
				(item.snapshot.source.kind === "capability" &&
					item.snapshot.source.binding &&
					item.snapshot.source.binding.id === targetId),
		);

		if (!matches.length) {
			return { ok: false, error: `No matching active capability: ${targetId}` };
		}
		if (matches.length > 1) {
			return { ok: false, error: `Ambiguous active capability "${targetId}"; use its activation ID.` };
		}
		const target = matches[0]!;

		if (actor === "agent") {
			if (target.actor !== "agent") {
				return { ok: false, error: `Agent cannot deactivate user-owned activation: ${target.snapshot.activationId}` };
			}
			const source = target.snapshot.source;
			if (source.kind !== "capability" || !source.binding) {
				return { ok: false, error: `Agent cannot deactivate unbound or manual capability: ${target.snapshot.activationId}` };
			}
			// Current authorization required
			const bindingsRes = readBindings(ctx);
			if (!bindingsRes.ok) {
				return { ok: false, error: `Failed to resolve active preset bindings: ${bindingsRes.error}` };
			}
			const currentBinding = bindingsRes.bindings.find((b) => b.id === source.binding!.id);
			const samePreset = formatResourceKey(source.binding.preset) === formatResourceKey(activePreset!.key);
			const sameCapability = currentBinding && formatResourceKey(source.key) === formatResourceKey(currentBinding.ref);
			if (!currentBinding || !samePreset || !sameCapability || !currentBinding.modelCallable) {
				return {
					ok: false,
					error: `Cannot deactivate capability "${targetId}": current authorization requires the exact active-preset binding identity (including its capability source) and modelCallable authorization.`,
				};
			}
		}

		try {
			commit(ctx, {
				schemaVersion: 1,
				eventId: randomUUID(),
				op: "deactivate",
				actor,
				createdAt: Date.now(),
				activationId: target.snapshot.activationId,
			});
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}

		return {
			ok: true,
			activationId: target.snapshot.activationId,
			message: `Stopped ${target.snapshot.activationId}; tools recomputed, stop notice pending next request.`,
		};
	}

	async function executeAgentTool(
		ctx: ExtensionContext,
		params: unknown,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
		if (disposed || restoring) {
			throw new Error("forge_capability is unavailable for this session.");
		}
		if (!isPlainObject(params)) {
			throw new Error("forge_capability parameters must be a plain object.");
		}
		const allowedKeys = new Set(["action", "id"]);
		for (const key of Object.keys(params)) {
			if (!allowedKeys.has(key)) {
				throw new Error(`forge_capability: unknown argument "${key}". Only "action" and "id" are permitted.`);
			}
		}
		const action = params.action;
		if (action !== "list" && action !== "status" && action !== "enable" && action !== "disable") {
			throw new Error(`forge_capability: invalid action "${String(action)}". Expected "list", "status", "enable", or "disable".`);
		}
		if (action === "list" || action === "status") {
			if (params.id !== undefined) {
				throw new Error(`forge_capability: argument "id" is irrelevant for action "${action}".`);
			}
		}
		if (action === "enable" || action === "disable") {
			if (typeof params.id !== "string" || !params.id.trim()) {
				throw new Error(`forge_capability: argument "id" is required for action "${action}".`);
			}
			if (params.id.trim().length > MAX_ID_LENGTH) {
				throw new Error(`forge_capability: argument "id" must be at most ${MAX_ID_LENGTH} characters.`);
			}
		}

		// EACH call checks: current trust, control-tool availability, active preset
		if (!ctx.isProjectTrusted()) {
			throw new Error("forge_capability requires a trusted project.");
		}
		if (context !== undefined && !sameContext(context, ctx)) throw new Error("forge_capability is unavailable for this session.");
		context = ctx;
		const allTools = pi.getAllTools();
		const activeTools = pi.getActiveTools();
		if (
			!allTools.some((t) => t.name === "forge_capability") ||
			!activeTools.includes("forge_capability") ||
			tools.blockReason("forge_capability") !== undefined
		) {
			throw new Error('Control tool "forge_capability" is not available or blocked by policy.');
		}
		const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
		if (!activePreset) {
			throw new Error("forge_capability requires an active preset with bound capabilities.");
		}

		if (action === "list") {
			const bindingsRes = readBindings(ctx);
			if (!bindingsRes.ok) throw new Error(bindingsRes.error);
			const eligible = bindingsRes.bindings.filter((b) => {
				if (!b.modelCallable) return false;
				if (b.capability.tools.remove.includes("forge_capability")) return false;
				if (tools.validateCapabilities([b.capability.tools]) !== undefined) return false;
				return true;
			});
			const text = eligible.length
				? eligible
					.map((b) =>
						[
							`id: ${b.id}${b.capability.name ? ` (${b.capability.name})` : ""}`,
							b.capability.description ? `  description: ${b.capability.description}` : undefined,
							`  tools: +${b.capability.tools.add.join(", ") || "(none)"}; -${b.capability.tools.remove.join(", ") || "(none)"}`,
						]
							.filter(Boolean)
							.join("\n"),
					)
					.join("\n\n")
				: "No authorized capabilities available for agent.";
			return {
				content: [{ type: "text", text }],
				details: {
					action: "list",
					capabilities: eligible.map((b) => ({ id: b.id, name: b.capability.name, tools: b.capability.tools })),
				},
			};
		}

		if (action === "status") {
			const { state } = view(ctx);
			const text = status(ctx, false);
			return {
				content: [{ type: "text", text }],
				details: {
					action: "status",
					activeCount: state.active.length,
					active: state.active.map((item) => ({
						activationId: item.snapshot.activationId,
						actor: item.actor,
						source: sourceLabel(item),
						bindingId:
							item.snapshot.source.kind === "capability" && item.snapshot.source.binding
								? item.snapshot.source.binding.id
								: undefined,
						tools: item.snapshot.tools,
					})),
				},
			};
		}

		if (action === "enable") {
			const res = enableBound(ctx, params.id as string, "agent");
			if (!res.ok) {
				throw new Error(res.error);
			}
			return {
				content: [{ type: "text", text: res.message }],
				details: { action: "enable", activationId: res.activationId, idempotent: res.idempotent === true },
			};
		}

		if (action === "disable") {
			const res = disableBound(ctx, params.id as string, "agent");
			if (!res.ok) {
				throw new Error(res.error);
			}
			return {
				content: [{ type: "text", text: res.message }],
				details: { action: "disable", activationId: res.activationId },
			};
		}

		throw new Error(`Unhandled action: ${action}`);
	}

	function commitEndAnchors(ctx: ExtensionContext): void {
		context = ctx;
		if (restoring) return;
		if (!pendingEvents(ctx).length) return;
		// Interrupted batches may leave an incomplete current tail. Keep intent
		// pending rather than anchoring between its call and a later result.
		if (hasPendingCapabilityToolCalls(canonicalSessionMessages(ctx))) return;
		persistPendingAnchors(ctx);
	}

	function assertActivationGuard(expected?: CapabilityStateGuard): void {
		if (!expected) return;
		const current = readState();
		if (disposed || !current.ok || current.state.restoring || !current.state.trusted || !sameGuard(expected, current.state.guard)) {
			throw new Error("Session changed during resource resolution. Refresh and review before activating.");
		}
	}

	function sameGuard(a: { sessionId: string; leafId: string | null; revision: string }, b: { sessionId: string; leafId: string | null; revision: string }): boolean {
		return a.sessionId === b.sessionId && a.leafId === b.leafId && a.revision === b.revision;
	}

	function sameContext(a: ExtensionContext, b: ExtensionContext): boolean {
		try {
			if (!a.sessionManager || !b.sessionManager) return false;
			return a.cwd === b.cwd && a.sessionManager.getSessionId() === b.sessionManager.getSessionId()
				&& a.sessionManager.getLeafId() === b.sessionManager.getLeafId();
		} catch {
			return false;
		}
	}

	function dispose(): void {
		disposed = true;
		context = undefined;
		restoring = true;
		preparedRevision = undefined;
		preparedModel = undefined;
		restoredTools = undefined;
		agentBusy = false;
	}

	return { prepareRestore, restore, sync, prepareMessages, project, commitEndAnchors, setAgentBusy, library, completionView, status, change, readBindings, enableBound, disableBound, executeAgentTool, readState, mutateState, readAvailableCapabilities, enableCapability, dispose };
}

function sourceLabel(item: ActiveCapability): string {
	return item.snapshot.source.kind === "manual" ? "manual" : formatResourceKey(item.snapshot.source.key);
}

export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>;
