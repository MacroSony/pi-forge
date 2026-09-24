import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "playwright-core";
import { build } from "vite";
import type { InstructionChoice, InstructionStateView, InstructionUseRequest } from "../src/instruction-state.ts";

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
		const outputs = results.flatMap((r) => ("output" in r ? r.output : []));
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
			sessionId: "sess-test-use-1234",
			leafId: "leaf-test-use-5678",
			revision: "rev-use-001",
		},
		trusted: true,
		restoring: false,
		delivery: "prepared",
		textPresentation: "native",
		effectiveTools: ["read", "write"],
		active: [
			{
				activationId: "act-existing-1",
				source: "preset:base",
				name: "Base Policy",
				actor: "user",
				content: "Base instructions for session.",
				tools: {
					add: ["read"],
					remove: [],
				},
			},
		],
	};
}

function createAvailableChoices(): InstructionChoice[] {
	return [
		{
			kind: "mode",
			id: "review",
			label: "Code Review Mode",
			content: "Review all diffs carefully for regressions.",
			tools: {
				add: ["lint"],
				remove: ["bash"],
			},
			fingerprint: "fp-review-9999",
		},
		{
			kind: "binding",
			id: "preset-security",
			label: "Security Preset Binding",
			content: "Strict security rules bound to the active preset.",
			tools: {
				add: ["guard_scan"],
				remove: [],
			},
			fingerprint: "fp-sec-8888",
		},
		{
			kind: "mode",
			id: "unknown-source",
			label: "Broken Mode",
			content: "Broken instructions that should not be activated.",
			tools: { add: [], remove: [] },
			fingerprint: "fp-broken-7777",
			problem: "Unknown mode reference: foo:bar",
		},
	];
}

