import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { convertSillyTavernPreset } from "./sillytavern-importer.ts";
import type { PromptStack, PromptStackDiagnostic, PromptStateDefinition, PromptStateValue } from "./types.ts";

export interface WebEditorStackSummary {
	id: string;
	name?: string;
	filePath: string;
	active: boolean;
	autoActivate?: boolean;
	mode?: string;
	itemCount: number;
	errors: number;
	warnings: number;
	diagnostics: PromptStackDiagnostic[];
}

export interface WebEditorHost {
	cwd: string;
	listStacks(): WebEditorStackSummary[];
	getStack(id: string): { stack: PromptStack; filePath: string; diagnostics: PromptStackDiagnostic[] } | undefined;
	createStack(stack: PromptStack, options: WebEditorCreateStackOptions): WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }>;
	saveStack(id: string, stack: PromptStack): WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }>;
	deleteStack(id: string): WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }>;
	validateStack(stack: PromptStack): PromptStackDiagnostic[];
	previewStack(id: string, stack: PromptStack): WebEditorOperationResult<{ text: string; preview?: WebEditorPreview; diagnostics: PromptStackDiagnostic[] }>;
	getState(): WebEditorOperationResult<WebEditorStateSnapshot>;
	setState(name: string, value: PromptStateValue): WebEditorOperationResult<WebEditorStateSnapshot>;
	clearState(name?: string): WebEditorOperationResult<WebEditorStateSnapshot>;
	getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	activateStack(id: string): WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }>;
	disableStacks(): WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }>;
	reloadStacks(): WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }>;
}

export interface WebEditorPreviewSection {
	id: string;
	title: string;
	role?: string;
	content: string;
	chars: number;
	approxTokens: number;
}

export interface WebEditorPreview {
	stackId: string;
	generatedAt: string;
	system: WebEditorPreviewSection;
	messages: WebEditorPreviewSection[];
	totalChars: number;
	approxTokens: number;
}

export interface WebEditorStateSnapshot {
	activeStackId?: string;
	session: Record<string, PromptStateValue>;
	definitions: Record<string, PromptStateDefinition>;
}

export interface WebEditorPayloadCapture {
	capturedAt: string;
	stackId?: string;
	savePath?: string;
	payload?: unknown;
	text: string;
	chars: number;
	approxTokens: number;
	truncated: boolean;
	error?: string;
}

export type WebEditorPayloadSnapshot =
	| { status: "idle" }
	| { status: "armed"; armedAt?: string; savePath?: string }
	| { status: "captured"; capture: WebEditorPayloadCapture };

export interface WebEditorCreateStackOptions {
	activate?: boolean;
	overwrite?: boolean;
}

export type WebEditorOperationResult<T> = ({ ok: true } & T) | { ok: false; status?: number; error: string };

export interface WebEditorServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

export const DEFAULT_WEB_EDITOR_PORT = 41738;

export interface WebEditorServerOptions {
	port?: number;
}

