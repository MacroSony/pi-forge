import assert from "node:assert/strict";
import test from "node:test";
import { compileSystemPrompt, compileMessages } from "../src/compiler.ts";
import { forgeV1, FORGE_V1_MAX_TEMPLATE_OUTPUT } from "../src/forge-v1/index.ts";
import { registerMacro } from "../src/macro-engine.ts";
import { registerSlot } from "../src/slot-renderers.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PromptEnvironment } from "../src/forge-v1/index.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";

function runtime(): PromptRuntime {
	return {
		options: {
			cwd: "/work/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files." },
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "hello world",
		now: new Date("2026-06-13T12:00:00Z"),
	};
}

function env(overrides: Partial<PromptEnvironment> = {}): PromptEnvironment {
	return {
		runtime: {
			cwd: "/work/project",
			date: "2026-06-13",
			time: "12:00:00",
			lastUserMessage: "hello world",
			selectedTools: ["read"],
			selectedToolsText: "read",
			activeModel: "test/model",
			populatedAt: "2026-06-13T12:00:00.000Z",
			timezone: "local",
			tool: { read: true },
			slot: { "chat-history": true },
		},
		parameters: { name: "Ada" },
		extensions: {},
		...overrides,
	};
}

test("forge-v1 parses output, filters, and if/else", () => {
	const parsed = forgeV1.parse("Hi {{ parameters.name }} / {{ parameters.name | upper }} / {% if runtime.tool.read %}Y{% else %}N{% endif %}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const analyzed = forgeV1.analyze(parsed.ast);
	assert.equal(analyzed.errors.length, 0);
	assert.ok(analyzed.dependencies.some((d) => d.kind === "parameters" && d.path?.join(".") === "parameters.name"));
	assert.ok(analyzed.dependencies.some((d) => d.kind === "runtime"));
	assert.ok(analyzed.dependencies.some((d) => d.kind === "filter" && d.filter === "upper"));
});

test("forge-v1 reports parse errors", () => {
	const parsed = forgeV1.parse("Hello {{ broken");
	assert.equal(parsed.ok, false);
	if (!parsed.ok) assert.equal(parsed.error.kind, "parse");
});

test("forge-v1 rejects unknown filters during analysis", () => {
	const parsed = forgeV1.parse("{{ name | nope }}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const analyzed = forgeV1.analyze(parsed.ast);
	assert.equal(analyzed.errors.some((e) => e.kind === "filter" && /nope/.test(e.message)), true);
});

test("forge-v1 strict undefined output errors", () => {
	const parsed = forgeV1.parse("{{ missing }}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env());
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "undefined");
});

test("forge-v1 truthy predicates treat missing paths as false", () => {
	const parsed = forgeV1.parse("{% if runtime.tool.bash %}Y{% else %}N{% endif %}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env());
	assert.deepEqual(result, { ok: true, text: "N" });
});

test("forge-v1 equality predicates compare rendered values", () => {
	const parsed = forgeV1.parse('{% if name == "Ada" %}yes{% else %}no{% endif %} / {% if name != "Ada" %}bad{% else %}good{% endif %}');
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env());
	assert.deepEqual(result, { ok: true, text: "yes / good" });
});

test("forge-v1 filters transform values", () => {
	const parsed = forgeV1.parse("{{ name | trim | upper }}|{{ name | lower }}|{{ special | xml }}|{{ name | json }}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env({ parameters: { name: "  Ada  ", special: "a<&" } }));
	assert.deepEqual(result, { ok: true, text: "ADA|  ada  |a&lt;&amp;|\"  Ada  \"" });
});

test("forge-v1 preserves whitespace", () => {
	const parsed = forgeV1.parse("a\n  {{ name }}  \nb");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env());
	assert.deepEqual(result, { ok: true, text: "a\n  Ada  \nb" });
});

test("forge-v1 enforces template output limits", () => {
	const parsed = forgeV1.parse("x".repeat(100) + " {{ name }}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env(), { templateLimit: 50 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "output-limit");
	assert.equal(result.error.message.includes("50"), true);
});

test("forge-v1 rendering is deterministic", () => {
	const parsed = forgeV1.parse("{{ name }} {{ runtime.cwd }}");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const first = forgeV1.render(parsed.ast, env());
	const second = forgeV1.render(parsed.ast, env());
	assert.deepEqual(first, second);
});

test("schema v2 parameters compile through forge-v1", () => {
	const stack: PromptStack = {
		schemaVersion: 2,
		id: "v2",
		parameters: { audience: "main agent", upper: "loud" },
		items: [
			{ kind: "block", id: "role", role: "system", content: "For {{ parameters.audience }}: {{ parameters.upper | upper }}" },
		],
	};
	const result = compileSystemPrompt(stack, runtime(), "base");
	assert.equal(result.systemPrompt, "For main agent: LOUD");
	assert.deepEqual(result.diagnostics, []);
});

test("finalize rules are excluded and diagnosed in preview", async () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "finalize-preview",
		regex: { rules: [{ id: "f", stage: "compiled", effect: "finalize", targets: ["messages"], roles: ["assistant"], pattern: "x" }] },
		items: [{ kind: "slot", id: "history", slot: "chat-history" }],
	};
	const messages = [{ role: "user" as const, content: "x", timestamp: 1 } as AgentMessage];
	const compiled = compileMessages(stack, runtime(), messages);
	assert.equal(String((compiled.messages[0] as { content?: unknown }).content), "x");
	// preview-level diagnostic is asserted through the build path below
	const { buildPreview } = await import("../src/preview.ts");
	const options = runtime().options;
	const previewCtx = {
		sessionManager: { getLeafId: () => null },
		getSystemPrompt: () => "base",
		getSystemPromptOptions: () => options,
	} as unknown as Parameters<typeof buildPreview>[0];
	const preview = buildPreview(previewCtx, { stack, filePath: "f", scope: "project", key: { scope: "project", id: "finalize-preview" }, diagnostics: [] }, options);
	assert.ok(preview.diagnostics.some((d) => d.level === "info" && /not represented/.test(d.message)));
});

test("forge-v1 cross-referencing extensions resolve declared dependencies", () => {
	const unregisterA = registerMacro({
		name: "fixtureDepA",
		dependencies: ["extensions.fixtureDepB"],
		render: ({ env }) => `A(${String(env.extensions.fixtureDepB)})`,
	});
	const unregisterB = registerMacro({
		name: "fixtureDepB",
		render: () => "B",
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "ext-deps",
			items: [{ kind: "block", id: "b", role: "system", content: "{{ extensions.fixtureDepA }}" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "A(B)");
		assert.deepEqual(result.diagnostics, []);
	} finally {
		unregisterA();
		unregisterB();
	}
});

test("forge-v1 extension output limits fail closed", () => {
	const unregister = registerMacro({
		name: "fixtureLarge",
		render: () => "x".repeat(FORGE_V1_MAX_TEMPLATE_OUTPUT),
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "ext-limit",
			items: [{ kind: "block", id: "b", role: "system", content: "{{ extensions.fixtureLarge }}" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "base");
		assert.ok(result.diagnostics.some((d) => d.level === "error" && /exceeds/.test(d.message)));
	} finally {
		unregister();
	}
});

test("forge-v1 extension cycles fail closed", () => {
	const unregisterA = registerMacro({
		name: "fixtureCycleA",
		dependencies: ["extensions.fixtureCycleB"],
		render: () => "A",
	});
	const unregisterB = registerMacro({
		name: "fixtureCycleB",
		dependencies: ["extensions.fixtureCycleA"],
		render: () => "B",
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "ext-cycle",
			items: [{ kind: "block", id: "b", role: "system", content: "{{ extensions.fixtureCycleA }}" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "base");
		assert.ok(result.diagnostics.some((d) => d.level === "error" && /cycle/.test(d.message)));
	} finally {
		unregisterA();
		unregisterB();
	}
});

test("forge-v1 extension render failures fail closed", () => {
	const unregister = registerMacro({
		name: "fixtureThrows",
		render: () => {
			throw new Error("boom");
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "ext-throw",
			items: [{ kind: "block", id: "b", role: "system", content: "{{ extensions.fixtureThrows }}" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "base");
		assert.ok(result.diagnostics.some((d) => d.level === "error" && /failed: boom/.test(d.message)));
	} finally {
		unregister();
	}
});

test("forge-v1 reports else/endif without if and empty tags as parse errors", () => {
	assert.equal(forgeV1.parse("{% else %}").ok, false);
	assert.equal(forgeV1.parse("{% endif %}").ok, false);
	assert.equal(forgeV1.parse("{{ }}").ok, false);
});

test("forge-v1 equality predicates error on undefined paths", () => {
	const parsed = forgeV1.parse('{% if missing == "x" %}A{% endif %}');
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env());
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "undefined");
});

test("forge-v1 supports nested if blocks", () => {
	const parsed = forgeV1.parse('{% if runtime.tool.read %}{% if parameters.x == "y" %}A{% else %}B{% endif %}{% else %}C{% endif %}');
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env({ parameters: { x: "y" } }));
	assert.deepEqual(result, { ok: true, text: "A" });
});

test("forge-v1 parses empty-string comparisons", () => {
	const parsed = forgeV1.parse('{% if parameters.x == "" %}empty{% else %}not{% endif %}');
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const result = forgeV1.render(parsed.ast, env({ parameters: { x: "" } }));
	assert.deepEqual(result, { ok: true, text: "empty" });
});

test("forge-v1 extension values resolve lazily per active branch", () => {
	const unregister = registerMacro({
		name: "fixtureLazyFail",
		render: () => {
			throw new Error("should not run");
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "lazy",
			items: [{
				kind: "block",
				id: "b",
				role: "system",
				content: "{% if runtime.tool.read %}ok{% else %}{{ extensions.fixtureLazyFail }}{% endif %}",
			}],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "ok");
		assert.deepEqual(result.diagnostics, []);
	} finally {
		unregister();
	}
});

test("custom slots receive resolved extension dependencies", () => {
	const unregMacro = registerMacro({
		name: "fixtureSlotDep",
		render: () => "dep-value",
	});
	const unregSlot = registerSlot({
		name: "fixture-slot-with-dep",
		dependencies: ["extensions.fixtureSlotDep"],
		render: ({ env }) => `slot:${String(env.extensions.fixtureSlotDep)}`,
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "slot-dep",
			items: [{ kind: "slot", id: "s", role: "system", slot: "fixture-slot-with-dep" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "slot:dep-value");
		assert.deepEqual(result.diagnostics, []);
	} finally {
		unregMacro();
		unregSlot();
	}
});

test("custom slot output is subject to the extension output limit", () => {
	const unregSlot = registerSlot({
		name: "fixture-slot-large",
		render: () => "x".repeat(FORGE_V1_MAX_TEMPLATE_OUTPUT),
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "slot-limit",
			items: [{ kind: "slot", id: "s", role: "system", slot: "fixture-slot-large" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "base");
		assert.ok(result.diagnostics.some((d) => d.level === "error" && /exceeds/.test(d.message)));
	} finally {
		unregSlot();
	}
});

test("slot dependency failures fail closed without crashing", () => {
	const unregMacro = registerMacro({
		name: "fixtureSlotBoom",
		render: () => {
			throw new Error("slot-dep-boom");
		},
	});
	const unregSlot = registerSlot({
		name: "fixture-slot-boom-dep",
		dependencies: ["extensions.fixtureSlotBoom"],
		render: ({ env }) => `slot:${String(env.extensions.fixtureSlotBoom)}`,
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "slot-boom",
			items: [{ kind: "slot", id: "s", role: "system", slot: "fixture-slot-boom-dep" }],
		};
		const result = compileSystemPrompt(stack, runtime(), "base");
		assert.equal(result.systemPrompt, "base");
		assert.ok(result.diagnostics.some((d) => d.level === "error" && /slot-dep-boom/.test(d.message)));
	} finally {
		unregMacro();
		unregSlot();
	}
});

test("PromptCompilationContext updates lastUserMessage for message blocks", async () => {
	const { PromptCompilationContext } = await import("../src/compiler.ts");
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "ctx",
		items: [{ kind: "block", id: "b", role: "user", content: "Latest={{ runtime.lastUserMessage }}" }],
	};
	const ctx = new PromptCompilationContext(stack, { ...runtime(), latestUserMessage: "prompt-value" });
	ctx.setLatestUserMessage("message-value");
	const compiled = ctx.compileMessages([{ role: "user" as const, content: "original", timestamp: 1 } as AgentMessage]);
	const content = (compiled.messages[0] as { content?: unknown }).content;
	const text = typeof content === "string" ? content : Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("")
		: "";
	assert.equal(text, "Latest=message-value");
});

test("prompt analysis excludes disabled items", async () => {
	const { analyzePromptStack } = await import("../src/prompt-analysis.ts");
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "disabled",
		items: [
			{ kind: "block", id: "enabled", content: "{{ extensions.known }}" },
			{ kind: "block", id: "disabled", enabled: false, content: "{{ extensions.unknown }}" },
		],
	};
	const analysis = analyzePromptStack(stack, {
		macros: [{ name: "known", dependencies: [] }],
		slots: [],
	});
	assert.deepEqual([...analysis.transitiveExtensions], ["known"]);
});

test("PromptCompilationContext evaluates an extension once across system and messages", async () => {
	const { PromptCompilationContext } = await import("../src/compiler.ts");
	let calls = 0;
	const unregister = registerMacro({
		name: "fixtureCompileOnce",
		render: () => {
			calls += 1;
			return "SV";
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "ctx-once",
			items: [
				{ kind: "block", id: "sys", role: "system", content: "{{ extensions.fixtureCompileOnce }}" },
				{ kind: "block", id: "msg", role: "user", content: "{{ extensions.fixtureCompileOnce }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		};
		const ctx = new PromptCompilationContext(stack, runtime());
		const system = ctx.compileSystemPrompt("base");
		const messages = ctx.compileMessages([{ role: "user", content: "orig", timestamp: 1 }]);
		assert.equal(calls, 1);
		assert.equal(system.systemPrompt, "SV");
		const texts = messages.messages.map((message) => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" ? content : Array.isArray(content)
				? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("")
				: "";
		});
		assert.ok(texts.some((text) => text === "SV"));
	} finally {
		unregister();
	}
});

test("preview shares one compilation context (extension evaluated once)", async () => {
	let calls = 0;
	const unregister = registerMacro({
		name: "fixturePreviewOnce",
		render: () => {
			calls += 1;
			return "PV";
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "preview-once",
			items: [
				{ kind: "block", id: "sys", role: "system", content: "sys={{ extensions.fixturePreviewOnce }}" },
				{ kind: "block", id: "msg", role: "user", content: "msg={{ extensions.fixturePreviewOnce }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		};
		const { buildPreview } = await import("../src/preview.ts");
		const options = runtime().options;
		const previewCtx = {
			sessionManager: { getLeafId: () => null },
			getSystemPrompt: () => "base",
			getSystemPromptOptions: () => options,
		} as unknown as Parameters<typeof buildPreview>[0];
		const result = buildPreview(
			previewCtx,
			{ stack, filePath: "f", scope: "project", key: { scope: "project", id: "preview-once" }, diagnostics: [] },
			options,
		);
		assert.equal(calls, 1);
		assert.ok(result.preview.system.content.includes("sys=PV"));
		assert.ok(result.text.includes("msg=PV"));
	} finally {
		unregister();
	}
});

test("identical frozen input produces identical output across compilation entry points", async () => {
	let calls = 0;
	const unregister = registerMacro({
		name: "fixtureFrozen",
		render: () => {
			calls += 1;
			return "FZ";
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "frozen",
			items: [
				{ kind: "block", id: "sys", role: "system", content: "d={{ date }} s={{ extensions.fixtureFrozen }}" },
				{ kind: "block", id: "msg", role: "user", content: "m={{ extensions.fixtureFrozen }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		};
		const frozen = { ...runtime(), now: new Date("2026-07-14T00:00:00.000Z"), latestUserMessage: "hi" };
		const textParts = (message: AgentMessage): string => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" ? content : Array.isArray(content)
				? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("")
				: "";
		};

		const { PromptCompilationContext } = await import("../src/compiler.ts");
		const ctx = new PromptCompilationContext(stack, frozen);
		const contextSystem = ctx.compileSystemPrompt("base");
		const contextMessages = ctx.compileMessages([]);

		const { compileSystemPrompt, compileMessages } = await import("../src/compiler.ts");
		const topSystem = compileSystemPrompt(stack, frozen, "base");
		const topMessages = compileMessages(stack, frozen, []);

		assert.equal(contextSystem.systemPrompt, topSystem.systemPrompt);
		assert.deepEqual(contextMessages.messages.map(textParts), topMessages.messages.map(textParts));
		assert.equal(calls, 3); // context reuses one renderer (1); top-level wrappers each build one (2)
		assert.ok(contextSystem.systemPrompt.includes("s=FZ"));
	} finally {
		unregister();
	}
});

test("setLatestUserMessage invalidates the extension cache for env-dependent macros", async () => {
	const { PromptCompilationContext } = await import("../src/compiler.ts");
	let calls = 0;
	const unregister = registerMacro({
		name: "fixtureEnvReader",
		render: ({ env }) => {
			calls += 1;
			return `u=${String(env.runtime.lastUserMessage)}`;
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "env-order",
			items: [
				{ kind: "block", id: "sys", role: "system", content: "s={{ extensions.fixtureEnvReader }}" },
				{ kind: "block", id: "msg", role: "user", content: "m={{ extensions.fixtureEnvReader }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		};
		const ctx = new PromptCompilationContext(stack, { ...runtime(), latestUserMessage: "old" });
		const system = ctx.compileSystemPrompt("base");
		ctx.setLatestUserMessage("new");
		const messages = ctx.compileMessages([{ role: "user", content: "orig", timestamp: 1 }]);
		assert.equal(calls, 2);
		assert.equal(system.systemPrompt, "s=u=old");
		const texts = messages.messages.map((message) => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" ? content : Array.isArray(content)
				? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("")
				: "";
		});
		assert.ok(texts.some((text) => text === "m=u=new"));
	} finally {
		unregister();
	}
});

test("setLatestUserMessage with an unchanged value does not invalidate the extension cache", async () => {
	const { PromptCompilationContext } = await import("../src/compiler.ts");
	let calls = 0;
	const unregister = registerMacro({
		name: "fixtureSameValue",
		render: () => {
			calls += 1;
			return "SAME";
		},
	});
	try {
		const stack: PromptStack = {
			schemaVersion: 1,
			id: "env-same",
			items: [
				{ kind: "block", id: "sys", role: "system", content: "{{ extensions.fixtureSameValue }}" },
				{ kind: "block", id: "msg", role: "user", content: "{{ extensions.fixtureSameValue }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		};
		const ctx = new PromptCompilationContext(stack, { ...runtime(), latestUserMessage: "unchanged" });
		const system = ctx.compileSystemPrompt("base");
		ctx.setLatestUserMessage("unchanged");
		const messages = ctx.compileMessages([{ role: "user", content: "orig", timestamp: 1 }]);
		assert.equal(calls, 1);
		assert.equal(system.systemPrompt, "SAME");
		const texts = messages.messages.map((message) => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" ? content : Array.isArray(content)
				? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("")
				: "";
		});
		assert.ok(texts.some((text) => text === "SAME"));
	} finally {
		unregister();
	}
});
