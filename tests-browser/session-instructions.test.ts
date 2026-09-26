import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "playwright-core";
import { build } from "vite";
import type { InstructionStateView } from "../src/instruction-state.ts";

function findChromeExecutable(): string | undefined {
	const candidates = [
		process.env.CHROME_PATH,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
		process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find(existsSync);
}

async function bundleSessionInstructions(root: string): Promise<{ js: string; css: string }> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-forge-browser-fixture-"));
	const entryPath = join(tempDir, "entry.ts");
	const componentPath = resolve(root, "src/web-editor/client/components/SessionInstructions.vue");

	writeFileSync(
		entryPath,
		`import { createApp } from "vue";\nimport SessionInstructions from "${componentPath}";\ncreateApp(SessionInstructions).mount("#app");\n`,
	);

	try {
		const result = await build({
			root,
			configFile: false,
			publicDir: false,
			logLevel: "silent",
			// Controls/guard fixture; the real inspector is exercised by the built-App tests.
			plugins: [{ name: "isolated-session-inspector", enforce: "pre", load(id) {
				if (id === resolve(root, "src/web-editor/client/components/ContextDiffPanel.vue")) return '<template><div data-inspector-stub /></template>';
			} }, vue()],
			define: {
				"process.env.NODE_ENV": JSON.stringify("production"),
				__VUE_OPTIONS_API__: "false",
				__VUE_PROD_DEVTOOLS__: "false",
				__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
			},
			build: {
				write: false,
				target: "es2022",
				minify: false,
				lib: {
					entry: entryPath,
					name: "SessionInstructionsFixture",
					formats: ["iife"],
					fileName: () => "bundle.js",
					cssFileName: "bundle",
				},
			},
		});

		const results = Array.isArray(result) ? result : [result];
		const outputs = results.flatMap((r) => {
			if ("output" in r) {
				return r.output;
			}
			return [];
		});
		const jsChunk = outputs.find((o) => o.type === "chunk");
		const cssAsset = outputs.find((o) => o.type === "asset" && o.fileName.endsWith(".css"));

		assert.ok(jsChunk, "Vite must produce an IIFE chunk");
		return {
			js: jsChunk.code,
			css: cssAsset?.type === "asset" && typeof cssAsset.source === "string" ? cssAsset.source : "",
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function createInitialState(): InstructionStateView {
	return {
		guard: {
			sessionId: "sess-alpha-998877665544",
			leafId: "leaf-beta-112233445566",
			revision: "rev-001-opaque",
		},
		trusted: true,
		restoring: false,
		delivery: "prepared",
		textPresentation: "native",
		effectiveTools: ["read", "write", "guard_scan", "lint"],
		active: [
			{
				activationId: "act-sec-1",
				source: "preset:security",
				name: "Security Policy",
				actor: "user",
				content: "Never output confidential credentials or keys.",
				tools: {
					add: ["guard_scan"],
					remove: ["bash"],
				},
			},
			{
				activationId: "act-rev-2",
				source: "prompt:review",
				name: "Review Mode",
				actor: "agent",
				content: "Perform thorough pull-request code reviews.",
				tools: {
					add: ["lint"],
					remove: [],
				},
			},
		],
	};
}

test("session instructions panel in real browser: render, off guard, 409 conflict, and stale safety", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	let currentState: InstructionStateView | null = createInitialState();
	let shouldFailGet = false;
	let shouldConflictPost = false;
	const postMutationsReceived: any[] = [];
	let getCount = 0;

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --pane: #ffffff;
  --pane-soft: #fbfcfe;
  --line: #e2e8f0;
  --text: #0f172a;
  --muted: #64748b;
  --accent: #2563eb;
  --error: #ef4444;
}
${css}
</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`);
			return;
		}

		if (url.pathname === "/api/instructions") {
			if (req.method === "GET") {
				getCount++;
				if (shouldFailGet) {
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Instruction runtime unavailable (503)" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
				return;
			}

			if (req.method === "POST") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					const parsed = JSON.parse(body);
					postMutationsReceived.push(parsed);

					if (shouldConflictPost) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Revision mismatch (HTTP 409)" }));
						return;
					}

					if (parsed.action === "off") {
						if (currentState) {
							currentState = {
								...currentState,
								guard: {
									...currentState.guard,
									revision: "rev-002-opaque",
								},
								active: currentState.active.filter((a) => a.activationId !== parsed.activationId),
							};
						}
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, state: currentState }));
						return;
					}

					if (parsed.action === "reset") {
						if (currentState) {
							currentState = {
								...currentState,
								guard: {
									...currentState.guard,
									revision: "rev-003-opaque",
								},
								active: [],
							};
						}
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, state: currentState }));
						return;
					}

					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Unknown mutation" }));
				});
				return;
			}
		}

		res.writeHead(404);
		res.end("Not found");
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-token-instructions`;

	let browser: Browser | undefined;
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];

	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(6_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});

		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// --- 1. RENDER MULTI-MODES & INITIAL STATE ---
		await page.locator("[data-instructions-body]").waitFor();

		// Check session summary badges
		const activeBadge = page.locator("[data-instructions-active-badge]");
		await activeBadge.waitFor();
		assert.equal(await activeBadge.textContent(), "2 active");

		const deliveryBadge = page.locator("[data-instructions-delivery-badge]");
		assert.equal(await deliveryBadge.textContent(), "prepared");

		// Controls remain beside the inspector
		const body = page.locator("[data-instructions-body]");
		await body.waitFor();
		assert.equal(await body.isVisible(), true);

		// Expand technical diagnostics
		await page.locator(".instructions-diagnostics summary").click();

		// Check short IDs
		const sessionElem = page.locator("[data-instructions-session-id]");
		assert.equal(await sessionElem.textContent(), "sess-alp");
		assert.equal(await sessionElem.getAttribute("title"), "sess-alpha-998877665544");

		const branchElem = page.locator("[data-instructions-branch-id]");
		assert.equal(await branchElem.textContent(), "leaf-bet");
		assert.equal(await branchElem.getAttribute("title"), "leaf-beta-112233445566");

		const revisionElem = page.locator("[data-instructions-revision]");
		assert.equal(await revisionElem.textContent(), "rev-001-");

		// Check presentation and tools
		const presentationElem = page.locator("[data-instructions-presentation]");
		assert.equal(await presentationElem.textContent(), "Native system sections");

		const toolTags = page.locator("[data-instructions-tool-tag]");
		assert.equal(await toolTags.count(), 4);
		assert.deepEqual(await toolTags.allTextContents(), ["read", "write", "guard_scan", "lint"]);

		// Check delivery note explicitly clarifies 'prepared' is not model compliance confirmation
		const preparedNotice = page.locator("[data-instructions-prepared-notice]");
		assert.equal(await preparedNotice.isVisible(), true);
		assert.match(await preparedNotice.textContent() || "", /not a confirmation of model compliance/i);

		// Check multi active modes
		const itemCards = page.locator(".active-item-card");
		assert.equal(await itemCards.count(), 2);

		// Item 1: Security Policy
		const item1 = itemCards.nth(0);
		assert.equal(await item1.locator("[data-item-name]").textContent(), "Security Policy");
		assert.equal(await item1.locator("[data-item-source]").textContent(), "preset:security");
		assert.equal(await item1.locator("[data-item-actor]").textContent(), "User");
		assert.equal(await item1.locator("[data-item-tools-add]").textContent(), "+ guard_scan");
		assert.equal(await item1.locator("[data-item-tools-remove]").textContent(), "- bash");

		// Expand content details on Item 1
		await item1.locator("[data-item-content-summary]").click();
		const item1Content = item1.locator("[data-item-content-text]");
		assert.equal(await item1Content.textContent(), "Never output confidential credentials or keys.");

		// Item 2: Review Mode
		const item2 = itemCards.nth(1);
		assert.equal(await item2.locator("[data-item-name]").textContent(), "Review Mode");
		assert.equal(await item2.locator("[data-item-source]").textContent(), "prompt:review");
		assert.equal(await item2.locator("[data-item-actor]").textContent(), "Agent");
		assert.equal(await item2.locator("[data-item-tools-add]").textContent(), "+ lint");

		// --- 2. OFF GUARD: DEACTIVATE ACTION SENDS CURRENT GUARD ---
		postMutationsReceived.length = 0;
		const deactivateBtn1 = item1.locator("[data-item-deactivate-btn]");
		await deactivateBtn1.click();

		// Wait for Item 1 to disappear from UI
		await page.locator('.active-item-card[data-activation-id="act-sec-1"]').waitFor({ state: "detached" });
		assert.equal(postMutationsReceived.length, 1);
		assert.deepEqual(postMutationsReceived[0], {
			action: "off",
			activationId: "act-sec-1",
			guard: {
				sessionId: "sess-alpha-998877665544",
				leafId: "leaf-beta-112233445566",
				revision: "rev-001-opaque",
			},
		});

		// UI updated with revision rev-002 and count 1
		assert.equal(await activeBadge.textContent(), "1 active");
		assert.equal(await page.locator(".active-item-card").count(), 1);
		assert.equal(await revisionElem.textContent(), "rev-002-");

		// --- 3. 409 CONFLICT: SHOWS ERROR, REFRESHES, NEVER AUTO-RETRIES ---
		shouldConflictPost = true;
		postMutationsReceived.length = 0;
		const remainingItem = page.locator(".active-item-card").nth(0);
		const deactivateBtn2 = remainingItem.locator("[data-item-deactivate-btn]");

		const preConflictGetCount = getCount;
		await deactivateBtn2.click();

		// Error banner should appear with 409 message
		const errorBanner = page.locator("[data-instructions-error-banner]");
		await errorBanner.waitFor();
		assert.match(await errorBanner.textContent() || "", /Revision mismatch/);

		// Exactly 1 POST was sent - NO auto-retry!
		assert.equal(postMutationsReceived.length, 1);
		assert.equal(postMutationsReceived[0].activationId, "act-rev-2");

		// Wait a bit to ensure no second POST arrives
		await page.waitForTimeout(300);
		assert.equal(postMutationsReceived.length, 1, "Action must NOT be automatically retried after 409");

		// A refresh GET was triggered
		assert.ok(getCount > preConflictGetCount, "A refresh GET must be triggered on 409");

		// 409 recovery: after conflict and refresh, buttons must NOT be permanently locked
		assert.equal(await deactivateBtn2.isDisabled(), false, "Buttons must be re-enabled after 409 conflict and refresh");

		shouldConflictPost = false;

		// --- 4. POLLING UPDATE & STALE ERROR SAFETY ---
		// External update on server: reset active modes
		currentState = {
			...currentState!,
			active: [],
			guard: {
				...currentState!.guard,
				revision: "rev-004-poll",
			},
		};

		// Manual refresh button triggers update
		const refreshBtn = page.locator("[data-instructions-refresh]");
		await refreshBtn.click();
		await page.locator("[data-instructions-empty]").waitFor();
		assert.equal(await activeBadge.textContent(), "0 active");

		// Now simulate GET failure (503) -> State becomes stale and disables mutations
		shouldFailGet = true;
		await refreshBtn.click();

		const staleBanner = page.locator("[data-instructions-stale-banner]");
		await staleBanner.waitFor();
		assert.equal(await page.locator("[data-instructions-stale-badge]").isVisible(), true);

		// Verify that all modification buttons are disabled while stale
		const resetBtn = page.locator("[data-instructions-reset-btn]");
		assert.equal(await resetBtn.isDisabled(), true);

		// Deactivate buttons (if any) would also be disabled
		assert.equal(await page.locator("[data-item-deactivate-btn]").count(), 0);

		// Confirm no unhandled JavaScript page errors occurred during the entire test
		assert.deepEqual(pageErrors, []);
		// Confirm expected HTTP errors were logged during 409 conflict and 503 failure
		const unexpectedErrors = consoleErrors.filter(
			(text) => !text.includes("409 (Conflict)") && !text.includes("503 (Service Unavailable)") && !text.includes("favicon"),
		);
		assert.deepEqual(unexpectedErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("session instructions panel handles untrusted and problem states safely", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	const state: InstructionStateView = {
		guard: {
			sessionId: "sess-untrusted-1",
			leafId: null,
			revision: "rev-untrusted",
		},
		trusted: false,
		restoring: false,
		delivery: "none",
		textPresentation: "user",
		effectiveTools: [],
		problem: "Branch history diverges",
		active: [
			{
				activationId: "act-untrusted-item",
				source: "project",
				name: "Untrusted Item",
				actor: "user",
				content: "Draft item.",
				tools: { add: [], remove: [] },
			},
		],
	};

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}
		if (url.pathname === "/api/instructions") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, state }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-untrusted`;

	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// Controls remain beside the inspector
		await page.locator("[data-instructions-body]").waitFor();

		// Verify problem banner is displayed
		const problemBanner = page.locator("[data-instructions-problem-banner]");
		await problemBanner.waitFor();
		assert.match(await problemBanner.textContent() || "", /Branch history diverges/);

		// Verify untrusted banner with CLI hint is displayed
		const untrustedBanner = page.locator("[data-instructions-untrusted-banner]");
		await untrustedBanner.waitFor();
		assert.match(await untrustedBanner.textContent() || "", /\/instruction reset/);

		// Verify modification operations are disabled
		const deactivateBtn = page.locator("[data-item-deactivate-btn]");
		assert.equal(await deactivateBtn.isDisabled(), true);

		const resetBtn = page.locator("[data-instructions-reset-btn]");
		assert.equal(await resetBtn.isDisabled(), true);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("session instructions panel confirms reset all with guard without auto-starting models", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	let currentState: InstructionStateView | null = createInitialState();
	const mutationsReceived: any[] = [];

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}
		if (url.pathname === "/api/instructions") {
			if (req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
				return;
			}
			if (req.method === "POST") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					const parsed = JSON.parse(body);
					mutationsReceived.push(parsed);
					if (parsed.action === "reset") {
						currentState = {
							...currentState!,
							guard: {
								...currentState!.guard,
								revision: "rev-reset-done",
							},
							active: [],
						};
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, state: currentState }));
						return;
					}
					res.writeHead(400);
					res.end();
				});
				return;
			}
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-reset`;

	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// Open drawer
		const resetBtn = page.locator("[data-instructions-reset-btn]");
		await resetBtn.waitFor();

		// Click Reset All -> should show confirmation prompt
		await resetBtn.click();
		const confirmGroup = page.locator("[data-instructions-reset-confirm-group]");
		await confirmGroup.waitFor();
		assert.equal(await confirmGroup.isVisible(), true);

		// Click Cancel -> confirmation disappears, no mutation sent
		const cancelBtn = page.locator("[data-instructions-cancel-reset-btn]");
		await cancelBtn.click();
		await confirmGroup.waitFor({ state: "detached" });
		assert.equal(mutationsReceived.length, 0);

		// Click Reset All again -> Click Confirm
		await resetBtn.click();
		await confirmGroup.waitFor();
		const confirmBtn = page.locator("[data-instructions-confirm-reset-btn]");
		await confirmBtn.click();

		// Wait for active count to become 0
		await page.locator("[data-instructions-active-badge]").filter({ hasText: "0 active" }).waitFor();
		assert.equal(mutationsReceived.length, 1);
		assert.deepEqual(mutationsReceived[0], {
			action: "reset",
			guard: {
				sessionId: "sess-alpha-998877665544",
				leafId: "leaf-beta-112233445566",
				revision: "rev-001-opaque",
			},
		});

		// Close drawer
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("session instructions panel tolerates 503 unavailable initial load gracefully", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}
		if (url.pathname === "/api/instructions") {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Instruction runtime unavailable (503)" }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-503`;

	let browser: Browser | undefined;
	const pageErrors: string[] = [];

	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.on("pageerror", (err) => pageErrors.push(err.message));
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// Should show unavailable badge gracefully
		const unavailableBadge = page.locator("[data-instructions-unavailable]");
		await unavailableBadge.waitFor();
		assert.equal(await unavailableBadge.isVisible(), true);

		// No unhandled page errors
		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("session instructions panel: delayed POST with focus/poll race, guard change cancels reset, and sha256 revision", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	let currentState: InstructionStateView | null = createInitialState();
	let postDelayMs = 0;
	let getCount = 0;

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}

		if (url.pathname === "/api/instructions") {
			if (req.method === "GET") {
				getCount++;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
				return;
			}

			if (req.method === "POST") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					const parsed = JSON.parse(body);
					const respond = () => {
						if (parsed.action === "off") {
							if (currentState) {
								currentState = {
									...currentState,
									guard: {
										...currentState.guard,
										revision: "rev-delayed-post-done",
									},
									active: currentState.active.filter((a) => a.activationId !== parsed.activationId),
								};
							}
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ ok: true, state: currentState }));
							return;
						}
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unknown" }));
					};

					if (postDelayMs > 0) {
						setTimeout(respond, postDelayMs);
					} else {
						respond();
					}
				});
				return;
			}
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-races`;

	let browser: Browser | undefined;
	const pageErrors: string[] = [];

	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.on("pageerror", (err) => pageErrors.push(err.message));
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// Controls remain beside the inspector
		await page.locator("[data-instructions-body]").waitFor();

		// Part 1: Delayed POST with focus/poll race
		// Delay POST by 200ms
		postDelayMs = 200;
		const item1 = page.locator('.active-item-card[data-activation-id="act-sec-1"]');
		const deactivateBtn = item1.locator("[data-item-deactivate-btn]");

		// Click deactivate to initiate delayed POST
		await deactivateBtn.click();

		// While delayed POST is in-flight, dispatch a focus event to trigger a concurrent GET
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));

		// Wait for Item 1 to disappear after delayed POST finishes
		await item1.waitFor({ state: "detached" });

		// After delayed POST completes, buttons on remaining items must NOT be permanently locked
		const remainingItem = page.locator('.active-item-card[data-activation-id="act-rev-2"]');
		const deactivateBtn2 = remainingItem.locator("[data-item-deactivate-btn]");
		assert.equal(
			await deactivateBtn2.isDisabled(),
			false,
			"Remaining deactivate button must NOT be permanently locked after delayed POST with focus race",
		);

		const resetBtn = page.locator("[data-instructions-reset-btn]");
		assert.equal(
			await resetBtn.isDisabled(),
			false,
			"Reset button must NOT be permanently locked after delayed POST with focus race",
		);

		postDelayMs = 0;

		// Part 2: Guard change while confirming reset must cancel confirmation
		await resetBtn.click();
		const confirmGroup = page.locator("[data-instructions-reset-confirm-group]");
		await confirmGroup.waitFor();
		assert.equal(await confirmGroup.isVisible(), true, "Confirm group should be visible");

		// Simulate external guard update on server (e.g. revision or branch changed)
		currentState = {
			...currentState!,
			guard: {
				sessionId: currentState!.guard.sessionId,
				leafId: "leaf-beta-switched",
				revision: "rev-external-update",
			},
		};

		// Trigger refresh GET
		const refreshBtn = page.locator("[data-instructions-refresh]");
		await refreshBtn.click();

		// Wait for branch ID to update to new leaf (assert full title rather than short id prefix)
		const branchElem = page.locator("[data-instructions-branch-id]");
		await page.waitForFunction(
			() => document.querySelector("[data-instructions-branch-id]")?.getAttribute("title") === "leaf-beta-switched",
		);
		assert.equal(await branchElem.getAttribute("title"), "leaf-beta-switched");

		// Confirmation prompt MUST have been cancelled automatically because guard changed!
		await confirmGroup.waitFor({ state: "detached" });
		assert.equal(await page.locator("[data-instructions-reset-btn]").isVisible(), true);

		// Part 3: sha256 revision format: must display hash digest suffix, NOT "sha256:v"
		currentState = {
			...currentState!,
			guard: {
				...currentState!.guard,
				revision: "sha256:v1:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			},
		};

		await refreshBtn.click();
		const revisionElem = page.locator("[data-instructions-revision]");
		await page.waitForFunction(
			() => document.querySelector("[data-instructions-revision]")?.getAttribute("title")?.startsWith("sha256:v1:9f86"),
		);

		const revisionText = await revisionElem.textContent();
		assert.notEqual(
			revisionText,
			"sha256:v",
			"Revision badge must NOT display 'sha256:v' prefix; must display digest hash suffix",
		);
		assert.equal(
			revisionText,
			"9f86d081",
			"Revision badge should display short hash suffix (9f86d081)",
		);

		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("session instructions panel: zh-CN localization for badges and warnings", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	let currentState: InstructionStateView | null = {
		guard: {
			sessionId: "sess-zh-1",
			leafId: "leaf-zh-1",
			revision: "rev-zh-1",
		},
		trusted: false,
		restoring: false,
		delivery: "prepared",
		textPresentation: "native",
		effectiveTools: ["read"],
		active: [
			{
				activationId: "act-zh-1",
				source: "preset:security",
				name: "安全策略",
				actor: "user",
				content: "请勿输出敏感密钥",
				tools: { add: [], remove: [] },
			},
		],
	};
	let shouldFailGet = false;

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`);
			return;
		}
		if (url.pathname === "/api/instructions") {
			if (req.method === "GET") {
				if (shouldFailGet) {
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Service unavailable" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
				return;
			}
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolveServer) => {
		server.listen(0, "127.0.0.1", () => resolveServer());
	});

	const address = server.address();
	assert.ok(address && typeof address === "object");
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-zh`;

	let browser: Browser | undefined;
	const pageErrors: string[] = [];

	try {
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.on("pageerror", (err) => pageErrors.push(err.message));
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });

		// Controls remain beside the inspector
		await page.locator("[data-instructions-body]").waitFor();
		await page.locator(".instructions-diagnostics summary").click();

		// Check localized badges
		const deliveryBadge = page.locator("[data-instructions-delivery-badge]");
		assert.equal(await deliveryBadge.textContent(), "已就绪");

		const untrustedBadge = page.locator("[data-instructions-untrusted-badge]");
		assert.equal(await untrustedBadge.textContent(), "未受信任");

		const untrustedBanner = page.locator("[data-instructions-untrusted-banner]");
		assert.match(
			await untrustedBanner.textContent() || "",
			/在Pi中信任项目，或使用 \/instruction reset 恢复/,
		);

		const presentationElem = page.locator("[data-instructions-presentation]");
		assert.equal(await presentationElem.textContent(), "原生系统分段");

		const actorBadge = page.locator("[data-item-actor]");
		assert.equal(await actorBadge.textContent(), "用户");

		// Test stale badge localization
		shouldFailGet = true;
		const refreshBtn = page.locator("[data-instructions-refresh]");
		await refreshBtn.click();

		const staleBadge = page.locator("[data-instructions-stale-badge]");
		await staleBadge.waitFor();
		assert.equal(await staleBadge.textContent(), "已过期");

		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});

test("older GET cannot clear stale status after a failed mutation and failed refresh", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	const executablePath = findChromeExecutable();
	assert.ok(executablePath);
	const { js, css } = await bundleSessionInstructions(resolve(import.meta.dirname, ".."));
	const original = createInitialState();
	let gets = 0, posts = 0;
	let holdNext = false, rejectReads = false;
	let held: import("node:http").ServerResponse | undefined;
	const server = createHttpServer((req, res) => {
		if (req.url?.startsWith("/api/instructions")) {
			if (req.method === "POST") {
				posts++;
				rejectReads = true;
				req.resume();
				req.on("end", () => {
					res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
					res.end(JSON.stringify({ error: "stale revision" }));
				});
			} else {
				gets++;
				if (holdNext) { holdNext = false; held = res; res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.flushHeaders(); return; }
				res.writeHead(rejectReads ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(JSON.stringify(rejectReads ? { error: "refresh unavailable" } : { ok: true, state: original }));
			}
			return;
		}
		if (req.url?.startsWith("/?")) {
			res.setHeader("content-type", "text/html");
			res.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
		} else { res.writeHead(204); res.end(); }
	});
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	const address = server.address(); assert.ok(address && typeof address === "object");
	const browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
	try {
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${address.port}/?token=fixture`);
		await page.locator("[data-instructions-active-badge]").waitFor();
		await page.waitForTimeout(50);
		holdNext = true;
		const oldResponse = page.waitForResponse(r => r.url().includes("/api/instructions") && r.status() === 200);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		while (!held) await new Promise(r => setTimeout(r, 5));
		await page.locator("[data-item-deactivate-btn]").first().evaluate((element: HTMLButtonElement) => element.click());
		await page.locator("[data-instructions-stale-badge]").waitFor();
		for (let attempt = 0; gets < 3 && attempt < 100; attempt++) await new Promise(r => setTimeout(r, 5));
		assert.ok(gets >= 3, "post-conflict refresh was attempted");
		held.end(JSON.stringify({ ok: true, state: original }));
		await (await oldResponse).finished();
		await page.waitForTimeout(100);
		assert.equal(await page.locator("[data-instructions-stale-badge]").isVisible(), true, "late pre-mutation GET must not make stale state look fresh");
		assert.equal(await page.locator("[data-item-deactivate-btn]").first().isDisabled(), true);
		assert.equal(posts, 1);
	} finally {
		held?.end();
		await browser.close();
		await new Promise<void>(r => server.close(() => r()));
	}
});

