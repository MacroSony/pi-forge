import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 1. Harness imported first so fetch guard is installed immediately
import { createCapabilityAgentControlHarness } from "./helpers/capability-agent-control-harness.ts";

// 2. Dynamic imports after fetch guard is active
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { readCapabilitySession } = await import("../src/session-adapter.ts");
const { createCapabilityRuntime } = await import("../src/runtime/capability-runtime.ts");
const { createToolPolicyRuntime } = await import("../src/runtime/tool-policy-runtime.ts");
const { ForgeWorkspace } = await import("../src/workspace.ts");
const { FORGE_CAPABILITY_TOOL_NAME } = await import("../src/capability-tool.ts");

function setupHermeticProject(options?: {
	customStack?: unknown;
	customMode?: unknown;
	globalMode?: unknown;
	skipStack?: boolean;
	skipConfig?: boolean;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-agent-ctrl-proj-"));

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
			capabilities: [
				{
					ref: "review",
					id: "review",
					modelCallable: true,
				},
			],
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
		description: "Enforces review-only workflow and disables write tool.",
		content: "REVIEW_ONLY_MODE_ACTIVE",
		tools: {
			add: [],
			remove: ["fake_write"],
		},
	};
	writeFileSync(join(capabilitiesDir, "review.json"), JSON.stringify(capability, null, 2));

	let globalDir: string | undefined;
	if (options?.globalMode) {
		globalDir = mkdtempSync(join(tmpdir(), "pi-forge-agent-ctrl-global-"));
		const gModesDir = join(globalDir, "capabilities");
		mkdirSync(gModesDir, { recursive: true });
		writeFileSync(
			join(gModesDir, "review.json"),
			JSON.stringify(options.globalMode, null, 2),
		);
	}

	return {
		cwd,
		globalDir,
		cleanup: () => {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {
				// best effort
			}
			if (globalDir) {
				try {
					rmSync(globalDir, { recursive: true, force: true });
				} catch {
					// best effort
				}
			}
		},
	};
}

function findLatestToolResult(messages: any[], toolName = "forge_capability") {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "toolResult" || (m.role === "tool" && m.toolName === toolName)) {
			return m;
		}
	}
	return undefined;
}

