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

const executablePath = [
	process.env.CHROME_PATH,
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
].find((path): path is string => !!path && existsSync(path));

test("complete built App: modes CRUD, preset bindings, guarded use, stale 409, snapshot", { timeout: 45_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	assert.ok(executablePath, "Set CHROME_PATH to run browser acceptance.");
	const cwd = mkdtempSync(join(tmpdir(), "forge-lib-ui-"));
	const root = join(cwd, ".pi", "forge");
	mkdirSync(join(root, "instruction-modes"), { recursive: true });
	mkdirSync(join(root, "prompt-stacks"), { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ webEditor: { locale: "en" } }));
	writeFileSync(join(root, "prompt-stacks", "base.json"), JSON.stringify({
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "base",
		name: "UI acceptance fixture",
		autoActivate: true,
		mode: "replace",
		items: [{ id: "role", kind: "block", role: "system", content: "Offline fixture." }],
	}));

	let harness: InstructionAgentHarness | undefined;
	let browser: Browser | undefined;
	let server: WebEditorServer | undefined;
	const quietPrompt = async (text: string) => {
		const log = console.log;
		console.log = () => {};
		try { await harness!.prompt(text); } finally { console.log = log; }
	};

	try {
		harness = await createInstructionAgentHarness({
			cwd,
			native: true,
			responses: ["Fixture ready."],
		});
		await quietPrompt("Seed historical tool declaration.");
		assert.equal(harness.streamContexts.length, 1);
		await quietPrompt("/preset ui");
		server = (globalThis as typeof globalThis & { __piForgeWebEditor?: { byCwd: Record<string, { server?: WebEditorServer }> } }).__piForgeWebEditor?.byCwd[cwd]?.server;
		assert.ok(server);

		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
		page.on("dialog", dialog => dialog.accept());
		const errors: string[] = [];
		page.on("pageerror", err => errors.push(err.message));
		page.on("console", msg => {
			if (msg.type() === "error" && !/409|Failed to load resource/i.test(msg.text())) {
				errors.push(msg.text());
			}
		});
		await page.goto(server.url);

		// 1. Modes surface: create and save definition without session events or inference
		await page.locator("#modesSurfaceBtn").click();
		await page.locator("#modeNewBtn").click();
		await page.locator("#modeId").fill("guard");
		await page.locator("#modeName").fill("Guard Mode");
		await page.locator("#modeDescription").fill("Safety checks");
		const xssContent = "Read-only inspection rules.<img src=x onerror=alert(1)>";
		await page.locator("#modeContent").fill(xssContent);
		await page.locator("#modeToolRemoveInput").fill("fake_write");
		await page.locator("#modeToolRemoveBtn").click();
		await page.locator("#modeSaveBtn").click();
		await page.locator("[data-mode-row]").filter({ hasText: "Guard Mode" }).waitFor();
		const modePath = join(root, "instruction-modes", "guard.json");
		assert.ok(existsSync(modePath));
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "saving mode definition must not modify live tools");
		assert.equal(harness.streamContexts.length, 1);

		// 2. Preset metadata: bind scoped ref, modelCallable false/true, overrides, save with sourceRevision
		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#reloadBtn").click();
		await page.locator("#bindingsTabBtn").click();
		await page.locator("#addBindingBtn").waitFor();
		await page.locator("#addBindingBtn").click();
		const bindingRow = page.locator("[data-binding-row]").first();
		await bindingRow.waitFor();
		await bindingRow.locator("[data-binding-ref]").selectOption("project:guard");
		await bindingRow.locator("[data-binding-id]").fill("guard-bind");
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), false);
		await bindingRow.locator("[data-binding-model-callable]").check();
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), true);
		await bindingRow.locator("[data-binding-model-callable]").uncheck();
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), false);
		await bindingRow.locator("[data-binding-model-callable]").check();
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), true);
		if (process.env.PI_FORGE_UI_ARTIFACT_DIR) {
			mkdirSync(process.env.PI_FORGE_UI_ARTIFACT_DIR, { recursive: true });
			await page.screenshot({ path: join(process.env.PI_FORGE_UI_ARTIFACT_DIR, "bindings.png") });
		}
		await bindingRow.locator("[data-binding-advanced-toggle]").click();
		await bindingRow.locator("[data-binding-content-mode]").selectOption("append");
		await bindingRow.locator("[data-binding-append-content]").fill(" Appended audit note.");
		await bindingRow.locator("[data-binding-preview]").waitFor();
		assert.match(await bindingRow.locator("[data-binding-source-content]").textContent() || "", /Read-only inspection rules/);
		assert.match(await bindingRow.locator("[data-binding-effective-content]").textContent() || "", /Appended audit note/);
		assert.equal(await bindingRow.locator(".preview-pre img").count(), 0, "preview escapes literal XSS tags");

		// Tab switch preserves live draft
		await page.locator("#policyTabBtn").click();
		await page.locator('[data-policy-row][data-policy-kind="tools"]').waitFor();
		await page.locator("#bindingsTabBtn").click();
		const restoredRow = page.locator("[data-binding-row]").first();
		await restoredRow.waitFor();
		assert.equal(await restoredRow.locator("[data-binding-id]").inputValue(), "guard-bind");
		assert.equal(await restoredRow.locator("[data-binding-model-callable]").isChecked(), true);
		await restoredRow.locator("[data-binding-advanced-toggle]").click();
		assert.equal(await restoredRow.locator("[data-binding-content-mode]").inputValue(), "append");
		assert.equal(await restoredRow.locator("[data-binding-append-content]").inputValue(), " Appended audit note.");

		await page.locator("#saveBtn").click();
		await page.waitForFunction(() => !document.getElementById("dirtyBadge")?.classList.contains("visible"));
		const baseJson = JSON.parse(readFileSync(join(root, "prompt-stacks", "base.json"), "utf8"));
		assert.equal(baseJson.instructionModes?.[0]?.ref, "project:guard");
		assert.equal(baseJson.instructionModes?.[0]?.modelCallable, true);
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "preset save must not activate instructions");
		assert.equal(harness.streamContexts.length, 1);

		// Reopen/reload preset verifies persisted bindings and sourceRevision
		await page.locator("#reloadBtn").click();
		await page.locator("#bindingsTabBtn").click();
		const reloadedRow = page.locator("[data-binding-row]").first();
		await reloadedRow.waitFor();
		assert.equal(await reloadedRow.locator("[data-binding-id]").inputValue(), "guard-bind");
		assert.equal(await reloadedRow.locator("[data-binding-model-callable]").isChecked(), true);

		// 3. Expanded Session panel: load guarded choices, use bound instruction, observe tool removal
		const panel = page.locator("[data-session-instructions]");
		await panel.locator("[data-instructions-toggle]").click();
		await panel.locator("[data-instructions-body]").waitFor();
		await panel.locator("[data-instructions-catalog-load]").click();
		const selectEl = panel.locator("[data-instructions-picker-select]");
		await selectEl.locator("option[value='binding:guard-bind']").waitFor({ state: "attached" });
		const optValues = await selectEl.locator("option").evaluateAll(opts => opts.map(o => (o as HTMLOptionElement).value));
		assert.ok(optValues.includes("binding:guard-bind"), "bound preset choice loaded");
		assert.ok(optValues.includes("mode:project:guard"), "unbound library choice loaded");
		await selectEl.selectOption("binding:guard-bind");
		await panel.locator("[data-instructions-picker-preview]").waitFor();
		assert.match(await panel.locator("[data-instructions-picker-preview]").textContent() || "", /fake_write/);
		await panel.locator("[data-instructions-use-btn]").click();
		const activeCard = panel.locator(".active-item-card").first();
		await activeCard.waitFor();
		assert.ok(!harness.getActiveToolNames().includes("fake_write"), "active instruction removes fake_write tool");
		assert.doesNotMatch(await panel.locator("[data-instructions-tools-list]").textContent() || "", /fake_write/);
		await activeCard.locator("[data-item-content-summary]").click();
		const activeBody = await activeCard.locator("[data-item-content-text]").textContent() || "";
		assert.match(activeBody, /<img src=x onerror=alert\(1\)>/);
		assert.equal(await activeCard.locator("[data-item-content-text] img").count(), 0, "active content renders literal XSS safely");

		// 4. Editing source while active leaves the active snapshot intact
		const diskMode = JSON.parse(readFileSync(modePath, "utf8"));
		writeFileSync(modePath, JSON.stringify({ ...diskMode, content: "Tampered disk content." }));
		const snapshotText = await activeCard.locator("[data-item-content-text]").textContent() || "";
		assert.match(snapshotText, /Read-only inspection rules/);
		assert.doesNotMatch(snapshotText, /Tampered disk content/);

		// 5. Stale actual source edit returns 409 conflict
		const staleResult = await page.evaluate(async () => {
			const token = new URLSearchParams(location.search).get("token") || "";
			const state = await fetch("/api/instructions", { headers: { "x-pi-forge-token": token } }).then(r => r.json());
			const res = await fetch("/api/instructions/use", {
				method: "POST",
				headers: { "x-pi-forge-token": token, "content-type": "application/json" },
				body: JSON.stringify({
					guard: state.state.guard,
					kind: "mode",
					id: "project:guard",
					fingerprint: "stale-pre-modification-fingerprint-0000",
				}),
			});
			return { status: res.status, body: await res.json() };
		});
		assert.equal(staleResult.status, 409);
		assert.match(staleResult.body.error, /Instruction (source|binding) changed/);

		// 6. Off and reset restore original tools
		await activeCard.locator("[data-item-deactivate-btn]").click();
		await panel.locator("[data-instructions-empty]").waitFor();
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "deactivation restores fake_write");

		await panel.locator("[data-instructions-catalog-load]").click();
		await selectEl.locator("option[value='mode:project:guard']").waitFor({ state: "attached" });
		await selectEl.selectOption("mode:project:guard");
		await panel.locator("[data-instructions-use-btn]").click();
		await panel.locator(".active-item-card").first().waitFor();
		assert.ok(!harness.getActiveToolNames().includes("fake_write"));
		await panel.locator("[data-instructions-reset-btn]").click();
		await panel.locator("[data-instructions-confirm-reset-btn]").click();
		await panel.locator("[data-instructions-empty]").waitFor();
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "reset restores fake_write");

		// 7. Locale switching verifies bilingual chrome
		await page.locator("#localeSelect").selectOption("zh-CN");
		await page.waitForFunction(() => document.getElementById("modesSurfaceBtn")?.textContent?.includes("模式"));
		await page.locator("#localeSelect").selectOption("en");
		await page.waitForFunction(() => document.getElementById("modesSurfaceBtn")?.textContent?.includes("Modes"));

		assert.equal(harness.streamContexts.length, 1, "only 1 initial seed turn; zero management inference");
		assert.equal(harness.fetchAttempts, 0, "zero network fetch attempts");
		assert.deepEqual(errors, [], "no console or page errors except expected 409");
	} finally {
		try { await browser?.close(); } finally {
			try { if (harness && server) await quietPrompt("/preset ui stop"); } finally {
				try { await harness?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
			}
		}
	}
});
