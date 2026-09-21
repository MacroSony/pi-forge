import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 1. Harness imported first so fetch guard is installed immediately
import { createInstructionAgentHarness, type InstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";

// 2. Dynamic imports after fetch guard is active
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");

import type { InstructionStateView } from "../src/instruction-state.ts";

interface HttpResponse<T = any> {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
	json(): T;
}

function httpRequest<T = any>(
	urlStr: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: unknown;
	} = {},
): Promise<HttpResponse<T>> {
	return new Promise((resolve, reject) => {
		const targetUrl = new URL(urlStr);
		const reqOptions: http.RequestOptions = {
			hostname: targetUrl.hostname,
			port: targetUrl.port,
			path: targetUrl.pathname + targetUrl.search,
			method: options.method || "GET",
			headers: { ...(options.headers || {}) },
		};

		let payload: string | undefined;
		if (options.body !== undefined) {
			payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
			reqOptions.headers = {
				...reqOptions.headers,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload).toString(),
			};
		}

		const req = http.request(reqOptions, (res) => {
			let chunks = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				chunks += chunk;
			});
			res.on("end", () => {
				resolve({
					status: res.statusCode || 0,
					headers: res.headers,
					body: chunks,
					json: () => JSON.parse(chunks),
				});
			});
		});

		req.on("error", reject);
		if (payload !== undefined) {
			req.write(payload);
		}
		req.end();
	});
}

