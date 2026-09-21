import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import type { InstructionStateMutation, InstructionStateView } from "../src/instruction-state.ts";
import { startWebEditorServer, type WebEditorHost, type WebEditorServer } from "../src/web-editor/index.ts";

const sampleState: InstructionStateView = {
	guard: {
		sessionId: "session-1",
		leafId: "leaf-1",
		revision: "rev-1",
	},
	trusted: true,
	restoring: false,
	delivery: "prepared",
	textPresentation: "native",
	effectiveTools: ["read_file"],
	active: [
		{
			activationId: "act-1",
			source: "mode:test",
			name: "Test Mode",
			actor: "user",
			content: "You are in test mode.",
			tools: { add: [], remove: [] },
		},
	],
};

async function withServer(host: WebEditorHost, run: (server: WebEditorServer) => Promise<void>): Promise<void> {
	const server = await startWebEditorServer(host, { port: 0 });
	try {
		await run(server);
	} finally {
		await server.close();
	}
}

test("GET /api/instructions returns 200 with state and does not infer or mutate state", async () => {
	let readCount = 0;
	let mutateCount = 0;
	const host: WebEditorHost = {
		readInstructions: () => {
			readCount++;
			return { ok: true, state: sampleState };
		},
		mutateInstructions: () => {
			mutateCount++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const res = await fetch(new URL("/api/instructions", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(res.status, 200);
		const data = await res.json() as { ok: boolean; state: InstructionStateView };
		assert.equal(data.ok, true);
		assert.deepEqual(data.state, sampleState);
		assert.equal(readCount, 1, "readInstructions must be called exactly once");
		assert.equal(mutateCount, 0, "mutateInstructions must not be called during read");
	});
});

test("GET /api/instructions requires a valid editor token (403)", async () => {
	const host: WebEditorHost = {
		readInstructions: () => ({ ok: true, state: sampleState }),
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const unauth = await fetch(new URL("/api/instructions", server.url));
		assert.equal(unauth.status, 403);

		const wrongToken = await fetch(new URL("/api/instructions", server.url), {
			headers: { "x-pi-forge-token": "wrong-token" },
		});
		assert.equal(wrongToken.status, 403);
	});
});

test("GET /api/instructions returns 503 when capability is missing", async () => {
	const hostWithoutCapability: WebEditorHost = {} as unknown as WebEditorHost;

	await withServer(hostWithoutCapability, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const res = await fetch(new URL("/api/instructions", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(res.status, 503);
		const data = await res.json() as { ok?: boolean; error?: string };
		assert.equal(data.ok, false);
		assert.match(data.error ?? "", /Instruction runtime is unavailable/);
	});
});

test("POST /api/instructions executes valid mutation and returns 200 with updated state", async () => {
	let receivedMutation: unknown;
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: (mutation: unknown) => {
			receivedMutation = mutation;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const mutation: InstructionStateMutation = {
			action: "reset",
			guard: { sessionId: "session-1", leafId: null, revision: "rev-1" },
		};

		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});

		assert.equal(res.status, 200);
		const data = await res.json() as { ok: boolean; state: InstructionStateView };
		assert.equal(data.ok, true);
		assert.deepEqual(data.state, sampleState);
		assert.deepEqual(receivedMutation, mutation);
	});
});

test("POST /api/instructions handles off action with activationId", async () => {
	let receivedMutation: unknown;
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: (mutation: unknown) => {
			receivedMutation = mutation;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const mutation: InstructionStateMutation = {
			action: "off",
			activationId: "act-1",
			guard: { sessionId: "session-1", leafId: "leaf-1", revision: "rev-1" },
		};

		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});

		assert.equal(res.status, 200);
		assert.deepEqual(receivedMutation, mutation);
	});
});

test("POST /api/instructions requires a valid editor token (403)", async () => {
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: () => ({ ok: true, state: sampleState }),
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const mutation: InstructionStateMutation = {
			action: "reset",
			guard: { sessionId: "session-1", leafId: null, revision: "rev-1" },
		};
		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});
		assert.equal(res.status, 403);
	});
});

test("POST /api/instructions rejects untrusted project (403)", async () => {
	let mutateCalls = 0;
	const host: WebEditorHost = {
		isProjectTrusted: () => false,
		mutateInstructions: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const mutation: InstructionStateMutation = {
			action: "reset",
			guard: { sessionId: "session-1", leafId: null, revision: "rev-1" },
		};
		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});
		assert.equal(res.status, 403);
		const data = await res.json() as { ok?: boolean; error?: string };
		assert.equal(data.ok, false);
		assert.match(data.error ?? "", /Project is not trusted/);
		assert.equal(mutateCalls, 0, "must not execute mutation when project is untrusted");
	});
});

