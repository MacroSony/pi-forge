import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstructionSnapshot } from "../src/instruction-events.ts";

// Keep the real SDK harness first: it installs the no-network guard before SDK imports.
import { createInstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";

const { initTheme, SessionManager } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");

const DELIVERY_TYPE = "pi-forge-instruction-delivery";
const EVENT_TYPE = "pi-forge-instruction-event";
const OWNED_CARRIER_TEXT = "Forge instruction state changed. Use /system-update status to inspect it.";

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

function messageContains(message: any, needle: string): boolean {
	return textOf(message).includes(needle) || JSON.stringify(message?.sections ?? {}).includes(needle);
}

function branchOf(harness: any): any[] {
	return harness.manager.getBranch();
}

function assertPlainAnchors(harness: any, expectedCount: number): any[] {
	const owned = branchOf(harness).filter((entry) => entry.customType === DELIVERY_TYPE);
	assert.equal(owned.length, expectedCount, "every delivered instruction event must have one persisted anchor");
	assert.equal(
		branchOf(harness).some((entry) => entry.type === "custom_message" && entry.customType === DELIVERY_TYPE),
		false,
		"the owned delivery type must never be persisted as custom_message",
	);
	assert.ok(owned.every((entry) => entry.type === "custom"), "instruction anchors must be plain custom entries");
	for (const entry of owned) {
		assert.deepEqual(
			entry.data,
			{ schemaVersion: 1, throughEventId: entry.data?.throughEventId },
			"anchor payload is cursor-only metadata",
		);
		assert.equal(typeof entry.data?.throughEventId, "string");
		assert.ok(entry.data.throughEventId.length > 0);
	}
	return owned;
}

function activationEvent(eventId: string, activationId: string, content: string): any {
	return {
		schemaVersion: 1,
		eventId,
		op: "activate",
		actor: "user",
		createdAt: Date.now(),
		snapshot: createInstructionSnapshot({
			activationId,
			source: { kind: "manual" },
			content,
			tools: { add: [], remove: ["fake_write"] },
		}),
	};
}

function appendAnchor(manager: any, throughEventId: string): void {
	manager.appendCustomEntry(DELIVERY_TYPE, { schemaVersion: 1, throughEventId });
}

function isProjectedInstructionMessage(message: any): boolean {
	return messageContains(message, "[pi-forge instruction update]") ||
		Object.keys(message?.sections ?? {}).some((key) => key.startsWith("forge-instruction-"));
}

function projectedInstructionSignature(message: any): string {
	const sections = Object.fromEntries(Object.entries(message?.sections ?? {})
		.filter(([key]) => key.startsWith("forge-instruction-")));
	return Object.keys(sections).length > 0 ? JSON.stringify(sections) : textOf(message);
}

function setupProject(options: { preset?: unknown } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-metadata-agent-"));
	const forgeDir = join(cwd, ".pi", "forge");
	mkdirSync(join(forgeDir, "instruction-modes"), { recursive: true });
	writeFileSync(join(forgeDir, "config.json"), JSON.stringify({ autoActivate: true }));
	writeFileSync(
		join(forgeDir, "instruction-modes", "review.json"),
		JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.instruction-mode",
			id: "review",
			name: "Review Mode",
			content: "METADATA_REVIEW_RULE",
			tools: { add: [], remove: ["fake_write"] },
		}),
	);
	if (options.preset !== undefined) {
		mkdirSync(join(forgeDir, "prompt-stacks"), { recursive: true });
		writeFileSync(join(forgeDir, "prompt-stacks", "active.json"), JSON.stringify(options.preset));
	}
	return {
		cwd,
		cleanup() {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function withHarness<T>(
	env: { cwd: string; cleanup: () => void },
	options: any,
	body: (harness: any) => Promise<T>,
): Promise<T> {
	const harness = await createInstructionAgentHarness({ cwd: env.cwd, ...options });
	try {
		return await body(harness);
	} finally {
		await harness.dispose();
		env.cleanup();
	}
}

test("plain custom metadata anchors: real SDK regression suite", async (suite) => {
	for (const native of [true, false]) {
		await suite.test(`idle updates retain exact conversation/peer order without inference (${native ? "native" : "fallback"})`, async () => {
			const env = setupProject();
			let peerApi: any;
			await withHarness(env, {
				native,
				extensionFactories: [(pi: any) => { peerApi = pi; }],
			}, async (h) => {
				await h.setResponses(["SEED_ASSISTANT_FACT"]);
				await h.prompt("SEED_USER_FACT");
				const callsBeforeCommands = h.streamContexts.length;

				await h.prompt("/system-update use review");
				assert.equal(h.streamContexts.length, callsBeforeCommands, "idle update must not infer");
				await peerApi.sendMessage(
					{ customType: "legitimate-peer", content: "GENUINE_PEER_FACT", display: false },
					{ triggerTurn: false },
				);
				await h.prompt("/system-update off review");
				assert.equal(h.streamContexts.length, callsBeforeCommands, "second idle update must not infer");

				h.setResponses(["AFTER_TWO_UPDATES"]);
				await h.prompt("NEXT_USER_FACT");
				assert.equal(h.streamContexts.length, callsBeforeCommands + 1);
				const messages = h.streamContexts.at(-1)!.messages;
				const ruleIndex = messages.findIndex((message: any) => messageContains(message, "METADATA_REVIEW_RULE"));
				const peerIndex = messages.findIndex((message: any) => messageContains(message, "GENUINE_PEER_FACT"));
				const stopIndex = messages.findIndex((message: any) =>
					messageContains(message, "Removed system prompt section") ||
					(native && Object.entries(message?.sections ?? {}).some(
						([key, value]) => key.startsWith("forge-instruction-") && value === null,
					)),
				);
				assert.ok(ruleIndex >= 0, "activation must be projected into the next request");
				assert.ok(peerIndex >= 0, "legitimate peer content must remain in the request");
				assert.ok(stopIndex >= 0, "deactivation must not lose its stop update");
				assert.ok(ruleIndex < peerIndex, "activation belongs before the peer message");
				assert.ok(peerIndex < stopIndex, "deactivation belongs after the peer message");
				assert.ok(stopIndex < messages.findIndex((message: any) => messageContains(message, "NEXT_USER_FACT")));
				assertPlainAnchors(h, 2);
				assert.equal(h.fetchAttempts, 0);
			});
		});
	}

	await suite.test("running fake_driver toggles defer all anchors until every tool result and preserves every stop", async () => {
		const env = setupProject();
		await withHarness(env, { native: true }, async (h) => {
			let step = 0;
			h.setOnDriver(async () => {
				step++;
				if (step === 1) await h.prompt("/system-update use review");
				else if (step === 2) await h.prompt("/system-update off review");
				else if (step === 3) await h.prompt("/system-update use review");
				else if (step === 4) await h.prompt("/system-update off review");
				return `driver-step-${step}`;
			});
			h.setResponses([
			{ toolCalls: [{ name: "fake_driver", id: "driver-1" }] },
			{ toolCalls: [{ name: "fake_driver", id: "driver-2" }] },
			{ toolCalls: [{ name: "fake_driver", id: "driver-3" }] },
			{ toolCalls: [{ name: "fake_driver", id: "driver-4" }] },
			"ALL_TOOL_RESULTS_COMPLETED",
		]);
			await h.prompt("RUN_MULTIPLE_TOGGLES");
			assert.equal(h.streamContexts.length, 5, "each tool result follow-up is a real provider request");
			assert.ok(h.toolExecutions.filter((execution: any) => execution.name === "fake_driver").length >= 4, "multiple real driver calls must execute");

			for (const context of h.streamContexts.slice(1)) {
				const resultIndexes = context.messages
					.map((message: any, index: number) => message.role === "toolResult" ? index : -1)
					.filter((index: number) => index >= 0);
				const updateIndexes = context.messages
					.map((message: any, index: number) => Object.keys(message.sections ?? {}).some((key) => key.startsWith("forge-instruction-")) ? index : -1)
					.filter((index: number) => index >= 0);
				if (resultIndexes.length > 0) {
					assert.ok(updateIndexes.at(-1)! > Math.max(...resultIndexes), "a running update is inserted only after the complete tool-result batch");
				}
			}
			const allMessages = h.streamContexts.flatMap((context: any) => context.messages);
			const stopMessages = allMessages.filter((message: any) =>
				message.role === "system" && Object.entries(message.sections ?? {}).some(
					([key, value]) => key.startsWith("forge-instruction-") && value === null,
				),
			);
			assert.equal(new Set(stopMessages.map((message: any) => JSON.stringify(message))).size, 2, "both off events must produce distinct stop updates");
			const resultIds = new Set(allMessages
				.filter((message: any) => message.role === "toolResult")
				.map((message: any) => message.toolCallId));
			assert.ok(resultIds.size >= 4, "every driver call has a real tool result in the captured requests");
			assert.ok(h.getActiveToolNames().includes("fake_write"), "final off restores the real tool selection");
			assertPlainAnchors(h, 4);
			assert.equal(h.fetchAttempts, 0);
		});
	});

	await suite.test("agent_end anchors a final-response command after the assistant and before the next user", async () => {
		const env = setupProject();
		await withHarness(env, { native: true }, async (h) => {
			h.setResponses([
				async () => {
					await h.prompt("/system-update use review");
					return "FINAL_ASSISTANT_RESPONSE_AFTER_COMMAND";
				},
			]);
			await h.prompt("FINAL_USER_BEFORE_COMMAND");
			assert.equal(h.streamContexts.length, 1, "final-response management must not enqueue a second turn");
			const entries = branchOf(h);
			const assistantIndex = entries.findIndex((entry) =>
				entry.type === "message" && entry.message?.role === "assistant" && textOf(entry.message).includes("FINAL_ASSISTANT_RESPONSE_AFTER_COMMAND"),
			);
			assert.ok(assistantIndex >= 0);

			h.setResponses(["NEXT_ASSISTANT_RESPONSE"]);
			await h.prompt("NEXT_USER_AFTER_COMMAND");
			const messages = h.streamContexts.at(-1)!.messages;
			const ruleIndex = messages.findIndex((message: any) => messageContains(message, "METADATA_REVIEW_RULE"));
			const priorAssistantIndex = messages.findIndex((message: any) => messageContains(message, "FINAL_ASSISTANT_RESPONSE_AFTER_COMMAND"));
			const nextUserIndex = messages.findIndex((message: any) => messageContains(message, "NEXT_USER_AFTER_COMMAND"));
			assert.ok(priorAssistantIndex >= 0 && ruleIndex > priorAssistantIndex && ruleIndex < nextUserIndex);
			const anchors = assertPlainAnchors(h, 1);
			const anchorIndexAfter = branchOf(h).findIndex((entry) => entry.id === anchors[0].id);
			assert.ok(anchorIndexAfter > assistantIndex);
			assert.equal(h.fetchAttempts, 0);
		});
	});

	for (const native of [true, false]) {
		await suite.test(`real session.compact excludes metadata and restores active/empty checkpoints (${native ? "native" : "fallback"})`, async () => {
			const env = setupProject();
			let peerApi: any;
			await withHarness(env, {
				native,
				extensionFactories: [(pi: any) => { peerApi = pi; }],
			}, async (h) => {
				await h.prompt("/system-update use review");
				await peerApi.sendMessage(
					{ customType: "legitimate-peer", content: "GENUINE_PEER_FACT", display: false },
					{ triggerTurn: false },
				);
				h.setResponses(["GENUINE_ASSISTANT_FACT"]);
				await h.prompt("GENUINE_USER_REQUIREMENT");
				h.setResponses(["SECOND_ASSISTANT_FACT"]);
				await h.prompt("SECOND_USER_FACT");

				h.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } });
				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => { summarizerRequests.push(structuredClone(context)); return "METADATA_ACTIVE_SUMMARY"; },
					({ context }: any) => { summarizerRequests.push(structuredClone(context)); return "METADATA_PREFIX_SUMMARY"; },
				]);
				const activeCompaction = await h.session.compact();
				assert.ok(activeCompaction?.summary.includes("METADATA_ACTIVE_SUMMARY"), "real summarizer response must be used");
				assert.ok(summarizerRequests.length >= 1);
				const summarized = JSON.stringify(summarizerRequests);
				for (const forbidden of [DELIVERY_TYPE, EVENT_TYPE, OWNED_CARRIER_TEXT, "throughEventId", "METADATA_REVIEW_RULE", "[pi-forge instruction update]"]) {
					assert.equal(summarized.includes(forbidden), false, `summarizer input leaked internal metadata: ${forbidden}`);
				}
				for (const fact of ["GENUINE_USER_REQUIREMENT", "GENUINE_ASSISTANT_FACT", "GENUINE_PEER_FACT"]) {
					assert.ok(summarized.includes(fact), `summarizer input lost real fact ${fact}`);
				}

				h.setResponses(["POST_ACTIVE_COMPACT"]);
				await h.prompt("POST_ACTIVE_COMPACT_USER");
				if (native) {
					assert.ok(getCurrentSystemPrompt(h.streamContexts.at(-1)!.messages).includes("METADATA_REVIEW_RULE"));
				} else {
					assert.ok(h.streamContexts.at(-1)!.messages.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")));
				}
				assert.ok(!h.getActiveToolNames().includes("fake_write"));

				await h.prompt("/system-update off review");
				h.setResponses(["POST_OFF_COMPACT"]);
				await h.prompt("POST_OFF_COMPACT_USER");
				h.setResponses([
					({ context }: any) => { summarizerRequests.push(structuredClone(context)); return "METADATA_EMPTY_SUMMARY"; },
					({ context }: any) => { summarizerRequests.push(structuredClone(context)); return "METADATA_EMPTY_PREFIX"; },
				]);
				const emptyCompaction = await h.session.compact();
				assert.ok(emptyCompaction?.summary.includes("METADATA_EMPTY_SUMMARY"));
				h.setResponses(["POST_EMPTY_COMPACT"]);
				await h.prompt("POST_EMPTY_COMPACT_USER");
				const emptyContext = h.streamContexts.at(-1)!.messages;
				assert.equal(emptyContext.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")), false);
				assert.equal(emptyContext.some((message: any) => messageContains(message, "Removed system prompt section")), false);
				assert.ok(h.getActiveToolNames().includes("fake_write"));
				assertPlainAnchors(h, 2);
				assert.equal(h.fetchAttempts, 0);
			});
		});
	}

	await suite.test("active preset trimming and request regex still locate metadata on a same-run tool follow-up", async () => {
		const env = setupProject({
			preset: {
				schemaVersion: 1,
				type: "pi-forge.prompt-stack",
				id: "active",
				name: "Active Preset",
				autoActivate: true,
				items: [
					{ kind: "block", id: "base", role: "system", content: "REAL_PRESET_BASE" },
					{ kind: "slot", id: "history", slot: "chat-history", options: { maxMessages: 1 } },
					{ kind: "block", id: "tail", role: "user", content: "REAL_PRESET_TAIL" },
				],
				regex: {
					rules: [{ id: "request-redaction", stage: "history", frequency: "request", pattern: "SECRET_TOKEN", flags: "g", replace: "[REDACTED]" }],
				},
			},
		});
		await withHarness(env, { native: true }, async (h) => {
			h.setResponses(["OLD_HISTORY_ASSISTANT"]);
			await h.prompt("OLD_HISTORY_SENTINEL");
			await h.prompt("/system-update use review");
			h.setResponses([
				{ toolCalls: [{ name: "fake_read", id: "followup-read" }] },
				"FOLLOWUP_COMPLETED",
			]);
			await h.prompt("CURRENT SECRET_TOKEN REQUEST");
			assert.equal(h.streamContexts.length, 3, "the same run must include the tool-result follow-up request");
			const firstRequest = h.streamContexts[1].messages;
			const followupRequest = h.streamContexts[2].messages;
			assert.ok(firstRequest.some((message: any) => messageContains(message, "REAL_PRESET_BASE")));
			assert.ok(firstRequest.some((message: any) => messageContains(message, "REAL_PRESET_TAIL")));
			assert.equal(firstRequest.some((message: any) => messageContains(message, "OLD_HISTORY_SENTINEL")), false, "real maxMessages trimming must remove old ordinary history");
			assert.ok(firstRequest.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")));
			assert.ok(followupRequest.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")), "follow-up must not rely on only the first provider call");
			assert.ok(followupRequest.some((message: any) => messageContains(message, "[REDACTED]")), "request regex must run over the follow-up context");
			assert.equal(followupRequest.some((message: any) => messageContains(message, "SECRET_TOKEN")), false);
			assert.equal(followupRequest.filter((message: any) => message.role === "toolResult").length, 1);
			assert.equal(h.toolExecutions.filter((execution: any) => execution.name === "fake_read").length, 1);
			assertPlainAnchors(h, 1);
			assert.equal(h.fetchAttempts, 0);
		});
	});

	await suite.test("disk reopen and public branch navigation preserve plain anchors without cross-branch rule leakage", async () => {
		const env = setupProject();
		const sessionDir = join(env.cwd, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const manager1 = SessionManager.create(env.cwd, sessionDir);
		const h1 = await createInstructionAgentHarness({ cwd: env.cwd, native: true, sessionManager: manager1 });
		let sessionFile = "";
		let cleanLeaf = "";
		let activeLeaf = "";
		try {
			h1.setResponses(["BASELINE_ASSISTANT"]);
			await h1.prompt("BASELINE_USER");
			cleanLeaf = h1.manager.getLeafId()!;
			await h1.prompt("/system-update use review");
			h1.setResponses(["ACTIVE_ASSISTANT"]);
			await h1.prompt("ACTIVE_USER");
			activeLeaf = h1.manager.getLeafId()!;
			sessionFile = h1.manager.getSessionFile()!;
			assert.ok(readFileSync(sessionFile, "utf8").includes(DELIVERY_TYPE));
		} finally {
			await h1.dispose();
		}

		const manager2 = SessionManager.open(sessionFile, sessionDir, env.cwd);
		const h2 = await createInstructionAgentHarness({ cwd: env.cwd, native: true, sessionManager: manager2 });
		try {
			assert.ok(!h2.getActiveToolNames().includes("fake_write"));
			await h2.session.navigateTree(cleanLeaf, { summarize: false });
			assert.ok(h2.getActiveToolNames().includes("fake_write"));
			h2.setResponses(["CLEAN_BRANCH_ASSISTANT"]);
			await h2.prompt("CLEAN_BRANCH_USER");
			assert.equal(h2.streamContexts.at(-1)!.messages.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")), false);
			await h2.session.navigateTree(activeLeaf, { summarize: false });
			assert.ok(!h2.getActiveToolNames().includes("fake_write"));
			h2.setResponses(["RETURNED_ACTIVE_ASSISTANT"]);
			await h2.prompt("RETURNED_ACTIVE_USER");
			assert.ok(h2.streamContexts.at(-1)!.messages.some((message: any) => messageContains(message, "METADATA_REVIEW_RULE")));
			assertPlainAnchors(h2, 1);
			assert.equal(h2.fetchAttempts, 0);
		} finally {
			await h2.dispose();
			env.cleanup();
		}
	});

	await suite.test("a legitimate preceding context rewrite aborts safely at an anchored request and recovers when removed", async () => {
		const env = setupProject();
		let rewrite = true;
		let providerCalls = 0;
		await withHarness(env, {
			native: true,
			beforeForgeExtensionFactories: [(pi: any) => {
				pi.on("context", async (event: any) => rewrite ? {
					// This is a valid public context rewrite, not a malformed extension.
					messages: [...event.messages, { role: "user", content: "LEGITIMATE_PRECEDING_REWRITE", timestamp: Date.now() }],
				} : undefined);
			}],
		}, async (h) => {
			await h.prompt("/system-update use review");
			assertPlainAnchors(h, 1);
			h.setResponses([() => {
				providerCalls++;
				return "MUST_NOT_REACH_PROVIDER";
			}]);
			await h.prompt("ANCHOR_MAPPING_MUST_ABORT");
			assert.equal(providerCalls, 0, "anchored context mismatch must abort before the provider");
			assert.equal(h.streamContexts.length, 0);
			assertPlainAnchors(h, 1);
			const failedAssistant = branchOf(h)
				.filter((entry) => entry.type === "message" && (entry as any).message?.role === "assistant")
				.at(-1) as any;
			assert.equal(failedAssistant?.message?.stopReason, "error");

			rewrite = false;
			let recoveryCalls = 0;
			h.setResponses([() => {
				recoveryCalls++;
				return "RECOVERED_AFTER_REWRITE_REMOVAL";
			}]);
			await h.prompt("RECOVER_AFTER_ABORT");
			assert.equal(recoveryCalls, 1, "removing the rewrite must make the next provider request recover");
			assert.equal(h.streamContexts.length, 1);
			assertPlainAnchors(h, 1);
			assert.equal(h.fetchAttempts, 0);
		});
	});

	await suite.test("the first unanchored event cannot be repaired by agent_end after mapping abort", async () => {
		const env = setupProject();
		const manager = SessionManager.inMemory(env.cwd);
		manager.appendMessage({ role: "user", content: "PUBLIC_BASELINE", timestamp: 10 });
		manager.appendCustomEntry(EVENT_TYPE, activationEvent("event-unanchored-first", "unanchored-first", "UNANCHORED_FIRST_RULE"));
		await withHarness(env, {
			native: true,
			sessionManager: manager,
			beforeForgeExtensionFactories: [(pi: any) => {
				pi.on("context", async (event: any) => ({
					messages: [...event.messages, { role: "user", content: "VALID_PRECEDING_REWRITE", timestamp: Date.now() }],
				}));
			}],
		}, async (h) => {
			let providerCalls = 0;
			h.setResponses([() => {
				providerCalls++;
				return "MUST_NOT_REACH_PROVIDER";
			}]);
			await h.prompt("FIRST_UNANCHORED_MAPPING_FAILURE");
			assert.equal(providerCalls, 0);
			assert.equal(h.streamContexts.length, 0);
			assert.equal(branchOf(h).filter((entry) => entry.customType === DELIVERY_TYPE).length, 0,
				"agent_end must not append a marker after a failed mapping");
			assert.ok(branchOf(h).some((entry) => entry.customType === EVENT_TYPE));
			assert.equal(h.fetchAttempts, 0);
		});
	});

	for (const native of [true, false]) {
		await suite.test(`same-batch driver/read toggles retain every update after all results (${native ? "native" : "fallback"})`, async () => {
			const env = setupProject();
			await withHarness(env, { native }, async (h) => {
				h.setOnDriver(async () => {
					await h.prompt("/system-update use review");
					await h.prompt("/system-update off review");
					await h.prompt("/system-update use review");
					await h.prompt("/system-update off review");
					assertPlainAnchors(h, 0); // All four intents remain pending during this one batch.
					return "FOUR_PENDING_EVENTS";
				});
				h.setResponses([
					{ toolCalls: [
						{ name: "fake_driver", id: "same-batch-driver-1" },
						{ name: "fake_read", id: "same-batch-read-1" },
					] },
					"ALL_SAME_BATCH_RESULTS_COMPLETE",
				]);
				await h.prompt("RUN_SAME_BATCH_TOGGLES");
				assert.equal(h.streamContexts.length, 2);
				assert.ok(h.toolExecutions.some((execution: any) => execution.name === "fake_read"));

				for (const context of h.streamContexts.slice(1)) {
					const resultIndexes = context.messages
						.map((message: any, index: number) => message.role === "toolResult" ? index : -1)
						.filter((index: number) => index >= 0);
					const updateIndexes = context.messages
						.map((message: any, index: number) => isProjectedInstructionMessage(message) ? index : -1)
						.filter((index: number) => index >= 0);
					if (resultIndexes.length > 0) {
						assert.equal(updateIndexes.length, 4);
						assert.ok(updateIndexes.every((index: number) => index > Math.max(...resultIndexes)),
							"each running update must follow every result in its assistant batch");
					}
				}

				const signatures: Set<string> = new Set(h.streamContexts.flatMap((context: any) => context.messages
					.filter((message: any) => isProjectedInstructionMessage(message))
					.map((message: any) => projectedInstructionSignature(message))));
				assert.equal([...signatures].filter((signature) => signature.includes("METADATA_REVIEW_RULE")).length, 2,
					"both activations must remain observable");
				assert.equal([...signatures].filter((signature) => signature.includes("null") || signature.includes("Removed system prompt section")).length, 2,
					"both deactivations must remain observable");
				assertPlainAnchors(h, 4);
				assert.equal(h.fetchAttempts, 0);
			});
		});
	}

	for (const native of [true, false]) {
		await suite.test(`idle crash-window activation is anchored before off, not reduced away (${native ? "native" : "fallback"})`, async () => {
			const env = setupProject();
			const manager = SessionManager.inMemory(env.cwd);
			manager.appendCustomEntry(EVENT_TYPE, activationEvent("event-crash-window", "crash-window", "CRASH_WINDOW_RULE"));
			await withHarness(env, { native, sessionManager: manager }, async (h) => {
				await h.prompt("/system-update off crash-window");
				const anchorsAfterOff = assertPlainAnchors(h, 2);
				assert.deepEqual(anchorsAfterOff.map((entry) => entry.data.throughEventId),
					["event-crash-window", branchOf(h).find((entry) => entry.customType === EVENT_TYPE && (entry as any).data?.op === "deactivate")?.data?.eventId]);
				h.setResponses(["CRASH_WINDOW_RECOVERED"]);
				await h.prompt("AFTER_CRASH_WINDOW");
				const messages = h.streamContexts.at(-1)!.messages;
				const activationIndex = messages.findIndex((message: any) => messageContains(message, "CRASH_WINDOW_RULE") ||
					Object.values(message?.sections ?? {}).includes("CRASH_WINDOW_RULE"));
				const stopIndex = messages.findIndex((message: any) => messageContains(message, "Removed system prompt section") ||
					Object.values(message?.sections ?? {}).some((value) => value === null));
				assert.ok(activationIndex >= 0, "the leftover activation must be projected");
				assert.ok(stopIndex > activationIndex, "the later off must not swallow the stop update");
				assert.equal(h.fetchAttempts, 0);
			});
		});
	}

	await suite.test("an identical replay after an anchored event is deduped without reversing order or aborting forever", async () => {
		const env = setupProject();
		const manager = SessionManager.inMemory(env.cwd);
		const first = activationEvent("event-replay-first", "replay-first", "REPLAY_FIRST_RULE");
		const stop = {
			schemaVersion: 1,
			eventId: "event-replay-stop",
			op: "deactivate",
			actor: "user",
			createdAt: Date.now(),
			activationId: "replay-first",
		};
		const next = activationEvent("event-replay-next", "replay-next", "REPLAY_NEXT_RULE");
		manager.appendCustomEntry(EVENT_TYPE, first);
		appendAnchor(manager, first.eventId);
		manager.appendCustomEntry(EVENT_TYPE, stop);
		appendAnchor(manager, stop.eventId);
		// A storage replay arrives after the already anchored semantic event.
		manager.appendCustomEntry(EVENT_TYPE, structuredClone(stop));
		manager.appendCustomEntry(EVENT_TYPE, next);
		await withHarness(env, { native: true, sessionManager: manager }, async (h) => {
			h.setResponses(["REPLAY_NEXT_PROJECTED", "REPLAY_SECOND_REQUEST"]);
			await h.prompt("AFTER_IDENTICAL_REPLAY");
			await h.prompt("PROVE_NO_PERMANENT_ABORT");
			assert.equal(h.streamContexts.length, 2);
			const anchors = assertPlainAnchors(h, 3);
			assert.deepEqual(anchors.map((entry) => entry.data.throughEventId),
				[first.eventId, stop.eventId, next.eventId]);
			assert.ok(h.streamContexts[0].messages.some((message: any) => messageContains(message, "REPLAY_NEXT_RULE") ||
				Object.values(message?.sections ?? {}).includes("REPLAY_NEXT_RULE")));
			assert.equal(h.fetchAttempts, 0);
		});
	});
	await suite.test("queued legitimate peer messages follow the canonical SDK projection without duplication", async () => {
		const env = setupProject(); let peerApi: any;
		const incomingContexts: any[][] = [];
		await withHarness(env, { native: true,
			beforeForgeExtensionFactories: [(pi: any) => { pi.on("context_with_system", (event: any) => { incomingContexts.push(structuredClone(event.messages)); }); }],
			extensionFactories: [(pi: any) => { peerApi = pi; }] }, async h => {
			await h.prompt("/system-update use review");
			h.setOnDriver(async () => {
				peerApi.sendMessage({customType: "legitimate-peer", content: "QUEUED_PEER_FACT", display: false},
					{deliverAs: "steer", triggerTurn: false});
				await new Promise(resolve => setTimeout(resolve, 25));
				await h.prompt("/system-update add QUEUED_RULE_TWO");
				return "COMPLETE_BATCH";
			});
			h.setResponses([{toolCalls: [{name: "fake_driver", id: "delayed-peer"}]}, "AFTER_PEER"]);
			await h.prompt("Receive a peer during a tool batch");
			assert.equal(h.streamContexts.length, 2, "a legitimate queued peer must not abort the follow-up");
			// Pi 0.87 rebuilds from SessionManager before each request: the queued
			// peer is already present BEFORE Forge, not reconstructed by our mapper.
			assert.equal(incomingContexts[1].filter((m: any) => messageContains(m, "QUEUED_PEER_FACT")).length, 1);
			assert.equal(h.streamContexts[1].messages.filter((m: any) => messageContains(m, "QUEUED_PEER_FACT")).length, 1);
			assert.ok(h.streamContexts[1].messages.some((m: any) => messageContains(m, "QUEUED_RULE_TWO")));
			const persisted = branchOf(h).find((e: any) => e.type === "custom_message" && e.customType === "legitimate-peer");
			const live = h.session.agent.state.messages.find((m: any) => m.role === "custom" && m.customType === "legitimate-peer");
			assert.equal(Date.parse(persisted.timestamp), live.timestamp, "public finalized state reflects the canonical persisted envelope");
			h.setResponses(["NEXT_PEER_TURN"]); await h.prompt("A new natural user turn");
			assert.ok(h.streamContexts[2].messages.some((m: any) => messageContains(m, "QUEUED_PEER_FACT")), "Pi includes the persisted peer at the next user turn");
			assertPlainAnchors(h, 2); assert.equal(h.fetchAttempts, 0);
		});
	});

});