export async function startWebEditorServer(host: WebEditorHost, options: WebEditorServerOptions = {}): Promise<WebEditorServer> {
	const token = randomBytes(24).toString("base64url");
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		void handleRequest(host, token, req, res).catch((error) => {
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

function renderEditorHtml(): string {
	return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-forge stack editor</title>
<style>
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --pane: #ffffff;
  --line: #d8dee8;
  --line-strong: #aeb8c7;
  --text: #18202c;
  --muted: #647083;
  --accent: #146b5f;
  --accent-bg: #e5f3ef;
  --warning: #9b6200;
  --warning-bg: #fff4d8;
  --error: #b42318;
  --error-bg: #fde8e7;
  --success: #1f7a3a;
  --control: #ffffff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}
button, input, select, textarea {
  font: inherit;
  letter-spacing: 0;
}
button {
  border: 1px solid var(--line-strong);
  background: var(--control);
  color: var(--text);
  min-height: 32px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
}
button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
button.danger {
  border-color: var(--error);
  color: var(--error);
}
button.icon {
  width: 34px;
  padding: 5px 0;
}
button:disabled {
  cursor: default;
  opacity: .55;
}
input, select, textarea {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: white;
  color: var(--text);
  padding: 6px 8px;
  width: 100%;
}
textarea {
  min-height: 140px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
html, body {
  height: 100%;
  overflow: hidden;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
}
.brand {
  font-weight: 700;
  margin-right: 8px;
  white-space: nowrap;
}
.status {
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  height: calc(100vh - 48px);
  min-height: 0;
  transition: grid-template-columns .16s ease;
}
.shell.sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}
.sidebar {
  border-right: 1px solid var(--line);
  background: var(--pane);
  min-width: 0;
  overflow: hidden;
}
.shell.sidebar-collapsed .sidebar {
  border-right: 0;
}
.side-head {
  padding: 12px;
  border-bottom: 1px solid var(--line);
}
.side-title {
  font-weight: 650;
}
.cwd {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.stack-list {
  padding: 8px;
  overflow: auto;
  height: calc(100% - 74px);
}
.stack-row {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 4px;
}
.stack-row.active {
  background: var(--accent-bg);
  border-color: #9dccbf;
}
.stack-row.selected {
  border-color: var(--accent);
}
.stack-name {
  font-weight: 650;
  overflow-wrap: anywhere;
}
.stack-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: 5px;
  font-size: 12px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.badge.error {
  color: var(--error);
  background: var(--error-bg);
  border-color: #f2b8b5;
}
.badge.warning {
  color: var(--warning);
  background: var(--warning-bg);
  border-color: #efd28b;
}
.main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.main-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
}
.action-spacer {
  flex: 1 1 auto;
  min-width: 12px;
}
.settings {
  display: grid;
  grid-template-columns: repeat(4, minmax(130px, 1fr));
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  background: #fbfcfe;
  flex: 0 0 auto;
}
.settings textarea {
  min-height: 48px;
  max-height: 72px;
  resize: vertical;
}
.field label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.checkline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.checkline input {
  width: auto;
}
.workspace {
  display: grid;
  grid-template-columns: minmax(230px, 340px) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.items-pane {
  border-right: 1px solid var(--line);
  background: var(--pane);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  font-weight: 650;
}
.item-tools {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}
.item-list {
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.item-row {
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  background: white;
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 6px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 48px;
  gap: 8px;
  align-items: center;
  cursor: grab;
}
.item-row:active {
  cursor: grabbing;
}
.item-row.selected {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.item-row.disabled {
  opacity: .62;
}
.item-row.dragging {
  border-style: dashed;
}
.drag-handle {
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  text-align: center;
  user-select: none;
}
.item-toggle {
  width: 44px;
  min-height: 26px;
  padding: 2px 0;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
}
.item-toggle.enabled {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
.item-toggle.disabled {
  border-color: var(--line-strong);
  background: #f3f5f8;
  color: var(--muted);
}
.item-title {
  font-weight: 650;
  overflow-wrap: anywhere;
}
.item-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.editor-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fbfcfe;
}
.item-editor {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.item-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.item-fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
  flex: 0 0 auto;
}
.item-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.item-body > .field {
  width: 100%;
}
.wide {
  grid-column: 1 / -1;
}
.content-field {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.content-field textarea {
  flex: 1;
  min-height: 0;
  height: 100%;
  resize: none;
}
.slot-options {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.segmented {
  display: inline-flex;
  gap: 4px;
  margin-bottom: 8px;
}
.segmented button {
  min-height: 28px;
  padding: 3px 9px;
}
.segmented button.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.options-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 1fr));
  gap: 10px;
  overflow: auto;
  padding-right: 4px;
  flex: 1;
  min-height: 0;
}
.option-note {
  color: var(--muted);
  font-size: 12px;
}
.json-options {
  flex: 1;
  min-height: 0;
  height: 100%;
  resize: none;
}
.empty {
  color: var(--muted);
  padding: 24px;
}
.diagnostics {
  border-top: 1px solid var(--line);
  background: var(--pane);
  flex: 0 0 128px;
  min-height: 0;
  overflow: auto;
}
.diagnostic {
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}
.diagnostic.error {
  color: var(--error);
  background: var(--error-bg);
}
.diagnostic.warning {
  color: var(--warning);
  background: var(--warning-bg);
}
.diagnostic.info {
  color: var(--muted);
}
.preview {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 100;
  align-items: stretch;
  justify-content: center;
  background: rgba(15, 23, 42, .38);
  color: var(--text);
  margin: 0;
  padding: 24px;
  overflow: hidden;
}
.preview.open {
  display: flex;
}
.preview-dialog {
  width: min(1220px, calc(100vw - 48px));
  height: min(900px, calc(100vh - 48px));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: #f8fafc;
  box-shadow: 0 18px 60px rgba(15, 23, 42, .24);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
  flex: 0 0 auto;
}
.preview-body {
  padding: 10px 12px 14px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.preview-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview-title {
  font-weight: 650;
}
.preview-meta {
  color: var(--muted);
  font-size: 12px;
}
.preview-section {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: white;
  margin-bottom: 8px;
  overflow: hidden;
}
.preview-section summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  list-style: none;
  border-bottom: 1px solid transparent;
}
.preview-section[open] summary {
  border-bottom-color: var(--line);
}
.preview-section summary::-webkit-details-marker {
  display: none;
}
.preview-section summary::before {
  content: "▶";
  color: var(--muted);
  font-size: 10px;
}
.preview-section[open] summary::before {
  content: "▼";
}
.preview-text {
  margin: 0;
  padding: 10px;
  background: #111827;
  color: #e5e7eb;
  overflow: auto;
  max-height: min(62vh, 680px);
  white-space: pre-wrap;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.preview-copy {
  min-height: 26px;
  padding: 2px 8px;
  font-size: 12px;
}
.modal {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 95;
  align-items: stretch;
  justify-content: center;
  background: rgba(15, 23, 42, .34);
  padding: 24px;
}
.modal.open {
  display: flex;
}
.modal-dialog {
  width: min(1280px, calc(100vw - 48px));
  height: min(860px, calc(100vh - 48px));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--pane);
  box-shadow: 0 18px 60px rgba(15, 23, 42, .22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.modal-title {
  font-weight: 650;
}
.modal-meta {
  color: var(--muted);
  font-size: 12px;
}
.modal-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: #fbfcfe;
}
.modal-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.modal-spacer {
  flex: 1;
}
.data-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.data-row {
  display: grid;
  gap: 8px;
  align-items: start;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: white;
}
.data-row.header {
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
  background: transparent;
  border-color: transparent;
  padding-top: 0;
  padding-bottom: 0;
}
.variable-row {
  grid-template-columns: minmax(160px, 260px) minmax(220px, 1fr) 86px;
}
.definition-row {
  grid-template-columns: minmax(150px, 210px) minmax(100px, 140px) minmax(90px, 120px) minmax(180px, 1fr) minmax(190px, 260px) minmax(110px, 130px) minmax(110px, 130px) 86px;
}
.session-row {
  grid-template-columns: minmax(160px, 240px) minmax(220px, 1fr) minmax(180px, 260px) 168px;
}
.data-row textarea {
  min-height: 56px;
  resize: vertical;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.state-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
@media (max-width: 900px) {
  .shell, .workspace, .settings, .item-fields {
    grid-template-columns: 1fr;
  }
  html, body {
    overflow: auto;
  }
  .shell {
    height: auto;
    min-height: calc(100vh - 48px);
  }
  .sidebar, .items-pane {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .item-list {
    max-height: 260px;
  }
  .variable-row, .definition-row, .session-row {
    grid-template-columns: 1fr;
  }
}
</style>
</head>
<body>
<header class="topbar">
  <button id="sidebarToggleBtn" class="icon" title="Toggle prompt stacks sidebar">☰</button>
  <div class="brand">pi-forge stack editor</div>
  <div id="status" class="status">Loading</div>
  <button id="reloadBtn">Reload</button>
  <button id="disableBtn">Disable stack</button>
</header>
<div id="shell" class="shell">
  <aside class="sidebar">
    <div class="side-head">
      <div class="side-title">Prompt stacks</div>
      <div id="cwd" class="cwd"></div>
    </div>
    <div id="stackList" class="stack-list"></div>
  </aside>
  <main class="main">
    <div class="main-actions">
      <button id="activateBtn" class="primary">Activate</button>
      <button id="saveBtn" class="primary">Save</button>
      <button id="validateBtn">Validate</button>
      <button id="previewBtn">Preview</button>
      <button id="payloadBtn">Arm payload</button>
      <button id="variablesBtn">Variables</button>
      <button id="stateSchemaBtn">State schema</button>
      <button id="sessionStateBtn">Session state</button>
      <button id="forkBtn">Fork</button>
      <button id="importBtn" title="Import pi-forge stack JSON or SillyTavern preset JSON">Import JSON</button>
      <button id="exportBtn">Export JSON</button>
      <span class="action-spacer"></span>
      <button id="deleteStackBtn" class="danger">Delete stack</button>
      <button id="deleteItemBtn" class="danger">Delete item</button>
      <input id="importFileInput" type="file" accept="application/json,.json" hidden>
    </div>
    <section id="settings" class="settings"></section>
    <section class="workspace">
      <div class="items-pane">
        <div class="pane-head">
          <span>Items</span>
          <span id="itemCount" class="stack-meta"></span>
        </div>
        <div class="item-tools">
          <button id="addBlockBtn">Add block</button>
          <button id="addSlotBtn">Add slot</button>
        </div>
        <div id="itemList" class="item-list"></div>
      </div>
      <div class="editor-pane">
        <div id="itemEditor" class="item-editor"></div>
        <div id="diagnostics" class="diagnostics"></div>
        <div id="preview" class="preview"></div>
      </div>
    </section>
  </main>
</div>
<div id="stackModal" class="modal"></div>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
let stacks = [];
let cwd = "";
let selectedId = "";
let currentStack = null;
let currentFilePath = "";
let selectedItemIndex = -1;
let dirty = false;
let dragIndex = -1;
let optionsText = "";
let optionsError = "";
let sidebarCollapsed = false;
let slotOptionsMode = "form";
let previewCopyTexts = [];
let payloadSnapshot = { status: "idle" };
let stackVariablesError = "";
let stackDefinitionsError = "";

const slotNames = [
  "chat-history", "tools", "tool-guidelines", "skills", "project-context",
  "append-system-prompt", "variables", "date", "cwd", "date-cwd",
  "active-model", "pi-docs"
];
const roles = ["", "system", "user", "assistant", "custom"];
const stateScopes = ["", "static", "session", "turn"];

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { "x-pi-forge-token": token, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    throw error;
  }
  return data;
}

function setStatus(text, tone = "") {
  el("status").textContent = text;
  el("status").style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
}

function markDirty() {
  dirty = true;
  setStatus("Unsaved changes");
}

async function loadStacks(preferId = selectedId) {
  const data = await api("/api/stacks");
  stacks = data.stacks || [];
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  const next = stacks.find((stack) => stack.id === preferId) || stacks.find((stack) => stack.active) || stacks[0];
  if (next) await selectStack(next.id, { keepDirty: false });
  else renderEmpty();
}

async function selectStack(id, options = {}) {
  if (dirty && !options.keepDirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id));
  selectedId = id;
  currentStack = structuredClone(data.stack);
  currentFilePath = data.filePath || "";
  selectedItemIndex = currentStack.items.length ? 0 : -1;
  dirty = false;
  optionsError = "";
  stackVariablesError = "";
  stackDefinitionsError = "";
  renderAll(data.diagnostics || []);
  setStatus("Loaded " + currentStack.id);
}

function renderAll(diagnostics = []) {
  renderStackList();
  renderSettings();
  renderItemList();
  renderItemEditor();
  renderDiagnostics(diagnostics);
  hidePreview();
}

function renderStackList() {
  const list = el("stackList");
  list.innerHTML = "";
  for (const stack of stacks) {
    const row = document.createElement("button");
    row.className = "stack-row" + (stack.active ? " active" : "") + (stack.id === selectedId ? " selected" : "");
    const diag = stack.errors ? '<span class="badge error">' + stack.errors + ' error</span>' : stack.warnings ? '<span class="badge warning">' + stack.warnings + ' warning</span>' : "";
    row.innerHTML = '<div class="stack-name">' + escapeHtml(stack.id) + (stack.active ? '<span class="badge">active</span>' : '') + diag + '</div>' +
      '<div class="stack-meta">' + escapeHtml(stack.name || "(unnamed)") + '</div>' +
      '<div class="stack-meta">' + stack.itemCount + ' items | ' + escapeHtml(stack.mode || "replace") + '</div>';
    row.onclick = () => selectStack(stack.id);
    list.appendChild(row);
  }
}

function renderSettings() {
  const settings = el("settings");
  if (!currentStack) {
    settings.innerHTML = "";
    return;
  }
  settings.innerHTML = [
    field("Stack ID", '<input id="stackId" value="' + attr(currentStack.id) + '">'),
    field("Name", '<input id="stackName" value="' + attr(currentStack.name || "") + '">'),
    field("Mode", '<select id="stackMode"><option value="replace">replace</option><option value="append">append</option><option value="prepend">prepend</option></select>'),
    field("Auto activate", '<label class="checkline"><input id="stackAuto" type="checkbox"> enabled</label>'),
    field("Description", '<textarea id="stackDescription" class="wide">' + escapeHtml(currentStack.description || "") + '</textarea>', "wide"),
    field("File", '<input value="' + attr(currentFilePath) + '" disabled>', "wide"),
  ].join("");
  el("stackMode").value = currentStack.mode || "replace";
  el("stackAuto").checked = currentStack.autoActivate === true;
  el("stackId").oninput = (event) => { currentStack.id = event.target.value; markDirty(); };
  el("stackName").oninput = (event) => { setOptionalString(currentStack, "name", event.target.value); markDirty(); };
  el("stackMode").onchange = (event) => { currentStack.mode = event.target.value; markDirty(); };
  el("stackAuto").onchange = (event) => { currentStack.autoActivate = event.target.checked; markDirty(); };
  el("stackDescription").oninput = (event) => { setOptionalString(currentStack, "description", event.target.value); markDirty(); };
}

function renderItemList() {
  const list = el("itemList");
  list.innerHTML = "";
  if (!currentStack) return;
  el("itemCount").textContent = currentStack.items.length + " total";
  currentStack.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "item-row" + (index === selectedItemIndex ? " selected" : "") + (item.enabled === false ? " disabled" : "");
    row.draggable = true;
    const enabled = item.enabled !== false;
    row.innerHTML = '<div class="drag-handle" title="Drag to reorder">≡</div>' +
      '<div><div class="item-title">' + escapeHtml(displayItemName(item)) + '</div>' +
      '<div class="item-meta">' + escapeHtml(item.kind) + ' | id: ' + escapeHtml(item.id) + (item.role ? " | " + escapeHtml(item.role) : "") + (item.kind === "slot" ? " | " + escapeHtml(item.slot || "") : "") + '</div></div>' +
      '<button type="button" class="item-toggle ' + (enabled ? "enabled" : "disabled") + '" title="Toggle item">' + (enabled ? "On" : "Off") + '</button>';
    row.onclick = (event) => {
      if (event.target?.classList?.contains("item-toggle")) return;
      selectedItemIndex = index;
      renderItemList();
      renderItemEditor();
    };
    row.querySelector(".item-toggle").onclick = (event) => {
      event.stopPropagation();
      item.enabled = item.enabled === false;
      selectedItemIndex = index;
      markDirty();
      renderItemList();
      renderItemEditor();
    };
    row.ondragstart = () => { dragIndex = index; row.classList.add("dragging"); };
    row.ondragend = () => { dragIndex = -1; row.classList.remove("dragging"); };
    row.ondragover = (event) => event.preventDefault();
    row.ondrop = (event) => {
      event.preventDefault();
      if (dragIndex === -1 || dragIndex === index) return;
      const moved = currentStack.items.splice(dragIndex, 1)[0];
      currentStack.items.splice(index, 0, moved);
      selectedItemIndex = index;
      markDirty();
      renderItemList();
      renderItemEditor();
    };
    list.appendChild(row);
  });
}

function renderItemEditor() {
  const editor = el("itemEditor");
  if (!currentStack || selectedItemIndex < 0 || !currentStack.items[selectedItemIndex]) {
    editor.innerHTML = '<div class="empty">No item selected.</div>';
    el("deleteItemBtn").disabled = true;
    return;
  }
  el("deleteItemBtn").disabled = false;
  const item = currentStack.items[selectedItemIndex];
  optionsText = JSON.stringify(item.options || {}, null, 2);
  optionsError = "";
  const slotSelect = '<select id="itemSlot">' + slotNames.map((slot) => '<option value="' + attr(slot) + '">' + escapeHtml(slot) + '</option>').join("") + '</select>';
  const roleSelect = '<select id="itemRole">' + roles.map((role) => '<option value="' + attr(role) + '">' + escapeHtml(role || "(none)") + '</option>').join("") + '</select>';
  const kindSelect = '<select id="itemKind"><option value="block">block</option><option value="slot">slot</option></select>';
  const topFields = '<div class="item-fields">' +
    field("Kind", kindSelect) +
    field("ID", '<input id="itemId" value="' + attr(item.id) + '">') +
    field("Name", '<input id="itemName" value="' + attr(item.name || "") + '">') +
    field("Role", roleSelect) +
    (item.kind === "slot" ? field("Slot", slotSelect) : "") +
    '</div>';
  const body = item.kind === "block"
    ? field("Content", '<textarea id="itemContent">' + escapeHtml(item.content || "") + '</textarea>', "content-field")
    : renderSlotOptionsEditor(item);
  editor.innerHTML = '<div class="item-form">' + topFields + '<div class="item-body">' + body + '</div></div>';

  el("itemKind").value = item.kind;
  el("itemRole").value = item.role || "";
  if (item.kind === "slot") el("itemSlot").value = item.slot || "chat-history";

  el("itemKind").onchange = (event) => {
    if (event.target.value === item.kind) return;
    const base = { id: item.id, name: item.name, enabled: item.enabled, role: item.role, tags: item.tags, source: item.source };
    currentStack.items[selectedItemIndex] = event.target.value === "slot"
      ? { ...base, kind: "slot", slot: "chat-history" }
      : { ...base, kind: "block", content: "" };
    markDirty();
    renderItemList();
    renderItemEditor();
  };
  el("itemId").oninput = (event) => { item.id = event.target.value; markDirty(); renderItemList(); };
  el("itemName").oninput = (event) => { setOptionalString(item, "name", event.target.value); markDirty(); };
  el("itemRole").onchange = (event) => { setOptionalString(item, "role", event.target.value); markDirty(); renderItemList(); };
  if (item.kind === "block") {
    el("itemContent").oninput = (event) => { item.content = event.target.value; markDirty(); };
  } else {
    el("itemSlot").onchange = (event) => { item.slot = event.target.value; markDirty(); renderItemList(); };
    bindSlotOptionsEditor(item);
  }
}

function renderSlotOptionsEditor(item) {
  const options = item.options || {};
  const jsonActive = slotOptionsMode === "json";
  const formButton = '<button id="slotOptionsFormBtn" type="button" class="' + (!jsonActive ? "active" : "") + '">Form</button>';
  const jsonButton = '<button id="slotOptionsJsonBtn" type="button" class="' + (jsonActive ? "active" : "") + '">JSON</button>';
  const body = jsonActive
    ? '<textarea id="itemOptions" class="json-options">' + escapeHtml(optionsText) + '</textarea>'
    : renderSlotOptionsForm(item, options);
  return '<div class="field wide slot-options"><label>Slot options</label><div class="segmented">' + formButton + jsonButton + '</div>' + body + '</div>';
}

function renderSlotOptionsForm(item, options) {
  const fields = [];
  if (item.slot === "chat-history") {
    fields.push(optionCheckbox("includeLastUserMessage", "Include last user message", options.includeLastUserMessage !== false));
  }
  if (item.slot === "variables") {
    fields.push(
      optionCheckbox("includeStatic", "Include static state", options.includeStatic !== false),
      optionCheckbox("includeSession", "Include session state", options.includeSession !== false),
      optionCheckbox("includeTurn", "Include turn state", options.includeTurn !== false),
      optionCheckbox("includeMetadata", "Include metadata", options.includeMetadata === true),
      optionSelect("format", "Format", options.format || "xml", ["xml", "json"]),
      optionText("includeScopes", "Include scopes", arrayToCsv(options.includeScopes)),
      optionText("includeNamespaces", "Include namespaces", arrayToCsv(options.includeNamespaces)),
      optionText("excludeNamespaces", "Exclude namespaces", arrayToCsv(options.excludeNamespaces)),
      optionNumber("maxValueChars", "Max value chars", options.maxValueChars ?? ""),
    );
  }
  if (fields.length === 0) {
    fields.push('<div class="wide option-note">This slot has no structured options yet. Use JSON mode for advanced settings.</div>');
  }
  fields.push('<div class="wide option-note">Unknown option keys are preserved. Use JSON mode for advanced settings.</div>');
  return '<div class="options-grid">' + fields.join("") + '</div>';
}

function bindSlotOptionsEditor(item) {
  el("slotOptionsFormBtn").onclick = () => {
    slotOptionsMode = "form";
    renderItemEditor();
  };
  el("slotOptionsJsonBtn").onclick = () => {
    slotOptionsMode = "json";
    renderItemEditor();
  };

  if (slotOptionsMode === "json") {
    el("itemOptions").oninput = (event) => {
      optionsText = event.target.value;
      try {
        const parsed = optionsText.trim() ? JSON.parse(optionsText) : {};
        item.options = Object.keys(parsed).length ? parsed : undefined;
        optionsError = "";
        markDirty();
      } catch (error) {
        optionsError = error.message;
        setStatus("Invalid item options JSON", "error");
      }
    };
    return;
  }

  document.querySelectorAll("[data-option]").forEach((control) => {
    control.onchange = (event) => {
      const target = event.target;
      const key = target.dataset.option;
      if (!key) return;
      if (target.type === "checkbox") {
        setSlotOption(item, key, target.checked, defaultSlotOptionValue(key));
      } else if (target.type === "number") {
        const value = target.value.trim();
        setSlotOption(item, key, value ? Number(value) : undefined);
      } else if (target.dataset.array === "true") {
        const values = target.value.split(",").map((part) => part.trim()).filter(Boolean);
        setSlotOption(item, key, values.length ? values : undefined);
      } else {
        setSlotOption(item, key, target.value || undefined);
      }
      markDirty();
    };
  });
}

function setSlotOption(item, key, value, defaultValue) {
  const options = { ...(item.options || {}) };
  if (value === undefined || value === defaultValue) delete options[key];
  else options[key] = value;
  item.options = Object.keys(options).length ? options : undefined;
}

function defaultSlotOptionValue(key) {
  if (["includeLastUserMessage", "includeStatic", "includeSession", "includeTurn"].includes(key)) return true;
  return undefined;
}

function optionCheckbox(key, label, checked) {
  return '<label class="checkline"><input type="checkbox" data-option="' + attr(key) + '" ' + (checked ? "checked" : "") + '> ' + escapeHtml(label) + '</label>';
}

function optionSelect(key, label, value, choices) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><select data-option="' + attr(key) + '">' +
    choices.map((choice) => '<option value="' + attr(choice) + '"' + (choice === value ? " selected" : "") + '>' + escapeHtml(choice) + '</option>').join("") +
    '</select></div>';
}

function optionText(key, label, value) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input data-option="' + attr(key) + '" data-array="true" value="' + attr(value) + '" placeholder="comma,separated"></div>';
}

function optionNumber(key, label, value) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input type="number" min="1" data-option="' + attr(key) + '" value="' + attr(value) + '"></div>';
}

function showStackModal(title, meta, body) {
  const pane = el("stackModal");
  pane.innerHTML = '<div class="modal-dialog" role="dialog" aria-modal="true" aria-label="' + attr(title) + '">' +
    '<div class="modal-head"><div><div class="modal-title">' + escapeHtml(title) + '</div><div class="modal-meta">' + escapeHtml(meta || "") + '</div></div>' +
    '<div class="modal-actions"><button data-modal-close="true">Close</button></div></div>' +
    '<div class="modal-body">' + body + '</div></div>';
  pane.classList.add("open");
}

function closeStackModal() {
  const pane = el("stackModal");
  pane.classList.remove("open");
  pane.innerHTML = "";
}

function openVariablesEditor() {
  if (!currentStack) return;
  const rows = Object.entries(currentStack.variables || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => variableRowHtml(name, value))
    .join("");
  showStackModal(
    "Stack variables",
    "Static string variables available to macros and variables slots.",
    '<div class="modal-toolbar"><button id="addVariableBtn">Add variable</button><span class="modal-spacer"></span><span class="modal-meta">Save writes these changes to the stack JSON.</span></div>' +
      '<div class="data-table" id="variablesRows">' +
      '<div class="data-row header variable-row"><div>Name</div><div>Value</div><div></div></div>' +
      rows +
      '</div>',
  );
  bindVariablesEditor();
}

function variableRowHtml(name = "", value = "") {
  return '<div class="data-row variable-row" data-var-row>' +
    '<input data-var-name value="' + attr(name) + '" placeholder="char">' +
    '<input data-var-value value="' + attr(value) + '" placeholder="泉此方">' +
    '<button type="button" class="danger" data-delete-row="true">Delete</button>' +
    '</div>';
}

function bindVariablesEditor() {
  el("addVariableBtn").onclick = () => {
    el("variablesRows").insertAdjacentHTML("beforeend", variableRowHtml(uniqueVariableName()));
    bindVariablesEditor();
    syncVariablesFromModal();
  };
  document.querySelectorAll("[data-var-row] input").forEach((input) => {
    input.oninput = () => syncVariablesFromModal();
  });
  document.querySelectorAll("[data-var-row] [data-delete-row]").forEach((button) => {
    button.onclick = (event) => {
      event.target.closest("[data-var-row]").remove();
      syncVariablesFromModal();
    };
  });
}

function uniqueVariableName() {
  const existing = new Set(Object.keys(currentStack?.variables || {}));
  let index = existing.size + 1;
  let name = "var" + index;
  while (existing.has(name)) name = "var" + (++index);
  return name;
}

function syncVariablesFromModal() {
  if (!currentStack) return;
  const variables = {};
  const seen = new Set();
  let duplicate = false;
  document.querySelectorAll("[data-var-row]").forEach((row) => {
    const name = row.querySelector("[data-var-name]").value.trim();
    const value = row.querySelector("[data-var-value]").value;
    if (!name) return;
    if (seen.has(name)) duplicate = true;
    seen.add(name);
    variables[name] = value;
  });
  if (Object.keys(variables).length) currentStack.variables = variables;
  else delete currentStack.variables;
  stackVariablesError = duplicate ? "Duplicate stack variable names." : "";
  markDirty();
  if (duplicate) setStatus(stackVariablesError, "error");
}

function openStateSchemaEditor() {
  if (!currentStack) return;
  const definitions = currentStack.state?.definitions || {};
  const rows = Object.entries(definitions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, definition]) => definitionRowHtml(name, definition))
    .join("");
  showStackModal(
    "State schema",
    "Definitions describe session state names, metadata, defaults, and write permissions.",
    '<div class="modal-toolbar"><button id="addDefinitionBtn">Add definition</button><span class="modal-spacer"></span><span class="modal-meta">Empty default means no default value.</span></div>' +
      '<div class="data-table" id="definitionRows">' +
      '<div class="data-row header definition-row"><div>Name</div><div>Type</div><div>Scope</div><div>Description</div><div>Default JSON</div><div>Agent write</div><div>User write</div><div></div></div>' +
      rows +
      '</div>',
  );
  bindStateSchemaEditor();
}