test("session instructions: human activation picker, catalog read, selection, 409 guard, and problem handling", { timeout: 35_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await bundleSessionInstructions(root);

	let currentState: InstructionStateView = createInitialState();
	let currentChoices: InstructionChoice[] = createAvailableChoices();
	let catalogReadCount = 0;
	let shouldConflictUse = false;
	const postUseRequests: InstructionUseRequest[] = [];
	const allPostRequests: any[] = [];

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

		if (url.pathname === "/api/instructions/available" && req.method === "GET") {
			catalogReadCount++;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, state: currentState, choices: currentChoices }));
			return;
		}

		if (url.pathname === "/api/instructions/use" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const parsed = JSON.parse(body);
				allPostRequests.push(parsed);
				postUseRequests.push(parsed);

				if (shouldConflictUse) {
					res.writeHead(409, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Revision mismatch (HTTP 409)" }));
					return;
				}

				// Find chosen item from catalog
				const choice = currentChoices.find((c) => c.kind === parsed.kind && c.id === parsed.id);
				currentState = {
					...currentState,
					guard: {
						...currentState.guard,
						revision: "rev-use-002",
					},
					active: [
						...currentState.active,
						{
							activationId: `act-${parsed.id}-2`,
							source: `${parsed.kind}:${parsed.id}`,
							name: choice?.label || parsed.id,
							actor: "user",
							content: choice?.content || "",
							tools: choice?.tools || { add: [], remove: [] },
						},
					],
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, state: currentState }));
			});
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
					allPostRequests.push(parsed);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, state: currentState }));
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
	const serverUrl = `http://127.0.0.1:${address.port}/?token=test-instruction-use`;

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

		// 1. Non-modal workspace starts visible
		await page.locator("[data-instructions-body]").waitFor();
		const activeBadge = page.locator("[data-instructions-active-badge]");
		await activeBadge.waitFor();
		assert.equal(await activeBadge.textContent(), "1 active");
		assert.equal(await page.locator("[data-instructions-body]").isVisible(), true);

		// Controls remain beside the inspector
		const body = page.locator("[data-instructions-body]");
		await body.waitFor();
		assert.equal(await body.isVisible(), true);

		// Picker section is rendered in the controls pane
		const pickerSection = page.locator("[data-instructions-picker-section]");
		await pickerSection.waitFor();
		assert.equal(await pickerSection.isVisible(), true);

		// 2. No mutation on catalog read / selection
		assert.equal(allPostRequests.length, 0);

		// Trigger catalog read by clicking catalog load button
		const loadBtn = page.locator("[data-instructions-catalog-load]");
		await loadBtn.click();

		// Wait for catalog count badge
		const countBadge = page.locator("[data-instructions-picker-count]");
		await countBadge.waitFor();
		assert.equal(await countBadge.textContent(), "3");
		assert.equal(catalogReadCount >= 1, true);
		assert.equal(allPostRequests.length, 0, "Reading catalog must NOT execute any mutation POST");

		// Check optgroup bilingual labels for the two kinds: library unbound vs current preset bound
		const libraryGroup = page.locator("[data-picker-optgroup-library]");
		assert.equal(await libraryGroup.getAttribute("label"), "Library modes (unbound)");
		const presetGroup = page.locator("[data-picker-optgroup-preset]");
		assert.equal(await presetGroup.getAttribute("label"), "Current preset (bound)");

		// Selection without activation: select "mode:review"
		const selectElem = page.locator("[data-instructions-picker-select]");
		await selectElem.selectOption("mode:review");
		assert.equal(allPostRequests.length, 0, "Selecting choice must NOT execute any mutation POST");

		// 3. Show chosen literal content / tools / problem before activation
		const previewCard = page.locator("[data-instructions-picker-preview]");
		await previewCard.waitFor();
		assert.equal(await page.locator("[data-picker-preview-label]").textContent(), "Code Review Mode");
		assert.equal(await page.locator("[data-picker-preview-id]").textContent(), "review");
		assert.equal(await page.locator("[data-picker-preview-kind]").textContent(), "library");
		assert.equal(await page.locator("[data-picker-preview-content]").textContent(), "Review all diffs carefully for regressions.");
		assert.equal(await page.locator("[data-picker-preview-tools-add]").textContent(), "+ lint");
		assert.equal(await page.locator("[data-picker-preview-tools-remove]").textContent(), "- bash");

		// 4. Successful use: human explicit click sends exact captured guard and fingerprint
		const useBtn = page.locator("[data-instructions-use-btn]");
		assert.equal(await useBtn.isEnabled(), true);
		// A status poll (including realistic latency) must not reload the catalog,
		// change selection, or transiently disable the controls.
		const catalogBeforePoll = catalogReadCount;
		await page.route("**/api/instructions", async route => {
			if (route.request().method() === "GET") await new Promise(resolve => setTimeout(resolve, 150));
			await route.continue();
		});
		await page.evaluate(() => {
			const select = document.querySelector<HTMLSelectElement>("[data-instructions-picker-select]")!;
			const use = document.querySelector<HTMLButtonElement>("[data-instructions-use-btn]")!;
			const samples: boolean[] = [];
			const observer = new MutationObserver(() => samples.push(select.disabled || use.disabled || !!document.querySelector("[data-instructions-summary-refreshing]")));
			observer.observe(document.querySelector("[data-session-instructions]")!, { subtree: true, attributes: true, childList: true });
			(window as any).__pollObservation = { samples, observer };
		});
		await page.waitForTimeout(3400);
		const blocked = await page.evaluate(() => { const observation = (window as any).__pollObservation; observation.observer.disconnect(); return observation.samples.some(Boolean); });
		assert.equal(blocked, false, "unchanged background reads must not flicker/disable controls");
		assert.equal(catalogReadCount, catalogBeforePoll);
		assert.equal(await selectElem.inputValue(), "mode:review");
		await page.unroute("**/api/instructions");
		const used = page.waitForResponse((r) => r.url().includes("/api/instructions/use") && r.status() === 200);
		await useBtn.click();
		await used;
		assert.equal(postUseRequests.length, 1);
		assert.deepEqual(postUseRequests[0], {
			guard: {
				sessionId: "sess-test-use-1234",
				leafId: "leaf-test-use-5678",
				revision: "rev-use-001",
			},
			kind: "mode",
			id: "review",
			fingerprint: "fp-review-9999",
		});

		// UI updates: active count is now 2, new card visible, selection reset
		assert.equal(await activeBadge.textContent(), "2 active");
		assert.equal(await page.locator('.active-item-card[data-activation-id="act-review-2"]').isVisible(), true);
		assert.equal(await previewCard.isVisible(), false);
		assert.equal(await selectElem.inputValue(), "");

		// 5. Stale source / guard 409 conflict: error banner retains explanation, no auto-retry
		// The mutation invalidates old choices, then reloads them without a second click.
		await countBadge.waitFor();
		assert.equal(await countBadge.textContent(), "3");
		assert.ok(catalogReadCount >= 2);
		shouldConflictUse = true;
		await selectElem.selectOption("binding:preset-security");
		await previewCard.waitFor();
		assert.equal(await page.locator("[data-picker-preview-kind]").textContent(), "preset binding");
		assert.equal(await page.locator("[data-picker-preview-tools-add]").textContent(), "+ guard_scan");

		const postCountBefore409 = postUseRequests.length;
		await useBtn.click();

		// Wait for 409 error banner
		const errorBanner = page.locator("[data-instructions-error-banner]");
		await errorBanner.waitFor();
		assert.match(await errorBanner.textContent() || "", /Revision mismatch \(HTTP 409\)/);

		// Error banner explanation is retained and stale indicator is visible
		const staleBadge = page.locator("[data-instructions-stale-badge]");
		// A successful follow-up GET may clear the stale badge; it must not
		// erase the conflict explanation or automatically repeat the POST.
		assert.match(await errorBanner.textContent() || "", /Revision mismatch/);

		// No auto retry after 409: exactly 1 request was sent for this attempt
		assert.equal(postUseRequests.length, postCountBefore409 + 1);

		// 6. Unknown source problem disabled: choice with problem disables Use button
		shouldConflictUse = false;
		// Refresh view to clear stale state
		const refreshBtn = page.locator("[data-instructions-refresh]");
		await refreshBtn.click();
		await staleBadge.waitFor({ state: "detached" });

		// Select choice with known problem
		await selectElem.selectOption("mode:unknown-source");
		await previewCard.waitFor();

		// Problem alert is displayed
		const problemAlert = page.locator("[data-picker-preview-problem]");
		await problemAlert.waitFor();
		assert.match(await problemAlert.textContent() || "", /Unknown mode reference: foo:bar/);

		// "Use" button is disabled and clicking it does NOT send POST
		assert.equal(await useBtn.isDisabled(), true);
		const postCountBeforeDisabled = postUseRequests.length;
		await useBtn.click({ force: true }).catch(() => {});
		assert.equal(postUseRequests.length, postCountBeforeDisabled, "Disabled Use button must NOT send any POST");

		// 7. Test the trust guard with a valid choice, not the preceding broken source.
		await selectElem.selectOption("mode:review");
		currentState = {
			...currentState,
			trusted: false,
		};
		await refreshBtn.click();
		const untrustedBanner = page.locator("[data-instructions-untrusted-banner]");
		await untrustedBanner.waitFor();
		assert.equal(await useBtn.isDisabled(), true, "Untrusted session must disable activation Use button");
		const beforeUntrusted = postUseRequests.length;
		await useBtn.evaluate((button: HTMLButtonElement) => { button.disabled = false; button.click(); });
		assert.equal(postUseRequests.length, beforeUntrusted, "handler rejects untrusted use even if the DOM is force-enabled");

		// 8. Recovery keeps the non-modal controls available
		currentState = {
			...currentState,
			trusted: true,
		};
		await refreshBtn.click();
		await untrustedBanner.waitFor({ state: "detached" });

		// No modal closes or blocks the adjacent inspector.
		assert.equal(await body.isVisible(), true);
		// Header retains the active badge
		assert.equal(await activeBadge.textContent(), "2 active");

		// Clean console errors
		const unexpectedErrors = consoleErrors.filter(
			(text) => !text.includes("409 (Conflict)") && !text.includes("favicon"),
		);
		assert.deepEqual(unexpectedErrors, []);
		assert.deepEqual(pageErrors, []);
	} finally {
		await browser?.close();
		await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
	}
});
