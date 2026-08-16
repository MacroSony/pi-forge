import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
	AGENT_PROFILE_THINKING_LEVELS,
	AGENT_PROFILE_TYPE,
	type AgentProfile,
} from "../agent-profile.ts";
import {
	isValidSubagentTimeoutMs,
	MAX_SUBAGENT_TIMEOUT_MS,
	MIN_SUBAGENT_TIMEOUT_MS,
} from "../forge-config.ts";
import { convertSillyTavernPreset } from "../sillytavern-importer.ts";
import type { PromptStack } from "../types.ts";
import { renderEditorHtml } from "./page.ts";
import type {
	WebEditorCreateStackOptions,
	WebEditorHost,
	WebEditorOperationResult,
	WebEditorServer,
	WebEditorServerOptions,
	WebEditorSubagentPolicyUpdate,
} from "./types.ts";

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

	if (req.method === "GET" && parts[1] === "profiles" && parts.length === 2) {
		sendJson(res, 200, host.listProfiles());
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
		const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true as const, scope: undefined };
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
		const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true as const, scope: undefined };
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
		sendOperation(res, await host.saveProfile(parts[2]!, parsed.profile));
		return;
	}

	if (req.method === "POST" && parts[1] === "profiles" && parts[3] === "apply" && parts.length === 4) {
		sendOperation(res, await host.applyProfile(parts[2]!));
		return;
	}

	if (req.method === "DELETE" && parts[1] === "profiles" && parts.length === 3) {
		sendOperation(res, await host.deleteProfile(parts[2]!));
		return;
	}

	if (req.method === "PUT" && parts[1] === "profiles" && parts[3] === "subagent" && parts.length === 4) {
		const parsed = readSubagentPolicyPayload(await readJsonBody(req));
		if (!parsed.ok) {
			sendJson(res, 400, { error: parsed.error });
			return;
		}
		sendOperation(res, await host.updateSubagentPolicy(parts[2]!, parsed.update));
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
		const scopeResult = isPlainObject(body) ? parseScope(body.scope) : { ok: true as const, scope: undefined };
		if (!scopeResult.ok) {
			sendJson(res, 400, { error: scopeResult.error });
			return;
		}
		const options: WebEditorCreateStackOptions = isPlainObject(body)
			? {
				activate: body.activate === true,
				overwrite: body.overwrite === true,
				scope: scopeResult.scope,
			}
			: {};
		const result = await host.createStack(parsed.stack, options);
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
		sendOperation(res, await host.saveStack(parts[2]!, parsed.stack));
		return;
	}

	if (req.method === "DELETE" && parts[1] === "stacks" && parts.length === 3) {
		sendOperation(res, await host.deleteStack(parts[2]!));
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
		sendOperation(res, await host.reloadStacks());
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

function readProfilePayload(body: unknown): { ok: true; profile: AgentProfile } | { ok: false; error: string } {
	const raw = isPlainObject(body) && "profile" in body ? body.profile : body;
	if (!isPlainObject(raw)) return { ok: false, error: "Profile payload must be a JSON object." };

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
	if (unsupported) return { ok: false, error: `Unsupported profile field: ${unsupported}` };
	if (raw.schemaVersion !== 1) return { ok: false, error: "Profile schemaVersion must be 1." };
	if (raw.type !== AGENT_PROFILE_TYPE) return { ok: false, error: `Profile type must be "${AGENT_PROFILE_TYPE}".` };
	if (typeof raw.id !== "string") return { ok: false, error: "Profile id must be a string." };
	if (raw.name !== undefined && typeof raw.name !== "string") return { ok: false, error: "Profile name must be a string when provided." };
	if (raw.description !== undefined && typeof raw.description !== "string") {
		return { ok: false, error: "Profile description must be a string when provided." };
	}
	if (raw.autoActivate !== undefined && typeof raw.autoActivate !== "boolean") {
		return { ok: false, error: "Profile autoActivate must be a boolean when provided." };
	}
	if (!isPlainObject(raw.model)) return { ok: false, error: "Profile model must be an object." };
	const unsupportedModelField = Object.keys(raw.model).find((field) => field !== "provider" && field !== "id");
	if (unsupportedModelField) return { ok: false, error: `Unsupported profile model field: ${unsupportedModelField}` };
	if (typeof raw.model.provider !== "string" || typeof raw.model.id !== "string") {
		return { ok: false, error: "Profile model provider and id must be strings." };
	}
	if (
		typeof raw.thinkingLevel !== "string"
		|| !AGENT_PROFILE_THINKING_LEVELS.includes(raw.thinkingLevel as AgentProfile["thinkingLevel"])
	) {
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
			name: raw.name as string | undefined,
			description: raw.description as string | undefined,
			autoActivate: raw.autoActivate as boolean | undefined,
			model: {
				provider: raw.model.provider,
				id: raw.model.id,
			},
			thinkingLevel: raw.thinkingLevel as AgentProfile["thinkingLevel"],
			promptStack: raw.promptStack,
		},
	};
}

function isSillyTavernPresetPayload(value: Record<string, unknown>): boolean {
	return Array.isArray(value.prompts) && !Array.isArray(value.items);
}

function readSubagentPolicyPayload(body: unknown): { ok: true; update: WebEditorSubagentPolicyUpdate } | { ok: false; error: string } {
	if (!isPlainObject(body)) return { ok: false, error: "Subagent policy payload must be a JSON object." };
	const unsupported = Object.keys(body).find((field) => field !== "enabled" && field !== "backend" && field !== "timeoutMs");
	if (unsupported) return { ok: false, error: `Unsupported subagent policy field: ${unsupported}` };
	if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
		return { ok: false, error: "Subagent policy enabled must be a boolean when provided." };
	}
	if (body.backend !== undefined && body.backend !== null && (typeof body.backend !== "string" || !body.backend.trim())) {
		return { ok: false, error: "Subagent policy backend must be a non-empty string or null to clear the override." };
	}
	if (body.timeoutMs !== undefined && body.timeoutMs !== null && !isValidSubagentTimeoutMs(body.timeoutMs)) {
		return {
			ok: false,
			error: `Subagent policy timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} or null to clear the override.`,
		};
	}
	return {
		ok: true,
		update: {
			enabled: body.enabled as boolean | undefined,
			backend: body.backend === null ? null : (body.backend as string | undefined)?.trim(),
			timeoutMs: body.timeoutMs as number | null | undefined,
		},
	};
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

function parseScope(value: unknown): { ok: true; scope?: "global" | "project" } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	if (value === "project" || value === "global") return { ok: true, scope: value };
	return { ok: false, error: 'scope must be "project" or "global".' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
