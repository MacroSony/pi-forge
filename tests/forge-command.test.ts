import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contributeForgeCommand, FORGE_COMMAND_DISCOVERY_EVENT } from "../src/command-contribution/index.ts";
import { registerForgeCommand } from "../src/forge-command.ts";
import { registerPayloadCommands, registerPayloadRequestHandler } from "../src/payload-command.ts";
import { createPayloadState } from "../src/payload-state.ts";
import { createContext, createHarness, startSession, writeLegacyStack } from "./helpers/index-command-harness.ts";

function fixture() {
	const commands: Record<string, any> = {}, handlers: Record<string, any> = {};
	const subscribers = new Map<string, Set<(data: any) => void>>();
	const events = {
		emit(name: string, data: any) { for (const cb of [...(subscribers.get(name) ?? [])]) cb(data); },
		on(name: string, cb: (data: any) => void) { const set = subscribers.get(name) ?? new Set(); set.add(cb); subscribers.set(name, set); return () => { set.delete(cb); }; },
	};
	const pi: any = { events, registerCommand(name: string, command: any) { commands[name] = command; }, on(name: string, fn: any) { handlers[name] = fn; } };
	const state = createPayloadState(), calls: string[] = [];
	const payload = registerPayloadCommands(pi, state);
	registerPayloadRequestHandler(pi, state, () => undefined);
	registerForgeCommand(pi, {
		async openWebEditor(_ctx, mode) { calls.push(mode ?? "open"); }, async stopWebEditor() { calls.push("stop"); },
	}, payload);
	const context = createContext(mkdtempSync(join(tmpdir(), "forge-root-command-")));
	return { ...context, pi, events, commands, handlers, state, calls };
}

test("forge root shares UI lifecycle, strict parsing, nested completion and help without inference", async () => {
	const f = fixture(), c = f.commands.forge;
	await c.handler("", f.ctx);
	assert.match(f.editors.at(-1)!.text, /\/instruction help/);
	assert.deepEqual(f.calls, []);
	for (const args of ["ui", "ui restart", "ui stop"]) await c.handler(args, f.ctx);
	assert.deepEqual(f.calls, ["open", "restart", "stop"]);
	await c.handler("ui restatr", f.ctx);
	await c.handler("ui restart extra", f.ctx);
	await c.handler("constructor", f.ctx);
	assert.deepEqual(f.calls, ["open", "restart", "stop"]);
	assert.match(f.notifications.at(-1)!.message, /Unknown/);
	assert.ok((await c.getArgumentCompletions("payload n")).some((x: any) => x.value === "payload next"));
	assert.deepEqual((await c.getArgumentCompletions("ui re")).map((x: any) => x.value), ["ui restart"]);
	await c.handler("subagent list", f.ctx);
	assert.match(f.notifications.at(-1)!.message, /matching optional/);
});

test("optional contributions work in either load order, share handlers, reject duplicate and stale providers", async () => {
	const f = fixture(); let calls = 0;
	let resolve!: (items: { value: string; label: string }[]) => void;
	const stop = contributeForgeCommand(f.events, { name: "subagent", description: "test", handler: async (args) => { assert.equal(args, "plan p -- task  with  spaces"); calls++; }, getArgumentCompletions: () => new Promise(r => { resolve = r; }) });
	await f.commands.forge.handler("subagent plan p -- task  with  spaces", f.ctx);
	assert.equal(calls, 1);
	const pending = f.commands.forge.getArgumentCompletions("subagent p");
	stop(); resolve([{ value: "plan", label: "plan" }]); assert.deepEqual(await pending, []);
	const definition = { name: "subagent", description: "test", handler: async () => { calls++; } };
	const stop1 = contributeForgeCommand(f.events, definition), stop2 = contributeForgeCommand(f.events, definition);
	await f.commands.forge.handler("subagent run", f.ctx); assert.equal(calls, 1);
	assert.match(f.notifications.at(-1)!.message, /ambiguous/); stop1(); stop2();
	// A contributor installed before a newly registered root is discovered too.
	const stop3 = contributeForgeCommand(f.events, definition);
	registerForgeCommand(f.pi, { async openWebEditor() {}, async stopWebEditor() {} }, f.commands.payload);
	await f.commands.forge.handler("subagent help", f.ctx); assert.equal(calls, 2); stop3();
	assert.throws(() => contributeForgeCommand(f.events, { ...definition, name: "ui" }), /reserved/);
});

test("discovery ignores malformed and asynchronous late offers", async () => {
	const f = fixture(); let offer: any;
	f.events.on(FORGE_COMMAND_DISCOVERY_EVENT, data => { offer = data.provide; data.provide({ name: "bad" }); data.provide({ name: "ui", handler() {}, description: "override" }); });
	const results = await f.commands.forge.getArgumentCompletions("");
	offer({ name: "late", description: "late", handler() {} });
	assert.equal(results.some((x: any) => x.value === "bad" || x.value === "late"), false);
	await f.commands.forge.handler("ui", f.ctx); assert.deepEqual(f.calls, ["open"]);
});

