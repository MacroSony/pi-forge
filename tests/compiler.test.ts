import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
} from "../src/compiler.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";

function runtime(overrides: Partial<PromptRuntime> = {}): PromptRuntime {
	return {
		options: {
			cwd: "/work/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files from disk." },
			promptGuidelines: ["Use read before editing files."],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "latest request",
		now: new Date("2026-06-13T12:00:00Z"),
		variables: createPromptVariableStore({ topic: "session topic" }),
		...overrides,
	};
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function assistant(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const obj = part as { type?: unknown; text?: unknown };
			return obj.type === "text" && typeof obj.text === "string" ? obj.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

type RuntimeSkill = NonNullable<PromptRuntime["options"]["skills"]>[number];

function testSkill(name: string, description: string, filePath: string, overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
	return {
		name,
		description,
		filePath,
		baseDir: filePath.replace(/\/SKILL\.md$/, ""),
		sourceInfo: { type: "test" },
		disableModelInvocation: false,
		...overrides,
	} as RuntimeSkill;
}

test("compileSystemPrompt preserves enabled system item order", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "ordered",
		mode: "replace",
		items: [
			{ kind: "block", id: "a", enabled: true, role: "system", content: "A" },
			{ kind: "block", id: "ignored-user", enabled: true, role: "user", content: "ignored" },
			{ kind: "slot", id: "date", enabled: true, role: "system", slot: "date" },
			{ kind: "block", id: "b", enabled: true, role: "system", content: "B" },
		],
	};

	const result = compileSystemPrompt(stack, runtime(), "base");

	assert.equal(result.systemPrompt, "A\n\nCurrent date: 2026-06-13\n\nB");
	assert.deepEqual(result.diagnostics, []);
});

test("empty replacement system prompt preserves the base prompt", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "empty",
		mode: "replace",
		items: [{ kind: "block", id: "user-only", enabled: true, role: "user", content: "not system" }],
	};

	const result = compileSystemPrompt(stack, runtime(), "base prompt");

	assert.equal(result.systemPrompt, "base prompt");
	assert.match(result.diagnostics[0]?.message ?? "", /preserving base system prompt/);
});

test("compileMessages expands chat history at the configured slot", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "messages",
		items: [
			{ kind: "block", id: "pre", enabled: true, role: "user", content: "before" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history", options: { includeLastUserMessage: false } },
			{ kind: "block", id: "post", enabled: true, role: "user", content: "latest: {{lastUserMessage}}" },
		],
	};
	const messages = [user("first"), assistant("reply"), user("latest request")];

	const result = compileMessages(stack, runtime({ latestUserMessage: "latest request" }), messages);

	assert.equal(result.messages.length, 4);
	assert.equal(textOf(result.messages[0]), "before");
	assert.equal(textOf(result.messages[1]), "first");
	assert.equal(textOf(result.messages[2]), "reply");
	assert.equal(textOf(result.messages[3]), "latest: latest request");
	assert.deepEqual(result.diagnostics, []);
});

test("history regex transforms only chat-history messages", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "history-regex",
		regex: {
			rules: [{
				id: "strip-assistant-ooc",
				stage: "history",
				pattern: "\\s*\\(OOC:[^)]+\\)",
				flags: "g",
				replace: "",
				roles: ["assistant"],
			}],
		},
		items: [
			{ kind: "block", id: "pre", enabled: true, role: "user", content: "before (OOC: stays)" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history", options: { includeLastUserMessage: false } },
			{ kind: "block", id: "post", enabled: true, role: "user", content: "after" },
		],
	};
	const messages = [user("(OOC: user stays) hello"), assistant("reply (OOC: hidden)"), user("latest request")];

	const result = compileMessages(stack, runtime({ latestUserMessage: "latest request" }), messages);

	assert.equal(textOf(result.messages[0]!), "before (OOC: stays)");
	assert.equal(textOf(result.messages[1]!), "(OOC: user stays) hello");
	assert.equal(textOf(result.messages[2]!), "reply");
	assert.equal(textOf(result.messages[3]!), "after");
	assert.ok(result.diagnostics.some((diagnostic) => /strip-assistant-ooc/.test(diagnostic.message)));
});