test("session instructions panel offers no locate action for tool-only modes", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");
	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	const initial = createInitialState();
	let currentState: InstructionStateView = {
		...initial,
		effectiveTools: ["read", "write", "guard_scan", "ls"],
		active: [initial.active[0], {
			activationId: "act-tools-3",
			source: "project:add-list",
			name: "Add List",
			actor: "user",
			content: "",
			tools: { add: ["ls"], remove: [] },
		}],
	};
	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}
		if (url.pathname === "/api/instructions" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, state: currentState }));
			return;
		}
		if (url.pathname === "/api/instructions" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const parsed = JSON.parse(body);
				assert.equal(parsed.action, "off");
				currentState = {
					...currentState,
					guard: { ...currentState.guard, revision: "rev-002-opaque" },
					effectiveTools: ["read", "write", "guard_scan"],
					active: currentState.active.filter((a) => a.activationId !== parsed.activationId),
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer()));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	let browser: Browser | undefined;
	const pageErrors: string[] = [];
	try {
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage();
		page.setDefaultTimeout(6_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.goto(`http://127.0.0.1:${address.port}/?token=test-token-instructions`, { waitUntil: "domcontentloaded" });

		const textCard = page.locator('.active-item-card[data-activation-id="act-sec-1"]');
		const toolCard = page.locator('.active-item-card[data-activation-id="act-tools-3"]');
		await toolCard.waitFor();
		assert.equal(await textCard.locator("[data-item-locate]").count(), 1, "text mode can be located");
		assert.equal(await toolCard.locator("[data-item-locate]").count(), 0, "tool-only mode projects nothing to locate");
		assert.match(await toolCard.locator(".instruction-excerpt").textContent() || "", /Tool-only mode/);

		await toolCard.locator("[data-item-deactivate-btn]").click();
		await toolCard.waitFor({ state: "detached" });
		const recent = page.locator("[data-instructions-recent-change]");
		await recent.waitFor();
		assert.match(await recent.textContent() || "", /ls/);
		assert.equal(await recent.locator("[data-locate-recent]").count(), 0, "recent tool-only change has nothing to locate");
		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
	}
});

