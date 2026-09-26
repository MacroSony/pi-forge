import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { createContext, createHarness, latestEditorUrl, startSession } from "../tests/helpers/index-command-harness.ts";
import { capabilitiesDir } from "../src/repositories/capability.ts";

function findChromeExecutable(): string | undefined {
	return [
		process.env.CHROME_PATH,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
		process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	].find((candidate): candidate is string => !!candidate && existsSync(candidate));
}

function capabilityFile(cwd: string, id: string): string {
	return join(capabilitiesDir(cwd), `${id}.json`);
}

function readCapability(cwd: string, id: string): any {
	return JSON.parse(readFileSync(capabilityFile(cwd, id), "utf8"));
}

function writeCapability(cwd: string, id: string, content: string): void {
	mkdirSync(capabilitiesDir(cwd), { recursive: true });
	writeFileSync(capabilityFile(cwd, id), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.capability",
		id,
		name: id,
		content,
		tools: { add: [], remove: [] },
	}, null, 2));
}

function revisionOf(cwd: string, id: string): string {
	return createHash("sha256").update(readFileSync(capabilityFile(cwd, id))).digest("hex");
}


test("capability saves use real production HTTP and preserve disk-backed drafts across races", { timeout: 40_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("browser tests explicitly disabled");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "forge-capability-save-integration-"));
	writeCapability(cwd, "review", "original on disk");
	writeCapability(cwd, "other", "other capability on disk");
	const harness = createHarness();
	const context = createContext(cwd);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let editorStarted = false;
	let nextGet: ((body: any) => void) | undefined;
	let nextPut: ((result: { status: number; body: any }) => void) | undefined;
	let nextPost: ((result: { status: number; body: any }) => void) | undefined;
	let holdPut = false;
	let holdPost = false;
	let holdCollectionGet = false;
	let releaseHeldPut: (() => void) | undefined;
	let releaseHeldPost: (() => void) | undefined;
	let releaseHeldGet: (() => void) | undefined;
	let dropPutReceipt = false;
	const putRequests: any[] = [];
	const postRequests: any[] = [];
	const getBodies: any[] = [];
	const putResults: { status: number; body: any }[] = [];
	const postResults: { status: number; body: any }[] = [];
	const browserErrors: string[] = [];

	try {
		await startSession(harness, context.ctx);
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(6_000);
		page.on("dialog", dialog => dialog.accept());
		page.on("pageerror", error => browserErrors.push(error.message));

		// route.fetch deliberately lets the real production server perform the
		// repository write before this test delays only the HTTP response.
		await page.route("**/api/capabilities**", async route => {
			const request = route.request();
			const url = new URL(request.url());
			const response = await route.fetch();
			const body = await response.json();
			if (request.method() === "GET" && url.pathname === "/api/capabilities") {
				getBodies.push(body);
				nextGet?.(body);
				nextGet = undefined;
				if (holdCollectionGet) {
					holdCollectionGet = false;
					await new Promise<void>(resolve => { releaseHeldGet = resolve; });
				}
				await route.fulfill({ response, json: body });
				return;
			}
			if (request.method() === "POST" && url.pathname === "/api/capabilities") {
				postRequests.push(request.postDataJSON());
				const result = { status: response.status(), body };
				postResults.push(result);
				nextPost?.(result);
				nextPost = undefined;
				if (holdPost) {
					holdPost = false;
					await new Promise<void>(resolve => { releaseHeldPost = resolve; });
				}
				await route.fulfill({ response, json: body });
				return;
			}
			if (request.method() === "PUT") {
				const requestBody = request.postDataJSON();
				putRequests.push(requestBody);
				const result = { status: response.status(), body };
				putResults.push(result);
				nextPut?.(result);
				nextPut = undefined;
				if (holdPut) {
					holdPut = false;
					await new Promise<void>(resolve => { releaseHeldPut = resolve; });
				}
				const responseBody = dropPutReceipt
					? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "sourceRevision"))
					: body;
				await route.fulfill({ response, json: responseBody });
				return;
			}
			await route.fulfill({ response, json: body });
		});

		const url = latestEditorUrl(context.editors);
		await page.goto(url.href);
		await page.locator("#capabilitiesSurfaceBtn").click();
		await page.locator("[data-capability-row]").filter({ hasText: "review" }).waitFor();

		const watchGet = (hold = false): Promise<any> => {
			holdCollectionGet = hold;
			return new Promise(resolve => { nextGet = resolve; });
		};
		const watchPut = (): Promise<{ status: number; body: any }> =>
			new Promise(resolve => { nextPut = resolve; });
		const watchPost = (): Promise<{ status: number; body: any }> =>
			new Promise(resolve => { nextPost = resolve; });
		const releaseGet = () => { releaseHeldGet?.(); releaseHeldGet = undefined; };
		const releasePut = () => { releaseHeldPut?.(); releaseHeldPut = undefined; };
		const releasePost = () => { releaseHeldPost?.(); releaseHeldPost = undefined; };
		const forceSecondSaveClick = async () => {
			await page.locator("#capabilitySaveBtn").evaluate((button) => {
				(button as HTMLButtonElement).disabled = false;
				(button as HTMLButtonElement).click();
			});
			await page.keyboard.press("Control+s");
		};

		// A PUT really commits the first snapshot to disk, while both an edit
		// during that PUT and an edit during its follow-up collection GET survive.
		await page.locator("[data-capability-row]").filter({ hasText: "review" }).click();
		await page.locator("#capabilityEditBtn").click();
		await page.locator("#capabilityContent").fill("first saved version");
		holdPut = true;
		const firstPut = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await firstPut;
		assert.equal(readCapability(cwd, "review").content, "first saved version");
		await page.locator("#capabilityContent").fill("typed during PUT");
		await forceSecondSaveClick();
		assert.equal(putRequests.length, 1, "a force-enabled Save must not submit a duplicate PUT");

		const firstFollowupGet = watchGet(true);
		releasePut();
		await firstFollowupGet;
		await page.locator("#capabilityContent").fill("typed during PUT and follow-up collection GET");
		assert.equal(readCapability(cwd, "review").content, "first saved version");
		releaseGet();
		await page.locator(".capability-dirty-badge").waitFor();
		assert.equal(await page.locator("#capabilityContent").inputValue(), "typed during PUT and follow-up collection GET");
		assert.equal(putRequests.length, 1);
		assert.equal(putResults[0]!.status, 200);
		assert.equal(putResults[0]!.body.sourceRevision, revisionOf(cwd, "review"));

		const secondPut = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await secondPut;
		assert.equal(putRequests.length, 2, `second save request missing (results=${putResults.length}, requests=${JSON.stringify(putRequests)})`);
		assert.equal(putRequests[1]!.expectedSourceRevision, putResults[0]!.body.sourceRevision, "next save must use the first write receipt");
		assert.equal(putRequests[1]!.capability.content, "typed during PUT and follow-up collection GET");
		await page.locator(".capability-detail-title").waitFor();
		assert.equal(readCapability(cwd, "review").content, "typed during PUT and follow-up collection GET");

		// A collection GET that observes an external disk edit must not replace
		// the editor's optimistic baseline. The next save consequently conflicts.
		await page.locator("#capabilityEditBtn").click();
		await page.locator("#capabilityContent").fill("local draft against external writer");
		writeCapability(cwd, "review", "external disk version");
		const externalGet = watchGet();
		await page.locator("#capabilityRefreshBtn").click();
		const externalCollection = await externalGet;
		assert.equal(externalCollection.capabilities.find((entry: any) => entry.selector === "project:review").capability.content, "external disk version");
		assert.equal(await page.locator("#capabilityContent").inputValue(), "local draft against external writer");
		const conflictPut = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await conflictPut;
		await page.locator(".capability-message.error").filter({ hasText: /revision conflict|stale/i }).waitFor();
		assert.equal(putResults.at(-1)!.status, 409);
		assert.equal(putRequests.at(-1)!.expectedSourceRevision, putResults[1]!.body.sourceRevision, "external GET must not steal the optimistic revision");
		assert.equal(readCapability(cwd, "review").content, "external disk version");
		assert.equal(await page.locator("#capabilityContent").inputValue(), "local draft against external writer");
		assert.equal(await page.locator(".capability-dirty-badge").isVisible(), true);

		// A late GET is also fenced when the user leaves the editor. Selecting a
		// different capability while it is held must not resurrect the cancelled draft.
		const lateGet = watchGet(true);
		await page.locator("#capabilityRefreshBtn").click();
		await lateGet;
		await page.locator("[data-capability-row]").filter({ hasText: "other" }).click();
		await page.locator(".capability-detail-title").filter({ hasText: "other" }).waitFor();
		releaseGet();
		await page.waitForTimeout(80);
		assert.equal(await page.locator("#capabilityContent").count(), 0, "a late collection GET must not reopen the cancelled editor");

		// POST has the same snapshot boundary. Its real write is delayed only at
		// the response, and the following save must be a PUT, never a second POST.
		await page.locator("#capabilityNewBtn").click();
		await page.locator("#capabilityId").fill("created");
		await page.locator("#capabilityContent").fill("create first version");
		holdPost = true;
		const createPost = watchPost();
		await page.locator("#capabilitySaveBtn").click();
		await createPost;
		assert.equal(readCapability(cwd, "created").content, "create first version");
		await page.locator("#capabilityContent").fill("create edited while POST pending");
		await forceSecondSaveClick();
		assert.equal(postRequests.length, 1, "the pending POST must not be duplicated by a forced Save");

		// The request body is captured separately because POST route.fetch has
		// already completed the actual server-side create at this point.
		assert.equal(postResults[0]!.status, 200);
		const createFollowupGet = watchGet(true);
		releasePost();
		await createFollowupGet;
		assert.equal(await page.locator("#capabilityContent").inputValue(), "create edited while POST pending");
		releaseGet();
		await page.locator(".capability-dirty-badge").waitFor();
		assert.equal(readCapability(cwd, "created").content, "create first version");
		assert.equal(postResults[0]!.body.sourceRevision, revisionOf(cwd, "created"));

		const createdPut = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await createdPut;
		assert.equal(postRequests.length, 1, "the second create save must remain a PUT");
		assert.equal(putRequests.at(-1)!.capability.content, "create edited while POST pending");
		assert.equal(putRequests.at(-1)!.expectedSourceRevision, postResults[0]!.body.sourceRevision);
		await page.locator(".capability-detail-title").waitFor();
		assert.equal(readCapability(cwd, "created").content, "create edited while POST pending");

		// A successful disk write without a receipt is still an application error:
		// keep the draft and its old baseline, so the retry cannot silently adopt
		// the unacknowledged write (and receives the real 409).
		await page.locator("[data-capability-row]").filter({ hasText: "created" }).click();
		await page.locator("#capabilityEditBtn").click();
		await page.locator("#capabilityContent").fill("draft with missing receipt");
		dropPutReceipt = true;
		const missingReceiptPut = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await missingReceiptPut;
		await page.locator(".capability-message.error").filter({ hasText: /source revision receipt/i }).waitFor();
		assert.equal(await page.locator("#capabilityContent").inputValue(), "draft with missing receipt");
		assert.equal(await page.locator(".capability-dirty-badge").isVisible(), true);
		assert.equal(readCapability(cwd, "created").content, "draft with missing receipt");
		dropPutReceipt = false;
		const missingReceiptRetry = watchPut();
		await page.locator("#capabilitySaveBtn").click();
		await missingReceiptRetry;
		assert.equal(putResults.at(-1)!.status, 409);
		assert.equal(await page.locator("#capabilityContent").inputValue(), "draft with missing receipt");
		assert.equal(await page.locator(".capability-dirty-badge").isVisible(), true);
        // Editing only during the post-write collection GET is a separate
        // boundary: the PUT receipt initially marked this editor clean.
        await page.locator("#capabilityCancelBtn").click();
        await page.locator('[data-capability-row]').filter({ hasText: "review" }).click();
        await page.locator("#capabilityEditBtn").click();
        await page.locator("#capabilityContent").fill("saved before GET-only edit");
        const cleanFollowup = watchGet(true);
        await page.locator("#capabilitySaveBtn").click();
        await cleanFollowup;
        await page.locator("#capabilityContent").fill("new edit only during GET");
        releaseGet();
        await page.locator(".capability-dirty-badge").waitFor();
        assert.equal(await page.locator("#capabilityContent").inputValue(), "new edit only during GET");
        const getOnlySave = watchPut();
        await page.locator("#capabilitySaveBtn").click(); await getOnlySave;
        await page.locator(".capability-detail-title").waitFor();
        assert.equal(readCapability(cwd, "review").content, "new edit only during GET");

        // Cancel is available during the follow-up GET. Its stale completion
        // must not leave the whole Capabilities surface permanently busy.
        await page.locator("#capabilityEditBtn").click();
        await page.locator("#capabilityContent").fill("saved before cancel");
        const cancelledFollowup = watchGet(true);
        await page.locator("#capabilitySaveBtn").click(); await cancelledFollowup;
        await page.locator("#capabilityCancelBtn").click();
        releaseGet();
        await page.waitForTimeout(80);
        assert.equal(await page.locator("#capabilityRefreshBtn").isEnabled(), true, "cancelling a mutation refresh must release its busy fence");
        await page.locator("#capabilityRefreshBtn").click();
        await page.locator("#capabilityEditBtn").click();
        assert.equal(await page.locator("#capabilityContent").inputValue(), "saved before cancel");
		assert.deepEqual(browserErrors, []);
	} finally {
		releaseHeldPut?.();
		releaseHeldPost?.();
		releaseHeldGet?.();
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
		await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
});
