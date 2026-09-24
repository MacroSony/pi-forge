import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "playwright-core";
import { build } from "vite";
import type {
	EffectiveInstructionModesResponse,
	InstructionMode,
	InstructionModeCollection,
	InstructionModeEntry,
} from "../src/web-editor/client/types.ts";

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

async function bundleFixture(root: string): Promise<{ js: string; css: string }> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-forge-instruction-mode-fixture-"));
	const entryPath = join(tempDir, "entry.ts");
	const browserPath = resolve(root, "src/web-editor/client/components/InstructionModeBrowser.vue");
	const bindingEditorPath = resolve(root, "src/web-editor/client/components/PresetBindingEditor.vue");
	const i18nPath = resolve(root, "src/web-editor/client/i18n.ts");

	writeFileSync(
		entryPath,
		`import { createApp, defineComponent, h, ref } from "vue";
import InstructionModeBrowser from "${browserPath}";
import PresetBindingEditor from "${bindingEditorPath}";
import { setEditorLocale } from "${i18nPath}";

const TestHarness = defineComponent({
	setup() {
		const activeTab = ref<"modes" | "preset">("modes");
		const presetDirty = ref(false);
		const presetScope = ref<"project" | "global">("project");
		const testStack = ref({
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Default Preset",
			mode: "replace",
			items: [],
			instructionModes: [
				{
					ref: "project:review",
					id: "review-binding",
					modelCallable: false,
					overrides: {
						content: "Binding overridden review instructions",
					},
				},
			],
		});

		(window as any).__getTestStack = () => testStack.value;
		(window as any).__setTestStack = (s: any) => { testStack.value = s; presetDirty.value = false; };
		(window as any).__setPresetScope = (s: "project" | "global") => { presetScope.value = s; };
		(window as any).__getPresetScope = () => presetScope.value;
		(window as any).__setActiveTab = (t: "modes" | "preset") => { activeTab.value = t; };

		function onStackChange() {
			presetDirty.value = true;
		}

		function onLocaleChange(e: Event) {
			const select = e.target as HTMLSelectElement;
			setEditorLocale(select.value as any);
		}

		function onScopeChange(e: Event) {
			const select = e.target as HTMLSelectElement;
			presetScope.value = select.value as any;
		}

		return () => h("div", { class: "test-root" }, [
			h("nav", { class: "test-nav" }, [
				h("button", { id: "tabModesBtn", onClick: () => { activeTab.value = "modes"; } }, "Modes"),
				h("button", { id: "tabPresetBtn", onClick: () => { activeTab.value = "preset"; } }, "Preset"),
				h("select", { id: "scopeSelect", value: presetScope.value, onChange: onScopeChange }, [
					h("option", { value: "project" }, "project"),
					h("option", { value: "global" }, "global"),
				]),
				h("select", { id: "localeSelect", onChange: onLocaleChange }, [
					h("option", { value: "en" }, "English"),
					h("option", { value: "zh-CN" }, "中文"),
				]),
				presetDirty.value ? h("span", { id: "presetDirtyBadge" }, "PRESET_DIRTY") : null,
			]),
			activeTab.value === "modes"
				? h(InstructionModeBrowser, { active: true })
				: h(PresetBindingEditor, {
						stack: testStack.value,
						presetSelector: presetScope.value + ":default",
						presetScope: presetScope.value,
						onChange: onStackChange,
				  }),
		]);
	},
});

createApp(TestHarness).mount("#app");
`,
	);

	try {
		const result = await build({
			root,
			configFile: false,
			publicDir: false,
			logLevel: "silent",
			plugins: [vue()],
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
					name: "InstructionModeFixture",
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

let cachedBundle: { js: string; css: string } | undefined;
async function getBundle(root: string): Promise<{ js: string; css: string }> {
	if (!cachedBundle) {
		cachedBundle = await bundleFixture(root);
	}
	return cachedBundle;
}

function createInitialModes(): InstructionModeEntry[] {
	return [
		{
			selector: "project:review",
			scope: "project",
			filePath: "/mock/project/review.json",
			sourceRevision: "rev-100",
			mode: {
				schemaVersion: 1,
				type: "pi-forge.instruction-mode",
				id: "review",
				name: "Review Mode",
				description: "Code review guidance",
				content: "Review all diffs carefully for regressions.",
				tools: {
					add: ["lint"],
					remove: ["bash"],
				},
			},
		},
		{
			selector: "global:audit",
			scope: "global",
			filePath: "/mock/global/audit.json",
			sourceRevision: "rev-200",
			mode: {
				schemaVersion: 1,
				type: "pi-forge.instruction-mode",
				id: "audit",
				name: "Audit Policy",
				description: "Global security audit",
				content: "Enforce audit standards across all projects.",
				tools: {
					add: ["audit_scan"],
					remove: [],
				},
			},
		},
	];
}

test("instruction mode editor: CRUD, 409 dirty preservation, binding edit and preview, locale, no activation", { timeout: 35_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await getBundle(root);

	let modes = createInitialModes();
	let shouldFailPutWith409 = false;
	const activationCalls: string[] = [];
	const postWrites: any[] = [];
	const putWrites: any[] = [];
	const deleteWrites: any[] = [];
	const effectiveRequests: any[] = [];

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");

		if (url.pathname.includes("activate") || url.pathname.includes("apply") || url.pathname.includes("system-update")) {
			activationCalls.push(url.pathname);
		}

		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --bg: #ffffff;
  --fg: #0f172a;
  --pane: #ffffff;
  --pane-soft: #f8fafc;
  --line: #e2e8f0;
  --muted: #64748b;
  --accent: #2563eb;
  --accent-bg: rgba(37, 99, 235, 0.1);
  --error: #ef4444;
}
body { margin: 0; font-family: sans-serif; }
.test-nav { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); align-items: center; }
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

		if (url.pathname === "/api/instruction-modes/effective" && req.method === "POST") {
			let raw = "";
			req.on("data", (chunk) => { raw += chunk; });
			req.on("end", () => {
				const body = JSON.parse(raw || "{}");
				effectiveRequests.push(body);
				const resp: EffectiveInstructionModesResponse = {
					bindings: (body.bindings || []).map((b: any) => {
						const match = modes.find((m) => m.selector === b.ref);
						const baseMode: InstructionMode = match?.mode ?? {
							schemaVersion: 1,
							type: "pi-forge.instruction-mode",
							id: "unknown",
							content: "Base content",
							tools: { add: [], remove: [] },
						};
						const effectiveMode: InstructionMode = {
							...baseMode,
							content: b.overrides?.content ?? (b.overrides?.appendContent ? `${baseMode.content}\n${b.overrides.appendContent}` : baseMode.content),
							tools: {
								add: b.overrides?.tools?.add !== undefined ? b.overrides.tools.add : baseMode.tools.add,
								remove: b.overrides?.tools?.remove !== undefined ? b.overrides.tools.remove : baseMode.tools.remove,
							},
						};
						return {
							id: b.id || baseMode.id,
							ref: b.ref,
							modelCallable: b.modelCallable === true,
							source: baseMode,
							effective: effectiveMode,
						};
					}),
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(resp));
			});
			return;
		}

		if (url.pathname === "/api/instruction-modes") {
			if (req.method === "GET") {
				const col: InstructionModeCollection = {
					trusted: true,
					modes,
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(col));
				return;
			}
			if (req.method === "POST") {
				let raw = "";
				req.on("data", (chunk) => { raw += chunk; });
				req.on("end", () => {
					const body = JSON.parse(raw || "{}");
					postWrites.push(body);
					const newEntry: InstructionModeEntry = {
						selector: `${body.scope}:${body.mode.id}`,
						scope: body.scope,
						mode: body.mode,
						filePath: `/mock/${body.scope}/${body.mode.id}.json`,
						sourceRevision: "rev-new",
						diagnostics: [],
					};
					modes.push(newEntry);
					// Contract: writes return ok; client explicitly GETs collection
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, sourceRevision: "a".repeat(64) }));
				});
				return;
			}
		}

		if (url.pathname.startsWith("/api/instruction-modes/")) {
			const selector = decodeURIComponent(url.pathname.slice("/api/instruction-modes/".length));
			if (req.method === "PUT") {
				let raw = "";
				req.on("data", (chunk) => { raw += chunk; });
				req.on("end", () => {
					const body = JSON.parse(raw || "{}");
					putWrites.push({ selector, body });
					if (shouldFailPutWith409) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: `Instruction mode source revision is stale for ${selector}.` }));
						return;
					}
					const idx = modes.findIndex((m) => m.selector === selector);
					if (idx >= 0) {
						modes[idx] = {
							...modes[idx],
							mode: body.mode,
							sourceRevision: "rev-updated",
						};
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, sourceRevision: "b".repeat(64) }));
				});
				return;
			}
			if (req.method === "DELETE") {
				let raw = "";
				req.on("data", (chunk) => { raw += chunk; });
				req.on("end", () => {
					const body = JSON.parse(raw || "{}");
					deleteWrites.push({ selector, body });
					modes = modes.filter((m) => m.selector !== selector);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				});
				return;
			}
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const port = (server.address() as any).port;
	const url = `http://127.0.0.1:${port}/`;

	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ executablePath, headless: true });
		const page: Page = await browser.newPage();
		page.on("dialog", (dialog) => dialog.accept());

		await page.goto(url);

		// --- 1. Mode Library Listing & View ---
		await page.locator("[data-mode-row]").first().waitFor();
		assert.equal(await page.locator("[data-mode-row]").count(), 2);
		assert.match(await page.locator(".mode-detail-title").textContent() ?? "", /Review Mode/);
		assert.match(await page.locator(".mode-content-pre").textContent() ?? "", /Review all diffs carefully/);

		// Bilingual explanatory note: Mode save never activates!
		const noteLocator = page.locator(".mode-save-note").first();
		assert.ok(await noteLocator.isVisible());
		assert.match(await noteLocator.textContent() ?? "", /updates its library definition only and does not activate/i);

		// --- 2. Create Instruction Mode ---
		await page.locator("#modeNewBtn").click();
		await page.locator("#modeId").fill("guard-rules");
		await page.locator("#modeName").fill("Guard Rules");
		await page.locator("#modeDescription").fill("Enforces security checks");
		await page.locator("#modeContent").fill("Strictly verify permissions and inputs.");

		// Add tool to add list
		await page.locator("[data-mode-tools-add-picker] [data-tool-picker-trigger]").click();
		const addPickerPanel = page.locator("[data-mode-tools-add-picker] [data-tool-picker-panel]");
		await addPickerPanel.waitFor();
		await addPickerPanel.locator(".tool-picker-manual summary").click();
		await addPickerPanel.locator("[data-tool-manual-input]").fill("guard_verify");
		await addPickerPanel.locator("[data-tool-manual-btn]").click();
		await addPickerPanel.locator("[data-tool-picker-done]").click();
		await page.locator(".mode-tag.add").filter({ hasText: "guard_verify" }).waitFor();

		// Add tool to remove list
		await page.locator("[data-mode-tools-remove-picker] [data-tool-picker-trigger]").click();
		const removePickerPanel = page.locator("[data-mode-tools-remove-picker] [data-tool-picker-panel]");
		await removePickerPanel.waitFor();
		await removePickerPanel.locator(".tool-picker-manual summary").click();
		await removePickerPanel.locator("[data-tool-manual-input]").fill("unsafe_exec");
		await removePickerPanel.locator("[data-tool-manual-btn]").click();
		await removePickerPanel.locator("[data-tool-picker-done]").click();
		await page.locator(".mode-tag.remove").filter({ hasText: "unsafe_exec" }).waitFor();

		// Save new mode
		await page.locator("#modeSaveBtn").click();

		// Wait for save & re-listing
		await page.locator("[data-mode-row]").filter({ hasText: "Guard Rules" }).waitFor();
		assert.equal(postWrites.length, 1);
		assert.equal(postWrites[0].scope, "project");
		assert.equal(postWrites[0].mode.id, "guard-rules");
		assert.deepEqual(postWrites[0].mode.tools.add, ["guard_verify"]);
		assert.deepEqual(postWrites[0].mode.tools.remove, ["unsafe_exec"]);

		// --- 3. 409 Stale Conflict: KEEP draft ---
		// Select the created mode to edit
		await page.locator("[data-mode-row]").filter({ hasText: "Guard Rules" }).click();
		await page.locator("#modeEditBtn").click();

		// Edit content
		const draftEditContent = "Draft changes that must be preserved on 409 conflict!";
		await page.locator("#modeContent").fill(draftEditContent);

		// Arm 409 conflict on PUT
		shouldFailPutWith409 = true;
		await page.locator("#modeSaveBtn").click();

		// Verify error message displayed
		await page.locator(".mode-message.error").waitFor();
		assert.match(await page.locator(".mode-message.error").textContent() ?? "", /stale/i);

		// CRITICAL REQUIREMENT: draft is KEPT on 409! Editor is still open with dirty draft!
		assert.equal(await page.locator("#modeContent").inputValue(), draftEditContent);
		assert.equal(await page.locator(".mode-dirty-badge").isVisible(), true);

		// Disarm 409 and save successfully
		shouldFailPutWith409 = false;
		await page.locator("#modeSaveBtn").click();
		await page.locator(".mode-detail-title").waitFor();
		assert.match(await page.locator(".mode-content-pre").textContent() ?? "", /Draft changes that must be preserved/);
		assert.ok(putWrites.length >= 2);

		// --- 4. Refresh doesn't clobber dirty editor ---
		await page.locator("#modeEditBtn").click();
		await page.locator("#modeContent").fill("Unsaved draft that refresh should not destroy");
		await page.locator("#modeRefreshBtn").click();
		// Editor must still be open with the draft intact
		assert.equal(await page.locator("#modeContent").inputValue(), "Unsaved draft that refresh should not destroy");
		await page.locator("#modeCancelBtn").click();

		// --- 5. Delete Instruction Mode ---
		await page.locator("#modeDeleteBtn").click();
		await page.locator("[data-mode-row]").filter({ hasText: "Guard Rules" }).waitFor({ state: "detached" });
		assert.equal(deleteWrites.length, 1);
		assert.equal(deleteWrites[0].selector, "project:guard-rules");

		// --- 6. Preset Binding Editor: Overrides & Effective Preview ---
		await page.locator("#tabPresetBtn").click();
		await page.locator("[data-binding-row]").first().waitFor();
		await page.locator("[data-binding-advanced-toggle]").first().click();
		await page.locator("[data-binding-preview]").first().waitFor();
		await page.locator("[data-binding-preview] summary").first().click();
		assert.ok(effectiveRequests.length > 0);
		assert.match(await page.locator("[data-binding-source-content]").first().textContent() ?? "", /Review all diffs carefully/);
		assert.match(await page.locator("[data-binding-effective-content]").first().textContent() ?? "", /Binding overridden review instructions/);

		// Edit tool overrides: set add tools override to custom (initiates explicit [])
		await page.locator("[data-binding-tools-add-mode]").first().selectOption("custom");
		// Verify preset dirty event fired
		await page.locator("#presetDirtyBadge").waitFor();

		// Check the test stack state via evaluate
		const currentStackState = await page.evaluate(() => (window as any).__getTestStack());
		assert.ok(currentStackState.instructionModes);
		assert.equal(currentStackState.instructionModes[0].ref, "project:review");
		assert.deepEqual(currentStackState.instructionModes[0].overrides.tools.add, []);

		// Edit content override to append mode
		await page.locator("[data-binding-content-mode]").first().selectOption("append");
		await page.locator("[data-binding-append-content]").first().fill("Appended instruction tail.");
		const updatedStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(updatedStack.instructionModes[0].overrides.content, undefined);
		assert.equal(updatedStack.instructionModes[0].overrides.appendContent, "Appended instruction tail.");

		// Add another binding
		await page.locator("#addBindingBtn").click();
		assert.equal(await page.locator("[data-binding-row]").count(), 2);

		// Set modelCallable toggle
		await page.locator("[data-binding-model-callable]").nth(1).check();
		const stackWithCallable = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(stackWithCallable.instructionModes[1].modelCallable, true);

		// --- 7. Bilingual locale switching ---
		await page.locator("#tabModesBtn").click();
		await page.locator("#localeSelect").selectOption("zh-CN");

		// Verify Chinese localization
		await page.locator(".mode-heading").filter({ hasText: "指令模式" }).waitFor();
		assert.match(await page.locator("#modeNewBtn").textContent() ?? "", /新建模式/);
		assert.match(await page.locator(".mode-save-note").first().textContent() ?? "", /保存指令模式仅更新模式库定义/);

		// Switch back to English
		await page.locator("#localeSelect").selectOption("en");
		await page.locator(".mode-heading").filter({ hasText: "Instruction modes" }).waitFor();
		assert.match(await page.locator("#modeNewBtn").textContent() ?? "", /New mode/);

		// --- 8. No Implicit Activation Check ---
		// Verify that throughout all tests, NO activation endpoint was called
		assert.deepEqual(activationCalls, [], "Mode operations must NEVER implicitly activate instructions");
	} finally {
		await browser?.close();
		server.close();
	}
});

