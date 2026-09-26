import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCapabilityAgentHarness, type CapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
import { startWebEditorServer, type WebEditorHost } from "../src/web-editor/index.ts";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

function httpRequest<T = any>(
	urlStr: string,
	options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; json: () => T }> {
	return new Promise((resolve, reject) => {
		const target = new URL(urlStr);
		const reqOptions: http.RequestOptions = {
			hostname: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method: options.method || "GET",
			headers: { ...(options.headers || {}) },
		};
		let payload: string | undefined;
		if (options.body !== undefined) {
			payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
			reqOptions.headers = { ...reqOptions.headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() };
		}
		const req = http.request(reqOptions, (res) => {
			let chunks = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { chunks += c; });
			res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: chunks, json: () => JSON.parse(chunks) }));
		});
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

function setupHermeticProject() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-inst-web-"));
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ autoActivate: true }, null, 2));

	const stackDir = join(cwd, ".pi", "forge", "prompt-stacks");
	mkdirSync(stackDir, { recursive: true });
	writeFileSync(join(stackDir, "base.json"), JSON.stringify({
		schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "Base Stack", autoActivate: true,
		items: [{ kind: "block", id: "sys1", role: "system", content: "Base preset content" }],
	}, null, 2));

	const capabilitiesDir = join(cwd, ".pi", "forge", "capabilities");
	mkdirSync(capabilitiesDir, { recursive: true });
	writeFileSync(join(capabilitiesDir, "review.json"), JSON.stringify({
		schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
		content: "Review content", tools: { add: [], remove: ["fake_write"] },
	}, null, 2));

	return { cwd, cleanup() { try { rmSync(cwd, { recursive: true, force: true }); } catch {} } };
}

async function openPresetUi(harness: CapabilityAgentHarness, cwd: string): Promise<{ port: number; token: string }> {
	let stdoutUrl = "";
	const origLog = console.log;
	console.log = (...args: any[]) => {
		const match = args.join(" ").match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/);
		if (match) stdoutUrl = match[0];
	};
	try { await harness.prompt("/preset ui"); } finally { console.log = origLog; }
	const registry = (globalThis as any).__piForgeWebEditor;
	const server = registry?.byCwd?.[cwd]?.server;
	const parsedUrl = new URL(stdoutUrl || server?.url);
	const token = parsedUrl.searchParams.get("token");
	assert.ok(token, "token must exist in server url");
	return { port: Number(parsedUrl.port), token };
}

async function closePresetUi(harness: CapabilityAgentHarness): Promise<void> {
	const origLog = console.log;
	console.log = () => {};
	try { await harness.prompt("/preset ui stop"); } catch {} finally { console.log = origLog; }
}

