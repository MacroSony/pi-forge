import assert from "node:assert/strict";
import test from "node:test";
import {
	ForgeHost,
	ForgeHostClient,
	ForgeHostPortError,
	FORGE_HOST_CHANNEL,
	FORGE_HOST_PORT_OPERATIONS,
	type ForgeHostTransport,
} from "../src/subagent/host-port.ts";

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

function hostOn(transport: ForgeHostTransport, opts: Partial<ConstructorParameters<typeof ForgeHost>[1]> = {}) {
	return new ForgeHost(transport, {
		handle: (operation, payload) => {
			if (operation === "listProfiles") return { ok: true, data: { profiles: [{ id: "worker" }] } };
			if (operation === "prepare") return { ok: true, data: { systemPrompt: "prepared", prepared: payload } };
			return { ok: false, error: `Unknown operation: ${operation}` };
		},
		...opts,
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("host port v1: discovery and the three minimal operations", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });

	const connection = await client.discover();
	assert.equal(connection.hostId, host.hostId);
	assert.equal(connection.generation, 1);
	assert.deepEqual([...connection.capabilities], [...FORGE_HOST_PORT_OPERATIONS]);

	client.connect(connection);
	const listed = await client.request(connection, "listProfiles", {});
	assert.equal(listed.ok, true);
	assert.deepEqual(listed.data, { profiles: [{ id: "worker" }] });

	const prepared = await client.request(connection, "prepare", { task: "x" });
	assert.equal(prepared.ok, true);
	assert.equal((prepared.data as { systemPrompt: string }).systemPrompt, "prepared");

	client.disconnect();
	host.stop();
});

test("host port v1: unknown operation returns a typed failure", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());
	const result = await client.request(connection, "noSuchOperation", {});
	assert.equal(result.ok, false);
	assert.match(result.error, /Unknown Forge host operation/);
	client.disconnect();
	host.stop();
});

test("host port v1: discovery times out when no compatible host is live", async () => {
	const bus = new MemoryTransport();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 50 });
	await assert.rejects(client.discover(50), (error: unknown) => {
		assert.ok(error instanceof ForgeHostPortError);
		assert.equal(error.code, "timeout");
		return true;
	});
	assert.equal(client.subscriptionCount, 0, "discovery must clean up its listeners on timeout");
});

test("host port v1: duplicate hosts fail discovery explicitly", async () => {
	const bus = new MemoryTransport();
	const hostA = hostOn(bus, { hostId: "host-a" });
	const hostB = hostOn(bus, { hostId: "host-b" });
	hostA.start();
	hostB.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	await assert.rejects(client.discover(), (error: unknown) => {
		assert.ok(error instanceof ForgeHostPortError);
		assert.equal(error.code, "duplicate");
		return true;
	});
	hostA.stop();
	hostB.stop();
});

test("host port v1: disposal invalidates the connection and raises unavailable", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());

	let unavailable = 0;
	client.onUnavailable(() => { unavailable += 1; });
	host.stop();
	await wait(10);
	assert.equal(unavailable, 1);

	const after = await client.request(connection, "listProfiles", {});
	assert.equal(after.ok, false);
	assert.match(after.error, /not the client's active connection|became unavailable/);

	client.disconnect();
});

test("host port v1: stale generation unavailable messages are ignored", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus, { hostId: "host" });
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());

	let unavailable = 0;
	client.onUnavailable(() => { unavailable += 1; });
	// A stale unavailable from a previous generation must be ignored.
	bus.emit(FORGE_HOST_CHANNEL.unavailable, { type: "unavailable", hostId: "host", generation: connection.generation - 1 });
	await wait(10);
	assert.equal(unavailable, 0);
	client.disconnect();
	host.stop();
});

test("host port v1: listener cleanup removes transient and persistent subscriptions", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const baselineAvailable = bus.listeners(FORGE_HOST_CHANNEL.available);
	const baselineUnavailable = bus.listeners(FORGE_HOST_CHANNEL.unavailable);

	const connection = await client.discover();
	client.connect(connection);
	const listed = await client.request(connection, "listProfiles", {});
	assert.equal(listed.ok, true);

	assert.equal(bus.listeners(FORGE_HOST_CHANNEL.available), baselineAvailable, "discover available listener must be removed");
	assert.equal(bus.listeners(FORGE_HOST_CHANNEL.reply), 0, "request reply listener must be removed");

	client.disconnect();
	assert.equal(bus.listeners(FORGE_HOST_CHANNEL.unavailable), baselineUnavailable ?? 0, "disconnect must drop persistent unavailable listener");
	host.stop();
});

test("host port v1: request times out and cleans up when the host never replies", async () => {
	const bus = new MemoryTransport();
	// Minimal fake host that answers discovery but never handles requests.
	const stopFake = bus.on(FORGE_HOST_CHANNEL.discover, () => {
		bus.emit(FORGE_HOST_CHANNEL.available, {
			type: "available",
			hostId: "fake-silent",
			protocolVersion: 1,
			minVersion: 1,
			maxVersion: 1,
			capabilities: [],
			generation: 1,
		});
	});
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 30, discoverSettleMs: 2 });
	const connection = client.connect(await client.discover());
	const result = await client.request(connection, "prepare", {}, 30);
	assert.equal(result.ok, false);
	assert.match(result.error, /timed out/);
	assert.equal(bus.listeners(FORGE_HOST_CHANNEL.reply), 0, "expired request must remove its reply listener");
	client.disconnect();
	stopFake();
});

test("host port v1: disposal notification survives a completed request while connected", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());

	const listed = await client.request(connection, "listProfiles", {});
	assert.equal(listed.ok, true);

	// Register the disposal listener only after a completed request.
	let unavailable = 0;
	client.onUnavailable(() => { unavailable += 1; });
	host.stop();
	await wait(10);
	assert.equal(unavailable, 1, "persistent disposal listener must survive a completed request");

	const after = await client.request(connection, "listProfiles", {});
	assert.equal(after.ok, false);
	assert.match(after.error, /not the client's active connection/);
	client.disconnect();
});

test("host port v1: malformed host operation results fail typed instead of timing out", async () => {
	const bus = new MemoryTransport();
	const host = new ForgeHost(bus, {
		handle: () => undefined as never,
	});
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());
	const result = await client.request(connection, "listProfiles", {});
	assert.equal(result.ok, false);
	assert.match(result.error, /malformed/);
	client.disconnect();
	host.stop();
});

test("host port v1: a self-unsubscribing unavailable handler does not starve later handlers", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	client.connect(await client.discover());

	let first = 0;
	let second = 0;
	const unsubFirst = client.onUnavailable(() => {
		first += 1;
		unsubFirst();
	});
	client.onUnavailable(() => { second += 1; });

	host.stop();
	await wait(10);
	assert.equal(first, 1);
	assert.equal(second, 1, "second handler must still run after the first unsubscribed itself");
	client.disconnect();
});

test("host port v1: a throwing unavailable handler does not abort host teardown", async () => {
	const bus = new MemoryTransport();
	const host = hostOn(bus);
	host.start();
	const generationAfterStart = host.generation;
	const client = new ForgeHostClient(bus, { defaultTimeoutMs: 200 });
	client.connect(await client.discover());
	client.onUnavailable(() => {
		throw new Error("boom");
	});

	host.stop();
	assert.equal(host.isLive, false);
	assert.equal(host.generation, generationAfterStart + 1);
	assert.equal(bus.listeners(FORGE_HOST_CHANNEL.request), 0, "host request listener must be removed even when a client handler throws");
	client.disconnect();
});
