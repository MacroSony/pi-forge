import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeProfile,
} from "../tests/helpers/index-command-harness.ts";
import { agentProfilesDir } from "../src/agent-profile.ts";

function findChromeExecutable(): string | undefined {
	return process.env.CHROME_PATH || [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
		process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
}

interface ProfileBrowserContext {
	page: Page;
	url: URL;
	cwd: string;
}

interface RunProfileOptions {
	harnessOptions?: Parameters<typeof createHarness>[0];
}

async function runProfileBrowserTest(
	t: test.TestContext,
	setup: (cwd: string) => void | Promise<void>,
	run: (ctx: ProfileBrowserContext) => Promise<void>,
	options?: RunProfileOptions
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("browser tests explicitly disabled");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "forge-save-busy-"));
	const harness = createHarness(options?.harnessOptions);
	const context = createContext(cwd, [], options?.harnessOptions ? { modelRuntime: harness } : undefined);
	let browser: Browser | undefined;
	let editorStarted = false;

	try {
		await setup(cwd);
		await startSession(harness, context.ctx);
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const url = latestEditorUrl(context.editors);

		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(8_000);

		await run({ page, url, cwd });
	} finally {
		await browser?.close();
		if (editorStarted) {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function openProfileEditor(page: Page, url: URL, clickNew = false): Promise<void> {
	await page.goto(url.href, { waitUntil: "domcontentloaded" });
	await page.locator("#profilesSurfaceBtn").click();
	await page.locator(".profile-layout").waitFor();
	if (clickNew) {
		const newBtn = page.locator("#emptyNewProfileBtn, #profileNewBtn").first();
		await newBtn.click();
	} else {
		await page.locator("#profileEditBtn").click();
	}
	await page.locator(".profile-editor").waitFor();
	await page.locator(".profile-advanced-group summary").click();
}

test("F2: Profile Save in Edit Mode disables entire draft and buttons during save", { timeout: 30_000 }, async (t) => {
	await runProfileBrowserTest(
		t,
		(cwd) => {
			writeProfile(cwd, "test-edit.json", {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: "test-edit",
				name: "Original Profile Name",
				model: { provider: "test-provider", id: "test-model" },
				thinkingLevel: "off",
				promptStack: null,
			});
		},
		async ({ page, url, cwd }) => {
			await openProfileEditor(page, url);
			await page.locator("#profileName").fill("Updated Name Before Save");

			let resolveSaveTriggered: (() => void) | undefined;
			const saveTriggered = new Promise<void>((resolve) => {
				resolveSaveTriggered = resolve;
			});

			let resolveReleaseSave: (() => void) | undefined;
			const releaseSave = new Promise<void>((resolve) => {
				resolveReleaseSave = resolve;
			});

			await page.route("**/api/profiles/*", async (route: Route) => {
				if (route.request().method() === "PUT") {
					resolveSaveTriggered?.();
					await releaseSave;
					return route.continue();
				}
				return route.continue();
			});

			await page.locator("#profileSaveBtn").click();
			await saveTriggered;

			assert.equal(await page.locator("#profileName").isDisabled(), true, "name input must be disabled during save");
			assert.equal(await page.locator("#profileModelProvider").isDisabled(), true, "provider input must be disabled during save");
			assert.equal(await page.locator("#profileModelId").isDisabled(), true, "model input must be disabled during save");
			assert.equal(await page.locator("#profileThinkingLevel").isDisabled(), true, "thinking select must be disabled during save");
			assert.equal(await page.locator("#profilePromptStack").isDisabled(), true, "preset picker select must be disabled during save");
			assert.equal(await page.locator("#profileDescription").isDisabled(), true, "description textarea must be disabled during save");
			assert.equal(await page.locator("#profileAutoActivate").isDisabled(), true, "autoActivate checkbox must be disabled during save");

			assert.equal(await page.locator("#profileSaveBtn").isDisabled(), true, "save button must be disabled during save");
			assert.equal(await page.locator("#profileValidateBtn").isDisabled(), true, "validate button must be disabled during save");
			assert.equal(await page.locator("#profileCancelBtn").isDisabled(), true, "cancel button must be disabled during save");

			resolveReleaseSave?.();
			await page.locator(".profile-editor").waitFor({ state: "hidden" });

			const diskPath = join(agentProfilesDir(cwd), "test-edit.json");
			const diskData = JSON.parse(readFileSync(diskPath, "utf8"));
			assert.equal(diskData.name, "Updated Name Before Save");
		}
	);
});

test("F2: Profile Create Mode disables draft ID, scope, and all inputs during save", { timeout: 30_000 }, async (t) => {
	const testModel = { provider: "test-provider", id: "test-model", reasoning: false, input: ["text"] };
	await runProfileBrowserTest(
		t,
		() => {},
		async ({ page, url }) => {
			await openProfileEditor(page, url, true);

			await page.locator("#profileId").fill("new-bot");
			await page.locator("#profileName").fill("New Bot Name");

			let resolveSaveTriggered: (() => void) | undefined;
			const saveTriggered = new Promise<void>((resolve) => {
				resolveSaveTriggered = resolve;
			});

			let resolveReleaseSave: (() => void) | undefined;
			const releaseSave = new Promise<void>((resolve) => {
				resolveReleaseSave = resolve;
			});

			await page.route("**/api/profiles", async (route: Route) => {
				if (route.request().method() === "POST") {
					resolveSaveTriggered?.();
					await releaseSave;
					return route.continue();
				}
				return route.continue();
			});

			await page.locator("#profileSaveBtn").click();
			await saveTriggered;

			assert.equal(await page.locator("#profileId").isDisabled(), true, "id input must be disabled during save");
			assert.equal(await page.locator("#profileScope").isDisabled(), true, "scope select must be disabled during save");

			assert.equal(await page.locator("#profileName").isDisabled(), true, "name input must be disabled during save");
			assert.equal(await page.locator("#profileModelProvider").isDisabled(), true, "provider input must be disabled during save");
			assert.equal(await page.locator("#profileModelId").isDisabled(), true, "model input must be disabled during save");
			assert.equal(await page.locator("#profileThinkingLevel").isDisabled(), true, "thinking select must be disabled during save");
			assert.equal(await page.locator("#profilePromptStack").isDisabled(), true, "preset picker select must be disabled during save");
			assert.equal(await page.locator("#profileDescription").isDisabled(), true, "description textarea must be disabled during save");
			assert.equal(await page.locator("#profileAutoActivate").isDisabled(), true, "autoActivate checkbox must be disabled during save");

			resolveReleaseSave?.();
			await page.locator(".profile-editor").waitFor({ state: "hidden" });
		},
		{
			harnessOptions: {
				currentModel: testModel,
				models: [testModel],
				availableModels: [testModel],
			},
		}
	);
});

test("F2: Validate busy state disables form controls and does not race with save", { timeout: 30_000 }, async (t) => {
	await runProfileBrowserTest(
		t,
		(cwd) => {
			writeProfile(cwd, "validate-test.json", {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: "validate-test",
				name: "Validation Test Profile",
				model: { provider: "test-provider", id: "test-model" },
				thinkingLevel: "off",
				promptStack: null,
			});
		},
		async ({ page, url }) => {
			await openProfileEditor(page, url);

			let resolveValidateTriggered: (() => void) | undefined;
			const validateTriggered = new Promise<void>((resolve) => {
				resolveValidateTriggered = resolve;
			});

			let resolveReleaseValidate: (() => void) | undefined;
			const releaseValidate = new Promise<void>((resolve) => {
				resolveReleaseValidate = resolve;
			});

			let saveAttempts = 0;
			await page.route("**/api/profiles/**", async (route: Route) => {
				if (route.request().url().includes("/validate")) {
					resolveValidateTriggered?.();
					await releaseValidate;
					return route.continue();
				}
				if (route.request().method() === "PUT" || route.request().method() === "POST") {
					saveAttempts++;
					return route.continue();
				}
				return route.continue();
			});

			await page.locator("#profileValidateBtn").click();
			await validateTriggered;

			assert.equal(await page.locator("#profileSaveBtn").isDisabled(), true, "save button must be disabled during validation");
			assert.equal(await page.locator("#profileValidateBtn").isDisabled(), true, "validate button must be disabled during validation");
			assert.equal(await page.locator("#profileCancelBtn").isDisabled(), true, "cancel button must be disabled during validation");
			assert.equal(await page.locator("#profileName").isDisabled(), true, "name input must be disabled during validation");

			await page.locator("#profileSaveBtn").dispatchEvent("click");
			assert.equal(saveAttempts, 0, "Save must not be triggered while validation is busy");

			resolveReleaseValidate?.();
			await page.locator("#profileEditorStatus").waitFor();

			assert.equal(await page.locator("#profileSaveBtn").isDisabled(), false, "save button re-enabled after validation");
			assert.equal(await page.locator("#profileName").isDisabled(), false, "name input re-enabled after validation");
		}
	);
});