function definitionRowHtml(name = "", definition = {}) {
  return '<div class="data-row definition-row" data-definition-row>' +
    '<input data-definition-name value="' + attr(name) + '" placeholder="agent.progress">' +
    '<input data-definition-type value="' + attr(definition.type || "") + '" placeholder="string">' +
    '<select data-definition-scope>' + stateScopes.map((scope) => '<option value="' + attr(scope) + '"' + ((definition.scope || "") === scope ? " selected" : "") + '>' + escapeHtml(scope || "(default)") + '</option>').join("") + '</select>' +
    '<input data-definition-description value="' + attr(definition.description || "") + '" placeholder="Short description">' +
    '<textarea class="state-value" data-definition-default placeholder="optional default JSON">' + escapeHtml(definition.default === undefined ? "" : JSON.stringify(definition.default, null, 2)) + '</textarea>' +
    permissionSelect("data-definition-agent", definition.agentWritable) +
    permissionSelect("data-definition-user", definition.userWritable) +
    '<button type="button" class="danger" data-delete-row="true">Delete</button>' +
    '</div>';
}

function permissionSelect(attribute, value) {
  const current = value === true ? "true" : value === false ? "false" : "";
  return '<select ' + attribute + '>' +
    '<option value=""' + (current === "" ? " selected" : "") + '>default</option>' +
    '<option value="true"' + (current === "true" ? " selected" : "") + '>allowed</option>' +
    '<option value="false"' + (current === "false" ? " selected" : "") + '>blocked</option>' +
    '</select>';
}

