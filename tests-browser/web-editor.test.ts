import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

test("web editor completes a stack workflow in a real browser", { timeout: 20_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-browser-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Browser Smoke",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: "Browser smoke system prompt." },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let editorStarted = false;
	const browserErrors: string[] = [];

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const editorUrl = latestEditorUrl(context.editors);
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		page.on("pageerror", (error) => browserErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(message.text());
		});

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.locator("#status").textContent(), "Loaded default");

		await page.locator("#metadataToggleBtn").click();
		assert.equal(await page.locator("#stackId").isEditable(), false);
		await page.locator("#stackName").fill("Browser Smoke Edited");
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#validateBtn").click();
		await page.locator("#status").filter({ hasText: "Validation complete" }).waitFor();

		await page.locator("#policyTabBtn").click();
		await page.locator("#tabPanel").filter({ hasText: "do not block explicit skill invocation" }).waitFor();
		const toolPolicyRow = page.locator('[data-policy-row][data-policy-kind="tools"]');
		await toolPolicyRow.locator('[data-policy-mode-option="allow"]').click();
		await toolPolicyRow.locator('[data-resource-name="read"]').click();
		await toolPolicyRow.locator('[data-remove-policy-pattern="read"]').waitFor();

		await page.locator("#regexTabBtn").click();
		await page.locator("#addRegexRuleBtn").click();
		const regexRow = page.locator("[data-regex-row]").last();
		await regexRow.locator("[data-regex-pattern]").fill("Browser");
		await regexRow.locator("[data-regex-replace]").fill("Typed");
		await page.locator("#validateRegexRulesBtn").click();
		await page.locator("#status").filter({ hasText: "Validation complete" }).waitFor();

		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		await page.locator("#status").filter({ hasText: "Loaded default" }).waitFor();

		const saved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8")) as {
			name?: string;
			tools?: { allow?: string[] };
			regex?: { rules?: Array<{ pattern?: string; replace?: string }> };
		};
		assert.equal(saved.name, "Browser Smoke Edited");
		assert.deepEqual(saved.tools?.allow, ["read"]);
		assert.equal(saved.regex?.rules?.[0]?.pattern, "Browser");
		assert.equal(saved.regex?.rules?.[0]?.replace, "Typed");

		const downloadPromise = page.waitForEvent("download");
		await page.locator("#exportBtn").click();
		const download = await downloadPromise;
		assert.equal(download.suggestedFilename(), "default.json");

		page.once("dialog", async (dialog) => {
			assert.equal(dialog.type(), "confirm");
			assert.match(dialog.message(), /Activate imported stack now/);
			await dialog.dismiss();
		});
		await page.locator("#importFileInput").setInputFiles({
			name: "imported-browser.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({
				schemaVersion: 1,
				type: "pi-forge.prompt-stack",
				id: "imported-browser",
				items: [{ kind: "block", id: "system", role: "system", content: "Imported in browser." }],
			})),
		});
		await page.locator("#status").filter({ hasText: "Imported imported-browser" }).waitFor();
		assert.equal(existsSync(join(promptStacksDir(cwd), "imported-browser.json")), true);
		assert.deepEqual(browserErrors, []);
	} finally {
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("web editor opens the preview/diff dock", { timeout: 20_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-browser-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Browser Dock",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: "Browser dock system prompt." },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let editorStarted = false;
	const browserErrors: string[] = [];

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const editorUrl = latestEditorUrl(context.editors);
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		page.on("pageerror", (error) => browserErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(message.text());
		});

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		let firstPreviewSeenResolve: () => void = () => {};
		let releaseFirstPreview: () => void = () => {};
		const firstPreviewSeen = new Promise<void>((resolve) => { firstPreviewSeenResolve = resolve; });
		const firstPreviewRelease = new Promise<void>((resolve) => { releaseFirstPreview = resolve; });
		let previewRequests = 0;
		await page.route(/\/api\/stacks\/.*\/preview$/, async (route) => {
			previewRequests += 1;
			if (previewRequests === 1) {
				firstPreviewSeenResolve();
				await firstPreviewRelease;
			}
			await route.continue();
		});

		await page.locator("#previewTabBtn").click();
		await page.locator("#editorDockArea.dock-open").waitFor();
		await page.locator("#tabPanel.open").waitFor();
		await page.locator(".context-diff-mode-tabs").filter({ hasText: "Compiled" }).waitFor();
		await firstPreviewSeen;
		await page.locator("#itemContent").fill("Unsaved browser dock prompt.");
		releaseFirstPreview();
		await page.waitForTimeout(250);
		assert.equal(await page.locator(".context-diff-sections").filter({ hasText: "Browser dock system prompt." }).count(), 0);
		await page.locator(".context-diff-section").first().waitFor();
		await page.locator(".context-diff-sections").filter({ hasText: "Unsaved browser dock prompt." }).waitFor();
		assert.equal(await page.locator(".context-diff-sections").filter({ hasText: "Browser dock system prompt." }).count(), 0);

		await page.locator(".context-diff-mode-tabs button", { hasText: "Diff" }).click();
		const emptyDiff = page.locator(".context-diff-empty").filter({ hasText: "No captured provider turns yet" });
		await emptyDiff.waitFor();
		const emptyDiffText = await emptyDiff.textContent();
		assert.match(emptyDiffText ?? "", /automatically/);
		assert.doesNotMatch(emptyDiffText ?? "", /Arm a payload capture/);

		await page.locator("#itemsTabBtn").click();
		await page.locator("#workspace").waitFor({ state: "visible" });
		assert.equal(await page.locator("#editorDockArea").getAttribute("class"), "editor-dock-area");

		assert.deepEqual(browserErrors, []);
	} finally {
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

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
