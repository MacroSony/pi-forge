import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createInstructionAgentHarness, type InstructionAgentHarness } from "../tests/helpers/instruction-agent-harness.ts";
import type { WebEditorPreview, WebEditorServer } from "../src/web-editor/types.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();

// Unlike isolated component fixtures, this serves the built complete App through
// the real Forge factory/SDK/HTTP coordinator. Only the model and tools are fake.
for (const native of [false, true]) {
test(`built editor uses projected text and separate tools without management inference (${native ? "native" : "fallback"})`, { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
	assert.ok(executablePath, "Set CHROME_PATH to run browser acceptance.");
	const cwd = mkdtempSync(join(tmpdir(), "forge-session-ui-"));
	const root = join(cwd, ".pi", "forge");
	mkdirSync(join(root, "instruction-modes"), { recursive: true });
	mkdirSync(join(root, "prompt-stacks"), { recursive: true });
	writeFileSync(join(root, "config.json"), JSON.stringify({ webEditor: { locale: "zh-CN" } }));
	writeFileSync(join(root, "prompt-stacks", "base.json"), JSON.stringify({ schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "UI acceptance fixture", autoActivate: true, mode: "replace", items: [{ id: "role", kind: "block", role: "system", content: "Offline fixture." }] }));
	writeFileSync(join(root, "instruction-modes", "review.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.instruction-mode", id: "review", name: "审查模式", content: "只读检查，不修改文件。<img src=x onerror=alert(1)>", tools: { add: [], remove: ["fake_write"] } }));
	let harness: InstructionAgentHarness | undefined;
	let browser: Browser | undefined;
	let server: WebEditorServer | undefined;
	const quietPrompt = async (text: string) => {
		const log = console.log;
		console.log = () => {}; // Never save ephemeral editor bearer tokens.
		try { await harness!.prompt(text); } finally { console.log = log; }
	};
	try {
		harness = await createInstructionAgentHarness({
			cwd,
			native,
			responses: [
				"Fixture ready.",
				"First dialogue response after review mode.",
				"Second dialogue response after rule addition.",
			],
		});
		await quietPrompt("Seed a historical tool declaration.");
		assert.equal(harness.streamContexts.length, 1);
		// Public session record fixture: a Pi base-only refresh, like the user's empty card.
		harness.manager.appendMessage({role: "system", content: "", sections: {tools: "Base tool descriptions", rules: "Base rules"}, timestamp: Date.now()});
		await quietPrompt("/system-update use project:review");
		await quietPrompt("Ordinary user dialogue after mode activation.");
		assert.equal(harness.streamContexts.length, 2);
		await quietPrompt("/system-update add 回答简洁，保留必要的风险说明。");
		await quietPrompt("Ordinary user dialogue after rule update.");
		assert.equal(harness.streamContexts.length, 3);
		await quietPrompt("/preset ui");
		server = (globalThis as typeof globalThis & { __piForgeWebEditor?: { byCwd: Record<string, { server?: WebEditorServer }> } }).__piForgeWebEditor?.byCwd[cwd]?.server;
		assert.ok(server);
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
		const errors: string[] = [], externalRequests: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		page.on("console", message => {
			if (/duplicate keys/i.test(message.text())) errors.push(message.text());
		});
		await page.route("**/*", route => {
			const url = new URL(route.request().url());
			if (url.hostname === "127.0.0.1") return route.continue();
			externalRequests.push(url.origin);
			return route.abort();
		});
		await page.goto(server.url);
		const panel = page.locator("[data-session-instructions]");
		await panel.locator("[data-instructions-active-badge]").waitFor();
		await panel.locator("[data-instructions-toggle]").click();
		await panel.locator(".active-item-card").nth(1).waitFor();
		assert.equal(await panel.locator(".active-item-card").count(), 2);
		assert.ok(!harness.getActiveToolNames().includes("fake_write"));
		await panel.locator("[data-item-content-summary]").first().click();
		assert.match(await panel.locator("[data-item-content-text]").first().textContent() || "", /<img/);
		assert.equal(await panel.locator("[data-item-content-text] img").count(), 0, "snapshot body is text, not executable HTML");
		const entriesBeforePreview = JSON.stringify(harness.manager.getEntries());
		await page.locator("#previewTabBtn").click();
		const compiled = page.locator(".context-diff-compiled");
		await page.waitForFunction(() => document.querySelector(".context-diff-compiled")?.textContent?.includes("只读检查，不修改文件。"));
		assert.match(await compiled.textContent() || "", /Forge instruction update/);
		assert.doesNotMatch(await compiled.textContent() || "", /Forge instruction state changed/);
		assert.equal(await compiled.locator(".section-text img").count(), 0);
		assert.equal(JSON.stringify(harness.manager.getEntries()), entriesBeforePreview);

		const apiPreviewData = await page.evaluate(async () => {
			const token = new URLSearchParams(location.search).get("token") || "";
			const loaded = await fetch("/api/stacks/base", {
				headers: { "x-pi-forge-token": token },
			}).then(r => r.json());
			return await fetch("/api/stacks/base/preview", {
				method: "POST",
				headers: { "x-pi-forge-token": token, "content-type": "application/json" },
				body: JSON.stringify({ stack: loaded.stack }),
			}).then(r => {
				if (!r.ok) throw new Error(`Preview request failed: ${r.status}`);
				return r.json();
			});
		}) as { preview: WebEditorPreview };
		// This fixture has a nonempty leading System; the backend already filters
		// genuinely empty subsequent System cards. Compare the complete API list.
		assert.ok(apiPreviewData.preview.system.content);
		const expectedApiSections = [apiPreviewData.preview.system, ...apiPreviewData.preview.messages];
		const expectedTitles = expectedApiSections.map(s => (s.title || s.id).trim());
		const domTitles = (await compiled.locator(".context-diff-sections .context-diff-section .section-title").allTextContents()).map(s => s.trim());
		assert.deepEqual(domTitles, expectedTitles, "DOM sections must strictly match API section order");

		const groupKeys = await compiled.locator("[data-group-key]").evaluateAll(els => els.map(e => e.getAttribute("data-group-key")));
		assert.ok(groupKeys.length >= 3, "must have multiple consecutive groups");
		assert.equal(new Set(groupKeys).size, groupKeys.length, "rendered group keys must be unique");

		const sectionIds = await compiled.locator(".context-diff-sections .context-diff-section").evaluateAll(els => els.map(e => e.getAttribute("data-section-id")));
		assert.equal(new Set(sectionIds).size, sectionIds.length, "rendered section ids must be unique");
		assert.deepEqual(sectionIds, expectedApiSections.map(s => s.id),
			"match identities too: two updates with the same title must not swap places");
		const selectedTools = compiled.locator(".preview-selected-tools-panel");
		assert.doesNotMatch(await selectedTools.textContent() || "", /fake_write/);
		assert.match(await selectedTools.textContent() || "", /fake_read/);
		const systemCard = compiled.locator(".context-diff-section.role-system").first();
		assert.equal(await systemCard.locator(".section-text").first().textContent(), "Offline fixture.");
		assert.doesNotMatch((await compiled.locator(".section-text").allTextContents()).join("\n"), /Added tool/);
		assert.equal(await systemCard.locator(".preview-tool-changes").getAttribute("open"), null);
		await systemCard.locator(".tool-changes-summary").click();
		assert.match(await systemCard.locator(".preview-tool-changes").textContent() || "", /fake_write/);
		await systemCard.locator(".tool-changes-summary").click();
		const systems = compiled.locator(".context-diff-section.role-system");
		assert.equal(await systems.count(), native ? 4 : 2, "base, tool-change history, and meaningful rule updates; empty refresh hidden");
		if (native) {
			assert.equal(await compiled.locator(".preview-named-section").count(), 2);
			assert.doesNotMatch((await compiled.locator(".section-text").allTextContents()).join("\n"), /Updated system prompt section/);
		}
		const shots = process.env.PI_FORGE_UI_SCREENSHOT_DIR;
		if (shots) {
			mkdirSync(shots, { recursive: true });
			await panel.locator("[data-instructions-toggle]").click();
			await compiled.evaluate(el => { el.scrollTop = 0; });
			await page.screenshot({ path: join(shots, `session-panel-${native ? "native" : "fallback"}.png`), fullPage: true });
			await panel.locator("[data-instructions-toggle]").click();
		}
		await panel.locator("[data-item-deactivate-btn]").first().click();
		await page.waitForFunction(() => document.querySelectorAll("[data-session-instructions] .active-item-card").length === 1);
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "browser off reaches the real tool owner");
		await compiled.locator(".context-diff-refresh").click();
		await page.waitForFunction((isNative) => isNative
			? !!document.querySelector(".context-diff-compiled .op-removed")
			: document.querySelector(".context-diff-compiled")?.textContent?.includes("Removed system prompt section"), native);
		assert.match(await selectedTools.textContent() || "", /fake_write/);
		assert.equal(harness.beforeAgentStartEvents.length, 3, "only the intentional dialogue turns; preview/controls add none");


		await panel.locator("[data-instructions-reset-btn]").click();
		await panel.locator("[data-instructions-reset-confirm-group]").waitFor();
		await quietPrompt("/system-update add NEW_RULE_WHILE_CONFIRMING");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForFunction(() => document.querySelectorAll("[data-session-instructions] .active-item-card").length === 2);
		assert.equal(await panel.locator("[data-instructions-reset-confirm-group]").count(), 0, "real CLI change invalidates the pending browser confirmation");
		await panel.locator("[data-instructions-reset-btn]").click();
		await panel.locator("[data-instructions-confirm-reset-btn]").click();
		await panel.locator("[data-instructions-empty]").waitFor();
		assert.ok(harness.getActiveToolNames().includes("fake_write"));
		assert.equal(harness.streamContexts.length, 3);
		assert.equal(harness.fetchAttempts, 0);
		assert.deepEqual(errors, []);
		assert.deepEqual(externalRequests, []);
	} finally {
		try { await browser?.close(); } finally {
			try { if (harness && server) await quietPrompt("/preset ui stop"); } finally {
				try { await harness?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
			}
		}
	}
});

}
