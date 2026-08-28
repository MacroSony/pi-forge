import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AGENT_PROFILE_THINKING_LEVELS, AGENT_PROFILE_TYPE, } from "../agent-profile.js";
import { ContributionService } from "./contrib-service.js";
import { renderEditorHtml } from "./page.js";
// Port 0 asks Node to bind any available localhost port.
export const DEFAULT_WEB_EDITOR_PORT = 0;
class RequestBodyError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "RequestBodyError";
        this.status = status;
    }
}
export async function startWebEditorServer(host, options = {}) {
    let currentHost = host;
    const token = randomBytes(24).toString("base64url");
    const sockets = new Set();
    const contributionService = options.contributionTransport
        ? new ContributionService(options.contributionTransport, {
            discoverTimeoutMs: options.contributionDiscoverTimeoutMs,
        })
        : undefined;
    const server = createServer((req, res) => {
        void handleRequest(currentHost, token, contributionService, req, res).catch((error) => {
            const status = error instanceof RequestBodyError ? error.status : 500;
            sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? DEFAULT_WEB_EDITOR_PORT, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await closeServer(server, sockets);
        throw new Error("Failed to start pi-forge editor server.");
    }
    const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
    contributionService?.start();
    return {
        url,
        port: address.port,
        updateHost: (nextHost) => {
            currentHost = nextHost;
        },
        close: async () => {
            await contributionService?.stop();
            await closeServer(server, sockets);
        },
    };
}
async function handleRequest(host, token, contributionService, req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" && req.method === "GET") {
        if (url.searchParams.get("token") !== token) {
            sendText(res, 403, "Invalid pi-forge editor token.");
            return;
        }
        sendHtml(res, renderEditorHtml(resolvePageLang(host, req)));
        return;
    }
    if (!url.pathname.startsWith("/api/")) {
        sendText(res, 404, "Not found.");
        return;
    }
    if (!hasValidToken(req, url, token)) {
        sendJson(res, 403, { error: "Invalid pi-forge editor token." });
        return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (req.method === "GET" && parts[1] === "editor-config" && parts.length === 2) {
        sendJson(res, 200, host.getEditorConfig());
        return;
    }
    if (req.method === "PUT" && parts[1] === "editor-config" && parts.length === 2) {
        const body = await readJsonBody(req);
        const locale = isPlainObject(body) ? body.locale : undefined;
        if (locale !== "en" && locale !== "zh-CN" && locale !== "auto") {
            sendJson(res, 400, { error: 'locale must be "en", "zh-CN", or "auto".' });
            return;
        }
        const result = host.setEditorLocale(locale);
        if (!result.ok) {
            sendJson(res, result.status ?? 500, { error: result.error });
            return;
        }
        sendJson(res, 200, { locale: result.locale });
        return;
    }
    if (req.method === "GET" && parts[1] === "stacks" && parts.length === 2) {
        sendJson(res, 200, { stacks: host.listStacks(), cwd: host.cwd });
        return;
    }
    if (req.method === "GET" && parts[1] === "profiles" && parts.length === 2) {
        sendJson(res, 200, host.listProfiles());
        return;
    }
    if (req.method === "GET" && parts[1] === "contrib" && parts.length === 2) {
        if (!contributionService) {
            sendJson(res, 200, { tabs: [], providerKey: null });
            return;
        }
        const tabs = await contributionService.listTabs();
        sendJson(res, 200, { tabs, providerKey: contributionService.providerKey });
        return;
    }
    if (req.method === "PUT" && parts[1] === "contrib" && parts.length === 3) {
        if (!contributionService) {
            sendJson(res, 503, { error: "No UI contribution provider is available." });
            return;
        }
        const body = await readJsonBody(req);
        const patch = isPlainObject(body) && isPlainObject(body.patch)
            ? body.patch
            : isPlainObject(body)
                ? body
                : undefined;
        if (!patch) {
            sendJson(res, 400, { error: "Contribution patch must be a JSON object." });
            return;
        }
        const result = await contributionService.writeValues(parts[2], patch);
        if (!result.ok) {
            sendJson(res, result.status, {
                error: result.error,
                ...(result.errors ? { errors: result.errors } : {}),
            });
            return;
        }
        sendJson(res, 200, { ok: true, ...(result.values ? { values: result.values } : {}) });
        return;
    }
    if (req.method === "POST" && parts[1] === "profiles" && parts[2] === "reload" && parts.length === 3) {
        sendOperation(res, await host.reloadProfiles());
        return;
    }
    if (req.method === "POST" && parts[1] === "profiles" && parts[2] === "validate" && parts.length === 3) {
        const body = await readJsonBody(req);
        const parsed = readProfilePayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        const existingId = isPlainObject(body) && typeof body.existingId === "string" ? body.existingId : undefined;
        const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true, scope: undefined };
        if (!scopeResult.ok) {
            sendJson(res, 400, { error: scopeResult.error });
            return;
        }
        sendJson(res, 200, host.validateProfile(parsed.profile, existingId, scopeResult.scope ?? "project"));
        return;
    }
    if (req.method === "POST" && parts[1] === "profiles" && parts.length === 2) {
        const body = await readJsonBody(req);
        const parsed = readProfilePayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true, scope: undefined };
        if (!scopeResult.ok) {
            sendJson(res, 400, { error: scopeResult.error });
            return;
        }
        sendOperation(res, await host.createProfile(parsed.profile, scopeResult.scope ?? "project"));
        return;
    }
    if (req.method === "PUT" && parts[1] === "profiles" && parts.length === 3) {
        const parsed = readProfilePayload(await readJsonBody(req));
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        sendOperation(res, await host.saveProfile(parts[2], parsed.profile));
        return;
    }
    if (req.method === "POST" && parts[1] === "profiles" && parts[3] === "apply" && parts.length === 4) {
        sendOperation(res, await host.applyProfile(parts[2]));
        return;
    }
    if (req.method === "DELETE" && parts[1] === "profiles" && parts.length === 3) {
        sendOperation(res, await host.deleteProfile(parts[2]));
        return;
    }
    if (req.method === "GET" && parts[1] === "resources" && parts.length === 2) {
        sendJson(res, 200, host.listResources());
        return;
    }
    if (req.method === "POST" && parts[1] === "stacks" && parts.length === 2) {
        const body = await readJsonBody(req);
        const parsed = readStackPayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true, scope: undefined };
        if (!scopeResult.ok) {
            sendJson(res, 400, { error: scopeResult.error });
            return;
        }
        const options = isPlainObject(body)
            ? {
                activate: body.activate === true,
                overwrite: body.overwrite === true,
                scope: scopeResult.scope,
            }
            : {};
        sendOperation(res, await host.createStack(parsed.stack, options));
        return;
    }
    if (req.method === "GET" && parts[1] === "stacks" && parts.length === 3) {
        const loaded = host.getStack(parts[2]);
        if (!loaded) {
            sendJson(res, 404, { error: `Unknown prompt stack: ${parts[2]}` });
            return;
        }
        sendJson(res, 200, loaded);
        return;
    }
    if (req.method === "PUT" && parts[1] === "stacks" && parts.length === 3) {
        const body = await readJsonBody(req);
        const parsed = readStackPayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        sendOperation(res, await host.saveStack(parts[2], parsed.stack));
        return;
    }
    if (req.method === "DELETE" && parts[1] === "stacks" && parts.length === 3) {
        sendOperation(res, await host.deleteStack(parts[2]));
        return;
    }
    if (req.method === "POST" && parts[1] === "stacks" && parts.length === 4 && parts[3] === "validate") {
        const body = await readJsonBody(req);
        const parsed = readStackPayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        sendJson(res, 200, { diagnostics: host.validateStack(parsed.stack) });
        return;
    }
    if (req.method === "POST" && parts[1] === "stacks" && parts.length === 4 && parts[3] === "preview") {
        const body = await readJsonBody(req);
        const parsed = readStackPayload(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        sendOperation(res, host.previewStack(parts[2], parsed.stack));
        return;
    }
    if (req.method === "GET" && parts[1] === "payload" && parts.length === 2) {
        sendOperation(res, host.getPayload());
        return;
    }
    if (req.method === "POST" && parts[1] === "payload" && parts.length === 3 && parts[2] === "arm") {
        const body = await readJsonBody(req);
        const savePath = isPlainObject(body) && typeof body.savePath === "string" && body.savePath.trim() ? body.savePath.trim() : undefined;
        sendOperation(res, host.armPayload(savePath));
        return;
    }
    if (req.method === "DELETE" && parts[1] === "payload" && parts.length === 2) {
        sendOperation(res, host.clearPayload());
        return;
    }
    if (req.method === "GET" && parts[1] === "context-diff" && parts.length === 2) {
        sendOperation(res, host.getContextDiff());
        return;
    }
    if (req.method === "POST" && parts[1] === "stacks" && parts.length === 4 && parts[3] === "activate") {
        sendOperation(res, host.activateStack(parts[2]));
        return;
    }
    if (req.method === "POST" && parts[1] === "disable" && parts.length === 2) {
        sendOperation(res, host.disableStacks());
        return;
    }
    if (req.method === "POST" && parts[1] === "reload" && parts.length === 2) {
        sendOperation(res, await host.reloadStacks());
        return;
    }
    sendJson(res, 404, { error: "Unknown pi-forge editor API route." });
}
function hasValidToken(req, url, token) {
    const header = req.headers["x-pi-forge-token"];
    return header === token || url.searchParams.get("token") === token;
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    const maxBytes = 2_000_000;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes)
            throw new RequestBodyError(413, "Request body is too large.");
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim())
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new RequestBodyError(400, "Request body must contain valid JSON.");
    }
}
function readStackPayload(body) {
    const rawStack = isPlainObject(body) && "stack" in body ? body.stack : body;
    if (!isPlainObject(rawStack))
        return { ok: false, error: "Stack payload must be a JSON object." };
    if (typeof rawStack.id !== "string" || !rawStack.id.trim())
        return { ok: false, error: "Stack id must be a non-empty string." };
    if (!Array.isArray(rawStack.items))
        return { ok: false, error: "Stack items must be an array." };
    for (const [index, item] of rawStack.items.entries()) {
        if (!isPlainObject(item))
            return { ok: false, error: `Item ${index + 1} must be an object.` };
        if (item.kind !== "block" && item.kind !== "slot")
            return { ok: false, error: `Item ${index + 1} kind must be block or slot.` };
        if (typeof item.id !== "string" || !item.id.trim())
            return { ok: false, error: `Item ${index + 1} id must be a non-empty string.` };
        if (item.kind === "block" && typeof item.content !== "string")
            return { ok: false, error: `Block item ${item.id} content must be a string.` };
        if (item.kind === "slot" && typeof item.slot !== "string")
            return { ok: false, error: `Slot item ${item.id} slot must be a string.` };
    }
    return { ok: true, stack: rawStack };
}
function readProfilePayload(body) {
    const raw = isPlainObject(body) && "profile" in body ? body.profile : body;
    if (!isPlainObject(raw))
        return { ok: false, error: "Profile payload must be a JSON object." };
    const allowedFields = new Set([
        "schemaVersion",
        "type",
        "id",
        "name",
        "description",
        "autoActivate",
        "model",
        "thinkingLevel",
        "promptStack",
    ]);
    const unsupported = Object.keys(raw).find((field) => !allowedFields.has(field));
    if (unsupported)
        return { ok: false, error: `Unsupported profile field: ${unsupported}` };
    if (raw.schemaVersion !== 1)
        return { ok: false, error: "Profile schemaVersion must be 1." };
    if (raw.type !== AGENT_PROFILE_TYPE)
        return { ok: false, error: `Profile type must be "${AGENT_PROFILE_TYPE}".` };
    if (typeof raw.id !== "string")
        return { ok: false, error: "Profile id must be a string." };
    if (raw.name !== undefined && typeof raw.name !== "string")
        return { ok: false, error: "Profile name must be a string when provided." };
    if (raw.description !== undefined && typeof raw.description !== "string") {
        return { ok: false, error: "Profile description must be a string when provided." };
    }
    if (raw.autoActivate !== undefined && typeof raw.autoActivate !== "boolean") {
        return { ok: false, error: "Profile autoActivate must be a boolean when provided." };
    }
    if (!isPlainObject(raw.model))
        return { ok: false, error: "Profile model must be an object." };
    const unsupportedModelField = Object.keys(raw.model).find((field) => field !== "provider" && field !== "id");
    if (unsupportedModelField)
        return { ok: false, error: `Unsupported profile model field: ${unsupportedModelField}` };
    if (typeof raw.model.provider !== "string" || typeof raw.model.id !== "string") {
        return { ok: false, error: "Profile model provider and id must be strings." };
    }
    if (typeof raw.thinkingLevel !== "string"
        || !AGENT_PROFILE_THINKING_LEVELS.includes(raw.thinkingLevel)) {
        return { ok: false, error: `Unsupported profile thinkingLevel: ${String(raw.thinkingLevel)}` };
    }
    if (raw.promptStack !== null && typeof raw.promptStack !== "string") {
        return { ok: false, error: "Profile promptStack must be a string or null." };
    }
    return {
        ok: true,
        profile: {
            schemaVersion: 1,
            type: AGENT_PROFILE_TYPE,
            id: raw.id,
            name: raw.name,
            description: raw.description,
            autoActivate: raw.autoActivate,
            model: {
                provider: raw.model.provider,
                id: raw.model.id,
            },
            thinkingLevel: raw.thinkingLevel,
            promptStack: raw.promptStack,
        },
    };
}
function sendOperation(res, result) {
    if (!result.ok) {
        sendJson(res, result.status ?? 400, { error: result.error });
        return;
    }
    sendJson(res, 200, result);
}
function sendHtml(res, html) {
    res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "connection": "close",
    });
    res.end(html);
}
function sendText(res, status, text) {
    res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "connection": "close",
    });
    res.end(text);
}
/**
 * Resolve the initial page language: an explicit configured locale wins;
 * "auto" follows the browser's Accept-Language header. The client keeps
 * document.documentElement.lang in sync when the user switches locale.
 */
