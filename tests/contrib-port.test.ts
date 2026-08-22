import assert from "node:assert/strict";
import test from "node:test";

import { ContributionService } from "../src/web-editor/contrib-service.ts";
import {
	UI_CONTRIBUTION_CHANNEL,
	UI_CONTRIBUTION_PORT_OPERATIONS,
	UI_CONTRIBUTION_PORT_VERSION,
	UiContributionClient,
	UiContributionPortError,
	UiContributionProvider,
	validateListContributionsRequest,
	validateListContributionsResponse,
	validateUiContributionTabDescriptor,
	validateWriteValuesRequest,
	validateWriteValuesResponse,
	type UiContributionTransport,
	type UiContributionTabDescriptor,
} from "../src/ui-contribution/contrib-port.ts";

class MemoryTransport implements UiContributionTransport {
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

const descriptor: UiContributionTabDescriptor = {
	tabId: "subagent-config",
	title: "Subagent",
	icon: "⚙",
	schema: {
		title: "Subagent settings",
		fields: [
			{ key: "backend", label: "Backend", type: "enum", options: ["auto", "cli"] },
			{ key: "timeoutMs", label: "Timeout (ms)", type: "number", required: true, min: 1 },
		],
	},
	values: { backend: "auto", timeoutMs: 3000 },
};

function providerOn(
	transport: UiContributionTransport,
	opts: Partial<ConstructorParameters<typeof UiContributionProvider>[1]> = {},
): UiContributionProvider {
	return new UiContributionProvider(transport, {
		handle: (operation, payload) => {
			if (operation === "listContributions") {
				return { ok: true, data: { tabs: [descriptor] } };
			}
			if (operation === "writeValues") {
				const request = payload as { tabId: string; patch: Record<string, unknown> };
				if (request.tabId !== descriptor.tabId) return { ok: false, error: "Unknown tab" };
				if (request.patch.timeoutMs === 0) {
					return { ok: true, data: { ok: false, errors: { timeoutMs: "Timeout must be positive." } } };
				}
				return { ok: true, data: { ok: true, values: request.patch } };
			}
			return { ok: false, error: `Unknown operation: ${operation}` };
		},
		...opts,
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ui contribution port v1: discovery, listContributions, and writeValues", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });

	const connection = await client.discover();
	assert.equal(connection.hostId, provider.hostId);
	assert.equal(connection.generation, 1);
	assert.deepEqual([...connection.capabilities], [...UI_CONTRIBUTION_PORT_OPERATIONS]);

	client.connect(connection);
	const listed = await client.listContributions(connection);
	assert.equal(listed.ok, true);
	assert.deepEqual((listed.data as { tabs: UiContributionTabDescriptor[] }).tabs, [descriptor]);

	const written = await client.writeValues(connection, descriptor.tabId, { backend: "cli", timeoutMs: 5000 });
	assert.equal(written.ok, true);
	assert.deepEqual((written.data as { ok: true; values?: unknown }).values, { backend: "cli", timeoutMs: 5000 });

	client.disconnect();
	provider.stop();
});

test("ui contribution port v1: structured validation errors survive the wire", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());

	const written = await client.writeValues(connection, descriptor.tabId, { backend: "auto", timeoutMs: 0 });
	assert.equal(written.ok, true);
	assert.deepEqual(written.data, { ok: false, errors: { timeoutMs: "Timeout must be positive." } });

	client.disconnect();
	provider.stop();
});

test("ui contribution port v1: unknown operation returns a typed failure", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());
	const result = await client.request(connection, "noSuchOperation", {});
	assert.equal(result.ok, false);
	assert.match(result.error!, /Unknown UI contribution operation/);
	client.disconnect();
	provider.stop();
});

test("ui contribution port v1: discovery times out when no compatible provider is live", async () => {
	const bus = new MemoryTransport();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 50 });
	await assert.rejects(client.discover(50), (error: unknown) => {
		assert.ok(error instanceof UiContributionPortError);
		assert.equal(error.code, "timeout");
		return true;
	});
	assert.equal(client.subscriptionCount, 0, "discovery must clean up its listeners on timeout");
});