test("Capability Agent Authorized Control Suite (serial to prevent global directory races)", async (suite) => {
	await suite.test(
		"1. model tool calls in native capability: list, use, status, fake_write rejection by policy, and off restoration",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				assert.ok(
					harness.getActiveToolNames().includes("forge_capability"),
					"forge_capability must be active tool",
				);
				assert.ok(
					harness.getActiveToolNames().includes("fake_write"),
					"fake_write must initially be active",
				);

				// 1.1 Model calls forge_capability action: 'list'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "list" },
							},
						],
					},
					"Modes listed successfully.",
				]);
				await harness.prompt("Please list available instruction modes");

				assert.equal(harness.streamContexts.length, 2, "turn 1: tool call + follow-up response");
				const followUp1 = harness.streamContexts[1];
				const listToolResult = findLatestToolResult(followUp1.messages);
				assert.ok(listToolResult, "toolResult message must be present in follow-up context");
				const listContent = Array.isArray(listToolResult.content)
					? listToolResult.content.map((c: any) => c.text ?? "").join("\n")
					: String(listToolResult.content);
				assert.match(listContent, /id:\s*review/, "list response must include bound review capability");
				assert.doesNotMatch(listContent, /REVIEW_ONLY_MODE_ACTIVE/, "inactive rule bodies must not be copied into ordinary tool history");
				assert.match(listContent, /Enforces review-only workflow/, "list retains the authored capability description");

				// 1.2 Model calls forge_capability action: 'enable', id: 'review'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Mode activated.",
				]);
				await harness.prompt("Please activate review capability");

				// fake_write must now be removed from active tools!
				assert.ok(
					!harness.getActiveToolNames().includes("fake_write"),
					"fake_write must be removed from active tools after capability activation",
				);

				// Check active instruction in session history
				const sessionHistory = readCapabilitySession(harness.session as any);
				assert.equal(sessionHistory.events.length, 1, "exactly 1 instruction event saved");
				const actEvent = sessionHistory.events[0];
				assert.equal(actEvent.op, "activate");
				assert.equal(actEvent.actor, "agent");
				assert.equal((actEvent as any).snapshot?.source?.kind, "capability");
				assert.equal((actEvent as any).snapshot?.source?.binding?.id, "review");

				// 1.3 Model calls forge_capability action: 'status'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "status" },
							},
						],
					},
					"Status checked.",
				]);
				await harness.prompt("Check status");

				const followUp3 = harness.streamContexts[harness.streamContexts.length - 1];
				const statusToolResult = findLatestToolResult(followUp3.messages);
				assert.ok(statusToolResult, "status toolResult must be present");
				const statusContent = Array.isArray(statusToolResult.content)
					? statusToolResult.content.map((c: any) => c.text ?? "").join("\n")
					: String(statusToolResult.content);
				assert.match(statusContent, /Capabilities.*:\s*1/i, "status reports 1 capability active");
				assert.match(statusContent, /agent/i, "status reports agent actor");
				assert.doesNotMatch(statusContent, /REVIEW_ONLY_MODE_ACTIVE/, "status must not duplicate rule bodies into the transcript");

				// 1.4 Next prompt: model attempts to call blocked fake_write
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "fake_write",
								args: { path: "blocked.txt", content: "forbidden" },
							},
						],
					},
					"Write failed as expected.",
				]);
				await harness.prompt("Please write to file");

				const writeExecs = harness.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecs.length, 0, "fake_write must NOT have executed because it was blocked");

				// Verify system prompt in stream context has REVIEW_ONLY_MODE_ACTIVE
				const lastCtx = harness.streamContexts[harness.streamContexts.length - 1];
				assert.ok(
					getCurrentSystemPrompt(lastCtx.messages).includes("REVIEW_ONLY_MODE_ACTIVE"),
					"system prompt must project active capability content",
				);

				// 1.5 Model calls forge_capability action: 'disable', id: 'review'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "disable", id: "review" },
							},
						],
					},
					"Review capability deactivated.",
				]);
				await harness.prompt("Please turn off review capability");

				assert.ok(
					harness.getActiveToolNames().includes("fake_write"),
					"fake_write must be restored after off",
				);

				// 1.6 Model calls fake_write now that it is restored
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "fake_write",
								args: { path: "allowed.txt", content: "restored" },
							},
						],
					},
					"Write succeeded.",
				]);
				await harness.prompt("Write to file again");

				const writeExecsAfterOff = harness.toolExecutions.filter((t) => t.name === "fake_write");
				assert.equal(writeExecsAfterOff.length, 1, "fake_write must execute successfully after off");

				// Delivery anchors check
				const branch = harness.manager.getBranch();
				const anchors = branch.filter(
					(e: any) => e.type === "custom" && e.customType === "pi-forge-capability-delivery",
				);
				assert.equal(anchors.length, 2, "both on and off transitions have plain custom anchors");
				for (const anchor of anchors) {
					assert.equal((anchor as any).data?.schemaVersion, 1);
					assert.equal(typeof (anchor as any).data?.throughEventId, "string");
				}

				const controls = branch.filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "forge_capability");
				assert.ok(controls.length >= 4);
				assert.doesNotMatch(JSON.stringify(controls), /REVIEW_ONLY_MODE_ACTIVE/);
				harness.settingsManager.applyOverrides({compaction:{enabled:false,keepRecentTokens:1,reserveTokens:100}});
				const summaries: any[]=[];
				harness.setResponses([({context}:any)=>{summaries.push(structuredClone(context)); return "CONTROL_HISTORY_SUMMARY";},({context}:any)=>{summaries.push(structuredClone(context));return "CONTROL_PREFIX_SUMMARY";}]);
				await harness.session.compact();
				assert.ok(summaries.length>0, "actual SDK summarizer ran");
				assert.doesNotMatch(JSON.stringify(summaries), /REVIEW_ONLY_MODE_ACTIVE/);

				assert.equal(harness.fetchAttempts, 0, "no network fetch permitted");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. fallback capability same-run on/off: attributed timeline user projection and tool restoration",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: false,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Turn 1: Model calls forge_capability action: 'enable', id: 'review'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Fallback capability activated.",
				]);
				await harness.prompt("Activate review in fallback");

				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write removed");

				// Turn 2: Check context projection in next prompt
				harness.setResponses(["Follow-up turn acknowledged."]);
				await harness.prompt("Next turn after activation");

				const streamCtx = harness.streamContexts[harness.streamContexts.length - 1];
				const attributedMessages = streamCtx.messages.filter(
					(m: any) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]"),
				);
				assert.ok(
					attributedMessages.length >= 1,
					"fallback capability must project attributed user instruction update",
				);
				assert.ok(
					attributedMessages.some((m: any) => m.content.includes("REVIEW_ONLY_MODE_ACTIVE")),
					"attributed update must contain capability content",
				);

				// Turn 3: Model calls forge_capability action: 'disable', id: 'review'
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "disable", id: "review" },
							},
						],
					},
					"Deactivated in fallback.",
				]);
				await harness.prompt("Deactivate review capability");

				assert.ok(
					harness.getActiveToolNames().includes("fake_write"),
					"fake_write restored in fallback",
				);

				// Turn 4: Check stop notice projected
				harness.setResponses(["Turn after off acknowledged."]);
				await harness.prompt("Check stop notice");

				const streamCtxAfterOff = harness.streamContexts[harness.streamContexts.length - 1];
				const stopMessages = streamCtxAfterOff.messages.filter(
					(m: any) =>
						m.role === "user" &&
						typeof m.content === "string" &&
						m.content.includes("[pi-forge capability update]") &&
						m.content.includes("Removed system prompt section"),
				);
				assert.ok(
					stopMessages.length >= 1,
					"fallback capability must project attributed user instruction stop notice",
				);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. trust revocation between calls: agent off is rejected when project becomes untrusted",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Turn 1: Agent uses review capability while trusted
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Mode activated while trusted.",
				]);
				await harness.prompt("Use review capability");

				const historyBefore = readCapabilitySession(harness.session as any);
				assert.equal(historyBefore.events.length, 1);

				// Revoke trust between calls
				harness.settingsManager.isProjectTrusted = () => false;
				(harness.session as any).settingsManager.isProjectTrusted = () => false;

				// In untrusted project, custom tools are stripped from stream context tools
				harness.setResponses(["Untrusted turn acknowledged."]);
				await harness.prompt("Check tools after trust revoked");
				const streamCtx = harness.streamContexts[harness.streamContexts.length - 1];
				const declaredTools = ((streamCtx as any).tools ?? []).map((t: any) => t.name);
				assert.ok(
					!declaredTools.includes("forge_capability"),
					"forge_capability must not be declared to model in untrusted project",
				);

				// Direct tool call with untrusted context rejects
				const tool = (harness.session as any).agent.state.tools.find(
					(t: any) => t.name === "forge_capability",
				);
				const untrustedCtx = {
					isProjectTrusted: () => false,
					cwd: env.cwd,
				};
				await assert.rejects(
					async () => tool.execute("c-trust", { action: "disable", id: "review" }, undefined, undefined, untrustedCtx),
					/trusted/i,
					"tool execution must reject in untrusted project",
				);

				// Capability must STILL be active in session history (not deactivated)
				const historyAfter = readCapabilitySession(harness.session as any);
				assert.equal(
					historyAfter.events.length,
					1,
					"event count must not increase (off was rejected)",
				);

				// Safe recovery: restore trust, human off succeeds
				harness.settingsManager.isProjectTrusted = () => true;
				(harness.session as any).settingsManager.isProjectTrusted = () => true;
				await harness.prompt("/capability disable review");
				const historyRecovered = readCapabilitySession(harness.session as any);
				assert.equal(historyRecovered.events.length, 2, "human recovery succeeds once trust restored");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. modelCallable revocation between calls: agent off is rejected when modelCallable is revoked",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Turn 1: Agent uses review capability while modelCallable is true
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Activated review.",
				]);
				await harness.prompt("Use review capability");

				const historyBefore = readCapabilitySession(harness.session as any);
				assert.equal(historyBefore.events.length, 1);

				// Listing authorization must not become a cached grant for a later off.
				harness.setResponses([
					{ toolCalls: [{ name: "forge_capability", args: { action: "list" } }] },
					"Listed.",
				]);
				await harness.prompt("List authorized modes before revocation");

				// Between calls: rewrite prompt stack on disk with modelCallable: false
				const stackPath = join(env.cwd, ".pi", "forge", "prompt-stacks", "base.json");
				const updatedStack = {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					capabilities: [
						{
							ref: "review",
							id: "review",
							modelCallable: false, // revoked!
						},
					],
					items: [
						{
							kind: "block",
							id: "sys1",
							role: "system",
							content: "Base preset system block",
						},
					],
				};
				writeFileSync(stackPath, JSON.stringify(updatedStack, null, 2));

				// Reload preset so runtime observes the updated stack definition
				await harness.prompt("/preset reload");

				// Turn 2: Agent attempts to call off now that modelCallable is revoked
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "disable", id: "review" },
							},
						],
					},
					"Attempted off after revocation.",
				]);
				await harness.prompt("Turn off review capability");

				const followUp = harness.streamContexts[harness.streamContexts.length - 1];
				const offResult = findLatestToolResult(followUp.messages);
				assert.ok(offResult, "toolResult must be present");
				const contentStr = Array.isArray(offResult.content)
					? offResult.content.map((c: any) => c.text ?? "").join("\n")
					: String(offResult.content);
				assert.match(
					contentStr,
					/modelCallable|authorization/i,
					"off must be rejected when modelCallable is revoked",
				);

				// Verify capability remains active (was not deactivated by agent)
				const historyAfter = readCapabilitySession(harness.session as any);
				assert.equal(historyAfter.events.length, 1, "agent off was rejected, no deactivate event");

				// But human CLI off can still deactivate it for safe recovery!
				await harness.prompt("/capability disable review");
				const historyAfterHuman = readCapabilitySession(harness.session as any);
				assert.equal(historyAfterHuman.events.length, 2, "human off succeeds as recovery");
				assert.equal(historyAfterHuman.events[1].op, "deactivate");
				assert.equal(historyAfterHuman.events[1].actor, "user");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"5. scope, shadowing, and bare ref resolution in Preset",
		async () => {
			const env = setupHermeticProject({
				customMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "review",
					name: "Project Review Mode",
					content: "PROJECT_LOCAL_CONTENT",
					tools: { add: [], remove: ["fake_write"] },
				},
				globalMode: {
					schemaVersion: 1,
					type: "pi-forge.capability",
					id: "review",
					name: "Global Review Mode",
					content: "GLOBAL_CONTENT",
					tools: { add: [], remove: ["fake_write"] },
				},
			});

			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Bare ref "review" in project stack resolves to project capability (project shadows global)
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Shadowed capability activated.",
				]);
				await harness.prompt("Activate review");

				const streamCtx = harness.streamContexts[harness.streamContexts.length - 1];
				const sysPrompt = getCurrentSystemPrompt(streamCtx.messages);
				assert.ok(
					sysPrompt.includes("PROJECT_LOCAL_CONTENT"),
					"project capability must shadow global capability",
				);
				assert.ok(
					!sysPrompt.includes("GLOBAL_CONTENT"),
					"global content must not leak through shadowed project capability",
				);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"6. self-removal rejection: agent activation that removes forge_capability is rejected",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					capabilities: [
						{
							ref: "suicide_mode",
							id: "suicide_mode",
							modelCallable: true,
						},
					],
					items: [
						{
							kind: "block",
							id: "sys1",
							role: "system",
							content: "Base system",
						},
					],
				},
			});

			// Create capability that attempts to remove forge_capability
			const capabilitiesDir = join(env.cwd, ".pi", "forge", "capabilities");
			writeFileSync(
				join(capabilitiesDir, "suicide_mode.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						type: "pi-forge.capability",
						id: "suicide_mode",
						content: "TRYING_TO_REMOVE_CONTROL_TOOL",
						tools: {
							add: [],
							remove: ["forge_capability"],
						},
					},
					null,
					2,
				),
			);

			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "suicide_mode" },
							},
						],
					},
					"Attempted self-removal.",
				]);
				await harness.prompt("Activate suicide capability");

				const followUp = harness.streamContexts[harness.streamContexts.length - 1];
				const toolResult = findLatestToolResult(followUp.messages);
				assert.ok(toolResult, "toolResult must be present");
				const contentStr = Array.isArray(toolResult.content)
					? toolResult.content.map((c: any) => c.text ?? "").join("\n")
					: String(toolResult.content);
				assert.match(
					contentStr,
					/cannot remove control tool/i,
					"self-removal of forge_capability must be rejected",
				);

				// Mode must not be active
				const history = readCapabilitySession(harness.session as any);
				assert.equal(history.events.length, 0, "no activation event recorded");
				assert.ok(
					harness.getActiveToolNames().includes("forge_capability"),
					"control tool remains active",
				);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"7. tool policy and unregistered tool rejection on agent activation",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					tools: {
						deny: ["fake_read"],
					},
					capabilities: [
						{
							ref: "add_unregistered",
							id: "add_unregistered",
							modelCallable: true,
						},
						{
							ref: "add_denied",
							id: "add_denied",
							modelCallable: true,
						},
					],
					items: [{ kind: "block", id: "s1", role: "system", content: "Base system" }],
				},
			});

			const capabilitiesDir = join(env.cwd, ".pi", "forge", "capabilities");
			writeFileSync(
				join(capabilitiesDir, "add_unregistered.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						type: "pi-forge.capability",
						id: "add_unregistered",
						content: "UNREGISTERED_TOOL_CONTENT",
						tools: { add: ["completely_fake_tool_xyz"], remove: [] },
					},
					null,
					2,
				),
			);
			writeFileSync(
				join(capabilitiesDir, "add_denied.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						type: "pi-forge.capability",
						id: "add_denied",
						content: "DENIED_TOOL_CONTENT",
						tools: { add: ["fake_read"], remove: [] },
					},
					null,
					2,
				),
			);

			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// 7.1 Agent tries to activate capability that adds unregistered tool
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "add_unregistered" },
							},
						],
					},
					"Attempted unregistered.",
				]);
				await harness.prompt("Activate unregistered tool capability");

				const followUp1 = harness.streamContexts[harness.streamContexts.length - 1];
				const res1 = findLatestToolResult(followUp1.messages);
				const text1 = Array.isArray(res1.content)
					? res1.content.map((c: any) => c.text ?? "").join("\n")
					: String(res1.content);
				assert.match(text1, /not registered/i, "unregistered tool must be rejected");

				// 7.2 Agent tries to activate capability adding tool denied by preset top policy
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "add_denied" },
							},
						],
					},
					"Attempted denied tool.",
				]);
				await harness.prompt("Activate denied tool capability");

				const followUp2 = harness.streamContexts[harness.streamContexts.length - 1];
				const res2 = findLatestToolResult(followUp2.messages);
				const text2 = Array.isArray(res2.content)
					? res2.content.map((c: any) => c.text ?? "").join("\n")
					: String(res2.content);
				assert.match(text2, /deny|blocked|Cannot activate/i, "denied tool must be rejected");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"8. ownership enforcement: agent cannot deactivate user-owned, manual, or unbound instructions",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// 8.1 Human activates bound capability via CLI enable-bound
				await harness.prompt("/capability enable-bound review");

				const history1 = readCapabilitySession(harness.session as any);
				assert.equal(history1.events.length, 1);
				assert.equal(history1.events[0].actor, "user");
				const userBoundActId = (history1.events[0] as any).snapshot.activationId;

				// Agent tries to call off on user-owned bound capability
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "disable", id: "review" },
							},
						],
					},
					"Attempted off on user capability.",
				]);
				await harness.prompt("Agent tries to turn off user-activated review");

				const followUp1 = harness.streamContexts[harness.streamContexts.length - 1];
				const res1 = findLatestToolResult(followUp1.messages);
				const text1 = Array.isArray(res1.content)
					? res1.content.map((c: any) => c.text ?? "").join("\n")
					: String(res1.content);
				assert.match(text1, /user-owned/i, "agent off on user-owned capability must be rejected");

				// 8.2 Human adds manual instruction
				await harness.prompt("/capability add Human manual rule");
				const history2 = readCapabilitySession(harness.session as any);
				assert.equal(history2.events.length, 2);
				const manualActId = (history2.events[1] as any).snapshot.activationId;

				// Agent tries to turn off manual instruction
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "disable", id: manualActId },
							},
						],
					},
					"Attempted off on manual.",
				]);
				await harness.prompt("Agent tries to turn off manual instruction");

				const followUp2 = harness.streamContexts[harness.streamContexts.length - 1];
				const res2 = findLatestToolResult(followUp2.messages);
				const text2 = Array.isArray(res2.content)
					? res2.content.map((c: any) => c.text ?? "").join("\n")
					: String(res2.content);
				assert.match(text2, /user-owned|manual/i, "agent off on manual must be rejected");

				// 8.3 Human turns off user-bound capability, leaving session clean
				await harness.prompt(`/capability disable ${userBoundActId}`);
				await harness.prompt(`/capability disable ${manualActId}`);

				// 8.4 Agent activates review capability
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Agent activated review.",
				]);
				await harness.prompt("Agent activate review");

				const history3 = readCapabilitySession(harness.session as any);
				const agentAct = history3.events[history3.events.length - 1];
				assert.equal(agentAct.actor, "agent");

				// User repeated use via enable-bound: idempotent, does NOT change actor to user!
				await harness.prompt("/capability enable-bound review");
				const history4 = readCapabilitySession(harness.session as any);
				assert.equal(
					history4.events.length,
					history3.events.length,
					"idempotent enable-bound does not append a new activation event",
				);

				// Human user can turn off agent-activated capability
				await harness.prompt("/capability disable review");
				const history5 = readCapabilitySession(harness.session as any);
				const lastEvent = history5.events[history5.events.length - 1];
				assert.equal(lastEvent.op, "deactivate");
				assert.equal(lastEvent.actor, "user");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"9. repeated use idempotency: multiple agent use calls produce single activation",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Call 1: use review
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"First use done.",
				]);
				await harness.prompt("Use review");

				const history1 = readCapabilitySession(harness.session as any);
				assert.equal(history1.events.length, 1);

				// Call 2: use review again
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Second use done.",
				]);
				await harness.prompt("Use review again");

				const followUp = harness.streamContexts[harness.streamContexts.length - 1];
				const res = findLatestToolResult(followUp.messages);
				const text = Array.isArray(res.content)
					? res.content.map((c: any) => c.text ?? "").join("\n")
					: String(res.content);
				assert.match(text, /already active|idempotent/i, "repeated use must be idempotent");

				const history2 = readCapabilitySession(harness.session as any);
				assert.equal(
					history2.events.length,
					1,
					"repeated use must NOT create duplicate activation events",
				);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"10. no management inference: commands and tool calls do not trigger extra unscripted turns",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Calling status and bindings via CLI does not invoke provider
				await harness.prompt("/capability status");
				assert.equal(harness.streamContexts.length, 0, "status must not invoke provider");

				await harness.prompt("/capability bindings");
				assert.equal(harness.streamContexts.length, 0, "bindings must not invoke provider");

				// Tool call turn executes exactly the scripted turn and follow-up
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "status" },
							},
						],
					},
					"Status confirmed.",
				]);
				await harness.prompt("Agent status check");
				assert.equal(harness.streamContexts.length, 2, "exactly 2 turns: call and answer");
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"11. preset switch deactivates OLD bound items while retaining human unbound modes; same-preset reload does not refresh snapshot",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "preset-one",
					name: "Preset One",
					autoActivate: true,
					capabilities: [
						{
							ref: "review",
							id: "review",
							modelCallable: true,
						},
					],
					items: [{ kind: "block", id: "s1", role: "system", content: "P1 system" }],
				},
			});

			// Also create a second preset preset-two
			const stacksDir = join(env.cwd, ".pi", "forge", "prompt-stacks");
			writeFileSync(
				join(stacksDir, "preset-two.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						type: "pi-forge.prompt-stack",
						id: "preset-two",
						name: "Preset Two",
						capabilities: [],
						items: [{ kind: "block", id: "s2", role: "system", content: "P2 system" }],
					},
					null,
					2,
				),
			);

			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Agent activates bound capability "review" from preset-one
				harness.setResponses([
					{
						toolCalls: [
							{
								name: "forge_capability",
								args: { action: "enable", id: "review" },
							},
						],
					},
					"Activated P1 review.",
				]);
				await harness.prompt("Activate review in P1");

				// Human adds unbound manual instruction
				await harness.prompt("/capability add Human persistent guidance");

				const historyBefore = readCapabilitySession(harness.session as any);
				assert.equal(historyBefore.events.length, 2);

				// Switch to preset-two
				await harness.prompt("/preset use preset-two");

				const historyAfter = readCapabilitySession(harness.session as any);
				// A lifecycle deactivate event should have been appended for the old bound capability "review"
				const deactEvents = historyAfter.events.filter(
					(e) => e.op === "deactivate" && e.actor === "lifecycle",
				);
				assert.equal(
					deactEvents.length,
					1,
					"lifecycle deactivate must be emitted for old preset bound capability",
				);

				// The human manual instruction must remain active!
				// Verify by calling status
				const originalLog = console.log;
				const capturedLogs: string[] = [];
				console.log = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
				try {
					await harness.prompt("/capability status");
					const lastLog = capturedLogs[capturedLogs.length - 1] ?? "";
					assert.match(
						lastLog,
						/Human persistent guidance/,
						"human unbound instruction must be retained after preset switch",
					);
					assert.match(
						lastLog,
						/Capability capabilities: 1;/,
						"only 1 instruction (human manual) remains active",
					);
				} finally {
					console.log = originalLog;
				}

				// Now switch back to preset-one and test same-preset reload
				await harness.prompt("/preset use preset-one");
				// Activate bound capability again
				await harness.prompt("/capability enable-bound review");

				// Modify review capability content on disk
				const capabilitiesDir = join(env.cwd, ".pi", "forge", "capabilities");
				writeFileSync(
					join(capabilitiesDir, "review.json"),
					JSON.stringify(
						{
							schemaVersion: 1,
							type: "pi-forge.capability",
							id: "review",
							content: "MODIFIED_ON_DISK_CONTENT",
							tools: { add: [], remove: ["fake_write"] },
						},
						null,
						2,
					),
				);

				// Reload same preset
				await harness.prompt("/preset reload");

				// Active snapshot must NOT have refreshed: snapshots remain immutable!
				capturedLogs.length = 0;
				console.log = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
				try {
					await harness.prompt("/capability status");
					const lastLog = capturedLogs[capturedLogs.length - 1] ?? "";
					assert.match(
						lastLog,
						/REVIEW_ONLY_MODE_ACTIVE/,
						"original snapshot content must be retained despite disk edits",
					);
					assert.ok(
						!lastLog.includes("MODIFIED_ON_DISK_CONTENT"),
						"snapshot must not refresh from disk source",
					);
				} finally {
					console.log = originalLog;
				}
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"12. direct malformed args: schema and runtime rejection of invalid parameters",
		async () => {
			const env = setupHermeticProject();
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});

			try {
				// Exercise the public runtime directly; do not reach into AgentSession internals.
				const runtime = createCapabilityRuntime({} as any, {} as any, {} as any);
				const execute = (...args: any[]) => runtime.executeAgentTool({} as any, args[1]);
				const dummyCtx = {}; // kept only to exercise the tool-call-shaped fixture arguments

				// 12.1 Non-object params
				await assert.rejects(
					async () => execute("c1", null as any),
					/plain object/i,
				);
				await assert.rejects(
					async () => execute("c2", "not-an-object" as any),
					/plain object/i,
				);

				// 12.2 Unknown arguments (e.g. text, path, patch, arbitrary keys)
				await assert.rejects(
					async () =>
						execute(
							"c3",
							{ action: "enable", id: "review", arbitraryText: "forbidden" } as any,
							undefined,
							undefined,
							dummyCtx,
						),
					/unknown argument/i,
				);
				await assert.rejects(
					async () =>
						execute(
							"c4",
							{ action: "enable", id: "review", patch: { remove: [] } } as any,
							undefined,
							undefined,
							dummyCtx,
						),
					/unknown argument/i,
				);
				await assert.rejects(
					async () =>
						execute(
							"c5",
							{ action: "list", path: "/some/path" } as any,
							undefined,
							undefined,
							dummyCtx,
						),
					/unknown argument/i,
				);

				// 12.3 Legacy actions are not part of forge_capability.
				await assert.rejects(
					async () => execute("c-use", { action: "use", id: "review" } as any),
					/invalid action/i,
				);
				await assert.rejects(
					async () => execute("c-off", { action: "off", id: "review" } as any),
					/invalid action/i,
				);

				// 12.4 Invalid action
				await assert.rejects(
					async () =>
						execute(
							"c6",
							{ action: "reset" as any },
							undefined,
							undefined,
							dummyCtx,
						),
					/invalid action/i,
				);
				await assert.rejects(
					async () =>
						execute(
							"c7",
							{ action: "add" as any },
							undefined,
							undefined,
							dummyCtx,
						),
					/invalid action/i,
				);

				// 12.5 Irrelevant arguments: id provided for list or status
				await assert.rejects(
					async () =>
						execute(
							"c8",
							{ action: "list", id: "review" },
							undefined,
							undefined,
							dummyCtx,
						),
					/irrelevant/i,
				);
				await assert.rejects(
					async () =>
						execute(
							"c9",
							{ action: "status", id: "review" },
							undefined,
							undefined,
							dummyCtx,
						),
					/irrelevant/i,
				);

				// 12.6 Missing required argument: id omitted for enable or disable
				await assert.rejects(
					async () =>
						execute("c10", { action: "enable" }),
					/required/i,
				);
				await assert.rejects(
					async () =>
						execute("c11", { action: "disable" }),
					/required/i,
				);
				await assert.rejects(
					async () =>
						execute(
							"c12",
							{ action: "enable", id: "   " },
							undefined,
							undefined,
							dummyCtx,
						),
					/required/i,
				);
				await assert.rejects(
					async () => execute("c13", { action: "enable", id: "x".repeat(129) }),
					/at most 128/i,
				);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"13. structured readBindings and enableBound exposed for Web owner integration",
		async () => {
			const env = setupHermeticProject();
			const workspace = new ForgeWorkspace();
			const branchEntries: any[] = [];
			const fakePi: any = {
				getActiveTools: () => ["fake_write", "fake_read", "fake_driver", "forge_capability"],
				getAllTools: () => [
					{ name: "fake_write" },
					{ name: "fake_read" },
					{ name: "fake_driver" },
					{ name: "forge_capability" },
				],
				setActiveTools: () => {},
				appendEntry: (customType: string, data: any) => {
					branchEntries.push({ type: "custom", customType, data });
				},
				events: { on: () => () => {}, emit: () => {} },
			};
			const toolPolicy = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
			const runtime = createCapabilityRuntime(fakePi, workspace, toolPolicy);

			const fakeContext: any = {
				cwd: env.cwd,
				isProjectTrusted: () => true,
				isIdle: () => true,
				ui: {
					setStatus: () => {},
					notify: () => {},
					theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
				},
				sessionManager: {
					getBranch: () => branchEntries,
					appendCustomEntry: (entry: any) => branchEntries.push(entry),
					getSessionId: () => "sess-test",
					getLeafId: () => "leaf-test",
				},
			};

			// Load workspace snapshot so active preset is known
			workspace.reload(env.cwd, { trusted: true });

			// 13.1 Test readBindings
			const bindingsRes = runtime.readBindings(fakeContext);
			assert.equal(bindingsRes.ok, true);
			assert.equal((bindingsRes as any).bindings.length, 1);
			assert.equal((bindingsRes as any).bindings[0].id, "review");
			assert.equal((bindingsRes as any).bindings[0].modelCallable, true);
			assert.equal((bindingsRes as any).bindings[0].capability.content, "REVIEW_ONLY_MODE_ACTIVE");

			// 13.2 Test enableBound as user
			const userRes = runtime.enableBound(fakeContext, "review", "user");
			assert.equal(userRes.ok, true);
			assert.equal(typeof (userRes as any).activationId, "string");

			// 13.3 Idempotent repeated use
			const userRes2 = runtime.enableBound(fakeContext, "review", "user");
			assert.equal(userRes2.ok, true);
			assert.equal((userRes2 as any).idempotent, true);

			// 13.4 enableBound with unknown ID
			const badIdRes = runtime.enableBound(fakeContext, "nonexistent-id", "user");
			assert.equal(badIdRes.ok, false);
			assert.match((badIdRes as any).error, /not bound/i);

			// 13.5 readBindings when project is untrusted
			const untrustedContext: any = { ...fakeContext, isProjectTrusted: () => false };
			const untrustedRes = runtime.readBindings(untrustedContext);
			assert.equal(untrustedRes.ok, false);
			assert.match((untrustedRes as any).error, /not trusted/i);

			runtime.dispose();
			workspace.dispose();
			env.cleanup();
		},
	);

	await suite.test(
		"14. agent off rejects ambiguous capability-name matches instead of deactivating the first item",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "base",
					name: "Base Stack",
					autoActivate: true,
					capabilities: [
						{ ref: "review", id: "review-a", modelCallable: true },
						{ ref: "review", id: "review-b", modelCallable: true },
					],
					items: [{ kind: "block", id: "sys1", role: "system", content: "Base" }],
				},
			});
			const harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native: true,
				initialTools: ["fake_write", "fake_read", "fake_driver", "forge_capability"],
			});
			try {
				for (const id of ["review-a", "review-b"]) {
					harness.setResponses([
						{ toolCalls: [{ name: "forge_capability", args: { action: "enable", id } }] },
						"Activated.",
					]);
					await harness.prompt(`Activate ${id}`);
				}

				harness.setResponses([
					{ toolCalls: [{ name: "forge_capability", args: { action: "disable", id: "review" } }] },
					"Ambiguous off rejected.",
				]);
				await harness.prompt("Turn off review by source name");
				const result = findLatestToolResult(harness.streamContexts[harness.streamContexts.length - 1]!.messages);
			assert.ok(result);
			const text = Array.isArray(result.content)
				? result.content.map((part: any) => part.text ?? "").join("\n")
				: String(result.content);
			assert.match(text, /ambiguous/i);
			assert.equal(readCapabilitySession(harness.session as any).events.length, 2);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"15. agent off rejects a stale activation from another preset even when the binding ID is reused",
		async () => {
			const env = setupHermeticProject({
				customStack: {
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "preset-one",
					name: "Preset One",
					autoActivate: true,
					capabilities: [{ ref: "review", id: "shared", modelCallable: true }],
					items: [{ kind: "block", id: "sys1", role: "system", content: "One" }],
				},
			});
			const stacksDir = join(env.cwd, ".pi", "forge", "prompt-stacks");
			writeFileSync(
				join(stacksDir, "preset-two.json"),
				JSON.stringify({
					schemaVersion: 1,
					type: "pi-forge.prompt-stack",
					id: "preset-two",
					name: "Preset Two",
					capabilities: [{ ref: "review", id: "shared", modelCallable: true }],
					items: [{ kind: "block", id: "sys2", role: "system", content: "Two" }],
				}, null, 2),
			);
			const workspace = new ForgeWorkspace();
			const branchEntries: any[] = [];
			const fakePi: any = {
				getActiveTools: () => ["fake_write", "fake_read", "fake_driver", "forge_capability"],
				getAllTools: () => [
					{ name: "fake_write" }, { name: "fake_read" }, { name: "fake_driver" }, { name: "forge_capability" },
				],
				setActiveTools: () => {},
				appendEntry: (customType: string, data: any) => branchEntries.push({ type: "custom", customType, data }),
				events: { on: () => () => {}, emit: () => {} },
			};
			const policy = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
			const runtime = createCapabilityRuntime(fakePi, workspace, policy);
			const context: any = {
				cwd: env.cwd,
				isProjectTrusted: () => true,
				isIdle: () => true,
				ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text } },
				sessionManager: {
					getBranch: () => branchEntries,
					getSessionId: () => "stale-session",
					getLeafId: () => "stale-leaf",
				},
			};

			try {
				workspace.reload(env.cwd, { trusted: true, activeStackId: "project:preset-one" });
				const activated = runtime.enableBound(context, "shared", "agent");
				assert.equal(activated.ok, true);
				assert.equal(workspace.setActiveStack("project:preset-two"), true);

				// Deliberately skip sync: this is the stale-history boundary the auth check must protect.
				const off = runtime.disableBound(context, "shared", "agent");
				assert.equal(off.ok, false);
				assert.match((off as any).error, /exact active-preset binding identity|authorization/i);
				assert.equal(readCapabilitySession(context).events.length, 1);
			} finally {
				runtime.dispose();
				workspace.dispose();
				env.cleanup();
			}
		},
	);
});