test("compiled regex transforms final system prompt", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "system-regex",
		regex: {
			rules: [{
				id: "system-secret",
				stage: "compiled",
				targets: ["system"],
				pattern: "SECRET",
				replace: "public",
			}],
		},
		items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Keep SECRET" }],
	};

	const result = compileSystemPrompt(stack, runtime(), "base");

	assert.equal(result.systemPrompt, "Keep public");
	assert.ok(result.diagnostics.some((diagnostic) => /system-secret/.test(diagnostic.message)));
});

test("compiled regex transforms final message text after macros", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "message-regex",
		variables: { name: "Ada" },
		regex: {
			rules: [{
				id: "macro-output",
				stage: "compiled",
				targets: ["messages"],
				pattern: "Hello Ada",
				replace: "Hi Ada",
			}],
		},
		items: [{ kind: "block", id: "user", enabled: true, role: "user", content: "Hello {{name}}" }],
	};

	const result = compileMessages(stack, runtime(), []);

	assert.equal(textOf(result.messages[0]!), "Hi Ada");
});

test("compiled regex preserves non-text message parts", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "non-text",
		regex: {
			rules: [{
				id: "text-only",
				stage: "compiled",
				pattern: "secret",
				replace: "redacted",
			}],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	};
	const message = assistant("secret");
	const originalContent = (message as unknown as { content: Array<Record<string, unknown>> }).content;
	originalContent.push({ type: "toolCall", name: "secret" });

	const result = compileMessages(stack, runtime(), [message]);
	const content = (result.messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;

	assert.equal(content[0]?.text, "redacted");
	assert.deepEqual(content[1], { type: "toolCall", name: "secret" });
});

test("variables resolve in turn, session, then static order", () => {
	const store = createPromptVariableStore({ name: "session", topic: "session topic" });
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "variables",
		variables: { name: "static", char: "Konata" },
		items: [
			{
				kind: "block",
				id: "vars",
				enabled: true,
				role: "system",
				content: "{{setvar::name::turn}}{{name}}/{{getsessionvar::name}}/{{char}}/{{setvar::session::mood::bright}}{{getsessionvar::mood}}",
			},
		],
	};

	const result = compileSystemPrompt(stack, runtime({ variables: store }), "base");

	assert.equal(result.systemPrompt, "turn/session/Konata/bright");
	assert.equal(store.session.mood, "bright");
	assert.equal(store.sessionDirty, true);
});

test("time macro renders from the runtime clock", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "time",
		items: [{ kind: "block", id: "clock", enabled: true, role: "system", content: "{{date}} {{time}}" }],
	};

	const result = compileSystemPrompt(stack, runtime({ now: new Date(2026, 5, 13, 9, 8, 7) }), "base");

	assert.equal(result.systemPrompt, "2026-06-13 09:08:07");
	assert.deepEqual(result.diagnostics, []);
});

test("unknown macros are kept and diagnosed", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "unknown",
		items: [{ kind: "block", id: "block", enabled: true, role: "system", content: "A {{missing}}" }],
	};

	const result = compileSystemPrompt(stack, runtime(), "base");

	assert.equal(result.systemPrompt, "A {{missing}}");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "block");
	assert.match(result.diagnostics[0]?.message ?? "", /Unresolved macro/);
});

test("duplicate chat-history slots warn and only expand once by default", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "duplicate-history",
		items: [
			{ kind: "slot", id: "history-1", enabled: true, slot: "chat-history" },
			{ kind: "slot", id: "history-2", enabled: true, slot: "chat-history" },
		],
	};
	const messages = [user("one")];

	const result = compileMessages(stack, runtime(), messages);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "one");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "history-2");
	assert.match(result.diagnostics[0]?.message ?? "", /duplicate chat-history/);
});

