import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { UiContributionProvider } from "../src/ui-contribution/contrib-port.ts";
import type { ContributionTabDescriptor } from "../src/web-editor/client/contribution-settings.ts";

function findChromeExecutable(): string | undefined {
	return process.env.CHROME_PATH || [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
}

test("ui-surfaces: mode scope label, profile name hierarchy, schema-form ids, and settings autosave locale safety", { timeout: 45_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-ui-surfaces-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Default Preset",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: "Root system prompt" },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	const sampleDescriptor: ContributionTabDescriptor = {
		tabId: "sample-plugin-settings",
		title: "Sample Plugin",
		icon: "⚙",
		schema: {
			title: "Sample Plugin Config",
			description: "Settings for sample plugin",
			fields: [
				{ key: "enabled", label: "Enable Feature", type: "boolean" },
				{ key: "retries", label: "Max Retries", type: "number", min: 1, max: 10 },
				{ key: "endpoint", label: "API Endpoint", type: "string" },
			],
		},
		values: {
			enabled: true,
			retries: 3,
			endpoint: "https://example.test",
		},
	};

	const provider = new UiContributionProvider(harness.eventsBus, {
		providerId: "sample-plugin-provider",
		handle: (operation, payload) => {
			if (operation === "listContributions") {
				return { ok: true, data: { tabs: [sampleDescriptor] } };
			}
			if (operation === "writeValues") {
				const req = payload as { tabId: string; patch: Record<string, unknown> };
				Object.assign(sampleDescriptor.values, req.patch);
				return { ok: true, data: { ok: true, values: sampleDescriptor.values } };
			}
			return { ok: false, error: `Unknown operation: ${operation}` };
		},
	});
	provider.start();

	let browser: Browser | undefined;
	let editorStarted = false;

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const editorUrl = latestEditorUrl(context.editors);

		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
		page.setDefaultTimeout(6_000);

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		// 1. Check Modes surface: Mode scope label must NOT be "Preset scope"
		await page.locator("#modesSurfaceBtn").click();
		await page.locator("#modeNewBtn").waitFor();
		await page.locator("#modeNewBtn").click();
		await page.locator("#modeScope").waitFor();

		// Visible label associated with #modeScope must not be "Preset scope"
		const modeScopeLabel = await page.locator("label:has(#modeScope) span").textContent();
		assert.notEqual(modeScopeLabel?.trim(), "Preset scope", "Mode scope visible label must not say 'Preset scope'");
		assert.match(modeScopeLabel ?? "", /Mode scope|模式作用域/, "Mode scope visible label must say 'Mode scope'");

		// Cancel out of mode create
		await page.locator("#modeCancelBtn").click();

		// 2. Check Profiles surface: Name primary, selector secondary
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator("#profileNewBtn").waitFor();
		await page.locator("#profileNewBtn").click();
		await page.locator("#profileId").waitFor();
		await page.locator("#profileName").waitFor();
		await page.locator("#profileCancelBtn").click();

		// 3. Check Settings surface with synthetic provider
		await page.locator("#settingsSurfaceBtn").click();
		await page.locator("#settings-sample-plugin-settingsTabBtn").waitFor();
		await page.locator("#settings-sample-plugin-settingsTabBtn").click();
		await page.locator(".schema-form").waitFor();

		// Status should settle on ready
		await page.locator("#settingsStatus").filter({ hasText: /Settings ready|设置已就绪/ }).waitFor();

		// Switch locale: status must NOT be permanently overwritten with static "Loading settings…" / "正在加载设置…"
		await page.locator("#localeSelect").selectOption("zh-CN");
		// Give time for any static overwrite to happen and verify dynamic status
		await page.waitForTimeout(500);
		const statusAfterLocale = await page.locator("#settingsStatus").textContent();
		assert.doesNotMatch(
			statusAfterLocale ?? "",
			/正在加载设置…|Loading settings…/,
			"Dynamic settingsStatus must not be overwritten by static Loading on locale switch",
		);

		// Switch back to en
		await page.locator("#localeSelect").selectOption("en");
		await page.waitForTimeout(500);
		const statusAfterEn = await page.locator("#settingsStatus").textContent();
		assert.doesNotMatch(
			statusAfterEn ?? "",
			/Loading settings…/,
			"Dynamic settingsStatus must not be overwritten by static Loading on en switch",
		);

		// SchemaForm label-for and input-id association check
		const inputId = await page.locator('[data-field-input="retries"]').getAttribute("id");
		assert.ok(inputId, "SchemaForm input must have an id attribute");
		const labelFor = await page.locator('label:has-text("Max Retries")').getAttribute("for");
		assert.equal(labelFor, inputId, "SchemaForm label 'for' attribute must match input id");
        const retryInput = page.locator('[data-field-input="retries"]');
        await retryInput.fill('0');
        assert.equal(await retryInput.getAttribute('aria-invalid'), 'true');
        const describedBy = await retryInput.getAttribute('aria-describedby');
        assert.ok(describedBy && !/\s/.test(describedBy));
        assert.ok(await page.evaluate(id => !!document.getElementById(id), describedBy));
        let releaseSave!: () => void;
        const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
        await page.route('**/api/contrib/sample-plugin-settings', async route => {
            if (route.request().method() === 'PUT') await saveGate;
            await route.continue();
        });
        await retryInput.fill('4');
        await page.locator('#settingsStatus[data-autosave-state="saving"]').waitFor();
        await page.locator('#localeSelect').selectOption('zh-CN');
        assert.equal(await page.locator('#settingsStatus').getAttribute('data-autosave-state'), 'saving');
        assert.doesNotMatch(await page.locator('#settingsStatus').innerText(), /加载|Loading/);
        releaseSave();
        await page.locator('#settingsStatus[data-autosave-state="saved"]').waitFor();
        await page.unroute('**/api/contrib/sample-plugin-settings');
        await page.route('**/api/contrib/sample-plugin-settings', route => route.request().method() === 'PUT'
            ? route.fulfill({ status: 500, json: { error: 'synthetic save failure' } }) : route.continue());
        await retryInput.fill('5');
        await page.locator('#settingsStatus[data-autosave-state="error"]').waitFor();
        assert.match(await page.locator('#settingsStatus').innerText(), /synthetic save failure/);
        assert.equal(await retryInput.inputValue(), '5', 'Failed autosave retains editable draft');
        await page.unroute('**/api/contrib/sample-plugin-settings');
        await retryInput.fill('6');
        await page.locator('#settingsStatus[data-autosave-state="saved"]').waitFor();
        assert.equal(sampleDescriptor.values.retries, 6);

	} finally {
		await browser?.close();
		provider.stop();
		if (editorStarted) {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
		await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
});