test("ui contribution port v1: duplicate providers fail discovery explicitly", async () => {
	const bus = new MemoryTransport();
	const providerA = providerOn(bus, { providerId: "provider-a" });
	const providerB = providerOn(bus, { providerId: "provider-b" });
	providerA.start();
	providerB.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
	await assert.rejects(client.discover(), (error: unknown) => {
		assert.ok(error instanceof UiContributionPortError);
		assert.equal(error.code, "duplicate");
		return true;
	});
	providerA.stop();
	providerB.stop();
});

test("ui contribution port v1: disposal invalidates the connection and raises unavailable", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
	const connection = client.connect(await client.discover());

	let unavailable = 0;
	client.onUnavailable(() => { unavailable += 1; });
	provider.stop();
	await wait(10);
	assert.equal(unavailable, 1);

	const after = await client.request(connection, "listContributions", {});
	assert.equal(after.ok, false);
	assert.match(after.error!, /not the client's active connection|became unavailable/);

	client.disconnect();
});

test("ui contribution port validators enforce exact wire shapes and recursive JSON compatibility", () => {
	assert.deepEqual(validateListContributionsRequest(undefined), { ok: true, data: {} });
	assert.equal(validateListContributionsRequest({ extra: true }).ok, false);
	assert.equal(validateListContributionsResponse({ tabs: "no" }).ok, false);
	assert.equal(validateListContributionsResponse({ tabs: [{ ...descriptor, unknownField: true }] }).ok, false);
	assert.equal(validateUiContributionTabDescriptor({ ...descriptor, schema: { fields: [{ key: "x", label: "X", type: "nope" }] } }).ok, false);
	assert.equal(validateUiContributionTabDescriptor({ ...descriptor, values: new Map() }).ok, false);
	assert.equal(validateWriteValuesRequest({ tabId: "", patch: {} }).ok, false);
	assert.equal(validateWriteValuesRequest({ tabId: "x", patch: [1] }).ok, false);
	assert.equal(validateWriteValuesResponse({ ok: false, errors: { a: 1 } }).ok, false);
	assert.equal(validateWriteValuesResponse({ ok: true, values: [1] }).ok, false);
	assert.equal(validateWriteValuesResponse({ ok: true, values: {} }).ok, true);
	assert.equal(validateWriteValuesResponse({ ok: false, errors: {} }).ok, true);
});

test("ui contribution port validates recursive FormSchema records", () => {
	const schema = {
		fields: [
			{
				key: "profiles",
				label: "Per-profile",
				type: "record",
				keyOptions: [{ value: "project:worker", label: "Project · worker" }],
				recordFields: [
					{ key: "enabled", label: "Enabled", type: "boolean" },
					{ key: "backend", label: "Backend", type: "enum", options: ["auto", "cli"] },
				],
			},
		],
	};
	const result = validateUiContributionTabDescriptor({ ...descriptor, schema, values: {} });
	assert.equal(result.ok, true);
	const bad = validateUiContributionTabDescriptor({
		...descriptor,
		schema: {
			fields: [
				{
					key: "profiles",
					label: "Per-profile",
					type: "record",
					recordFields: [{ key: "backend", label: "Backend", type: "enum", options: ["auto", { value: "" }] }],
				},
			],
		},
		values: {},
	});
	assert.equal(bad.ok, false);
	assert.match((bad as { error: string }).error, /enum option value/);

	const badKeyOptions = validateUiContributionTabDescriptor({
		...descriptor,
		schema: {
			fields: [{ key: "profiles", label: "Per-profile", type: "record", keyOptions: [{ value: "" }] }],
		},
		values: {},
	});
	assert.equal(badKeyOptions.ok, false);
	assert.match((badKeyOptions as { error: string }).error, /keyOptions/);
	const emptyStringKeyOption = validateUiContributionTabDescriptor({
		...descriptor,
		schema: { fields: [{ key: "profiles", label: "Per-profile", type: "record", keyOptions: [""] }] },
		values: {},
	});
	assert.equal(emptyStringKeyOption.ok, false);
	const duplicateKeyOption = validateUiContributionTabDescriptor({
		...descriptor,
		schema: { fields: [{ key: "profiles", label: "Per-profile", type: "record", keyOptions: ["worker", { value: "worker", label: "Worker" }] }] },
		values: {},
	});
	assert.equal(duplicateKeyOption.ok, false);
	assert.match((duplicateKeyOption as { error: string }).error, /unique/);
});

