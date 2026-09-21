import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import {
	type InstructionHistory,
	INSTRUCTION_DELIVERY_TYPE,
	isInstructionDelivery,
} from "./instruction-protocol.ts";
import {
	reduceInstructionEvents,
	type ActiveInstruction,
	type InstructionEvent,
} from "./instruction-events.ts";

const BUILTIN_BASE_KEYS = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
]);

/** Rebuild only Pi's owned base; foreign named sections/prose remain separate. */
export function getPiBasePrompt(messages: AgentMessage[], fallback: string): string {
	const systems = messages.filter((message): message is SystemMessage => message.role === "system");
	if (!systems.length) return fallback;
	return getCurrentSystemPrompt(systems.map((message, index) => ({
		role: "system" as const,
		content: index === 0 ? message.content : "",
		sections: Object.fromEntries(Object.entries(message.sections ?? {}).filter(([key]) => BUILTIN_BASE_KEYS.has(key))),
		timestamp: message.timestamp,
	})));
}

function createProjectedMessage(
	sections: Record<string, string | null>,
	timestamp: number,
	native: boolean,
): AgentMessage {
	if (native) {
		return {
			role: "system",
			content: "",
			sections,
			timestamp,
		} as AgentMessage;
	}

	const updateText = renderSystemMessageUpdate({
		role: "system",
		content: "",
		sections,
		timestamp,
	});

	return {
		role: "user",
		content: `[pi-forge instruction update]\n${updateText}`,
		timestamp,
	} as AgentMessage;
}

function computeDeltaSections(
	prev: Map<string, string>,
	curr: Map<string, string>,
): Record<string, string | null> | null {
	const sections: Record<string, string | null> = {};
	let hasChanges = false;

	for (const [id, content] of curr) {
		const prevContent = prev.get(id);
		if (prevContent === undefined || prevContent !== content) {
			sections[`forge-instruction-${id}`] = content;
			hasChanges = true;
		}
	}

	for (const [id] of prev) {
		if (!curr.has(id)) {
			sections[`forge-instruction-${id}`] = null;
			hasChanges = true;
		}
	}

	return hasChanges ? sections : null;
}

/**
 * Pure instruction projection bridge. Replaces delivery markers with native
 * SystemMessage or fallback UserMessage updates based on event prefixes.
 */