test("payload aliases share arming; status/cancel preserve retained captures and history", async () => {
	const f = fixture(); const history = f.state.contextDiffHistory;
	await f.commands.forge.handler("payload next", f.ctx); assert.equal(f.state.interceptNextProviderPayload, true);
	await f.handlers.before_provider_request({ payload: { model: "test", messages: [] } }, f.ctx);
	const captured = f.state.latestProviderPayloadCapture; assert.ok(captured);
	// Simulate a pending web capture with a retained capture, not a history reset.
	f.state.interceptNextProviderPayload = true; f.state.interceptPayloadSavePath = "pending.json";
	await f.commands.forge.handler("payload status", f.ctx); assert.equal(f.state.interceptNextProviderPayload, true);
	await f.commands.forge.handler("payload cancel", f.ctx);
	assert.equal(f.state.interceptNextProviderPayload, false); assert.equal(f.state.interceptPayloadSavePath, undefined);
	assert.equal(f.state.latestProviderPayloadCapture, captured); assert.equal(f.state.contextDiffHistory, history);
	await f.commands.payload.handler("", f.ctx); assert.equal(f.state.interceptNextProviderPayload, true);
	await f.commands.forge.handler("payload cancel", f.ctx);
	await f.commands.intercept.handler("", f.ctx); assert.equal(f.state.interceptNextProviderPayload, true);
});

test("payload save parses quoted paths, rejects unknown flags and requires explicit overwrite", async () => {
	const f = fixture(); const path = join(f.ctx.cwd, "with spaces.json");
	await f.commands.forge.handler('payload next save="with spaces.json"', f.ctx);
	await f.handlers.before_provider_request({ payload: { value: 1 } }, f.ctx); assert.equal(JSON.parse(readFileSync(path, "utf8")).value, 1);
	await f.commands.payload.handler('next save="with spaces.json"', f.ctx); assert.equal(f.state.interceptNextProviderPayload, false);
	assert.match(f.notifications.at(-1)!.message, /exists/);
	await f.commands.payload.handler('next save="with spaces.json" --overwrite', f.ctx);
	await f.handlers.before_provider_request({ payload: { value: 2 } }, f.ctx); assert.equal(JSON.parse(readFileSync(path, "utf8")).value, 2);
	for (const bad of ['next --save no.json', 'next save="broken', 'next save=x --overwite', 'next save=']) {
		await f.commands.payload.handler(bad, f.ctx); assert.equal(f.state.interceptNextProviderPayload, false);
	}
	await f.commands.payload.handler("next save=race.json", f.ctx); writeFileSync(join(f.ctx.cwd, "race.json"), "USER");
	await f.handlers.before_provider_request({ payload: { value: 3 } }, f.ctx);
	assert.equal(readFileSync(join(f.ctx.cwd, "race.json"), "utf8"), "USER");
	assert.ok(f.notifications.some(x => /NOT saved/.test(x.message)));
	const untrusted = createContext(f.ctx.cwd, [], { trusted: false });
	await f.commands.payload.handler("next save=no.json", untrusted.ctx);
	assert.equal(f.state.interceptNextProviderPayload, false);
});

test("migration typo is rejected before writes, old and canonical root aliases coexist", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-cli-migrate-")); const h = createHarness(), { ctx, notifications } = createContext(cwd);
	writeLegacyStack(cwd, "old.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "old", items: [] });
	await startSession(h, ctx);
	assert.ok(h.commands.forge && h.commands.instruction && h.commands["system-update"] && h.commands.preset && h.commands.profile);
	assert.equal(h.commands.instruction.handler, h.commands["system-update"].handler);
	await h.commands.preset.handler("migrate-stacks --dryrun", ctx);
	assert.equal(existsSync(join(cwd, ".pi", "forge", "prompt-stacks", "old.json")), false);
	assert.match(notifications.at(-1)!.message, /Unknown|Usage/);
	await h.events.session_shutdown?.({ type: "session_shutdown" }, ctx);
});

test("replacement with the same handler cannot deliver an older completer result", async () => {
	const f = fixture(); let resolve!: (items: { value: string; label: string }[]) => void;
	const handler = async () => {};
	const stop = contributeForgeCommand(f.events, { name: "subagent", description: "old", handler, getArgumentCompletions: () => new Promise(r => { resolve = r; }) });
	const pending = f.commands.forge.getArgumentCompletions("subagent p");
	stop();
	const stopNew = contributeForgeCommand(f.events, { name: "subagent", description: "new", handler, getArgumentCompletions: () => [{ value: "plan new", label: "new" }] });
	resolve([{ value: "plan old", label: "old" }]);
	assert.deepEqual(await pending, []);
	assert.equal((await f.commands.forge.getArgumentCompletions("subagent p"))[0].value, "subagent plan new");
	stopNew();
});
