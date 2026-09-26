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
	Capability,
	CapabilityCollection,
	CapabilityEntry,
	WebEditorPolicyResource,
	WebEditorResources,
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
	const tempDir = mkdtempSync(join(tmpdir(), "pi-forge-tool-picker-fixture-"));
	const entryPath = join(tempDir, "entry.ts");
	const policyEditorPath = resolve(root, "src/web-editor/client/components/PolicyEditor.vue");
	const capabilityEditorPath = resolve(root, "src/web-editor/client/components/CapabilityEditor.vue");
	const bindingEditorPath = resolve(root, "src/web-editor/client/components/PresetBindingEditor.vue");
	const toolPickerPath = resolve(root, "src/web-editor/client/components/ToolPicker.vue");
	const i18nPath = resolve(root, "src/web-editor/client/i18n.ts");

	writeFileSync(
		entryPath,
		`import { createApp, defineComponent, h, ref } from "vue";
import PolicyEditor from "${policyEditorPath}";
import CapabilityEditor from "${capabilityEditorPath}";
import PresetBindingEditor from "${bindingEditorPath}";
import ToolPicker from "${toolPickerPath}";
import { setEditorLocale } from "${i18nPath}";

const TestHarness = defineComponent({
	setup() {
		const activeTab = ref<"policy" | "capability" | "binding" | "standalone">("policy");
		const dirty = ref(false);
		const testStack = ref({
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Default Stack",
			tools: {
				allow: ["read", "write"],
			},
			skills: {
				allow: ["search_code"],
			},
			capabilities: [
				{
					ref: "project:review",
					id: "review-binding",
					overrides: {
						tools: {
							add: ["lint"],
						},
					},
				},
			],
		});

		const policyResources = ref({
			tools: [
				{ name: "read", description: "Read files", source: "fs", group: { id: "filesystem", label: "File System" }, active: true },
				{ name: "write", description: "Write files", source: "fs", group: { id: "filesystem", label: "File System" }, active: true },
				{ name: "git_status", description: "Git status", source: "git", group: { id: "git", label: "Git VCS" } },
				{ name: "git_commit", description: "Git commit", source: "git", group: { id: "git", label: "Git VCS" } },
				{ name: "bash_exec", description: "Execute bash command", source: "shell" },
			],
			skills: [
				{ name: "search_code", description: "Search code" },
			],
		});

		const standaloneSelected = ref<string[]>([]);

		(window as any).__getTestStack = () => testStack.value;
		(window as any).__setTestStack = (s: any) => { testStack.value = s; dirty.value = false; };
		(window as any).__getPolicyResources = () => policyResources.value;
		(window as any).__setPolicyResources = (r: any) => { policyResources.value = r; };
		(window as any).__setActiveTab = (t: string) => { activeTab.value = t as any; };
		(window as any).__getDirty = () => dirty.value;
		(window as any).__setDirty = (d: boolean) => { dirty.value = d; };
		(window as any).__getStandaloneSelected = () => standaloneSelected.value;
		(window as any).__setStandaloneSelected = (s: string[]) => { standaloneSelected.value = s; };

		function onStackChange() {
			dirty.value = true;
		}

		function onLocaleChange(e: Event) {
			const select = e.target as HTMLSelectElement;
			setEditorLocale(select.value as any);
		}

		return () => h("div", { class: "test-root" }, [
			h("nav", { class: "test-nav" }, [
				h("button", { id: "tabPolicyBtn", onClick: () => { activeTab.value = "policy"; } }, "Policy"),
				h("button", { id: "tabCapabilityBtn", onClick: () => { activeTab.value = "capability"; } }, "Capability"),
				h("button", { id: "tabBindingBtn", onClick: () => { activeTab.value = "binding"; } }, "Binding"),
				h("button", { id: "tabStandaloneBtn", onClick: () => { activeTab.value = "standalone"; } }, "Standalone"),
				h("select", { id: "localeSelect", onChange: onLocaleChange }, [
					h("option", { value: "en" }, "English"),
					h("option", { value: "zh-CN" }, "中文"),
				]),
				dirty.value ? h("span", { id: "dirtyBadge" }, "DIRTY") : null,
			]),
			activeTab.value === "policy"
				? h(PolicyEditor, {
						stack: testStack.value,
						resources: policyResources.value,
						onChange: onStackChange,
				  })
				: activeTab.value === "capability"
				? h(CapabilityEditor, {
						mode: "create",
						createScope: "project",
						onDirtyChange: (isDirty: boolean) => { dirty.value = isDirty; },
				  })
				: activeTab.value === "binding"
				? h(PresetBindingEditor, {
						stack: testStack.value,
						presetSelector: "project:default",
						presetScope: "project",
						onChange: onStackChange,
				  })
				: h("div", { class: "standalone-container" }, [
						h(ToolPicker, {
							resources: policyResources.value.tools,
							modelValue: standaloneSelected.value,
							"onUpdate:modelValue": (val: string[]) => { standaloneSelected.value = val; },
						}),
				  ]),
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
					name: "ToolPickerFixture",
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

test("source-grouped batch tool picker, custom defaults, and execution safety", { timeout: 40_000 }, async () => {
	const chromeExecutable = findChromeExecutable();
	if (!chromeExecutable) {
		console.warn("Skipping browser test: No Chrome executable found.");
		return;
	}

	const root = resolve(import.meta.dirname, "..");
	const { js, css } = await getBundle(root);

	let shouldFailResources = false;
	const activationCalls: string[] = [];
	const postWrites: any[] = [];

	let catalogTools: WebEditorPolicyResource[] = [
		{ name: "read", description: "Read files", source: "fs", group: { id: "filesystem", label: "File System" }, active: true },
		{ name: "write", description: "Write files", source: "fs", group: { id: "filesystem", label: "File System" }, active: true },
		{ name: "git_status", description: "Git status", source: "git", group: { id: "git", label: "Git VCS" } },
		{ name: "git_commit", description: "Git commit", source: "git", group: { id: "git", label: "Git VCS" } },
		{ name: "bash_exec", description: "Execute bash command", source: "shell" },
	];

	const capabilities: CapabilityEntry[] = [
		{
			selector: "project:review",
			scope: "project",
			filePath: "/mock/review.json",
			sourceRevision: "rev-1",
			capability: {
				schemaVersion: 1,
				type: "pi-forge.capability",
				id: "review",
				name: "Review Capability",
				content: "Review carefully",
				tools: { add: ["lint"], remove: [] },
			},
		},
	];

	const server = createHttpServer((req, res) => {
		const parsed = new URL(req.url || "/", "http://localhost");

		// Track activation calls to verify live execution is never mutated
		if (parsed.pathname.includes("/capability-state/enable")) {
			activationCalls.push(`${req.method} ${parsed.pathname}`);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		if (parsed.pathname === "/api/resources") {
			if (shouldFailResources) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Failed to load resources" }));
				return;
			}
			const resources: WebEditorResources = {
				tools: catalogTools,
				skills: [{ name: "search_code", description: "Search code" }],
				macros: [],
				slots: [],
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(resources));
			return;
		}

		if (parsed.pathname === "/api/capabilities" && req.method === "GET") {
			const collection: CapabilityCollection = {
				trusted: true,
				capabilities,
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(collection));
			return;
		}

		if (parsed.pathname === "/api/capabilities" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const data = JSON.parse(body);
				postWrites.push(data);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, selector: `${data.scope}:${data.capability.id}` }));
			});
			return;
		}

		if (parsed.pathname.startsWith("/api/capabilities/") && parsed.pathname.endsWith("/effective")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ bindings: [] }));
			return;
		}

		if (parsed.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html>
<html>
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

		res.writeHead(404);
		res.end("Not found");
	});

	await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
	const port = (server.address() as any).port;
	const serverUrl = `http://127.0.0.1:${port}/?token=test-token`;

	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({
			executablePath: chromeExecutable,
			headless: true,
		});
		const page: Page = await browser.newPage();
		await page.goto(serverUrl);

		// =========================================================================
		// 1. STANDALONE TOOL PICKER: Source-group batch selection and partial choice
		// =========================================================================
		await page.locator("#tabStandaloneBtn").click();
		await page.locator("[data-tool-picker-trigger]").first().click();
		await page.locator("[data-tool-picker-panel]").waitFor();

		// Verify groups rendered: "Git VCS", "File System", and "Other"
		const gitGroup = page.locator('[data-tool-group="git"]');
		const fsGroup = page.locator('[data-tool-group="filesystem"]');
		const otherGroup = page.locator('[data-tool-group="other"]');

		await gitGroup.waitFor();
		await fsGroup.waitFor();
		await otherGroup.waitFor();

		assert.equal(await gitGroup.locator(".tool-group-name").textContent(), "Git VCS");
		assert.equal(await fsGroup.locator(".tool-group-name").textContent(), "File System");
		assert.equal(await otherGroup.locator(".tool-group-name").textContent(), "Other");

		// Batch select git group
		await gitGroup.locator("[data-tool-group-checkbox]").click();
		let selected = await page.evaluate(() => (window as any).__getStandaloneSelected());
		assert.ok(selected.includes("git_status"));
		assert.ok(selected.includes("git_commit"));
		assert.equal(await gitGroup.locator("[data-tool-group-checkbox]").isChecked(), true);
		assert.match(await gitGroup.locator(".tool-group-count").textContent() ?? "", /\(2\/2\)/);

		// Groups start collapsed by default
		assert.equal(await gitGroup.locator(".tool-group-items").count(), 0);
		// Expand git group
		await gitGroup.locator("[data-tool-group-toggle]").click();
		await gitGroup.locator(".tool-group-items").waitFor();

		// Partial check: uncheck git_commit
		await gitGroup.locator('[data-tool-checkbox][data-tool-name="git_commit"]').click();
		selected = await page.evaluate(() => (window as any).__getStandaloneSelected());
		assert.ok(selected.includes("git_status"));
		assert.ok(!selected.includes("git_commit"));

		// Verify indeterminate state
		const isIndeterminate = await gitGroup.locator("[data-tool-group-checkbox]").evaluate((el: HTMLInputElement) => el.indeterminate);
		assert.equal(isIndeterminate, true, "Group checkbox must be indeterminate when partially selected");
		assert.match(await gitGroup.locator(".tool-group-count").textContent() ?? "", /\(1\/2\)/);

		// Search filtering: search "status"
		await page.locator("[data-tool-picker-search]").fill("status");
		assert.equal(await gitGroup.locator('[data-tool-checkbox][data-tool-name="git_status"]').isVisible(), true);
		assert.equal(await gitGroup.locator('[data-tool-checkbox][data-tool-name="git_commit"]').isVisible(), false);
		assert.equal(await fsGroup.isVisible(), false);

		// Clear search
		await page.locator("[data-tool-picker-search]").fill("");
		assert.equal(await fsGroup.isVisible(), true);

		// Close picker
		await page.locator("[data-tool-picker-done]").click();
		assert.equal(await page.locator("[data-tool-picker-panel]").isVisible(), false);

		// =========================================================================
		// 2. NO FUTURE-TOOL AUTO SELECTION ON REFRESH
		// =========================================================================
		// Catalog adds git_push to Git group
		await page.evaluate(() => {
			const res = (window as any).__getPolicyResources();
			res.tools.push({
				name: "git_push",
				description: "Git push",
				source: "git",
				group: { id: "git", label: "Git VCS" },
			});
			(window as any).__setPolicyResources(res);
		});

		// Reopen picker
		await page.locator("[data-tool-picker-trigger]").first().click();
		await page.locator("[data-tool-picker-panel]").waitFor();

		// Expand git group to inspect git_push if not already visible
		if (!await gitGroup.locator(".tool-group-items").isVisible()) {
			await gitGroup.locator("[data-tool-group-toggle]").click();
		}

		// Verify git_push is NOT silently selected!
		selected = await page.evaluate(() => (window as any).__getStandaloneSelected());
		assert.ok(!selected.includes("git_push"), "New catalog tool in group must NOT be auto-selected");
		const pushChecked = await gitGroup.locator('[data-tool-checkbox][data-tool-name="git_push"]').isChecked();
		assert.equal(pushChecked, false);

		await page.locator("[data-tool-picker-close]").click();

		// =========================================================================
		// 3. UNKNOWN SAVED TOOL NAMES AND WILDCARDS PERSIST
		// =========================================================================
		await page.evaluate(() => {
			(window as any).__setStandaloneSelected(["unknown_custom_tool", "browser-*"]);
		});

		await page.locator("[data-tool-picker-trigger]").first().click();
		await page.locator("[data-tool-picker-panel]").waitFor();

		const unknownGroup = page.locator('[data-tool-group="unknown"]');
		await unknownGroup.waitFor();
		assert.match(await unknownGroup.locator(".tool-group-name").textContent() ?? "", /Custom \/ Unknown/);
		// Expand unknown group
		await unknownGroup.locator("[data-tool-group-toggle]").click();
		assert.equal(await unknownGroup.locator('[data-tool-checkbox][data-tool-name="unknown_custom_tool"]').isChecked(), true);
		assert.equal(await unknownGroup.locator('[data-tool-checkbox][data-tool-name="browser-*"]').isChecked(), true);

		// Selection was not cleaned up
		selected = await page.evaluate(() => (window as any).__getStandaloneSelected());
		assert.deepEqual(selected, ["unknown_custom_tool", "browser-*"]);

		await page.locator("[data-tool-picker-done]").click();

		// =========================================================================
		// 4. GROUPING NO PROVENANCE: NO GUESSED PREFIX GROUPING
		// =========================================================================
		// bash_exec has no group metadata -> must be in "other" group, NOT a guessed "bash" group!
		await page.locator("[data-tool-picker-trigger]").first().click();
		await page.locator('[data-tool-group="other"] [data-tool-group-toggle]').click();
		const otherItems = await page.locator('[data-tool-group="other"] [data-tool-item]').allTextContents();
		assert.ok(otherItems.some((text) => text.includes("bash_exec")), "Tools without group metadata must go to Other");
		assert.equal(await page.locator('[data-tool-group="bash"]').count(), 0, "Must not invent guessed prefix groups");

		await page.locator("[data-tool-picker-done]").click();

		// =========================================================================
		// 5. POLICY EDITOR: CUSTOM DEFAULTS (absent vs [], allow/deny edit preserves initial)
		// =========================================================================
		await page.locator("#tabPolicyBtn").click();
		await page.locator('[data-policy-row][data-policy-kind="tools"]').waitFor();

		// Verify initial state: stack tools initial is absent (undefined)
		let currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.tools.initial, undefined, "Initial must be absent on mount");
		assert.equal(await page.evaluate(() => (window as any).__getDirty()), false, "Mount must never dirty stack");
		assert.equal(await page.locator("[data-custom-defaults-toggle]").isChecked(), false);
		assert.equal(await page.locator("[data-custom-defaults-body]").isVisible(), false);

		// Check the custom defaults toggle
		await page.locator("[data-custom-defaults-toggle]").check();
		assert.equal(await page.locator("[data-custom-defaults-body]").isVisible(), true);
		assert.equal(await page.evaluate(() => (window as any).__getDirty()), true, "Enabling custom defaults marks dirty");

		// Explanation and save note are shown
		assert.match(await page.locator("[data-custom-defaults-help]").textContent() ?? "", /Permitted tools define the ceiling/);
		assert.match(await page.locator("[data-save-never-activates]").textContent() ?? "", /Saving the active preset refreshes its live policy/);

		// Initial is seeded from current allow selection (read, write)
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.tools.initial, ["read", "write"]);
		assert.equal(await page.locator("[data-selected-default-tools] .selected-pattern-chip").count(), 2);

		// Remove "read" and "write" from defaults -> initial becomes [] (zero defaults)
		await page.locator('[data-remove-default-tool="read"]').click();
		await page.locator('[data-remove-default-tool="write"]').click();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.tools.initial, [], "Empty defaults must be [] (distinct from absent)");
		assert.equal(await page.locator("[data-no-default-tools]").isVisible(), true);
		assert.match(await page.locator("[data-no-default-tools]").textContent() ?? "", /0 default tools/);

		// Edit allow/deny patterns: add bash_exec to patternsText
		await page.locator('[data-policy-row][data-policy-kind="tools"] details.advanced > summary').click();
		await page.locator('[data-policy-row][data-policy-kind="tools"] [data-policy-patterns]').fill("read\nwrite\nbash_exec");
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.tools.allow, ["read", "write", "bash_exec"]);
		// CRITICAL: editing allow/deny must NOT strip initial!
		assert.deepEqual(currentStack.tools.initial, [], "Editing allow patterns must NOT strip initial");

		// Uncheck custom defaults toggle -> removes only initial
		await page.locator("[data-custom-defaults-toggle]").uncheck();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.tools.initial, undefined, "Disabling custom defaults removes only initial");
		assert.deepEqual(currentStack.tools.allow, ["read", "write", "bash_exec"], "Allow list remains untouched");

		// Skills row has no initial
		assert.equal(currentStack.skills.initial, undefined, "Skills must never receive initial");

		// Test allow:['*'] unrestricted baseline (never fall back to all catalog tools)
		await page.locator('[data-policy-row][data-policy-kind="tools"] [data-policy-patterns]').fill("*");
		await page.locator("[data-custom-defaults-toggle]").check();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.tools.initial, ["read", "write"], "allow:['*'] seeds active baseline only, not all catalog tools");

		// Disable custom defaults again
		await page.locator("[data-custom-defaults-toggle]").uncheck();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.tools.initial, undefined);

		// Test no active tools: must seed [], never guess all catalog
		await page.evaluate(() => {
			const res = (window as any).__getPolicyResources();
			for (const t of res.tools) t.active = false;
			(window as any).__setPolicyResources(res);
		});
		await page.locator("[data-custom-defaults-toggle]").check();
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.tools.initial, [], "When no active tools, custom defaults seeds [] (zero tools), never all catalog");

		// Restore active flags
		await page.evaluate(() => {
			const res = (window as any).__getPolicyResources();
			res.tools.find((t: any) => t.name === "read").active = true;
			res.tools.find((t: any) => t.name === "write").active = true;
			(window as any).__setPolicyResources(res);
		});
		await page.locator("[data-custom-defaults-toggle]").uncheck();

		// =========================================================================
		// 6. CAPABILITY EDITOR: Catalog wiring, picker, and error fallback
		// =========================================================================
		await page.locator("#tabCapabilityBtn").click();
		await page.locator("#capabilityId").waitFor();

		// Add tools using picker
		await page.locator("[data-capability-tools-add-picker] [data-tool-picker-trigger]").click();
		await page.locator("[data-capability-tools-add-picker] [data-tool-picker-panel]").waitFor();
		await page.locator('[data-capability-tools-add-picker] [data-tool-group="filesystem"] [data-tool-group-checkbox]').click();
		await page.locator("[data-capability-tools-add-picker] [data-tool-picker-done]").click();

		// Verify added to tags
		const tags = await page.locator(".capability-tag.add").allTextContents();
		assert.ok(tags.some((t) => t.includes("read")));
		assert.ok(tags.some((t) => t.includes("write")));
		assert.equal(await page.locator(".capability-dirty-badge").isVisible(), true);

		// Simulate catalog 500 error: manual entry remains intact
		shouldFailResources = true;
		await page.locator("[data-capability-tools-add-picker] [data-tool-picker-trigger]").click();
		const failPickerPanel = page.locator("[data-capability-tools-add-picker] [data-tool-picker-panel]");
		await failPickerPanel.waitFor();
		await failPickerPanel.locator("[data-tool-picker-refresh]").click();
		await failPickerPanel.locator("[data-tool-picker-error]").waitFor();
		assert.equal(await failPickerPanel.locator("[data-tool-picker-error]").isVisible(), true);
		await failPickerPanel.locator(".tool-picker-manual summary").click();
		await failPickerPanel.locator("[data-tool-manual-input]").fill("manual_offline_tool");
		await failPickerPanel.locator("[data-tool-manual-btn]").click();
		await failPickerPanel.locator("[data-tool-picker-done]").click();
		const updatedTags = await page.locator(".capability-tag.add").allTextContents();
		assert.ok(updatedTags.some((t) => t.includes("manual_offline_tool")));
		shouldFailResources = false;

		// =========================================================================
		// 7. PRESET BINDING EDITOR: Finite overrides undefined vs [] vs custom
		// =========================================================================
		await page.locator("#tabBindingBtn").click();
		await page.locator("[data-binding-advanced-toggle]").first().click();
		await page.locator("[data-binding-tools-add-mode]").first().waitFor();

		// Switch to custom mode
		await page.locator("[data-binding-tools-add-mode]").first().selectOption("custom");
		// Verify picker is rendered for custom mode
		const bindingPicker = page.locator("[data-binding-tools-add-picker]");
		await bindingPicker.waitFor();

		// Pick tool
		await bindingPicker.locator("[data-tool-picker-trigger]").click();
		// Expand filesystem group
		await page.locator('[data-tool-group="filesystem"] [data-tool-group-toggle]').click();
		await page.locator('[data-tool-checkbox][data-tool-name="read"]').check();
		await page.locator("[data-tool-picker-done]").click();

		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.capabilities[0].overrides.tools.add, ["lint", "read"]);

		// Clear tools via custom text input to explicit empty []
		await page.locator("[data-binding-tools-add-input]").first().fill("");
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.capabilities[0].overrides.tools.add, []);

		// Switch to omitted
		await page.locator("[data-binding-tools-add-mode]").first().selectOption("omitted");
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.equal(currentStack.capabilities[0].overrides?.tools?.add, undefined);

		// Switch back to custom initiates explicit empty []
		await page.locator("[data-binding-tools-add-mode]").first().selectOption("custom");
		currentStack = await page.evaluate(() => (window as any).__getTestStack());
		assert.deepEqual(currentStack.capabilities[0].overrides.tools.add, []);

		// =========================================================================
		// 8. BILINGUAL LOCALIZATION (en vs zh-CN)
		// =========================================================================
		await page.locator("#tabPolicyBtn").click();
		await page.locator("#localeSelect").selectOption("zh-CN");

		// Chinese translations
		assert.match(await page.locator("[data-custom-defaults-toggle]").locator("..").textContent() ?? "", /自定义默认激活工具/);
		assert.match(await page.locator("[data-custom-defaults-help]").textContent() ?? "", /许可工具定义了上限；这组工具是当前预设的基础/);
		assert.match(await page.locator('[data-permitted-tools-picker] [data-tool-picker-trigger]').textContent() ?? "", /选择允许工具…/);

		// Open picker in Chinese
		await page.locator('[data-permitted-tools-picker] [data-tool-picker-trigger]').click();
		await page.locator('[data-tool-group="other"]').waitFor();
		assert.equal(await page.locator('[data-tool-group="other"] .tool-group-name').textContent(), "其它");
		assert.equal(await page.locator("[data-tool-picker-done]").textContent(), "完成");
		await page.locator("[data-tool-picker-done]").click();

		// Switch back to English
		await page.locator("#localeSelect").selectOption("en");
		assert.match(await page.locator("[data-custom-defaults-toggle]").locator("..").textContent() ?? "", /Customize default active tools/);

		// =========================================================================
		// 9. LIVE EXECUTION SAFETY
		// =========================================================================
		assert.deepEqual(
			activationCalls,
			[],
			"Tool picker and policy editing must NEVER trigger live activation or execution mutations",
		);
	} finally {
		await browser?.close();
		server.close();
	}
});
