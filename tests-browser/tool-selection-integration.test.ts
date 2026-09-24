import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createInstructionAgentHarness, type InstructionAgentHarness } from "../tests/helpers/instruction-agent-harness.ts";
import type { WebEditorServer } from "../src/web-editor/types.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();

const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")].find((path): path is string => !!path && existsSync(path));

test("built App default tools: cross-preset isolation, source picker, save/use/preview/off", { timeout: 45_000 }, async t => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	assert.ok(executablePath);
	const cwd = mkdtempSync(join(tmpdir(), "forge-lazy-tools-ui-"));
	const root = join(cwd, ".pi", "forge");
	mkdirSync(join(root, "prompt-stacks"), { recursive: true });
	mkdirSync(join(root, "instruction-modes"), { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ webEditor: { locale: "en" } }));
	const allowed = ["fake_read", "fake_write", "forge_system_update"];
	const base = { schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "BASE CURRENT", autoActivate: true, tools: { allow: allowed }, items: [{ id: "role", kind: "block", role: "system", content: "Offline test." }, { id: "tool-list", kind: "slot", slot: "tools", role: "system", options: { format: "plain" } }] };
	writeFileSync(join(root, "prompt-stacks", "base.json"), JSON.stringify(base));
	writeFileSync(join(root, "prompt-stacks", "lazy.json"), JSON.stringify({ ...base, id: "lazy", name: "LAZY DRAFT", autoActivate: false, tools: { allow: allowed, initial: [] } }));
	let harness: InstructionAgentHarness | undefined;
	let browser: Browser | undefined;
	let server: WebEditorServer | undefined;
	try {
		harness = await createInstructionAgentHarness({ cwd, native: true, allowedTools: [...allowed, "fake_driver"], initialTools: allowed, responses: ["seed"] });
		await harness.prompt("seed");
		const log = console.log;
		try { console.log = () => {}; await harness.prompt("/preset ui"); } finally { console.log = log; }
		server = (globalThis as any).__piForgeWebEditor?.byCwd[cwd]?.server;
		assert.ok(server);
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
		page.setDefaultTimeout(6000);
		page.on("dialog", dialog => dialog.accept());
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.goto(server.url);
		await page.locator("#policyTabBtn").click();
		assert.equal(await page.locator("[data-custom-defaults-toggle]").isChecked(), false);
		await page.locator(".stack-row").filter({ hasText: "LAZY DRAFT" }).click();
		await page.locator("#status").filter({ hasText: "Loaded lazy" }).waitFor();
		assert.equal(await page.locator("[data-custom-defaults-toggle]").isChecked(), true, "unmounting previous tab must not copy old policy into newly loaded preset");
		assert.equal(await page.locator("[data-no-default-tools]").count(), 1, "saved empty initial remains empty after switch");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "browsing does not alter draft");

		await page.locator("[data-default-tools-picker] [data-tool-picker-trigger]").click();
		const panel = page.locator("[data-tool-picker-panel]");
		assert.equal(await panel.locator('[data-tool-group="other"]').count(), 0, "real policy catalog retains SDK provenance through client normalization");
		assert.ok(await panel.locator("[data-tool-group]").count() > 0);
		await panel.locator("[data-tool-picker-search]").fill("fake_read");
		await panel.locator('[data-tool-name="fake_read"]').check();
		await panel.locator("[data-tool-picker-search]").fill("forge_system_update");
		await panel.locator('[data-tool-name="forge_system_update"]').check();
		await panel.locator("[data-tool-picker-close]").click();
		await page.locator("#bindingsTabBtn").click();
		assert.equal(await page.locator("[data-binding-row]").count(), 0);
		await page.locator("#policyTabBtn").click();
		assert.equal(await page.locator("[data-selected-default-tools] .selected-pattern-chip").count(), 2);
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		const saved = JSON.parse(readFileSync(join(root, "prompt-stacks", "lazy.json"), "utf8"));
		assert.deepEqual(saved.tools.initial, ["fake_read", "forge_system_update"]);
		assert.equal(saved.instructionModes, undefined, "opening binding tab must not add empty bindings");
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "saving inactive preset does not select it");
		await page.locator("#reloadBtn").click();
		assert.equal(await page.locator("[data-selected-default-tools] .selected-pattern-chip").count(), 2);
		await page.locator("#activateBtn").click();
		await page.locator("#status").filter({ hasText: "Activated" }).waitFor();
		assert.deepEqual(harness.getActiveToolNames(), ["fake_read", "forge_system_update"]);

		await page.locator("#modesSurfaceBtn").click();
		await page.locator("#modeNewBtn").click();
		await page.locator("#modeId").fill("paint-test");
		await page.locator("#modeName").fill("Painter capability");
		await page.locator("#modeContent").fill("PAINT_TEST_RULE");
		await page.locator("[data-mode-tools-add-picker] [data-tool-picker-trigger]").click();
		await panel.locator("[data-tool-picker-search]").fill("fake_write");
		const group = panel.locator("[data-tool-group]").filter({ has: page.locator('[data-tool-name="fake_write"]') });
		await group.locator("[data-tool-group-checkbox]").check();
		const catalog = await page.evaluate(async () => {
			const token = new URLSearchParams(location.search).get("token") || "";
			return fetch("/api/resources", { headers: { "x-pi-forge-token": token } }).then(response => response.json());
		});
		catalog.tools.push({ ...catalog.tools.find((tool: any) => tool.name === "fake_write"), name: "fake_future", active: false, baselineActive: false });
		await page.route("**/api/resources", route => route.fulfill({ json: catalog }));
		await panel.locator("[data-tool-picker-refresh]").click();
		await panel.locator("[data-tool-picker-search]").fill("fake_");
		await panel.locator('[data-tool-name="fake_future"]').waitFor();
		assert.equal(await panel.locator('[data-tool-name="fake_future"]').isChecked(), false, "refresh never auto-grants new package members");
		assert.equal(await panel.locator('[data-tool-name="fake_write"]').isChecked(), true);
		await page.unroute("**/api/resources");
		if (process.env.PI_FORGE_UI_ARTIFACT_DIR) {
			mkdirSync(process.env.PI_FORGE_UI_ARTIFACT_DIR, { recursive: true });
			await page.screenshot({ path: join(process.env.PI_FORGE_UI_ARTIFACT_DIR, "tool-picker.png") });
		}
		const box = await panel.boundingBox();
		assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1281 && box.y + box.height <= 851, "picker fits the real app viewport");
		await panel.locator("[data-tool-picker-close]").click();
		await page.locator("#modeSaveBtn").click();
		await page.locator("[data-mode-row]").filter({ hasText: "Painter capability" }).waitFor();
		const savedMode = JSON.parse(readFileSync(join(root, "instruction-modes", "paint-test.json"), "utf8"));
		assert.deepEqual(savedMode.tools.add, ["fake_write"], "picker saves concrete tool names only");
		assert.equal(savedMode.tools.packages, undefined);
		assert.ok(!harness.getActiveToolNames().includes("fake_write"));
		await page.locator("#stacksSurfaceBtn").click();
		if (process.env.PI_FORGE_UI_ARTIFACT_DIR) await page.screenshot({ path: join(process.env.PI_FORGE_UI_ARTIFACT_DIR, "default-tools.png") });
		const sessionPanel = page.locator("[data-session-instructions]");
		await page.locator("#sessionSurfaceBtn").click();
		await sessionPanel.locator("[data-instructions-catalog-load]").click();
		const choices = sessionPanel.locator("[data-instructions-picker-select]");
		await choices.locator('option[value="mode:project:paint-test"]').waitFor({ state: "attached" });
		await choices.selectOption("mode:project:paint-test");
		await sessionPanel.locator("[data-instructions-use-btn]").click();
		await sessionPanel.locator(".active-item-card").waitFor();
		assert.ok(harness.getActiveToolNames().includes("fake_write"));
		const before = JSON.stringify(harness.manager.getEntries());
		const preview = await page.evaluate(async stack => {
			const token = new URLSearchParams(location.search).get("token") || "";
			const response = await fetch("/api/stacks/project%3Alazy/preview", { method: "POST", headers: { "x-pi-forge-token": token, "content-type": "application/json" }, body: JSON.stringify({ stack }) });
			return response.json();
		}, saved);
		assert.equal(preview.ok, true);
		assert.ok(preview.preview.selectedTools?.includes("fake_write"), JSON.stringify(preview));
		assert.match(preview.preview.system.content, /fake_write/, "preview tool slot uses effective loadout");
		assert.equal(JSON.stringify(harness.manager.getEntries()), before, "preview is read-only");
		await sessionPanel.locator("[data-item-deactivate-btn]").click();
		await sessionPanel.locator("[data-instructions-empty]").waitFor();
		assert.deepEqual(harness.getActiveToolNames(), ["fake_read", "forge_system_update"]);
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(harness.streamContexts.length, 1, "one deliberate seed only; management never infers");
		assert.equal(harness.fetchAttempts, 0);
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		try { if (harness && server) await harness.prompt("/preset ui stop"); } finally { await harness?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
	}
});