function bindStateSchemaEditor() {
  el("addDefinitionBtn").onclick = () => {
    el("definitionRows").insertAdjacentHTML("beforeend", definitionRowHtml(uniqueDefinitionName()));
    bindStateSchemaEditor();
    syncStateDefinitionsFromModal();
  };
  document.querySelectorAll("[data-definition-row] input, [data-definition-row] textarea, [data-definition-row] select").forEach((control) => {
    control.oninput = () => syncStateDefinitionsFromModal();
    control.onchange = () => syncStateDefinitionsFromModal();
  });
  document.querySelectorAll("[data-definition-row] [data-delete-row]").forEach((button) => {
    button.onclick = (event) => {
      event.target.closest("[data-definition-row]").remove();
      syncStateDefinitionsFromModal();
    };
  });
}

function uniqueDefinitionName() {
  const existing = new Set(Object.keys(currentStack?.state?.definitions || {}));
  let index = existing.size + 1;
  let name = "agent.state" + index;
  while (existing.has(name)) name = "agent.state" + (++index);
  return name;
}

function syncStateDefinitionsFromModal() {
  if (!currentStack) return;
  const definitions = {};
  const seen = new Set();
  const errors = [];
  document.querySelectorAll("[data-definition-row]").forEach((row) => {
    const name = row.querySelector("[data-definition-name]").value.trim();
    if (!name) return;
    if (seen.has(name)) errors.push("Duplicate state definition: " + name);
    seen.add(name);
    const definition = {};
    setOptionalObjectString(definition, "type", row.querySelector("[data-definition-type]").value);
    setOptionalObjectString(definition, "scope", row.querySelector("[data-definition-scope]").value);
    setOptionalObjectString(definition, "description", row.querySelector("[data-definition-description]").value);
    const defaultText = row.querySelector("[data-definition-default]").value.trim();
    if (defaultText) {
      try {
        const parsed = JSON.parse(defaultText);
        if (!isJsonStateValue(parsed)) errors.push(name + ": default must be JSON-compatible.");
        else definition.default = parsed;
      } catch (error) {
        errors.push(name + ": invalid default JSON.");
      }
    }
    const agent = row.querySelector("[data-definition-agent]").value;
    if (agent === "true") definition.agentWritable = true;
    else if (agent === "false") definition.agentWritable = false;
    const user = row.querySelector("[data-definition-user]").value;
    if (user === "true") definition.userWritable = true;
    else if (user === "false") definition.userWritable = false;
    definitions[name] = definition;
  });

  if (Object.keys(definitions).length) {
    currentStack.state = { ...(currentStack.state || {}), schemaVersion: currentStack.state?.schemaVersion || 1, definitions };
  } else if (currentStack.state?.schemaVersion) {
    currentStack.state = { schemaVersion: currentStack.state.schemaVersion };
  } else {
    delete currentStack.state;
  }
  stackDefinitionsError = errors[0] || "";
  markDirty();
  if (stackDefinitionsError) setStatus(stackDefinitionsError, "error");
}

