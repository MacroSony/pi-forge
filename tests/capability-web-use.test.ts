import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isCapabilityEnableRequest, type CapabilityEnableRequest } from "../src/capability-state.ts";
import { createCapabilityAgentHarness, type CapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
import { ForgeWorkspace } from "../src/workspace.ts";
import { createCapabilityRuntime } from "../src/runtime/capability-runtime.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const request: CapabilityEnableRequest = {
	guard: { sessionId: "session-1", leafId: "leaf-1", revision: "sha256:v1:test" },
	kind: "capability", id: "project:review", fingerprint: "sha256:v1:candidate",
};

test("human instruction activation accepts only its guarded four-field payload", () => {
	assert.equal(isCapabilityEnableRequest(request), true);
	assert.equal(isCapabilityEnableRequest({ ...request, patch: "arbitrary" }), false);
	assert.equal(isCapabilityEnableRequest({ ...request, path: ".pi/forge/capabilities/x.json" }), false);
	assert.equal(isCapabilityEnableRequest({ ...request, guard: { ...request.guard, revision: "" } }), false);
});

test("human activation validates kind and semantic fingerprint fields before resource resolution", () => {
	assert.equal(isCapabilityEnableRequest({ ...request, id: "review" }), true);
	assert.equal(isCapabilityEnableRequest({ ...request, fingerprint: "" }), false);
	assert.equal(isCapabilityEnableRequest({ ...request, kind: "other" }), false);
});

function httpRequest<T = any>(urlStr: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; json: () => T }> {
	return new Promise((resolve, reject) => {
		const target = new URL(urlStr);
		const reqOptions: http.RequestOptions = { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method || "GET", headers: { ...(options.headers || {}) } };
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
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-use-web-"));
	mkdirSync(join(cwd, ".pi", "forge", "prompt-stacks"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "forge", "capabilities"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ autoActivate: true }, null, 2));
	writeFileSync(join(cwd, ".pi", "forge", "prompt-stacks", "base.json"), JSON.stringify({
		schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "Base Stack", autoActivate: true,
		items: [{ kind: "block", id: "sys1", role: "system", content: "Base preset content" }],
		capabilities: [{ ref: "review", id: "review-bound", modelCallable: false }],
	}, null, 2));
	writeFileSync(join(cwd, ".pi", "forge", "capabilities", "review.json"), JSON.stringify({
		schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
		content: "Review capability content", tools: { add: [], remove: ["fake_write"] },
	}, null, 2));
	return { cwd, capabilitiesDir: join(cwd, ".pi", "forge", "capabilities"), cleanup() { try { rmSync(cwd, { recursive: true, force: true }); } catch {} } };
}

async function openPresetUi(harness: CapabilityAgentHarness, cwd: string): Promise<{ port: number; token: string }> {
	let stdoutUrl = "";
	const origLog = console.log;
	console.log = (...args: any[]) => {
		const match = args.join(" ").match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/);
		if (match) stdoutUrl = match[0];
	};
	try { await harness.prompt("/preset ui"); } finally { console.log = origLog; }
	const parsedUrl = new URL(stdoutUrl || (globalThis as any).__piForgeWebEditor?.byCwd?.[cwd]?.server?.url);
	const token = parsedUrl.searchParams.get("token");
	assert.ok(token, "token must exist in server url");
	return { port: Number(parsedUrl.port), token };
}

async function closePresetUi(harness: CapabilityAgentHarness): Promise<void> {
	const origLog = console.log;
	console.log = () => {};
	try { await harness.prompt("/preset ui stop"); } catch {} finally { console.log = origLog; await harness.dispose(); }
}

