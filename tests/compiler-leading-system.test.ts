import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createExtensionRuntime, ExtensionRunner, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compileMessages } from "../src/compiler.ts";
import { projectPresetSystemPrompt } from "../src/capability-projection.ts";
import { buildPreview } from "../src/preview.ts";
import type { LoadedPromptStack, PromptRuntime, PromptStack } from "../src/types.ts";

const runtime: PromptRuntime = {
	options: { cwd: "/fixture", selectedTools: [], toolSnippets: {}, promptGuidelines: [], contextFiles: [], skills: [] },
	latestUserMessage: "latest", now: new Date(0),
};
const head: SystemMessage = {
	role: "system", content: "BASE", timestamp: 0,
	sections: { foreign: "KEEP" },
	toolsAdded: [{ name: "read", description: "fixture", parameters: { type: "object", properties: {} } }],
};
const user: AgentMessage = { role: "user", content: "latest", timestamp: 1 };
const delta: SystemMessage = { role: "system", content: "LATER", sections: { foreign: "UPDATE" }, timestamp: 2 };
const later: AgentMessage = { role: "user", content: "after delta", timestamp: 3 };
const prefix: PromptStack["items"] = [
	{ kind: "block", id: "persona", role: "system", content: "PERSONA" },
	{ kind: "block", id: "intro", role: "user", content: "INTRO" },
	{ kind: "block", id: "ack", role: "assistant", content: "ACK" },
];
const history: PromptStack["items"][number] = { kind: "slot", id: "history", slot: "chat-history" };
function stack(items = [...prefix, history]): PromptStack { return { schemaVersion: 2, id: "fixture", items }; }

test("incoming leading System and provenance stay first with explicit/implicit history and authored slots", async (t) => {
	for (const implicit of [false, true]) {
		await t.test(implicit ? "implicit" : "explicit", () => {
			const input = [head, user, delta, later];
			const original = structuredClone(input);
			const result = compileMessages(stack(implicit ? prefix : [...prefix, history]), runtime, input);
			assert.deepEqual(result.messages.map(m => m.role), ["system", "user", "assistant", "user", "system", "user"]);
			assert.equal(result.messages[0], head);
			assert.equal(result.messages[4], delta);
			assert.equal(result.messageSources[0].kind, implicit ? "implicit-history" : "chat-history");
			assert.equal(result.messageSources[1].itemId, "intro");
			assert.equal(result.messageSources[2].itemId, "ack");
			assert.equal(result.messageSources.length, result.messages.length);
			assert.deepEqual(input, original);
		});
	}
	const dated = compileMessages(stack([{ kind: "slot", id: "date", role: "user", slot: "date" }, history]), runtime, [head, user]);
	assert.equal(dated.messages[0], head);
	assert.equal(dated.messageSources[1].itemId, "date");
});

test("history filtering, regex and merging preserve the header, later deltas and aligned sources", () => {
	const filtered: PromptStack = {
		...stack([
			{ kind: "block", id: "one", role: "user", content: "ONE" },
			{ kind: "block", id: "two", role: "user", content: "TWO" },
			{ ...history, kind: "slot", slot: "chat-history", options: {
				includeSummaries: false, roles: ["user"], toolMode: "drop", stripAssistantThinking: true, maxMessages: 1, maxChars: 30,
			} },
		]),
		context: { mergeConsecutiveRoles: true },
		regex: { rules: [{ id: "scrub", stage: "compiled", targets: ["messages"], pattern: "BASE|LATER", replace: "MUST NOT CHANGE CONTROL" }] },
	};
	const result = compileMessages(filtered, runtime, [head, user, delta, later]);
	assert.deepEqual(result.messages.map(m => m.role), ["system", "user", "system", "user"]);
	assert.equal(result.messages[0], head);
	assert.equal(result.messages[2], delta);
	assert.equal(result.messages[3], later);
	assert.deepEqual(result.messageSources[1].mergedItems?.map(item => item.itemId), ["one", "two"]);
	const projected = projectPresetSystemPrompt(result.messages, "PERSONA");
	assert.equal((projected[0] as SystemMessage).content, "PERSONA");
	assert.deepEqual((projected[0] as SystemMessage).toolsAdded, head.toolsAdded);
	assert.deepEqual((projected[0] as SystemMessage).sections, head.sections);
	assert.deepEqual(projected[2], delta);
});

