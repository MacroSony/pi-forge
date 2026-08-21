import type { Block, TurnSnapshot } from "../../src/context-diff.ts";
import { createBlock, createTurnSnapshot } from "../../src/context-diff.ts";
import { formatProviderPayload } from "../../src/payload-capture.ts";

export interface TurnPayloadFixtureSet {
	name: string;
	description: string;
	/** Realistic provider request payloads corresponding one-to-one with turns. */
	payloads: unknown[];
	/** Realistic `payload-capture.ts`-style capture shapes corresponding one-to-one with turns. */
	captures: TurnPayloadCapture[];
	turns: TurnSnapshot[];
}

interface MessageFixture {
	role: string;
	content: string;
}

export interface TurnPayloadCapture {
	capturedAt: string;
	stackId: string;
	payload?: unknown;
	text: string;
	chars: number;
	approxTokens: number;
	truncated: boolean;
	error?: string;
}

function captureFromPayload(capturedAt: string, stackId: string, payload: unknown): TurnPayloadCapture {
	return { capturedAt, stackId, ...formatProviderPayload(payload) };
}

function messageBlocks(messages: MessageFixture[]): Block[] {
	return messages.map((message, index) =>
		createBlock(
			index === 0 && message.role === "system" ? "system" : `message-${index}`,
			message.role,
			message.content,
		),
	);
}

function payloadTurn(
	turnId: string,
	capturedAt: string,
	stackId: string,
	messages: MessageFixture[],
): TurnSnapshot {
	return createTurnSnapshot({
		turnId,
		capturedAt,
		stackId,
		blocks: messageBlocks(messages),
	});
}

function openAiPayload(messages: MessageFixture[]): unknown {
	return {
		model: "gpt-4.1",
		messages,
		temperature: 0.7,
		stream: true,
		max_tokens: 2048,
	};
}

const stackId = "stack-context-diff";

const systemPrompt =
	"You are a meticulous coding assistant. Follow the user's instructions precisely, inspect the relevant code first, and propose minimal changes.";
const userFirst =
	"Refactor the parser module in src/parser.ts to use a recursive descent structure and add unit tests for the new entry points.";
const assistantFirst =
	"I will start by reading src/parser.ts and its existing tests to understand the current shape before proposing the refactor.";
const userSecond =
	"Please also update the changelog and keep the public API backward compatible.";

const identicalTurnMessages: MessageFixture[] = [
	{ role: "system", content: systemPrompt },
	{ role: "user", content: userFirst },
	{ role: "assistant", content: assistantFirst },
	{ role: "user", content: userSecond },
];

const turn1Payload = openAiPayload(identicalTurnMessages);
const turn2Payload = openAiPayload(identicalTurnMessages);

export const identicalConsecutiveTurns: TurnPayloadFixtureSet = {
	name: "identical-consecutive-turns",
	description: "Two consecutive captures with no prompt changes; the cache boundary should cover the full prompt.",
	payloads: [turn1Payload, turn2Payload],
	captures: [
		captureFromPayload("2025-01-01T00:00:00.000Z", stackId, turn1Payload),
		captureFromPayload("2025-01-01T00:01:00.000Z", stackId, turn2Payload),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:00:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:01:00.000Z", stackId, identicalTurnMessages),
	],
};

const addedUserMessage: MessageFixture = {
	role: "user",
	content: "One more thing: keep the public API stable and document the new parser entry points.",
};

export const blockAddedTurnSet: TurnPayloadFixtureSet = {
	name: "block-added",
	description: "A new user message is appended after an otherwise identical prompt.",
	payloads: [
		openAiPayload(identicalTurnMessages),
		openAiPayload([...identicalTurnMessages, addedUserMessage]),
	],
	captures: [
		captureFromPayload("2025-01-01T00:02:00.000Z", stackId, openAiPayload(identicalTurnMessages)),
		captureFromPayload("2025-01-01T00:03:00.000Z", stackId, openAiPayload([...identicalTurnMessages, addedUserMessage])),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:02:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:03:00.000Z", stackId, [
			...identicalTurnMessages,
			addedUserMessage,
		]),
	],
};

export const blockRemovedTurnSet: TurnPayloadFixtureSet = {
	name: "block-removed",
	description: "The final user message is dropped, shrinking the prompt from the tail.",
	payloads: [
		openAiPayload(identicalTurnMessages),
		openAiPayload(identicalTurnMessages.slice(0, 3)),
	],
	captures: [
		captureFromPayload("2025-01-01T00:04:00.000Z", stackId, openAiPayload(identicalTurnMessages)),
		captureFromPayload("2025-01-01T00:05:00.000Z", stackId, openAiPayload(identicalTurnMessages.slice(0, 3))),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:04:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:05:00.000Z", stackId, identicalTurnMessages.slice(0, 3)),
	],
};