function createFakeEnv(cwd: string) {
	const branchEntries: any[] = [];
	const fakePi: any = {
		getActiveTools: () => ["fake_write", "fake_read", "forge_capability"],
		getAllTools: () => [{ name: "fake_write" }, { name: "fake_read" }, { name: "forge_capability" }],
		setActiveTools: () => {}, appendEntry: (t: string, d: any) => { branchEntries.push({ type: "custom", customType: t, data: d }); },
		events: { on: () => () => {}, emit: () => {} },
	};
	const fakeContext: any = {
		cwd, isProjectTrusted: () => true, isIdle: () => true,
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } },
		sessionManager: {
			getBranch: () => branchEntries,
			appendCustomEntry: (e: any) => branchEntries.push(e),
			getSessionId: () => "s1", getLeafId: () => "l1",
		},
	};
	return { fakePi, fakeContext };
}

test("Capability Web Use HTTP & SDK Suite", async (suite) => {
	const env = setupHermeticProject();
	const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: true });
	const { port, token } = await openPresetUi(harness, env.cwd);
	const availUrl = `http://127.0.0.1:${port}/api/capability-state/available`;
	const useUrl = `http://127.0.0.1:${port}/api/capability-state/enable`;
	const mutateUrl = `http://127.0.0.1:${port}/api/capability-state`;
	const auth = { "x-pi-forge-token": token };

	try {
		await suite.test("token required and untrusted project rejects available and use (403)", async () => {
			assert.equal((await httpRequest(availUrl)).status, 403);
			assert.equal((await httpRequest(availUrl, { headers: { "x-pi-forge-token": "bad" } })).status, 403);
			assert.equal((await httpRequest(useUrl, { method: "POST", body: request })).status, 403);
			assert.equal((await httpRequest(useUrl, { method: "POST", headers: { "x-pi-forge-token": "bad" }, body: request })).status, 403);

			harness.settingsManager.isProjectTrusted = () => false;
			assert.equal((await httpRequest(availUrl, { headers: auth })).status, 403);
			assert.equal((await httpRequest(useUrl, { method: "POST", headers: auth, body: request })).status, 403);
			harness.settingsManager.isProjectTrusted = () => true;
		});

		await suite.test("native choices include unbound and bound (modelCallable false human-allowed), explicit use removes fake_write, off restores tools, 0 inferences", async () => {
			const initialInferences = harness.streamContexts.length;
			assert.ok(harness.getActiveToolNames().includes("fake_write"));

			const availRes = await httpRequest(availUrl, { headers: auth });
			assert.equal(availRes.status, 200);
			const { state, choices } = availRes.json();
			assert.equal(state.textPresentation, "native");
			assert.equal(state.active.length, 0);

			const unboundChoice = choices.find((c: any) => c.kind === "capability" && c.id === "project:review");
			assert.ok(unboundChoice);
			assert.match(unboundChoice.fingerprint, /^sha256:/);

			const boundChoice = choices.find((c: any) => c.kind === "binding" && c.id === "review-bound");
			assert.ok(boundChoice);
			assert.match(boundChoice.fingerprint, /^sha256:/);

			// Explicit human activation of bound choice (even though modelCallable is false)
			const enableBoundRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: state.guard, kind: "binding", id: "review-bound", fingerprint: boundChoice.fingerprint },
			});
			assert.equal(enableBoundRes.status, 200);
			const boundState = enableBoundRes.json().state;
			assert.equal(boundState.active.length, 1);
			assert.ok(!harness.getActiveToolNames().includes("fake_write"), "explicit use must remove fake_write");
			assert.ok(!boundState.effectiveTools.includes("fake_write"));

			// Off restores fake_write
			const offRes = await httpRequest(mutateUrl, {
				method: "POST", headers: auth,
				body: { action: "disable", activationId: boundState.active[0].activationId, guard: boundState.guard },
			});
			assert.equal(offRes.status, 200);
			assert.ok(harness.getActiveToolNames().includes("fake_write"), "off must restore fake_write");
			assert.equal(offRes.json().state.active.length, 0);

			// Explicit human activation of unbound capability
			const freshAvail = await httpRequest(availUrl, { headers: auth });
			const useModeRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: freshAvail.json().state.guard, kind: "capability", id: "project:review", fingerprint: unboundChoice.fingerprint },
			});
			assert.equal(useModeRes.status, 200);
			assert.ok(!harness.getActiveToolNames().includes("fake_write"));

			// Turn off again
			const offRes2 = await httpRequest(mutateUrl, {
				method: "POST", headers: auth,
				body: { action: "disable", activationId: useModeRes.json().state.active[0].activationId, guard: useModeRes.json().state.guard },
			});
			assert.equal(offRes2.status, 200);
			assert.ok(harness.getActiveToolNames().includes("fake_write"));
			assert.equal(harness.streamContexts.length, initialInferences, "management has zero provider calls");
		});

		await suite.test("source snapshots immutable: disk edit after activation does not mutate active content", async () => {
			const availRes = await httpRequest(availUrl, { headers: auth });
			const unboundChoice = availRes.json().choices.find((c: any) => c.kind === "capability" && c.id === "project:review");

			const useRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: availRes.json().state.guard, kind: "capability", id: "project:review", fingerprint: unboundChoice.fingerprint },
			});
			assert.equal(useRes.status, 200);
			assert.equal(useRes.json().state.active[0].content, "Review capability content");

			const reviewPath = join(env.capabilitiesDir, "review.json");
			writeFileSync(reviewPath, JSON.stringify({
				schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
				content: "CHANGED_AFTER_ACTIVATION", tools: { add: [], remove: ["fake_write"] },
			}, null, 2));

			const checkState = await httpRequest(availUrl, { headers: auth });
			assert.equal(checkState.json().state.active[0].content, "Review capability content");

			writeFileSync(reviewPath, JSON.stringify({
				schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
				content: "Review capability content", tools: { add: [], remove: ["fake_write"] },
			}, null, 2));
			await httpRequest(mutateUrl, {
				method: "POST", headers: auth,
				body: { action: "disable", activationId: checkState.json().state.active[0].activationId, guard: checkState.json().state.guard },
			});
		});

		await suite.test("stale semantic fingerprint after actual capability file edit returns 409", async () => {
			const availRes = await httpRequest(availUrl, { headers: auth });
			const unboundChoice = availRes.json().choices.find((c: any) => c.kind === "capability" && c.id === "project:review");
			const oldFingerprint = unboundChoice.fingerprint;

			const reviewPath = join(env.capabilitiesDir, "review.json");
			writeFileSync(reviewPath, JSON.stringify({
				schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
				content: "Different content for fingerprint change", tools: { add: [], remove: ["fake_write"] },
			}, null, 2));

			const useRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: availRes.json().state.guard, kind: "capability", id: "project:review", fingerprint: oldFingerprint },
			});
			assert.equal(useRes.status, 409);
			assert.match(useRes.json().error, /Capability source changed/i);

			writeFileSync(reviewPath, JSON.stringify({
				schemaVersion: 1, type: "pi-forge.capability", id: "review", name: "Review Mode",
				content: "Review capability content", tools: { add: [], remove: ["fake_write"] },
			}, null, 2));
		});

		await suite.test("stale guard after manual CLI activity or binding reload returns 409", async () => {
			const availRes = await httpRequest(availUrl, { headers: auth });
			const oldGuard = availRes.json().state.guard;
			const unboundChoice = availRes.json().choices.find((c: any) => c.kind === "capability" && c.id === "project:review");

			// 1. Manual CLI activity
			await harness.prompt("/capability add MANUAL_CLI_TEST");
			const useResCli = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: oldGuard, kind: "capability", id: "project:review", fingerprint: unboundChoice.fingerprint },
			});
			assert.equal(useResCli.status, 409);
			assert.match(useResCli.json().error, /Session, branch or capability state changed/i);

			// Reset manual instruction
			const freshAvail = await httpRequest(availUrl, { headers: auth });
			await httpRequest(mutateUrl, {
				method: "POST", headers: auth,
				body: { action: "reset", guard: freshAvail.json().state.guard },
			});

			// 2. Binding reload
			const guardBeforeReload = (await httpRequest(availUrl, { headers: auth })).json().state.guard;
			const stackPath = join(env.cwd, ".pi", "forge", "prompt-stacks", "base.json");
			writeFileSync(stackPath, JSON.stringify({
				schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "Base Stack", autoActivate: true,
				items: [{ kind: "block", id: "sys1", role: "system", content: "Base preset content" }],
				capabilities: [{ ref: "review", id: "review-bound", modelCallable: true }],
			}, null, 2));
			await harness.prompt("/preset reload");

			const useResReload = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: guardBeforeReload, kind: "capability", id: "project:review", fingerprint: unboundChoice.fingerprint },
			});
			assert.equal(useResReload.status, 409);
			assert.match(useResReload.json().error, /Session, branch or capability state changed/i);
		});

		await suite.test("no writes on all rejects and malformed checks (400, 404, 409)", async () => {
			const availRes = await httpRequest(availUrl, { headers: auth });
			const currentGuard = availRes.json().state.guard;
			const choice = availRes.json().choices.find((c: any) => c.id === "project:review");
			const entriesBefore = harness.session.sessionManager.getEntries().length;
			const toolsBefore = harness.getActiveToolNames();

			// 400: Extra property
			const extraRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: currentGuard, kind: "capability", id: "project:review", fingerprint: choice.fingerprint, extra: 123 },
			});
			assert.equal(extraRes.status, 400);

			// 400: Invalid kind
			const kindRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: currentGuard, kind: "unknown", id: "project:review", fingerprint: choice.fingerprint },
			});
			assert.equal(kindRes.status, 400);

			// 400: Empty fingerprint
			const fpRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: currentGuard, kind: "capability", id: "project:review", fingerprint: "" },
			});
			assert.equal(fpRes.status, 400);

			// 409: Unqualified capability ID
			const unqualRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: currentGuard, kind: "capability", id: "review", fingerprint: choice.fingerprint },
			});
			assert.equal(unqualRes.status, 409);
			assert.match(unqualRes.json().error, /qualified resource IDs/i);

			// 409: Nonexistent capability
			const nonExistRes = await httpRequest(useUrl, {
				method: "POST", headers: auth,
				body: { guard: currentGuard, kind: "capability", id: "project:nonexistent", fingerprint: choice.fingerprint },
			});
			assert.equal(nonExistRes.status, 409);

			assert.equal(harness.session.sessionManager.getEntries().length, entriesBefore, "entries must not change on rejects");
			assert.deepEqual(harness.getActiveToolNames(), toolsBefore, "tools must not change on rejects");
			const stateAfter = (await httpRequest(availUrl, { headers: auth })).json().state;
			assert.equal(stateAfter.active.length, 0, "active instructions must remain 0");
		});
	} finally {
		await closePresetUi(harness);
		env.cleanup();
	}
});

