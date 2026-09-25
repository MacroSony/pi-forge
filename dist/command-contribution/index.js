/** Local, synchronous discovery only. Not an RPC/authorization or execution boundary. */
export const FORGE_COMMAND_DISCOVERY_EVENT = "pi-forge:command-contribution:v1";
/** The extension owns the returned unsubscribe; no singleton registry or persistent state. */
export function contributeForgeCommand(events, contribution) {
    if (!/^[a-z][a-z0-9-]*$/.test(contribution.name) || ["help", "ui", "payload"].includes(contribution.name)) {
        throw new Error(`Invalid or reserved Forge command contribution: ${contribution.name}`);
    }
    return events.on(FORGE_COMMAND_DISCOVERY_EVENT, (data) => {
        const request = data;
        if (request?.version === 1 && typeof request.provide === "function")
            request.provide(contribution);
    });
}
//# sourceMappingURL=index.js.map