const modifiedAssistantMessage: MessageFixture = {
	role: "assistant",
	content:
		"I will start by reading src/parser.ts and its existing tests, then I will sketch the recursive descent structure before proposing the refactor.",
};

export const blockModifiedMidArrayTurnSet: TurnPayloadFixtureSet = {
	name: "block-modified-mid-array",
	description: "The assistant block in the middle changes while the surrounding blocks stay identical.",
	payloads: [
		openAiPayload(identicalTurnMessages),
		openAiPayload([
			identicalTurnMessages[0],
			identicalTurnMessages[1],
			modifiedAssistantMessage,
			identicalTurnMessages[3],
		]),
	],
	captures: [
		captureFromPayload("2025-01-01T00:06:00.000Z", stackId, openAiPayload(identicalTurnMessages)),
		captureFromPayload("2025-01-01T00:07:00.000Z", stackId, openAiPayload([
			identicalTurnMessages[0],
			identicalTurnMessages[1],
			modifiedAssistantMessage,
			identicalTurnMessages[3],
		])),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:06:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:07:00.000Z", stackId, [
			identicalTurnMessages[0],
			identicalTurnMessages[1],
			modifiedAssistantMessage,
			identicalTurnMessages[3],
		]),
	],
};

const changedSystemPrompt =
	"You are a rigorous coding assistant. Follow the user's instructions precisely, inspect the relevant code first, and propose minimal, well-tested changes.";

export const firstBlockChangeTurnSet: TurnPayloadFixtureSet = {
	name: "first-block-change",
	description: "The system prompt changes at the top, so the cache boundary starts inside the first block.",
	payloads: [
		openAiPayload(identicalTurnMessages),
		openAiPayload([
			{ role: "system", content: changedSystemPrompt },
			...identicalTurnMessages.slice(1),
		]),
	],
	captures: [
		captureFromPayload("2025-01-01T00:08:00.000Z", stackId, openAiPayload(identicalTurnMessages)),
		captureFromPayload("2025-01-01T00:09:00.000Z", stackId, openAiPayload([
			{ role: "system", content: changedSystemPrompt },
			...identicalTurnMessages.slice(1),
		])),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:08:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:09:00.000Z", stackId, [
			{ role: "system", content: changedSystemPrompt },
			...identicalTurnMessages.slice(1),
		]),
	],
};

const modifiedUserFirst: MessageFixture = {
	role: "user",
	content:
		"Refactor the parser module in src/parser.ts to use a recursive descent structure, add unit tests for the new entry points, and update the module documentation.",
};

export const multiBlockMixedChangesTurnSet: TurnPayloadFixtureSet = {
	name: "multi-block-mixed-changes",
	description: "A mid-array block is modified and a new user message is appended, with later identical blocks after the cache boundary.",
	payloads: [
		openAiPayload(identicalTurnMessages),
		openAiPayload([
			identicalTurnMessages[0],
			modifiedUserFirst,
			identicalTurnMessages[2],
			identicalTurnMessages[3],
			addedUserMessage,
		]),
	],
	captures: [
		captureFromPayload("2025-01-01T00:10:00.000Z", stackId, openAiPayload(identicalTurnMessages)),
		captureFromPayload("2025-01-01T00:11:00.000Z", stackId, openAiPayload([
			identicalTurnMessages[0],
			modifiedUserFirst,
			identicalTurnMessages[2],
			identicalTurnMessages[3],
			addedUserMessage,
		])),
	],
	turns: [
		payloadTurn("turn-1", "2025-01-01T00:10:00.000Z", stackId, identicalTurnMessages),
		payloadTurn("turn-2", "2025-01-01T00:11:00.000Z", stackId, [
			identicalTurnMessages[0],
			modifiedUserFirst,
			identicalTurnMessages[2],
			identicalTurnMessages[3],
			addedUserMessage,
		]),
	],
};

export const contextDiffFixtureSets: TurnPayloadFixtureSet[] = [
	identicalConsecutiveTurns,
	blockAddedTurnSet,
	blockRemovedTurnSet,
	blockModifiedMidArrayTurnSet,
	firstBlockChangeTurnSet,
	multiBlockMixedChangesTurnSet,
];
