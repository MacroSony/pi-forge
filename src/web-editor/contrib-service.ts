import {
	UiContributionClient,
	type UiContributionConnection,
	type UiContributionTabDescriptor,
	type UiContributionTransport,
	type UiWriteValuesResponse,
} from "../ui-contribution/contrib-port.ts";

export interface ContributionServiceOptions {
	discoverTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export type ContributionWriteResult =
	| { ok: true; values?: Record<string, unknown> }
	| { ok: false; status: number; error: string; errors?: Record<string, string> };

export class ContributionService {
	private readonly client: UiContributionClient;
	private readonly discoverTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private connection?: UiContributionConnection;
	private tabs: UiContributionTabDescriptor[] = [];
	private discovering?: Promise<UiContributionConnection | undefined>;
	private discoveringGeneration?: number;
	private unavailableUnsubscribe?: () => void;
	private lifecycleGeneration = 0;
	private connectionEpoch = 0;
	private started = false;

	constructor(transport: UiContributionTransport, options: ContributionServiceOptions = {}) {
		this.discoverTimeoutMs = options.discoverTimeoutMs ?? 200;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
		this.client = new UiContributionClient(transport, {
			discoverSettleMs: 10,
			defaultTimeoutMs: this.requestTimeoutMs,
		});
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		const generation = ++this.lifecycleGeneration;
		this.unavailableUnsubscribe = this.client.onUnavailable(() => {
			this.connection = undefined;
			this.tabs = [];
		});
		void this.ensureConnected(generation)
			.then((connection) => connection ? this.refreshTabs(generation) : undefined)
			.catch(() => {
				if (generation !== this.lifecycleGeneration) return;
				this.connection = undefined;
				this.tabs = [];
			});
	}

	async stop(): Promise<void> {
		if (!this.started && !this.discovering) return;
		this.started = false;
		this.lifecycleGeneration += 1;
		const pendingDiscovery = this.discovering;
		if (this.unavailableUnsubscribe) {
			this.unavailableUnsubscribe();
			this.unavailableUnsubscribe = undefined;
		}
		this.client.disconnect();
		this.connection = undefined;
		this.tabs = [];
		await pendingDiscovery?.catch(() => undefined);
	}

	async listTabs(): Promise<UiContributionTabDescriptor[]> {
		if (!this.started) return [];
		const connection = await this.ensureConnected();
		if (!connection) return [];
		await this.refreshTabs();
		return this.tabs;
	}

	/**
	 * Opaque identity for the provider session that produced the current tabs.
	 * The browser uses this to invalidate a mounted schema even when a provider
	 * restarts quickly enough that polling never observes an empty tab list.
	 */
	get providerKey(): string | null {
		return this.connection ? `connection:${this.connectionEpoch}` : null;
	}

	async writeValues(tabId: string, patch: Record<string, unknown>): Promise<ContributionWriteResult> {
		if (!this.started) return { ok: false, status: 503, error: "No UI contribution provider is available." };
		const connection = await this.ensureConnected();
		if (!connection) return { ok: false, status: 503, error: "No UI contribution provider is available." };
		if (this.tabs.length === 0) await this.refreshTabs();
		if (!this.connection) return { ok: false, status: 503, error: "No UI contribution provider is available." };
		if (!this.tabs.some((tab) => tab.tabId === tabId)) {
			return { ok: false, status: 404, error: `Unknown contribution tab: ${tabId}` };
		}
		const result = await this.client.writeValues(connection, tabId, patch, this.requestTimeoutMs);
		if (!result.ok) {
			return { ok: false, status: 502, error: result.error };
		}
		const response = result.data as UiWriteValuesResponse;
		if (response.ok) {
			const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
			const values = response.values ?? (tab ? mergeFormValues(tab.values, patch) : patch);
			if (tab) tab.values = values;
			return { ok: true, values };
		}
		const first = Object.values(response.errors)[0];
		return {
			ok: false,
			status: 400,
			error: first ? `${first} (${Object.keys(response.errors).join(", ")})` : "Contribution values failed validation.",
			errors: response.errors,
		};
	}

	private async ensureConnected(generation = this.lifecycleGeneration): Promise<UiContributionConnection | undefined> {
		if (this.connection) return this.connection;
		if (!this.discovering || this.discoveringGeneration !== generation) {
			const discovery = this.client.discover(this.discoverTimeoutMs)
				.then((connection) => {
					if (!this.started || generation !== this.lifecycleGeneration) return undefined;
					this.client.connect(connection);
					this.connection = connection;
					this.connectionEpoch += 1;
					return connection;
				})
				.catch(() => undefined)
				.finally(() => {
					if (this.discovering === discovery) {
						this.discovering = undefined;
						this.discoveringGeneration = undefined;
					}
				});
			this.discovering = discovery;
			this.discoveringGeneration = generation;
		}
		return this.discovering;
	}

	private async refreshTabs(generation = this.lifecycleGeneration): Promise<void> {
		try {
			if (!this.started || generation !== this.lifecycleGeneration) return;
			const connection = this.connection;
			if (!connection) {
				this.tabs = [];
				return;
			}
			const result = await this.client.listContributions(connection, this.requestTimeoutMs);
			if (!this.started || generation !== this.lifecycleGeneration) return;
			if (!result.ok) {
				this.tabs = [];
				this.connection = undefined;
				return;
			}
			const response = result.data as { tabs: UiContributionTabDescriptor[] };
			this.tabs = response.tabs;
		} catch {
			if (!this.started || generation !== this.lifecycleGeneration) return;
			this.tabs = [];
			this.connection = undefined;
		}
	}
}

function mergeFormValues(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const existing = merged[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			merged[key] = mergeFormValues(existing, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