function setupHermeticProject(options?: {
	customModes?: Array<{ id: string; name?: string; content: string; tools?: { add?: string[]; remove?: string[] } }>;
}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-web-agent-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ autoActivate: true }, null, 2),
	);

	const stackDir = join(cwd, ".pi", "forge", "prompt-stacks");
	mkdirSync(stackDir, { recursive: true });
	const stack = {
		schemaVersion: 2,
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

	const modesDir = join(cwd, ".pi", "forge", "instruction-modes");
	mkdirSync(modesDir, { recursive: true });
	const modes = options?.customModes ?? [
		{
			id: "review",
			name: "Review Mode",
			content: "REVIEW_MODE_CONTENT",
			tools: { add: [], remove: ["fake_write"] },
		},
	];
	for (const m of modes) {
		const modeDoc = {
			schemaVersion: 1,
			type: "pi-forge.instruction-mode",
			id: m.id,
			...(m.name ? { name: m.name } : {}),
			content: m.content,
			tools: {
				add: m.tools?.add ?? [],
				remove: m.tools?.remove ?? [],
			},
		};
		writeFileSync(join(modesDir, `${m.id}.json`), JSON.stringify(modeDoc, null, 2));
	}

	return {
		cwd,
		cleanup() {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

async function openPresetUi(harness: InstructionAgentHarness, cwd: string): Promise<{ port: number; token: string }> {
	const origLog = console.log;
	console.log = () => {};
	try {
		await harness.prompt("/preset ui");
	} finally {
		console.log = origLog;
	}

	const registry = (globalThis as any).__piForgeWebEditor;
	const server = registry?.byCwd?.[cwd]?.server;
	assert.ok(server, `server must be registered in __piForgeWebEditor.byCwd for ${cwd}`);
	const url = new URL(server.url);
	const token = url.searchParams.get("token");
	assert.ok(token, "token must exist in server.url");
	return { port: server.port, token };
}

async function closePresetUi(harness: InstructionAgentHarness): Promise<void> {
	const origLog = console.log;
	console.log = () => {};
	try {
		await harness.prompt("/preset ui stop");
	} catch {} finally {
		console.log = origLog;
	}
}

test("Instruction Web Agent Suite (serial to prevent global directory and port races)", async (suite) => {
	await suite.test(
		"1. GET returns multi-mode state, actor/source/body, actual tools, no transcript append, no extra inference, and delivery transitions pending -> prepared after intentional model request",
		async () => {
			const env = setupHermeticProject({
				customModes: [
					{
						id: "review",
						name: "Review Mode",
						content: "REVIEW_MODE_CONTENT",
						tools: { add: [], remove: ["fake_write"] },
					},
				],
			});
			const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: true });

			try {
				// 1.1 Activate mode from file and add manual mode via CLI
				await harness.prompt("/system-update use review");
				await harness.prompt("/system-update add MANUAL_SPECIAL_DIRECTIVE");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write must be gated off by review mode");

				// 1.2 Start real Web server via /preset ui
				const { port, token } = await openPresetUi(harness, env.cwd);
				const apiUrl = `http://127.0.0.1:${port}/api/instructions`;

				// Baseline metrics: no intentional model inference has executed yet
				const baselineInferenceCount = harness.streamContexts.length;
				assert.equal(baselineInferenceCount, 0, "idle CLI and server start must not trigger model inference");
				const entriesCountBefore = harness.session.sessionManager.getEntries().length;
				const activeToolsBefore = harness.getActiveToolNames();

				// 1.3 GET /api/instructions returns 200 with full multi-mode view
				const getRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "GET",
					headers: { "x-pi-forge-token": token },
				});

				assert.equal(getRes.status, 200);
				assert.equal(getRes.json().ok, true);
				const state = getRes.json().state;

				// Verification: GET does NOT append entries, change tools, or trigger inference
				assert.equal(harness.session.sessionManager.getEntries().length, entriesCountBefore, "GET must not append entries");
				assert.deepEqual(harness.getActiveToolNames(), activeToolsBefore, "GET must not change active tools");
				assert.equal(harness.streamContexts.length, baselineInferenceCount, "GET must not trigger model inference (0 extra calls)");

				// Verification: active items contain both review mode and manual directive with exact fields
				assert.equal(state.active.length, 2, "state must contain exactly 2 active modes");

				const reviewAct = state.active.find((item) => item.source === "project:review");
				assert.ok(reviewAct, "review mode item must exist in active instructions");
				assert.equal(reviewAct.actor, "user");
				assert.equal(reviewAct.name, "Review Mode");
				assert.equal(reviewAct.content, "REVIEW_MODE_CONTENT");
				assert.deepEqual(reviewAct.tools, { add: [], remove: ["fake_write"] });

				const manualAct = state.active.find((item) => item.source === "manual");
				assert.ok(manualAct, "manual directive item must exist in active instructions");
				assert.equal(manualAct.actor, "user");
				assert.equal(manualAct.content, "MANUAL_SPECIAL_DIRECTIVE");
				assert.deepEqual(manualAct.tools, { add: [], remove: [] });

				// Verification: effectiveTools matches actual tools (without fake_write)
				assert.deepEqual(state.effectiveTools, harness.getActiveToolNames());
				assert.ok(!state.effectiveTools.includes("fake_write"));

				// Verification: delivery is pending before model prompt
				assert.equal(state.delivery, "pending", "delivery must be pending before prompt request");

				// 1.4 Perform ONE intentional model request
				harness.setResponses(["Acknowledged instruction mode turn."]);
				await harness.prompt("Please check the active instructions.");

				const intentionalInferences = baselineInferenceCount + 1; // exactly 1 intentional model turn
				assert.equal(harness.streamContexts.length, intentionalInferences, "intentional prompt increments inference count by exactly 1");

				const lastCtx = harness.streamContexts.at(-1)!;
				const promptText = getCurrentSystemPrompt(lastCtx.messages);
				assert.ok(promptText.includes("Base preset system block"), "valid fixture preset really participates in compilation");
				assert.ok(promptText.includes("REVIEW_MODE_CONTENT"), "system prompt contains mode content");
				assert.ok(promptText.includes("MANUAL_SPECIAL_DIRECTIVE"), "system prompt contains manual directive");

				// 1.5 GET /api/instructions after prompt: delivery transitions from pending to prepared
				const getResAfter = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "GET",
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getResAfter.status, 200);
				assert.equal(getResAfter.json().state.delivery, "prepared", "delivery transitions to prepared after model request");
				assert.equal(harness.streamContexts.length, intentionalInferences, "subsequent GET must not trigger model inference");
				assert.equal(harness.fetchAttempts, 0, "must have zero external network fetch attempts");
			} finally {
				await closePresetUi(harness);
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"2. POST off restores fake_write without inference; rejects 400 bad payload, 404 unknown activation, 409 session/leaf/revision and stale revision from CLI",
		async () => {
			const env = setupHermeticProject();
			const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: true });

			try {
				const { port, token } = await openPresetUi(harness, env.cwd);
				const apiUrl = `http://127.0.0.1:${port}/api/instructions`;

				// Baseline inference tracking
				const baselineInferences = harness.streamContexts.length;
				assert.equal(baselineInferences, 0, "baseline inferences must be 0");

				// Activate review mode (removes fake_write)
				await harness.prompt("/system-update use review");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "fake_write gated off by review mode");

				// Read initial state
				const getRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getRes.status, 200);
				const state1 = getRes.json().state;
				const guard1 = state1.guard;
				const reviewAct = state1.active.find((a) => a.source === "project:review");
				assert.ok(reviewAct, "review activation must exist");

				// 2.1 400 Bad Request on invalid payloads
				const badActionRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "invalid_action", guard: guard1 },
				});
				assert.equal(badActionRes.status, 400);

				const missingGuardRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct.activationId },
				});
				assert.equal(missingGuardRes.status, 400);

				const extraFieldRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: guard1, extraProp: true },
				});
				assert.equal(extraFieldRes.status, 400);

				assert.equal(harness.streamContexts.length, baselineInferences, "400 errors must not trigger inference");

				// 2.2 404 Not Found on unknown activationId
				const notFoundRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: "00000000-0000-0000-0000-000000000000", guard: guard1 },
				});
				assert.equal(notFoundRes.status, 404);
				assert.equal(harness.streamContexts.length, baselineInferences, "404 error must not trigger inference");

				// 2.3 409 Conflict on mismatched guard parameters
				const wrongSessionRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct.activationId, guard: { ...guard1, sessionId: "wrong-session-uuid" } },
				});
				assert.equal(wrongSessionRes.status, 409);

				const wrongLeafRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct.activationId, guard: { ...guard1, leafId: "wrong-leaf-uuid" } },
				});
				assert.equal(wrongLeafRes.status, 409);

				const wrongRevRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct.activationId, guard: { ...guard1, revision: "tampered-revision" } },
				});
				assert.equal(wrongRevRes.status, 409);

				assert.equal(harness.streamContexts.length, baselineInferences, "409 guard errors must not trigger inference");

				// 2.4 409 Conflict when CLI mode change produces a stale revision; state is not written
				await harness.prompt("/system-update add EXTRA_CLI_RULE");
				const staleRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct.activationId, guard: guard1 },
				});
				assert.equal(staleRes.status, 409, "mutation with stale guard must be rejected with 409");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"), "stale mutation must not write or restore tools");
				assert.equal(harness.streamContexts.length, baselineInferences, "stale 409 must not trigger inference");

				// 2.5 Successful POST off with fresh state restores fake_write and does not infer
				const freshGetRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(freshGetRes.status, 200);
				const freshState = freshGetRes.json().state;
				const freshReviewAct = freshState.active.find((a) => a.source === "project:review");
				assert.ok(freshReviewAct, "review activation must exist in fresh state");

				const offRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: freshReviewAct.activationId, guard: freshState.guard },
				});
				assert.equal(offRes.status, 200);
				assert.equal(offRes.json().ok, true);
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "POST off must restore fake_write");
				assert.ok(!offRes.json().state.active.some((a) => a.activationId === freshReviewAct.activationId), "review activation removed from state");
				assert.equal(harness.streamContexts.length, baselineInferences, "POST off must not trigger model inference (0 extra calls)");
				assert.equal(harness.fetchAttempts, 0, "must have zero external network fetch attempts");
			} finally {
				await closePresetUi(harness);
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"3. navigateTree to baseline leaf prevents old branch guard from mutating new branch, fresh state succeeds, and reset maintains session isolation",
		async () => {
			const env = setupHermeticProject();
			const harness = await createInstructionAgentHarness({ cwd: env.cwd, native: true });

			try {
				const { port, token } = await openPresetUi(harness, env.cwd);
				const apiUrl = `http://127.0.0.1:${port}/api/instructions`;

				// 3.1 Establish intentional baseline leaf with 1 model turn
				harness.setResponses(["Baseline turn response"]);
				await harness.prompt("Run baseline turn");
				const baselineLeaf = harness.sessionManager.getLeafId();
				assert.ok(baselineLeaf, "baseline leaf must exist");
				const baselineInferences = 1; // 1 intentional baseline model call
				assert.equal(harness.streamContexts.length, baselineInferences);

				// 3.2 Branch A: activate review mode
				await harness.prompt("/system-update use review");
				const branchALeaf = harness.sessionManager.getLeafId();
				assert.notEqual(branchALeaf, baselineLeaf);
				assert.ok(!harness.getActiveToolNames().includes("fake_write"));

				const resA = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(resA.status, 200);
				const guardBranchA = resA.json().state.guard;
				assert.equal(guardBranchA.leafId, branchALeaf);

				// 3.3 Navigate tree back to baseline leaf
				await harness.session.navigateTree(baselineLeaf);
				assert.equal(harness.sessionManager.getLeafId(), baselineLeaf);
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "fake_write restored at baseline leaf");

				// 3.4 Create Branch B from baseline
				await harness.prompt("/system-update add BRANCH_B_RULE");
				const branchBLeaf = harness.sessionManager.getLeafId();
				assert.notEqual(branchBLeaf, baselineLeaf);
				assert.notEqual(branchBLeaf, branchALeaf);

				// 3.5 Old Branch A guard cannot mutate/reset Branch B (409)
				const staleResetRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: guardBranchA },
				});
				assert.equal(staleResetRes.status, 409, "old branch guard must be rejected on new branch with 409");

				// Branch B active state is preserved
				const checkB = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(checkB.status, 200);
				const stateB = checkB.json().state;
				assert.ok(stateB.active.some((a) => a.content === "BRANCH_B_RULE"), "Branch B rule preserved after stale reset rejection");
				assert.equal(harness.streamContexts.length, baselineInferences, "rejected reset triggers 0 inference calls");

				// 3.6 Cross-session reset isolation: foreign sessionId is rejected with 409
				const foreignGuard = { ...stateB.guard, sessionId: "foreign-session-uuid-isolation" };
				const foreignResetRes = await httpRequest(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: foreignGuard },
				});
				assert.equal(foreignResetRes.status, 409, "foreign session guard must fail closed with 409");

				// 3.7 Fresh Branch B guard resets successfully
				const validResetRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: stateB.guard },
				});
				assert.equal(validResetRes.status, 200);
				assert.equal(validResetRes.json().state.active.length, 0, "Branch B active instructions cleared by reset");
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "tools recomputed after reset");

				// Verification: all management operations triggered zero additional inference calls; total remains exactly 1 intentional baseline call
				assert.equal(
					harness.streamContexts.length,
					baselineInferences,
					"management operations (GET, stale resets, foreign resets, valid reset) must produce 0 extra model calls; total equals exactly 1 intentional baseline call",
				);
				assert.equal(harness.fetchAttempts, 0, "must have zero external network fetch attempts");
			} finally {
				await closePresetUi(harness);
				await harness.dispose();
				env.cleanup();
			}
		},
	);

	await suite.test(
		"4. public SDK dispose invalidates old host (503 on old host, manager entries unchanged), h2 same-manager reconstruction refreshes host with 409 guard rejection and valid off, h3 new-session isolation maintains distinct sessionId",
		async () => {
			const env = setupHermeticProject();
			let h1: InstructionAgentHarness | undefined;
			let h2: InstructionAgentHarness | undefined;
			let h3: InstructionAgentHarness | undefined;
			let server: any;

			try {
				// 4.1 h1: start in env.cwd, activate review mode and open UI
				h1 = await createInstructionAgentHarness({ cwd: env.cwd, native: true });
				await h1.prompt("/system-update use review");
				assert.ok(!h1.getActiveToolNames().includes("fake_write"), "fake_write gated off by review mode");

				const { port, token } = await openPresetUi(h1, env.cwd);
				const apiUrl = `http://127.0.0.1:${port}/api/instructions`;

				// Read initial guard from GET
				const getRes1 = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getRes1.status, 200);
				assert.equal(getRes1.json().ok, true);
				const state1 = getRes1.json().state;
				const guard1 = state1.guard;
				const reviewAct1 = state1.active.find((a) => a.source === "project:review");
				assert.ok(reviewAct1, "review activation must exist in initial state");

				// Save manager and server references (accessible from global Forge registry)
				const manager1 = h1.sessionManager;
				const registry = (globalThis as any).__piForgeWebEditor;
				server = registry?.byCwd?.[env.cwd]?.server;
				assert.ok(server, `server must be registered in __piForgeWebEditor.byCwd for ${env.cwd}`);
				assert.equal(server.port, port);
				const entriesCountBefore = manager1.getEntries().length;

				// Public SDK disposal invalidates its contexts; no synthetic shutdown emit.
				assert.equal(h1.streamContexts.length, 0);
				assert.equal(h1.fetchAttempts, 0);
				await h1.dispose();
				h1 = undefined;

				// GET after h1.dispose still returns 503
				const getResDisposed = await httpRequest<{ ok: boolean; error: string }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getResDisposed.status, 503, "GET after h1.dispose must return 503");
				assert.equal(manager1.getEntries().length, entriesCountBefore, "manager entries must remain unchanged");

				// POST after h1.dispose must fail closed without writing to unloaded session
				const postResDisposed = await httpRequest<{ ok: boolean; error: string }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct1.activationId, guard: guard1 },
				});
				assert.equal(postResDisposed.status, 503, "disposed context returns service unavailable without entering mutation");
				assert.equal(manager1.getEntries().length, entriesCountBefore, "POST after dispose must not write to unloaded session");

				// 4.3 h2: restore runtime with same cwd using original manager1 (simulates runtime replacement)
				h2 = await createInstructionAgentHarness({ cwd: env.cwd, sessionManager: manager1, native: true });

				// Web server automatically refreshes host to h2 via session_start lifecycle
				const getRes2 = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getRes2.status, 200, "GET after host refresh must return 200");
				assert.equal(getRes2.json().ok, true);
				const state2 = getRes2.json().state;
				assert.equal(state2.active.length, 1, "active mode must be restored in h2");
				const reviewAct2 = state2.active.find((a) => a.source === "project:review");
				assert.ok(reviewAct2, "review mode item must exist in restored state");

				// Old guard1 rejected with 409 Conflict
				// Note: leafId changed because new session initialization appends session entries,
				// and revision changed because instanceId/leafId changed across runtime instances.
				assert.notEqual(guard1.leafId, state2.guard.leafId, "leafId changes on restored session initialization");
				assert.notEqual(guard1.revision, state2.guard.revision, "revision changes across runtime instances");

				const postOldGuardRes = await httpRequest<{ ok: boolean; error: string }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct2.activationId, guard: guard1 },
				});
				assert.equal(postOldGuardRes.status, 409, "old guard must be rejected with 409 Conflict");
				assert.equal(postOldGuardRes.json().ok, false);
				assert.match(postOldGuardRes.json().error, /Session, branch or instruction state changed/);

				// New guard2 off succeeds, restores fake_write
				const postNewGuardRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "off", activationId: reviewAct2.activationId, guard: state2.guard },
				});
				assert.equal(postNewGuardRes.status, 200, "POST off with fresh guard must succeed");
				assert.equal(postNewGuardRes.json().ok, true);
				assert.equal(postNewGuardRes.json().state.active.length, 0, "instruction mode deactivated");
				assert.ok(h2.getActiveToolNames().includes("fake_write"), "fake_write restored by off action");

				// 4.4 Dispose h2, then create h3 with same cwd and fresh SessionManager
				assert.equal(h2.streamContexts.length, 0);
				assert.equal(h2.fetchAttempts, 0);
				await h2.dispose();
				h2 = undefined;

				h3 = await createInstructionAgentHarness({ cwd: env.cwd, native: true });
				await h3.prompt("/system-update add NEWSESSION_RULE");

				const getRes3 = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					headers: { "x-pi-forge-token": token },
				});
				assert.equal(getRes3.status, 200);
				const state3 = getRes3.json().state;
				assert.equal(state3.active.length, 1);
				assert.equal(state3.active[0].content, "NEWSESSION_RULE");

				// sessionId is indeed distinct between h2 and h3
				assert.notEqual(state2.guard.sessionId, state3.guard.sessionId, "sessionId must differ between independent sessions");

				// Old h2 guard cannot clear h3 (fails closed with 409)
				const postH3OldGuardRes = await httpRequest<{ ok: boolean; error: string }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: state2.guard },
				});
				assert.equal(postH3OldGuardRes.status, 409, "old h2 guard must not clear h3 session");

				// New h3 guard resets normally
				const postH3NewGuardRes = await httpRequest<{ ok: boolean; state: InstructionStateView }>(apiUrl, {
					method: "POST",
					headers: { "x-pi-forge-token": token },
					body: { action: "reset", guard: state3.guard },
				});
				assert.equal(postH3NewGuardRes.status, 200, "new h3 guard resets normally");
				assert.equal(postH3NewGuardRes.json().ok, true);
				assert.equal(postH3NewGuardRes.json().state.active.length, 0, "h3 active modes cleared");

				// Zero model requests and zero external network
				assert.equal(h3.streamContexts.length, 0, "must produce 0 model inferences throughout test 4");
				assert.equal(h3.fetchAttempts, 0, "must have zero external network fetch attempts");
			} finally {
				const cleanupErrors: unknown[] = [];
				if (server) {
					try { await server.close(); } catch (error) { cleanupErrors.push(error); }
				}
				for (const harness of [h3, h2, h1]) {
					if (harness) {
						try { await harness.dispose(); } catch (error) { cleanupErrors.push(error); }
					}
				}
				env.cleanup();
				assert.deepEqual(cleanupErrors, [], "all servers and sessions close cleanly");
			}
		},
	);
});

