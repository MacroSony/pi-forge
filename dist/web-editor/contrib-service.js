import { UiContributionClient, } from "../ui-contribution/contrib-port.js";
export class ContributionService {
    client;
    discoverTimeoutMs;
    requestTimeoutMs;
    connection;
    tabs = [];
    discovering;
    unavailableUnsubscribe;
    constructor(transport, options = {}) {
        this.discoverTimeoutMs = options.discoverTimeoutMs ?? 200;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
        this.client = new UiContributionClient(transport, {
            discoverSettleMs: 10,
            defaultTimeoutMs: this.requestTimeoutMs,
        });
    }
    start() {
        this.unavailableUnsubscribe = this.client.onUnavailable(() => {
            this.connection = undefined;
            this.tabs = [];
        });
        void this.ensureConnected()
            .then(() => this.refreshTabs())
            .catch(() => {
            this.connection = undefined;
            this.tabs = [];
        });
    }
    async stop() {
        if (this.unavailableUnsubscribe) {
            this.unavailableUnsubscribe();
            this.unavailableUnsubscribe = undefined;
        }
        this.client.disconnect();
        this.connection = undefined;
        this.tabs = [];
    }
    async listTabs() {
        const connection = await this.ensureConnected();
        if (!connection)
            return [];
        if (this.tabs.length === 0)
            await this.refreshTabs();
        return this.tabs;
    }
    async writeValues(tabId, patch) {
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
            if (tab)
                tab.values = response.values ?? patch;
            return { ok: true, values: response.values ?? patch };
        }
        const first = Object.values(response.errors)[0];
        return {
            ok: false,
            status: 400,
            error: first ? `${first} (${Object.keys(response.errors).join(", ")})` : "Contribution values failed validation.",
            errors: response.errors,
        };
    }
    async ensureConnected() {
        if (this.connection)
            return this.connection;
        if (!this.discovering) {
            this.discovering = this.client.discover(this.discoverTimeoutMs)
                .then((connection) => {
                this.client.connect(connection);
                this.connection = connection;
                return connection;
            })
                .catch(() => undefined)
                .finally(() => {
                this.discovering = undefined;
            });
        }
        return this.discovering;
    }
    async refreshTabs() {
        try {
            const connection = this.connection;
            if (!connection) {
                this.tabs = [];
                return;
            }
            const result = await this.client.listContributions(connection, this.requestTimeoutMs);
            if (!result.ok) {
                this.tabs = [];
                this.connection = undefined;
                return;
            }
            const response = result.data;
            this.tabs = response.tabs;
        }
        catch {
            this.tabs = [];
            this.connection = undefined;
        }
    }
}
//# sourceMappingURL=contrib-service.js.map