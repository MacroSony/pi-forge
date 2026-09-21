import { randomUUID } from "node:crypto";
import { fingerprintJson } from "../json-fingerprint.ts";
import { isInstructionStateMutation, type InstructionStateResult, type InstructionStateView } from "../instruction-state.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createResourceCatalog } from "../catalog.ts";
import { createInstructionSnapshot, reduceInstructionEvents, type ActiveInstruction, type InstructionEvent } from "../instruction-events.ts";
import { resolveInstructionMode } from "../instruction-modes.ts";
import { projectInstructionMessages } from "../instruction-projection.ts";
import { INSTRUCTION_DELIVERY_TYPE, isInstructionDelivery } from "../instruction-protocol.ts";
import { formatResourceKey } from "../resource-identity.ts";
import { hasResourcePolicy } from "../policy.ts";
import { persistInstructionEvent, persistInstructionTools, readInstructionSession } from "../session-adapter.ts";
import type { ForgeWorkspace } from "../workspace.ts";
import type { ToolPolicyRuntime, ToolPolicySnapshot } from "./tool-policy-runtime.ts";

/** Branch entries are authoritative. This service only coordinates the existing tool owner and delivery. */
export function createInstructionRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, tools: ToolPolicyRuntime) {
	const instanceId = randomUUID();
	let context: ExtensionContext | undefined;
	let restoring = false;
	let preparedRevision: string | undefined;
	let preparedModel: string | undefined;
	let lastToolRecord: string | undefined;
	let restoredTools: ToolPolicySnapshot | undefined;

	function view(ctx: ExtensionContext) {
		const history = readInstructionSession(ctx);
		const state = reduceInstructionEvents(history.events);
		if (!state.ok) throw new Error(state.error);
		return { history, state };
	}

	function rememberTools(ctx: ExtensionContext): void {
		const history = readInstructionSession(ctx);
		if (!history.events.length && !history.tools && !hasResourcePolicy(workspace.snapshotKnown ? workspace.snapshot().active?.stack.tools : undefined)) return;
		const snapshot = tools.snapshot();
		const serialized = JSON.stringify(snapshot);
		if (serialized !== lastToolRecord) {
			persistInstructionTools(pi, snapshot);
			lastToolRecord = serialized;
		}
	}

	function prepareRestore(ctx: ExtensionContext): void {
		context = ctx;
		restoring = true;
		preparedRevision = undefined;
		lastToolRecord = undefined;
		const history = readInstructionSession(ctx);
		// A branch without a durable baseline must not replace an existing pristine
		// baseline with the currently filtered selection. Let its owner reconcile it.
		restoredTools = history.tools;
		tools.setInstructionModes([]);
	}

	function restore(ctx: ExtensionContext, options?: { deferToolPolicy?: boolean }): void {
		context = ctx;
		restoring = false;
		if (!options?.deferToolPolicy) sync(ctx);
	}

	function sendMarker(eventId: string): void {
		pi.sendMessage({
			customType: INSTRUCTION_DELIVERY_TYPE,
			content: "Forge instruction state changed. Use /system-update status to inspect it.",
			display: false,
			details: { schemaVersion: 1, throughEventId: eventId },
		}, { deliverAs: "steer", triggerTurn: false });
		// Management must not enqueue an extra model turn. Pi safely appends this
		// carrier after a running batch; pending events project at the next existing
		// request boundary even before that carrier is present.
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
			if (source.kind !== "mode" || !source.binding || formatResourceKey(source.binding.preset) === presetKey) continue;
			const event: InstructionEvent = {
				schemaVersion: 1, eventId: randomUUID(), op: "deactivate", actor: "lifecycle",
				createdAt: Date.now(), activationId: item.snapshot.activationId,
			};
			persistInstructionEvent(pi, event);
			lastRetired = event.eventId;
		}
		if (lastRetired) { sendMarker(lastRetired); current = view(ctx); }
		if (!ctx.isProjectTrusted() && current.state.active.length) {
			throw new Error("Active instruction modes require a trusted project. Use /system-update reset to clear them, or trust the project.");
		}
		const patches = current.state.active.map((item) => item.snapshot.tools);
		const error = tools.validateInstructionModes(patches);
		if (error) throw new Error(error);
		tools.setInstructionModes(patches, restoredTools);
		restoredTools = undefined;
		tools.sync(ctx);
		rememberTools(ctx);
	}

	function project(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		sync(ctx);
		const { history, state } = view(ctx);
		if (!ctx.isProjectTrusted()) return messages.filter((message) => !isInstructionDelivery(message));
		const native = (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
		const projected = projectInstructionMessages(messages, history, native);
		preparedRevision = projected.throughEventId;
		preparedModel = modelKey(ctx);
		if (state.lastEventId) ctx.ui.setStatus("pi-forge-instructions", `${state.active.length} mode(s) · request prepared`);
		return projected.messages;
	}

	function commit(ctx: ExtensionContext, event: InstructionEvent): void {
		const current = view(ctx);
		const next = reduceInstructionEvents([...current.history.events, event]);
		if (!next.ok) throw new Error(next.error);
		const problem = tools.validateInstructionModes(next.active.map((item) => item.snapshot.tools));
		if (problem) throw new Error(problem);
		// Persist the pristine/reconciled baseline before a branch can land on the activation entry.
		tools.sync(ctx);
		const before = tools.snapshot();
		if (JSON.stringify(current.history.tools) !== JSON.stringify(before)) {
			persistInstructionTools(pi, before);
			lastToolRecord = JSON.stringify(before);
		}
		persistInstructionEvent(pi, event);
		// A failure after commit remains recoverable from the event; never claim it was applied.
		try {
			sendMarker(event.eventId);
			sync(ctx);
			ctx.ui.setStatus("pi-forge-instructions", `${next.active.length} mode(s) · pending request`);
		} catch (error) {
			preparedRevision = undefined;
			throw new Error(`Instruction event saved but application is pending: ${error instanceof Error ? error.message : "delivery failure"}`);
		}
	}

	function library(ctx: ExtensionContext): string {
		const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
		return modes.length ? modes.map((loaded) => {
			const errors = loaded.diagnostics.filter((d) => d.level === "error").map((d) => d.message);
			return `${formatResourceKey(loaded.key)}${loaded.mode.name ? ` — ${loaded.mode.name}` : ""}${errors.length ? ` [invalid: ${errors.join("; ")}]` : ""}`;
		}).join("\n") : "No instruction modes. Place JSON in .pi/forge/instruction-modes/ or ~/.pi/forge/instruction-modes/.";
	}

	function modelKey(ctx: ExtensionContext): string {
		return JSON.stringify([ctx.model?.provider, ctx.model?.id, (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true]);
	}

	/** Reading the browser view must never append entries, sync tools or start inference. */
	function readState(): InstructionStateResult {
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
			const problem = tools.validateInstructionModes(active.map((item) => item.tools));
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const preset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
			const revision = fingerprintJson({ domain: "forge-instruction-view-v1", instanceId, sessionId, leafId,
				lastEventId: state.lastEventId, active, effectiveTools, trusted, restoring, model, delivery,
				preset: preset ? { key: preset.key, tools: preset.stack.tools } : null, baseline: history.tools });
			const result: InstructionStateView = {
				guard: { sessionId, leafId, revision }, trusted, restoring, delivery,
				textPresentation: (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true ? "native" : "user",
				effectiveTools, active, ...(problem ? { problem } : {}),
			};
			return { ok: true, state: result };
		} catch (error) {
			return { ok: false, status: 503, error: `Instruction state unavailable: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	/** Human Web controls share CLI semantics, with an exact displayed-view guard. */
	function mutateState(input: unknown): InstructionStateResult {
		if (!isInstructionStateMutation(input)) return { ok: false, status: 400, error: "Invalid instruction state operation." };
		const current = readState();
		if (!current.ok) return current;
		if (!current.state.trusted) return { ok: false, status: 403, error: "Project is not trusted. Use the human CLI for recovery." };
		const guard = current.state.guard;
		if (current.state.restoring || input.guard.sessionId !== guard.sessionId || input.guard.leafId !== guard.leafId || input.guard.revision !== guard.revision) {
			return { ok: false, status: 409, error: "Session, branch or instruction state changed. Refresh and review before trying again." };
		}
		if (input.action === "off" && !current.state.active.some((item) => item.activationId === input.activationId)) {
			return { ok: false, status: 404, error: "No active instruction with that activation ID." };
		}
		try {
			// No await between checking the guard and committing to the current session.
			change(context!, input.action, input.action === "off" ? input.activationId : "");
			return readState();
		} catch (error) {
			return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
		}
	}

	function status(ctx: ExtensionContext): string {
		const { state } = view(ctx);
		const presentation = (ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true ? "native system sections" : "attributed user updates";
		const delivery = !state.lastEventId ? "none" : preparedRevision === state.lastEventId && preparedModel === modelKey(ctx) ? "request prepared (not a model-obedience or delivery acknowledgment)" : "pending next request";
		return [
			`Instruction modes: ${state.active.length}; ${presentation}; ${delivery}`,
			`Currently selected tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
			...state.active.flatMap((item) => [
				`${item.snapshot.activationId} · ${sourceLabel(item)} · ${item.actor}`,
				`  +tools: ${item.snapshot.tools.add.join(", ") || "(none)"}; -tools: ${item.snapshot.tools.remove.join(", ") || "(none)"}`,
				item.snapshot.content,
			]),
		].join("\n");
	}

	function change(ctx: ExtensionContext, command: "add" | "use" | "off" | "reset", value: string): string {
		context = ctx;
		const { state } = view(ctx);
		if ((command === "add" || command === "use") && !ctx.isProjectTrusted()) throw new Error("Project is not trusted; refusing to activate an instruction mode.");
		const common = { schemaVersion: 1 as const, eventId: randomUUID(), actor: "user" as const, createdAt: Date.now() };
		if (command === "reset") {
			if (!state.active.length) return "No active instructions to reset.";
			commit(ctx, { ...common, op: "reset" });
			return "Instructions stopped; tools recomputed. Historical messages and completed work are not undone.";
		}
		if (!value.trim()) throw new Error(`Usage: /system-update ${command} <${command === "add" ? "text" : "id"}>`);
		if (command === "off") {
			const matches = state.active.filter((item) => item.snapshot.activationId === value || sourceLabel(item) === value
				|| (item.snapshot.source.kind === "mode" && item.snapshot.source.key.id === value));
			if (!matches.length) return "No matching active instruction (already off or unknown ID).";
			if (matches.length !== 1) throw new Error("Ambiguous mode name; use the activation ID from /system-update status.");
			commit(ctx, { ...common, op: "deactivate", activationId: matches[0]!.snapshot.activationId });
			return `Stopped ${matches[0]!.snapshot.activationId}; tools recomputed, stop notice pending next request.`;
		}
		let input: Parameters<typeof createInstructionSnapshot>[0];
		if (command === "add") {
			input = { activationId: randomUUID(), source: { kind: "manual" }, content: value, tools: { add: [], remove: [] } };
		} else {
			const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
			const resolved = resolveInstructionMode(createResourceCatalog([...modes]), value);
			if (!resolved.ok) throw new Error(resolved.error);
			const existing = state.active.find((item) => item.snapshot.source.kind === "mode" && !item.snapshot.source.binding
				&& formatResourceKey(item.snapshot.source.key) === formatResourceKey(resolved.loaded.key));
			if (existing) return `Already selected as ${existing.snapshot.activationId}; source edits do not change this snapshot. Off/use to reapply.`;
			const mode = resolved.loaded.mode;
			input = { activationId: randomUUID(), source: { kind: "mode", key: resolved.loaded.key }, content: mode.content, tools: mode.tools,
				...(mode.name === undefined ? {} : { name: mode.name }) };
		}
		const snapshot = createInstructionSnapshot(input);
		commit(ctx, { ...common, op: "activate", snapshot });
		return `Selected ${snapshot.activationId}; tools prepared, instruction pending next model request. Use /system-update off ${snapshot.activationId} to stop.`;
	}

	function dispose(): void {
		context = undefined;
		restoring = true;
		preparedRevision = undefined;
		preparedModel = undefined;
		restoredTools = undefined;
	}

	return { prepareRestore, restore, sync, project, library, status, change, readState, mutateState, dispose };
}

function sourceLabel(item: ActiveInstruction): string {
	return item.snapshot.source.kind === "manual" ? "manual" : formatResourceKey(item.snapshot.source.key);
}

export type InstructionRuntime = ReturnType<typeof createInstructionRuntime>;