async function openSessionStateEditor() {
  const snapshot = await api("/api/state");
  renderSessionStateEditor(snapshot);
}

function renderSessionStateEditor(snapshot) {
  const names = [...new Set([...Object.keys(snapshot.session || {}), ...Object.keys(snapshot.definitions || {})])].sort((a, b) => a.localeCompare(b));
  const rows = names.map((name) => sessionRowHtml(name, snapshot.session?.[name], snapshot.definitions?.[name], Object.prototype.hasOwnProperty.call(snapshot.session || {}, name))).join("");
  showStackModal(
    "Session state",
    "Runtime state persisted in the current Pi session branch.",
    '<div class="modal-toolbar"><button id="addSessionStateBtn">Add state</button><button id="refreshSessionStateBtn">Refresh</button><span class="modal-spacer"></span><button id="clearAllSessionStateBtn" class="danger">Clear all</button></div>' +
      '<div class="data-table" id="sessionStateRows">' +
      '<div class="data-row header session-row"><div>Name</div><div>Value</div><div>Definition</div><div></div></div>' +
      rows +
      '</div>',
  );
  bindSessionStateEditor();
}

function sessionRowHtml(name = "", value = undefined, definition = undefined, isSet = false) {
  const details = definition
    ? [
      definition.type ? "type=" + definition.type : undefined,
      definition.scope ? "scope=" + definition.scope : undefined,
      definition.agentWritable !== undefined ? "agent=" + definition.agentWritable : undefined,
      definition.userWritable !== undefined ? "user=" + definition.userWritable : undefined,
      definition.description || undefined,
    ].filter(Boolean).join(" | ")
    : "(none)";
  return '<div class="data-row session-row" data-session-row>' +
    '<input data-session-name value="' + attr(name) + '" placeholder="agent.progress">' +
    '<textarea class="state-value" data-session-value placeholder="text or JSON">' + escapeHtml(isSet ? formatStateInput(value) : "") + '</textarea>' +
    '<div class="modal-meta">' + escapeHtml(details) + '</div>' +
    '<div class="row-actions"><button type="button" data-session-set="true">Set</button><button type="button" class="danger" data-session-clear="true">Clear</button></div>' +
    '</div>';
}