test("fallback choices discover textPresentation user with bound and unbound choices", async () => {
	const env = setupHermeticProject();
	const harness = await createCapabilityAgentHarness({ cwd: env.cwd, native: false });
	const { port, token } = await openPresetUi(harness, env.cwd);
	try {
		const res = await httpRequest(`http://127.0.0.1:${port}/api/capability-state/available`, { headers: { "x-pi-forge-token": token } });
		assert.equal(res.status, 200);
		assert.equal(res.json().state.textPresentation, "user");
		assert.equal(res.json().choices.length, 2);
	} finally {
		await closePresetUi(harness);
		env.cleanup();
	}
});

test("disposed instruction runtime rejects executeAgentTool, enableBound, and enableCapability", async () => {
	const env = setupHermeticProject();
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(env.cwd, { trusted: true });
		const { fakePi, fakeContext } = createFakeEnv(env.cwd);
		const toolPolicy = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
		const runtime = createCapabilityRuntime(fakePi, workspace, toolPolicy);
		runtime.dispose();

		await assert.rejects(async () => runtime.executeAgentTool(fakeContext, { action: "list" }), /unavailable for this session/i);

		const boundRes = runtime.enableBound(fakeContext, "review-bound", "user");
		assert.equal(boundRes.ok, false);
		assert.match(boundRes.error, /no longer active for this session/i);

		const useRes = runtime.enableCapability({
			guard: { sessionId: "s1", leafId: "l1", revision: "sha256:v1:test" },
			kind: "capability", id: "project:review", fingerprint: "sha256:v1:test",
		});
		assert.equal(useRes.ok, false);
		assert.equal((useRes as any).status, 503);

		const availRes = runtime.readAvailableCapabilities();
		assert.equal(availRes.ok, false);
		assert.equal((availRes as any).status, 503);
	} finally {
		env.cleanup();
	}
});

