import { Type } from "typebox";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Install the existing network guard before loading/operating the real SDK.
import { getBlockedFetchCount } from "./helpers/capability-agent-harness.ts";
import piForge from "../src/index.ts";
import { reconcileToolPolicyBaseline } from "../src/runtime/tool-policy-runtime.ts";
import { GLOBAL_FORGE_CONFIG_PATH_ENV } from "../src/forge-config.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";
import { resolveHostFamilyVersion } from "../scripts/packed-versions.ts";
import type { SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";

const SDK = await import("@earendil-works/pi-coding-agent");
const AI = await import("@earendil-works/pi-ai");
SDK.initTheme();
const [major, minor] = resolveHostFamilyVersion(process.cwd()).split(".").map(Number);
const restoresDefaultTools = major > 1 || (major === 1 && minor >= 3);
// `+name`/`-name` default-tool modifiers first shipped in Pi 1.1.0; older hosts
// would treat them as literal tool names, so the modifier cases do not exist there.
const supportsToolModifiers = major > 1 || (major === 1 && minor >= 1);
// Pi 1.4 resume also activates extension tools the branch never mentioned
// (AgentSession._restoreToolsFromTranscript "newTools"), so Forge's own
// default-active forge_capability joins a transcript that predates it.
const activatesUnmentionedExtensionTools = major > 1 || (major === 1 && minor >= 4);
const withUnmentioned = (names: string[]) => sorted(activatesUnmentionedExtensionTools ? [...names, "forge_capability"] : names);
const sorted = (names: string[]) => [...names].sort();

// Do NOT use the agent harness's explicit tools/noTools/setActiveTools setup:
// it intentionally overrides the SDK default/modifier transcript-restore path.
async function fixture(policy: "allow" | "deny", modifiers: boolean) {
	const root = mkdtempSync(join(tmpdir(), "forge-pi13-restore-"));
	const cwd = join(root, "project"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
	const oldGlobal = process.env[GLOBAL_FORGE_DIR_ENV], oldConfig = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(root, "global");
	process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = join(root, "global", "config.json");
	mkdirSync(agentDir, { recursive: true });
	for (const dir of ["prompt-stacks", "capabilities"]) mkdirSync(join(cwd, ".pi", "forge", dir), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "prompt-stacks", "restore.json"), JSON.stringify({
		schemaVersion: 1, id: "restore",
		tools: { ...(policy === "allow" ? { allow: ["read", "restore_extra"] } : { deny: ["write", "grep"] }), initial: ["read"] },
		items: [{ kind: "block", id: "sys", role: "system", content: "RESTORE-SENTINEL" }],
	}));
	writeFileSync(join(cwd, ".pi", "forge", "capabilities", "extra.json"), JSON.stringify({
		schemaVersion: 1, type: "pi-forge.capability", id: "extra", content: "CAPABILITY-RESTORED",
		tools: { add: ["restore_extra"], remove: [] },
	}));
	const fetchBefore = getBlockedFetchCount();
	async function open(manager: SessionManagerType) {
		const errors: unknown[] = [];
		const provider = AI.fauxProvider({ provider: "restore-faux", api: "restore-faux", models: [{ id: "probe", name: "Probe", reasoning: false }] });
		const runtime = await SDK.ModelRuntime.create({ credentials: new AI.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		const settings = SDK.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }, { projectTrusted: true });
		const loader = new SDK.DefaultResourceLoader({
			cwd, agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [api => {
				api.registerProvider(provider.provider);
				// Not an inline literal: `defaultActive` only exists in newer SDK types, and
				// older hosts (e.g. 0.87) simply ignore it at runtime.
				const restoreExtra = { name: "restore_extra", label: "Restore extra", description: "Offline inactive tool", defaultActive: false,
					parameters: Type.Object({}), execute: async () => { throw new Error("No tool execution expected"); } };
				api.registerTool(restoreExtra);
			}, piForge],
		});
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await SDK.createAgentSession({
			cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model: provider.getModel(), settingsManager: settings, sessionManager: manager,
			...(modifiers ? { tools: ["-grep", "+write"] } : {}),
		});
		const startup = sorted(session.getActiveToolNames());
		await session.bindExtensions({ onError: error => errors.push(error) });
		return {
			session, startup, errors,
			command: async (name: string, args: string) => {
				const command = session.extensionRunner.getCommand(name); assert.ok(command);
				await command.handler(args, session.extensionRunner.createCommandContext());
			},
			prompt: async () => { provider.setResponses([AI.fauxAssistantMessage("offline done")]); await session.prompt("Persist this fixture"); },
			close: async () => {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose(); assert.deepEqual(errors, []);
			},
		};
	}
	return { cwd, sessionDir, open, cleanup: () => {
		assert.equal(getBlockedFetchCount(), fetchBefore, "no network calls");
		if (oldGlobal === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV]; else process.env[GLOBAL_FORGE_DIR_ENV] = oldGlobal;
		if (oldConfig === undefined) delete process.env[GLOBAL_FORGE_CONFIG_PATH_ENV]; else process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = oldConfig;
		rmSync(root, { recursive: true, force: true });
	} };
}

for (const policy of ["allow", "deny"] as const) for (const modifiers of supportsToolModifiers ? [false, true] : [false]) for (const capability of [false, true]) {
	test(`real SDK transcript restore: ${policy}, modifiers=${modifiers}, capability=${capability}`, async () => {
		const f = await fixture(policy, modifiers);
		let live: Awaited<ReturnType<typeof f.open>> | undefined;
		try {
			const manager = SDK.SessionManager.create(f.cwd, f.sessionDir);
			manager.appendMessage({ role: "system", content: "BASE", toolsAdded: ["read", "grep"].map(name => ({ name, description: name, parameters: Type.Object({}) })), timestamp: 1 });
			live = await f.open(manager);
			if (restoresDefaultTools) assert.deepEqual(live.startup, withUnmentioned(modifiers ? ["read", "write"] : ["read", "grep"]));
			const originalBaseline = live.startup;
			await live.command("preset", "use project:restore");
			await live.command("preset", "use off");
			assert.deepEqual(sorted(live.session.getActiveToolNames()), originalBaseline, "preset disable restores the transcript/modifier startup baseline");
			await live.command("preset", "use project:restore");
			assert.deepEqual(sorted(live.session.getActiveToolNames()), ["read"]);
			if (capability) await live.command("capability", "enable project:extra");
			const effective = sorted(capability ? ["read", "restore_extra"] : ["read"]);
			assert.deepEqual(sorted(live.session.getActiveToolNames()), effective);
			await live.prompt();
			// Persist an intentionally stale loadout: a forbidden tool appears and a
			// Capability-added inactive tool disappears. Forge's stored state is intact.
			manager.appendMessage({ role: "system", content: "", toolsAdded: [{ name: "write", description: "stale", parameters: Type.Object({}) }], toolsRemoved: [{ name: "restore_extra" }], timestamp: 2 });
			const file = manager.getSessionFile()!;
			await live.close(); live = undefined;
			const resumed = SDK.SessionManager.open(file, f.sessionDir, f.cwd);
			live = await f.open(resumed);
			if (restoresDefaultTools) assert.deepEqual(live.startup, withUnmentioned(["read", "write"]), "SDK really restores the stale transcript before Forge binds");
			assert.deepEqual(sorted(live.session.getActiveToolNames()), effective, "Forge owns effective selection after resume, not stale transcript tools");
			await live.prompt();
			assert.deepEqual(sorted(live.session.getActiveToolNames()), effective, "first resumed turn keeps the policy ceiling and Capability additions");
			if (capability) {
				await live.command("capability", "disable extra");
				assert.deepEqual(sorted(live.session.getActiveToolNames()), ["read"]);
			} else {
				await live.command("preset", "use off");
				// Forge persists its pre-policy baseline: do not mistake the host's
				// restored *policy-reduced* transcript for that original baseline.
				const baseline = sorted(reconcileToolPolicyBaseline(originalBaseline, effective, live.startup));
				assert.deepEqual(sorted(live.session.getActiveToolNames()), baseline, "disable preserves saved startup baseline plus distinguishable external additions");
			}
		} finally { if (live) await live.close(); f.cleanup(); }
	});
}
