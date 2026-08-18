import assert from "node:assert/strict";
import test from "node:test";
import { compileSystemPrompt, compileMessages } from "../src/compiler.ts";
import { forgeV1, FORGE_V1_MAX_TEMPLATE_OUTPUT, registerMacro } from "../src/index.ts";
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
