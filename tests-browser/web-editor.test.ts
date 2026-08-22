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
		await page.locator("#moreActions > summary").click();
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
	writeStack(cwd, "secondary.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "secondary",
		name: "Secondary dock",
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: "Secondary stack preview survives selection." },
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
		let firstContextSeenResolve: () => void = () => {};
		let secondContextSeenResolve: () => void = () => {};
		let releaseFirstContext: () => void = () => {};
		const firstContextSeen = new Promise<void>((resolve) => { firstContextSeenResolve = resolve; });
		const secondContextSeen = new Promise<void>((resolve) => { secondContextSeenResolve = resolve; });
		const firstContextRelease = new Promise<void>((resolve) => { releaseFirstContext = resolve; });
		let contextRequests = 0;
		let serveLatestRunDiff = false;
		await page.route(/\/api\/context-diff$/, async (route) => {
			contextRequests += 1;
			if (contextRequests === 1) {
				firstContextSeenResolve();
				await firstContextRelease;
				try {
					await route.fulfill({ json: staleContextDiffView() });
				} catch {
					// The client is expected to abort this superseded request.
				}
				return;
			}
			secondContextSeenResolve();
			await route.fulfill({ json: serveLatestRunDiff ? latestContextDiffView() : { turns: [], latest: null, latestDiff: null } });
		});

		await page.locator("#previewTabBtn").click();
		await page.locator("#editorDockArea.dock-open").waitFor();
		await page.locator("#contextDiffPanel.open").waitFor();
		await page.locator(".context-diff-mode-tabs").filter({ hasText: "Draft diff" }).waitFor();
		await firstContextSeen;
		await firstPreviewSeen;
		await page.locator("#itemContent").fill("Unsaved browser dock prompt.");
		releaseFirstPreview();
		await page.waitForTimeout(250);
		assert.equal(await page.locator(".context-diff-sections").filter({ hasText: "Browser dock system prompt." }).count(), 0);
		await page.locator(".context-diff-section").first().waitFor();
		await page.locator(".context-diff-sections").filter({ hasText: "Unsaved browser dock prompt." }).waitFor();
		assert.equal(await page.locator(".context-diff-sections").filter({ hasText: "Browser dock system prompt." }).count(), 0);
		await page.locator("#itemContent").fill("Newest unsaved browser dock prompt.");
		assert.equal(await page.locator(".context-diff-sections").count(), 0);
		await page.locator(".context-diff-empty").filter({ hasText: "Loading preview" }).waitFor();
		await page.locator(".context-diff-sections").filter({ hasText: "Newest unsaved browser dock prompt." }).waitFor();

		await page.locator(".context-diff-mode-tabs button", { hasText: "Draft diff" }).click();
		const draftBlock = page.locator(".context-diff-block.modified");
		await draftBlock.waitFor();
		assert.match(await draftBlock.textContent() ?? "", /Browser dock system prompt/);
		assert.match(await draftBlock.textContent() ?? "", /Newest unsaved browser dock prompt/);
		assert.equal(await page.locator(".context-diff-block.same").count(), 0);
		assert.equal(await draftBlock.locator(".git-diff.unified").count(), 1);
		assert.ok(await draftBlock.locator(".line-number").count() >= 2);
		assert.ok(await draftBlock.locator("mark").count() >= 2);
		await page.locator('select[aria-label="Diff line context"]').selectOption("0");
		assert.equal(await draftBlock.locator(".git-line.same").count(), 0);
		await page.locator(".diff-layout-buttons button", { hasText: "Split" }).click();
		assert.equal(await draftBlock.locator(".git-diff.split .split-header").count(), 1);
		await page.locator(".diff-layout-buttons button", { hasText: "Unified" }).click();
		await page.locator(".context-diff-expand", { hasText: "Focus" }).click();
		await page.locator("#editorDockArea.dock-focus").waitFor();
		assert.equal(await page.locator("#workspace").isVisible(), false);
		await page.locator(".context-diff-expand", { hasText: "Split" }).click();
		await page.locator("#workspace").waitFor({ state: "visible" });

		await page.locator(".context-diff-mode-tabs button", { hasText: "Run diff" }).click();
		await page.locator(".context-diff-diff .context-diff-refresh").click();
		await secondContextSeen;
		releaseFirstContext();
		const emptyDiff = page.locator(".context-diff-empty").filter({ hasText: "No captured provider turns yet" });
		await emptyDiff.waitFor();
		const emptyDiffText = await emptyDiff.textContent();
		assert.match(emptyDiffText ?? "", /automatically/);
		assert.doesNotMatch(emptyDiffText ?? "", /Arm a payload capture/);
		assert.equal(await page.locator(".context-diff-block").filter({ hasText: "STALE CONTEXT" }).count(), 0);
		serveLatestRunDiff = true;
		await page.locator(".context-diff-diff .context-diff-refresh").click();
		await page.locator(".context-diff-block.modified").filter({ hasText: "current run line" }).waitFor();
		const eofNote = page.locator(".git-diff.unified .git-line.note").filter({ hasText: "Before · No newline at end of file" });
		await eofNote.waitFor();
		assert.equal(await eofNote.count(), 1);
		const metadataOnly = page.locator(".metadata-only-change");
		await metadataOnly.waitFor();
		assert.match(await metadataOnly.textContent() ?? "", /Provider-visible metadata changed/);
		assert.match(await metadataOnly.textContent() ?? "", /Role changed: system → user/);
		await page.locator(".context-diff-details > summary").click();
		const metadata = await page.locator(".context-diff-details").textContent() ?? "";
		assert.match(metadata, /Actual prompt tokens\s*100/);
		assert.match(metadata, /Actual cache hit rate\s*80\.0%/);
		assert.match(metadata, /Estimated reusable prefix/);
		assert.match(metadata, /chars\/4/);

		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		await page.locator("#contextDiffPanel.open .context-diff-mode-tabs").waitFor();
		await page.locator(".stack-row").filter({ hasText: "Secondary dock" }).click();
		await page.locator(".context-diff-mode-tabs button", { hasText: "Preview" }).click();
		await page.locator(".context-diff-sections").filter({ hasText: "Secondary stack preview survives selection." }).waitFor();

		await page.setViewportSize({ width: 390, height: 844 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
		assert.equal(await page.locator("#workspace").isVisible(), false);
		assert.equal(await page.locator("#contextDiffPanel").isVisible(), true);
		await page.setViewportSize({ width: 1280, height: 720 });

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

function staleContextDiffView() {
	const block = { key: "stale", role: "system", text: "STALE CONTEXT", chars: 13, approxTokens: 4, hash: "stale" };
	const diff = {
		blocks: [{ status: "added", after: block, tokenDelta: 4 }],
		prefixTokens: 0,
		prefixRatio: 0,
		deltaTokens: 4,
		summary: { sameBlocks: 0, addedBlocks: 1, removedBlocks: 0, modifiedBlocks: 0, changedBlocks: 1, addedTokens: 4, removedTokens: 0, netTokens: 4 },
	};
	const turn = { turnId: "turn-stale", capturedAt: "", stackId: "default", blocks: [block] };
	return { turns: [], latest: { turn, diff }, latestDiff: diff };
}

function latestContextDiffView() {
	const before = { key: "message-user", role: "user", text: "shared line\nprevious run line", chars: 29, approxTokens: 8, hash: "before" };
	const after = { key: "message-user", role: "user", text: "shared line\ncurrent run line", chars: 28, approxTokens: 7, hash: "after" };
	const metadataBefore = { key: "metadata-only", role: "system", text: "same visible text", chars: 17, approxTokens: 5, hash: "metadata-before" };
	const metadataAfter = { key: "metadata-only", role: "user", text: "same visible text", chars: 17, approxTokens: 5, hash: "metadata-after" };
	const newlineBefore = { key: "newline-only", role: "user", text: "trailing line", chars: 13, approxTokens: 4, hash: "newline-before" };
	const newlineAfter = { key: "newline-only", role: "user", text: "trailing line\n", chars: 14, approxTokens: 4, hash: "newline-after" };
	const diff = {
		blocks: [
			{ status: "modified", before, after, tokenDelta: -1 },
			{ status: "modified", before: metadataBefore, after: metadataAfter, tokenDelta: 0 },
			{ status: "modified", before: newlineBefore, after: newlineAfter, tokenDelta: 0 },
		],
		prefixTokens: 3,
		prefixRatio: 0.3,
		deltaTokens: -1,
		summary: { sameBlocks: 0, addedBlocks: 0, removedBlocks: 0, modifiedBlocks: 3, changedBlocks: 3, addedTokens: 0, removedTokens: 1, netTokens: -1 },
	};
	const turn = { turnId: "turn-2", capturedAt: "", stackId: "default", blocks: [after, metadataAfter, newlineAfter] };
	const usage = {
		provider: "test",
		model: "model",
		stopReason: "stop",
		input: 20,
		output: 5,
		cacheRead: 80,
		cacheWrite: 0,
		totalTokens: 105,
		promptTokens: 100,
		cacheHitRatio: 0.8,
		cacheStatus: "reported",
	};
	return { turns: [], latest: { turn, diff, usage }, latestDiff: diff };
}
