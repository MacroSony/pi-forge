import { canonicalJson, fingerprintJson } from "./json-fingerprint.js";
import { isValidToolName, MAX_CONTENT_LENGTH, MAX_CAPABILITY_NAME_LENGTH, MAX_TOOL_ARRAY_LENGTH, } from "./codecs/capability.js";
import { isResourceScope, isValidResourceId, } from "./resource-identity.js";
export const CAPABILITY_SNAPSHOT_TYPE = "pi-forge.capability-snapshot";
export const FINGERPRINT_PATTERN = /^sha256:v1:[0-9a-f]{64}$/;
export const MAX_ID_LENGTH = 128;
export { MAX_CAPABILITY_NAME_LENGTH };
export const MAX_NAME_LENGTH = MAX_CAPABILITY_NAME_LENGTH;
function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function deepFreeze(obj) {
    if (obj === null || typeof obj !== "object")
        return obj;
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    }
    return obj;
}
function validateSource(source) {
    if (!isPlainObject(source)) {
        return { ok: false, error: "source must be a plain object" };
    }
    const kind = source.kind;
    if (kind === "manual") {
        const keys = Object.keys(source);
        if (keys.length !== 1) {
            return { ok: false, error: "manual source must only have kind property" };
        }
        return { ok: true, value: { kind: "manual" } };
    }
    if (kind === "capability") {
        const allowed = new Set(["kind", "key", "binding"]);
        for (const k of Object.keys(source)) {
            if (!allowed.has(k)) {
                return { ok: false, error: `source has unknown property: ${k}` };
            }
        }
        if (!isPlainObject(source.key)) {
            return { ok: false, error: "capability source requires key object" };
        }
        const keyKeys = Object.keys(source.key);
        if (keyKeys.length !== 2 || !("scope" in source.key) || !("id" in source.key)) {
            return { ok: false, error: "capability key must only contain scope and id" };
        }
        if (!isResourceScope(source.key.scope)) {
            return { ok: false, error: "Invalid capability key scope" };
        }
        if (typeof source.key.id !== "string" ||
            !isValidResourceId(source.key.id)) {
            return { ok: false, error: "Invalid capability key id" };
        }
        let bindingVal = undefined;
        if (source.binding !== undefined) {
            if (!isPlainObject(source.binding)) {
                return { ok: false, error: "binding must be a plain object" };
            }
            const bindingKeys = Object.keys(source.binding);
            if (bindingKeys.length !== 2 || !("preset" in source.binding) || !("id" in source.binding)) {
                return { ok: false, error: "binding must only contain preset and id" };
            }
            if (!isPlainObject(source.binding.preset)) {
                return { ok: false, error: "binding preset must be a plain object" };
            }
            const presetKeys = Object.keys(source.binding.preset);
            if (presetKeys.length !== 2 || !("scope" in source.binding.preset) || !("id" in source.binding.preset)) {
                return { ok: false, error: "binding preset must only contain scope and id" };
            }
            if (!isResourceScope(source.binding.preset.scope)) {
                return { ok: false, error: "Invalid binding preset scope" };
            }
            if (typeof source.binding.preset.id !== "string" ||
                !isValidResourceId(source.binding.preset.id)) {
                return { ok: false, error: "Invalid binding preset id" };
            }
            if (typeof source.binding.id !== "string" ||
                !isValidResourceId(source.binding.id)) {
                return { ok: false, error: "Invalid binding id" };
            }
            // global preset cannot bind project capability
            if (source.binding.preset.scope === "global" && source.key.scope === "project") {
                return { ok: false, error: "Global preset cannot bind project capability" };
            }
            bindingVal = {
                preset: {
                    scope: source.binding.preset.scope,
                    id: source.binding.preset.id,
                },
                id: source.binding.id,
            };
        }
        return {
            ok: true,
            value: {
                kind: "capability",
                key: { scope: source.key.scope, id: source.key.id },
                ...(bindingVal ? { binding: bindingVal } : {}),
            },
        };
    }
    const kindDisplay = typeof kind === "string" || typeof kind === "number" || typeof kind === "boolean"
        ? `: ${kind}`
        : "";
    return { ok: false, error: `Invalid source kind${kindDisplay}` };
}
function validateTools(tools) {
    if (!isPlainObject(tools)) {
        return { ok: false, error: "tools must be a plain object" };
    }
    const keys = Object.keys(tools);
    if (keys.length !== 2 || !("add" in tools) || !("remove" in tools)) {
        return { ok: false, error: "tools must contain exactly add and remove arrays" };
    }
    if (!Array.isArray(tools.add)) {
        return { ok: false, error: "tools.add must be an array" };
    }
    if (!Array.isArray(tools.remove)) {
        return { ok: false, error: "tools.remove must be an array" };
    }
    if (tools.add.length > MAX_TOOL_ARRAY_LENGTH) {
        return { ok: false, error: `tools.add exceeds max length ${MAX_TOOL_ARRAY_LENGTH}` };
    }
    if (tools.remove.length > MAX_TOOL_ARRAY_LENGTH) {
        return { ok: false, error: `tools.remove exceeds max length ${MAX_TOOL_ARRAY_LENGTH}` };
    }
    for (let i = 0; i < tools.add.length; i++) {
        const t = tools.add[i];
        if (typeof t !== "string" || !isValidToolName(t)) {
            return { ok: false, error: `Invalid tool name in tools.add at index ${i}` };
        }
    }
    for (let i = 0; i < tools.remove.length; i++) {
        const t = tools.remove[i];
        if (typeof t !== "string" || !isValidToolName(t)) {
            return { ok: false, error: `Invalid tool name in tools.remove at index ${i}` };
        }
    }
    return {
        ok: true,
        value: {
            add: [...tools.add],
            remove: [...tools.remove],
        },
    };
}
function computeSnapshotFingerprint(source, content, tools, name) {
    const payload = {
        type: CAPABILITY_SNAPSHOT_TYPE,
        schemaVersion: 1,
        source,
        ...(name !== undefined ? { name } : {}),
        content,
        tools,
    };
    return fingerprintJson(payload);
}
export function createCapabilitySnapshot(input) {
    if (!isPlainObject(input)) {
        throw new TypeError("CapabilitySnapshot input must be a plain object");
    }
    const allowedKeys = new Set(["activationId", "source", "name", "content", "tools"]);
    for (const k of Object.keys(input)) {
        if (!allowedKeys.has(k)) {
            throw new TypeError(`Unexpected property on snapshot input: ${k}`);
        }
    }
    if (typeof input.activationId !== "string" ||
        input.activationId.length === 0 ||
        input.activationId.length > MAX_ID_LENGTH ||
        !isValidResourceId(input.activationId)) {
        throw new TypeError("activationId must be a valid resource id <= 128 chars");
    }
    const sourceRes = validateSource(input.source);
    if (!sourceRes.ok) {
        throw new TypeError(sourceRes.error);
    }
    let nameVal = undefined;
    if (input.name !== undefined) {
        if (typeof input.name !== "string" || input.name.length > MAX_NAME_LENGTH) {
            throw new TypeError(`name must be a string <= ${MAX_NAME_LENGTH} chars`);
        }
        nameVal = input.name;
    }
    if (typeof input.content !== "string" || input.content.length > MAX_CONTENT_LENGTH) {
        throw new TypeError(`content must be a string <= ${MAX_CONTENT_LENGTH} chars`);
    }
    const toolsRes = validateTools(input.tools);
    if (!toolsRes.ok) {
        throw new TypeError(toolsRes.error);
    }
    if (input.content.trim().length === 0 &&
        toolsRes.value.add.length === 0 &&
        toolsRes.value.remove.length === 0) {
        throw new TypeError("Snapshot must have non-empty content or at least one tool effect");
    }
    const clonedSource = sourceRes.value;
    const clonedTools = toolsRes.value;
    const fingerprint = computeSnapshotFingerprint(clonedSource, input.content, clonedTools, nameVal);
    const snapshot = {
        activationId: input.activationId,
        source: clonedSource,
        ...(nameVal !== undefined ? { name: nameVal } : {}),
        content: input.content,
        tools: clonedTools,
        fingerprint,
    };
    return deepFreeze(snapshot);
}
export function decodeCapabilityEvent(raw) {
    if (!isPlainObject(raw)) {
        return { ok: false, error: "Event must be a plain object" };
    }
    if (raw.schemaVersion !== 1) {
        return { ok: false, error: "schemaVersion must be 1" };
    }
    if (typeof raw.eventId !== "string" ||
        raw.eventId.length === 0 ||
        raw.eventId.length > MAX_ID_LENGTH ||
        !isValidResourceId(raw.eventId)) {
        return { ok: false, error: "Invalid eventId" };
    }
    if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt) || raw.createdAt < 0) {
        return { ok: false, error: "createdAt must be a non-negative finite number" };
    }
    const op = raw.op;
    if (op === "activate") {
        const allowedKeys = new Set(["schemaVersion", "eventId", "op", "actor", "createdAt", "snapshot"]);
        for (const k of Object.keys(raw)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: `Unexpected property on activate event: ${k}` };
            }
        }
        if (raw.actor !== "user" && raw.actor !== "agent") {
            return { ok: false, error: "Activate actor must be user or agent" };
        }
        if (!isPlainObject(raw.snapshot)) {
            return { ok: false, error: "snapshot must be a plain object" };
        }
        const snapAllowed = new Set(["activationId", "source", "name", "content", "tools", "fingerprint"]);
        for (const k of Object.keys(raw.snapshot)) {
            if (!snapAllowed.has(k)) {
                return { ok: false, error: `Unexpected property on snapshot: ${k}` };
            }
        }
        if (typeof raw.snapshot.activationId !== "string" ||
            raw.snapshot.activationId.length === 0 ||
            raw.snapshot.activationId.length > MAX_ID_LENGTH ||
            !isValidResourceId(raw.snapshot.activationId)) {
            return { ok: false, error: "Invalid snapshot activationId" };
        }
        const sourceRes = validateSource(raw.snapshot.source);
        if (!sourceRes.ok) {
            return { ok: false, error: sourceRes.error };
        }
        const source = sourceRes.value;
        // agent activation must be source.capability and binding must exist
        if (raw.actor === "agent") {
            if (source.kind !== "capability" || !source.binding) {
                return { ok: false, error: "agent activation must have source capability with binding" };
            }
        }
        // manual source can only be user activated
        if (source.kind === "manual" && raw.actor !== "user") {
            return { ok: false, error: "manual source can only be activated by user" };
        }
        let nameVal = undefined;
        if (raw.snapshot.name !== undefined) {
            if (typeof raw.snapshot.name !== "string" || raw.snapshot.name.length > MAX_NAME_LENGTH) {
                return { ok: false, error: `name must be a string <= ${MAX_NAME_LENGTH}` };
            }
            nameVal = raw.snapshot.name;
        }
        if (typeof raw.snapshot.content !== "string" || raw.snapshot.content.length > MAX_CONTENT_LENGTH) {
            return { ok: false, error: `content must be a string <= ${MAX_CONTENT_LENGTH}` };
        }
        const toolsRes = validateTools(raw.snapshot.tools);
        if (!toolsRes.ok) {
            return { ok: false, error: toolsRes.error };
        }
        const tools = toolsRes.value;
        if (raw.snapshot.content.trim().length === 0 &&
            tools.add.length === 0 &&
            tools.remove.length === 0) {
            return { ok: false, error: "Snapshot must have non-empty content or at least one tool effect" };
        }
        if (typeof raw.snapshot.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(raw.snapshot.fingerprint)) {
            return { ok: false, error: "Invalid snapshot fingerprint format" };
        }
        const expectedFp = computeSnapshotFingerprint(source, raw.snapshot.content, tools, nameVal);
        if (raw.snapshot.fingerprint !== expectedFp) {
            return { ok: false, error: "Snapshot fingerprint mismatch" };
        }
        const snapshot = {
            activationId: raw.snapshot.activationId,
            source,
            ...(nameVal !== undefined ? { name: nameVal } : {}),
            content: raw.snapshot.content,
            tools,
            fingerprint: raw.snapshot.fingerprint,
        };
        return {
            ok: true,
            event: deepFreeze({
                schemaVersion: 1,
                eventId: raw.eventId,
                op: "activate",
                actor: raw.actor,
                createdAt: raw.createdAt,
                snapshot: deepFreeze(snapshot),
            }),
        };
    }
    if (op === "deactivate") {
        const allowedKeys = new Set(["schemaVersion", "eventId", "op", "actor", "createdAt", "activationId"]);
        for (const k of Object.keys(raw)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: `Unexpected property on deactivate event: ${k}` };
            }
        }
        if (raw.actor !== "user" && raw.actor !== "agent" && raw.actor !== "lifecycle") {
            return { ok: false, error: "Deactivate actor must be user, agent, or lifecycle" };
        }
        if (typeof raw.activationId !== "string" ||
            raw.activationId.length === 0 ||
            raw.activationId.length > MAX_ID_LENGTH ||
            !isValidResourceId(raw.activationId)) {
            return { ok: false, error: "Invalid activationId" };
        }
        return {
            ok: true,
            event: deepFreeze({
                schemaVersion: 1,
                eventId: raw.eventId,
                op: "deactivate",
                actor: raw.actor,
                createdAt: raw.createdAt,
                activationId: raw.activationId,
            }),
        };
    }
    if (op === "reset") {
        const allowedKeys = new Set(["schemaVersion", "eventId", "op", "actor", "createdAt"]);
        for (const k of Object.keys(raw)) {
            if (!allowedKeys.has(k)) {
                return { ok: false, error: `Unexpected property on reset event: ${k}` };
            }
        }
        if (raw.actor !== "user") {
            return { ok: false, error: "Reset actor must be user" };
        }
        return {
            ok: true,
            event: deepFreeze({
                schemaVersion: 1,
                eventId: raw.eventId,
                op: "reset",
                actor: "user",
                createdAt: raw.createdAt,
            }),
        };
    }
    const opDisplay = typeof op === "string" || typeof op === "number" || typeof op === "boolean"
        ? `: ${op}`
        : "";
    return { ok: false, error: `Invalid op${opDisplay}` };
}
/**
 * Reduce an ordered event stream into active capability states.
 * Note: Current reducer only validates event shape and historical actor ownership.
 * It does not validate current Preset.modelCallable, registered tools, or top-level policy;
 * these are deferred to downstream services, and complete authorization checking is not claimed here.
 */