// Exercise the shipped examples without replacing their defaults or binding schema.
for (const native of [true, false]) {
	test(`read-first worker example: authorized on-demand tools (${native ? "native" : "fallback"})`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-forge-read-first-example-"));
		let harness: Awaited<ReturnType<typeof createCapabilityAgentControlHarness>> | undefined;
		try {
			const root = join(cwd, ".pi", "forge");
			mkdirSync(join(root, "prompt-stacks"), { recursive: true });
			mkdirSync(join(root, "capabilities"), { recursive: true });
			const presetSource = readFileSync(new URL("../examples/read-first-worker-prompt-stack.json", import.meta.url), "utf8");
			const modeSource = readFileSync(new URL("../examples/capabilities/write-tools.json", import.meta.url), "utf8");
			const { parsePromptStack } = await import("../src/codecs/prompt-stack.ts");
			const { parseCapability } = await import("../src/codecs/capability.ts");
			assert.deepEqual(parsePromptStack(presetSource, "read-first-worker.json", "project").diagnostics, []);
			assert.deepEqual(parseCapability(modeSource, "write-tools.json", "project").diagnostics, []);
			writeFileSync(join(root, "prompt-stacks", "read-first-worker.json"), presetSource);
			writeFileSync(join(root, "capabilities", "write-tools.json"), modeSource);
			harness = await createCapabilityAgentControlHarness({ cwd, native, initialTools: [], allowedTools: ["read", "ls", "forge_capability", "bash", "edit"] });
			assert.deepEqual(harness.getActiveToolNames(), [], "example does not auto-activate");
			await harness.prompt("/preset use project:read-first-worker");
			const base = ["forge_capability", "ls", "read"];
			const enabled = ["bash", "edit", ...base].sort();
			assert.deepEqual(harness.getActiveToolNames().sort(), base);
			assert.equal(harness.streamContexts.length, 0, "human activation invokes no model");
			for (const action of ["enable", "disable"] as const) {
				harness.setResponses([{ toolCalls: [{ name: "forge_capability", args: { action, id: "write-tools" } }] }, "Done."]);
				await harness.prompt(`${action} the authorized write-tools binding`);
				const last: import("@earendil-works/pi-ai").TranscriptContext = harness.streamContexts.at(-1)!;
				assert.deepEqual(harness.getActiveToolNames().sort(), action === "enable" ? enabled : base);
				assert.deepEqual(getCurrentTools(last.messages).map(t => t.name).sort(), action === "enable" ? enabled : base);
				assert.equal(findLatestToolResult(last.messages)?.isError, false);
				if (action === "enable") {
					const event: ReturnType<typeof readCapabilitySession>["events"][number] = readCapabilitySession(harness.session as any).events[0];
					assert.equal(event.actor, "agent");
					assert.equal(event.op, "activate");
					assert.ok(JSON.stringify(last.messages).includes(JSON.parse(modeSource).content));
				} else if (native) {
					assert.ok(!getCurrentSystemPrompt(last.messages).includes(JSON.parse(modeSource).content));
				} else {
					assert.match(JSON.stringify(last.messages), /Removed system prompt section/);
				}
			}
			assert.deepEqual(getCurrentTools(harness.streamContexts[0].messages).map(t => t.name).sort(), base);
			assert.equal(harness.streamContexts.length, 4, "only deliberate local fake-provider turns");
			assert.equal(harness.fetchAttempts, 0);
			assert.deepEqual(harness.toolExecutions, [], "no shell/edit or fake tools executed");
		} finally {
			await harness?.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

for (const native of [true, false]) {
	test(`tool-only capability sends tool changes without an instruction update (${native ? "native" : "fallback"})`, async () => {
		const env = setupHermeticProject({
			customMode: {
				schemaVersion: 1,
				type: "pi-forge.capability",
				id: "review",
				name: "Tool-only Review",
				description: "Removes fake_write without instruction text.",
				content: "",
				tools: { add: [], remove: ["fake_write"] },
			},
		});
		let harness: Awaited<ReturnType<typeof createCapabilityAgentControlHarness>> | undefined;
		try {
			harness = await createCapabilityAgentControlHarness({
				cwd: env.cwd,
				native,
				initialTools: ["fake_write", "fake_read", "forge_capability"],
			});
			const noCapabilityUpdate = (label: string) => {
				for (const context of harness!.streamContexts) {
					const wire = JSON.stringify(context.messages);
					assert.doesNotMatch(wire, /forge-capability-/, `${label}: no instruction section`);
					assert.doesNotMatch(wire, /\[pi-forge instruction update\]/, `${label}: no fallback user update`);
				}
			};

			harness.setResponses([{ toolCalls: [{ name: "forge_capability", args: { action: "enable", id: "review" } }] }, "Done."]);
			await harness.prompt("Enable the review binding");
			let last = harness.streamContexts.at(-1)!;
			const useResult = findLatestToolResult(last.messages);
			const useText = useResult.content.map((c: any) => c.text ?? "").join("\n");
			assert.match(useText, /tool-only capability, no instruction text is sent/);
			assert.doesNotMatch(useText, /capability pending/);
			assert.ok(!harness.getActiveToolNames().includes("fake_write"));
			assert.ok(!getCurrentTools(last.messages).some(t => t.name === "fake_write"), "tool removal still reaches the request");

			harness.setResponses(["Plain reply."]);
			await harness.prompt("Plain follow-up");
			last = harness.streamContexts.at(-1)!;
			assert.ok(!getCurrentTools(last.messages).some(t => t.name === "fake_write"));
			noCapabilityUpdate("after use");

			harness.setResponses([{ toolCalls: [{ name: "forge_capability", args: { action: "disable", id: "review" } }] }, "Done."]);
			await harness.prompt("Disable the review binding");
			harness.setResponses(["Plain reply."]);
			await harness.prompt("Plain follow-up");
			last = harness.streamContexts.at(-1)!;
			assert.ok(harness.getActiveToolNames().includes("fake_write"));
			assert.ok(getCurrentTools(last.messages).some(t => t.name === "fake_write"), "tool restoration reaches the request");
			noCapabilityUpdate("after off");
			assert.equal(harness.fetchAttempts, 0);
			assert.equal(harness.toolExecutions.filter(t => t.name === "fake_write").length, 0);
		} finally {
			await harness?.dispose();
			env.cleanup();
		}
	});
}