test("preset binding editor: scope restriction, empty/loading/error/retry, library refresh, invalid ref preservation", { timeout: 35_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await getBundle(root);

	let modes: InstructionModeEntry[] = [
		{
			selector: "project:guard",
			scope: "project",
			filePath: "/mock/project/guard.json",
			sourceRevision: "rev-guard-1",
			mode: {
				schemaVersion: 1,
				type: "pi-forge.instruction-mode",
				id: "guard",
				name: "Project Guard Mode",
				description: "Project guard rules",
				content: "Project guard instruction text.",
				tools: { add: ["guard_tool"], remove: [] },
			},
		},
	];
	let simulateModesError = true;
	let holdModeRead = false;
	let releaseModeRead: (() => void) | undefined;
	const effectiveRequests: any[] = [];

	const server = createHttpServer((req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");

		if (url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --bg: #ffffff;
  --fg: #0f172a;
  --pane: #ffffff;
  --pane-soft: #f8fafc;
  --line: #e2e8f0;
  --muted: #64748b;
  --accent: #2563eb;
  --accent-bg: rgba(37, 99, 235, 0.1);
  --error: #ef4444;
}
body { margin: 0; font-family: sans-serif; }
.test-nav { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); align-items: center; }
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

		if (url.pathname === "/api/instruction-modes/effective" && req.method === "POST") {
			let raw = "";
			req.on("data", (chunk) => { raw += chunk; });
			req.on("end", () => {
				const body = JSON.parse(raw || "{}");
				effectiveRequests.push(body);
				const bindings = body.bindings || [];
				for (const b of bindings) {
					const match = modes.find((m) => m.selector === b.ref);
					if (!match) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: `Instruction mode not found for ref "${b.ref}".` }));
						return;
					}
				}
				const resp: EffectiveInstructionModesResponse = {
					bindings: bindings.map((b: any) => {
						const match = modes.find((m) => m.selector === b.ref)!;
						return {
							id: b.id || match.mode.id,
							ref: b.ref,
							modelCallable: b.modelCallable === true,
							source: match.mode,
							effective: match.mode,
						};
					}),
				};
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(resp));
			});
			return;
		}

		if (url.pathname === "/api/instruction-modes") {
			if (req.method === "GET") {
				if (simulateModesError) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Failed to load instruction mode collection." }));
					return;
				}
				const reply = () => {
					res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ trusted: true, modes } satisfies InstructionModeCollection));
				};
				if (holdModeRead) releaseModeRead = reply;
				else reply();
				return;
			}
			if (req.method === "POST") {
				let raw = "";
				req.on("data", (chunk) => { raw += chunk; });
				req.on("end", () => {
					const body = JSON.parse(raw || "{}");
					const newEntry: InstructionModeEntry = {
						selector: `${body.scope}:${body.mode.id}`,
						scope: body.scope,
						mode: body.mode,
						filePath: `/mock/${body.scope}/${body.mode.id}.json`,
						sourceRevision: "rev-new",
						diagnostics: [],
					};
					modes.push(newEntry);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, sourceRevision: "c".repeat(64) }));
				});
				return;
			}
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const port = (server.address() as any).port;
	const url = `http://127.0.0.1:${port}/`;

	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ executablePath, headless: true });
		const page: Page = await browser.newPage();
		page.on("dialog", (dialog) => dialog.accept());

		await page.goto(url);

		// Switch preset scope to global and empty bindings initially
		await page.evaluate(() => {
			(window as any).__setPresetScope("global");
			(window as any).__setTestStack({
				schemaVersion: 2,
				type: "pi-forge.prompt-stack",
				id: "global-default",
				name: "Global Default Preset",
				mode: "replace",
				items: [],
				instructionModes: [],
			});
			(window as any).__setActiveTab("preset");
		});

		// --- 1. Loading / Failure / Retry UX ---
		// modes load failed with 500
		await page.locator("[data-binding-catalog-error]").waitFor();
		assert.match(await page.locator("[data-binding-catalog-error]").textContent() ?? "", /Failed to load/i);
		const retryBtn = page.locator("[data-binding-retry-btn]");
		await retryBtn.waitFor();
		// Add button must be disabled during error state
		const addBtn = page.locator("#addBindingBtn");
		assert.equal(await addBtn.isDisabled(), true, "Add button must be disabled when catalog failed to load");

		// Attempting click must not mutate stack
		await addBtn.click({ force: true });
		let currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.instructionModes?.length ?? 0, 0, "No binding added on catalog failure");
		assert.equal(effectiveRequests.length, 0, "No fake reference sent to effective resolver on catalog failure");

		// Heal server and retry
		simulateModesError = false;
		await retryBtn.click();
		await page.locator("[data-binding-catalog-error]").waitFor({ state: "detached" });

		// --- 2. Global preset with only project modes (the regression) ---
		// Now modes has only project:guard, but preset is global!
		// Add button must remain disabled because global preset cannot bind project modes!
		assert.equal(await addBtn.isDisabled(), true, "Add button must be disabled on global preset with only project modes");
		// Bilingual empty/scope hint must be visible
		const scopeHintLocator = page.locator("[data-binding-no-eligible]");
		await scopeHintLocator.waitFor();
		assert.match(await scopeHintLocator.textContent() ?? "", /Global presets can only bind global instruction modes/i);

		// Attempting to click must NOT manufacture a fake UUID or mutate stack
		await addBtn.click({ force: true });
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.instructionModes?.length ?? 0, 0, "Draft must not be mutated when no eligible modes exist");
		assert.equal(await page.locator("#presetDirtyBadge").isVisible(), false, "Dirty badge must not appear");
		assert.equal(effectiveRequests.length, 0, "Fake reference must not be sent to effective resolver");
		assert.equal(await page.locator(".preview-error-line").isVisible(), false, "No resolution failure displayed");

		// Bilingual check in zh-CN
		await page.locator("#localeSelect").selectOption("zh-CN");
		assert.match(await scopeHintLocator.textContent() ?? "", /全局预设只能绑定全局指令模式/);
		await page.locator("#localeSelect").selectOption("en");

		// --- 3. Genuinely empty catalog ---
		modes = [];
		await page.locator("#refreshModesBtn").click();
		await scopeHintLocator.waitFor();
		assert.match(await scopeHintLocator.textContent() ?? "", /No instruction modes available in the library/i);
		assert.equal(await addBtn.isDisabled(), true, "Add button must be disabled when catalog is genuinely empty");

		// Bilingual check for genuinely empty in zh-CN
		await page.locator("#localeSelect").selectOption("zh-CN");
		assert.match(await scopeHintLocator.textContent() ?? "", /指令库中暂无可用指令模式/);
		await page.locator("#localeSelect").selectOption("en");

		// --- 4. Creation of available mode via library and refresh bindings ---
		// Switch to library tab and create a global mode
		await page.locator("#tabModesBtn").click();
		await page.locator("#modeNewBtn").click();
		await page.locator("#modeScope").selectOption("global");
		await page.locator("#modeId").fill("audit");
		await page.locator("#modeName").fill("Global Audit");
		await page.locator("#modeContent").fill("Global audit instructions.");
		await page.locator("#modeSaveBtn").click();
		await page.locator("[data-mode-row]").filter({ hasText: "Global Audit" }).waitFor();

		// Switch back to preset tab
		await page.locator("#tabPresetBtn").click();
		// Click refresh button in PresetBindingEditor
		await page.locator("#refreshModesBtn").click();

		// Now global mode is available!
		await page.locator("#addBindingBtn:not(:disabled)").waitFor();
		await scopeHintLocator.waitFor({ state: "detached" });
		assert.equal(await addBtn.isDisabled(), false, "Add button must be enabled once an eligible mode exists");

		// Click Add to add the eligible mode
		const beforeAddEffectiveCount = effectiveRequests.length;
		await addBtn.click();
		await page.locator("[data-binding-row]").waitFor();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.instructionModes?.length, 1);
		assert.equal(currentStack.instructionModes[0].ref, "global:audit");
		assert.equal(currentStack.instructionModes[0].modelCallable, false, "modelCallable must be false by default");
		await page.locator("[data-binding-advanced-toggle]").click();
		// Effective preview must succeed
		await page.locator("[data-binding-preview]").waitFor();
		assert.equal(await page.locator(".preview-error-line").isVisible(), false);
		assert.ok(effectiveRequests.length - beforeAddEffectiveCount >= 1);
		assert.equal(effectiveRequests[effectiveRequests.length - 1].bindings[0].ref, "global:audit");

		// A real held refresh with an already usable cached mode: loading must
		// disable Add, not just rely on the catalog coincidentally being empty.
		const beforeRefresh = await page.evaluate(() => (window as any).__getTestStack());
		holdModeRead = true;
		modes.find(mode => mode.selector === "global:audit")!.mode.content = "REFRESHED_SOURCE_BODY";
		await page.locator("#refreshModesBtn").click();
		await page.locator("[data-binding-catalog-loading]").waitFor();
		assert.equal(await addBtn.isDisabled(), true);
		await addBtn.dispatchEvent("click");
		assert.deepEqual(await page.evaluate(() => (window as any).__getTestStack()), beforeRefresh);
		assert.ok(releaseModeRead);
		holdModeRead = false;
		releaseModeRead();
		await page.locator("[data-binding-catalog-loading]").waitFor({ state: "detached" });
		await page.locator("[data-binding-preview]").filter({ hasText: "REFRESHED_SOURCE_BODY" }).waitFor();
		assert.equal(await addBtn.isDisabled(), false);
		assert.deepEqual(await page.evaluate(() => (window as any).__getTestStack()), beforeRefresh, "Refreshing source/effective display does not change bindings");

		// --- 5. Preserve existing invalid/missing persisted bindings for explicit recovery ---
		await page.evaluate(() => {
			(window as any).__setTestStack({
				schemaVersion: 2,
				type: "pi-forge.prompt-stack",
				id: "global-default",
				name: "Global Default Preset",
				mode: "replace",
				items: [],
				instructionModes: [
					{
						ref: "global:unavailable-stale-recovered-id",
						modelCallable: false,
					},
				],
			});
		});
		await page.locator("[data-binding-row]").first().waitFor();
		const refSelect = page.locator("[data-binding-ref]").first();
		assert.equal(await refSelect.inputValue(), "global:unavailable-stale-recovered-id", "Existing invalid persisted binding ref must be preserved");

		// User explicitly deletes the invalid binding
		await page.locator("[data-binding-delete-btn]").first().click();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.instructionModes?.length ?? 0, 0, "Invalid binding explicitly deleted");
	} finally {
		await browser?.close();
		server.close();
	}
});