for (const native of [true, false]) {
 test(`preview API uses frozen mode projection without preparing delivery (${native ? "native" : "fallback"})`, async () => {
  const env = setupHermeticProject();
  const harness = await createInstructionAgentHarness({cwd: env.cwd, native, responses: ['Intentional preview comparison turn.']});
  try {
   await harness.prompt('/system-update use review');
   const {port, token} = await openPresetUi(harness, env.cwd);
   const root = `http://127.0.0.1:${port}`;
   const headers = {'x-pi-forge-token': token};
   const state = async () => (await httpRequest(`${root}/api/instructions`, {headers})).json().state;
   const stack = (await httpRequest(`${root}/api/stacks/project%3Abase`, {headers})).json().stack;
   stack.items.push({kind: 'slot', id: 'tools', role: 'system', slot: 'tools'});
   stack.items.push({kind: 'slot', id: 'history', name: 'Delegated Task', slot: 'chat-history'});
   const preview = async () => {
    const before = {entries: JSON.stringify(harness.manager.getEntries()), tools: harness.getActiveToolNames(), state: await state(), calls: harness.streamContexts.length, starts: harness.beforeAgentStartEvents.length};
    const res = await httpRequest(`${root}/api/stacks/project%3Abase/preview`, {method: 'POST', headers, body: {stack}});
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.stringify(harness.manager.getEntries()), before.entries);
    assert.deepEqual(harness.getActiveToolNames(), before.tools);
    assert.deepEqual(await state(), before.state, 'preview cannot mark a pending update prepared or change revision');
    assert.equal(harness.streamContexts.length, before.calls);
    assert.equal(harness.beforeAgentStartEvents.length, before.starts);
    return res.json();
   };
   assert.equal((await state()).delivery, 'pending');
   const first = await preview();
   const updates = first.preview.messages.filter((m: any) => m.title === 'Forge instruction update');
   assert.equal(updates.length, 1);
   assert.equal(updates[0].role, native ? 'system' : 'user');
   assert.match(native ? Object.values(updates[0].sections ?? {}).join("\n") : updates[0].content, /REVIEW_MODE_CONTENT/);
   assert.ok(!first.preview.selectedTools.includes("fake_write"));
   assert.doesNotMatch(first.text, /Forge instruction state changed/);
   assert.doesNotMatch(first.preview.system.content, /fake_write/);
   assert.equal(harness.streamContexts.length, 0);
   // Source edits never replace a branch's immutable activation snapshot.
   writeFileSync(join(env.cwd, '.pi/forge/instruction-modes/review.json'), JSON.stringify({schemaVersion: 1, type: 'pi-forge.instruction-mode', id: 'review', content: 'NEW_SOURCE_NOT_ACTIVE', tools: {add: [], remove: []}}));
   const frozen = await preview();
   assert.match(frozen.text, /REVIEW_MODE_CONTENT/);
   assert.doesNotMatch(frozen.text, /NEW_SOURCE_NOT_ACTIVE/);
   // One intentional fake-provider turn checks the real request path too.
   await harness.prompt('Inspect the current rules.');
   assert.equal((await state()).delivery, 'prepared');
   assert.match(JSON.stringify(harness.streamContexts.at(-1)), /REVIEW_MODE_CONTENT/);
   await preview();
   await harness.prompt('/system-update off review');
   assert.equal((await state()).delivery, 'pending');
   const off = await preview();
   assert.ok(off.preview.selectedTools.includes('fake_write'));
   assert.match(off.text, /Removed system prompt section/);
   assert.doesNotMatch(off.text, /Forge instruction state changed/);
   assert.ok(harness.getActiveToolNames().includes('fake_write'));
   assert.equal(harness.fetchAttempts, 0);
  } finally {
   try {await closePresetUi(harness);} finally {
    try {await harness.dispose();} finally {env.cleanup();}
   }
  }
 });
}
