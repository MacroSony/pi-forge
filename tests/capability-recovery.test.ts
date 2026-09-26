import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 1. Harness imported first so fetch guard is installed immediately
import { createCapabilityAgentHarness, DEFAULT_INITIAL_TOOLS } from "./helpers/capability-agent-harness.ts";

// 2. Dynamic imports after fetch guard is active
const { initTheme, SessionManager } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { readCapabilitySession } = await import("../src/session-adapter.ts");
const { createCapabilitySnapshot } = await import("../src/capability-events.ts");
const { CAPABILITY_DELIVERY_TYPE, CAPABILITY_EVENT_ENTRY, CAPABILITY_TOOLS_ENTRY } = await import("../src/capability-protocol.ts");

function setupHermeticProject(options?: {
	customMode?: unknown;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-recovery-project-"));
	const sessionDir = join(cwd, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ autoActivate: true }, null, 2),
	);

	const capabilitiesDir = join(cwd, ".pi", "forge", "capabilities");
	mkdirSync(capabilitiesDir, { recursive: true });
	const capability = options?.customMode ?? {
		schemaVersion: 1,
		type: "pi-forge.capability",
		id: "review",
		name: "Review Mode",
		content: "RECOVERY_REVIEW_RULE",
		tools: {
			add: [],
			remove: ["fake_write"],
		},
	};
	writeFileSync(join(capabilitiesDir, "review.json"), JSON.stringify(capability, null, 2));

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

test("legacy capability-session custom types require a new session even without active state", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry("pi-forge-instruction-event", {});
	assert.throws(
		() => readCapabilitySession({ sessionManager: session } as any),
		/legacy pre-capability state|new session/i,
	);
});