test("empty global binding add preserves an untouched draft instead of inventing a UUID", async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1"); return; }
	const executablePath = findChromeExecutable();
	assert.ok(executablePath);
	const { js, css } = await getBundle(resolve(import.meta.dirname, ".."));
	let effectiveCalls = 0;
	let includeFault = false;
	const server = createHttpServer((req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (req.url === "/") {
			res.setHeader("Content-Type", "text/html");
			res.end(`<style>${css}</style><div id="app"></div><script>${js}</script>`);
		} else {
			res.setHeader("Content-Type", "application/json");
			if (req.url?.startsWith("/api/instruction-modes/effective")) {
				effectiveCalls++;
				res.statusCode = 400;
				res.end(JSON.stringify({ error: "Unknown instruction mode" }));
			} else res.end(JSON.stringify({ trusted: true, modes: [{
				selector: "project:review", scope: "project", filePath: "/fixture/review.json",
				mode: { schemaVersion: 1, type: "pi-forge.instruction-mode", id: "review", content: "Review", tools: { add: [], remove: [] } },
			}, ...(includeFault ? [{
				selector: "global:broken", scope: "global", filePath: "/fixture/broken.json",
				mode: { schemaVersion: 1, type: "pi-forge.instruction-mode", id: "broken", content: "", tools: { add: [], remove: [] } },
				diagnostics: [{ level: "error", message: "Invalid mode file" }],
			}] : [])] }));
		}
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ executablePath, headless: true });
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
		await page.evaluate(() => {
			(window as any).__setPresetScope("global");
			(window as any).__setTestStack({ schemaVersion: 2, type: "pi-forge.prompt-stack", id: "global-default", mode: "replace", items: [] });
			(window as any).__setActiveTab("preset");
		});
		await page.waitForLoadState("networkidle");
		// Dispatch directly even on a disabled button: cover the handler's own
		// guard as well as the native disabled-control behavior.
		await page.locator("#addBindingBtn").dispatchEvent("click");
		const stack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(stack.instructionModes, undefined, "No synthetic global:unavailable UUID and no empty-array draft mutation");
		assert.equal(await page.locator("#addBindingBtn").isDisabled(), true);
		assert.equal(await page.locator("#presetDirtyBadge").count(), 0);
		assert.equal(effectiveCalls, 0);
		includeFault = true;
		await page.locator("#refreshModesBtn").click();
		await page.waitForLoadState("networkidle");
		await page.locator("#addBindingBtn").dispatchEvent("click");
		assert.equal(await page.locator("#addBindingBtn").isDisabled(), true, "A known-invalid global definition is not an add candidate");
		assert.equal((await page.evaluate(() => (window as any).__getTestStack())).instructionModes, undefined);
		assert.equal(effectiveCalls, 0);
	} finally {
		await browser?.close();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