test("structured slots default to XML and ignore unsupported json format", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "structured-defaults",
		items: [
			{ kind: "slot", id: "tools", enabled: true, role: "system", slot: "tools" },
			{ kind: "slot", id: "guidelines", enabled: true, role: "system", slot: "tool-guidelines", options: { format: "json" } },
			{ kind: "slot", id: "skills", enabled: true, role: "system", slot: "skills" },
			{ kind: "slot", id: "context", enabled: true, role: "system", slot: "project-context" },
		],
	};
	const result = compileSystemPrompt(stack, runtime({
		options: {
			...runtime().options,
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read files from disk.", bash: "Run shell commands." },
			skills: [testSkill("review", "Review code.", "/skills/review/SKILL.md")],
			contextFiles: [{ path: ".pi/instructions.md", content: "Project rules." }],
		},
	}), "base");

	assert.match(result.systemPrompt, /<available_tools>/);
	assert.match(result.systemPrompt, /<tool_guidelines>/);
	assert.match(result.systemPrompt, /<available_skills>/);
	assert.match(result.systemPrompt, /<project_context>/);
	assert.match(result.systemPrompt, /<project_instructions path="\.pi\/instructions\.md">/);
	assert.doesNotMatch(result.systemPrompt, /Available tools:/);
	assert.deepEqual(result.diagnostics, []);
});

test("structured slots render compact plain format", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "structured-plain",
		items: [
			{ kind: "slot", id: "tools", enabled: true, role: "system", slot: "tools", options: { format: "plain" } },
			{ kind: "slot", id: "guidelines", enabled: true, role: "system", slot: "tool-guidelines", options: { format: "plain" } },
			{ kind: "slot", id: "skills", enabled: true, role: "system", slot: "skills", options: { format: "plain" } },
			{ kind: "slot", id: "context", enabled: true, role: "system", slot: "project-context", options: { format: "plain" } },
		],
	};
	const result = compileSystemPrompt(stack, runtime({
		options: {
			...runtime().options,
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read files\nfrom disk.", bash: "Run shell commands." },
			promptGuidelines: ["Use read\nbefore edits."],
			skills: [
				testSkill("review", "Review code\nfor regressions.", "/skills/review/SKILL.md"),
				testSkill("hidden", "Hidden skill.", "/skills/hidden/SKILL.md", { disableModelInvocation: true }),
			],
			contextFiles: [{ path: ".pi/instructions.md", content: "Project <rules>\nSecond line." }],
		},
	}), "base");

	assert.match(result.systemPrompt, /Available tools:\n- read: Read files\n  from disk\.\n- bash: Run shell commands\./);
	assert.match(result.systemPrompt, /Tool guidelines:\n- Use bash for file operations like ls, rg, find\.\n- Use read\n  before edits\./);
	assert.match(result.systemPrompt, /Available skills:\n- review: Review code\n  for regressions\.\n  Location: \/skills\/review\/SKILL\.md/);
	assert.doesNotMatch(result.systemPrompt, /hidden/);
	assert.match(result.systemPrompt, /Project context:\n\nProject-specific instructions and guidelines:\n\nPath: \.pi\/instructions\.md\n  Project <rules>\n  Second line\./);
	assert.doesNotMatch(result.systemPrompt, /<available_tools>|<available_skills>|<project_context>/);
	assert.deepEqual(result.diagnostics, []);
});

test("tool policy filters rendered tools and tool macros", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "tool-policy",
		tools: {
			allow: ["read", "bash", "write"],
		},
		items: [
			{ kind: "slot", id: "tools", enabled: true, role: "system", slot: "tools", options: { format: "plain" } },
			{ kind: "block", id: "macro", enabled: true, role: "system", content: "Selected: {{tools}}" },
		],
	};

	const result = compileSystemPrompt(stack, runtime({
		options: {
			cwd: "/work/project",
			selectedTools: ["read", "bash", "edit", "write"],
			toolSnippets: {
				read: "Read files.",
				bash: "Run shell commands.",
				edit: "Edit files.",
				write: "Write files.",
			},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
	}), "base");

	assert.match(result.systemPrompt, /Available tools:\n- read: Read files\.\n- bash: Run shell commands\.\n- write: Write files\./);
	assert.doesNotMatch(result.systemPrompt, /edit/);
	assert.match(result.systemPrompt, /Selected: read, bash, write/);
});

