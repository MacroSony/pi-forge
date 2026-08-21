import assert from "node:assert/strict";
import test from "node:test";
import {
	appendContextDiffCapture,
	createContextDiffHistory,
	getContextDiffView,
	type ContextDiffView,
} from "../src/context-diff-history.ts";
import type { ContextDiffCapture } from "../src/context-diff-snapshot.ts";
import { startWebEditorServer, type WebEditorHost, type WebEditorServer } from "../src/web-editor/index.ts";

function capture(capturedAt: string, content: string): ContextDiffCapture {
	return {
		capturedAt,
		stackId: "stack-context-diff",
		payload: {
			model: "gpt-4.1",
			messages: [{ role: "user", content }],
		},
		text: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content }] }),
	};
}

function hostWithView(view: ContextDiffView): WebEditorHost {
	return {
		getContextDiff: () => ({ ok: true, ...view }),
	} as unknown as WebEditorHost;
}

async function withServer(host: WebEditorHost, run: (server: WebEditorServer) => Promise<void>): Promise<void> {
	const server = await startWebEditorServer(host, { port: 0 });
	try {
		await run(server);
	} finally {
		await server.close();
	}
}

test("GET /api/context-diff returns the latest diff and recent turn summaries", async () => {
	const history = createContextDiffHistory();
	appendContextDiffCapture(history, capture("2025-01-01T00:00:00.000Z", "first"));
	appendContextDiffCapture(history, capture("2025-01-01T00:01:00.000Z", "second"));
	const view = getContextDiffView(history);

	await withServer(hostWithView(view), async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const response = await fetch(new URL("/api/context-diff", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { ok: true; turns: ContextDiffView["turns"]; latest: ContextDiffView["latest"]; latestDiff: ContextDiffView["latestDiff"] };
		assert.equal(body.ok, true);
		assert.equal(body.turns.length, 2);
		assert.equal(body.turns[1]!.deltaTokens, view.turns[1]!.deltaTokens);
		assert.equal(body.latest?.diff.deltaTokens, view.latest?.diff.deltaTokens);
		assert.equal(body.latestDiff?.deltaTokens, view.latestDiff?.deltaTokens);
	});
});

test("GET /api/context-diff returns an empty view when no captures exist", async () => {
	const history = createContextDiffHistory();
	const view = getContextDiffView(history);

	await withServer(hostWithView(view), async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const response = await fetch(new URL("/api/context-diff", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { ok: true; turns: unknown[]; latest: unknown };
		assert.deepEqual(body.turns, []);
		assert.equal(body.latest, null);
	});
});

test("GET /api/context-diff requires the editor token", async () => {
	const history = createContextDiffHistory();
	const view = getContextDiffView(history);

	await withServer(hostWithView(view), async (server) => {
		const response = await fetch(new URL("/api/context-diff", server.url));
		assert.equal(response.status, 403);
	});
});
