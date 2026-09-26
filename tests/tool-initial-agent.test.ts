import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// Import the real SDK harness first: it installs the process-wide fetch guard.
import { createCapabilityAgentControlHarness } from "./helpers/capability-agent-control-harness.ts";

const { initTheme, SessionManager } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");

const REGISTERED = ["fake_read", "fake_write", "fake_driver", "forge_capability"];
const BASELINE = ["fake_read", "forge_capability"];

function textOf(value: any): string {
	if (typeof value?.content === "string") return value.content;
	if (Array.isArray(value?.content)) {
		return value.content.map((part: any) => part?.text ?? "").join("\n");
	}
	return "";
}

function toolNames(context: any): string[] {
	return getCurrentTools(context.messages).map((tool: any) => tool.name);
}

function toolResultText(context: any): string {
	return context.messages
		.filter((message: any) => message.role === "toolResult")
		.map(textOf)
		.join("\n");
}

function setupProject() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-tool-initial-agent-"));
	const forgeDir = join(cwd, ".pi", "forge");
	const stacksDir = join(forgeDir, "prompt-stacks");
	const modesDir = join(forgeDir, "capabilities");
	mkdirSync(stacksDir, { recursive: true });
	mkdirSync(modesDir, { recursive: true });
	writeFileSync(join(forgeDir, "config.json"), JSON.stringify({ autoActivate: true }));

	const slots = [
		{ kind: "slot", id: "tools", role: "system", slot: "tools", options: { format: "plain" } },
		{
			kind: "slot",
			id: "guidelines",
			role: "system",
			slot: "tool-guidelines",
			options: { format: "plain", includePiDefaultGuidelines: true },
		},
	];
	const base = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "base",
		name: "Initial tool base",
		autoActivate: true,
		tools: { allow: REGISTERED, initial: BASELINE },
		capabilities: [
			{ ref: "review", id: "review", modelCallable: true },
			{ ref: "shared-a", id: "shared-a", modelCallable: true },
			{ ref: "shared-b", id: "shared-b", modelCallable: true },
		],
		items: [
			{ kind: "block", id: "base-rule", role: "system", content: "BASE_INITIAL_TOOL_RULE" },
			...slots,
		],
	};
	writeFileSync(join(stacksDir, "base.json"), JSON.stringify(base, null, 2));

	// This preset deliberately has an empty initial selection. It is used to
	// prove that reset does not resurrect the prior SDK active-tool list.
	const empty = {
		...base,
		id: "empty",
		name: "Empty initial",
		autoActivate: false,
		tools: { allow: REGISTERED, initial: [] },
		capabilities: [
			{ ref: "shared-a", id: "shared-a", modelCallable: true },
			{ ref: "shared-b", id: "shared-b", modelCallable: true },
		],
		items: [{ kind: "block", id: "empty-rule", role: "system", content: "EMPTY_INITIAL_RULE" }, ...slots],
	};
	writeFileSync(join(stacksDir, "empty.json"), JSON.stringify(empty, null, 2));

	// A different policy ceiling rejects a mode that tries to add fake_driver.
	const restricted = {
		...base,
		id: "restricted",
		name: "Restricted driver policy",
		autoActivate: false,
		tools: { allow: ["fake_read", "fake_write", "forge_capability"], initial: BASELINE },
		capabilities: [{ ref: "driver", id: "driver", modelCallable: true }],
		items: [{ kind: "block", id: "restricted-rule", role: "system", content: "RESTRICTED_RULE" }, ...slots],
	};
	writeFileSync(join(stacksDir, "restricted.json"), JSON.stringify(restricted, null, 2));

	const mode = (id: string, content: string, add: string[]) => ({
		schemaVersion: 1,
		type: "pi-forge.capability",
		id,
		name: id,
		content,
		tools: { add, remove: [] },
	});
	writeFileSync(join(modesDir, "review.json"), JSON.stringify(mode("review", "LITERAL_FAKE_WRITE_RULE", ["fake_write"]), null, 2));
	writeFileSync(join(modesDir, "shared-a.json"), JSON.stringify(mode("shared-a", "SHARED_A_RULE", ["fake_write"]), null, 2));
	writeFileSync(join(modesDir, "shared-b.json"), JSON.stringify(mode("shared-b", "SHARED_B_RULE", ["fake_write"]), null, 2));
	writeFileSync(join(modesDir, "driver.json"), JSON.stringify(mode("driver", "DRIVER_RULE", ["fake_driver"]), null, 2));

	return {
		cwd,
		sessionDir: join(cwd, "sessions"),
		modePath: join(modesDir, "review.json"),
		cleanup() {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function newHarness(cwd: string, native: boolean, sessionManager?: any) {
	return createCapabilityAgentControlHarness({
		cwd,
		native,
		sessionManager,
		// The ceiling registers fake_write, but the preset's initial selection does not.
		allowedTools: REGISTERED,
		initialTools: BASELINE,
	});
}

async function callMode(harness: any, action: "list" | "enable" | "disable", id?: string) {
	harness.setResponses([
		{ toolCalls: [{ name: "forge_capability", args: { action, ...(id ? { id } : {}) } }] },
		`${action} complete`,
	]);
	await harness.prompt(`${action} ${id ?? ""}`.trim());
}

async function staleWriterCall(harness: any) {
	harness.setResponses([
		{ toolCalls: [{ name: "fake_write", args: { path: "stale.txt", content: "must not run" } }] },
		"stale call handled",
	]);
	await harness.prompt("Call the inactive writer anyway");
	const last = harness.streamContexts.at(-1);
	assert.ok(last, "stale call should still produce a real SDK follow-up context");
	assert.match(`${toolResultText(last)} ${JSON.stringify(last.messages)}`, /inactive|blocked|not available|unknown|not found/i);
}

async function assertPromptLoadout(harness: any, expectedWriter: boolean) {
	harness.setResponses(["loadout observed"]);
	await harness.prompt("Show the current tool loadout");
	const context = harness.streamContexts.at(-1)!;
	const names = toolNames(context);
	assert.equal(names.includes("fake_write"), expectedWriter, "provider tool schema must follow effective active tools");
	const system = getCurrentSystemPrompt(context.messages);
	assert.ok(system.includes(expectedWriter ? "fake_write" : "fake_read"), `compiled prompt must contain the active tool text; system=${system}`);
	return { context, system };
}

test("SDK 0.87 initial tool policy: native and fallback effective-loadout regressions", async (suite) => {
	for (const native of [true, false]) {
		await suite.test(`${native ? "native" : "fallback"} initial schema, agent control, slots, and execution`, async () => {
			const env = setupProject();
			const harness = await newHarness(env.cwd, native);
			try {
				// The real SDK applies the harness' explicit active list after extension
				// loading; reselect the auto-activated preset through its public command
				// so the preset initial policy is the owner before assertions begin.
				await harness.prompt("/preset use base");
				// The registry is the policy ceiling, not the initial active selection.
				assert.deepEqual(harness.getActiveToolNames(), BASELINE);
				assert.deepEqual(
					new Set(harness.session.getAllTools().map((tool: any) => tool.name).filter((name: string) => REGISTERED.includes(name))),
					new Set(REGISTERED),
				);

				await staleWriterCall(harness);
				assert.equal(harness.toolExecutions.filter((call: any) => call.name === "fake_write").length, 0);
				assert.equal(harness.fetchAttempts, 0, "the hermetic SDK path must not fetch");

				const before = await assertPromptLoadout(harness, false);
				assert.ok(!toolNames(before.context).includes("fake_write"), "initial provider schema excludes writer");

				// list/use are genuine model tool calls. list must not itself infer or activate a mode.
				const beforeListTurns = harness.streamContexts.length;
				await callMode(harness, "list");
				assert.equal(harness.streamContexts.length, beforeListTurns + 2, "list uses exactly one management inference plus its scripted reply");
				assert.ok(!harness.getActiveToolNames().includes("fake_write"));
				assert.match(JSON.stringify(harness.streamContexts.at(-1)!.messages), /review/);

				const beforeUseTurns = harness.streamContexts.length;
				await callMode(harness, "enable", "review");
				assert.equal(harness.streamContexts.length, beforeUseTurns + 2, "use uses one management inference plus its scripted reply");
				assert.ok(harness.getActiveToolNames().includes("fake_write"), "Agent use dynamically enables registered writer");
				const activated = await assertPromptLoadout(harness, true);
				const projectedActivation = native ? activated.system : JSON.stringify(activated.context.messages);
				assert.match(projectedActivation, /LITERAL_FAKE_WRITE_RULE/);
				// The tool slot and the rules/guidelines projection must be rebuilt from the
				// effective selection, not from the preset's initial list. This intentionally
				// records the current render-helper red case until the parent source fix lands.
				assert.match(activated.system, /Available tools:[\s\S]*fake_write/);
				assert.match(activated.system, /Tool guidelines:/, "default guidelines slot remains projected");

				harness.setResponses([
					{ toolCalls: [{ name: "fake_write", args: { path: "actual.txt", content: "allowed" } }] },
					"writer executed",
				]);
				await harness.prompt("Use the newly enabled writer");
				assert.equal(harness.toolExecutions.filter((call: any) => call.name === "fake_write").length, 1);

				await callMode(harness, "disable", "review");
				assert.deepEqual(harness.getActiveToolNames(), BASELINE, "off restores the preset initial selection");
				const afterOff = await assertPromptLoadout(harness, false);
				assert.doesNotMatch(getCurrentSystemPrompt(afterOff.context.messages), /LITERAL_FAKE_WRITE_RULE/);
				await staleWriterCall(harness);
				assert.equal(harness.toolExecutions.filter((call: any) => call.name === "fake_write").length, 1, "stale writer remains unexecuted after off");
				assert.equal(harness.fetchAttempts, 0);
			} finally {
				await harness.dispose();
				env.cleanup();
			}
		});
	}
});

test("initial policy ceiling, immutable mode snapshots, shared additions, reset, and disk reopen", async () => {
	const env = setupProject();
	mkdirSync(env.sessionDir, { recursive: true });
	const manager = SessionManager.create(env.cwd, env.sessionDir);
	const h1 = await newHarness(env.cwd, true, manager);
	let sessionFile = "";
	try {
		await callMode(h1, "enable", "review");
		assert.ok(h1.getActiveToolNames().includes("fake_write"));
		// The activated snapshot is immutable across a disk reload of the source file.
		writeFileSync(env.modePath, JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.capability",
			id: "review",
			name: "review changed",
			content: "CHANGED_ON_DISK_MUST_NOT_REPLACE_SNAPSHOT",
			tools: { add: [], remove: ["fake_write"] },
		}, null, 2));
		await h1.prompt("/preset reload");
		h1.setResponses(["immutable snapshot observed"]);
		await h1.prompt("Check the active rule after disk reload");
		assert.match(getCurrentSystemPrompt(h1.streamContexts.at(-1)!.messages), /LITERAL_FAKE_WRITE_RULE/);
		assert.doesNotMatch(getCurrentSystemPrompt(h1.streamContexts.at(-1)!.messages), /CHANGED_ON_DISK/);

		h1.setResponses(["flush activation to disk"]);
		await h1.prompt("Persist the active mode");
		sessionFile = manager.getSessionFile()!;
		assert.ok(sessionFile);
	} finally {
		await h1.dispose();
	}

	const reopenedManager = SessionManager.open(sessionFile, env.sessionDir, env.cwd);
	const h2 = await newHarness(env.cwd, true, reopenedManager);
	try {
		assert.ok(h2.getActiveToolNames().includes("fake_write"), "disk reopen restores active effective writer");
		await callMode(h2, "disable", "review");
		assert.deepEqual(h2.getActiveToolNames(), BASELINE);

		// An original policy ceiling still rejects a mode add, even though the tool is
		// registered and executable in the same SDK harness.
		await h2.prompt("/preset use restricted");
		assert.deepEqual(h2.getActiveToolNames(), BASELINE);
		await callMode(h2, "enable", "driver");
		assert.ok(!h2.getActiveToolNames().includes("fake_driver"), "restricted preset rejects driver mode add");
		assert.equal(h2.toolExecutions.filter((call: any) => call.name === "fake_driver").length, 0);

		// Two active modes share the same addition. Turning one off keeps the shared
		// tool; reset on a preset whose initial selection is [] removes everything.
		await h2.prompt("/preset use base");
		assert.deepEqual(h2.getActiveToolNames(), BASELINE, "switching presets restores the selected preset baseline");
		await callMode(h2, "enable", "shared-a");
		await callMode(h2, "enable", "shared-b");
		assert.ok(h2.getActiveToolNames().includes("fake_write"));
		await callMode(h2, "disable", "shared-a");
		assert.ok(h2.getActiveToolNames().includes("fake_write"));

		await h2.prompt("/preset use empty");
		await h2.prompt("/capability enable-bound shared-a");
		await h2.prompt("/capability enable-bound shared-b");
		assert.ok(h2.getActiveToolNames().includes("fake_write"));
		await h2.prompt("/capability reset");
		assert.deepEqual(h2.getActiveToolNames(), [], "reset honors empty preset initial rather than restoring a stale baseline");
		assert.equal(h2.fetchAttempts, 0);
	} finally {
		await h2.dispose();
		env.cleanup();
	}
});
