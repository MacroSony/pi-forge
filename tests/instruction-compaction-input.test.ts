import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");

function setupHermeticProject(options?: {
	customMode?: unknown;
	extraMode?: unknown;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-compaction-input-"));
	const sessionDir = join(cwd, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ autoActivate: true }, null, 2),
	);

	const modesDir = join(cwd, ".pi", "forge", "instruction-modes");
	mkdirSync(modesDir, { recursive: true });
	const mode = options?.customMode ?? {
		schemaVersion: 1,
		type: "pi-forge.instruction-mode",
		id: "review",
		name: "Review Mode",
		content: "RECOVERY_REVIEW_RULE",
		tools: {
			add: [],
			remove: ["fake_write"],
		},
	};
	writeFileSync(join(modesDir, "review.json"), JSON.stringify(mode, null, 2));

	if (options?.extraMode) {
		const extra = options.extraMode as { id: string };
		writeFileSync(join(modesDir, `${extra.id}.json`), JSON.stringify(extra, null, 2));
	}

	return {
		cwd,
		sessionDir,
		cleanup() {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("Characterize real SDK compaction input and postcompact context", async (suite) => {
	await suite.test(
		"1. native active compact: summarizer sees NO carrier, preserves assistant mention but NOT Forge rule body (request-only projection); checkpoint precedes summary in postcompact context",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createInstructionAgentHarness({
				cwd: env.cwd,
				native: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate review mode
				await h.prompt("/system-update use review");
				h.setResponses(["Assistant acknowledges review mode is now active"]);
				await h.prompt("Turn 1 prompt: check my code");

				// Configure compaction overrides: keep minimal tokens to force cut point
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				// Turn 2: another turn before compact
				h.setResponses(["Assistant turn 2 response"]);
				await h.prompt("Turn 2 prompt");

				// Intercept summarizer requests
				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "ACTIVE_COMPACT_DETERMINISTIC_SUMMARY";
					},
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "ACTIVE_COMPACT_TURN_PREFIX_SUMMARY";
					},
				]);

				// Run real SDK compaction (no session_before_compact fake summary injection!)
				const compactResult = await h.session.compact();
				// Immediately reset responses after session.compact() to prevent leftover summarizer scripts
				h.setResponses(["Assistant turn 3 response post-compact"]);

				assert.equal(compactEvents, 1, "session_compact event must fire once");
				assert.ok(compactResult, "compactResult must be defined");
				assert.ok(
					compactResult.summary.includes("ACTIVE_COMPACT_DETERMINISTIC_SUMMARY"),
					"summary contains returned fake summary",
				);
				assert.ok(summarizerRequests.length >= 1, "at least one summarizer request captured");

				// Characterize summarizer input (Call 0: main conversation history summarization)
				const summarizerCtx = summarizerRequests[0];
				const summarizerUserMsg = summarizerCtx.messages.find((m: any) => m.role === "user");
				assert.ok(summarizerUserMsg, "summarizer request must have a user message");
				const promptText = summarizerUserMsg.content[0].text as string;

				// 1. Summarizer DOES NOT see generic carrier
				assert.equal(
					promptText.includes("Forge instruction state changed"),
					false,
					"summarizer input MUST NOT contain internal carrier",
				);

				// 2. Summarizer sees old assistant mention
				assert.ok(
					promptText.includes("Assistant acknowledges review mode is now active"),
					"summarizer sees old assistant mention",
				);

				// 3. Summarizer DOES NOT see Forge rule body (projection is request-only; raw transcript only has generic carrier)
				assert.ok(
					!promptText.includes("RECOVERY_REVIEW_RULE"),
					"summarizer input MUST NOT contain raw Forge rule body",
				);

				// 4. Summarizer system prompt is the standard compaction system prompt
				const summarizerSysMsg = summarizerCtx.messages.find((m: any) => m.role === "system");
				assert.ok(summarizerSysMsg, "summarizer has system message");
				assert.ok(
					summarizerSysMsg.content.includes("You are a context summarization assistant"),
					"summarizer has standard compaction system instructions",
				);

				// Turn 3: prompt after compaction
				await h.prompt("Turn 3 prompt post-compact");

				const postCompactCtx = h.streamContexts.at(-1)!;
				const sysPrompt = getCurrentSystemPrompt(postCompactCtx.messages);

				// Verify rule remains active in system prompt
				assert.ok(
					sysPrompt.includes("RECOVERY_REVIEW_RULE"),
					"active rule persists in system prompt post-compact",
				);
				assert.ok(
					!h.getActiveToolNames().includes("fake_write"),
					"fake_write remains gated off post-compact",
				);

				// Characterize relative positions of checkpoint and summary in provider context:
				// Find checkpoint system message (carries forge-instruction section)
				const checkpointIndex = postCompactCtx.messages.findIndex(
					(m: any) => m.role === "system" && m.sections && Object.keys(m.sections).some((k) => k.startsWith("forge-instruction-")),
				);
				// Find compaction summary message
				const summaryIndex = postCompactCtx.messages.findIndex(
					(m: any) => m.role === "user" && typeof m.content === "object" && JSON.stringify(m.content).includes("ACTIVE_COMPACT_DETERMINISTIC_SUMMARY"),
				);

				assert.ok(checkpointIndex !== -1, "checkpoint system message must exist in provider context");
				assert.ok(summaryIndex !== -1, "compaction summary message must exist in provider context");

				// Checkpoint precedes summary in current projection order:
				// [leadingSystem (0)] -> [checkpoint (1)] -> [summary (2)] -> [retained tail (3)] -> [current (4)]
				assert.ok(
					checkpointIndex < summaryIndex,
					`checkpoint message (index ${checkpointIndex}) precedes summary (index ${summaryIndex}) in provider context`,
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. native on -> off then compact: summarizer sees NO carriers, preserves assistant statements but off command and rule literal are not in transcript; fake summary does not resurrect structural state or affect tools",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createInstructionAgentHarness({
				cwd: env.cwd,
				native: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate review mode
				await h.prompt("/system-update use review");
				h.setResponses(["Turn 1 assistant: mode activated"]);
				await h.prompt("Turn 1 prompt");

				// Turn 2: deactivate review mode
				await h.prompt("/system-update off review");
				h.setResponses(["Turn 2 assistant: mode deactivated"]);
				await h.prompt("Turn 2 prompt");

				// Override compaction settings to force compaction cut
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				// Intercept summarizer requests and supply a deliberately misleading summary
				// claiming that review mode is active
				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FAKE_SUMMARY: The user previously requested review mode, and review mode is currently active and mandatory.";
					},
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FAKE_TURN_PREFIX_SUMMARY";
					},
				]);

				// Real compaction
				const compactResult = await h.session.compact();
				// Immediately reset responses after session.compact()
				h.setResponses(["Turn 3 assistant post-compact response"]);

				assert.equal(compactEvents, 1);
				assert.ok(compactResult?.summary.includes("FAKE_SUMMARY: The user previously requested review mode"));

				// Inspect summarizer input
				const summarizerCtx = summarizerRequests[0];
				const summarizerUserMsg = summarizerCtx.messages.find((m: any) => m.role === "user");
				const promptText = summarizerUserMsg.content[0].text as string;

				// Summarizer DOES NOT see generic carriers
				assert.equal(
					promptText.includes("Forge instruction state changed"),
					false,
					"summarizer input MUST NOT contain internal carriers for on and off transitions",
				);

				// Summarizer saw Turn 1 old assistant mention
				assert.ok(
					promptText.includes("Turn 1 assistant: mode activated"),
					"summarizer saw old assistant statement from Turn 1",
				);

				// Summarizer DID NOT see the off slash command (slash commands handled locally, not in transcript)
				assert.ok(
					!promptText.includes("/system-update off review"),
					"off slash command is handled locally and is NOT in transcript",
				);

				// Summarizer DID NOT see Forge rule body (request-only projection; raw transcript only has generic carriers)
				assert.ok(
					!promptText.includes("RECOVERY_REVIEW_RULE"),
					"summarizer input MUST NOT contain raw Forge rule body",
				);

				// Turn 3: prompt post-compact
				await h.prompt("Turn 3 prompt post-compact");

				const postCompactCtx = h.streamContexts.at(-1)!;
				const sysPrompt = getCurrentSystemPrompt(postCompactCtx.messages);

				// 1. Structural state check: rule did NOT resurrect in system prompt
				assert.ok(
					!sysPrompt.includes("RECOVERY_REVIEW_RULE"),
					"deactivated rule MUST NOT resurrect in system prompt despite fake summary claims (structural state guarantee)",
				);

				// 2. Real tools check: fake_write is restored/active
				assert.ok(
					h.getActiveToolNames().includes("fake_write"),
					"fake_write MUST be restored/active after off (real tool configuration unaffected by fake summary)",
				);

				// 3. No checkpoint message carries the owned rule
				const checkpointWithRule = postCompactCtx.messages.find(
					(m: any) => m.role === "system" && m.sections && Object.values(m.sections).some((v: any) => typeof v === "string" && v.includes("RECOVERY_REVIEW_RULE")),
				);
				assert.equal(checkpointWithRule, undefined, "no checkpoint message carries deactivated rule");

				// 4. Compaction summary STILL contains the fake summary text verbatim in conversation history
				const summaryMsg = postCompactCtx.messages.find(
					(m: any) => m.role === "user" && JSON.stringify(m.content).includes("FAKE_SUMMARY: The user previously requested review mode"),
				);
				assert.ok(
					summaryMsg !== undefined,
					"historical summary persists verbatim in transcript, demonstrating structural separation from active state",
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. fallback active compact: summarizer sees NO carrier, preserves assistant mention but NOT fallback user update or rule body (request-only); fallback checkpoint precedes summary in postcompact context",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createInstructionAgentHarness({
				cwd: env.cwd,
				native: false,
				extensionFactories: [
					(pi) => {
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate review mode in fallback mode
				await h.prompt("/system-update use review");
				h.setResponses(["Assistant acknowledges review mode in fallback"]);
				await h.prompt("Turn 1 prompt: check my code");

				// Configure compaction overrides: minimal tokens to force compaction
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				// Turn 2: prompt before compact
				h.setResponses(["Assistant turn 2 response in fallback"]);
				await h.prompt("Turn 2 prompt");

				// Intercept summarizer requests
				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FALLBACK_ACTIVE_DETERMINISTIC_SUMMARY";
					},
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FALLBACK_ACTIVE_PREFIX_SUMMARY";
					},
				]);

				// Real SDK compaction
				const compactResult = await h.session.compact();
				// Immediately reset responses after session.compact()
				h.setResponses(["Assistant turn 3 response post-compact in fallback"]);

				assert.equal(compactEvents, 1, "session_compact event must fire once");
				assert.ok(compactResult, "compactResult must be defined");
				assert.ok(
					compactResult.summary.includes("FALLBACK_ACTIVE_DETERMINISTIC_SUMMARY"),
					"summary contains returned fake summary",
				);
				assert.ok(summarizerRequests.length >= 1, "at least one summarizer request captured");

				// Characterize summarizer input (Call 0)
				const summarizerCtx = summarizerRequests[0];
				const summarizerUserMsg = summarizerCtx.messages.find((m: any) => m.role === "user");
				assert.ok(summarizerUserMsg, "summarizer request must have a user message");
				const promptText = summarizerUserMsg.content[0].text as string;

				// 1. Generic carrier is NOT in transcript and thus NOT seen by summarizer
				assert.equal(
					promptText.includes("Forge instruction state changed"),
					false,
					"summarizer input MUST NOT contain internal carrier",
				);

				// 2. Old assistant mention is seen by summarizer
				assert.ok(
					promptText.includes("Assistant acknowledges review mode in fallback"),
					"summarizer sees old assistant mention",
				);

				// 3. Forge rule body is NOT in raw transcript and NOT in summarizer input
				assert.ok(
					!promptText.includes("RECOVERY_REVIEW_RULE"),
					"summarizer input MUST NOT contain raw Forge rule body",
				);

				// 4. Fallback user update envelope [pi-forge instruction update] is NOT in raw transcript
				// (proves invisibility is due to request-only projection, not system message filtering!)
				assert.ok(
					!promptText.includes("[pi-forge instruction update]"),
					"summarizer input MUST NOT contain fallback user instruction envelope (proves request-only projection)",
				);

				// Turn 3: prompt after compaction
				await h.prompt("Turn 3 prompt post-compact in fallback");

				const postCompactCtx = h.streamContexts.at(-1)!;

				// Check tool gating: fake_write remains removed
				assert.ok(
					!h.getActiveToolNames().includes("fake_write"),
					"fake_write remains gated off post-compact in fallback mode",
				);

				// In fallback mode, checkpoint message is a user message containing [pi-forge instruction update]
				const checkpointIndex = postCompactCtx.messages.findIndex(
					(m: any) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge instruction update]") &&
						m.content.includes("RECOVERY_REVIEW_RULE"),
				);
				// Compaction summary message
				const summaryIndex = postCompactCtx.messages.findIndex(
					(m: any) =>
						m.role === "user" &&
						typeof m.content === "object" &&
						JSON.stringify(m.content).includes("FALLBACK_ACTIVE_DETERMINISTIC_SUMMARY"),
				);

				assert.ok(checkpointIndex !== -1, "fallback checkpoint user message must exist in provider context");
				assert.ok(summaryIndex !== -1, "compaction summary message must exist in provider context");

				// Checkpoint precedes summary in provider context
				assert.ok(
					checkpointIndex < summaryIndex,
					`fallback checkpoint message (index ${checkpointIndex}) precedes summary (index ${summaryIndex}) in provider context`,
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. fallback on -> off then compact: summarizer sees NO carriers, preserves assistant statements but off command and rule literal are not in transcript; fake summary does not resurrect structural state or affect tools",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createInstructionAgentHarness({
				cwd: env.cwd,
				native: false,
				extensionFactories: [
					(pi) => {
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate review mode in fallback mode
				await h.prompt("/system-update use review");
				h.setResponses(["Turn 1 assistant in fallback: mode activated"]);
				await h.prompt("Turn 1 prompt");

				// Turn 2: deactivate review mode in fallback mode
				await h.prompt("/system-update off review");
				h.setResponses(["Turn 2 assistant in fallback: mode deactivated"]);
				await h.prompt("Turn 2 prompt");

				// Override compaction settings to force cut
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				// Intercept summarizer requests with misleading summary claiming review mode is active
				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FAKE_SUMMARY: The user previously requested review mode, and review mode is currently active and mandatory.";
					},
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "FAKE_TURN_PREFIX_SUMMARY";
					},
				]);

				// Real compaction
				const compactResult = await h.session.compact();
				// Immediately reset responses after session.compact()
				h.setResponses(["Turn 3 assistant post-compact response in fallback"]);

				assert.equal(compactEvents, 1);
				assert.ok(compactResult?.summary.includes("FAKE_SUMMARY: The user previously requested review mode"));

				// Inspect summarizer input
				const summarizerCtx = summarizerRequests[0];
				const summarizerUserMsg = summarizerCtx.messages.find((m: any) => m.role === "user");
				const promptText = summarizerUserMsg.content[0].text as string;

				// Summarizer DOES NOT see generic carriers
				assert.equal(
					promptText.includes("Forge instruction state changed"),
					false,
					"summarizer input MUST NOT contain internal carriers for on and off transitions",
				);

				// Summarizer saw old assistant statement from Turn 1
				assert.ok(
					promptText.includes("Turn 1 assistant in fallback: mode activated"),
					"summarizer saw Turn 1 old assistant statement",
				);

				// Summarizer did NOT see the off slash command
				assert.ok(
					!promptText.includes("/system-update off review"),
					"off slash command is handled locally and is NOT in transcript",
				);

				// Summarizer did NOT see Forge rule body or fallback user update wrapper
				assert.ok(
					!promptText.includes("RECOVERY_REVIEW_RULE"),
					"summarizer input MUST NOT contain raw Forge rule body",
				);
				assert.ok(
					!promptText.includes("[pi-forge instruction update]"),
					"summarizer input MUST NOT contain fallback user instruction envelope",
				);

				// Turn 3: prompt post-compact
				await h.prompt("Turn 3 prompt post-compact in fallback");

				const postCompactCtx = h.streamContexts.at(-1)!;

				// 1. Structural state check: deactivated rule is NOT in any user message or system prompt
				const userUpdateWithRule = postCompactCtx.messages.find(
					(m: any) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge instruction update]") &&
						m.content.includes("RECOVERY_REVIEW_RULE"),
				);
				assert.equal(userUpdateWithRule, undefined, "deactivated rule MUST NOT appear in any instruction update message (structural guarantee)");

				const leadingSystem = postCompactCtx.messages.find((m: any) => m.role === "system");
				assert.ok(leadingSystem, "leading system message must exist");
				assert.ok(
					!String(leadingSystem.content).includes("RECOVERY_REVIEW_RULE"),
					"leading system prompt must not contain deactivated rule",
				);

				// 2. Real tools check: fake_write is restored/active
				assert.ok(
					h.getActiveToolNames().includes("fake_write"),
					"fake_write tool MUST be restored/active after off (real tool configuration unaffected by fake summary)",
				);

				// 3. Historical summary persists verbatim in transcript (structural separation)
				const summaryMsg = postCompactCtx.messages.find(
					(m: any) => m.role === "user" && JSON.stringify(m.content).includes("FAKE_SUMMARY: The user previously requested review mode"),
				);
				assert.ok(
					summaryMsg !== undefined,
					"historical summary persists verbatim in transcript, demonstrating structural separation from active state",
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"5. retaining tail marker (native): pre-compaction marker is stripped and folded into checkpoint preceding summary; post-compaction delta replays after summary",
		async () => {
			const env = setupHermeticProject({
				extraMode: {
					schemaVersion: 1,
					type: "pi-forge.instruction-mode",
					id: "audit",
					name: "Audit Mode",
					content: "AUDIT_TAIL_RULE",
					tools: { add: [], remove: [] },
				},
			});
			let compactEvents = 0;
			const h = await createInstructionAgentHarness({
				cwd: env.cwd,
				native: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: initial baseline turn with enough content to allow cutting between Turn 1 and Turn 2
				h.setResponses(["Turn 1 assistant baseline " + "word ".repeat(50)]);
				await h.prompt("Turn 1 baseline prompt " + "word ".repeat(50));

				// Turn 2: activate review mode before compaction
				await h.prompt("/system-update use review");
				h.setResponses(["Turn 2 assistant with mode active"]);
				await h.prompt("Turn 2 prompt");

				// Cut point keeps Turn 2 in the retained tail (keep recent ~15 tokens)
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 15, reserveTokens: 100 },
				});

				const summarizerRequests: any[] = [];
				h.setResponses([
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "TAIL_MARKER_DETERMINISTIC_SUMMARY";
					},
					({ context }: any) => {
						summarizerRequests.push(structuredClone(context));
						return "TAIL_MARKER_PREFIX_SUMMARY";
					},
				]);

				// Compact
				const compactResult = await h.session.compact();
				// Immediately reset responses after session.compact()
				h.setResponses(["Turn 3 assistant post-compact"]);

				assert.equal(compactEvents, 1);
				assert.ok(compactResult);

				// Turn 3: prompt post-compact
				await h.prompt("Turn 3 prompt post-compact");

				const postCompactCtx = h.streamContexts.at(-1)!;
				const sysPrompt = getCurrentSystemPrompt(postCompactCtx.messages);

				// Rule is active in system prompt
				assert.ok(sysPrompt.includes("RECOVERY_REVIEW_RULE"), "rule active in post-compact prompt");
				assert.ok(!h.getActiveToolNames().includes("fake_write"), "fake_write gated");

				// In postcompact context: find summary message and checkpoint message
				const summaryIndex = postCompactCtx.messages.findIndex(
					(m: any) => m.role === "user" && JSON.stringify(m.content).includes("TAIL_MARKER_DETERMINISTIC_SUMMARY"),
				);
				assert.ok(summaryIndex !== -1, "summary message exists");

				// Because Turn 2's event occurred before the compaction entry in the session branch,
				// readInstructionSession sets checkpointThrough to Turn 2's event.
				// Kept tail marker for Turn 2 is stripped (markerCursor <= checkpointIndex),
				// and its state is consolidated into the checkpoint message.
				const checkpointIndex = postCompactCtx.messages.findIndex(
					(m: any) => m.role === "system" && m.sections && Object.keys(m.sections).some((k) => k.startsWith("forge-instruction-")),
				);
				assert.ok(checkpointIndex !== -1, "checkpoint message exists");
				assert.ok(checkpointIndex < summaryIndex, "checkpoint precedes summary");

				// Now, activate a second mode (audit) AFTER compaction
				await h.prompt("/system-update use audit");
				h.setResponses(["Turn 4 assistant with audit mode"]);
				await h.prompt("Turn 4 prompt");

				const turn4Ctx = h.streamContexts.at(-1)!;
				const summaryIndex4 = turn4Ctx.messages.findIndex(
					(m: any) => m.role === "user" && JSON.stringify(m.content).includes("TAIL_MARKER_DETERMINISTIC_SUMMARY"),
				);
				// The post-compaction delta message for audit mode should appear AFTER the summary
				const auditDeltaIndex = turn4Ctx.messages.findIndex(
					(m: any, idx: number) =>
						idx > summaryIndex4 &&
						m.role === "system" &&
						m.sections &&
						Object.values(m.sections).some((v: any) => typeof v === "string" && v.includes("AUDIT_TAIL_RULE")),
				);
				assert.ok(
					auditDeltaIndex > summaryIndex4,
					`post-compaction activation delta (index ${auditDeltaIndex}) appears AFTER summary (index ${summaryIndex4})`,
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);
});