function resolvePageLang(host, req) {
    const configured = host.getEditorConfig().locale;
    if (configured === "en" || configured === "zh-CN")
        return configured;
    const accepted = req.headers["accept-language"] ?? "";
    const ranges = accepted
        .split(",")
        .map((entry, index) => {
        const [rawRange = "", ...parameters] = entry.trim().split(";");
        let quality = 1;
        for (const parameter of parameters) {
            if (!/^q\s*=/iu.test(parameter.trim()))
                continue;
            const match = parameter.trim().match(/^q\s*=\s*(0(?:\.\d{0,3})?|\.\d{1,3}|1(?:\.0{0,3})?)$/iu);
            quality = match ? Number(match[1]) : 0;
            break;
        }
        return { range: rawRange.toLowerCase(), quality, index };
    })
        .filter(({ range, quality }) => range.length > 0 && quality > 0)
        .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const { range } of ranges) {
        if (range === "zh" || range.startsWith("zh-"))
            return "zh-CN";
        if (range === "en" || range.startsWith("en-") || range === "*")
            return "en";
    }
    return "en";
}
function sendJson(res, status, value) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "connection": "close",
    });
    res.end(JSON.stringify(value));
}
function closeServer(server, sockets) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets)
            socket.destroy();
    });
}
function parseScope(value) {
    if (value === undefined)
        return { ok: true };
    if (value === "project" || value === "global")
        return { ok: true, scope: value };
    return { ok: false, error: 'scope must be "project" or "global".' };
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=server.js.map