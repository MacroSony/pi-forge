import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The helper installs the hermetic SDK/fetch setup before loading Forge.
import { createInstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";
import {
	FORGE_NESTED_USAGE_KEY,
	cacheHitRate,
	parseForgeNestedUsage,
	summarizeSessionCacheUsage,
} from "../src/session-usage.ts";

function message(role: string, usage?: Record<string, unknown>, details?: unknown): unknown {
	return {
		type: "message",
		message: {
			role,
			content: [],
			...(usage ? { usage } : {}),
			...(details === undefined ? {} : { details }),
		},
	};
}

function assistant(usage: Record<string, unknown>, stopReason = "stop"): unknown {
	return { type: "message", message: { role: "assistant", content: [], usage, stopReason } };
}

function nested(usage: unknown): unknown {
	return message("toolResult", undefined, { [FORGE_NESTED_USAGE_KEY]: usage });
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers: { "x-pi-forge-token": token } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
		});
		request.on("error", reject);
	});
}

test("session usage summarizes an empty branch and guards the hit-rate denominator", () => {
	assert.deepEqual(summarizeSessionCacheUsage([]), {
		main: { turn: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, session: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		nested: {
			turn: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 },
			session: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 },
		},
	});
	assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	assert.equal(cacheHitRate({ input: 20, cacheRead: 60, cacheWrite: 20 }), 0.6);
});

test("session usage uses only the supplied current branch, retains pre-compaction history, and separates nested calls", () => {
	const branch = freeze([
		{ type: "custom", customType: "other-branch-entry" },
		message("system"),
		message("user"),
		assistant({ input: 10, output: 1, cacheRead: 90, cacheWrite: 0 }),
		nested({ schemaVersion: 1, requests: 9, input: 30, output: 40, cacheRead: 50, cacheWrite: 6 }),
		{ type: "compaction", summary: "retained history is still in this branch" },
		message("user"),
		assistant({ input: 20, output: 2, cacheRead: 60, cacheWrite: 20 }),
		nested({ schemaVersion: 1, requests: 2, input: 3, output: 4, cacheRead: 5, cacheWrite: 1 }),
		nested({ schemaVersion: 1, requests: 1, input: 7, output: 8 }),
		assistant({ input: 30, output: 3, cacheRead: 0, cacheWrite: 10 }),
		nested({ schemaVersion: 1, requests: 1, input: 4, output: 5, cacheRead: 2, cacheWrite: 0 }),
		message("system"),
		{ type: "usage", usage: { input: 999, cacheRead: 999 } },
		{ type: "branch_summary", usage: { input: 999, cacheRead: 999 } },
		{ type: "compaction", usage: { input: 999, cacheRead: 999 } },
		message("toolResult", { input: 999, cacheRead: 999 }),
		{ type: "custom", customType: "ignored" },
	] as unknown[]);
	const before = structuredClone(branch);
	const view = summarizeSessionCacheUsage(branch);

	assert.deepEqual(view.main.session, { requests: 3, input: 60, output: 6, cacheRead: 150, cacheWrite: 30 });
	assert.deepEqual(view.main.turn, { requests: 2, input: 50, output: 5, cacheRead: 60, cacheWrite: 30 });
	assert.deepEqual(view.main.lastRequest, { requests: 1, input: 30, output: 3, cacheRead: 0, cacheWrite: 10 });
	assert.deepEqual(view.nested.session, { requests: 12, input: 37, output: 49, cacheRead: 57, cacheWrite: 7, calls: 3, cacheUnknownCalls: 1, invalidCalls: 0 });
	assert.deepEqual(view.nested.turn, { requests: 3, input: 7, output: 9, cacheRead: 7, cacheWrite: 1, calls: 2, cacheUnknownCalls: 1, invalidCalls: 0 });
	const withNativeUsage = structuredClone(branch) as any[];
	withNativeUsage[4].message.usage = { input: 30, output: 40, cacheRead: 50, cacheWrite: 6 };
	assert.deepEqual(summarizeSessionCacheUsage(withNativeUsage), view, "native toolResult.usage must not duplicate Forge attribution");
	const nextTurn = summarizeSessionCacheUsage([...branch, message("user")]);
	assert.equal(nextTurn.main.turn.requests, 0);
	assert.equal(nextTurn.nested.turn.calls, 0);
	assert.deepEqual(nextTurn.main.session, view.main.session);
	assert.deepEqual(branch, before, "summarizing must not mutate frozen branch input");
	assert.equal(cacheHitRate(view.main.session), 150 / 240);
});