export function reduceCapabilityEvents(events) {
    if (!Array.isArray(events)) {
        return { ok: false, index: 0, error: "Events must be an array" };
    }
    const activeList = [];
    const seenActivationIds = new Set();
    const seenEvents = new Map();
    let lastEventId = undefined;
    for (let i = 0; i < events.length; i++) {
        const raw = events[i];
        const decoded = decodeCapabilityEvent(raw);
        if (!decoded.ok) {
            return { ok: false, index: i, error: decoded.error };
        }
        const event = decoded.event;
        const canonical = canonicalJson(event);
        if (seenEvents.has(event.eventId)) {
            if (seenEvents.get(event.eventId) === canonical) {
                // Duplicate identical eventId/identical canonical event: idempotent noop
                continue;
            }
            return {
                ok: false,
                index: i,
                error: `Duplicate eventId with conflicting payload: ${event.eventId}`,
            };
        }
        seenEvents.set(event.eventId, canonical);
        lastEventId = event.eventId;
        if (event.op === "activate") {
            if (seenActivationIds.has(event.snapshot.activationId)) {
                return {
                    ok: false,
                    index: i,
                    error: `activationId cannot be reused in the same branch: ${event.snapshot.activationId}`,
                };
            }
            seenActivationIds.add(event.snapshot.activationId);
            if (event.snapshot.source.kind === "capability" && event.snapshot.source.binding) {
                const binding = event.snapshot.source.binding;
                const duplicateBinding = activeList.some((item) => item.snapshot.source.kind === "capability" &&
                    item.snapshot.source.binding &&
                    item.snapshot.source.binding.preset.scope === binding.preset.scope &&
                    item.snapshot.source.binding.preset.id === binding.preset.id &&
                    item.snapshot.source.binding.id === binding.id);
                if (duplicateBinding) {
                    return {
                        ok: false,
                        index: i,
                        error: `Duplicate preset binding id currently active: ${binding.preset.scope}:${binding.preset.id} -> ${binding.id}`,
                    };
                }
            }
            activeList.push(Object.freeze({
                snapshot: event.snapshot,
                actor: event.actor,
                eventId: event.eventId,
                createdAt: event.createdAt,
            }));
        }
        else if (event.op === "deactivate") {
            const targetIdx = activeList.findIndex((item) => item.snapshot.activationId === event.activationId);
            if (targetIdx === -1) {
                // off on duplicate or unknown activationId is a noop
                continue;
            }
            const target = activeList[targetIdx];
            // agent cannot deactivate user owned activation
            if (event.actor === "agent" && target.actor === "user") {
                return {
                    ok: false,
                    index: i,
                    error: `Agent cannot deactivate user-owned activation: ${event.activationId}`,
                };
            }
            // lifecycle can only deactivate capability with binding
            if (event.actor === "lifecycle") {
                if (target.snapshot.source.kind !== "capability" || !target.snapshot.source.binding) {
                    return {
                        ok: false,
                        index: i,
                        error: `Lifecycle can only deactivate capability with binding: ${event.activationId}`,
                    };
                }
            }
            activeList.splice(targetIdx, 1);
        }
        else if (event.op === "reset") {
            activeList.length = 0;
        }
    }
    return {
        ok: true,
        active: Object.freeze([...activeList]),
        ...(lastEventId !== undefined ? { lastEventId } : {}),
    };
}
//# sourceMappingURL=capability-events.js.map