export function projectInstructionMessages(
	messages: AgentMessage[],
	history: InstructionHistory,
	native: boolean,
): { messages: AgentMessage[]; throughEventId?: string } {
	if (!history || typeof history !== "object" || !Array.isArray(history.events)) {
		throw new Error("Invalid instruction history: events array is required");
	}

	const fullReduction = reduceInstructionEvents(history.events);
	if (!fullReduction.ok) {
		throw new Error(
			`Invalid instruction events at index ${fullReduction.index}: ${fullReduction.error}`,
		);
	}

	// Identical event replays are semantic no-ops, not new cursor positions.
	const seenEvents = new Set<string>();
	history = { ...history, events: history.events.filter((event) => {
		if (seenEvents.has(event.eventId)) return false;
		seenEvents.add(event.eventId);
		return true;
	}) };

	let checkpointIndex = -1;
	if (history.checkpointThrough !== undefined) {
		if (typeof history.checkpointThrough !== "string" || history.checkpointThrough.length === 0) {
			throw new Error("Invalid checkpointThrough: must be a non-empty string");
		}
		checkpointIndex = history.events.findIndex(
			(e) => e.eventId === history.checkpointThrough,
		);
		if (checkpointIndex === -1) {
			throw new Error(
				`checkpointThrough "${history.checkpointThrough}" not found in branch events`,
			);
		}
	}

	const eventIndexMap = new Map<string, number>();
	for (let i = 0; i < history.events.length; i++) {
		eventIndexMap.set(history.events[i].eventId, i);
	}

	for (const msg of messages) {
		if (isInstructionDelivery(msg)) {
			const raw = msg as { details?: unknown };
			if (!raw.details || typeof raw.details !== "object" || Array.isArray(raw.details)) {
				throw new Error("Invalid instruction delivery marker: details object is required");
			}
			const details = raw.details as { schemaVersion?: unknown; throughEventId?: unknown };
			if (details.schemaVersion !== 1) {
				throw new Error(
					`Invalid instruction delivery marker: schemaVersion must be 1, got ${details.schemaVersion}`,
				);
			}
			if (typeof details.throughEventId !== "string" || details.throughEventId.length === 0) {
				throw new Error(
					"Invalid instruction delivery marker: throughEventId must be a non-empty string",
				);
			}
			if (!eventIndexMap.has(details.throughEventId)) {
				throw new Error(
					`Delivery marker cursor "${details.throughEventId}" not found in branch events`,
				);
			}
		}
	}

	const activeCache = new Map<number, Map<string, string>>();
	activeCache.set(-1, new Map());

	function getActiveMap(eventIndex: number): Map<string, string> {
		const cached = activeCache.get(eventIndex);
		if (cached) return cached;

		const subEvents = history.events.slice(0, eventIndex + 1);
		const res = reduceInstructionEvents(subEvents);
		if (!res.ok) {
			throw new Error(`Failed to reduce event prefix: ${res.error}`);
		}
		const map = new Map<string, string>();
		for (const item of res.active) {
			map.set(item.snapshot.activationId, item.snapshot.content);
		}
		activeCache.set(eventIndex, map);
		return map;
	}

	let currentCursor = -1;
	let currentState = new Map<string, string>();
	let checkpointMessage: AgentMessage | undefined = undefined;

	if (history.checkpointThrough !== undefined) {
		currentCursor = checkpointIndex;
		currentState = getActiveMap(checkpointIndex);

		if (currentState.size > 0) {
			const checkpointSections: Record<string, string | null> = {};
			for (const [id, content] of currentState) {
				checkpointSections[`forge-instruction-${id}`] = content;
			}
			const checkpointTimestamp = history.events[checkpointIndex].createdAt;
			checkpointMessage = createProjectedMessage(checkpointSections, checkpointTimestamp, native);
		}
	}

	const out: AgentMessage[] = [];

	for (const msg of messages) {
		if (!isInstructionDelivery(msg)) {
			out.push(msg);
			continue;
		}

		const markerDetails = (msg as { details: { throughEventId: string } }).details;
		const markerCursor = eventIndexMap.get(markerDetails.throughEventId)!;

		if (history.checkpointThrough !== undefined && markerCursor <= checkpointIndex) {
			continue;
		}

		if (markerCursor < currentCursor) {
			throw new Error(
				`Corrupt marker cursor: marker at "${markerDetails.throughEventId}" (index ${markerCursor}) is earlier than current cursor position ${currentCursor}`,
			);
		}

		if (markerCursor === currentCursor) {
			continue;
		}

		const nextState = getActiveMap(markerCursor);
		const delta = computeDeltaSections(currentState, nextState);
		currentState = nextState;
		currentCursor = markerCursor;

		if (delta !== null) {
			const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : 0;
			out.push(createProjectedMessage(delta, timestamp, native));
		}
	}

	if (checkpointMessage !== undefined) {
		const insertIdx = out.findIndex((m) => m.role === "system");
		if (insertIdx !== -1) {
			out.splice(insertIdx + 1, 0, checkpointMessage);
		} else {
			out.unshift(checkpointMessage);
		}
	}

	// Missing carriers may be queued until agent_end, or lost at a crash boundary.
	// Replay EACH pending event: a rule rendered on the previous request still
	// needs an instance-specific stop notice, even if the final net state is empty.
	for (let index = currentCursor + 1; index < history.events.length; index++) {
		const nextState = getActiveMap(index);
		const delta = computeDeltaSections(currentState, nextState);
		currentState = nextState;
		if (delta !== null) out.push(createProjectedMessage(delta, history.events[index].createdAt, native));
	}

	const throughEventId = history.events.length > 0
		? history.events[history.events.length - 1].eventId
		: undefined;

	return {
		messages: out,
		...(throughEventId !== undefined ? { throughEventId } : {}),
	};
}

/**
 * Projects a preset-compiled system prompt into messages. Strips Pi builtin base
 * sections, sets the leading System content, preserves foreign sections and tools.
 */
export function projectPresetSystemPrompt(
	messages: AgentMessage[],
	compiled: string,
): AgentMessage[] {
	let headDone = false;
	const out: AgentMessage[] = [];

	for (const m of messages) {
		if (m.role !== "system") {
			out.push(m);
			continue;
		}

		const sysMsg = m as SystemMessage;
		let filteredSections: Record<string, string | null> | undefined = undefined;

		if (sysMsg.sections) {
			const remainingEntries = Object.entries(sysMsg.sections).filter(
				([k]) => !BUILTIN_BASE_KEYS.has(k),
			);
			if (remainingEntries.length > 0) {
				filteredSections = Object.fromEntries(remainingEntries);
			}
		}

		const newMsg: SystemMessage = {
			...sysMsg,
			content: headDone ? sysMsg.content : compiled,
		};

		if (filteredSections !== undefined) {
			newMsg.sections = filteredSections;
		} else {
			delete newMsg.sections;
		}

		headDone = true;
		out.push(newMsg as AgentMessage);
	}

	if (!headDone) {
		out.unshift({
			role: "system",
			content: compiled,
			timestamp: 0,
		} as AgentMessage);
	}

	return out;
}