function bindSessionStateEditor() {
  el("addSessionStateBtn").onclick = () => {
    el("sessionStateRows").insertAdjacentHTML("beforeend", sessionRowHtml());
    bindSessionStateEditor();
  };
  el("refreshSessionStateBtn").onclick = () => run(openSessionStateEditor);
  el("clearAllSessionStateBtn").onclick = () => run(async () => {
    if (!confirm("Clear all session state?")) return;
    const snapshot = await api("/api/state", { method: "DELETE" });
    renderSessionStateEditor(snapshot);
    setStatus("Cleared all session state", "success");
  });
  document.querySelectorAll("[data-session-set]").forEach((button) => {
    button.onclick = (event) => run(() => setSessionStateFromRow(event.target.closest("[data-session-row]")));
  });
  document.querySelectorAll("[data-session-clear]").forEach((button) => {
    button.onclick = (event) => run(() => clearSessionStateFromRow(event.target.closest("[data-session-row]")));
  });
}

async function setSessionStateFromRow(row) {
  const name = row.querySelector("[data-session-name]").value.trim();
  if (!name) throw new Error("State name is required.");
  const value = parseStateInput(row.querySelector("[data-session-value]").value);
  const snapshot = await api("/api/state/" + encodeURIComponent(name), { method: "PUT", body: { value } });
  renderSessionStateEditor(snapshot);
  setStatus("Set session state " + name, "success");
}

async function clearSessionStateFromRow(row) {
  const name = row.querySelector("[data-session-name]").value.trim();
  if (!name) throw new Error("State name is required.");
  const snapshot = await api("/api/state/" + encodeURIComponent(name), { method: "DELETE" });
  renderSessionStateEditor(snapshot);
  setStatus("Cleared session state " + name, "success");
}

function parseStateInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|["[{])/.test(trimmed)) {
    return JSON.parse(trimmed);
  }
  return value;
}

function formatStateInput(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isJsonStateValue(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonStateValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonStateValue);
}

function setOptionalObjectString(target, key, value) {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}

function addItem(kind) {
  if (!currentStack) return;
  const idBase = kind === "slot" ? "slot" : "block";
  let index = currentStack.items.length + 1;
  let id = idBase + "-" + index;
  const existing = new Set(currentStack.items.map((item) => item.id));
  while (existing.has(id)) id = idBase + "-" + (++index);
  currentStack.items.push(kind === "slot"
    ? { kind: "slot", id, enabled: true, slot: "chat-history" }
    : { kind: "block", id, enabled: true, role: "user", content: "" });
  selectedItemIndex = currentStack.items.length - 1;
  markDirty();
  renderItemList();
  renderItemEditor();
}

function deleteSelectedItem() {
  if (!currentStack || selectedItemIndex < 0) return;
  const item = currentStack.items[selectedItemIndex];
  if (!confirm("Delete item " + item.id + "?")) return;
  currentStack.items.splice(selectedItemIndex, 1);
  selectedItemIndex = Math.min(selectedItemIndex, currentStack.items.length - 1);
  markDirty();
  renderItemList();
  renderItemEditor();
}

async function saveStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId), { method: "PUT", body: { stack } });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.id || stack.id;
  currentStack = structuredClone(stack);
  dirty = false;
  renderAll(data.stack?.diagnostics || []);
  setStatus("Saved " + selectedId, "success");
  await selectStack(selectedId, { keepDirty: true });
}

async function createStackRemote(stack, options = {}) {
  try {
    return await api("/api/stacks", { method: "POST", body: { stack, ...options } });
  } catch (error) {
    if (error.status === 409 && !options.overwrite && confirm((error.message || "Stack already exists.") + "\n\nOverwrite it?")) {
      return await api("/api/stacks", { method: "POST", body: { stack, ...options, overwrite: true } });
    }
    throw error;
  }
}

async function openImportedStack(stack, activate, actionLabel, extraOptions = {}) {
  const data = await createStackRemote(stack, { ...extraOptions, activate });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.id || stack.id;
  dirty = false;
  await selectStack(selectedId, { keepDirty: true });
  const converted = data.importFormat === "sillytavern" ? " from SillyTavern" : "";
  setStatus(actionLabel + converted + " " + selectedId, "success");
}

async function importStackJson() {
  el("importFileInput").value = "";
  el("importFileInput").click();
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const imported = JSON.parse(text);
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error("Imported JSON must be an object.");
  if (isSillyTavernImport(imported)) {
    const characterId = promptSillyTavernCharacterId(imported);
    if (characterId === null) return;
    const activate = confirm("Convert and activate imported SillyTavern stack now?");
    await openImportedStack(imported, activate, "Imported", { sourceName: file.name, characterId });
    return;
  }

  const stack = imported;
  if (!stack.id || typeof stack.id !== "string") {
    const promptedId = prompt("Stack id", sanitizeStackId(file.name.replace(/\.json$/i, "")));
    if (!promptedId) return;
    stack.id = promptedId.trim();
  }
  if (!Array.isArray(stack.items)) throw new Error("Imported stack must contain an items array.");
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  const activate = confirm("Activate imported stack now?");
  await openImportedStack(stack, activate, "Imported");
}

