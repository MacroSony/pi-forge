import assert from "node:assert/strict";
import test from "node:test";

import {
	UiContributionProvider,
	type UiContributionTabDescriptor,
	type UiContributionTransport,
} from "../src/ui-contribution/contrib-port.ts";
import { startWebEditorServer, type WebEditorServer, type WebEditorHost } from "../src/web-editor/index.ts";

class MemoryTransport implements UiContributionTransport {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

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

function providerOn(transport: UiContributionTransport, providerId?: string): UiContributionProvider {
	return new UiContributionProvider(transport, {
		providerId,
		handle: (operation, payload) => {
			if (operation === "listContributions") return { ok: true, data: { tabs: [descriptor] } };
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
	});
}

function fakeHost(): WebEditorHost {
	return {} as unknown as WebEditorHost;
}

async function withServer(
	transport: UiContributionTransport | undefined,
	run: (server: WebEditorServer) => Promise<void>,
): Promise<void> {
	const server = await startWebEditorServer(fakeHost(), {
		port: 0,
		contributionTransport: transport,
		contributionDiscoverTimeoutMs: 30,
	});
	try {
		await run(server);
	} finally {
		await server.close();
	}
}

test("web editor contribution routes list descriptors and proxy writeValues", async () => {
	const bus = new MemoryTransport();
	const provider = providerOn(bus);
	provider.start();
	await withServer(bus, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const headers = { "x-pi-forge-token": token };

		const listed = await fetch(new URL("/api/contrib", server.url), { headers });
		assert.equal(listed.status, 200);
		const listedJson = await listed.json() as { tabs: UiContributionTabDescriptor[]; providerKey: string | null };
		assert.deepEqual(listedJson.tabs, [descriptor]);
		assert.match(listedJson.providerKey ?? "", /^connection:\d+$/);

		const written = await fetch(new URL("/api/contrib/subagent-config", server.url), {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ backend: "cli", timeoutMs: 5000 }),
		});
		assert.equal(written.status, 200);
		assert.deepEqual(await written.json(), { ok: true, values: { backend: "cli", timeoutMs: 5000 } });

		const invalid = await fetch(new URL("/api/contrib/subagent-config", server.url), {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ timeoutMs: 0 }),
		});
		assert.equal(invalid.status, 400);
		const invalidJson = await invalid.json() as { errors?: Record<string, string>; error?: string };
		assert.deepEqual(invalidJson.errors, { timeoutMs: "Timeout must be positive." });
		assert.match(invalidJson.error ?? "", /Timeout must be positive/);

		const unknown = await fetch(new URL("/api/contrib/missing-tab", server.url), {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(unknown.status, 404);
		assert.match((await unknown.json() as { error?: string }).error ?? "", /Unknown contribution tab/);
	});
	provider.stop();
});

test("web editor contribution routes return zero tabs when no provider is present", async () => {
	await withServer(undefined, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const headers = { "x-pi-forge-token": token };
		const listed = await fetch(new URL("/api/contrib", server.url), { headers });
		assert.equal(listed.status, 200);
		assert.deepEqual(await listed.json(), { tabs: [], providerKey: null });

		const written = await fetch(new URL("/api/contrib/subagent-config", server.url), {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(written.status, 503);
		assert.match((await written.json() as { error?: string }).error ?? "", /No UI contribution provider/);
	});
});

test("web editor contribution routes tolerate a provider disappearing", async () => {
	const bus = new MemoryTransport();
	let provider = providerOn(bus, "stable-settings-provider");
	provider.start();
	let server: WebEditorServer | undefined;
	try {
		server = await startWebEditorServer(fakeHost(), {
			port: 0,
			contributionTransport: bus,
			contributionDiscoverTimeoutMs: 30,
		});
		const token = new URL(server.url).searchParams.get("token")!;
		const headers = { "x-pi-forge-token": token };

		const listed = await fetch(new URL("/api/contrib", server.url), { headers });
		assert.equal(listed.status, 200);
		const firstListing = await listed.json() as { tabs: UiContributionTabDescriptor[]; providerKey: string | null };
		assert.deepEqual(firstListing.tabs, [descriptor]);

		provider.stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const after = await fetch(new URL("/api/contrib", server.url), { headers });
		assert.equal(after.status, 200);
		assert.deepEqual(await after.json(), { tabs: [], providerKey: null });

		provider = providerOn(bus, "stable-settings-provider");
		provider.start();
		const reconnected = await fetch(new URL("/api/contrib", server.url), { headers });
		assert.equal(reconnected.status, 200);
		const secondListing = await reconnected.json() as { tabs: UiContributionTabDescriptor[]; providerKey: string | null };
		assert.deepEqual(secondListing.tabs, [descriptor]);
		assert.notEqual(secondListing.providerKey, firstListing.providerKey);
	} finally {
		await server?.close();
		provider.stop();
	}
});

test("web editor maps malformed and oversized JSON bodies to client errors", async () => {
	await withServer(undefined, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const headers = { "x-pi-forge-token": token, "content-type": "application/json" };

		const malformed = await fetch(new URL("/api/stacks/test", server.url), {
			method: "PUT",
			headers,
			body: "{ not-json",
		});
		assert.equal(malformed.status, 400);
		assert.match((await malformed.json() as { error?: string }).error ?? "", /valid JSON/);

		const oversized = await fetch(new URL("/api/stacks/test", server.url), {
			method: "PUT",
			headers,
			body: "x".repeat(2_000_001),
		});
		assert.equal(oversized.status, 413);
		assert.match((await oversized.json() as { error?: string }).error ?? "", /too large/);
	});
});
