import { UiContributionClient, } from "../ui-contribution/contrib-port.js";
export class ContributionService {
    client;
    discoverTimeoutMs;
    requestTimeoutMs;
    connection;
    tabs = [];
    discovering;
    discoveringGeneration;
    unavailableUnsubscribe;
    lifecycleGeneration = 0;
    connectionEpoch = 0;
    started = false;
    constructor(transport, options = {}) {
        this.discoverTimeoutMs = options.discoverTimeoutMs ?? 200;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
        this.client = new UiContributionClient(transport, {
            discoverSettleMs: 10,
            defaultTimeoutMs: this.requestTimeoutMs,
        });
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        const generation = ++this.lifecycleGeneration;
        this.unavailableUnsubscribe = this.client.onUnavailable(() => {
            this.connection = undefined;
            this.tabs = [];
        });
        void this.ensureConnected(generation)
            .then((connection) => connection ? this.refreshTabs(generation) : undefined)
            .catch(() => {
            if (generation !== this.lifecycleGeneration)
                return;
            this.connection = undefined;
            this.tabs = [];
        });
    }
    async stop() {
        if (!this.started && !this.discovering)
            return;
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
    async listTabs() {
        if (!this.started)
            return [];
        const connection = await this.ensureConnected();
        if (!connection)
            return [];
        await this.refreshTabs();
        return this.tabs;
    }
    /**
     * Opaque identity for the provider session that produced the current tabs.
     * The browser uses this to invalidate a mounted schema even when a provider
     * restarts quickly enough that polling never observes an empty tab list.
     */
    get providerKey() {
        return this.connection ? `connection:${this.connectionEpoch}` : null;
    }
    async writeValues(tabId, patch) {
        if (!this.started)
            return { ok: false, status: 503, error: "No UI contribution provider is available." };
        const connection = await this.ensureConnected();
        if (!connection)
            return { ok: false, status: 503, error: "No UI contribution provider is available." };
        if (this.tabs.length === 0)
            await this.refreshTabs();
        if (!this.connection)
            return { ok: false, status: 503, error: "No UI contribution provider is available." };
        if (!this.tabs.some((tab) => tab.tabId === tabId)) {
            return { ok: false, status: 404, error: `Unknown contribution tab: ${tabId}` };
        }
        const result = await this.client.writeValues(connection, tabId, patch, this.requestTimeoutMs);
        if (!result.ok) {
            return { ok: false, status: 502, error: result.error };
        }
        const response = result.data;
        if (response.ok) {
            const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
            const values = response.values ?? (tab ? mergeFormValues(tab.values, patch) : patch);
            if (tab)
                tab.values = values;
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
    async ensureConnected(generation = this.lifecycleGeneration) {
        if (this.connection)
            return this.connection;
        if (!this.discovering || this.discoveringGeneration !== generation) {
            const discovery = this.client.discover(this.discoverTimeoutMs)
                .then((connection) => {
                if (!this.started || generation !== this.lifecycleGeneration)
                    return undefined;
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
    async refreshTabs(generation = this.lifecycleGeneration) {
        try {
            if (!this.started || generation !== this.lifecycleGeneration)
                return;
            const connection = this.connection;
            if (!connection) {
                this.tabs = [];
                return;
            }
            const result = await this.client.listContributions(connection, this.requestTimeoutMs);
            if (!this.started || generation !== this.lifecycleGeneration)
                return;
            if (!result.ok) {
                this.tabs = [];
                this.connection = undefined;
                return;
            }
            const response = result.data;
            this.tabs = response.tabs;
        }
        catch {
            if (!this.started || generation !== this.lifecycleGeneration)
                return;
            this.tabs = [];
            this.connection = undefined;
        }
    }
}
function mergeFormValues(base, patch) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const existing = merged[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            merged[key] = mergeFormValues(existing, value);
        }
        else {
            merged[key] = value;
        }
    }
    return merged;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=contrib-service.js.map