function isSillyTavernImport(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.prompts) && !Array.isArray(value.items);
}

function promptSillyTavernCharacterId(value) {
  const ids = Array.isArray(value.prompt_order)
    ? value.prompt_order
      .map((entry) => entry && entry.character_id)
      .filter((id) => Number.isInteger(id))
    : [];
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length <= 1) return undefined;
  const answer = prompt("SillyTavern character_id (" + uniqueIds.join(", ") + ")", String(uniqueIds[0]));
  if (answer === null) return null;
  const parsed = Number(answer.trim());
  if (!Number.isInteger(parsed) || !uniqueIds.includes(parsed)) {
    throw new Error("Choose one of these character_id values: " + uniqueIds.join(", "));
  }
  return parsed;
}

async function forkStack() {
  const source = stackForSubmit();
  const forkId = prompt("New fork stack id", uniqueForkId(source.id || "stack"));
  if (!forkId) return;
  const forkName = prompt("Fork display name", ((source.name || source.id || "Prompt stack") + " fork"));
  const fork = structuredClone(source);
  fork.id = forkId.trim();
  if (forkName && forkName.trim()) fork.name = forkName;
  fork.autoActivate = false;
  const activate = confirm("Activate fork now?");
  await openImportedStack(fork, activate, "Forked");
}

function exportStackJson() {
  const stack = stackForSubmit();
  const json = JSON.stringify(stack, null, 2) + "\n";
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeStackId(stack.id || "prompt-stack") + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported " + (stack.id || "prompt stack"), "success");
}

function uniqueForkId(baseId) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack) => stack.id));
  let candidate = base + "-fork";
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-fork-" + index++;
  return candidate;
}

function sanitizeStackId(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function validateStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/validate", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  hidePreview();
  setStatus("Validation complete", "success");
}

async function previewStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/preview", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  renderPreviewInspector(data);
  setStatus("Preview rendered", "success");
}

async function refreshPayloadCapture(options = {}) {
  const previousCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  const data = await api("/api/payload");
  payloadSnapshot = data;
  updatePayloadButton();
  const nextCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  if (options.open || (options.autoOpen && nextCapturedAt && nextCapturedAt !== previousCapturedAt)) {
    renderPayloadInspector(payloadSnapshot);
  }
}

async function armPayloadCapture(showInspector = false) {
  const data = await api("/api/payload/arm", { method: "POST" });
  payloadSnapshot = data;
  updatePayloadButton();
  setStatus("Payload capture armed; send the next Pi prompt");
  if (showInspector) renderPayloadInspector(payloadSnapshot);
}

async function clearPayloadCapture() {
  const data = await api("/api/payload", { method: "DELETE" });
  payloadSnapshot = data;
  updatePayloadButton();
  hidePreview();
  setStatus("Payload capture cleared", "success");
}

async function openPayloadCapture() {
  await refreshPayloadCapture();
  if (payloadSnapshot.status === "captured" || payloadSnapshot.status === "armed") {
    renderPayloadInspector(payloadSnapshot);
    return;
  }
  await armPayloadCapture();
}

function updatePayloadButton() {
  const button = el("payloadBtn");
  if (!button) return;
  button.classList.remove("primary");
  if (payloadSnapshot.status === "armed") {
    button.textContent = "Payload armed";
    button.classList.add("primary");
    button.title = "Waiting for the next provider payload";
    return;
  }
  if (payloadSnapshot.status === "captured") {
    button.textContent = "View payload";
    button.title = "Open the latest captured provider payload";
    return;
  }
  button.textContent = "Arm payload";
  button.title = "Capture the next provider payload in this editor";
}

function hidePreview() {
  const pane = el("preview");
  pane.classList.remove("open");
  pane.innerHTML = "";
  previewCopyTexts = [];
}

function renderPreviewInspector(data) {
  const pane = el("preview");
  const preview = data.preview;
  if (!preview) {
    previewCopyTexts = [data.text || ""];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
      '<div class="preview-head"><div><div class="preview-title">Preview</div><div class="preview-meta">Plain text fallback</div></div>' +
      '<div class="preview-actions"><button class="preview-copy" data-copy-index="0">Copy</button><button data-preview-close="true">Close</button></div></div>' +
      '<div class="preview-body"><pre class="preview-text">' + escapeHtml(data.text || "") + '</pre></div></div>';
    pane.classList.add("open");
    return;
  }

  const sections = [preview.system, ...(preview.messages || [])];
  previewCopyTexts = [data.text || "", ...sections.map((section) => section.content || "")];
  const sectionHtml = sections.map((section, index) => {
    const open = index === 0 ? " open" : "";
    const label = section.role ? section.role + " · " : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title || section.id) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(label + formatCount(section.chars) + " chars · ~" + formatCount(section.approxTokens) + " tokens") + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" onclick="event.preventDefault()">Copy</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");

  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
    '<div class="preview-head"><div><div class="preview-title">Prompt preview: ' + escapeHtml(preview.stackId || selectedId) + '</div>' +
    '<div class="preview-meta">' + escapeHtml(formatCount(preview.totalChars) + " chars · ~" + formatCount(preview.approxTokens) + " tokens · " + (preview.messages || []).length + " messages") + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0">Copy full</button><button data-preview-close="true">Close</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function renderPayloadInspector(snapshot) {
  const pane = el("preview");
  if (snapshot.status === "idle") {
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
      '<div class="preview-head"><div><div class="preview-title">Provider payload</div><div class="preview-meta">No payload captured.</div></div>' +
      '<div class="preview-actions"><button data-payload-arm="true">Arm next</button><button data-preview-close="true">Close</button></div></div>' +
      '<div class="preview-body"><div class="empty">Arm capture, then send the next prompt in Pi. The provider payload will appear here before it is sent.</div></div></div>';
    pane.classList.add("open");
    return;
  }

  if (snapshot.status === "armed") {
    const meta = snapshot.armedAt ? "Armed at " + snapshot.armedAt : "Waiting for next provider request";
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
      '<div class="preview-head"><div><div class="preview-title">Payload capture armed</div><div class="preview-meta">' + escapeHtml(meta) + '</div></div>' +
      '<div class="preview-actions"><button class="danger" data-payload-clear="true">Clear</button><button data-preview-close="true">Close</button></div></div>' +
      '<div class="preview-body"><div class="empty">Send the next prompt in Pi. The exact provider payload will be captured here and redacted before display.</div></div></div>';
    pane.classList.add("open");
    return;
  }

  const capture = snapshot.capture || {};
  const sections = payloadSections(capture);
  previewCopyTexts = [capture.text || "", ...sections.map((section) => section.content || "")];
  const sectionHtml = sections.map((section, index) => {
    const open = index === 0 ? " open" : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(section.meta) + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" onclick="event.preventDefault()">Copy</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");
  const metaParts = [
    formatCount(capture.chars) + " chars",
    "~" + formatCount(capture.approxTokens) + " tokens",
    capture.stackId ? "stack " + capture.stackId : undefined,
    capture.truncated ? "truncated" : undefined,
  ].filter(Boolean);
  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
    '<div class="preview-head"><div><div class="preview-title">Provider payload</div>' +
    '<div class="preview-meta">' + escapeHtml(metaParts.join(" · ") + (capture.capturedAt ? " · " + capture.capturedAt : "")) + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0">Copy full</button><button data-payload-arm="true">Arm again</button><button class="danger" data-payload-clear="true">Clear</button><button data-preview-close="true">Close</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function payloadSections(capture) {
  const value = capture.payload;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((item, index) => payloadSection(String(index), item));
    }
    const entries = Object.entries(value);
    if (entries.length) return entries.map(([key, item]) => payloadSection(key, item));
  }
  return [{
    title: capture.error ? "Stringify error" : capture.truncated ? "Raw truncated payload" : "Raw payload",
    meta: formatCount((capture.text || "").length) + " chars",
    content: capture.text || "",
  }];
}

