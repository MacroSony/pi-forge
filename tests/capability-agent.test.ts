import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 1. Harness imported first so fetch guard is installed immediately
import { createCapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";

// 2. Dynamic imports after fetch guard is active
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { readCapabilitySession } = await import("../src/session-adapter.ts");
const { GLOBAL_FORGE_DIR_ENV } = await import("../src/storage.ts");

function setupHermeticProject(options?: {
	customStack?: unknown;
	customMode?: unknown;
	skipStack?: boolean;
	skipConfig?: boolean;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-agent-project-"));

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
					content: "Base preset system block",
				},
			],
		};
		writeFileSync(join(stackDir, "base.json"), JSON.stringify(stack, null, 2));
	}

	const capabilitiesDir = join(cwd, ".pi", "forge", "capabilities");
	mkdirSync(capabilitiesDir, { recursive: true });
	const capability = options?.customMode ?? {
		schemaVersion: 1,
		type: "pi-forge.capability",
		id: "review",
		name: "Review Mode",
		content: "REVIEW_ONLY",
		tools: {
			add: [],
			remove: ["fake_write"],
		},
	};
	writeFileSync(join(capabilitiesDir, "review.json"), JSON.stringify(capability, null, 2));

	return {
		cwd,
		cleanup() {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("Capability Agent Acceptance Suite (serial to prevent global directory races)", async (suite) => {
	await suite.test(
		"1. idle use command produces no provider request, next prompt reflects capability & tool gate, blocked call has zero fake executions, off restores write",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				// 1.1 Idle /capability enable review should not trigger provider request
				await harness.prompt("/capability enable review");
				assert.equal(harness.streamContexts.length, 0, "idle use command must not trigger provider call");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write should be gated off");

				// 1.2 Next prompt: script LLM deliberately calling blocked tool fake_write
				// This prompt has 2 provider turns: 1 for tool call, 1 for follow-up response
				harness.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "forbidden.txt", content: "hello" } }] },
					"Tool call failed as expected, stopping.",
				]);
				await harness.prompt("Please write something to disk");

				assert.equal(harness.streamContexts.length, 2, "initial tool turn and follow-up turn recorded");
				const ctx1 = harness.streamContexts[0];
				assert.ok(
					getCurrentSystemPrompt(ctx1.messages).includes("REVIEW_ONLY"),
					"system prompt must contain capability content",
				);
				const streamTools = getCurrentTools(ctx1.messages).map((t) => t.name);
				assert.ok(!streamTools.includes("fake_write"), "stream tools must not declare fake_write");

				// Tool call was blocked by policy: fake executions list must NOT contain fake_write
				const writeExecutions = harness.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecutions.length, 0, "blocked tool call must not execute fake_write");

				// 1.3 Off restores fake_write and subsequent execution succeeds
				await harness.prompt("/capability disable review");
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "fake_write restored after off");

				harness.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "allowed.txt", content: "data" } }] },
					"Write executed successfully.",
				]);
				await harness.prompt("Please write again");
				const writeExecutionsAfterOff = harness.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecutionsAfterOff.length, 1, "fake_write must execute after capability deactivated");

				// Plain metadata delivery assertions
				const branch = harness.manager.getBranch();
				assert.equal(
					branch.some((e: any) => e.type === "custom_message" && e.customType === "pi-forge-capability-delivery"),
					false,
					"delivery markers must never be custom_message",
				);
				const anchors = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-forge-capability-delivery");
				assert.equal(anchors.length, 2, "both on and off transitions have plain custom anchors");
				for (const anchor of anchors) {
					assert.equal((anchor as any).data?.schemaVersion, 1);
					assert.equal(typeof (anchor as any).data?.throughEventId, "string");
				}

				assert.equal(harness.fetchAttempts, 0, "no network fetch operations allowed");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. fallback flagfalse contains timeline user instruction activation and stop notice, does not fold into leading system, repeated use/off leaves no residue",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: false });
			try {
				// Turn 1: activate review in fallback capability
				await harness.prompt("/capability enable review");
				harness.setResponses(["Fallback turn 1 acknowledged"]);
				await harness.prompt("Turn 1 prompt");

				assert.equal(harness.streamContexts.length, 1);
				const ctx1 = harness.streamContexts[0];

				// Leading system message must NOT fold in capability content
				const leadingSystem = ctx1.messages.find((m) => m.role === "system");
				assert.ok(leadingSystem, "leading system message must exist");
				assert.ok(
					!String(leadingSystem.content).includes("REVIEW_ONLY"),
					"leading system must not fold in fallback instruction update",
				);

				// Timeline must contain attributed user instruction update
				const userUpdates1 = ctx1.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(userUpdates1.length, 1, "must contain exactly one user instruction update message");
				assert.ok(String(userUpdates1[0].content).includes("REVIEW_ONLY"));

				// Turn 2: deactivate review capability
				await harness.prompt("/capability disable review");
				harness.setResponses(["Fallback turn 2 acknowledged"]);
				await harness.prompt("Turn 2 prompt");

				assert.equal(harness.streamContexts.length, 2);
				const ctx2 = harness.streamContexts[1];
				const userUpdates2 = ctx2.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(userUpdates2.length, 2, "must contain activation and deactivation stop notice");
				assert.ok(
					String(userUpdates2[1].content).includes("Removed system prompt section"),
					"stop notice must indicate section removal",
				);

				// Turn 3: repeat use and off cycle; verify no leftover residue
				await harness.prompt("/capability enable review");
				await harness.prompt("/capability disable review");
				harness.setResponses(["Fallback turn 3 acknowledged"]);
				await harness.prompt("Turn 3 prompt");

				assert.equal(harness.streamContexts.length, 3);
				const ctx3 = harness.streamContexts[2];
				assert.ok(
					!getCurrentSystemPrompt(ctx3.messages).includes("REVIEW_ONLY"),
					"current system prompt must not contain deactivated capability",
				);
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "fake_write must be active");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. mid-run fake_driver triggers session.prompt('/capability enable review') then off, capturing 3 stream contexts and tool gate transitions",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				let driverStep = 0;
				harness.setOnDriver(async () => {
					driverStep++;
					if (driverStep === 1) {
						await harness.session.prompt("/capability enable review");
						return "activated-review-midrun";
					} else if (driverStep === 2) {
						await harness.session.prompt("/capability disable review");
						return "deactivated-review-midrun";
					}
					return "done";
				});

				harness.setResponses([
					// Stream 1: initial run -> triggers fake_driver call 1
					{ toolCalls: [{ name: "fake_driver" }] },
					// Stream 2: post-activation loop -> triggers fake_driver call 2
					{ toolCalls: [{ name: "fake_driver" }] },
					// Stream 3: post-deactivation loop -> finishes run
					"Driver loop completed.",
				]);

				await harness.prompt("Start driver run");
				assert.equal(harness.streamContexts.length, 3, "expected 3 distinct stream contexts during mid-run transitions");

				// Stream 1: initial state (before capability activation)
				const tools1 = getCurrentTools(harness.streamContexts[0].messages).map((t) => t.name);
				assert.ok(tools1.includes("fake_write"), "stream 1 must include fake_write");
				assert.ok(!getCurrentSystemPrompt(harness.streamContexts[0].messages).includes("REVIEW_ONLY"));

				// Stream 2: active review capability
				const tools2 = getCurrentTools(harness.streamContexts[1].messages).map((t) => t.name);
				assert.ok(!tools2.includes("fake_write"), "stream 2 must exclude fake_write");
				assert.ok(getCurrentSystemPrompt(harness.streamContexts[1].messages).includes("REVIEW_ONLY"));

				// Stream 3: review capability turned off
				const tools3 = getCurrentTools(harness.streamContexts[2].messages).map((t) => t.name);
				assert.ok(tools3.includes("fake_write"), "stream 3 must restore fake_write");
				assert.ok(!getCurrentSystemPrompt(harness.streamContexts[2].messages).includes("REVIEW_ONLY"));

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. manual add works without active preset, stacks with capability, and reset cleans both",
		async () => {
			const env = setupHermeticProject({ skipStack: true });
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				// 4.1 Manual add without active preset
				await harness.prompt("/capability add MANUAL_SPECIAL_DIRECTIVE");
				// 4.2 Stacking capability
				await harness.prompt("/capability enable review");

				harness.setResponses(["Both active"]);
				await harness.prompt("Check active stack");

				assert.equal(harness.streamContexts.length, 1);
				const ctx1 = harness.streamContexts[0];
				const promptText1 = getCurrentSystemPrompt(ctx1.messages);
				assert.ok(promptText1.includes("MANUAL_SPECIAL_DIRECTIVE"), "prompt must contain manual directive");
				assert.ok(promptText1.includes("REVIEW_ONLY"), "prompt must contain capability content");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "tool gate from capability must be active");

				// 4.3 Reset clears both manual and capability instructions
				await harness.prompt("/capability reset");
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "tools recomputed after reset");

				harness.setResponses(["After reset"]);
				await harness.prompt("Check after reset");

				assert.equal(harness.streamContexts.length, 2);
				const ctx2 = harness.streamContexts[1];
				const promptText2 = getCurrentSystemPrompt(ctx2.messages);
				assert.ok(!promptText2.includes("MANUAL_SPECIAL_DIRECTIVE"), "manual directive removed after reset");
				assert.ok(!promptText2.includes("REVIEW_ONLY"), "capability content removed after reset");
				const tools2 = getCurrentTools(ctx2.messages).map((t) => t.name);
				assert.ok(tools2.includes("fake_write"), "fake_write active in stream after reset");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"5. source edits on disk do not mutate active snapshot until off/use cycle",
		async () => {
			const env = setupHermeticProject({
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "review",
					content: "ORIGINAL_SNAPSHOT_CONTENT",
					tools: { add: [], remove: ["fake_write"] },
				},
			});
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				await harness.prompt("/capability enable review");

				// Mutate file on disk
				const modePath = join(env.cwd, ".pi", "forge", "capabilities", "review.json");
				writeFileSync(
					modePath,
					JSON.stringify({
						schemaVersion: 1,
						type: "pi-forge.capability",
						id: "review",
						content: "MUTATED_DISK_CONTENT",
						tools: { add: [], remove: ["fake_write"] },
					}),
				);

				// Prompt 1: active snapshot must remain unchanged
				harness.setResponses(["Response 1"]);
				await harness.prompt("Turn 1");

				const prompt1 = getCurrentSystemPrompt(harness.streamContexts[0].messages);
				assert.ok(prompt1.includes("ORIGINAL_SNAPSHOT_CONTENT"), "snapshot must retain original content");
				assert.ok(!prompt1.includes("MUTATED_DISK_CONTENT"), "disk mutation must not alter live snapshot");

				// Prompting use review while active issues warning and retains snapshot
				await harness.prompt("/capability enable review");

				// Reload snapshot via off then use
				await harness.prompt("/capability disable review");
				await harness.prompt("/capability enable review");

				// Prompt 2: new snapshot reflects disk changes
				harness.setResponses(["Response 2"]);
				await harness.prompt("Turn 2");

				const prompt2 = getCurrentSystemPrompt(harness.streamContexts[1].messages);
				assert.ok(prompt2.includes("MUTATED_DISK_CONTENT"), "new snapshot must reflect updated file");
				assert.ok(!prompt2.includes("ORIGINAL_SNAPSHOT_CONTENT"), "old snapshot discarded");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"6. unknown or denied add fails without event commit or tool change, invalid local shadows global capability",
		async () => {
			const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-global-test-"));
			const prevGlobalDirEnv = process.env[GLOBAL_FORGE_DIR_ENV];
			process.env[GLOBAL_FORGE_DIR_ENV] = globalForgeDir;

			// Write valid capability in global directory
			const globalModesDir = join(globalForgeDir, "capabilities");
			mkdirSync(globalModesDir, { recursive: true });
			writeFileSync(
				join(globalModesDir, "shadow_target.json"),
				JSON.stringify({
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "shadow_target",
					content: "VALID_GLOBAL_CONTENT",
					tools: { add: [], remove: ["fake_write"] },
				}),
			);

			const env = setupHermeticProject();
			// Write invalid corrupted local capability with same id
			const localModePath = join(env.cwd, ".pi", "forge", "capabilities", "shadow_target.json");
			writeFileSync(localModePath, "{ corrupted local json syntax");

			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				const baselineTools = [...harness.getActiveToolNames()];
				const cmdCtx = (harness.session as any)._extensionRunner.createCommandContext();
				const initialEventCount = readCapabilitySession(cmdCtx).events.length;
				assert.equal(initialEventCount, 0);

				// 6.1 Unknown capability rejected
				await harness.prompt("/capability enable definitely_unknown_mode_9999");
				assert.deepEqual(harness.getActiveToolNames(), baselineTools, "tools unchanged on unknown capability");
				assert.equal(
					readCapabilitySession(cmdCtx).events.length,
					0,
					"no event committed for unknown capability",
				);

				// 6.2 Invalid local shadows global capability without fallback
				await harness.prompt("/capability enable shadow_target");
				assert.deepEqual(harness.getActiveToolNames(), baselineTools, "tools unchanged on shadowed fault");
				assert.equal(
					readCapabilitySession(cmdCtx).events.length,
					0,
					"no event committed when invalid local shadows global",
				);

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
				try {
					rmSync(globalForgeDir, { recursive: true, force: true });
				} catch {}
				if (prevGlobalDirEnv === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
				else process.env[GLOBAL_FORGE_DIR_ENV] = prevGlobalDirEnv;
			}

			// 6.3 Top-level stack policy deny: registered inactive tool cannot be added by capability
			const denyEnv = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "top_deny_stack",
					name: "Top Deny Stack",
					autoActivate: true,
					tools: { deny: ["fake_write"] },
					items: [{ kind: "block", id: "sys1", role: "system", content: "Top deny fake_write block" }],
				},
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "add_write",
					name: "Add Write Mode",
					content: "TRY_ADD_WRITE",
					tools: { add: ["fake_write"], remove: [] },
				},
			});
			const denyHarness = await createCapabilityAgentHarness({
				cwd: denyEnv.cwd,
				native: true,
				initialTools: ["fake_read", "fake_driver"],
			});
			try {
				assert.ok(!denyHarness.getActiveToolNames().includes("fake_write"), "fake_write is registered inactive");
				const baseline = [...denyHarness.getActiveToolNames()];
				const denyCmdCtx = (denyHarness.session as any)._extensionRunner.createCommandContext();

				await denyHarness.prompt("/capability enable add_write");

				assert.deepEqual(denyHarness.getActiveToolNames(), baseline, "no tool change: fake_write remains inactive");
				assert.equal(
					readCapabilitySession(denyCmdCtx).events.length,
					0,
					"no event committed when top policy denies add",
				);
				assert.equal(denyHarness.streamContexts.length, 0, "no provider request on rejected use");
				assert.equal(denyHarness.fetchAttempts, 0);
			} finally {
				await denyHarness.dispose();
				denyEnv.cleanup();
			}
		},
	);

	await suite.test(
		"7. tool-only capability with empty content preserves tool effects without losing effects",
		async () => {
			const env = setupHermeticProject({
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "tool_only",
					name: "Tool Only Mode",
					content: "",
					tools: { add: [], remove: ["fake_write"] },
				},
			});
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				await harness.prompt("/capability enable tool_only");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write removed by tool-only capability");

				harness.setResponses(["Tool-only acknowledged"]);
				await harness.prompt("Check tool list");

				assert.equal(harness.streamContexts.length, 1);
				const streamTools = getCurrentTools(harness.streamContexts[0].messages).map((t) => t.name);
				assert.ok(!streamTools.includes("fake_write"), "stream tools must not contain fake_write");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"8. native -> fallback -> native model switch via session.setModel preserves instruction lifecycle",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				await harness.prompt("/capability enable review");

				// 8.1 Turn 1: native model
				harness.setResponses(["Native response 1"]);
				await harness.prompt("Turn 1 in native");

				assert.equal(harness.streamContexts.length, 1);
				const ctx1 = harness.streamContexts[0];
				const userUpdates1 = ctx1.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(userUpdates1.length, 0, "native model must not project user instruction markers");
				assert.ok(getCurrentSystemPrompt(ctx1.messages).includes("REVIEW_ONLY"), "native prompt has review capability");

				// 8.2 Switch to fallback model via setModel
				assert.ok(harness.session.model, "model must be defined");
				const currentModel = harness.session.model;
				const fallbackModel = {
					...currentModel,
					id: currentModel.id,
					compat: { ...currentModel.compat, supportsMidConvoSystemMessages: false },
				};
				await harness.session.setModel(fallbackModel);

				// Turn 2: fallback model
				harness.setResponses(["Fallback response 2"]);
				await harness.prompt("Turn 2 in fallback");

				assert.equal(harness.streamContexts.length, 2);
				const ctx2 = harness.streamContexts[1];
				const userUpdates2 = ctx2.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.ok(userUpdates2.length >= 1, "fallback model must project timeline user instruction update");

				// 8.3 Switch back to native model via setModel
				const nativeModel = {
					...currentModel,
					id: currentModel.id,
					compat: { ...currentModel.compat, supportsMidConvoSystemMessages: true },
				};
				await harness.session.setModel(nativeModel);

				// Turn 3: native model restored
				harness.setResponses(["Native response 3"]);
				await harness.prompt("Turn 3 in native restored");

				assert.equal(harness.streamContexts.length, 3);
				const ctx3 = harness.streamContexts[2];
				assert.ok(getCurrentSystemPrompt(ctx3.messages).includes("REVIEW_ONLY"), "native prompt restored");
				const streamTools3 = getCurrentTools(ctx3.messages).map((t) => t.name);
				assert.ok(!streamTools3.includes("fake_write"), "tool gate maintained across model switch");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"9. /capability status output accurately presents instruction count, presentation capability, and delivery state",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			const originalLog = console.log;
			const capturedLogs: string[] = [];
			console.log = (...args: unknown[]) => {
				capturedLogs.push(args.map((a) => String(a)).join(" "));
			};
			try {
				// 9.1 Initial status when no instructions active: 0 capability, native label, none delivery, 0 provider requests
				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 0, "status command must not trigger provider call");
				const log1 = capturedLogs[capturedLogs.length - 1] ?? "";
				assert.match(log1, /Capability capabilities: 0;/, "initial status reports 0 capability");
				assert.match(log1, /native system sections;/, "initial status reports native label");
				assert.match(log1, /;\s*none/, "initial delivery state is none");

				// 9.2 Status after capability use: 1 capability, pending next request, 0 provider requests
				await harness.prompt("/capability enable review");
				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 0, "status after use must not trigger provider call");
				const log2 = capturedLogs[capturedLogs.length - 1] ?? "";
				assert.match(log2, /Capability capabilities: 1;/, "reports 1 capability active");
				assert.match(log2, /pending next request/, "delivery state is pending next request before turn");

				// 9.3 Provider prompt: delivery transitions pending next request -> request prepared
				harness.setResponses(["Resp turn 1"]);
				await harness.prompt("Check status after prompt");
				assert.equal(harness.streamContexts.length, 1, "prompt executes exactly 1 provider turn");

				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 1, "status after prompt does not increase provider count");
				const log3 = capturedLogs[capturedLogs.length - 1] ?? "";
				assert.match(log3, /Capability capabilities: 1;/, "reports 1 capability active");
				assert.match(log3, /request prepared \(not a model-obedience or delivery acknowledgment\)/, "transitioned to request prepared");
				assert.match(log3, /native system sections;/, "native label remains under native model");

				// 9.4 Switch to fallback: native -> fallback label
				assert.ok(harness.session.model, "model must be defined");
				const activeModel = harness.session.model;
				const fallbackModel = {
					...activeModel,
					id: activeModel.id,
					compat: { ...activeModel.compat, supportsMidConvoSystemMessages: false },
				};
				await harness.session.setModel(fallbackModel);

				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 1, "status after model switch does not increase provider count");
				const log4 = capturedLogs[capturedLogs.length - 1] ?? "";
				assert.match(log4, /attributed user updates;/, "reports fallback label after model switch");

				// 9.5 Deactivate capability: status reports 0 modes after off
				await harness.prompt("/capability disable review");
				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 1, "status after off does not increase provider count");
				const log5 = capturedLogs[capturedLogs.length - 1] ?? "";
				assert.match(log5, /Capability capabilities: 0;/, "reports 0 capability after off");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				console.log = originalLog;
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"10. multi-capability overlapping tool policies: remove wins globally, tool remains removed until every removing capability is deactivated",
		async () => {
			const env = setupHermeticProject({
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "review",
					content: "REVIEW_ONLY",
					tools: { add: [], remove: ["fake_write"] },
				},
			});

			// Write a second capability that also removes fake_write
			const capabilitiesDir = join(env.cwd, ".pi", "forge", "capabilities");
			writeFileSync(
				join(capabilitiesDir, "audit.json"),
				JSON.stringify({
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "audit",
					content: "AUDIT_MODE",
					tools: { add: [], remove: ["fake_write", "fake_read"] },
				}),
			);

			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				await harness.prompt("/capability enable review");
				await harness.prompt("/capability enable audit");

				// Both active: both fake_write and fake_read removed
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write removed by both");
				assert.ok(!harness.getActiveToolNames().includes("fake_read"), "fake_read removed by audit");

				// Deactivate audit: fake_read restored, but fake_write still removed by review
				await harness.prompt("/capability disable audit");
				assert.ok(harness.getActiveToolNames().includes("fake_read"), "fake_read restored after audit off");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write still removed by review");

				// Deactivate review: fake_write now restored
				await harness.prompt("/capability disable review");
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "fake_write restored after review off");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"11. template selected tool descriptions in midrun capability/remove/off stay in exact sync with real declarations",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					items: [
						{ kind: "block", id: "macro-tools", role: "system", content: "SelectedToolsMacro: {{tools}}" },
						{ kind: "slot", id: "tools-slot", role: "system", slot: "tools", options: { format: "plain" } },
					],
				},
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "remove_write",
					name: "Remove Write Mode",
					content: "NO_WRITE_ALLOWED",
					tools: { add: [], remove: ["fake_write"] },
				},
			});
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				let driverStep = 0;
				harness.setOnDriver(async () => {
					driverStep++;
					if (driverStep === 1) {
						await harness.session.prompt("/capability enable remove_write");
						return "step1-remove-write";
					} else if (driverStep === 2) {
						await harness.session.prompt("/capability disable remove_write");
						return "step2-restore-write";
					}
					return "done";
				});

				harness.setResponses([
					{ toolCalls: [{ name: "fake_driver" }] },
					{ toolCalls: [{ name: "fake_driver" }] },
					"Done.",
				]);

				await harness.prompt("Start midrun tool sync run");
				assert.equal(harness.streamContexts.length, 3, "expected 3 stream turns for midrun transitions");

				// Stream 1: initial baseline
				const tools1 = getCurrentTools(harness.streamContexts[0].messages).map((t) => t.name);
				const sysPrompt1 = getCurrentSystemPrompt(harness.streamContexts[0].messages);
				assert.ok(tools1.includes("fake_write"), "stream 1 decl must include fake_write");
				assert.ok(sysPrompt1.includes("fake_write"), "stream 1 macro {{tools}} must include fake_write");
				assert.match(sysPrompt1, /- fake_write: Use only for isolated harness tests/, "stream 1 tools slot must describe fake_write");

				// Stream 2: midrun capability activated removing fake_write
				const tools2 = getCurrentTools(harness.streamContexts[1].messages).map((t) => t.name);
				const sysPrompt2 = getCurrentSystemPrompt(harness.streamContexts[1].messages);
				assert.ok(!tools2.includes("fake_write"), "stream 2 decl must NOT include fake_write");
				assert.ok(!sysPrompt2.includes("fake_write"), "stream 2 macro {{tools}} and tools slot must NOT include fake_write");
				assert.ok(tools2.includes("fake_read") && tools2.includes("fake_driver"), "stream 2 retains remaining tools");
				assert.ok(sysPrompt2.includes("fake_read") && sysPrompt2.includes("fake_driver"), "stream 2 prompt retains remaining tools");

				// Stream 3: midrun capability deactivated restoring fake_write
				const tools3 = getCurrentTools(harness.streamContexts[2].messages).map((t) => t.name);
				const sysPrompt3 = getCurrentSystemPrompt(harness.streamContexts[2].messages);
				assert.ok(tools3.includes("fake_write"), "stream 3 decl must restore fake_write");
				assert.ok(sysPrompt3.includes("fake_write"), "stream 3 macro {{tools}} must restore fake_write");
				assert.match(sysPrompt3, /- fake_write: Use only for isolated harness tests/, "stream 3 tools slot must restore fake_write description");

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"12. foreign system sections and toolsAdded are preserved across prompt stack compilation and instruction lifecycle",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					items: [{ kind: "block", id: "sys1", role: "system", content: "COMPILED_PRESET_BASE" }],
				},
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "review",
					name: "Review Mode",
					content: "REVIEW_MODE_CONTENT",
					tools: { add: [], remove: ["fake_write"] },
				},
			});
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				// Inject foreign system message with foreign sections and foreign toolsAdded into transcript
				const foreignMsg = {
					role: "system" as const,
					content: "foreign preamble",
					sections: {
						foreign_meta: "foreign_metadata_value",
						custom_telemetry: "custom_telemetry_payload",
					},
					toolsAdded: [{ name: "foreign_tool", description: "foreign tool desc", parameters: {} }],
					timestamp: Date.now(),
				};
				harness.manager.appendMessage(foreignMsg);
				harness.session.refreshContext();

				// Turn 1: activate review capability and verify foreign sections survive preset projection and instruction projection
				await harness.prompt("/capability enable review");
				harness.setResponses(["Turn 1 response"]);
				await harness.prompt("Prompt 1 with foreign sections");

				assert.equal(harness.streamContexts.length, 1);
				const ctx1 = harness.streamContexts[0];
				const leadingSystem1 = ctx1.messages.find((m) => m.role === "system") as any;
				assert.ok(leadingSystem1, "leading system message must exist");
				assert.equal(leadingSystem1.content, "COMPILED_PRESET_BASE", "preset compiles into system content");
				assert.equal(leadingSystem1.sections?.foreign_meta, "foreign_metadata_value", "foreign_meta section preserved");
				assert.equal(leadingSystem1.sections?.custom_telemetry, "custom_telemetry_payload", "custom_telemetry section preserved");
				assert.deepEqual(
					leadingSystem1.toolsAdded,
					[{ name: "foreign_tool", description: "foreign tool desc", parameters: {} }],
					"foreign toolsAdded preserved",
				);

				// Turn 2: deactivate capability and verify foreign sections still preserved
				await harness.prompt("/capability disable review");
				harness.setResponses(["Turn 2 response"]);
				await harness.prompt("Prompt 2 after off");

				assert.equal(harness.streamContexts.length, 2);
				const ctx2 = harness.streamContexts[1];
				const leadingSystem2 = ctx2.messages.find((m) => m.role === "system") as any;
				assert.ok(leadingSystem2, "leading system message must exist in turn 2");
				assert.equal(leadingSystem2.sections?.foreign_meta, "foreign_metadata_value", "foreign_meta preserved after off");
				assert.equal(leadingSystem2.sections?.custom_telemetry, "custom_telemetry_payload", "custom_telemetry preserved after off");
				assert.deepEqual(
					leadingSystem2.toolsAdded,
					[{ name: "foreign_tool", description: "foreign tool desc", parameters: {} }],
					"foreign toolsAdded preserved after off",
				);

				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"13. busy provider response callback adds instruction rule without triggerTurn extra turn; delivered on next human prompt",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
			try {
				let callbackRan = false;
				harness.setResponses([
					// Busy provider response callback: invoke /capability add during active provider call
					async () => {
						callbackRan = true;
						await harness.prompt("/capability add BUSY_RULE");
						// Return final stop response without tool calls
						return "First turn completed without tools.";
					},
					// Response for next human prompt
					"Second turn response acknowledging BUSY_RULE.",
				]);

				// 13.1 First prompt: provider response callback adds BUSY_RULE mid-stream
				await harness.prompt("First human prompt");
				assert.ok(callbackRan, "provider response callback must have executed");

				// Mechanism report:
				// When deliverAs: 'steer' did not specify triggerTurn: false, the agent runtime
				// would treat the queued steering marker as a reason to initiate an extra model
				// turn immediately after the current turn ended (causing 2 provider requests instead
				// of 1). With runtime.sendMarker setting triggerTurn: false, the management update
				// never starts extra inference, keeping provider call count strictly at 1.
				assert.equal(
					harness.streamContexts.length,
					1,
					"provider total calls must be exactly 1; no unwanted extra turn triggered during busy callback",
				);
				const sysPrompt1 = getCurrentSystemPrompt(harness.streamContexts[0].messages);
				assert.ok(
					!sysPrompt1.includes("BUSY_RULE"),
					"turn 1 stream context must not include BUSY_RULE since it was added mid-response",
				);

				// 13.2 Next human prompt: now the queued rule is delivered to the model
				await harness.prompt("Second human prompt");
				assert.equal(
					harness.streamContexts.length,
					2,
					"next human prompt triggers exactly the second provider request",
				);
				const sysPrompt2 = getCurrentSystemPrompt(harness.streamContexts[1].messages);
				assert.ok(
					sysPrompt2.includes("BUSY_RULE"),
					"turn 2 stream context must include BUSY_RULE on the natural human prompt turn",
				);

				assert.equal(harness.fetchAttempts, 0, "no network fetch operations allowed");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"14. fallback capability midrun two fake_drivers use/off review: ctx2 has attributed activation, ctx3 has instance stop notice and restored write tools via semantic safety tail",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: false });
			try {
				let driverStep = 0;
				harness.setOnDriver(async () => {
					driverStep++;
					if (driverStep === 1) {
						await harness.session.prompt("/capability enable review");
						return "step1-use-review";
					} else if (driverStep === 2) {
						await harness.session.prompt("/capability disable review");
						return "step2-off-review";
					}
					return "done";
				});

				harness.setResponses([
					// Stream 1: initial request -> triggers fake_driver call 1 (use review)
					{ toolCalls: [{ name: "fake_driver" }] },
					// Stream 2: tool followup 1 -> triggers fake_driver call 2 (off review)
					{ toolCalls: [{ name: "fake_driver" }] },
					// Stream 3: tool followup 2 -> terminates run without tools
					"Driver loop completed.",
				]);

				await harness.prompt("Start driver run in fallback capability");

				// 14.1 Exactly 3 stream contexts captured during the same single prompt run
				assert.equal(
					harness.streamContexts.length,
					3,
					"expected exactly 3 distinct stream contexts during midrun transitions in single run",
				);
				const ctx1 = harness.streamContexts[0];
				const ctx2 = harness.streamContexts[1];
				const ctx3 = harness.streamContexts[2];

				// Stream 1: initial baseline before review activation
				const tools1 = getCurrentTools(ctx1.messages).map((t) => t.name);
				assert.ok(tools1.includes("fake_write"), "stream 1 must include fake_write");
				const updates1 = ctx1.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(updates1.length, 0, "stream 1 must have no instruction updates");

				// Stream 2: post-activation followup
				// - Gated tools: fake_write removed
				// - Messages: must contain attributed user instruction activation with REVIEW_ONLY
				// - Leading system must not fold fallback capability content
				const tools2 = getCurrentTools(ctx2.messages).map((t) => t.name);
				assert.ok(!tools2.includes("fake_write"), "stream 2 must exclude fake_write due to review capability");
				const leadingSystem2 = ctx2.messages.find((m) => m.role === "system");
				assert.ok(leadingSystem2, "leading system message must exist in stream 2");
				assert.ok(
					!String(leadingSystem2.content).includes("REVIEW_ONLY"),
					"leading system must not fold in fallback instruction update",
				);
				const updates2 = ctx2.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(updates2.length, 1, "stream 2 must contain exactly 1 attributed activation");
				assert.ok(
					String(updates2[0].content).includes("Updated system prompt section \"forge-capability-"),
					"stream 2 activation must contain section update header",
				);
				assert.ok(
					String(updates2[0].content).includes("REVIEW_ONLY"),
					"stream 2 activation must include capability content REVIEW_ONLY",
				);

				// Stream 3: post-deactivation followup
				// Mechanism: Even without delivery markers having landed in raw messages,
				// the projector's semantic safety tail replays EACH pending event individually.
				// Therefore, ctx3 must NOT simply clear the rule (net-empty), but MUST explicitly
				// include the instance-specific stop notice corresponding to the activation.
				const tools3 = getCurrentTools(ctx3.messages).map((t) => t.name);
				assert.ok(tools3.includes("fake_write"), "stream 3 must restore fake_write after off");

				const updates3 = ctx3.messages.filter(
					(m) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.equal(
					updates3.length,
					2,
					"stream 3 must contain both activation and instance stop notice from missing-tail replay",
				);

				// Extract activationId from the activation update
				const match = String(updates3[0].content).match(/forge-capability-([0-9a-fA-F-]+)/);
				assert.ok(match, "must extract activationId from stream 3 activation update");
				const activationId = match[1];

				assert.ok(
					String(updates3[1].content).includes(
						`Removed system prompt section "forge-capability-${activationId}"`,
					),
					"stream 3 must contain explicit instance stop notice referencing the specific activationId, not just net-empty rules",
				);

				// 14.2 Active tools restored on harness session
				assert.ok(
					harness.getActiveToolNames().includes("fake_write"),
					"session active tools must restore fake_write",
				);

				// 14.3 Verify actual fake_write tool execution succeeds
				harness.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "resumed.txt", content: "safe write" } }] },
					"Write execution succeeded.",
				]);
				await harness.prompt("Perform write with restored tool");
				const writeExecs = harness.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(
					writeExecs.length,
					1,
					"actual fake_write tool execution must succeed after review capability is turned off",
				);

				assert.equal(harness.fetchAttempts, 0, "no network fetch operations allowed");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);
});
