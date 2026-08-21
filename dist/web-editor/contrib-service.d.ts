import { type UiContributionTabDescriptor, type UiContributionTransport } from "../ui-contribution/contrib-port.ts";
export interface ContributionServiceOptions {
    discoverTimeoutMs?: number;
    requestTimeoutMs?: number;
}
export type ContributionWriteResult = {
    ok: true;
    values?: Record<string, unknown>;
} | {
    ok: false;
    status: number;
    error: string;
    errors?: Record<string, string>;
};
export declare class ContributionService {
    private readonly client;
    private readonly discoverTimeoutMs;
    private readonly requestTimeoutMs;
    private connection?;
    private tabs;
    private discovering?;
    private discoveringGeneration?;
    private unavailableUnsubscribe?;
    private lifecycleGeneration;
    private started;
    constructor(transport: UiContributionTransport, options?: ContributionServiceOptions);
    start(): void;
    stop(): Promise<void>;
    listTabs(): Promise<UiContributionTabDescriptor[]>;
    writeValues(tabId: string, patch: Record<string, unknown>): Promise<ContributionWriteResult>;
    private ensureConnected;
    private refreshTabs;
}
//# sourceMappingURL=contrib-service.d.ts.map