test("no incoming header does not hoist later System; already-leading and empty cases are unchanged", () => {
	for (const input of [[], [user], [user, delta, later]] as AgentMessage[][]) {
		const result = compileMessages(stack(), runtime, input);
		assert.deepEqual(result.messages.slice(2), input);
		assert.equal(result.messageSources[0].itemId, "intro");
	}
	const result = compileMessages(stack([history, prefix[1]!]), runtime, [head, user]);
	assert.equal(result.messages[0], head);
	assert.equal(result.messages[1], user);
	assert.equal(result.messageSources[2].itemId, "intro");
});

test("real SDK context guard accepts the compiled prefix while retaining initial tools and foreign sections", async () => {
	const errors: string[] = [];
	// Real guard/runtime/session manager; model registry is unused by this pure
	// context handler and deliberately has no provider or credential setup.
	type RunnerArgs = ConstructorParameters<typeof ExtensionRunner>;
	const extension = {
		path: "fixture", handlers: new Map([["context_with_system", [async (event: { messages: AgentMessage[] }) => ({
			messages: projectPresetSystemPrompt(compileMessages(stack(), runtime, event.messages).messages, "PERSONA"),
		})]]]),
	} as RunnerArgs[0][number];
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), "/fixture", SessionManager.inMemory("/fixture"), {} as RunnerArgs[4]);
	runner.onError(error => errors.push(error.error));
	const output = await runner.emitContext([head, user]);
	assert.deepEqual(errors, []);
	assert.deepEqual(output.map(m => m.role), ["system", "user", "assistant", "user"]);
	assert.equal((output[0] as SystemMessage).content, "PERSONA");
	assert.deepEqual((output[0] as SystemMessage).toolsAdded, head.toolsAdded);
	assert.deepEqual((output[0] as SystemMessage).sections, head.sections);
});

test("Preview consumes the same compiler and keeps synthetic/history provenance aligned", () => {
	const session = SessionManager.inMemory("/fixture");
	session.appendMessage(head);
	session.appendMessage(user);
	session.appendMessage(delta);
	session.appendMessage(later);
	const target: LoadedPromptStack = {
		stack: stack(), filePath: "/fixture/preset.json", scope: "project", key: { scope: "project", id: "fixture" }, diagnostics: [],
	};
	const ctx = {
		sessionManager: session, getSystemPrompt: () => "BASE", isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	const { preview } = buildPreview(ctx, target, { cwd: "/fixture" });
	assert.match(preview.system.content, /PERSONA/);
	assert.deepEqual(preview.messages.map(m => m.role), ["user", "assistant", "user", "system", "user"]);
	assert.match(preview.messages[0].title, /intro/);
	assert.match(preview.messages[1].title, /ack/);
	assert.match(preview.messages[2].content, /latest/);
	assert.match(preview.messages[3].content, /LATER/);
	assert.match(preview.messages[4].content, /after delta/);
});

test("registered lifecycle keeps the header across first request and follow-up; disabled preset is unchanged", async (t) => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createHarness, createContext, startSession, writeStack } = await import("./helpers/index-command-harness.ts");
	const cwd = mkdtempSync(join(tmpdir(), "forge-leading-lifecycle-"));
	writeStack(cwd, "fixture.json", { ...stack(), autoActivate: true });
	const harness = createHarness();
	const context = createContext(cwd);
	t.after(async () => { await harness.events.session_shutdown?.({}, context.ctx); rmSync(cwd, { recursive: true, force: true }); });
	await startSession(harness, context.ctx);
	await harness.events.before_agent_start({ prompt: "latest", systemPrompt: "BASE", systemPromptOptions: context.ctx.getSystemPromptOptions() }, context.ctx);
	const input = [head, user, delta, later];
	const original = structuredClone(input);
	for (const first of [true, false]) {
		const result = await harness.events.context_with_system({ type: "context_with_system", messages: input }, context.ctx);
		assert.equal(result.messages[0].role, "system");
		assert.equal(result.messages[0].content, "PERSONA");
		assert.deepEqual(result.messages[0].toolsAdded, head.toolsAdded);
		assert.equal(result.messages.length, first ? 6 : 4);
		assert.deepEqual(result.messages.at(-2), delta);
		assert.deepEqual(input, original);
	}
	await harness.events.agent_settled({}, context.ctx);
	await harness.commands.preset.handler("use none", context.ctx);
	const inactive = await harness.events.context_with_system({ type: "context_with_system", messages: input }, context.ctx);
	assert.deepEqual(inactive?.messages ?? input, input);
});
