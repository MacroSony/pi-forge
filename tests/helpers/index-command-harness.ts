import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import piForge from "../../src/index.ts";
import { legacyPromptStacksDir, promptStacksDir } from "../../src/loader.ts";
import { forgeExtensionsDir, globalForgeExtensionsDir } from "../../src/storage.ts";

export function writeStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), name), JSON.stringify(value, null, 2));
}

export function writeLegacyStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(legacyPromptStacksDir(cwd), { recursive: true });
	writeFileSync(join(legacyPromptStacksDir(cwd), name), JSON.stringify(value, null, 2));
}

export function writePreset(cwd: string, name: string, value: unknown): string {
	const dir = join(cwd, "st");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value, null, 2));
	return path;
}

export async function getFreePort(): Promise<number> {
	const blocker = await bindAvailablePort();
	await blocker.close();
	return blocker.port;
}

export async function bindAvailablePort(): Promise<{ port: number; close(): Promise<void> }> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		port: address.port,
		close: () => closeNetServer(server),
	};
}

function closeNetServer(server: NetServer): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function writeForgeConfig(cwd: string, value: unknown): void {
	const dir = join(cwd, ".pi", "forge");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(value, null, 2));
}

export function writeForgeExtension(cwd: string, name: string, content: string): string {
	const dir = forgeExtensionsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

export function writeGlobalForgeExtension(name: string, content: string): string {
	const dir = globalForgeExtensionsDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

export function latestEditorUrl(editors: { title: string; text: string }[]): URL {
	const editorText = editors.at(-1)?.text ?? "";
	const urlMatch = editorText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
	assert.ok(urlMatch);
	return new URL(urlMatch[0]);
}

export function createHarness() {
	const events: Record<string, Function> = {};
	const commands: Record<string, { handler: Function; getArgumentCompletions?: Function }> = {};
	const tools: Record<string, any> = {};
	const appended: { type: string; data: unknown }[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const allTools = new Set(activeTools);

	const pi = {
		on(name: string, handler: Function) {
			events[name] = handler;
		},
		registerCommand(name: string, options: { handler: Function; getArgumentCompletions?: Function }) {
			commands[name] = options;
		},
		registerTool(tool: { name: string; execute?: Function }) {
			tools[tool.name] = tool;
			allTools.add(tool.name);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		getAllTools() {
			return [...allTools].map((name) => tools[name] ? { name, ...tools[name] } : { name });
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	};

	piForge(pi as any);
	return {
		events,
		commands,
		tools,
		appended,
		getActiveTools: () => [...activeTools],
	};
}

export function createContext(cwd: string, entries: unknown[] = [], options: { trusted?: boolean; leafId?: string | null } = {}) {
	const notifications: { message: string; type?: string }[] = [];
	const statuses: Record<string, string | undefined> = {};
	const editors: { title: string; text: string }[] = [];
	let confirmResult = false;
	let leafId = options.leafId;

	function getBranch(fromId?: string): unknown[] {
		const startId = fromId ?? leafId;
		if (startId === null) return [];
		if (startId === undefined) return entries;
		const byId = new Map(entries.map((entry) => [(entry as { id?: unknown }).id, entry]));
		const path: unknown[] = [];
		let current = byId.get(startId);
		while (current) {
			path.unshift(current);
			const parentId = (current as { parentId?: unknown }).parentId;
			current = typeof parentId === "string" ? byId.get(parentId) : undefined;
		}
		return path;
	}

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		signal: undefined,
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => leafId,
			getBranch,
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => {
				statuses[key] = text;
			},
			editor: async (title: string, text = "") => {
				editors.push({ title, text });
				return text;
			},
			confirm: async () => confirmResult,
		},
		isProjectTrusted: () => options.trusted ?? true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "base system",
		getSystemPromptOptions: () => ({ cwd, selectedTools: [], toolSnippets: {}, promptGuidelines: [], contextFiles: [], skills: [] }),
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
	};

	return {
		ctx: ctx as any,
		notifications,
		statuses,
		editors,
		setConfirmResult(value: boolean) {
			confirmResult = value;
		},
		setLeafId(value: string | null | undefined) {
			leafId = value;
		},
	};
}

export async function startSession(harness: ReturnType<typeof createHarness>, ctx: any): Promise<void> {
	await harness.events.session_start?.({ type: "session_start", reason: "startup" }, ctx);
}
