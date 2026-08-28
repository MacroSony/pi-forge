import assert from "node:assert/strict";
import test from "node:test";

import { startWebEditorServer, type WebEditorHost, type WebEditorLocale, type WebEditorServer } from "../src/web-editor/index.ts";

function hostWithLocale(initial: WebEditorLocale = "auto"): WebEditorHost & { written: WebEditorLocale[] } {
	const written: WebEditorLocale[] = [];
	let current = initial;
	return {
		written,
		getEditorConfig: () => ({ locale: current }),
		setEditorLocale: (locale: WebEditorLocale) => {
			written.push(locale);
			current = locale;
			return { ok: true as const, locale };
		},
	} as unknown as WebEditorHost & { written: WebEditorLocale[] };
}

async function withServer(host: WebEditorHost, run: (server: WebEditorServer) => Promise<void>): Promise<void> {
	const server = await startWebEditorServer(host, { port: 0 });
	try {
		await run(server);
	} finally {
		await server.close();
	}
}

test("GET /api/editor-config returns the configured locale", async () => {
	await withServer(hostWithLocale("zh-CN"), async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const response = await fetch(new URL("/api/editor-config", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { locale: "zh-CN" });
	});
});

test("PUT /api/editor-config validates and persists the locale", async () => {
	const host = hostWithLocale();
	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;

		const bad = await fetch(new URL("/api/editor-config", server.url), {
			method: "PUT",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify({ locale: "fr" }),
		});
		assert.equal(bad.status, 400);
		assert.deepEqual(host.written, []);

		const ok = await fetch(new URL("/api/editor-config", server.url), {
			method: "PUT",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify({ locale: "zh-CN" }),
		});
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { locale: "zh-CN" });
		assert.deepEqual(host.written, ["zh-CN"]);

		const after = await fetch(new URL("/api/editor-config", server.url), {
			headers: { "x-pi-forge-token": token },
		});
		assert.deepEqual(await after.json(), { locale: "zh-CN" });
	});
});

test("PUT /api/editor-config surfaces host write failures", async () => {
	const host = {
		getEditorConfig: () => ({ locale: "auto" }),
		setEditorLocale: () => ({ ok: false as const, status: 403, error: "Project is not trusted." }),
	} as unknown as WebEditorHost;
	await withServer(host, async (server) => {
		const token = new URL(server.url).searchParams.get("token")!;
		const response = await fetch(new URL("/api/editor-config", server.url), {
			method: "PUT",
			headers: { "x-pi-forge-token": token, "content-type": "application/json" },
			body: JSON.stringify({ locale: "zh-CN" }),
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "Project is not trusted." });
	});
});

test("editor page lang follows the configured locale or Accept-Language", async () => {
	const cases: Array<{ locale: WebEditorLocale; acceptLanguage?: string; expected: string }> = [
		{ locale: "zh-CN", expected: "zh-CN" },
		{ locale: "en", acceptLanguage: "zh-CN,zh;q=0.9", expected: "en" },
		{ locale: "auto", acceptLanguage: "zh-CN,zh;q=0.9", expected: "zh-CN" },
		{ locale: "auto", acceptLanguage: "en-US,en;q=0.9", expected: "en" },
		{ locale: "auto", acceptLanguage: "en-US,en;q=0.9,zh-CN;q=0.8", expected: "en" },
		{ locale: "auto", acceptLanguage: "zh-CN;q=0.4,en-US;q=0.9", expected: "en" },
		{ locale: "auto", acceptLanguage: "zh-CN;q=.4,en-US;q=.9", expected: "en" },
		{ locale: "auto", acceptLanguage: "zh-CN;q=0,en-US;q=0.5", expected: "en" },
		{ locale: "auto", acceptLanguage: "zh-CN;q=invalid,en-US;q=.5", expected: "en" },
		{ locale: "auto", acceptLanguage: "fr-FR,zh-CN;q=0.7,en;q=0.6", expected: "zh-CN" },
		{ locale: "auto", expected: "en" },
	];
	for (const { locale, acceptLanguage, expected } of cases) {
		await withServer(hostWithLocale(locale), async (server) => {
			const response = await fetch(server.url, {
				headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
			});
			assert.equal(response.status, 200);
			const html = await response.text();
			assert.match(html, new RegExp(`<html lang="${expected}">`));
		});
	}
});

test("editor page and /api/editor-config require the editor token", async () => {
	await withServer(hostWithLocale(), async (server) => {
		const base = server.url.split("?")[0]!;
		const page = await fetch(base);
		assert.equal(page.status, 403);
		const api = await fetch(new URL("/api/editor-config", base));
		assert.equal(api.status, 403);
	});
});
