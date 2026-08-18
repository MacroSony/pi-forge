import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// The external-consumer surface: only the published @zihanw/pi-forge/subagent
// host-port names are imported here (no src/workspace, subagent-host, loaders,
// compiler, or profile internals).
import {
	ForgeHostClient,
	ForgeHostPortError,
	validateListProfilesResponse,
	validatePrepareResponse,
} from "../src/subagent/index.ts";
import {
	createContext,
	createHarness,
	startSession,
	writeProfile,
	writeStack,
} from "./helpers/index-command-harness.ts";

function contextCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-forge-host-port-integration-"));
}

test("external consumer discovers the wired runtime host, lists profiles, prepares, and observes disposal", async () => {
	const cwd = contextCwd();
	try {
		writeStack(cwd, "worker.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "worker",
			items: [{ kind: "block", id: "role", role: "system", content: "You are a focused reviewer." }],
		});
		writeProfile(cwd, "worker.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: "test-provider", id: "model-x" },
			thinkingLevel: "high",
			promptStack: "worker",
		});

		const harness = createHarness({
			models: [{ provider: "test-provider", id: "model-x" }],
			availableModels: [{ provider: "test-provider", id: "model-x" }],
			currentModel: { provider: "test-provider", id: "model-x" },
			thinkingLevel: "high",
		});
		const { ctx } = createContext(cwd);
		await startSession(harness, ctx);

		// The same event bus an external package shares: harness.eventsBus is
		// wired to pi.events where piForge started the host.
		const client = new ForgeHostClient(harness.eventsBus as never, { defaultTimeoutMs: 500 });
		const connection = client.connect(await client.discover());
		assert.equal(connection.hostId.startsWith("forge-host-"), true);
		assert.ok(connection.capabilities.includes("prepare"));

		const listed = await client.request(connection, "listProfiles", {});
		assert.equal(listed.ok, true);
		const listedValidated = validateListProfilesResponse(listed.data);
		assert.equal(listedValidated.ok, true);
		const profiles = (listed.data as { profiles: Array<{ profileId: string }> }).profiles;
		assert.deepEqual(profiles.map((profile) => profile.profileId), ["worker"]);

		const prepared = await client.request(connection, "prepare", {
			profile: "project:worker",
			task: { text: "Review this task." },
			access: { level: "read-only", network: "deny", allowProcess: false },
			backend: { model: { provider: "test-provider", id: "model-x" }, thinkingLevel: "high", toolCatalog: [] },
		});
		assert.equal(prepared.ok, true, (prepared as { error?: string }).error ?? "prepare expected ok");
		const prepareValidated = validatePrepareResponse(prepared.data);
		assert.equal(prepareValidated.ok, true);
		const data = prepared.data as { profileId: string; systemPrompt: string; messages: unknown[]; profileSnapshot: unknown };
		assert.equal(data.profileId, "project:worker");
		assert.ok(typeof data.systemPrompt === "string");
		assert.ok(data.systemPrompt.includes("focused reviewer"));
		assert.ok(Array.isArray(data.messages));
		assert.ok(!!data.profileSnapshot);

		// Host disposal: session shutdown unregisters the workspace host.
		let unavailable = 0;
		client.onUnavailable(() => { unavailable += 1; });
		await harness.events.session_shutdown?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unavailable, 1, "external client must observe host disposal");
		client.disconnect();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("host is not advertised before the first workspace snapshot exists", async () => {
	const cwd = contextCwd();
	try {
		writeStack(cwd, "worker.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "worker",
			items: [],
		});
		writeProfile(cwd, "worker.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: "test-provider", id: "model-x" },
			thinkingLevel: "high",
			promptStack: "worker",
		});

		const harness = createHarness({
			models: [{ provider: "test-provider", id: "model-x" }],
			availableModels: [{ provider: "test-provider", id: "model-x" }],
			currentModel: { provider: "test-provider", id: "model-x" },
			thinkingLevel: "high",
		});
		const { ctx } = createContext(cwd);

		// Before any session start, the host must NOT be discoverable.
		const early = new ForgeHostClient(harness.eventsBus as never, { defaultTimeoutMs: 150, discoverSettleMs: 2 });
		await assert.rejects(early.discover(150), (error: unknown) => {
			assert.ok(error instanceof ForgeHostPortError);
			assert.equal(error.code, "timeout");
			return true;
		});

		// After the first session start, the snapshot exists and the host serves.
		await startSession(harness, ctx);
		const client = new ForgeHostClient(harness.eventsBus as never, { defaultTimeoutMs: 300, discoverSettleMs: 2 });
		const connection = client.connect(await client.discover());
		const listed = await client.request(connection, "listProfiles", {});
		assert.equal(listed.ok, true);
		client.disconnect();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