test("session instructions panel shows separated cache usage and localization", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");
	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	const cachedState: InstructionStateView = {
		...createInitialState(),
		cacheUsage: {
			main: {
				turn: { requests: 5, input: 11, output: 1235, cacheRead: 51794, cacheWrite: 6578 },
				session: { requests: 19, input: 45, output: 4529, cacheRead: 111885, cacheWrite: 16359 },
				lastRequest: { requests: 1, input: 2, output: 885, cacheRead: 11010, cacheWrite: 5349 },
			},
			nested: {
				turn: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 },
				session: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 },
			},
		},
	};
	const updatedState: InstructionStateView = {
		...cachedState,
		cacheUsage: {
			main: {
				turn: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				session: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			nested: {
				turn: { requests: 3, input: 10, output: 100, cacheRead: 900, cacheWrite: 90, calls: 2, cacheUnknownCalls: 1, invalidCalls: 1 },
				session: { requests: 3, input: 10, output: 100, cacheRead: 900, cacheWrite: 90, calls: 2, cacheUnknownCalls: 1, invalidCalls: 1 },
			},
		},
	};
	const withoutCacheState: InstructionStateView = { ...createInitialState() };
	let currentState: InstructionStateView = cachedState;
	let locale = "en";
	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`);
			return;
		}
		if (url.pathname === "/api/instructions" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, state: currentState }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer()));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	let browser: Browser | undefined;
	const pageErrors: string[] = [];
	try {
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage();
		page.setDefaultTimeout(6_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		const serverUrl = `http://127.0.0.1:${address.port}/?token=test-cache-usage`;

		// 1. Main rates, last-request title details, and empty nested usage.
		await page.goto(serverUrl, { waitUntil: "domcontentloaded" });
		const cache = page.locator("[data-instructions-cache]");
		await cache.waitFor();
		assert.equal(await cache.locator("[data-cache-turn]").textContent(), "This turn 88.7% (5 requests)");
		assert.equal(await cache.locator("[data-cache-session]").textContent(), "Session 87.2% (19 requests)");
		assert.match(await cache.locator("[data-cache-main]").getAttribute("title") || "", /Latest reported request: 67\.3%/);
		assert.equal(await cache.locator("[data-cache-nested-empty]").isVisible(), true);
		assert.doesNotMatch(await cache.locator("[data-cache-nested]").textContent() || "", /5|19/);

		// 2. Reload to fetch the changed state rather than waiting for polling.
		currentState = updatedState;
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator("[data-instructions-cache]").waitFor();
		assert.equal(await page.locator("[data-cache-turn]").textContent(), "This turn — (0 requests)");
		assert.equal(await page.locator("[data-cache-nested-turn]").textContent(), "This turn 90.0% (2 calls)");
		assert.equal(await page.locator("[data-cache-nested-session]").textContent(), "Session 90.0% (2 calls)");
		assert.equal(await page.locator("[data-cache-nested-unknown]").textContent(), "1 calls reported no cache data");
		assert.equal(await page.locator("[data-cache-nested-invalid]").textContent(), "1 malformed reports ignored");
		const nestedTitle = await page.locator("[data-cache-nested]").getAttribute("title") || "";
		assert.match(nestedTitle, /Combined known data — session: 90\.0%/);
		assert.match(nestedTitle, /cache-unknown reports are excluded/);
		const updatedCacheText = await page.locator("[data-instructions-cache]").textContent() || "";
		assert.doesNotMatch(updatedCacheText, /5 requests|19 requests|Combined known/);

		// 3. The optional block is absent when the backend omits cacheUsage.
		currentState = withoutCacheState;
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator("[data-instructions-impact]").waitFor();
		assert.equal(await page.locator("[data-instructions-cache]").count(), 0);

		// 4. No unhandled errors occurred while switching between all states.
		assert.deepEqual(pageErrors, []);

		// 5. The component follows the document locale on a fresh page load.
		locale = "zh-CN";
		currentState = cachedState;
		await page.reload({ waitUntil: "domcontentloaded" });
		assert.equal(await page.locator("[data-cache-turn]").textContent(), "本轮 88.7%（5 次请求）");
		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
	}
});
