import type { AgentBeforeSettleEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 1. Harness imported first so fetch guard is installed immediately
import { createInstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";

// 2. Dynamic imports after fetch guard is active
const {
	initTheme,
	SessionManager,
	buildSessionProjection,
} = await import("@earendil-works/pi-coding-agent");
initTheme();
const {
	getCurrentSystemPrompt,
	getCurrentTools,
} = await import("@earendil-works/pi-ai");
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
	SystemMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
const {
	INSTRUCTION_DELIVERY_TYPE,
	INSTRUCTION_EVENT_ENTRY,
} = await import("../src/instruction-protocol.ts");

function textOf(msg: AgentMessage): string {
	const content = (msg as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: "text"; text: string } =>
					Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text"),
			)
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

function setupHermeticProject(options?: {
	customStack?: unknown;
	customMode?: unknown;
	skipStack?: boolean;
	skipConfig?: boolean;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-pi087-project-"));

	if (!options?.skipConfig) {
		const configDir = join(cwd, ".pi", "forge");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ autoActivate: true }, null, 2),
		);
	}

	if (!options?.skipStack) {
		const stackDir = join(cwd, ".pi", "forge", "prompt-stacks");
		mkdirSync(stackDir, { recursive: true });
		const stack = options?.customStack ?? {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "base",
			name: "Base Stack",
			autoActivate: true,
			items: [
				{
					kind: "block",
					id: "sys1",
					role: "system",
					content: "Base preset system block for pi087",
				},
			],
		};
		writeFileSync(join(stackDir, "base.json"), JSON.stringify(stack, null, 2));
	}

	const modesDir = join(cwd, ".pi", "forge", "instruction-modes");
	mkdirSync(modesDir, { recursive: true });
	const mode = options?.customMode ?? {
		schemaVersion: 1,
		type: "pi-forge.instruction-mode",
		id: "review",
		name: "Review Mode",
		content: "REVIEW_MODE_ACTIVE_RULE",
		tools: {
			add: [],
			remove: ["fake_write"],
		},
	};
	writeFileSync(join(modesDir, "review.json"), JSON.stringify(mode, null, 2));

	return {
		cwd,
		cleanup() {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

function assertLeadingSystemAndMode(
	messages: AgentMessage[],
	expectedBaseText: string,
	expectedModeText: string,
	native: boolean,
) {
	assert.ok(messages.length >= 2, "transcript must contain at least system and user message");
	const leadingSystem = messages[0];
	assert.equal(leadingSystem.role, "system", "first message in transcript must be system");
	assert.ok(
		textOf(leadingSystem).includes(expectedBaseText),
		"initial System message must include compiled base text",
	);

	const baseOccurrences = messages.filter((m) => textOf(m).includes(expectedBaseText));
	assert.equal(baseOccurrences.length, 1, "exactly one compiled base occurrence in transcript");

	if (native) {
		const modeUpdates = messages.slice(1).filter((m) => {
			if (m.role === "system") {
				const sections = (m as { sections?: Record<string, string | null> }).sections;
				return (
					sections &&
					Object.values(sections).some(
						(v) => typeof v === "string" && v.includes(expectedModeText),
					)
				);
			}
			return false;
		});
		assert.ok(modeUpdates.length >= 1, "native mode update section must be projected after head");
	} else {
		const fallbackUpdates = messages.slice(1).filter((m) => {
			return (
				m.role === "user" &&
				textOf(m).includes("[pi-forge instruction update]") &&
				textOf(m).includes(expectedModeText)
			);
		});
		assert.ok(fallbackUpdates.length >= 1, "fallback mode update must be projected after head");
	}
}

test("Pi 0.87 Regression Suite (Canonical Projection & context_with_system Integration)", async (suite) => {
	await suite.test(
		"1. native mode: exact single leading compiled System, active rule projection, and tool gating",
		async () => {
			const env = setupHermeticProject();
			try {
				const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: true });
				try {
					assert.ok(harness.getActiveToolNames().includes("fake_write"), "initial tools include fake_write");

					// Activate instruction mode via Forge command
					await harness.prompt("/instruction use review");
					assert.equal(harness.streamContexts.length, 0, "idle activation does not dispatch to provider");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write is immediately gated off");

					// Script provider turn
					harness.setResponses(["Review mode acknowledged."]);
					await harness.prompt("Please inspect the repository");

					assert.equal(harness.streamContexts.length, 1, "prompt dispatches exactly one provider turn");
					const streamCtx = harness.streamContexts[0];
					assert.ok(streamCtx, "streamContext must be recorded");

					// Single leading compiled System message, exactly one compiled base occurrence, mode updates after head
					assertLeadingSystemAndMode(
						streamCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						true,
					);

					// Active rule projection
					const fullSysPrompt = getCurrentSystemPrompt(streamCtx.messages);
					assert.ok(
						fullSysPrompt.includes("REVIEW_MODE_ACTIVE_RULE"),
						"system prompt must project active instruction mode rule",
					);

					// Tool gating
					const streamToolNames = getCurrentTools(streamCtx.messages).map((t) => t.name);
					assert.ok(!streamToolNames.includes("fake_write"), "fake_write must be absent from stream tool declarations");
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. fallback mode: exact single leading compiled System, timeline user instruction update, and tool gating",
		async () => {
			const env = setupHermeticProject();
			try {
				const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: false });
				try {
					assert.ok(harness.getActiveToolNames().includes("fake_write"), "initial tools include fake_write");

					// Activate instruction mode in fallback mode
					await harness.prompt("/instruction use review");
					assert.equal(harness.streamContexts.length, 0, "idle activation does not dispatch to provider");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write is immediately gated off in fallback");

					harness.setResponses(["Fallback mode acknowledged."]);
					await harness.prompt("Please inspect the repository");

					assert.equal(harness.streamContexts.length, 1, "prompt dispatches one provider turn in fallback");
					const streamCtx = harness.streamContexts[0];
					assert.ok(streamCtx, "streamContext must be recorded in fallback");

					// Single leading compiled System message, exactly one compiled base occurrence, mode updates after head
					assertLeadingSystemAndMode(
						streamCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						false,
					);

					// Tool gating
					const streamToolNames = getCurrentTools(streamCtx.messages).map((t) => t.name);
					assert.ok(!streamToolNames.includes("fake_write"), "fake_write must be absent from fallback tool declarations");
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. native mode: real SDK active mode with external appendContextEdit, refreshContext, canonical projection, and tool gating",
		async () => {
			const env = setupHermeticProject();
			try {
				const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: true });
				try {
					assert.ok(harness.getActiveToolNames().includes("fake_write"), "initial tools include fake_write");

					// Activate instruction mode
					await harness.prompt("/instruction use review");
					assert.equal(harness.streamContexts.length, 0, "idle activation does not dispatch to provider");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write is immediately gated off");

					// Actual h.prompt seed with user prompt, assistant tool call, tool result, and assistant reply
					harness.setResponses([
						{ toolCalls: [{ name: "fake_read", args: { path: "seed.txt" } }] },
						"INITIAL_RAW_ASSISTANT_REPLY",
					]);
					await harness.prompt("INITIAL_RAW_USER_QUERY");

					// External fixture appends custom peer message
					const customEntryId = harness.sessionManager.appendCustomMessageEntry(
						"peer",
						"INITIAL_RAW_CUSTOM_PAYLOAD",
						false,
					);

					// Semantic events and anchors must exist in session
					const branch = harness.sessionManager.getBranch();
					const semanticEvent = branch.find(
						(e) => e.type === "custom" && e.customType === INSTRUCTION_EVENT_ENTRY,
					);
					assert.ok(semanticEvent, "mode semantic event must exist in session branch");

					const deliveryAnchor = branch.find(
						(e) => e.type === "custom" && e.customType === INSTRUCTION_DELIVERY_TYPE,
					);
					assert.ok(deliveryAnchor, "mode delivery anchor must exist in session branch");

					// Locate the seed entries to edit
					const userEntry = branch.find(
						(e) =>
							e.type === "message" &&
							textOf(e.message as AgentMessage).includes("INITIAL_RAW_USER_QUERY"),
					);
					assert.ok(userEntry, "seed user entry exists");

					const assistantEntry = branch.find(
						(e) =>
							e.type === "message" &&
							textOf(e.message as AgentMessage).includes("INITIAL_RAW_ASSISTANT_REPLY"),
					);
					assert.ok(assistantEntry, "seed assistant entry exists");

					const toolResultEntry = branch.find(
						(e) => e.type === "message" && (e.message as { role?: unknown })?.role === "toolResult",
					);
					assert.ok(toolResultEntry, "seed toolResult entry exists");

					// External appendContextEdit: replace user, assistant, toolResult; omit custom
					harness.sessionManager.appendContextEdit(userEntry.id, {
						content: "CANONICAL_REPLACED_USER_QUERY",
					});
					harness.sessionManager.appendContextEdit(assistantEntry.id, {
						content: "CANONICAL_REPLACED_ASSISTANT_REPLY",
					});
					harness.sessionManager.appendContextEdit(toolResultEntry.id, {
						content: "CANONICAL_REPLACED_TOOL_RESULT",
					});
					harness.sessionManager.appendContextEdit(customEntryId, null);

					// Synchronize active session state
					harness.session.refreshContext();

					// Actual subsequent model request
					harness.setResponses(["Subsequent turn response acknowledged."]);
					await harness.prompt("Subsequent turn user request");

					// Stream context for subsequent request must reflect canonical edits
					assert.ok(harness.streamContexts.length >= 2, "at least two provider turns recorded");
					const subsequentCtx = harness.streamContexts[harness.streamContexts.length - 1];
					assert.ok(subsequentCtx, "subsequent streamContext must exist");

					// 1. Assert initial System includes compiled base, exactly one base occurrence, mode updates after head
					assertLeadingSystemAndMode(
						subsequentCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						true,
					);

					// 2. Canonical text is projected
					const allText = subsequentCtx.messages.map(textOf).join("\n");
					assert.ok(
						allText.includes("CANONICAL_REPLACED_USER_QUERY"),
						"subsequent provider request includes canonical user replacement",
					);
					assert.ok(
						allText.includes("CANONICAL_REPLACED_ASSISTANT_REPLY"),
						"subsequent provider request includes canonical assistant replacement",
					);
					assert.ok(
						allText.includes("CANONICAL_REPLACED_TOOL_RESULT"),
						"subsequent provider request includes canonical toolResult replacement",
					);

					// 3. No raw text resurrection
					assert.ok(
						!allText.includes("INITIAL_RAW_USER_QUERY"),
						"raw replaced user text never resurrects in subsequent request",
					);
					assert.ok(
						!allText.includes("INITIAL_RAW_ASSISTANT_REPLY"),
						"raw replaced assistant text never resurrects in subsequent request",
					);
					assert.ok(
						!allText.includes("INITIAL_RAW_CUSTOM_PAYLOAD"),
						"omitted raw custom text never resurrects in subsequent request",
					);

					// 4. Active rules still projected
					const fullSysPrompt = getCurrentSystemPrompt(subsequentCtx.messages);
					assert.ok(
						fullSysPrompt.includes("REVIEW_MODE_ACTIVE_RULE"),
						"system prompt projects active mode rule on subsequent request",
					);

					// 5. Tools still gated
					const streamToolNames = getCurrentTools(subsequentCtx.messages).map((t) => t.name);
					assert.ok(
						!streamToolNames.includes("fake_write"),
						"fake_write remains gated off during subsequent request",
					);
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. fallback mode: real SDK active mode with external appendContextEdit, refreshContext, canonical projection, and tool gating",
		async () => {
			const env = setupHermeticProject();
			try {
				const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: false });
				try {
					assert.ok(harness.getActiveToolNames().includes("fake_write"), "initial tools include fake_write");

					// Activate instruction mode in fallback mode
					await harness.prompt("/instruction use review");
					assert.equal(harness.streamContexts.length, 0, "idle activation does not dispatch to provider");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write is immediately gated off in fallback");

					// Actual h.prompt seed with user prompt, assistant tool call, tool result, and assistant reply
					harness.setResponses([
						{ toolCalls: [{ name: "fake_read", args: { path: "seed.txt" } }] },
						"INITIAL_RAW_ASSISTANT_REPLY",
					]);
					await harness.prompt("INITIAL_RAW_USER_QUERY");

					// External fixture appends custom peer message
					const customEntryId = harness.sessionManager.appendCustomMessageEntry(
						"peer",
						"INITIAL_RAW_CUSTOM_PAYLOAD",
						false,
					);

					// Semantic events and anchors must exist in session
					const branch = harness.sessionManager.getBranch();
					const semanticEvent = branch.find(
						(e) => e.type === "custom" && e.customType === INSTRUCTION_EVENT_ENTRY,
					);
					assert.ok(semanticEvent, "mode semantic event must exist in session branch");

					const deliveryAnchor = branch.find(
						(e) => e.type === "custom" && e.customType === INSTRUCTION_DELIVERY_TYPE,
					);
					assert.ok(deliveryAnchor, "mode delivery anchor must exist in session branch");

					// Locate the seed entries to edit
					const userEntry = branch.find(
						(e) =>
							e.type === "message" &&
							textOf(e.message as AgentMessage).includes("INITIAL_RAW_USER_QUERY"),
					);
					assert.ok(userEntry, "seed user entry exists");

					const assistantEntry = branch.find(
						(e) =>
							e.type === "message" &&
							textOf(e.message as AgentMessage).includes("INITIAL_RAW_ASSISTANT_REPLY"),
					);
					assert.ok(assistantEntry, "seed assistant entry exists");

					const toolResultEntry = branch.find(
						(e) => e.type === "message" && (e.message as { role?: unknown })?.role === "toolResult",
					);
					assert.ok(toolResultEntry, "seed toolResult entry exists");

					// External appendContextEdit: replace user, assistant, toolResult; omit custom
					harness.sessionManager.appendContextEdit(userEntry.id, {
						content: "CANONICAL_REPLACED_USER_QUERY",
					});
					harness.sessionManager.appendContextEdit(assistantEntry.id, {
						content: "CANONICAL_REPLACED_ASSISTANT_REPLY",
					});
					harness.sessionManager.appendContextEdit(toolResultEntry.id, {
						content: "CANONICAL_REPLACED_TOOL_RESULT",
					});
					harness.sessionManager.appendContextEdit(customEntryId, null);

					// Synchronize active session state
					harness.session.refreshContext();

					// Actual subsequent model request
					harness.setResponses(["Subsequent fallback turn response acknowledged."]);
					await harness.prompt("Subsequent turn user request");

					// Stream context for subsequent request must reflect canonical edits
					assert.ok(harness.streamContexts.length >= 2, "at least two provider turns recorded");
					const subsequentCtx = harness.streamContexts[harness.streamContexts.length - 1];
					assert.ok(subsequentCtx, "subsequent streamContext must exist");

					// 1. Assert initial System includes compiled base, exactly one base occurrence, mode updates after head
					assertLeadingSystemAndMode(
						subsequentCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						false,
					);

					// 2. Canonical text is projected
					const allText = subsequentCtx.messages.map(textOf).join("\n");
					assert.ok(
						allText.includes("CANONICAL_REPLACED_USER_QUERY"),
						"subsequent provider request includes canonical user replacement",
					);
					assert.ok(
						allText.includes("CANONICAL_REPLACED_ASSISTANT_REPLY"),
						"subsequent provider request includes canonical assistant replacement",
					);
					assert.ok(
						allText.includes("CANONICAL_REPLACED_TOOL_RESULT"),
						"subsequent provider request includes canonical toolResult replacement",
					);

					// 3. No raw text resurrection
					assert.ok(
						!allText.includes("INITIAL_RAW_USER_QUERY"),
						"raw replaced user text never resurrects in subsequent request",
					);
					assert.ok(
						!allText.includes("INITIAL_RAW_ASSISTANT_REPLY"),
						"raw replaced assistant text never resurrects in subsequent request",
					);
					assert.ok(
						!allText.includes("INITIAL_RAW_CUSTOM_PAYLOAD"),
						"omitted raw custom text never resurrects in subsequent request",
					);

					// 4. Active rules still projected in fallback timeline
					assert.ok(
						allText.includes("REVIEW_MODE_ACTIVE_RULE"),
						"timeline projects active mode rule on fallback subsequent request",
					);

					// 5. Tools still gated
					const streamToolNames = getCurrentTools(subsequentCtx.messages).map((t) => t.name);
					assert.ok(
						!streamToolNames.includes("fake_write"),
						"fake_write remains gated off during subsequent request",
					);
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"5. real Pi 0.87 turn_end boundary context edits: active mode with turn_end edit projected into next provider request",
		async () => {
			const env = setupHermeticProject();
			try {
				let capturedMessageEntryId: string | undefined;

				const harness = await createInstructionAgentHarness({
					cwd: env.cwd,
					native: true,
					extensionFactories: [
						(pi) => {
							pi.on("turn_end", async (event) => {
								if (event.messageEntryId && !capturedMessageEntryId) {
									capturedMessageEntryId = event.messageEntryId;
									return {
										entries: [
											{
												type: "context_edit",
												targetId: capturedMessageEntryId,
												replacement: {
													content: [{ type: "text", text: "REPLACED_VIA_TURN_END_BOUNDARY" }],
												},
											},
										],
									};
								}
							});
						},
					],
				});

				try {
					// Activate instruction mode
					await harness.prompt("/instruction use review");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write gated after mode activation");

					harness.setResponses(["Original assistant turn 1 to be replaced", "Second turn assistant reply"]);
					await harness.prompt("First turn prompt");

					assert.ok(capturedMessageEntryId, "turn_end must observe messageEntryId");

					// Verify context_edit entry was appended to the session manager
					const entries = harness.manager.getEntries();
					const editEntry = entries.find((e) => e.type === "context_edit");
					assert.ok(editEntry, "context_edit entry must be present in SessionManager after turn_end");
					assert.equal((editEntry as { targetId?: string }).targetId, capturedMessageEntryId);

					// Second turn: prompt again and check actual subsequent provider request
					await harness.prompt("Second turn prompt");

					assert.equal(harness.streamContexts.length, 2, "two provider turns recorded");
					const subsequentCtx = harness.streamContexts[1];

					// Assert leading System includes compiled base, exactly one occurrence, mode updates after head
					assertLeadingSystemAndMode(
						subsequentCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						true,
					);

					// Context edit projection demonstrated in subsequent provider request
					const requestText = subsequentCtx.messages.map(textOf).join("\n");
					assert.ok(
						requestText.includes("REPLACED_VIA_TURN_END_BOUNDARY"),
						"subsequent provider request reflects context edit returned from turn_end",
					);
					assert.ok(
						!requestText.includes("Original assistant turn 1 to be replaced"),
						"original assistant response never resurrects in subsequent provider request",
					);

					// Active rule still projected and tools gated
					const fullSysPrompt = getCurrentSystemPrompt(subsequentCtx.messages);
					assert.ok(fullSysPrompt.includes("REVIEW_MODE_ACTIVE_RULE"), "active mode rule is projected");
					const streamTools = getCurrentTools(subsequentCtx.messages).map((t) => t.name);
					assert.ok(!streamTools.includes("fake_write"), "fake_write remains gated off");
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"6. real Pi 0.87 agent_before_settle boundary context edits: active mode with agent_before_settle edit projected into next provider request",
		async () => {
			const env = setupHermeticProject();
			try {
				let capturedAssistantId: string | undefined;

				const harness = await createInstructionAgentHarness({
					cwd: env.cwd,
					native: true,
					extensionFactories: [
						(pi) => {
							pi.on("turn_end", async (event) => {
								if (event.messageEntryId) {
									capturedAssistantId = event.messageEntryId;
								}
							});
							pi.on("agent_before_settle", async () => {
								if (capturedAssistantId) {
									return {
										entries: [
											{
												type: "context_edit",
												targetId: capturedAssistantId,
												replacement: null, // Omit assistant response before settling
											},
										],
									};
								}
							});
						},
					],
				});

				try {
					// Activate instruction mode
					await harness.prompt("/instruction use review");
					assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write gated after mode activation");

					harness.setResponses([
						"Assistant response to be omitted before settle",
						"Second turn response after settle",
					]);
					await harness.prompt("Prompt to test agent_before_settle");

					// Verify context_edit entry was appended before agent settlement
					const entries = harness.manager.getEntries();
					const editEntry = entries.find((e) => e.type === "context_edit");
					assert.ok(editEntry, "context_edit entry must be present after agent_before_settle");
					assert.equal((editEntry as { targetId?: string }).targetId, capturedAssistantId);
					assert.equal((editEntry as { replacement?: unknown }).replacement, null);

					// Subsequent prompt triggers next provider request demonstrating omission projection
					await harness.prompt("Second turn prompt after settle");

					assert.equal(harness.streamContexts.length, 2, "two provider turns recorded");
					const subsequentCtx = harness.streamContexts[1];

					// Assert leading System includes compiled base, exactly one occurrence, mode updates after head
					assertLeadingSystemAndMode(
						subsequentCtx.messages,
						"Base preset system block for pi087",
						"REVIEW_MODE_ACTIVE_RULE",
						true,
					);

					const requestText = subsequentCtx.messages.map(textOf).join("\n");
					assert.ok(
						!requestText.includes("Assistant response to be omitted before settle"),
						"omitted message must not appear in subsequent provider request after settlement",
					);

					// Active rule still projected and tools gated
					const fullSysPrompt = getCurrentSystemPrompt(subsequentCtx.messages);
					assert.ok(fullSysPrompt.includes("REVIEW_MODE_ACTIVE_RULE"), "active mode rule is projected");
					const streamTools = getCurrentTools(subsequentCtx.messages).map((t) => t.name);
					assert.ok(!streamTools.includes("fake_write"), "fake_write remains gated off");
				} finally {
					await harness.dispose();
				}
			} finally {
				env.cleanup();
			}
		},
	);
});

test("Pi0.87 actionable continuations preserve the compiled preset across low-level runs", async suite => {
	for (const boundary of ["turn_end", "agent_before_settle"] as const) {
		for (const native of [true, false]) {
			await suite.test(`${boundary} continue (${native ? "native" : "fallback"})`, async () => {
				const env = setupHermeticProject();
				let continued = false;
				const harness = await createInstructionAgentHarness({ cwd: env.cwd, native, extensionFactories: [pi => {
					const continueOnce = async (event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) => {
						if (continued) return;
						continued = true;
						const reply = ctx.sessionManager.getBranch().slice().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
						assert.ok(reply);
						return { entries: [...event.entries, { type: "context_edit" as const, targetId: reply.id, replacement: { content: "CANONICAL_BOUNDARY_REPLY" } }, { type: "custom_message" as const, customType: "boundary-followup", content: "BOUNDARY_FOLLOWUP_INPUT", display: false }], continue: true };
					};
					if (boundary === "turn_end") pi.on("turn_end", continueOnce);
					else pi.on("agent_before_settle", continueOnce);
				}] });
				try {
					await harness.prompt("/instruction use review");
					harness.setResponses(["RAW_BOUNDARY_REPLY", "FINISHED_BOUNDARY_CONTINUATION"]);
					await harness.prompt("One user turn with an explicit extension continuation");
					assert.equal(harness.beforeAgentStartEvents.length, 1, "this is a continuation, not a second user prompt");
					assert.equal(harness.streamContexts.length, 2, "one intentional boundary continuation");
					for (const context of harness.streamContexts) {
						assertLeadingSystemAndMode(context.messages, "Base preset system block for pi087", "REVIEW_MODE_ACTIVE_RULE", native);
						assert.ok(!getCurrentTools(context.messages).some(tool => tool.name === "fake_write"));
					}
					const lastText = harness.streamContexts[1].messages.map(textOf).join("\n");
					assert.ok(lastText.includes("CANONICAL_BOUNDARY_REPLY"));
					assert.ok(!lastText.includes("RAW_BOUNDARY_REPLY"));
					assert.equal(harness.fetchAttempts, 0);
				} finally { await harness.dispose(); env.cleanup(); }
			});
		}
	}
});

test("Pi0.87 automatic retry retains Preset and pending rules while omitting the abandoned attempt", async suite => {
	for (const native of [true, false]) {
		await suite.test(native ? "native" : "fallback", async () => {
			const env = setupHermeticProject();
			const harness = await createInstructionAgentHarness({ cwd: env.cwd, native });
			try {
				harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 20, provider: { maxRetries: 0 } } });
				await harness.prompt("/instruction use review");
				harness.setResponses([
					async () => {
						await harness.prompt("/instruction add RETRY_PENDING_RULE");
						return { text: "ABANDONED_ATTEMPT_TEXT", stopReason: "error", errorMessage: "503 Service Unavailable" };
					},
					"RETRY_SUCCEEDED",
				]);
				await harness.prompt("One user prompt with a retryable provider error");
				assert.equal(harness.beforeAgentStartEvents.length, 1);
				assert.equal(harness.streamContexts.length, 2, "one real SDK retry, no unscripted requests");
				assert.ok(harness.observedEvents.some(event => event.type === "auto_retry_start"));
				assert.ok(harness.observedEvents.some(event => event.type === "auto_retry_end" && event.success));
				const last = harness.streamContexts[1].messages;
				assertLeadingSystemAndMode(last, "Base preset system block for pi087", "REVIEW_MODE_ACTIVE_RULE", native);
				assert.ok(!JSON.stringify(last).includes("ABANDONED_ATTEMPT_TEXT"));
				assert.ok(JSON.stringify(last).includes("RETRY_PENDING_RULE"), "pending rule survives recovery and is projected on retry");
				assert.ok(!getCurrentTools(last).some(tool => tool.name === "fake_write"));
				const entries = harness.manager.getEntries();
				assert.ok(entries.some(entry => entry.type === "message" && textOf(entry.message).includes("ABANDONED_ATTEMPT_TEXT")), "raw failed attempt remains in history");
				assert.ok(entries.some(entry => entry.type === "context_edit" && entry.replacement === null), "SDK persists the recovery omission");
				assert.equal(harness.fetchAttempts, 0);
			} finally { await harness.dispose(); env.cleanup(); }
		});
	}
});
