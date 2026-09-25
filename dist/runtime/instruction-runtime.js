import { randomUUID } from "node:crypto";
import { fingerprintJson } from "../json-fingerprint.js";
import { isInstructionStateMutation, isInstructionUseRequest, } from "../instruction-state.js";
import { createResourceCatalog } from "../catalog.js";
import { createInstructionSnapshot, reduceInstructionEvents, MAX_ID_LENGTH } from "../instruction-events.js";
import { resolveInstructionMode, resolveInstructionModeBindings } from "../instruction-modes.js";
import { isUsableInstructionMode } from "../codecs/instruction-mode.js";
import { projectInstructionMessages } from "../instruction-projection.js";
import { isInstructionDelivery } from "../instruction-protocol.js";
import { formatResourceKey, parseResourceSelector } from "../resource-identity.js";
import { hasToolSelectionPolicy } from "../policy.js";
import { buildSessionProjection, } from "@earendil-works/pi-coding-agent";
import { hasPendingInstructionToolCalls, instructionContextMatches, materializeInstructionAnchors, } from "../instruction-anchors.js";
import { getCurrentBranchEntries, persistInstructionDelivery, persistInstructionEvent, persistInstructionTools, readInstructionSession, } from "../session-adapter.js";
function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/** Branch entries are authoritative. This service only coordinates the existing tool owner and delivery. */
export function createInstructionRuntime(pi, workspace, tools) {
    const instanceId = randomUUID();
    let context;
    let restoring = false;
    let preparedRevision;
    let preparedModel;
    let lastToolRecord;
    let restoredTools;
    let agentBusy = false;
    let disposed = false;
    let lifecycleRevision = 0;
    function setAgentBusy(busy) {
        agentBusy = busy;
    }
    function isBusy(ctx) {
        if (agentBusy)
            return true;
        const targetCtx = ctx ?? context;
        if (targetCtx && typeof targetCtx.isIdle === "function") {
            return !targetCtx.isIdle();
        }
        return false;
    }
    function view(ctx) {
        const history = readInstructionSession(ctx);
        const state = reduceInstructionEvents(history.events);
        if (!state.ok)
            throw new Error(state.error);
        return { history, state };
    }
    function rememberTools(ctx) {
        const history = readInstructionSession(ctx);
        if (!history.events.length && !history.tools && !hasToolSelectionPolicy(workspace.snapshotKnown ? workspace.snapshot().active?.stack.tools : undefined))
            return;
        const snapshot = tools.snapshot();
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastToolRecord) {
            persistInstructionTools(pi, snapshot);
            lastToolRecord = serialized;
        }
    }
    function prepareRestore(ctx) {
        disposed = false;
        lifecycleRevision++;
        context = ctx;
        restoring = true;
        preparedRevision = undefined;
        preparedModel = undefined;
        lastToolRecord = undefined;
        agentBusy = false;
        const history = readInstructionSession(ctx);
        // A branch without a durable baseline must not replace an existing pristine
        // baseline with the currently filtered selection. Let its owner reconcile it.
        restoredTools = history.tools;
        tools.setInstructionModes([]);
    }
    function restore(ctx, options) {
        if (disposed)
            return;
        context = ctx;
        restoring = false;
        agentBusy = false;
        if (!options?.deferToolPolicy)
            sync(ctx);
    }
    function sync(ctx = context) {
        if (restoring)
            return;
        if (!ctx) {
            tools.sync(ctx);
            return;
        }
        context = ctx;
        let current = view(ctx);
        const preset = workspace.snapshotKnown && workspace.snapshot().active;
        const presetKey = preset ? formatResourceKey(preset.key) : undefined;
        let lastRetired;
        for (const item of current.state.active) {
            const source = item.snapshot.source;
            if (source.kind !== "mode" || !source.binding || formatResourceKey(source.binding.preset) === presetKey)
                continue;
            const event = {
                schemaVersion: 1, eventId: randomUUID(), op: "deactivate", actor: "lifecycle",
                createdAt: Date.now(), activationId: item.snapshot.activationId,
            };
            persistInstructionEvent(pi, event);
            lastRetired = event.eventId;
        }
        if (lastRetired) {
            if (!isBusy(ctx))
                persistPendingAnchors(ctx);
            current = view(ctx);
        }
        if (!ctx.isProjectTrusted() && current.state.active.length) {
            throw new Error("Active instruction modes require a trusted project. Use /system-update reset to clear them, or trust the project.");
        }
        const patches = current.state.active.map((item) => item.snapshot.tools);
        const error = tools.validateInstructionModes(patches);
        if (error)
            throw new Error(error);
        tools.setInstructionModes(patches, restoredTools);
        restoredTools = undefined;
        tools.sync(ctx);
        rememberTools(ctx);
    }
    function pendingEvents(ctx) {
        const history = readInstructionSession(ctx);
        const checkpoint = history.events.findIndex(event => event.eventId === history.checkpointThrough);
        const through = Math.max(history.lastAnchoredIndex, checkpoint);
        const seen = new Set();
        return history.events.filter((event, index) => {
            if (seen.has(event.eventId))
                return false;
            seen.add(event.eventId);
            return index > through;
        });
    }
    function persistPendingAnchors(ctx) {
        // Do not collapse a saved-but-unanchored activate/off sequence into net state.
        for (const event of pendingEvents(ctx))
            persistInstructionDelivery(pi, event.eventId);
    }
    function canonicalSessionMessages(ctx) {
        return buildSessionProjection(getCurrentBranchEntries(ctx)).messages;
    }
    function prepareMessages(raw, ctx) {
        context = ctx;
        if (pendingEvents(ctx).length > 0) {
            // Context hooks should run after a complete batch. Never project pending
            // deltas into an unresolved current batch if that invariant is broken.
            if (hasPendingInstructionToolCalls(raw)) {
                throw new Error("Cannot prepare instruction anchors during an incomplete tool batch.");
            }
            if (!instructionContextMatches(canonicalSessionMessages(ctx), raw)) {
                throw new Error("Cannot materialize instruction anchors: context has no unique session alignment (possible preceding extension rewrite or deferred custom messages)");
            }
            persistPendingAnchors(ctx);
        }
        return materializeInstructionAnchors(getCurrentBranchEntries(ctx), raw);
    }
    function project(messages, ctx) {
        const { history, state } = view(ctx);
        if (!ctx.isProjectTrusted())
            return messages.filter((message) => !isInstructionDelivery(message));
        const native = ctx.model?.compat?.supportsMidConvoSystemMessages === true;
        const projected = projectInstructionMessages(messages, history, native);
        preparedRevision = projected.throughEventId;
        preparedModel = modelKey(ctx);
        if (state.lastEventId)
            ctx.ui.setStatus("pi-forge-instructions", `${state.active.length} mode(s) · request prepared`);
        return projected.messages;
    }
    function commit(ctx, event) {
        const current = view(ctx);
        const next = reduceInstructionEvents([...current.history.events, event]);
        if (!next.ok)
            throw new Error(next.error);
        const problem = tools.validateInstructionModes(next.active.map((item) => item.snapshot.tools));
        if (problem)
            throw new Error(problem);
        // Persist the pristine/reconciled baseline before a branch can land on the activation entry.
        tools.sync(ctx);
        const before = tools.snapshot();
        if (JSON.stringify(current.history.tools) !== JSON.stringify(before)) {
            persistInstructionTools(pi, before);
            lastToolRecord = JSON.stringify(before);
        }
        persistInstructionEvent(pi, event);
        // Any failure after saving intent remains recoverable; never imply rollback.
        try {
            if (!isBusy(ctx))
                persistPendingAnchors(ctx);
            sync(ctx);
            ctx.ui.setStatus("pi-forge-instructions", `${next.active.length} mode(s) · pending request`);
        }
        catch (error) {
            preparedRevision = undefined;
            throw new Error(`Instruction event saved but application is pending: ${error instanceof Error ? error.message : "delivery failure"}`);
        }
    }
    function library(ctx) {
        const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
        return modes.length ? modes.map((loaded) => {
            const errors = loaded.diagnostics.filter((d) => d.level === "error").map((d) => d.message);
            return `${formatResourceKey(loaded.key)}${loaded.mode.name ? ` — ${loaded.mode.name}` : ""}${errors.length ? ` [invalid: ${errors.join("; ")}]` : ""}`;
        }).join("\n") : "No instruction modes. Place JSON in .pi/forge/instruction-modes/ or ~/.pi/forge/instruction-modes/.";
    }
    /**
     * Completion-only projection. It deliberately consumes the current session
     * and the last published workspace snapshot; unlike library()/readBindings()
     * it never reloads files or publishes a snapshot on a keystroke.
     */
    function completionView(ctx) {
        const target = ctx ?? context;
        if (disposed || restoring || !target || (ctx && !sameContext(context, ctx))) {
            return { ok: false, error: "Instruction runtime is not active for this session." };
        }
        try {
            const trusted = target.isProjectTrusted();
            const snapshot = workspace.snapshot();
            if (!workspace.snapshotKnown || snapshot.cwd !== target.cwd)
                return { ok: false, error: "Workspace completion snapshot does not match the current project." };
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
                return { ok: true, trusted: false, capturedAt: snapshot.capturedAt, modes: [], bindings: [], active };
            }
            const modes = snapshot.instructionModes
                .filter((loaded) => isUsableInstructionMode(loaded))
                .map((loaded) => ({
                id: formatResourceKey(loaded.key),
                label: `${formatResourceKey(loaded.key)}${loaded.mode.name ? ` — ${loaded.mode.name}` : ""}`,
            }));
            const bindings = [];
            const preset = snapshot.active;
            if (preset && (preset.stack.instructionModes?.length ?? 0) > 0) {
                const resolved = resolveInstructionModeBindings(createResourceCatalog([...snapshot.instructionModes]), preset.key, preset.stack.instructionModes ?? []);
                if (!resolved.ok)
                    return { ok: false, error: resolved.error };
                for (const binding of resolved.bindings) {
                    const readable = binding.mode.name ?? formatResourceKey(binding.ref);
                    bindings.push({
                        id: binding.id,
                        modelCallable: binding.modelCallable,
                        label: `${binding.id} — ${readable}${binding.modelCallable ? "" : " [human-only]"}`,
                    });
                }
            }
            return { ok: true, trusted: true, capturedAt: snapshot.capturedAt, modes, bindings, active };
        }
        catch (error) {
            return { ok: false, error: `Instruction completion unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    function modelKey(ctx) {
        return JSON.stringify([ctx.model?.provider, ctx.model?.id, ctx.model?.compat?.supportsMidConvoSystemMessages === true]);
    }
    /** Reading the browser view must never append entries, sync tools or start inference. */
    function readState() {
        const ctx = context;
        if (!ctx)
            return { ok: false, status: 503, error: "No active Forge session." };
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
            const revision = fingerprintJson({ domain: "forge-instruction-view-v1", instanceId, lifecycleRevision, sessionId, leafId,
                lastEventId: state.lastEventId, active, effectiveTools, trusted, restoring, model, delivery,
                preset: preset ? { key: preset.key, tools: preset.stack.tools, instructionModes: preset.stack.instructionModes ?? [] } : null, baseline: history.tools });
            const result = {
                guard: { sessionId, leafId, revision }, trusted, restoring, delivery,
                ...(preset ? { presetRevision: fingerprintJson({ domain: "forge-inspection-preset-v1", key: preset.key, stack: preset.stack }) } : {}),
                textPresentation: ctx.model?.compat?.supportsMidConvoSystemMessages === true ? "native" : "user",
                effectiveTools, active, ...(problem ? { problem } : {}),
            };
            return { ok: true, state: result };
        }
        catch (error) {
            return { ok: false, status: 503, error: `Instruction state unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    function choiceForMode(kind, id, mode, source) {
        const snapshot = createInstructionSnapshot({
            activationId: randomUUID(),
            source,
            ...(mode.name === undefined ? {} : { name: mode.name }),
            content: mode.content,
            tools: mode.tools,
        });
        const problem = tools.validateInstructionModes([mode.tools]);
        return {
            kind,
            id,
            label: mode.name ?? id,
            content: mode.content,
            tools: { add: [...mode.tools.add], remove: [...mode.tools.remove] },
            fingerprint: snapshot.fingerprint,
            ...(problem ? { problem } : {}),
        };
    }
    /** Read-only resource discovery for the human web client. */
    function readAvailableInstructions() {
        const stateResult = readState();
        if (!stateResult.ok)
            return stateResult;
        const ctx = context;
        if (!ctx)
            return { ok: false, status: 503, error: "No active Forge session." };
        if (!stateResult.state.trusted)
            return { ok: false, status: 403, error: "Project is not trusted." };
        if (stateResult.state.restoring || disposed)
            return { ok: false, status: 503, error: "Instruction session is restoring." };
        try {
            if (!ctx.isProjectTrusted())
                return { ok: false, status: 403, error: "Project is not trusted." };
            const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
            const choices = [];
            for (const loaded of modes) {
                if (!isUsableInstructionMode(loaded))
                    continue;
                choices.push(choiceForMode("mode", formatResourceKey(loaded.key), loaded.mode, { kind: "mode", key: loaded.key }));
            }
            const bindings = readBindings(ctx);
            if (!bindings.ok)
                return { ok: false, status: 409, error: bindings.error };
            for (const binding of bindings.bindings) {
                choices.push(choiceForMode("binding", binding.id, binding.mode, {
                    kind: "mode",
                    key: binding.ref,
                    binding: { preset: binding.preset, id: binding.id },
                }));
            }
            const finalState = readState();
            if (!finalState.ok)
                return finalState;
            if (!sameGuard(stateResult.state.guard, finalState.state.guard))
                return { ok: false, status: 409, error: "Session changed during resource discovery. Refresh and review." };
            return { ok: true, state: finalState.state, choices };
        }
        catch (error) {
            return { ok: false, status: 503, error: `Instruction choices unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    /** Guarded, explicit human web activation. It never retries or infers. */
    function useInstruction(input) {
        if (!isInstructionUseRequest(input))
            return { ok: false, status: 400, error: "Invalid instruction activation payload." };
        const initial = readState();
        if (!initial.ok)
            return initial;
        if (disposed || initial.state.restoring)
            return { ok: false, status: 503, error: "Instruction session is restoring." };
        if (!initial.state.trusted)
            return { ok: false, status: 403, error: "Project is not trusted." };
        if (!sameGuard(input.guard, initial.state.guard))
            return { ok: false, status: 409, error: "Session, branch or instruction state changed. Refresh and review before trying again." };
        const ctx = context;
        if (!ctx)
            return { ok: false, status: 503, error: "No active Forge session." };
        try {
            let expected = "";
            if (input.kind === "mode") {
                const parsed = parseResourceSelector(input.id);
                if (!parsed.ok || !parsed.selector.scope)
                    return { ok: false, status: 409, error: "Direct mode IDs must be qualified resource IDs." };
                if (!ctx.isProjectTrusted())
                    return { ok: false, status: 403, error: "Project is not trusted." };
                const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
                const resolved = resolveInstructionMode(createResourceCatalog([...modes]), input.id);
                if (!resolved.ok)
                    return { ok: false, status: 409, error: resolved.error };
                const mode = resolved.loaded.mode;
                expected = choiceForMode("mode", input.id, mode, { kind: "mode", key: resolved.loaded.key }).fingerprint;
                if (expected !== input.fingerprint)
                    return { ok: false, status: 409, error: "Instruction source changed. Refresh and review before trying again." };
            }
            else {
                const bindings = readBindings(ctx);
                if (!bindings.ok)
                    return { ok: false, status: 409, error: bindings.error };
                const binding = bindings.bindings.find((candidate) => candidate.id === input.id);
                if (!binding)
                    return { ok: false, status: 409, error: "Instruction binding changed or is no longer available. Refresh and review before trying again." };
                expected = choiceForMode("binding", binding.id, binding.mode, {
                    kind: "mode", key: binding.ref, binding: { preset: binding.preset, id: binding.id },
                }).fingerprint;
                if (expected !== input.fingerprint)
                    return { ok: false, status: 409, error: "Instruction binding changed. Refresh and review before trying again." };
            }
            const checked = readState();
            if (!checked.ok)
                return checked;
            if (checked.state.restoring || !checked.state.trusted || !sameGuard(input.guard, checked.state.guard)) {
                return { ok: false, status: checked.state.trusted ? 409 : 403, error: checked.state.trusted ? "Session, branch or instruction state changed. Refresh and review before trying again." : "Project is not trusted." };
            }
            if (input.kind === "binding") {
                const result = useBound(ctx, input.id, "user", expected, input.guard);
                if (!result.ok) {
                    try {
                        if (!ctx.isProjectTrusted())
                            return { ok: false, status: 403, error: result.error };
                    }
                    catch {
                        return { ok: false, status: 503, error: "Instruction session is unavailable." };
                    }
                    return { ok: false, status: 409, error: result.error };
                }
            }
            else {
                change(ctx, "use", input.id, expected, input.guard);
            }
            return readState();
        }
        catch (error) {
            try {
                if (!ctx.isProjectTrusted())
                    return { ok: false, status: 403, error: "Project is not trusted." };
            }
            catch {
                return { ok: false, status: 503, error: "Instruction session is unavailable." };
            }
            return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** Human Web controls share CLI semantics, with an exact displayed-view guard. */
    function mutateState(input) {
        if (!isInstructionStateMutation(input))
            return { ok: false, status: 400, error: "Invalid instruction state operation." };
        const current = readState();
        if (!current.ok)
            return current;
        if (!current.state.trusted)
            return { ok: false, status: 403, error: "Project is not trusted. Use the human CLI for recovery." };
        const guard = current.state.guard;
        if (current.state.restoring || input.guard.sessionId !== guard.sessionId || input.guard.leafId !== guard.leafId || input.guard.revision !== guard.revision) {
            return { ok: false, status: 409, error: "Session, branch or instruction state changed. Refresh and review before trying again." };
        }
        if (input.action === "off" && !current.state.active.some((item) => item.activationId === input.activationId)) {
            return { ok: false, status: 404, error: "No active instruction with that activation ID." };
        }
        try {
            // No await between checking the guard and committing to the current session.
            change(context, input.action, input.action === "off" ? input.activationId : "");
            return readState();
        }
        catch (error) {
            return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
        }
    }
    function status(ctx, includeRuleContent = true) {
        const { state } = view(ctx);
        const presentation = ctx.model?.compat?.supportsMidConvoSystemMessages === true ? "native system sections" : "attributed user updates";
        const delivery = !state.lastEventId ? "none" : preparedRevision === state.lastEventId && preparedModel === modelKey(ctx) ? "request prepared (not a model-obedience or delivery acknowledgment)" : "pending next request";
        return [
            `Instruction modes: ${state.active.length}; ${presentation}; ${delivery}`,
            `Currently selected tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
            "Tool transport is provider-managed: native text does not guarantee incremental tools. Full schema resubmission and cache changes are possible; prepared does not guarantee delivery or cache hits.",
            ...state.active.flatMap((item) => [
                `${item.snapshot.activationId} · ${sourceLabel(item)} · ${item.actor}`,
                `  +tools: ${item.snapshot.tools.add.join(", ") || "(none)"}; -tools: ${item.snapshot.tools.remove.join(", ") || "(none)"}`,
                ...(includeRuleContent ? [item.snapshot.content] : []),
            ]),
        ].join("\n");
    }
    function change(ctx, command, value, expectedFingerprint, expectedGuard) {
        if (disposed || restoring || (context !== undefined && !sameContext(context, ctx)))
            throw new Error("Instruction runtime is no longer active for this session.");
        context = ctx;
        const { state } = view(ctx);
        if ((command === "add" || command === "use" || command === "use-bound") && !ctx.isProjectTrusted())
            throw new Error("Project is not trusted; refusing to activate an instruction mode.");
        const common = { schemaVersion: 1, eventId: randomUUID(), actor: "user", createdAt: Date.now() };
        if (command === "reset") {
            if (!state.active.length)
                return "No active instructions to reset.";
            commit(ctx, { ...common, op: "reset" });
            return "Instructions stopped; tools recomputed. Historical messages and completed work are not undone.";
        }
        if (!value.trim())
            throw new Error(`Usage: /system-update ${command} <${command === "add" ? "text" : "id"}>`);
        if (command === "use-bound") {
            const res = useBound(ctx, value.trim(), "user");
            if (!res.ok)
                throw new Error(res.error);
            return res.message;
        }
        if (command === "off") {
            const matches = state.active.filter((item) => item.snapshot.activationId === value || sourceLabel(item) === value
                || (item.snapshot.source.kind === "mode" && item.snapshot.source.key.id === value)
                || (item.snapshot.source.kind === "mode" && item.snapshot.source.binding && item.snapshot.source.binding.id === value));
            if (!matches.length)
                return "No matching active instruction (already off or unknown ID).";
            if (matches.length !== 1)
                throw new Error("Ambiguous mode name; use the activation ID from /system-update status.");
            commit(ctx, { ...common, op: "deactivate", activationId: matches[0].snapshot.activationId });
            return `Stopped ${matches[0].snapshot.activationId}; tools recomputed, stop notice pending next request.`;
        }
        let input;
        if (command === "add") {
            input = { activationId: randomUUID(), source: { kind: "manual" }, content: value, tools: { add: [], remove: [] } };
        }
        else {
            const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
            const resolved = resolveInstructionMode(createResourceCatalog([...modes]), value);
            if (!resolved.ok)
                throw new Error(resolved.error);
            assertActivationGuard(expectedGuard);
            const existing = state.active.find((item) => item.snapshot.source.kind === "mode" && !item.snapshot.source.binding
                && formatResourceKey(item.snapshot.source.key) === formatResourceKey(resolved.loaded.key));
            if (existing)
                return `Already selected as ${existing.snapshot.activationId}; source edits do not change this snapshot. Off/use to reapply.`;
            const mode = resolved.loaded.mode;
            input = { activationId: randomUUID(), source: { kind: "mode", key: resolved.loaded.key }, content: mode.content, tools: mode.tools,
                ...(mode.name === undefined ? {} : { name: mode.name }) };
        }
        const snapshot = createInstructionSnapshot(input);
        if (expectedFingerprint !== undefined && snapshot.fingerprint !== expectedFingerprint) {
            throw new Error("Instruction source changed. Refresh and review before trying again.");
        }
        commit(ctx, { ...common, op: "activate", snapshot });
        return `Selected ${snapshot.activationId}; tools prepared, instruction pending next model request. Use /system-update off ${snapshot.activationId} to stop.`;
    }
    function readBindings(ctx) {
        if (!ctx.isProjectTrusted()) {
            return { ok: false, error: "Project is not trusted; cannot read instruction mode bindings." };
        }
        const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
        if (!activePreset) {
            return { ok: true, preset: null, bindings: [] };
        }
        const declaredBindings = activePreset.stack.instructionModes ?? [];
        const presetMarker = fingerprintJson({ key: activePreset.key, stack: activePreset.stack });
        if (declaredBindings.length === 0) {
            return { ok: true, preset: activePreset.key, bindings: [] };
        }
        const modes = workspace.reloadInstructionModes(ctx.cwd, ctx.isProjectTrusted()).instructionModes;
        const afterReload = workspace.snapshot().active;
        if (!afterReload || fingerprintJson({ key: afterReload.key, stack: afterReload.stack }) !== presetMarker) {
            return { ok: false, error: "Active preset changed while resolving instruction mode bindings. Refresh and try again." };
        }
        const catalog = createResourceCatalog([...modes]);
        const res = resolveInstructionModeBindings(catalog, activePreset.key, declaredBindings);
        if (!res.ok) {
            return { ok: false, error: res.error };
        }
        return { ok: true, preset: activePreset.key, bindings: res.bindings };
    }
    function useBound(ctx, id, actor = "user", expectedFingerprint, expectedGuard) {
        if (disposed || restoring || (context !== undefined && !sameContext(context, ctx))) {
            return { ok: false, error: "Instruction runtime is no longer active for this session." };
        }
        context = ctx;
        if (!ctx.isProjectTrusted()) {
            return { ok: false, error: "Project is not trusted; refusing to activate an instruction mode." };
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
            return { ok: false, error: "No active preset; cannot activate a bound instruction mode." };
        }
        const bindingsRes = readBindings(ctx);
        if (!bindingsRes.ok) {
            return { ok: false, error: bindingsRes.error };
        }
        const binding = bindingsRes.bindings.find((b) => b.id === targetId);
        if (!binding) {
            return {
                ok: false,
                error: `Instruction mode "${targetId}" is not bound to active preset "${formatResourceKey(activePreset.key)}".`,
            };
        }
        if (actor === "agent") {
            if (!binding.modelCallable) {
                return {
                    ok: false,
                    error: `Instruction mode "${targetId}" is not authorized for agent use (modelCallable is not true).`,
                };
            }
            if (binding.mode.tools.remove.includes("forge_system_update")) {
                return {
                    ok: false,
                    error: `Cannot activate instruction mode "${targetId}": agent cannot remove control tool "forge_system_update".`,
                };
            }
            const allTools = pi.getAllTools();
            const activeTools = pi.getActiveTools();
            if (!allTools.some((t) => t.name === "forge_system_update") ||
                !activeTools.includes("forge_system_update") ||
                tools.blockReason("forge_system_update") !== undefined) {
                return { ok: false, error: 'Control tool "forge_system_update" is not available or blocked by policy.' };
            }
        }
        const policyErr = tools.validateInstructionModes([binding.mode.tools]);
        if (policyErr) {
            return { ok: false, error: `Cannot activate instruction mode "${targetId}": ${policyErr}` };
        }
        try {
            assertActivationGuard(expectedGuard);
        }
        catch (error) {
            return { ok: false, error: String(error) };
        }
        // Repeated use idempotent/no owner takeover
        const { state } = view(ctx);
        const existing = state.active.find((item) => item.snapshot.source.kind === "mode" &&
            item.snapshot.source.binding &&
            formatResourceKey(item.snapshot.source.binding.preset) === formatResourceKey(binding.preset) &&
            item.snapshot.source.binding.id === binding.id &&
            formatResourceKey(item.snapshot.source.key) === formatResourceKey(binding.ref));
        const stale = state.active.find((item) => item.snapshot.source.kind === "mode" &&
            item.snapshot.source.binding &&
            formatResourceKey(item.snapshot.source.binding.preset) === formatResourceKey(binding.preset) &&
            item.snapshot.source.binding.id === binding.id);
        if (stale && !existing) {
            return {
                ok: false,
                error: `Instruction mode "${targetId}" has a stale binding identity; turn off the old activation before reusing it.`,
            };
        }
        if (existing) {
            return {
                ok: true,
                activationId: existing.snapshot.activationId,
                idempotent: true,
                message: `Instruction mode "${targetId}" is already active as ${existing.snapshot.activationId}. Repeated use is idempotent and does not change ownership.`,
            };
        }
        const snapshot = createInstructionSnapshot({
            activationId: randomUUID(),
            source: {
                kind: "mode",
                key: binding.ref,
                binding: {
                    preset: binding.preset,
                    id: binding.id,
                },
            },
            content: binding.mode.content,
            tools: binding.mode.tools,
            ...(binding.mode.name !== undefined ? { name: binding.mode.name } : {}),
        });
        if (expectedFingerprint !== undefined && snapshot.fingerprint !== expectedFingerprint) {
            return { ok: false, error: "Instruction source or binding changed. Refresh and review before trying again." };
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
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        return {
            ok: true,
            activationId: snapshot.activationId,
            message: `Selected ${snapshot.activationId}; tools prepared, instruction pending next model request. Use /system-update off ${snapshot.activationId} to stop.`,
        };
    }
    function deactivateBound(ctx, id, actor = "user") {
        if (disposed || restoring || (context !== undefined && !sameContext(context, ctx))) {
            return { ok: false, error: "Instruction runtime is no longer active for this session." };
        }
        context = ctx;
        if (!ctx.isProjectTrusted()) {
            return { ok: false, error: "Project is not trusted; refusing to deactivate an instruction mode." };
        }
        if (typeof id !== "string" || !id.trim()) {
            return { ok: false, error: "Invalid instruction mode id." };
        }
        const targetId = id.trim();
        if (targetId.length > MAX_ID_LENGTH) {
            return { ok: false, error: `Instruction mode ID must be at most ${MAX_ID_LENGTH} characters.` };
        }
        const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
        if (actor === "agent") {
            const allTools = pi.getAllTools();
            const activeTools = pi.getActiveTools();
            if (!allTools.some((t) => t.name === "forge_system_update") ||
                !activeTools.includes("forge_system_update") ||
                tools.blockReason("forge_system_update") !== undefined) {
                return { ok: false, error: 'Control tool "forge_system_update" is not available or blocked by policy.' };
            }
            if (!activePreset) {
                return { ok: false, error: "forge_system_update off requires an active preset with bound instruction modes." };
            }
        }
        const { state } = view(ctx);
        const matches = state.active.filter((item) => item.snapshot.activationId === targetId ||
            sourceLabel(item) === targetId ||
            (item.snapshot.source.kind === "mode" && item.snapshot.source.key.id === targetId) ||
            (item.snapshot.source.kind === "mode" &&
                item.snapshot.source.binding &&
                item.snapshot.source.binding.id === targetId));
        if (!matches.length) {
            return { ok: false, error: `No matching active instruction mode: ${targetId}` };
        }
        if (matches.length > 1) {
            return { ok: false, error: `Ambiguous active instruction mode "${targetId}"; use its activation ID.` };
        }
        const target = matches[0];
        if (actor === "agent") {
            if (target.actor !== "agent") {
                return { ok: false, error: `Agent cannot deactivate user-owned activation: ${target.snapshot.activationId}` };
            }
            const source = target.snapshot.source;
            if (source.kind !== "mode" || !source.binding) {
                return { ok: false, error: `Agent cannot deactivate unbound or manual instruction: ${target.snapshot.activationId}` };
            }
            // Current authorization required
            const bindingsRes = readBindings(ctx);
            if (!bindingsRes.ok) {
                return { ok: false, error: `Failed to resolve active preset bindings: ${bindingsRes.error}` };
            }
            const currentBinding = bindingsRes.bindings.find((b) => b.id === source.binding.id);
            const samePreset = formatResourceKey(source.binding.preset) === formatResourceKey(activePreset.key);
            const sameMode = currentBinding && formatResourceKey(source.key) === formatResourceKey(currentBinding.ref);
            if (!currentBinding || !samePreset || !sameMode || !currentBinding.modelCallable) {
                return {
                    ok: false,
                    error: `Cannot deactivate mode "${targetId}": current authorization requires the exact active-preset binding identity (including its mode source) and modelCallable authorization.`,
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
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        return {
            ok: true,
            activationId: target.snapshot.activationId,
            message: `Stopped ${target.snapshot.activationId}; tools recomputed, stop notice pending next request.`,
        };
    }
    async function executeAgentTool(ctx, params) {
        if (disposed || restoring) {
            throw new Error("forge_system_update is unavailable for this session.");
        }
        if (!isPlainObject(params)) {
            throw new Error("forge_system_update parameters must be a plain object.");
        }
        const allowedKeys = new Set(["action", "id"]);
        for (const key of Object.keys(params)) {
            if (!allowedKeys.has(key)) {
                throw new Error(`forge_system_update: unknown argument "${key}". Only "action" and "id" are permitted.`);
            }
        }
        const action = params.action;
        if (action !== "list" && action !== "status" && action !== "use" && action !== "off") {
            throw new Error(`forge_system_update: invalid action "${String(action)}". Expected "list", "status", "use", or "off".`);
        }
        if (action === "list" || action === "status") {
            if (params.id !== undefined) {
                throw new Error(`forge_system_update: argument "id" is irrelevant for action "${action}".`);
            }
        }
        if (action === "use" || action === "off") {
            if (typeof params.id !== "string" || !params.id.trim()) {
                throw new Error(`forge_system_update: argument "id" is required for action "${action}".`);
            }
            if (params.id.trim().length > MAX_ID_LENGTH) {
                throw new Error(`forge_system_update: argument "id" must be at most ${MAX_ID_LENGTH} characters.`);
            }
        }
        // EACH call checks: current trust, control-tool availability, active preset
        if (!ctx.isProjectTrusted()) {
            throw new Error("forge_system_update requires a trusted project.");
        }
        if (context !== undefined && !sameContext(context, ctx))
            throw new Error("forge_system_update is unavailable for this session.");
        context = ctx;
        const allTools = pi.getAllTools();
        const activeTools = pi.getActiveTools();
        if (!allTools.some((t) => t.name === "forge_system_update") ||
            !activeTools.includes("forge_system_update") ||
            tools.blockReason("forge_system_update") !== undefined) {
            throw new Error('Control tool "forge_system_update" is not available or blocked by policy.');
        }
        const activePreset = workspace.snapshotKnown ? workspace.snapshot().active : undefined;
        if (!activePreset) {
            throw new Error("forge_system_update requires an active preset with bound instruction modes.");
        }
        if (action === "list") {
            const bindingsRes = readBindings(ctx);
            if (!bindingsRes.ok)
                throw new Error(bindingsRes.error);
            const eligible = bindingsRes.bindings.filter((b) => {
                if (!b.modelCallable)
                    return false;
                if (b.mode.tools.remove.includes("forge_system_update"))
                    return false;
                if (tools.validateInstructionModes([b.mode.tools]) !== undefined)
                    return false;
                return true;
            });
            const text = eligible.length
                ? eligible
                    .map((b) => [
                    `id: ${b.id}${b.mode.name ? ` (${b.mode.name})` : ""}`,
                    b.mode.description ? `  description: ${b.mode.description}` : undefined,
                    `  tools: +${b.mode.tools.add.join(", ") || "(none)"}; -${b.mode.tools.remove.join(", ") || "(none)"}`,
                ]
                    .filter(Boolean)
                    .join("\n"))
                    .join("\n\n")
                : "No authorized instruction modes available for agent.";
            return {
                content: [{ type: "text", text }],
                details: {
                    action: "list",
                    modes: eligible.map((b) => ({ id: b.id, name: b.mode.name, tools: b.mode.tools })),
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
                        bindingId: item.snapshot.source.kind === "mode" && item.snapshot.source.binding
                            ? item.snapshot.source.binding.id
                            : undefined,
                        tools: item.snapshot.tools,
                    })),
                },
            };
        }
        if (action === "use") {
            const res = useBound(ctx, params.id, "agent");
            if (!res.ok) {
                throw new Error(res.error);
            }
            return {
                content: [{ type: "text", text: res.message }],
                details: { action: "use", activationId: res.activationId, idempotent: res.idempotent === true },
            };
        }
        if (action === "off") {
            const res = deactivateBound(ctx, params.id, "agent");
            if (!res.ok) {
                throw new Error(res.error);
            }
            return {
                content: [{ type: "text", text: res.message }],
                details: { action: "off", activationId: res.activationId },
            };
        }
        throw new Error(`Unhandled action: ${action}`);
    }
    function commitEndAnchors(ctx) {
        context = ctx;
        if (restoring)
            return;
        if (!pendingEvents(ctx).length)
            return;
        // Interrupted batches may leave an incomplete current tail. Keep intent
        // pending rather than anchoring between its call and a later result.
        if (hasPendingInstructionToolCalls(canonicalSessionMessages(ctx)))
            return;
        persistPendingAnchors(ctx);
    }
    function assertActivationGuard(expected) {
        if (!expected)
            return;
        const current = readState();
        if (disposed || !current.ok || current.state.restoring || !current.state.trusted || !sameGuard(expected, current.state.guard)) {
            throw new Error("Session changed during resource resolution. Refresh and review before activating.");
        }
    }
    function sameGuard(a, b) {
        return a.sessionId === b.sessionId && a.leafId === b.leafId && a.revision === b.revision;
    }
    function sameContext(a, b) {
        try {
            if (!a.sessionManager || !b.sessionManager)
                return false;
            return a.cwd === b.cwd && a.sessionManager.getSessionId() === b.sessionManager.getSessionId()
                && a.sessionManager.getLeafId() === b.sessionManager.getLeafId();
        }
        catch {
            return false;
        }
    }
    function dispose() {
        disposed = true;
        context = undefined;
        restoring = true;
        preparedRevision = undefined;
        preparedModel = undefined;
        restoredTools = undefined;
        agentBusy = false;
    }
    return { prepareRestore, restore, sync, prepareMessages, project, commitEndAnchors, setAgentBusy, library, completionView, status, change, readBindings, useBound, deactivateBound, executeAgentTool, readState, mutateState, readAvailableInstructions, useInstruction, dispose };
}
function sourceLabel(item) {
    return item.snapshot.source.kind === "manual" ? "manual" : formatResourceKey(item.snapshot.source.key);
}
//# sourceMappingURL=instruction-runtime.js.map