test("POST /api/instructions rejects bad bodies with 400 (no arbitrary text/use, no extra fields)", async () => {
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: () => ({ ok: true, state: sampleState }),
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const post = async (body: unknown) => {
			return fetch(new URL("/api/instructions", server.url), {
				method: "POST",
				headers: { "x-pi-forge-token": token, "content-type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
		};

		// 1. Invalid JSON
		const badJson = await post("{invalid json");
		assert.equal(badJson.status, 400);

		// 2. Empty object
		const empty = await post({});
		assert.equal(empty.status, 400);

		// 3. Arbitrary 'use' action
		const useAction = await post({
			action: "use",
			mode: "custom-mode",
			guard: { sessionId: "s1", leafId: null, revision: "r1" },
		});
		assert.equal(useAction.status, 400);

		// 4. Arbitrary 'text' action
		const textAction = await post({
			action: "text",
			text: "do something",
			guard: { sessionId: "s1", leafId: null, revision: "r1" },
		});
		assert.equal(textAction.status, 400);

		// 5. Extra fields in root
		const extraRoot = await post({
			action: "reset",
			guard: { sessionId: "s1", leafId: null, revision: "r1" },
			unauthorizedExtra: "bad",
		});
		assert.equal(extraRoot.status, 400);

		// 6. Incomplete guard (missing revision)
		const missingRevision = await post({
			action: "reset",
			guard: { sessionId: "s1", leafId: null },
		});
		assert.equal(missingRevision.status, 400);

		// 7. Extra fields in guard
		const extraGuard = await post({
			action: "reset",
			guard: { sessionId: "s1", leafId: null, revision: "r1", extra: 123 },
		});
		assert.equal(extraGuard.status, 400);

		// 8. Action off missing activationId
		const missingActivation = await post({
			action: "off",
			guard: { sessionId: "s1", leafId: null, revision: "r1" },
		});
		assert.equal(missingActivation.status, 400);
	});
});

test("POST /api/instructions returns runtime 409 conflict as-is without retry", async () => {
	let mutateCallCount = 0;
	let receivedGuard: unknown;
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: (input: unknown) => {
			mutateCallCount++;
			receivedGuard = (input as InstructionStateMutation).guard;
			return {
				ok: false,
				status: 409,
				error: "Instruction state guard revision mismatch: expected rev-2, got rev-1.",
			};
		},
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const mutation: InstructionStateMutation = {
			action: "reset",
			guard: { sessionId: "session-1", leafId: "leaf-old", revision: "rev-1" },
		};

		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});

		assert.equal(res.status, 409);
		const data = await res.json() as { ok?: boolean; error?: string };
		assert.equal(data.ok, false);
		assert.match(data.error ?? "", /Instruction state guard revision mismatch/);
		assert.equal(mutateCallCount, 1, "must not auto-retry on 409 conflict");
		assert.deepEqual(receivedGuard, mutation.guard, "guard must not be truncated");
	});
});

test("POST /api/instructions returns 503 when capability is missing", async () => {
	const host: WebEditorHost = {
		isProjectTrusted: () => true,
	} as unknown as WebEditorHost;

	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const mutation: InstructionStateMutation = {
			action: "reset",
			guard: { sessionId: "session-1", leafId: null, revision: "rev-1" },
		};
		const res = await fetch(new URL("/api/instructions", server.url), {
			method: "POST",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify(mutation),
		});
		assert.equal(res.status, 503);
		const data = await res.json() as { ok?: boolean; error?: string };
		assert.equal(data.ok, false);
		assert.match(data.error ?? "", /Instruction runtime is unavailable/);
	});
});

test("race condition: updateHost during segmented POST body only executes new host (not old session)", async () => {
	let oldHostCalls = 0;
	let newHostCalls = 0;
	let newHostReceived: unknown;

	const oldHost: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: () => {
			oldHostCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebEditorHost;

	const newHostState: InstructionStateView = {
		...sampleState,
		guard: { sessionId: "session-new", leafId: null, revision: "rev-new" },
	};

	const newHost: WebEditorHost = {
		isProjectTrusted: () => true,
		mutateInstructions: (input: unknown) => {
			newHostCalls++;
			newHostReceived = input;
			return { ok: true, state: newHostState };
		},
	} as unknown as WebEditorHost;

	await withServer(oldHost, async (server) => {
		const parsedUrl = new URL(server.url);
		const token = parsedUrl.searchParams.get("token")!;

		const responsePromise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
			const req = http.request(
				{
					hostname: parsedUrl.hostname,
					port: parsedUrl.port,
					path: "/api/instructions",
					method: "POST",
					headers: {
						"x-pi-forge-token": token,
						"content-type": "application/json",
						"transfer-encoding": "chunked",
						"expect": "100-continue",
					},
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => { data += chunk; });
					res.on("end", () => {
						resolve({ statusCode: res.statusCode ?? 0, body: data });
					});
				},
			);
			req.on("error", reject);

			req.once("continue", () => {
				// The server has entered this request and is awaiting its body.
				req.write('{"action":"reset",');
				server.updateHost(newHost);
				req.end('"guard":{"sessionId":"session-new","leafId":null,"revision":"rev-new"}}');
			});
			req.flushHeaders();
		});

		const result = await responsePromise;
		assert.equal(result.statusCode, 200);
		const parsed = JSON.parse(result.body) as { ok: boolean; state: InstructionStateView };
		assert.equal(parsed.ok, true);
		assert.equal(parsed.state.guard.sessionId, "session-new");

		// Crucial assertions:
		assert.equal(oldHostCalls, 0, "old host must NOT have received mutation");
		assert.equal(newHostCalls, 1, "new host must have received mutation");
		assert.deepEqual(
			newHostReceived,
			{
				action: "reset",
				guard: { sessionId: "session-new", leafId: null, revision: "rev-new" },
			},
		);
	});
});
