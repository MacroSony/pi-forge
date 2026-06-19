import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { convertSillyTavernPreset } from "../sillytavern-importer.ts";
import type { PromptStack, PromptStateValue } from "../types.ts";
import { renderEditorHtml } from "./page.ts";
import type { WebEditorHost, WebEditorOperationResult, WebEditorServer, WebEditorServerOptions } from "./types.ts";

// Port 0 asks Node to bind any available localhost port.
export const DEFAULT_WEB_EDITOR_PORT = 0;

export async function startWebEditorServer(host: WebEditorHost, options: WebEditorServerOptions = {}): Promise<WebEditorServer> {
	let currentHost = host;
	const token = randomBytes(24).toString("base64url");
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		void handleRequest(currentHost, token, req, res).catch((error) => {
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
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
	return {
		url,
		port: address.port,
		updateHost: (nextHost) => {
			currentHost = nextHost;
		},
		close: () => closeServer(server, sockets),
	};
}

async function handleRequest(host: WebEditorHost, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	if (url.pathname === "/" && req.method === "GET") {
		if (url.searchParams.get("token") !== token) {
			sendText(res, 403, "Invalid pi-forge editor token.");
			return;
		}
		sendHtml(res, renderEditorHtml());
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

	if (req.method === "GET" && parts[1] === "stacks" && parts.length === 2) {
		sendJson(res, 200, { stacks: host.listStacks(), cwd: host.cwd });
		return;
	}

	if (req.method === "POST" && parts[1] === "stacks" && parts.length === 2) {
		const body = await readJsonBody(req);
		const parsed = readStackPayload(body);
		if (!parsed.ok) {
			sendJson(res, 400, { error: parsed.error });
			return;
		}
		const options = isPlainObject(body)
			? { activate: body.activate === true, overwrite: body.overwrite === true }
			: {};
		const result = host.createStack(parsed.stack, options);
		if (result.ok && parsed.importFormat) {
			sendJson(res, 200, { ...result, importFormat: parsed.importFormat, importReport: parsed.importReport });
			return;
		}
		sendOperation(res, result);
		return;
	}

	if (req.method === "GET" && parts[1] === "stacks" && parts.length === 3) {
		const loaded = host.getStack(parts[2]!);
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
		sendOperation(res, host.saveStack(parts[2]!, parsed.stack));
		return;
	}

	if (req.method === "DELETE" && parts[1] === "stacks" && parts.length === 3) {
		sendOperation(res, host.deleteStack(parts[2]!));
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
		sendOperation(res, host.previewStack(parts[2]!, parsed.stack));
		return;
	}

	if (req.method === "GET" && parts[1] === "state" && parts.length === 2) {
		sendOperation(res, host.getState());
		return;
	}

	if ((req.method === "PUT" || req.method === "POST") && parts[1] === "state" && parts.length === 3) {
		const body = await readJsonBody(req);
		const parsed = readStatePayload(body);
		if (!parsed.ok) {
			sendJson(res, 400, { error: parsed.error });
			return;
		}
		sendOperation(res, host.setState(parts[2]!, parsed.value));
		return;
	}

	if (req.method === "DELETE" && parts[1] === "state" && (parts.length === 2 || parts.length === 3)) {
		sendOperation(res, host.clearState(parts[2]));
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

	if (req.method === "POST" && parts[1] === "stacks" && parts.length === 4 && parts[3] === "activate") {
		sendOperation(res, host.activateStack(parts[2]!));
		return;
	}

	if (req.method === "POST" && parts[1] === "disable" && parts.length === 2) {
		sendOperation(res, host.disableStacks());
		return;
	}

	if (req.method === "POST" && parts[1] === "reload" && parts.length === 2) {
		sendOperation(res, host.reloadStacks());
		return;
	}

	sendJson(res, 404, { error: "Unknown pi-forge editor API route." });
}

function hasValidToken(req: IncomingMessage, url: URL, token: string): boolean {
	const header = req.headers["x-pi-forge-token"];
	return header === token || url.searchParams.get("token") === token;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	const maxBytes = 2_000_000;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw new Error("Request body is too large.");
		chunks.push(buffer);
	}

	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() ? JSON.parse(text) : {};
}

function readStackPayload(body: unknown): { ok: true; stack: PromptStack; importFormat?: "sillytavern"; importReport?: string } | { ok: false; error: string } {
	const rawStack = isPlainObject(body) && "stack" in body ? body.stack : body;
	if (!isPlainObject(rawStack)) return { ok: false, error: "Stack payload must be a JSON object." };

	if (isSillyTavernPresetPayload(rawStack)) {
		const sourceName = isPlainObject(body) && typeof body.sourceName === "string" ? body.sourceName : undefined;
		const characterId = readCharacterId(body);
		const result = convertSillyTavernPreset(rawStack, { sourceName, characterId });
		if ("error" in result) return { ok: false, error: `SillyTavern import error: ${result.error}` };
		return { ok: true, stack: result.stack, importFormat: "sillytavern", importReport: result.report };
	}

	if (typeof rawStack.id !== "string" || !rawStack.id.trim()) return { ok: false, error: "Stack id must be a non-empty string." };
	if (!Array.isArray(rawStack.items)) return { ok: false, error: "Stack items must be an array." };

	for (const [index, item] of rawStack.items.entries()) {
		if (!isPlainObject(item)) return { ok: false, error: `Item ${index + 1} must be an object.` };
		if (item.kind !== "block" && item.kind !== "slot") return { ok: false, error: `Item ${index + 1} kind must be block or slot.` };
		if (typeof item.id !== "string" || !item.id.trim()) return { ok: false, error: `Item ${index + 1} id must be a non-empty string.` };
		if (item.kind === "block" && typeof item.content !== "string") return { ok: false, error: `Block item ${item.id} content must be a string.` };
		if (item.kind === "slot" && typeof item.slot !== "string") return { ok: false, error: `Slot item ${item.id} slot must be a string.` };
	}

	return { ok: true, stack: rawStack as unknown as PromptStack };
}

function readStatePayload(body: unknown): { ok: true; value: PromptStateValue } | { ok: false; error: string } {
	const value = isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "value") ? body.value : body;
	if (!isPromptStateValue(value)) return { ok: false, error: "State value must be JSON-compatible." };
	return { ok: true, value };
}

function isSillyTavernPresetPayload(value: Record<string, unknown>): boolean {
	return Array.isArray(value.prompts) && !Array.isArray(value.items);
}

function readCharacterId(body: unknown): number | undefined {
	if (!isPlainObject(body)) return undefined;
	const raw = body.characterId;
	if (typeof raw === "number" && Number.isInteger(raw)) return raw;
	if (typeof raw === "string" && raw.trim()) {
		const parsed = Number(raw.trim());
		if (Number.isInteger(parsed)) return parsed;
	}
	return undefined;
}

function sendOperation<T>(res: ServerResponse, result: WebEditorOperationResult<T>): void {
	if (!result.ok) {
		sendJson(res, result.status ?? 400, { error: result.error });
		return;
	}
	sendJson(res, 200, result);
}

function sendHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"connection": "close",
	});
	res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"connection": "close",
	});
	res.end(text);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"connection": "close",
	});
	res.end(JSON.stringify(value));
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		for (const socket of sockets) socket.destroy();
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPromptStateValue(value: unknown): value is PromptStateValue {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isPromptStateValue);
	if (!isPlainObject(value)) return false;
	return Object.values(value).every(isPromptStateValue);
}
