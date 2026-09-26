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
	writeFileSync(join(root, "prompt-stacks", "scratch.json"), JSON.stringify({ schemaVersion: 2, type: "pi-forge.prompt-stack", id: "scratch", name: "Inactive scratch", mode: "replace", items: [{ id: "scratch-role", kind: "block", role: "system", content: "INACTIVE_SCRATCH" }] }));
	writeFileSync(join(root, "instruction-modes", "audit.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.instruction-mode", id: "audit", name: "Audit", content: "AUDIT_RULE", tools: { add: [], remove: ["fake_write"] } }));
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
		const seedMsg = {role: "system" as const, content: "", sections: {tools: "Base tool descriptions", rules: "Base rules"}, timestamp: Date.now()};
		harness.manager.appendMessage(seedMsg);
		harness.session.refreshContext();
		await quietPrompt("/instruction use project:review");
		await quietPrompt("Ordinary user dialogue after mode activation.");
		assert.equal(harness.streamContexts.length, 2);
		await quietPrompt("/instruction add 回答简洁，保留必要的风险说明。");
		await quietPrompt("Ordinary user dialogue after rule update.");
		assert.equal(harness.streamContexts.length, 3);
		await quietPrompt("/preset ui");
		server = (globalThis as typeof globalThis & { __piForgeWebEditor?: { byCwd: Record<string, { server?: WebEditorServer }> } }).__piForgeWebEditor?.byCwd[cwd]?.server;
		assert.ok(server);
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
		page.setDefaultTimeout(7000);
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
		const shots = process.env.PI_FORGE_UI_SCREENSHOT_DIR;
		if (shots) mkdirSync(shots, { recursive: true });
		const panel = page.locator("[data-session-instructions]");
		await panel.locator("[data-instructions-active-badge]").waitFor();
		await page.locator("#sessionSurfaceBtn").click();
		await panel.locator(".active-item-card").nth(1).waitFor();
		assert.equal(await panel.locator(".active-item-card").count(), 2);
		assert.ok(!harness.getActiveToolNames().includes("fake_write"));
		await panel.locator("[data-item-content-summary]").first().click();
		assert.match(await panel.locator("[data-item-content-text]").first().textContent() || "", /<img/);
		assert.equal(await panel.locator("[data-item-content-text] img").count(), 0, "snapshot body is text, not executable HTML");
		await panel.locator("[data-item-content-summary]").first().click();
		const entriesBeforePreview = JSON.stringify(harness.manager.getEntries());
		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#previewTabBtn").click();
		const compiled = page.locator("#contextDiffPanel .context-diff-compiled");
		await page.waitForFunction(() => document.querySelector("#contextDiffPanel .context-diff-compiled")?.textContent?.includes("只读检查，不修改文件。"));
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
		// The independent Session workspace must not replace the Preset editor dock.
		const sessionView = page.locator(".session-inspector");
		const sessionCompiled = sessionView.locator(".context-diff-compiled");
		await page.locator("#focus-toggle").click();
		assert.equal(await page.locator("#contextDiffPanel .context-diff-dock").getAttribute("data-reading"), "wide");
		await page.locator("#stackList .stack-row").filter({ hasText: "Inactive scratch" }).click();
		await page.waitForFunction(() => (document.getElementById("itemContent") as HTMLTextAreaElement)?.value === "INACTIVE_SCRATCH");
		await page.locator("#itemContent").fill("UNSAVED_DO_NOT_LEAK_INTO_SESSION");
		const dockWidth = (await page.locator("#contextDiffPanel").boundingBox())!.width;
		const entriesBeforeInspect = JSON.stringify(harness.manager.getEntries());
		await page.locator("#sessionSurfaceBtn").click();
		await page.waitForFunction(() => document.querySelector(".session-inspector .section-text")?.textContent === "Offline fixture.");
		assert.doesNotMatch(await sessionCompiled.textContent() || "", /UNSAVED_DO_NOT_LEAK|INACTIVE_SCRATCH/);
		assert.equal(await panel.locator("[data-instructions-tools-list]").isVisible(), true);
		assert.equal(await page.locator("dialog[open]").count(), 0);
		await page.waitForFunction(() => !(document.querySelector("[data-instructions-catalog-load]") as HTMLButtonElement).disabled);
		let availableReads = 0, inspectReads = 0;
		page.on("request", request => {
			const path = new URL(request.url()).pathname;
			if (path === "/api/instructions/available") availableReads++;
			if (path === "/api/instructions/preview") inspectReads++;
		});
		await page.waitForTimeout(3400);
		assert.equal(availableReads, 0, "idle state polling must not scan the modes catalog");
		assert.equal(inspectReads, 0, "unchanged state must not recompile the projection");
		await panel.locator("[data-item-locate]").first().click();
		await sessionView.locator(".instruction-location-match").first().waitFor();
		assert.equal(await panel.locator("[data-instructions-body]").isVisible(), true, "locating retains non-modal controls");
		assert.equal(JSON.stringify(harness.manager.getEntries()), entriesBeforeInspect);
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(await page.locator("#itemContent").inputValue(), "UNSAVED_DO_NOT_LEAK_INTO_SESSION");
		assert.ok(await page.locator("#dirtyBadge").isVisible());
		assert.equal((await page.locator("#contextDiffPanel").boundingBox())!.width, dockWidth);
		await page.getByRole("tab", { name: "草稿差异", exact: true }).click();
		await page.waitForFunction(() => document.querySelector("#contextDiffPanel .context-diff-diff")?.textContent?.includes("UNSAVED_DO_NOT_LEAK_INTO_SESSION"));
		assert.ok(await page.locator("#itemContent").isVisible(), "editing and diff remain side by side");
		if (shots) await page.screenshot({ path: join(shots, `editor-diff-${native ? "native" : "fallback"}.png`) });
		await page.locator("#sessionSurfaceBtn").click();
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(await page.getByRole("tab", { name: "草稿差异", exact: true }).getAttribute("aria-selected"), "true");
		await page.getByRole("tab", { name: "运行差异", exact: true }).click();
		assert.equal((await page.locator("#contextDiffPanel").boundingBox())!.width, dockWidth);
		await page.getByRole("tab", { name: "预览", exact: true }).click();
		await page.locator("#saveBtn").click();
		await page.waitForFunction(() => !document.getElementById("dirtyBadge")?.classList.contains("visible"));
		await page.locator("#stackList .stack-row").filter({ hasText: "UI acceptance fixture" }).click();
		await page.waitForFunction(() => (document.getElementById("itemContent") as HTMLTextAreaElement)?.value === "Offline fixture.");
		if (shots) {
			mkdirSync(shots, { recursive: true });
			await page.locator("#sessionSurfaceBtn").click();
			await compiled.evaluate(el => { el.scrollTop = 0; });
			await page.screenshot({ path: join(shots, `session-panel-${native ? "native" : "fallback"}.png`), fullPage: true });
			await page.locator("#stacksSurfaceBtn").click();
		}
		await page.locator("#sessionSurfaceBtn").click();
		await panel.locator("[data-item-deactivate-btn]").first().click();
		await page.waitForFunction(() => document.querySelectorAll("[data-session-instructions] .active-item-card").length === 1);
		assert.ok(harness.getActiveToolNames().includes("fake_write"), "browser off reaches the real tool owner");

		const branch = harness.manager.getBranch();
		assert.equal(
			branch.some((e: any) => e.type === "custom_message" && e.customType === "pi-forge-instruction-delivery"),
			false,
			"delivery markers must never be custom_message",
		);
		const anchors = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-forge-instruction-delivery");
		assert.ok(anchors.length >= 2, "instruction modes produce plain metadata anchors");
		await page.locator("#stacksSurfaceBtn").click();
		await compiled.locator(".context-diff-refresh").click();
		await page.waitForFunction((isNative) => isNative
			? !!document.querySelector("#contextDiffPanel .context-diff-compiled .op-removed")
			: document.querySelector("#contextDiffPanel .context-diff-compiled")?.textContent?.includes("Removed system prompt section"), native);
		assert.match(await selectedTools.textContent() || "", /fake_write/);
		assert.equal(harness.beforeAgentStartEvents.length, 3, "only the intentional dialogue turns; preview/controls add none");

		await page.locator("#sessionSurfaceBtn").click();
		await panel.locator("[data-instructions-reset-btn]").click();
		await panel.locator("[data-instructions-reset-confirm-group]").waitFor();
		await quietPrompt("/instruction add NEW_RULE_WHILE_CONFIRMING");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForFunction(() => document.querySelectorAll("[data-session-instructions] .active-item-card").length === 2);
		assert.equal(await panel.locator("[data-instructions-reset-confirm-group]").count(), 0, "real CLI change invalidates the pending browser confirmation");
		await panel.locator("[data-instructions-reset-btn]").click();
		await panel.locator("[data-instructions-confirm-reset-btn]").click();
		await panel.locator("[data-instructions-empty]").waitFor();
		assert.ok(harness.getActiveToolNames().includes("fake_write"));
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(harness.streamContexts.length, 3);
		assert.equal(harness.fetchAttempts, 0);
		await page.locator("#sessionSurfaceBtn").click();
		const select = panel.locator("[data-instructions-picker-select]");
		await select.locator("option[value='mode:project:review']").waitFor({ state: "attached" });
		await select.selectOption("mode:project:review");
		await panel.locator("[data-instructions-use-btn]").click();
		await panel.locator("[data-impact-removed]").waitFor();
		assert.match(await panel.locator("[data-impact-removed]").textContent() || "", /fake_write/);
		await select.selectOption("mode:project:audit");
		await panel.locator("[data-instructions-use-btn]").click();
		await page.waitForFunction(() => document.querySelectorAll(".active-item-card").length === 2);
		assert.match(await panel.locator("[data-instructions-recent-change]").textContent() || "", /生效工具未变化/);
		await page.waitForFunction(() => document.querySelector(".session-inspector .context-diff-compiled")?.textContent?.includes("AUDIT_RULE"));
		await panel.locator(".active-item-card").filter({ hasText: "AUDIT_RULE" }).locator("[data-item-deactivate-btn]").click();
		await page.waitForFunction(() => document.querySelectorAll(".active-item-card").length === 1);
		assert.match(await panel.locator("[data-instructions-recent-change]").textContent() || "", /生效工具未变化/);
		await panel.locator("[data-item-deactivate-btn]").click();
		await panel.locator("[data-instructions-empty]").waitFor();
		assert.match(await panel.locator("[data-impact-added]").textContent() || "", /fake_write/);
		await panel.locator("[data-locate-recent]").click();
		await sessionView.locator(".instruction-location-match").last().waitFor();
		await page.waitForFunction(() => {
			const matches = document.querySelectorAll(".session-inspector .instruction-location-match");
			const pane = document.querySelector(".session-inspector .context-diff-compiled")!.getBoundingClientRect();
			const rect = matches[matches.length - 1]?.getBoundingClientRect();
			return matches.length >= 2 && rect && rect.top >= pane.top && rect.bottom <= pane.bottom + 1;
		});
		if (shots) await page.screenshot({ path: join(shots, `session-stop-${native ? "native" : "fallback"}.png`) });
		// A source-only active Preset save changes the projection without touching Mode permission guards.
		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#itemContent").fill("UPDATED_ACTIVE_SAVED");
		await page.locator("#saveBtn").click();
		await page.waitForFunction(() => !document.getElementById("dirtyBadge")?.classList.contains("visible"));
		await page.locator("#sessionSurfaceBtn").click();
		await page.waitForFunction(() => document.querySelector(".session-inspector .section-text")?.textContent === "UPDATED_ACTIVE_SAVED");
		// Leaving while a real HTTP response is held cannot revive Session or overwrite the draft.
		let release!: () => void, held!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve), captured = new Promise<void>(resolve => held = resolve);
		await page.route("**/api/instructions/preview", async route => {
			const response = await route.fetch(); held(); await blocked;
			try { await route.fulfill({ response }); } catch { /* intentional browser abort on navigation */ }
		});
		await sessionView.locator(".context-diff-refresh").click(); await captured;
		assert.match(await sessionCompiled.textContent() || "", /UPDATED_ACTIVE_SAVED/, "same-branch refresh retains previous projection");
		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#itemContent").fill("NEWER_UNSAVED_INPUT");
		release(); await page.waitForTimeout(150); await page.unroute("**/api/instructions/preview");
		assert.equal(await sessionView.isVisible(), false);
		assert.equal(await page.locator("#itemContent").inputValue(), "NEWER_UNSAVED_INPUT");
		assert.equal(await page.locator("#contextDiffPanel .context-diff-dock").getAttribute("data-reading"), "wide");
		// A delayed catalog from the previous visit must not block or replace
		// a fresh catalog when returning to the Session workspace.
		let releaseCatalog!: () => void, heldCatalog!: () => void, catalogCalls = 0;
		const catalogBlocked = new Promise<void>(resolve => releaseCatalog = resolve);
		const catalogCaptured = new Promise<void>(resolve => heldCatalog = resolve);
		await page.route("**/api/instructions/available", async route => {
			if (++catalogCalls !== 1) { await route.continue(); return; }
			const response = await route.fetch(); heldCatalog(); await catalogBlocked;
			try { await route.fulfill({ response }); } catch { /* old visit invalidated */ }
		});
		try {
			await page.locator("#sessionSurfaceBtn").click(); await catalogCaptured;
			await page.locator("#stacksSurfaceBtn").click();
			writeFileSync(join(root, "instruction-modes", "audit.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.instruction-mode", id: "audit", name: "Audit", content: "AUDIT_CHANGED_ON_REENTRY", tools: { add: [], remove: ["fake_write"] } }));
			await page.locator("#sessionSurfaceBtn").click();
			await page.waitForFunction(() => !(document.querySelector("[data-instructions-picker-select]") as HTMLSelectElement).disabled, null, { timeout: 1500 });
			assert.ok(catalogCalls >= 2, "new visit cannot wait behind a stale in-flight catalog");
			await select.selectOption("mode:project:audit");
			assert.match(await panel.locator("[data-picker-preview-content]").textContent() || "", /AUDIT_CHANGED_ON_REENTRY/);
		} finally { releaseCatalog(); await page.unroute("**/api/instructions/available"); }
		await page.waitForTimeout(150);
		assert.match(await panel.locator("[data-picker-preview-content]").textContent() || "", /AUDIT_CHANGED_ON_REENTRY/);
		// A navigation invalidation must not discard an in-flight mutation receipt.
		let releaseUse!: () => void, heldUse!: () => void, useCalls = 0;
		const useBlocked = new Promise<void>(resolve => releaseUse = resolve), useCaptured = new Promise<void>(resolve => heldUse = resolve);
		await page.route("**/api/instructions/use", async route => {
			useCalls++; const response = await route.fetch(); heldUse(); await useBlocked;
			await route.fulfill({ response });
		});
		try {
			await panel.locator("[data-instructions-use-btn]").click(); await useCaptured;
			await page.locator("#stacksSurfaceBtn").click();
			await page.locator("#sessionSurfaceBtn").click();
			assert.ok(await panel.locator("[data-instructions-use-btn]").isDisabled());
		} finally { releaseUse(); await page.unroute("**/api/instructions/use"); }
		await page.waitForFunction(() => document.querySelectorAll(".active-item-card").length === 1);
		assert.equal(useCalls, 1);
		assert.match(await panel.locator("[data-instructions-recent-change]").textContent() || "", /fake_write/);
		await page.locator("#localeSelect").selectOption("en");
		await page.locator("#themeToggleBtn").click();
		await panel.locator("[data-item-locate]").click();
		await sessionView.locator(".instruction-location-match").last().waitFor();
		if (shots) await page.screenshot({ path: join(shots, `session-dark-${native ? "native" : "fallback"}.png`) });
		await page.setViewportSize({ width: 390, height: 844 });
		await panel.locator("[data-item-locate]").click();
		await page.waitForFunction(() => {
			const matches = document.querySelectorAll(".session-inspector .instruction-location-match");
			const rect = matches[matches.length - 1]?.getBoundingClientRect();
			return rect && rect.top >= 0 && rect.bottom <= innerHeight;
		});
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		assert.equal(await page.locator("dialog[open]").count(), 0);
		if (shots) await page.screenshot({ path: join(shots, `session-narrow-${native ? "native" : "fallback"}.png`) });
		assert.equal(harness.streamContexts.length, 3);
		assert.equal(harness.fetchAttempts, 0);
		assert.deepEqual(errors, []);
		assert.deepEqual(externalRequests, []);
	} catch (error) {
		if (process.env.PI_FORGE_UI_SCREENSHOT_DIR && browser?.contexts()[0]?.pages()[0]) {
			const page = browser.contexts()[0].pages()[0];
			await page.screenshot({ path: join(process.env.PI_FORGE_UI_SCREENSHOT_DIR, `failure-${native ? "native" : "fallback"}.png`), fullPage: true }).catch(() => {});
			const geometry = await page.evaluate(() => {
				const box = (selector: string) => { const el = document.querySelector<HTMLElement>(selector); return el ? { rect: el.getBoundingClientRect().toJSON(), scroll: el.scrollTop, scrollHeight: el.scrollHeight, height: el.clientHeight } : null; };
				return { viewport: [innerWidth, innerHeight], workspace: box(".session-workspace"), inspector: box(".session-inspector"), projection: box(".session-inspector .context-diff-compiled"), matches: [...document.querySelectorAll(".session-inspector .instruction-location-match")].map(el => el.getBoundingClientRect().toJSON()) };
			}).catch(() => null);
			console.error(JSON.stringify(geometry));
		}
		throw error;
	} finally {
		try { await browser?.close(); } finally {
			try { if (harness && server) await quietPrompt("/preset ui stop"); } finally {
				try { await harness?.dispose(); } finally { rmSync(cwd, { recursive: true, force: true }); }
			}
		}
	}
});

}