test("zero-usage errors and aborts are ignored, while positive reported usage is included", () => {
	const entries = freeze([
		message("user"),
		assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "error"),
		assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "aborted"),
		assistant({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0 }, "error"),
		assistant({ input: 0, output: 0, cacheRead: 6, cacheWrite: 0 }, "aborted"),
	] as unknown[]);
	assert.deepEqual(summarizeSessionCacheUsage(entries).main.session, { requests: 2, input: 4, output: 0, cacheRead: 6, cacheWrite: 0 });
});

test("nested usage accepts the contract and rejects malformed reports", () => {
	const valid = { schemaVersion: 1, requests: 2, input: 3, output: 4, cacheRead: 5, cacheWrite: 6 };
	assert.deepEqual(parseForgeNestedUsage(freeze(valid)), valid);
	assert.deepEqual(parseForgeNestedUsage({ schemaVersion: 1, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), { schemaVersion: 1, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(parseForgeNestedUsage({ schemaVersion: 1, requests: 1, input: 2, output: 3 }), { schemaVersion: 1, requests: 1, input: 2, output: 3 });

	for (const invalid of [
		{ ...valid, requests: 0 },
		{ schemaVersion: 1, requests: 0, input: 1, output: 0 },
		{ ...valid, requests: -1 },
		{ ...valid, input: -1 },
		{ ...valid, output: Number.NaN },
		{ ...valid, cacheRead: Number.POSITIVE_INFINITY },
		{ ...valid, requests: 1.5 },
		{ ...valid, cacheRead: 1, cacheWrite: undefined },
		{ ...valid, cacheRead: undefined, cacheWrite: 1 },
		{ ...valid, schemaVersion: 2 },
		{ ...valid, extra: true },
	]) assert.equal(parseForgeNestedUsage(invalid), undefined);

	const invalidEntries = freeze([
		nested({ schemaVersion: 1, requests: -1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
		nested({ schemaVersion: 1, requests: 1, input: 1, output: 1, cacheRead: 1 }),
	]);
	const view = summarizeSessionCacheUsage(invalidEntries);
	assert.equal(view.nested.session.invalidCalls, 2);
	assert.equal(view.nested.session.calls, 0);
	assert.equal(view.nested.session.cacheRead, 0, "unknown/invalid cache must not become zero-valued valid usage");
});

test("real SDK readState is read-only and observes usage on the next leaf", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-session-usage-"));
	const harness = await createInstructionAgentHarness({ cwd, native: true });
	try {
		await harness.prompt("/preset ui");
		const server = (globalThis as any).__piForgeWebEditor?.byCwd?.[cwd]?.server;
		assert.ok(server, "real SDK harness should expose the instruction runtime server");
		const serverUrl = new URL(server.url);
		const token = serverUrl.searchParams.get("token");
		assert.ok(token);

		const entriesBefore = structuredClone(harness.sessionManager.getBranch());
		const inferencesBefore = harness.streamContexts.length;
		const initial = await getJson(`${serverUrl.origin}/api/instructions`, token);
		assert.equal(initial.status, 200);
		assert.equal(initial.body.state.cacheUsage.main.session.requests, 0);
		assert.deepEqual(harness.sessionManager.getBranch(), entriesBefore, "readState must not append session entries");
		assert.equal(harness.streamContexts.length, inferencesBefore, "readState must not infer");

		harness.setResponses([() => {
			const response: any = { role: "assistant", content: [{ type: "text", text: "recorded" }], stopReason: "stop", timestamp: Date.now() };
			response.usage = { input: 12, output: 3, cacheRead: 5, cacheWrite: 1, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			return response;
		}]);
		const previousLeaf = harness.sessionManager.getLeafId();
		await harness.prompt("record positive usage");
		assert.notEqual(harness.sessionManager.getLeafId(), previousLeaf, "prompt should advance the SDK leaf");

		const entriesAfterPrompt = structuredClone(harness.sessionManager.getBranch());
		const inferencesAfterPrompt = harness.streamContexts.length;
		const next = await getJson(`${serverUrl.origin}/api/instructions`, token);
		assert.equal(next.status, 200);
		assert.equal(next.body.state.cacheUsage.main.session.requests, 1);
		const persisted = summarizeSessionCacheUsage(harness.sessionManager.getBranch()).main.lastRequest;
		assert.deepEqual(next.body.state.cacheUsage.main.lastRequest, persisted);
		assert.notDeepEqual(next.body.state.guard, initial.body.state.guard, "new leaf invalidates the existing state guard");
		assert.ok(persisted && persisted.input + persisted.output + persisted.cacheRead + persisted.cacheWrite > 0, "positive persisted usage must be included");
		assert.deepEqual(harness.sessionManager.getBranch(), entriesAfterPrompt, "later readState must not append entries");
		assert.equal(harness.streamContexts.length, inferencesAfterPrompt, "later readState must not infer");
	} finally {
		try { await harness.prompt("/preset ui stop"); } catch {}
		await harness.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
