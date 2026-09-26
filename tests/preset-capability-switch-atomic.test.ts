import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createContext, createHarness, latestEditorUrl, startSession, writeStack } from "./helpers/index-command-harness.ts";
import { FORGE_ACTIVE_STATE_CHANNEL } from "../src/active-state.ts";
import { readCapabilitySession } from "../src/session-adapter.ts";

async function setup(t: TestContext, trusted = true) {
	const cwd = mkdtempSync(join(tmpdir(), "forge-switch-preflight-"));
	for (const [id, tools] of [["base", undefined], ["deny", { deny: ["bash"] }], ["allow", { allow: ["read"] }]] as const) {
		writeStack(cwd, `${id}.json`, { schemaVersion: 1, id, tools, autoActivate: id === "base",
			capabilities: [{ id: "bound-bash", ref: "bash-cap" }],
			items: [{ kind: "block", id: "system", role: "system", content: `Preset ${id}` }],
		});
	}
	const dir = join(cwd, ".pi", "forge", "capabilities");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bash-cap.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.capability", id: "bash-cap", content: "fixture", tools: { add: ["bash"], remove: [] } }));
	const entries: unknown[] = [];
	const harness = createHarness({ activeTools: ["read", "write"], allTools: ["read", "write", "bash", "forge_capability"] });
	const push = harness.appended.push.bind(harness.appended);
	harness.appended.push = (...items) => {
		for (const item of items) entries.push({ type: "custom", customType: item.type, data: item.data });
		return push(...items);
	};
	const context = createContext(cwd, entries, { trusted });
	let aborted = false;
	context.ctx.abort = () => { aborted = true; };
	t.after(async () => {
		await harness.commands.preset.handler("ui stop", context.ctx);
		await harness.events.session_shutdown?.({}, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	});
	await startSession(harness, context.ctx);
	const publications: unknown[] = [];
	harness.eventsBus.on(FORGE_ACTIVE_STATE_CHANNEL, (event: unknown) => publications.push(event));
	const state = () => structuredClone({ entries, statuses: context.statuses, tools: harness.getActiveTools(), publications });
	async function healthyTurn() {
		await harness.events.turn_start({}, context.ctx);
		await harness.events.before_agent_start({ prompt: "hello", systemPrompt: "base", systemPromptOptions: context.ctx.getSystemPromptOptions() }, context.ctx);
		await harness.events.context_with_system({ type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 0 }, { role: "user", content: "hello", timestamp: 1 }] }, context.ctx);
		assert.equal(aborted, false);
	}
	async function request(path: string, body?: unknown) {
		await harness.commands.preset.handler("ui", context.ctx);
		const url = latestEditorUrl(context.editors);
		const response = await fetch(new URL(path, url), { method: "POST", headers: { "x-pi-forge-token": url.searchParams.get("token")!, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
		return { status: response.status, body: await response.json() as { error?: string } };
	}
	return { cwd, harness, context, entries, publications, state, healthyTurn, request };
}

test("CLI rejects incompatible unbound capability before selection, publication, persistence or tool mutation", async (t) => {
	for (const target of ["deny", "allow"]) await t.test(target, async (t) => {
		const f = await setup(t);
		await f.harness.commands.capability.handler("enable bash-cap", f.context.ctx);
		const before = f.state();
		await f.harness.commands.preset.handler(`use ${target}`, f.context.ctx);
		assert.deepEqual(f.state(), before);
		assert.match(f.context.notifications.at(-1)!.message, /blocked by prompt stack/);
		assert.match(f.context.notifications.at(-1)!.message, /Disable conflicting capabilities/);
		assert.equal(f.context.notifications.at(-1)!.type, "error");
		assert.equal(await f.harness.events.tool_call({ toolName: "bash" }, f.context.ctx), undefined);
		await f.healthyTurn();
		await f.harness.commands.capability.handler("disable bash-cap", f.context.ctx);
		await f.harness.commands.preset.handler(`use ${target}`, f.context.ctx);
		assert.match(f.context.statuses["pi-forge"]!, new RegExp(`stack:${target}`));
		assert.ok(f.publications.length > 0, "negative publication assertion is backed by a positive control");
		assert.deepEqual(await f.harness.events.tool_call({ toolName: "bash" }, f.context.ctx), { block: true, reason: `Tool "bash" is blocked by prompt stack "${target}".` });
	});
});

test("same-preset selection preserves snapshots; switching retires only old bound capabilities; none keeps unbound", async (t) => {
	const f = await setup(t);
	await f.harness.commands.capability.handler("enable-bound bound-bash", f.context.ctx);
	const events = readCapabilitySession(f.context.ctx).events;
	await f.harness.commands.preset.handler("use base", f.context.ctx);
	assert.deepEqual(readCapabilitySession(f.context.ctx).events, events);
	await f.harness.commands.preset.handler("use deny", f.context.ctx);
	assert.ok(!f.harness.getActiveTools().includes("bash"));
	assert.equal(readCapabilitySession(f.context.ctx).events.at(-1)!.op, "deactivate");
	await f.harness.commands.preset.handler("use base", f.context.ctx);
	await f.harness.commands.capability.handler("enable bash-cap", f.context.ctx);
	await f.harness.commands.preset.handler("use none", f.context.ctx);
	assert.equal(f.context.statuses["pi-forge"], undefined);
	assert.ok(f.harness.getActiveTools().includes("bash"));
	await f.healthyTurn();
});

test("rejected switch must not retire old bound activations before validating surviving unbound patches", async (t) => {
	const f = await setup(t);
	await f.harness.commands.capability.handler("enable-bound bound-bash", f.context.ctx);
	await f.harness.commands.capability.handler("enable bash-cap", f.context.ctx);
	const before = f.state();
	await f.harness.commands.preset.handler("use deny", f.context.ctx);
	assert.deepEqual(f.state(), before);
	assert.equal(readCapabilitySession(f.context.ctx).events.filter(e => e.op === "deactivate").length, 0);
});

test("Web Activate returns 409 for a real policy conflict and 404 for unknown, with unchanged runtime", async (t) => {
	const f = await setup(t);
	await f.harness.commands.capability.handler("enable bash-cap", f.context.ctx);
	await f.harness.commands.preset.handler("ui", f.context.ctx);
	const before = f.state();
	const conflict = await f.request("/api/stacks/deny/activate");
	assert.equal(conflict.status, 409);
	assert.match(conflict.body.error!, /blocked by prompt stack/);
	assert.deepEqual(f.state(), before);
	const missing = await f.request("/api/stacks/missing/activate");
	assert.equal(missing.status, 404);
	assert.deepEqual(f.state(), before);
	await f.healthyTurn();
});

test("create-and-activate discovers the file without bypassing preflight or changing previous selection", async (t) => {
	const f = await setup(t);
	await f.harness.commands.capability.handler("enable bash-cap", f.context.ctx);
	await f.harness.commands.preset.handler("ui", f.context.ctx);
	const before = f.state();
	const result = await f.request("/api/stacks", { activate: true, scope: "project", stack: {
		schemaVersion: 1, id: "created-deny", tools: { deny: ["bash"] }, items: [],
	} });
	assert.equal(result.status, 409);
	assert.match(result.body.error!, /was created, but activation failed/);
	assert.ok(existsSync(join(f.cwd, ".pi", "forge", "prompt-stacks", "created-deny.json")));
	// Creation legitimately refreshes the catalog and republishes the unchanged
	// active identity. It must never publish the failed candidate or alter events/tools.
	const after = f.state();
	assert.deepEqual(after.entries, before.entries);
	assert.deepEqual(after.statuses, before.statuses);
	assert.deepEqual(after.tools, before.tools);
	assert.ok(after.publications.length > before.publications.length);
	for (const event of after.publications) assert.equal((event as { stackKey: string }).stackKey, "project:base");
	await f.healthyTurn();
});

test("untrusted project refuses activation without changing runtime", async (t) => {
	const f = await setup(t, false);
	const before = f.state();
	await f.harness.commands.preset.handler("use deny", f.context.ctx);
	assert.match(f.context.notifications.at(-1)!.message, /not trusted/);
	assert.deepEqual(f.state(), before);
});