test("ui contribution providers may resolve operation results asynchronously", async () => {
	const bus = new MemoryTransport();
	const provider = new UiContributionProvider(bus, {
		handle: async (operation) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			if (operation === "listContributions") return { ok: true, data: { tabs: [descriptor] } };
			return { ok: false, error: "Unknown operation" };
		},
	});
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 100 });
	const connection = await client.discover();
	client.connect(connection);
	try {
		const result = await client.listContributions(connection);
		assert.equal(result.ok, true);
	} finally {
		client.disconnect();
		provider.stop();
	}
});

test("stopping a provider aborts pending async operation contexts", async () => {
	const bus = new MemoryTransport();
	let release!: () => void;
	let started!: () => void;
	let requestSignal: AbortSignal | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const entered = new Promise<void>((resolve) => { started = resolve; });
	const provider = new UiContributionProvider(bus, {
		handle: async (_operation, _payload, context) => {
			requestSignal = context.signal;
			started();
			await gate;
			return { ok: true, data: { tabs: [descriptor] } };
		},
	});
	provider.start();
	const client = new UiContributionClient(bus, { defaultTimeoutMs: 100 });
	const connection = await client.discover();
	client.connect(connection);
	const pending = client.listContributions(connection);
	await entered;
	provider.stop();
	assert.equal(requestSignal?.aborted, true);
	release();
	const result = await pending;
	assert.equal(result.ok, false);
	client.disconnect();
});

test("ContributionService merges a partial patch when the provider omits returned values", async () => {
	const bus = new MemoryTransport();
	const partialDescriptor: UiContributionTabDescriptor = {
		...descriptor,
		values: {
			backend: "auto",
			profiles: { worker: { enabled: true, timeoutMs: 3000 } },
		},
	};
	const provider = new UiContributionProvider(bus, {
		handle: (operation) => {
			if (operation === "listContributions") return { ok: true, data: { tabs: [partialDescriptor] } };
			if (operation === "writeValues") return { ok: true, data: { ok: true } };
			return { ok: false, error: "Unknown operation" };
		},
	});
	const service = new ContributionService(bus, { discoverTimeoutMs: 50, requestTimeoutMs: 100 });
	provider.start();
	service.start();
	try {
		const result = await service.writeValues("subagent-config", {
			backend: "cli",
			profiles: { worker: { timeoutMs: 5000 } },
		});
		assert.deepEqual(result, {
			ok: true,
			values: {
				backend: "cli",
				profiles: { worker: { enabled: true, timeoutMs: 5000 } },
			},
		});
	} finally {
		await service.stop();
		provider.stop();
	}
});

test("ContributionService refreshes contribution schemas on every list request", async () => {
	const bus = new MemoryTransport();
	let title = "Initial";
	let reads = 0;
	const provider = new UiContributionProvider(bus, {
		handle: (operation) => {
			if (operation !== "listContributions") return { ok: false, error: "Unknown operation" };
			reads += 1;
			return { ok: true, data: { tabs: [{ ...descriptor, schema: { ...descriptor.schema, title } }] } };
		},
	});
	const service = new ContributionService(bus, { discoverTimeoutMs: 50, requestTimeoutMs: 100 });
	provider.start();
	service.start();
	try {
		const first = await service.listTabs();
		assert.equal(first[0]?.schema.title, "Initial");
		title = "Refreshed";
		const second = await service.listTabs();
		assert.equal(second[0]?.schema.title, "Refreshed");
		assert.ok(reads >= 2);
	} finally {
		await service.stop();
		provider.stop();
	}
});

test("ContributionService stop waits out discovery and prevents reconnect-after-disposal", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	const service = new ContributionService(bus, { discoverTimeoutMs: 100, requestTimeoutMs: 100 });
	service.start();
	const stopping = service.stop();
	provider.start();
	await stopping;
	await wait(30);

	assert.deepEqual(await service.listTabs(), []);
	provider.stop();
});