test("skill policy filters rendered skills with wildcard patterns", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "skill-policy",
		skills: {
			allow: ["review", "browser-*"],
		},
		items: [{ kind: "slot", id: "skills", enabled: true, role: "system", slot: "skills", options: { format: "plain" } }],
	};

	const result = compileSystemPrompt(stack, runtime({
		options: {
			cwd: "/work/project",
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [
				testSkill("review", "Review code.", "/skills/review/SKILL.md"),
				testSkill("browser-search", "Search browser.", "/skills/browser-search/SKILL.md"),
				testSkill("browser-danger", "Dangerous browser.", "/skills/browser-danger/SKILL.md"),
				testSkill("write", "Write prose.", "/skills/write/SKILL.md"),
			],
		},
	}), "base");

	assert.match(result.systemPrompt, /- review: Review code\./);
	assert.match(result.systemPrompt, /- browser-search: Search browser\./);
	assert.match(result.systemPrompt, /- browser-danger: Dangerous browser\./);
	assert.doesNotMatch(result.systemPrompt, /Write prose/);
});

test("variables slot renders all scopes as XML", () => {
	const store = createPromptVariableStore({ mood: "happy", progress: "step 2" });
	store.turn = { recent: "just happened" };
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-slot",
		variables: { char: "Konata", user: "USER" },
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables" },
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /<prompt_state>/);
	assert.match(text, /<static>/);
	assert.match(text, /<var name="char" type="string">Konata<\/var>/);
	assert.match(text, /<var name="user" type="string">USER<\/var>/);
	assert.match(text, /<session>/);
	assert.match(text, /<var name="mood" type="string">happy<\/var>/);
	assert.match(text, /<var name="progress" type="string">step 2<\/var>/);
	assert.match(text, /<turn>/);
	assert.match(text, /<var name="recent" type="string">just happened<\/var>/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot respects include options", () => {
	const store = createPromptVariableStore({ mood: "happy" });
	store.turn = { recent: "just happened" };
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-options",
		variables: { char: "Konata" },
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: { includeStatic: false, includeSession: true, includeTurn: false },
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /<prompt_state>/);
	assert.match(text, /<session>/);
	assert.match(text, /<var name="mood" type="string">happy<\/var>/);
	// Static and turn should be excluded
	assert.doesNotMatch(text, /<static>/);
	assert.doesNotMatch(text, /<turn>/);
	assert.doesNotMatch(text, /Konata/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot is empty when no variables exist", () => {
	const store = createPromptVariableStore();
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-empty",
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables" },
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), [user("original")]);

	// No variables block emitted — just the original message
	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "original");
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot escapes XML in values", () => {
	const store = createPromptVariableStore({ code: "<script>alert('xss')</script>" });
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-xml",
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables" },
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /&lt;script&gt;alert/);
	assert.doesNotMatch(text, /<script>alert/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot preserves JSON format", () => {
	const store = createPromptVariableStore({ mood: "happy" });
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-json",
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: { includeScopes: ["session"], format: "json" },
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /<prompt_state format="json">/);
	assert.match(text, /&quot;session&quot;/);
	assert.match(text, /&quot;mood&quot;: &quot;happy&quot;/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot renders compact plain format with metadata and multiline values", () => {
	const store = createPromptVariableStore({
		"agent.note": "a<\n&",
		"agent.long": "abcdef",
		"user.preference": "concise",
	});
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-plain",
		state: {
			schemaVersion: 1,
			definitions: {
				"agent.note": {
					type: "string",
					scope: "session",
					description: "Current <note>",
					agentWritable: true,
				},
				"agent.long": {
					type: "string",
					scope: "session",
					agentWritable: true,
				},
				"agent.missing": {
					type: "string",
					scope: "session",
					description: "Missing value",
					agentWritable: true,
				},
			},
		},
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: {
					includeScopes: ["session"],
					includeNamespaces: ["agent.*"],
					includeMetadata: true,
					format: "plain",
					maxValueChars: 5,
				},
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), [
		"Prompt state:",
		"session:",
		"- agent.long (string; agentWritable: true): abcde",
		"  [truncated]",
		"- agent.note (string; description: Current <note>; agentWritable: true): a<",
		"  &",
		"- agent.missing (string; unset; description: Missing value; agentWritable: true): (unset)",
	].join("\n"));
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot filters session state and includes metadata", () => {
	const store = createPromptVariableStore({
		"agent.count": 2,
		"user.preference": "concise",
		"other": "ignored",
	});
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-filter",
		state: {
			schemaVersion: 1,
			definitions: {
				"agent.count": {
					type: "number",
					scope: "session",
					description: "Number of completed steps",
					agentWritable: true,
				},
			},
		},
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: {
					includeScopes: ["session"],
					includeNamespaces: ["agent.*"],
					includeMetadata: true,
				},
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: store }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /<session>/);
	assert.match(text, /<var name="agent.count" type="number" description="Number of completed steps" agentWritable="true">2<\/var>/);
	assert.doesNotMatch(text, /user.preference/);
	assert.doesNotMatch(text, /other/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot renders metadata-only state definitions as unset", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-unset-definitions",
		state: {
			schemaVersion: 1,
			definitions: {
				"agent.progress": {
					type: "string",
					scope: "session",
					description: "Current progress",
					agentWritable: true,
				},
				"user.preference": {
					type: "string",
					scope: "session",
					description: "User preference",
					userWritable: true,
				},
				"internal.hidden": {
					type: "string",
					scope: "session",
				},
			},
		},
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: {
					includeScopes: ["session"],
					includeNamespaces: ["agent.*", "user.*"],
					includeMetadata: true,
				},
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: createPromptVariableStore() }), []);

	assert.equal(result.messages.length, 1);
	const text = textOf(result.messages[0]);
	assert.match(text, /<prompt_state>/);
	assert.match(text, /<var name="agent.progress" type="string" unset="true" description="Current progress" agentWritable="true"><\/var>/);
	assert.match(text, /<var name="user.preference" type="string" unset="true" description="User preference" userWritable="true"><\/var>/);
	assert.doesNotMatch(text, /internal.hidden/);
	assert.deepEqual(result.diagnostics, []);
});

