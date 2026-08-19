import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeWorkspace } from "../src/workspace.ts";
import { ForgeHostClient, FORGE_HOST_CHANNEL, type ForgeHostTransport } from "../src/subagent/host-port.ts";
import { resolveSubagentHostProfile } from "../src/subagent-host.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";

class MemoryTransport implements ForgeHostTransport {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	listeners(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}
	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			set.delete(handler);
		};
	}
}

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-forge-workspace-"));
	mkdirSync(join(dir, ".pi", "forge", "prompt-stacks"), { recursive: true });
	mkdirSync(join(dir, ".pi", "forge", "agent-profiles"), { recursive: true });
	mkdirSync(join(dir, ".pi", "forge", "global-prompt-stacks"), { recursive: true });
	mkdirSync(join(dir, ".pi", "forge", "global-agent-profiles"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "forge", "prompt-stacks", "worker.json"),
		JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "worker", items: [] }),
		"utf8",
	);
	writeFileSync(
		join(dir, ".pi", "forge", "agent-profiles", "worker.json"),
		JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: "test", id: "m" },
			thinkingLevel: "high",
			promptStack: "worker",
		}),
		"utf8",
	);
	return dir;
}

test("ForgeWorkspace reloads a snapshot and hosts profile listing over the bus", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const snapshot = workspace.snapshot();
		assert.deepEqual(snapshot.stacks.map((s) => s.stack.id), ["worker"]);
		assert.deepEqual(snapshot.profiles.map((p) => p.profile.id), ["worker"]);

		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
		const connection = client.connect(await client.discover());
		const listed = await client.request(connection, "listProfiles", {});
		assert.equal(listed.ok, true);
		const profiles = (listed.data as { profiles: Array<{ profileId: string; usable: boolean }> }).profiles;
		assert.deepEqual(profiles.map((p) => p.profileId), ["worker"]);
		assert.equal(profiles[0]!.usable, true);

		client.disconnect();
		workspace.dispose();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace prepare returns a typed failure for malformed payloads", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
		const connection = client.connect(await client.discover());
		const prepared = await client.request(connection, "prepare", { request: {} });
		assert.equal(prepared.ok, false);
		assert.match(prepared.error, /prepare request/);
		client.disconnect();
		workspace.dispose();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace disposal unregisters the host and notifies clients", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
		const connection = client.connect(await client.discover());

		let unavailable = 0;
		client.onUnavailable(() => { unavailable += 1; });
		workspace.dispose();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(unavailable, 1);
		assert.equal(bus.listeners(FORGE_HOST_CHANNEL.available), 0);

		const after = await client.request(connection, "listProfiles", {});
		assert.equal(after.ok, false);
		client.disconnect();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace prepare rejects nested-malformed payloads", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
		const connection = client.connect(await client.discover());
		const prepared = await client.request(connection, "prepare", {
			profile: "worker",
			task: { text: "x" },
			access: { level: "none", workspaces: [], network: "deny" },
			limits: {},
			backend: { model: { provider: "test", id: "m" }, thinkingLevel: "high", toolCatalog: [] },
		});
		assert.equal(prepared.ok, false);
		assert.match(prepared.error, /prepare request/);
		client.disconnect();
		workspace.dispose();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace prepares a real prompt over the bus", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const loaded = workspace.snapshot();
		const loadedProfile = loaded.profiles.find((p) => p.profile.id === "worker")!;
		const loadedStack = loaded.stacks.find((s) => s.stack.id === "worker")!;
		const resolved = resolveSubagentHostProfile(loadedProfile, {
			promptStacks: [loadedStack],
			registrations: { macros: [], slots: [] },
		});
		assert.ok(resolved.snapshot, "expected a resolvable snapshot for prepare");

		const payload = {
			profile: "project:worker",
			task: { text: "Do the task." },
			access: { level: "read-only", network: "deny", allowProcess: false },
			backend: { model: { provider: "test", id: "m" }, thinkingLevel: "high", toolCatalog: [] },
		};

		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 300 });
		const connection = client.connect(await client.discover());
		const prepared = await client.request(connection, "prepare", payload);
		assert.equal(prepared.ok, true, (prepared as { error?: string }).error ?? "prepare ok");
		const data = prepared.data as { profileId: string; systemPrompt: string; messages: unknown[]; profileSnapshot: unknown };
		assert.equal(data.profileId, "project:worker");
		assert.equal(typeof data.systemPrompt, "string");
		assert.ok(Array.isArray(data.messages));
		assert.ok(!!data.profileSnapshot);
		client.disconnect();
		workspace.dispose();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace snapshot is genuinely immutable", () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const snapshot = workspace.snapshot();
		assert.equal(Object.isFrozen(snapshot.stacks), true);
		assert.equal(Object.isFrozen(snapshot.stacks[0]!.stack.items), true);
		assert.throws(() => {
			(snapshot.stacks[0]!.stack as { items: unknown[] }).items.push({ id: "mutated", content: "" });
		}, TypeError);
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace startHostPort requires a prior snapshot", () => {
	const workspace = new ForgeWorkspace();
	assert.throws(() => workspace.startHostPort(new MemoryTransport()), /before starting the host port/);
});

test("ForgeWorkspace untrusted reload reads global resources only", () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	const globalRoot = join(cwd, ".pi", "forge", "global-root");
	process.env[GLOBAL_FORGE_DIR_ENV] = globalRoot;
	try {
		mkdirSync(join(globalRoot, "prompt-stacks"), { recursive: true });
		mkdirSync(join(globalRoot, "agent-profiles"), { recursive: true });
		writeFileSync(
			join(globalRoot, "prompt-stacks", "global-stack.json"),
			JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "global-stack", items: [] }),
			"utf8",
		);
		writeFileSync(
			join(globalRoot, "agent-profiles", "global-worker.json"),
			JSON.stringify({
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: "global-worker",
				model: { provider: "test", id: "m" },
				thinkingLevel: "high",
				promptStack: "global-stack",
			}),
			"utf8",
		);

		const workspace = new ForgeWorkspace();
		workspace.reload(cwd, { trusted: false });
		const snapshot = workspace.snapshot();
		assert.deepEqual(snapshot.stacks.map((s) => s.stack.id), ["global-stack"]);
		assert.deepEqual(snapshot.profiles.map((p) => p.profile.id), ["global-worker"]);
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ForgeWorkspace resolves an immutable profile snapshot over the bus", async () => {
	const cwd = tempCwd();
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = join(cwd, ".pi", "forge", "global-root");
	mkdirSync(join(cwd, ".pi", "forge", "global-root"), { recursive: true });
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(cwd);
		const bus = new MemoryTransport();
		workspace.startHostPort(bus);
		const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
		const connection = client.connect(await client.discover());
		const resolved = await client.request(connection, "resolveProfile", { profile: "project:worker" });
		assert.equal(resolved.ok, true, (resolved as { error?: string }).error ?? "resolve expected ok");
		const snapshot = (resolved.data as { snapshot: { profileId: string; promptStack: unknown } }).snapshot;
		assert.equal(snapshot.profileId, "project:worker");
		assert.ok(snapshot.promptStack);
		client.disconnect();
		workspace.dispose();
	} finally {
		if (original === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(cwd, { recursive: true, force: true });
	}
});