test("guarded resolver reentry via workspace.subscribe changes preset during reload", async () => {
	const env = setupHermeticProject();
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(env.cwd, { trusted: true });
		const { fakePi, fakeContext } = createFakeEnv(env.cwd);
		const toolPolicy = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
		const runtime = createCapabilityRuntime(fakePi, workspace, toolPolicy);

		let reloaded = false;
		const unsubscribe = workspace.subscribe(() => {
			if (!reloaded) {
				reloaded = true;
				workspace.reload(env.cwd, { activeStackId: "none" });
			}
		});

		const bindingsRes = runtime.readBindings(fakeContext);
		assert.equal(bindingsRes.ok, false);
		assert.match((bindingsRes as any).error, /Active preset changed while resolving capability bindings/i);

		unsubscribe();
	} finally {
		env.cleanup();
	}
});


test("human use rechecks the displayed guard after its final resource read", () => {
 const env=setupHermeticProject();
 try {
  const workspace=new ForgeWorkspace(); workspace.reload(env.cwd,{trusted:true});
  const {fakePi,fakeContext}=createFakeEnv(env.cwd);
  const runtime=createCapabilityRuntime(fakePi,workspace,createToolPolicyRuntime(fakePi,()=>workspace.snapshot().active));
  runtime.restore(fakeContext);
  const available=runtime.readAvailableCapabilities(); assert.equal(available.ok,true); if(!available.ok)return;
  const selected=available.choices.find(c=>c.kind==="capability")!;
  const before=JSON.stringify(fakeContext.sessionManager.getBranch());
  let reads=0;
  const unsubscribe=workspace.subscribe(()=>{
   if (++reads===2) workspace.reload(env.cwd,{trusted:true,activeStackId:"none"});
  });
  const result=runtime.enableCapability({guard:available.state.guard,kind:selected.kind,id:selected.id,fingerprint:selected.fingerprint});
  unsubscribe(); assert.equal(result.ok,false); if(!result.ok)assert.equal(result.status,409);
  assert.equal(JSON.stringify(fakeContext.sessionManager.getBranch()),before);
 } finally {env.cleanup();}
});


test("retired CLI cannot revive an instruction runtime or write through a foreign session", () => {
 const env=setupHermeticProject(); try {
  const workspace=new ForgeWorkspace(); workspace.reload(env.cwd,{trusted:true});
  const {fakePi,fakeContext}=createFakeEnv(env.cwd);
  const runtime=createCapabilityRuntime(fakePi,workspace,createToolPolicyRuntime(fakePi,()=>workspace.snapshot().active));
  runtime.restore(fakeContext);
  const before=JSON.stringify(fakeContext.sessionManager.getBranch());
  const foreign={...fakeContext,sessionManager:{...fakeContext.sessionManager,getSessionId:()=>"foreign"}};
  assert.throws(()=>runtime.change(foreign,"add","FOREIGN"),/no longer active/);
  runtime.dispose();
  for(const action of ["add","enable","disable","reset"] as const) assert.throws(()=>runtime.change(fakeContext,action,"review"),/no longer active/);
  assert.equal(JSON.stringify(fakeContext.sessionManager.getBranch()),before);
 } finally {env.cleanup();}
});