test("variables slot omits unset state definitions unless metadata is enabled", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "vars-no-metadata",
		state: {
			definitions: {
				"agent.progress": {
					type: "string",
					scope: "session",
					agentWritable: true,
				},
			},
		},
		items: [
			{
				kind: "slot",
				id: "vars",
				enabled: true,
				role: "user",
				slot: "variables",
				options: {
					includeScopes: ["session"],
					includeNamespaces: ["agent.*"],
				},
			},
		],
	};

	const result = compileMessages(stack, runtime({ variables: createPromptVariableStore() }), [user("original")]);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "original");
	assert.deepEqual(result.diagnostics, []);
});

test("macros stringify non-string state values", () => {
	const store = createPromptVariableStore({
		flags: ["brief", "technical"],
		count: 2,
	});
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "typed-macros",
		items: [
			{
				kind: "block",
				id: "vars",
				enabled: true,
				role: "system",
				content: "flags={{flags}} count={{getsessionvar::count}}",
			},
		],
	};

	const result = compileSystemPrompt(stack, runtime({ variables: store }), "base");

	assert.equal(result.systemPrompt, 'flags=["brief","technical"] count=2');
	assert.deepEqual(result.diagnostics, []);
});

test("unsupported slots produce diagnostics", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "unsupported",
		items: [{ kind: "slot", id: "bad-slot", enabled: true, role: "user", slot: "not-real" }],
	};

	const result = compileMessages(stack, runtime(), [user("original")]);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "original");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "bad-slot");
	assert.match(result.diagnostics[0]?.message ?? "", /Unsupported slot/);
});
