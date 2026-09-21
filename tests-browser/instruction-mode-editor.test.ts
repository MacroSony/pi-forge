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
	const metadataEditorPath = resolve(root, "src/web-editor/client/components/StackMetadataEditor.vue");
	const i18nPath = resolve(root, "src/web-editor/client/i18n.ts");

	writeFileSync(
		entryPath,
		`import { createApp, defineComponent, h, ref } from "vue";
import InstructionModeBrowser from "${browserPath}";
import StackMetadataEditor from "${metadataEditorPath}";
import { setEditorLocale } from "${i18nPath}";

const TestHarness = defineComponent({
	setup() {
		const activeTab = ref<"modes" | "preset">("modes");
		const presetDirty = ref(false);
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

		function onStackChange() {
			presetDirty.value = true;
		}

		function onLocaleChange(e: Event) {
			const select = e.target as HTMLSelectElement;
			setEditorLocale(select.value as any);
		}

		return () => h("div", { class: "test-root" }, [
			h("nav", { class: "test-nav" }, [
				h("button", { id: "tabModesBtn", onClick: () => { activeTab.value = "modes"; } }, "Modes"),
				h("button", { id: "tabPresetBtn", onClick: () => { activeTab.value = "preset"; } }, "Preset"),
				h("select", { id: "localeSelect", onChange: onLocaleChange }, [
					h("option", { value: "en" }, "English"),
					h("option", { value: "zh-CN" }, "中文"),
				]),
				presetDirty.value ? h("span", { id: "presetDirtyBadge" }, "PRESET_DIRTY") : null,
			]),
			activeTab.value === "modes"
				? h(InstructionModeBrowser, { active: true })
				: h(StackMetadataEditor, {
						stack: testStack.value,
						filePath: "/test/default.json",
						presetSelector: "project:default",
						presetScope: "project",
						collapsed: false,
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
	const { js, css } = await bundleFixture(root);

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
					res.end(JSON.stringify({ ok: true }));
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
					res.end(JSON.stringify({ ok: true }));
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
		await page.locator("#modeToolAddInput").fill("guard_verify");
		await page.locator("#modeToolAddBtn").click();
		// Add tool to remove list
		await page.locator("#modeToolRemoveInput").fill("unsafe_exec");
		await page.locator("#modeToolRemoveBtn").click();

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
		await page.locator("[data-binding-preview]").first().waitFor();
		assert.ok(effectiveRequests.length > 0);
		assert.match(await page.locator("[data-binding-source-content]").first().textContent() ?? "", /Review all diffs carefully/);
		assert.match(await page.locator("[data-binding-effective-content]").first().textContent() ?? "", /Binding overridden review instructions/);

		// Edit tool overrides: set add tools override to explicit empty
		await page.locator("[data-binding-tools-add-mode]").first().selectOption("explicitEmpty");
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