test("Capability Recovery Acceptance Suite (serialized disk, compaction, branching, and abort tests)", async (suite) => {
	await suite.test(
		"1. disk persistence flushes raw semantic and cursor-only delivery after assistant turn; SessionManager.open restores active rules; off restores fake_write and executes toolcalls across disk reopens",
		async () => {
			const env = setupHermeticProject();
			const sm1 = SessionManager.create(env.cwd, env.sessionDir);
			const h1 = await createCapabilityAgentHarness({
				cwd: env.cwd,
				sessionManager: sm1,
				native: true,
			});

			let sessionFile = "";
			try {
				// 1.1 Activate capability which removes fake_write
				await h1.prompt("/capability enable review");
				assert.ok(!h1.getActiveToolNames().includes("fake_write"), "fake_write should be gated off in h1");

				// 1.2 Produce assistant message to flush SessionManager entries to disk
				h1.setResponses(["Assistant response ensuring flush to disk"]);
				await h1.prompt("Trigger disk flush");

				const file = sm1.getSessionFile();
				assert.ok(file, "sessionFile must be defined");
				sessionFile = file;

				// Verify file exists on disk and inspect persisted entries
				const content = readFileSync(sessionFile, "utf-8").trim().split("\n");
				const entries = content.map((line) => JSON.parse(line));

				// Check raw semantic entry
				const semanticEntry = entries.find(
					(e) => e.type === "custom" && e.customType === CAPABILITY_EVENT_ENTRY,
				);
				assert.ok(semanticEntry, "session file must contain raw semantic instruction event");
				assert.equal(semanticEntry.data?.op, "activate");
				assert.equal(semanticEntry.data?.snapshot?.content, "RECOVERY_REVIEW_RULE");
				assert.deepEqual(semanticEntry.data?.snapshot?.tools?.remove, ["fake_write"]);

				// Check delivery marker: must be plain custom anchor entry with cursor ONLY (schemaVersion, throughEventId), no rule content or sections
				assert.equal(
					entries.some((e) => e.type === "custom_message" && e.customType === CAPABILITY_DELIVERY_TYPE),
					false,
					"delivery marker must never be persisted as custom_message",
				);
				const deliveryEntry = entries.find(
					(e) => e.type === "custom" && e.customType === CAPABILITY_DELIVERY_TYPE,
				);
				assert.ok(deliveryEntry, "session file must contain plain custom delivery anchor");
				assert.equal(deliveryEntry.data?.schemaVersion, 1);
				assert.equal(typeof deliveryEntry.data?.throughEventId, "string");
				assert.ok(deliveryEntry.data.throughEventId.length > 0);
				assert.equal((deliveryEntry.data as any).content, undefined, "delivery marker must not contain raw rule content");
				assert.equal((deliveryEntry.data as any).sections, undefined, "delivery marker must not contain rendered sections");

				// Check baseline tools record
				const toolsEntry = entries.find(
					(e) => e.type === "custom" && e.customType === CAPABILITY_TOOLS_ENTRY,
				);
				assert.ok(toolsEntry, "session file must contain persisted tool baseline entry");
				assert.deepEqual(toolsEntry.data?.baseline, ["fake_write", "fake_read", "fake_driver"]);
			} finally {
				await h1.dispose();
			}

			// 1.3 Open the same file using real disk SessionManager.open while capability was active
			const sm2 = SessionManager.open(sessionFile, env.sessionDir, env.cwd);
			assert.ok(sm2.getEntries().length > 0, "sm2 must load persisted entries from disk");

			const h2 = await createCapabilityAgentHarness({
				cwd: env.cwd,
				sessionManager: sm2,
				initialTools: ["fake_read", "fake_driver"],
				native: true,
			});

			try {
				// While active, fake_write remains removed
				assert.ok(!h2.getActiveToolNames().includes("fake_write"), "fake_write remains removed in resumed session");

				// Verify that before 'disable', Forge recovered the pristine recorded baseline from disk:
				const cmdCtx2 = (h2.session as any)._extensionRunner.createCommandContext();
				const historyBeforeOff = readCapabilitySession(cmdCtx2);
				assert.deepEqual(
					historyBeforeOff.tools?.baseline,
					["fake_write", "fake_read", "fake_driver"],
					"Forge session history faithfully restored pristine baseline tools from disk",
				);

				// Turn in resumed session verifies active rule is projected into system prompt
				h2.setResponses(["Acknowledged active rule in resumed session"]);
				await h2.prompt("Turn in resumed session");
				assert.equal(h2.streamContexts.length, 1);
				const ctx1 = h2.streamContexts[0];
				assert.ok(
					getCurrentSystemPrompt(ctx1.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt must project active rule on resumed turn",
				);
				const streamTools = getCurrentTools(ctx1.messages).map((t) => t.name);
				assert.ok(!streamTools.includes("fake_write"), "stream tools must not include fake_write");

				// 1.4 Deactivate capability: system prompt no longer contains rule and fake_write is restored
				await h2.prompt("/capability disable review");
				assert.ok(h2.getActiveToolNames().includes("fake_write"), "fake_write restored after off without manual intervention");

				const historyAfterOff = readCapabilitySession(cmdCtx2);
				assert.deepEqual(
					historyAfterOff.tools?.baseline,
					["fake_write", "fake_read", "fake_driver"],
					"baseline preserved pristine after deactivation",
				);

				// fake_write toolcall must truly execute (assert exact 1)
				h2.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "allowed.txt", content: "data" } }] },
					"Write executed successfully.",
				]);
				await h2.prompt("Please write again");
				const writeExecutionsAfterOff = h2.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecutionsAfterOff.length, 1, "fake_write must execute after capability deactivated");

				const lastCtx = h2.streamContexts.at(-1)!;
				assert.ok(
					!getCurrentSystemPrompt(lastCtx.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt must not contain deactivated rule after off",
				);

				assert.equal(h2.fetchAttempts, 0);
			} finally {
				await h2.dispose();
			}

			// 1.5 Second disk reopen: reopen session file from disk after deactivation to verify active state lifecycle
			const sm3 = SessionManager.open(sessionFile, env.sessionDir, env.cwd);
			assert.ok(sm3.getEntries().length > 0, "sm3 must load persisted entries from disk");

			const h3 = await createCapabilityAgentHarness({
				cwd: env.cwd,
				sessionManager: sm3,
				native: true,
			});
			try {
				// Startup state after persisted deactivation: fake_write is active
				assert.ok(
					h3.getActiveToolNames().includes("fake_write"),
					"fake_write must be active on startup when session is reopened after deactivation",
				);

				const cmdCtx3 = (h3.session as any)._extensionRunner.createCommandContext();
				const historyReopened = readCapabilitySession(cmdCtx3);
				assert.deepEqual(
					historyReopened.tools?.baseline,
					["fake_write", "fake_read", "fake_driver"],
					"baseline must remain pristine in session reopened after off",
				);

				// Turn in reopened session verifies rule remains absent and fake_write executes
				h3.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "disk-reopened.txt", content: "persisted" } }] },
					"Write in reopened session succeeded.",
				]);
				await h3.prompt("Turn in reopened session after off");
				assert.equal(h3.streamContexts.length, 2);
				const ctxReopened = h3.streamContexts[0];
				assert.ok(
					!getCurrentSystemPrompt(ctxReopened.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt in reopened session must not contain deactivated rule",
				);
				const streamToolsReopened = getCurrentTools(ctxReopened.messages).map((t) => t.name);
				assert.ok(
					streamToolsReopened.includes("fake_write"),
					"stream tools in reopened session must include fake_write",
				);
				const writeExecutions3 = h3.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecutions3.length, 1, "fake_write must execute in session reopened after off");
			} finally {
				await h3.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. manual compact with fake hook returns summary; active checkpoint + retained old marker yields single non-duplicated rule; off prevents resurrection",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createCapabilityAgentHarness({
				cwd: env.cwd,
				native: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (e) => ({
							compaction: {
								summary: "FAKE MANUAL SUMMARY; no summarization inference",
								firstKeptEntryId: e.preparation.firstKeptEntryId,
								tokensBefore: e.preparation.tokensBefore,
							},
						}));
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate review capability
				await h.prompt("/capability enable review");
				h.setResponses(["Turn 1 response"]);
				await h.prompt("Turn 1 prompt");

				// Configure overrides so compact keeps recent tokens and triggers compaction boundary
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				// Turn 2: another turn before compact
				h.setResponses(["Turn 2 response"]);
				await h.prompt("Turn 2 prompt");

				// Manual compact
				const compactResult = await h.session.compact();
				assert.equal(compactResult?.summary, "FAKE MANUAL SUMMARY; no summarization inference");
				assert.equal(compactEvents, 1, "session_compact event must fire once");

				// Turn 3: after compact, rule remains active and is NOT duplicated
				h.setResponses(["Turn 3 post-compact response"]);
				await h.prompt("Turn 3 prompt post-compact");

				const lastCtx = h.streamContexts.at(-1)!;
				const sysPrompt = getCurrentSystemPrompt(lastCtx.messages);
				assert.ok(sysPrompt.includes("RECOVERY_REVIEW_RULE"), "active rule persists across compaction");

				// Verify single occurrence: not duplicated across checkpoint + retained marker
				const matches = sysPrompt.match(/RECOVERY_REVIEW_RULE/g) || [];
				assert.equal(matches.length, 1, "rule content must appear exactly once in system prompt");

				// System messages containing the rule must not be duplicated
				const sysMessagesWithRule = lastCtx.messages.filter(
					(m) => m.role === "system" && JSON.stringify(m).includes("RECOVERY_REVIEW_RULE"),
				);
				assert.equal(sysMessagesWithRule.length, 1, "only one system message carries the rule");

				// Turn 4: turn off review capability after compaction
				await h.prompt("/capability disable review");
				h.setResponses(["Turn 4 response after off"]);
				await h.prompt("Turn 4 prompt");

				const offCtx = h.streamContexts.at(-1)!;
				assert.ok(
					!getCurrentSystemPrompt(offCtx.messages).includes("RECOVERY_REVIEW_RULE"),
					"rule must not resurrect after off",
				);
				assert.ok(h.getActiveToolNames().includes("fake_write"), "fake_write restored after off");

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. compaction performed while capability is already off does not resurrect deactivated rule or gate tools",
		async () => {
			const env = setupHermeticProject();
			let compactEvents = 0;
			const h = await createCapabilityAgentHarness({
				cwd: env.cwd,
				native: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (e) => ({
							compaction: {
								summary: "FAKE INACTIVE COMPACT SUMMARY",
								firstKeptEntryId: e.preparation.firstKeptEntryId,
								tokensBefore: e.preparation.tokensBefore,
							},
						}));
						pi.on("session_compact", () => {
							compactEvents++;
						});
					},
				],
			});

			try {
				// Turn 1: activate capability
				await h.prompt("/capability enable review");
				h.setResponses(["Turn 1 response"]);
				await h.prompt("Turn 1 prompt");

				// Turn 2: deactivate capability
				await h.prompt("/capability disable review");
				h.setResponses(["Turn 2 response"]);
				await h.prompt("Turn 2 prompt");

				// Apply compaction overrides and compact while off
				h.settingsManager.applyOverrides({
					compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				});

				const result = await h.session.compact();
				assert.equal(result?.summary, "FAKE INACTIVE COMPACT SUMMARY");
				assert.equal(compactEvents, 1);

				// Turn 3: after compact, verify capability did NOT resurrect
				h.setResponses(["Turn 3 response"]);
				await h.prompt("Turn 3 prompt");

				const postCompactCtx = h.streamContexts.at(-1)!;
				assert.ok(
					!getCurrentSystemPrompt(postCompactCtx.messages).includes("RECOVERY_REVIEW_RULE"),
					"deactivated capability must not resurrect after compaction",
				);
				assert.ok(h.getActiveToolNames().includes("fake_write"), "fake_write must remain active");

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. tree navigation via session.navigateTree restores correct tools/rules before and after activation; child branch off does not pollute ancestor/sibling branches",
		async () => {
			const env = setupHermeticProject();
			const h = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				// 4.1 Turn 0: pre-activation turn
				h.setResponses(["Pre-activation turn response"]);
				await h.prompt("Pre-activation prompt");
				const preActivationLeaf = h.sessionManager.getLeafId();
				assert.ok(preActivationLeaf, "preActivationLeaf must be defined");
				assert.ok(h.getActiveToolNames().includes("fake_write"), "fake_write active at pre-activation leaf");

				// 4.2 Turn 1: activate review capability
				await h.prompt("/capability enable review");
				h.setResponses(["Active capability turn response"]);
				await h.prompt("Active capability prompt");
				const activeLeaf = h.sessionManager.getLeafId();
				assert.ok(activeLeaf, "activeLeaf must be defined");
				assert.ok(!h.getActiveToolNames().includes("fake_write"), "fake_write removed at activeLeaf");

				// 4.3 Navigate back to preActivationLeaf
				await h.session.navigateTree(preActivationLeaf);
				assert.ok(
					h.getActiveToolNames().includes("fake_write"),
					"fake_write restored when navigating to pre-activation leaf",
				);

				h.setResponses(["Pre-activation continuation"]);
				await h.prompt("Prompt at pre-activation leaf");
				const ctxPre = h.streamContexts.at(-1)!;
				assert.ok(
					!getCurrentSystemPrompt(ctxPre.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt at pre-activation leaf must not have capability rules",
				);

				// 4.4 Navigate back to activeLeaf
				await h.session.navigateTree(activeLeaf);
				assert.ok(
					!h.getActiveToolNames().includes("fake_write"),
					"fake_write removed when navigating back to active leaf",
				);

				h.setResponses(["Active continuation"]);
				await h.prompt("Prompt at active leaf");
				const ctxAct = h.streamContexts.at(-1)!;
				assert.ok(
					getCurrentSystemPrompt(ctxAct.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt at active leaf must contain capability rules",
				);

				// 4.5 In this branch descendant, turn off capability
				await h.prompt("/capability disable review");
				assert.ok(h.getActiveToolNames().includes("fake_write"), "fake_write restored after off in descendant branch");

				// 4.6 Navigate back to activeLeaf (the parent state before off was issued)
				await h.session.navigateTree(activeLeaf);
				assert.ok(
					!h.getActiveToolNames().includes("fake_write"),
					"activeLeaf must retain capability active; descendant off must not pollute parent branch",
				);

				// 4.7 Navigate back to preActivationLeaf
				await h.session.navigateTree(preActivationLeaf);
				assert.ok(
					h.getActiveToolNames().includes("fake_write"),
					"preActivationLeaf remains clean and unpolluted",
				);

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"5. corrupt event or wrong delivery cursor triggers ctx.abort() before faux provider; results in aborted error rather than silent dispatch",
		async () => {
			const env = setupHermeticProject();
			try {
				// 5.1 Wrong cursor in delivery marker
				const smWrongCursor = SessionManager.inMemory();
				smWrongCursor.appendCustomMessageEntry(
					CAPABILITY_DELIVERY_TYPE,
					"bogus marker",
					false,
					{ schemaVersion: 1, throughEventId: "non-existent-cursor-id-8888" },
				);

				let providerCalled1 = false;
				const h1 = await createCapabilityAgentHarness({
					cwd: env.cwd,
					sessionManager: smWrongCursor,
					native: true,
					responses: [
						() => {
							providerCalled1 = true;
							return "must not complete";
						},
					],
				});

				try {
					await h1.prompt("Prompt with wrong delivery cursor");
				} catch {}

				assert.equal(providerCalled1, false, "faux provider must not be called when cursor is invalid");
				assert.equal(h1.streamContexts.length, 0, "no stream contexts captured due to abort");
				const lastAssistant1 = (h1.sessionManager
					.getBranch()
					.filter((e) => e.type === "message" && (e as any).message?.role === "assistant")
					.at(-1) as any)?.message;
				assert.equal(lastAssistant1?.stopReason, "error", "aborted run must label assistant stopReason as error");
				assert.match(String(lastAssistant1?.errorMessage), /abort/i, "error message must indicate abortion");
				await h1.dispose();

				// 5.2 Corrupt event in session history
				const smCorruptEvent = SessionManager.inMemory();
				smCorruptEvent.appendCustomEntry(CAPABILITY_EVENT_ENTRY, {
					schemaVersion: 999, // unsupported schemaVersion
					invalidPayload: true,
				});

				let providerCalled2 = false;
				const h2 = await createCapabilityAgentHarness({
					cwd: env.cwd,
					sessionManager: smCorruptEvent,
					native: true,
					responses: [
						() => {
							providerCalled2 = true;
							return "must not complete";
						},
					],
				});

				try {
					await h2.prompt("Prompt with corrupt event");
				} catch {}

				assert.equal(providerCalled2, false, "faux provider must not be called when event is corrupt");
				assert.equal(h2.streamContexts.length, 0, "no stream contexts captured due to abort");
				const lastAssistant2 = (h2.sessionManager
					.getBranch()
					.filter((e) => e.type === "message" && (e as any).message?.role === "assistant")
					.at(-1) as any)?.message;
				assert.equal(lastAssistant2?.stopReason, "error", "corrupt event must label assistant stopReason as error");
				assert.match(String(lastAssistant2?.errorMessage), /abort/i, "error message must indicate abortion");
				await h2.dispose();
			} finally {
				env.cleanup();
			}
		},
	);

	await suite.test(
		"6. branch stopping directly on semantic activation entry without delivery marker reconstructs and projects active rules",
		async () => {
			const env = setupHermeticProject();
			const sm = SessionManager.inMemory();

			// Construct a semantic activation event directly without appending a delivery marker
			const snapshot = createCapabilitySnapshot({
				activationId: "no-marker-act-id-1234",
				source: { kind: "manual" },
				content: "ACTIVE_RULE_WITHOUT_DELIVERY_MARKER",
				tools: { add: [], remove: ["fake_write"] },
			});

			sm.appendCustomEntry(CAPABILITY_EVENT_ENTRY, {
				schemaVersion: 1,
				eventId: "event-act-no-marker-1",
				op: "activate",
				actor: "user",
				createdAt: Date.now(),
				snapshot,
			});

			const h = await createCapabilityAgentHarness({
				cwd: env.cwd,
				sessionManager: sm,
				native: true,
			});

			try {
				h.setResponses(["Acknowledged response"]);
				await h.prompt("Turn on branch without delivery marker");

				assert.equal(h.streamContexts.length, 1, "prompt must succeed and dispatch to provider");
				const ctx = h.streamContexts[0];
				const sysPrompt = getCurrentSystemPrompt(ctx.messages);
				assert.ok(
					sysPrompt.includes("ACTIVE_RULE_WITHOUT_DELIVERY_MARKER"),
					"projection safety net must deliver active rule even when delivery marker was never emitted",
				);
				const streamTools = getCurrentTools(ctx.messages).map((t) => t.name);
				assert.ok(!streamTools.includes("fake_write"), "fake_write must be gated off");

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"7. crash window: persisted activation event with tools applied but baseline lastApplied truncated/stale preserves baseline and off restores original tools",
		async () => {
			const env = setupHermeticProject();
			const sm = SessionManager.inMemory();

			// 1. Tool baseline recorded before capability effects were applied (lastApplied still old/equal to baseline)
			sm.appendCustomEntry(CAPABILITY_TOOLS_ENTRY, {
				schemaVersion: 1,
				baseline: ["fake_write", "fake_read", "fake_driver"],
				lastApplied: ["fake_write", "fake_read", "fake_driver"],
			});

			// 2. Persisted activation event (review capability removes fake_write)
			const snapshot = createCapabilitySnapshot({
				activationId: "crash-act-1",
				source: { kind: "capability", key: { scope: "project", id: "review" } },
				name: "Review Mode",
				content: "RECOVERY_REVIEW_RULE",
				tools: { add: [], remove: ["fake_write"] },
			});
			sm.appendCustomEntry(CAPABILITY_EVENT_ENTRY, {
				schemaVersion: 1,
				eventId: "event-act-crash-1",
				op: "activate",
				actor: "user",
				createdAt: Date.now(),
				snapshot,
			});

			// 3. Delivery marker cursor
			sm.appendCustomMessageEntry(
				CAPABILITY_DELIVERY_TYPE,
				"Forge instruction state changed. Use /capability status to inspect it.",
				false,
				{ schemaVersion: 1, throughEventId: "event-act-crash-1" },
			);

			// Tools were applied in session before crash: actual active tools is ["fake_read", "fake_driver"]
			const h = await createCapabilityAgentHarness({
				cwd: env.cwd,
				sessionManager: sm,
				initialTools: ["fake_read", "fake_driver"],
				native: true,
			});

			try {
				// While active, fake_write is gated off
				assert.ok(!h.getActiveToolNames().includes("fake_write"), "fake_write remains removed while review capability is active");

				// Tool policy runtime matched actual == desired, so capability effects were not treated as external:
				// baseline remains pristine ["fake_write", "fake_read", "fake_driver"]
				const cmdCtx = (h.session as any)._extensionRunner.createCommandContext();
				const historyBeforeOff = readCapabilitySession(cmdCtx);
				assert.deepEqual(
					historyBeforeOff.tools?.baseline,
					["fake_write", "fake_read", "fake_driver"],
					"baseline must not be corrupted by crash-window mismatch",
				);

				// Turn while active projects rule
				h.setResponses(["Acknowledged turn during crash recovery"]);
				await h.prompt("Turn in crash recovery session");
				assert.equal(h.streamContexts.length, 1);
				const ctx1 = h.streamContexts[0];
				assert.ok(
					getCurrentSystemPrompt(ctx1.messages).includes("RECOVERY_REVIEW_RULE"),
					"system prompt must project active rule",
				);
				const streamTools = getCurrentTools(ctx1.messages).map((t) => t.name);
				assert.ok(!streamTools.includes("fake_write"), "stream tools must not include fake_write");

				// 4. Deactivate capability: must restore original baseline and fake_write
				await h.prompt("/capability disable review");
				assert.ok(h.getActiveToolNames().includes("fake_write"), "fake_write must be restored after off");

				const historyAfterOff = readCapabilitySession(cmdCtx);
				assert.deepEqual(
					historyAfterOff.tools?.baseline,
					["fake_write", "fake_read", "fake_driver"],
					"original baseline must be fully restored after off",
				);

				// Execute tool call to verify fake_write is fully operational (assert exact 1)
				h.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "crash-recovered.txt", content: "ok" } }] },
					"Write executed successfully after crash recovery.",
				]);
				await h.prompt("Execute fake_write after off");
				const writeExecutions = h.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecutions.length, 1, "fake_write must execute successfully after off");

				assert.equal(h.fetchAttempts, 0);
			} finally {
				await h.dispose();
				env.cleanup();
			}
		},
	);
});