test("Capability Mode Web API Suite", async (suite) => {
	const env = setupHermeticProject();
	const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });

	const globalStacksDir = join(process.env.PI_FORGE_GLOBAL_DIR!, "prompt-stacks");
	mkdirSync(globalStacksDir, { recursive: true });
	writeFileSync(join(globalStacksDir, "global-base.json"), JSON.stringify({
		schemaVersion: 2, type: "pi-forge.prompt-stack", id: "global-base",
		items: [{ kind: "block", id: "gb1", role: "system", content: "global base" }],
	}, null, 2));
	await harness.prompt("/preset reload");

	const { port, token } = await openPresetUi(harness, env.cwd);
	const base = `http://127.0.0.1:${port}/api/capabilities`;
	const auth = { "x-pi-forge-token": token };

	const entriesBefore = harness.session.sessionManager.getEntries().length;
	const toolsBefore = harness.getActiveToolNames();
	const inferencesBefore = harness.streamContexts.length;

	try {
		await suite.test("1. token required, qualified route selector, and unknown/traversal rejection", async () => {
			assert.equal((await httpRequest(base, { method: "GET" })).status, 403);
			assert.equal((await httpRequest(base, { method: "GET", headers: { "x-pi-forge-token": "bad-token" } })).status, 403);

			const bareSelector = await httpRequest(`${base}/review`, { headers: auth });
			assert.equal(bareSelector.status, 400);
			assert.match(bareSelector.json().error, /qualified capability selector is required/i);

			assert.equal((await httpRequest(`${base}/project:..%2Fevil`, { headers: auth })).status, 400);
			assert.equal((await httpRequest(`${base}/project:nonexistent`, { headers: auth })).status, 404);
		});

		await suite.test("2. CRUD scoped revision conflicts, invalid schemas, and isolation of legacy carrier/history/tools/agentStarts", async () => {
			const listRes = await httpRequest(base, { headers: auth });
			assert.equal(listRes.status, 200);
			assert.equal(listRes.json().trusted, true);
			const review = listRes.json().capabilities.find((m: any) => m.selector === "project:review");
			assert.ok(review);
			assert.match(review.sourceRevision, /^[a-f0-9]{64}$/);

			const extraKey = await httpRequest(base, { method: "POST", headers: auth, body: { scope: "project", capability: { id: "bad" }, extra: 123 } });
			assert.equal(extraKey.status, 400);
			const badId = await httpRequest(base, { method: "POST", headers: auth, body: { scope: "project", capability: { id: "bad/id" } } });
			assert.equal(badId.status, 400);

			const validMode = {
				schemaVersion: 1, type: "pi-forge.capability", id: "custom", name: "Custom Mode",
				content: "Custom Content", tools: { add: ["fake_read"], remove: [] },
			};
			const createRes = await httpRequest(base, { method: "POST", headers: auth, body: { scope: "project", capability: validMode } });
			assert.equal(createRes.status, 200);
			assert.equal(createRes.json().ok, true);
			assert.equal(createRes.json().changed, "project:custom");
			assert.match(createRes.json().sourceRevision, /^[a-f0-9]{64}$/);

			assert.equal((await httpRequest(base, { method: "POST", headers: auth, body: { scope: "project", capability: validMode } })).status, 409);

			const getRes = await httpRequest(`${base}/project:custom`, { headers: auth });
			assert.equal(getRes.status, 200);
			assert.equal(getRes.json().selector, "project:custom");
			const rev1 = getRes.json().sourceRevision;
			assert.match(rev1, /^[a-f0-9]{64}$/);

			const renameRes = await httpRequest(`${base}/project:custom`, {
				method: "PUT", headers: auth, body: { capability: { ...validMode, id: "renamed" }, expectedSourceRevision: rev1 },
			});
			assert.equal(renameRes.status, 400);
			assert.match(renameRes.json().error, /Capability ID is immutable/i);

			const badRev = await httpRequest(`${base}/project:custom`, {
				method: "PUT", headers: auth, body: { capability: validMode, expectedSourceRevision: "short" },
			});
			assert.equal(badRev.status, 400);

			const revConflict = await httpRequest(`${base}/project:custom`, {
				method: "PUT", headers: auth, body: { capability: { ...validMode, content: "Updated" }, expectedSourceRevision: "f".repeat(64) },
			});
			assert.equal(revConflict.status, 409);

			const saveRes = await httpRequest(`${base}/project:custom`, {
				method: "PUT", headers: auth, body: { capability: { ...validMode, content: "Updated Custom Content" }, expectedSourceRevision: rev1 },
			});
			assert.equal(saveRes.status, 200);
			assert.equal(saveRes.json().ok, true);
			assert.equal(saveRes.json().changed, "project:custom");
			assert.match(saveRes.json().sourceRevision, /^[a-f0-9]{64}$/);

			const getRes2 = await httpRequest(`${base}/project:custom`, { headers: auth });
			assert.equal(getRes2.status, 200);
			assert.equal(getRes2.json().capability.content, "Updated Custom Content");
			const rev2 = getRes2.json().sourceRevision;
			assert.notEqual(rev2, rev1);

			const delConflict = await httpRequest(`${base}/project:custom`, { method: "DELETE", headers: auth, body: { expectedSourceRevision: rev1 } });
			assert.equal(delConflict.status, 409);

			const delRes = await httpRequest(`${base}/project:custom`, { method: "DELETE", headers: auth, body: { expectedSourceRevision: rev2 } });
			assert.equal(delRes.status, 200);
			assert.deepEqual(delRes.json(), { ok: true, changed: "project:custom" });

			assert.equal((await httpRequest(`${base}/project:custom`, { headers: auth })).status, 404);

			assert.equal(harness.session.sessionManager.getEntries().length, entriesBefore, "session history must be unchanged");
			assert.deepEqual(harness.getActiveToolNames(), toolsBefore, "active tools must be unchanged");
			assert.equal(harness.streamContexts.length, inferencesBefore, "no inference may be triggered");
		});

		await suite.test("3. trust on mutation and list filtering when project untrusted", async () => {
			harness.settingsManager.isProjectTrusted = () => false;

			const createRes = await httpRequest(base, {
				method: "POST", headers: auth, body: { scope: "project", capability: { id: "blocked", content: "x", tools: { add: [], remove: [] } } },
			});
			assert.equal(createRes.status, 403);

			const saveRes = await httpRequest(`${base}/project:review`, {
				method: "PUT", headers: auth, body: { capability: { id: "review" }, expectedSourceRevision: "f".repeat(64) },
			});
			assert.equal(saveRes.status, 403);

			const delRes = await httpRequest(`${base}/project:review`, {
				method: "DELETE", headers: auth, body: { expectedSourceRevision: "f".repeat(64) },
			});
			assert.equal(delRes.status, 403);

			const listRes = await httpRequest(base, { headers: auth });
			assert.equal(listRes.status, 200);
			assert.equal(listRes.json().trusted, false);
			assert.equal(listRes.json().capabilities.length, 0);

			harness.settingsManager.isProjectTrusted = () => true;
		});

		await suite.test("4. effective preview validates qualified preset scope, overrides, modelCallable, and missing source", async () => {
			const effectiveUrl = `${base}/effective`;

			const missingFields = await httpRequest(effectiveUrl, { method: "POST", headers: auth, body: { presetSelector: "project:base" } });
			assert.equal(missingFields.status, 400);

			const unqualifiedPreset = await httpRequest(effectiveUrl, { method: "POST", headers: auth, body: { presetSelector: "base", bindings: [] } });
			assert.equal(unqualifiedPreset.status, 404);

			const missingPreset = await httpRequest(effectiveUrl, { method: "POST", headers: auth, body: { presetSelector: "project:nonexistent", bindings: [] } });
			assert.equal(missingPreset.status, 404);

			const missingSource = await httpRequest(effectiveUrl, {
				method: "POST", headers: auth, body: { presetSelector: "project:base", bindings: [{ ref: "project:missing" }] },
			});
			assert.equal(missingSource.status, 400);
			assert.match(missingSource.json().error, /not found/i);

			const globalCrossScope = await httpRequest(effectiveUrl, {
				method: "POST", headers: auth, body: { presetSelector: "global:global-base", bindings: [{ ref: "project:review" }] },
			});
			assert.equal(globalCrossScope.status, 400);
			assert.match(globalCrossScope.json().error, /Global binding cannot reference project/i);

			const validRes = await httpRequest(effectiveUrl, {
				method: "POST",
				headers: auth,
				body: {
					presetSelector: "project:base",
					bindings: [{ ref: "project:review", modelCallable: true, overrides: { appendContent: " OVERRIDDEN", tools: { add: ["fake_read"] } } }],
				},
			});
			assert.equal(validRes.status, 200);
			const bindings = validRes.json().bindings;
			assert.equal(bindings.length, 1);
			assert.equal(bindings[0].id, "review");
			assert.equal(bindings[0].ref, "project:review");
			assert.equal(bindings[0].modelCallable, true);
			assert.equal(bindings[0].source.content, "Review content");
			assert.equal(bindings[0].effective.content, "Review content\n\n OVERRIDDEN");
			assert.deepEqual(bindings[0].effective.tools.add, ["fake_read"]);
			assert.deepEqual(bindings[0].effective.tools.remove, ["fake_write"]);
		});
	} finally {
		await closePresetUi(harness);
		env.cleanup();
	}

	await suite.test("5. HTTP delayed-body current-host test executes against new host upon updateHost", async () => {
		let oldHostCalls = 0;
		let newHostCalls = 0;
		let newHostReceived: unknown;

		const oldHost = {
			isProjectTrusted: () => true,
			capabilityOperation: () => { oldHostCalls++; return { ok: true, changed: "project:old" }; },
		} as unknown as WebEditorHost;

		const newHost = {
			isProjectTrusted: () => true,
			capabilityOperation: (action: string, selector: string, input: unknown) => {
				newHostCalls++;
				newHostReceived = { action, selector, input };
				return { ok: true, changed: "project:new" };
			},
		} as unknown as WebEditorHost;

		const server = await startWebEditorServer(oldHost, { port: 0 });
		try {
			const parsedUrl = new URL(server.url);
			const srvToken = parsedUrl.searchParams.get("token")!;

			const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
				const req = http.request(
					{
						hostname: parsedUrl.hostname,
						port: parsedUrl.port,
						path: "/api/capabilities",
						method: "POST",
						headers: {
							"x-pi-forge-token": srvToken,
							"content-type": "application/json",
							"transfer-encoding": "chunked",
							"expect": "100-continue",
						},
					},
					(incoming) => {
						let data = "";
						incoming.on("data", (chunk) => { data += chunk; });
						incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body: data }));
					},
				);
				req.on("error", reject);
				req.once("continue", () => {
					req.write('{"scope":"project",');
					server.updateHost(newHost);
					req.end('"capability":{"schemaVersion":1,"type":"pi-forge.capability","id":"test","content":"c","tools":{"add":[],"remove":[]}}}');
				});
				req.flushHeaders();
			});

			assert.equal(res.statusCode, 200);
			assert.equal(oldHostCalls, 0, "old host must not be called after updateHost");
			assert.equal(newHostCalls, 1, "new host must receive the operation");
			assert.equal((newHostReceived as any)?.action, "create");
			assert.equal((newHostReceived as any)?.input?.capability?.id, "test");
		} finally {
			await server.close();
		}
	});
});