function payloadSection(title, value) {
  const rendered = JSON.stringify(value, null, 2);
  const content = rendered === undefined ? String(value) : rendered;
  const meta = describePayloadValue(value) + " · " + formatCount(content.length) + " chars";
  return { title, meta, content };
}

function describePayloadValue(value) {
  if (Array.isArray(value)) return "array[" + value.length + "]";
  if (value && typeof value === "object") return "object{" + Object.keys(value).length + "}";
  if (value === null) return "null";
  return typeof value;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

async function copyPreviewText(index) {
  const text = previewCopyTexts[index] || "";
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  setStatus("Copied text", "success");
}

async function activateStack() {
  if (!currentStack) return;
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/activate", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Activated " + selectedId, "success");
}

async function disableStacks() {
  const data = await api("/api/disable", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Prompt stack disabled", "success");
}

async function deleteCurrentStack() {
  if (!currentStack) return;
  const id = selectedId;
  const message = "Delete prompt stack '" + id + "'?\n\nThis removes its JSON file from .pi/prompt-stacks.";
  if (!confirm(message)) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id), { method: "DELETE" });
  stacks = data.stacks || [];
  dirty = false;
  const next = stacks.find((stack) => stack.active) || stacks[0];
  if (next) {
    await selectStack(next.id, { keepDirty: true });
    setStatus("Deleted " + id, "success");
  } else {
    renderStackList();
    renderEmpty();
    setStatus("Deleted " + id + "; no stacks remain", "success");
  }
}

async function reloadFromDisk() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/reload", { method: "POST" });
  stacks = data.stacks || [];
  renderStackList();
  await loadStacks(selectedId);
  setStatus("Reloaded from disk", "success");
}

function stackForSubmit() {
  if (!currentStack) throw new Error("No stack selected.");
  if (optionsError) throw new Error("Invalid item options JSON: " + optionsError);
  if (stackVariablesError) throw new Error(stackVariablesError);
  if (stackDefinitionsError) throw new Error(stackDefinitionsError);
  const clone = structuredClone(currentStack);
  if (!clone.type) clone.type = "pi-forge.prompt-stack";
  if (!clone.schemaVersion) clone.schemaVersion = 1;
  return clone;
}

function renderDiagnostics(diagnostics) {
  const pane = el("diagnostics");
  if (!diagnostics.length) {
    pane.innerHTML = '<div class="diagnostic info">No diagnostics.</div>';
    return;
  }
  pane.innerHTML = diagnostics.map((diag) => {
    const level = diag.level || "info";
    const item = diag.itemId ? " [" + escapeHtml(diag.itemId) + "]" : "";
    return '<div class="diagnostic ' + attr(level) + '"><strong>' + escapeHtml(level.toUpperCase()) + item + '</strong>: ' + escapeHtml(diag.message || "") + '</div>';
  }).join("");
}

function renderEmpty() {
  currentStack = null;
  selectedId = "";
  el("settings").innerHTML = "";
  el("itemList").innerHTML = "";
  el("itemEditor").innerHTML = '<div class="empty">No prompt stacks found.</div>';
  renderDiagnostics([]);
  setStatus("No prompt stacks found");
}

function field(label, control, className = "") {
  return '<div class="field ' + className + '"><label>' + escapeHtml(label) + '</label>' + control + '</div>';
}

function displayItemName(item) {
  if (item.name) return item.name;
  if (item.source && typeof item.source.previousName === "string" && item.source.previousName.trim()) return item.source.previousName;
  if (item.kind === "slot" && item.slot) return item.slot;
  if (item.kind === "block" && item.content) {
    const firstLine = item.content.trim().split(/\n/)[0]?.trim();
    if (firstLine) return firstLine.length > 46 ? firstLine.slice(0, 43) + "..." : firstLine;
  }
  return item.id || "(unnamed)";
}

function arrayToCsv(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function setOptionalString(target, key, value) {
  const trimmed = value.trim();
  if (trimmed) target[key] = value;
  else delete target[key];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function attr(value) {
  return escapeHtml(value);
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  el("shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
  el("sidebarToggleBtn").title = sidebarCollapsed ? "Show prompt stacks sidebar" : "Hide prompt stacks sidebar";
  setStatus(sidebarCollapsed ? "Prompt stacks sidebar hidden" : "Prompt stacks sidebar shown");
}

el("sidebarToggleBtn").onclick = toggleSidebar;
el("reloadBtn").onclick = () => run(reloadFromDisk);
el("disableBtn").onclick = () => run(disableStacks);
el("activateBtn").onclick = () => run(activateStack);
el("saveBtn").onclick = () => run(saveStack);
el("validateBtn").onclick = () => run(validateStack);
el("previewBtn").onclick = () => run(previewStack);
el("payloadBtn").onclick = () => run(openPayloadCapture);
el("variablesBtn").onclick = openVariablesEditor;
el("stateSchemaBtn").onclick = openStateSchemaEditor;
el("sessionStateBtn").onclick = () => run(openSessionStateEditor);
el("forkBtn").onclick = () => run(forkStack);
el("importBtn").onclick = () => run(importStackJson);
el("exportBtn").onclick = () => run(exportStackJson);
el("importFileInput").onchange = (event) => run(() => handleImportFile(event));
el("deleteStackBtn").onclick = () => run(deleteCurrentStack);
el("stackModal").onclick = (event) => {
  if (event.target === el("stackModal") || event.target.closest?.("[data-modal-close]")) {
    closeStackModal();
  }
};
el("preview").onclick = (event) => {
  if (event.target === el("preview") || event.target.closest?.("[data-preview-close]")) {
    hidePreview();
    return;
  }
  if (event.target.closest?.("[data-payload-arm]")) {
    event.preventDefault();
    event.stopPropagation();
    run(() => armPayloadCapture(true));
    return;
  }
  if (event.target.closest?.("[data-payload-clear]")) {
    event.preventDefault();
    event.stopPropagation();
    run(clearPayloadCapture);
    return;
  }
  const button = event.target.closest?.("[data-copy-index]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  run(() => copyPreviewText(Number(button.dataset.copyIndex)));
};
el("addBlockBtn").onclick = () => addItem("block");
el("addSlotBtn").onclick = () => addItem("slot");
el("deleteItemBtn").onclick = deleteSelectedItem;
window.onbeforeunload = () => dirty ? "Unsaved changes" : undefined;
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (el("preview").classList.contains("open")) hidePreview();
  else if (el("stackModal").classList.contains("open")) closeStackModal();
});

run(async () => {
  await loadStacks();
  await refreshPayloadCapture();
  setInterval(() => run(() => refreshPayloadCapture({ autoOpen: true })), 2000);
});
</script>
</body>
</html>`;
}
