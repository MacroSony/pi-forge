import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chromium, type Page } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeProfile,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { agentProfilePath } from "../src/agent-profile.ts";
import { promptStacksDir } from "../src/loader.ts";
import { GLOBAL_FORGE_DIR_ENV, globalAgentProfilePath } from "../src/storage.ts";
import { UiContributionProvider } from "../src/ui-contribution/contrib-port.ts";

test("web editor preserves its shell and guarded editing state", { timeout: 30_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		writeStack(cwd, "alternate.json", stackFixture("alternate", "Alternate stack"));
	}, async ({ editorUrl, page }) => {
		const unauthorizedUrl = new URL(editorUrl);
		unauthorizedUrl.search = "";
		const unauthorized = await page.request.get(unauthorizedUrl.href);
		assert.equal(unauthorized.status(), 403);
		assert.equal(await unauthorized.text(), "Invalid pi-forge editor token.");

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.title(), "pi-forge editor");
		assert.equal(await page.locator(".brand").textContent(), "pi-forge stack editor");
		assert.equal(await page.locator(".stack-row").count(), 2);
		assert.equal(await page.locator("#status").textContent(), "Loaded default");
		assert.equal(await page.locator("#itemContent").inputValue(), "Content for default.");
		assert.equal(await page.locator("#settings").isVisible(), false);
		const scopeBox = await page.locator("#stackCreateScope").boundingBox();
		const newStackBox = await page.locator("#newStackBtn").boundingBox();
		const actionsBox = await page.locator(".main-actions").boundingBox();
		const workspaceBox = await page.locator("#workspace").boundingBox();
		assert.ok(scopeBox && newStackBox && actionsBox && workspaceBox);
		assert.ok(Math.abs(scopeBox.y - newStackBox.y) < 2, "scope and New stack should remain one compact control");
		assert.ok(scopeBox.width < 120, "stack scope should not consume a full toolbar row");
		assert.ok(actionsBox.height <= 44, "primary stack actions should fit on one compact row");
		assert.ok(workspaceBox.y <= 225, "stack editing should begin near the top of the viewport");
		assert.equal(await page.locator("#deleteStackBtn").isVisible(), false);
		await page.locator("#moreActions > summary").click();
		assert.equal(await page.locator("#deleteStackBtn").isVisible(), true);
		await page.locator("#moreActions > summary").click();
		await page.setViewportSize({ width: 901, height: 720 });
		const narrowNewStackBox = await page.locator("#newStackBtn").boundingBox();
		const narrowActivateBox = await page.locator("#activateBtn").boundingBox();
		assert.ok(narrowNewStackBox && narrowActivateBox);
		const controlsOverlap = !(
			narrowNewStackBox.x + narrowNewStackBox.width <= narrowActivateBox.x
			|| narrowActivateBox.x + narrowActivateBox.width <= narrowNewStackBox.x
			|| narrowNewStackBox.y + narrowNewStackBox.height <= narrowActivateBox.y
			|| narrowActivateBox.y + narrowActivateBox.height <= narrowNewStackBox.y
		);
		assert.equal(controlsOverlap, false, "compact stack creation must not overlap Activate at narrow desktop widths");
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
		await page.setViewportSize({ width: 390, height: 844 });
		const mobileTopbarBox = await page.locator(".topbar").boundingBox();
		const mobileSidebarBox = await page.locator(".sidebar").boundingBox();
		assert.ok(mobileTopbarBox && mobileSidebarBox);
		assert.ok(mobileTopbarBox.height <= 44, "mobile stack status bar should stay on one row");
		assert.ok(mobileSidebarBox.height <= 240, "mobile stack list should not push the editor below the fold indefinitely");
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
		await page.setViewportSize({ width: 1280, height: 720 });

		const initialTheme = await page.locator("body").getAttribute("data-theme");
		assert.ok(initialTheme === "light" || initialTheme === "dark");
		await page.locator("#themeToggleBtn").click();
		const toggledTheme = initialTheme === "light" ? "dark" : "light";
		assert.equal(await page.locator("body").getAttribute("data-theme"), toggledTheme);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.locator("body").getAttribute("data-theme"), toggledTheme);

		// The theme toggle lives in the shared surface nav: it must stay visible
		// and functional on the profiles surface too.
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator("#themeToggleBtn").click();
		assert.equal(await page.locator("body").getAttribute("data-theme"), initialTheme);
		await page.locator("#stacksSurfaceBtn").click();

		await page.locator("#sidebarToggleBtn").click();
		assert.equal(await page.locator("#shell").getAttribute("class"), "shell sidebar-collapsed");
		assert.equal(await page.locator("#status").textContent(), "Prompt stacks sidebar hidden");
		await page.locator("#sidebarToggleBtn").click();
		assert.equal(await page.locator("#shell").getAttribute("class"), "shell");

		await page.locator("#itemContent").fill("Unsaved content.");
		await page.locator("#dirtyBadge.visible").waitFor();

		page.once("dialog", async (dialog) => {
			assert.equal(dialog.type(), "confirm");
			assert.equal(dialog.message(), "Discard unsaved changes?");
			await dialog.dismiss();
		});
		await page.locator(".stack-row", { hasText: "alternate" }).click();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "defaultactive");
		assert.equal(await page.locator("#itemContent").inputValue(), "Unsaved content.");

		page.once("dialog", async (dialog) => {
			assert.equal(dialog.message(), "Discard unsaved changes?");
			await dialog.accept();
		});
		await page.locator(".stack-row", { hasText: "alternate" }).click();
		await page.locator("#status").filter({ hasText: "Loaded alternate" }).waitFor();
		assert.equal(await page.locator("#itemContent").inputValue(), "Content for alternate.");

		await page.locator("#stackTabBtn").click();
		const rawStack = JSON.parse(await page.locator("#stackJsonText").inputValue()) as Record<string, unknown>;
		await page.locator("#stackJsonText").fill(JSON.stringify({ id: "alternate" }));
		await page.locator("#applyStackJsonBtn").click();
		assert.equal(await page.locator("#status").textContent(), "Stack JSON needs an items array.");

		rawStack.name = "Raw JSON edit";
		rawStack.items = [{ kind: "block", id: "raw", role: "system", content: "Raw content." }];
		await page.locator("#stackJsonText").fill(JSON.stringify(rawStack));
		await page.locator("#applyStackJsonBtn").click();
		await page.locator("#status").filter({ hasText: "Applied stack JSON to editor" }).waitFor();
		await page.locator("#dirtyBadge.visible").waitFor();
		await page.locator("#itemsTabBtn").click();
		assert.equal(await page.locator("#itemContent").inputValue(), "Raw content.");
	});
});

test("web editor transitions between populated and empty stack states", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "only.json", stackFixture("only", "Only stack", true));
	}, async ({ cwd, editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		await page.locator("#regexTabBtn").click();
		await page.locator("#addRegexRuleBtn").waitFor();

		page.once("dialog", async (dialog) => {
			assert.match(dialog.message(), /Delete prompt stack 'only'/);
			await dialog.accept();
		});
		await page.locator("#moreActions > summary").click();
		await page.locator("#deleteStackBtn").click();
		await page.locator(".empty-title").filter({ hasText: "No prompt stacks found." }).waitFor();
		assert.equal(await page.locator("#saveBtn").isDisabled(), true);
		assert.equal(await page.locator("#metadataPanel").isVisible(), false);
		assert.equal(existsSync(join(promptStacksDir(cwd), "only.json")), false);

		const promptAnswers = ["replacement", "Replacement stack"];
		page.on("dialog", async (dialog) => {
			assert.equal(dialog.type(), "prompt");
			const answer = promptAnswers.shift();
			assert.notEqual(answer, undefined);
			await dialog.accept(answer);
		});
		await page.locator("#emptyNewStackBtn").click();
		await page.locator("#status").filter({ hasText: "Created replacement" }).waitFor();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "replacementactive");
		assert.equal(await page.locator("#saveBtn").isEnabled(), true);
		assert.equal(existsSync(join(promptStacksDir(cwd), "replacement.json")), true);
		assert.deepEqual(promptAnswers, []);
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator(".profile-empty").filter({ hasText: "No agent profiles found." }).waitFor();
	});
});

test("profile preflight refreshes after prompt-stack deletion", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		for (let index = 0; index < 8; index += 1) {
			writeProfile(cwd, `profile-${index}.json`, {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: `profile-${index}`,
				model: { provider: "test", id: "target" },
				thinkingLevel: "high",
				promptStack: "default",
			});
		}
		writeProfile(cwd, "reviewer.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "default",
		});
	}, async ({ editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator('[data-profile-row][data-profile-id="reviewer"]').click();
		await page.locator(".profile-applicability").filter({ hasText: "Ready to apply" }).waitFor();

		await page.locator("#stacksSurfaceBtn").click();
		page.once("dialog", async (dialog) => {
			assert.match(dialog.message(), /Delete prompt stack 'default'/);
			await dialog.accept();
		});
		await page.locator("#moreActions > summary").click();
		await page.locator("#deleteStackBtn").click();
		await page.locator(".empty-title").filter({ hasText: "No prompt stacks found." }).waitFor();

		await page.locator("#profilesSurfaceBtn").click();
		await page.locator(".profile-applicability").filter({ hasText: "Preflight failed" }).waitFor();
		assert.match(await page.locator(".profile-diagnostics").textContent() ?? "", /Unknown prompt stack: default/);
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
	});
});

test("stack diagnostics panel collapses and expands", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		writeStack(cwd, "warned.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "warned",
			name: "Warned stack",
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "No history slot here." }],
		});
	}, async ({ editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		// Clean stack: collapsed slim header, body hidden.
		const diagnostics = page.locator(".diagnostics");
		assert.equal(await diagnostics.getAttribute("class"), "diagnostics collapsed");
		assert.equal(await page.locator(".diagnostics-title").textContent(), "Diagnostics · none");
		assert.equal(await page.locator(".diagnostics-body").isVisible(), false);

		// Warnings auto-expand the panel.
		await page.locator(".stack-row", { hasText: "warned" }).click();
		await page.locator(".diagnostics-title").filter({ hasText: "1 warning" }).waitFor();
		assert.equal(await diagnostics.getAttribute("class"), "diagnostics");
		assert.equal(await page.locator(".diagnostics-body").isVisible(), true);

		// Back to clean: auto-collapses again until the user toggles.
		await page.locator(".stack-row", { hasText: "default" }).click();
		await page.locator(".diagnostics-title").filter({ hasText: "none" }).waitFor();
		assert.equal(await diagnostics.getAttribute("class"), "diagnostics collapsed");
		await page.locator("#diagnosticsToggleBtn").click();
		assert.equal(await diagnostics.getAttribute("class"), "diagnostics");
		assert.equal(await page.locator(".diagnostics-body").isVisible(), true);
		assert.match(await page.locator(".diagnostics-body").textContent() ?? "", /No diagnostics/);
		assert.equal(await page.locator("#diagnosticsToggleBtn").getAttribute("aria-expanded"), "true");

		// The explicit user choice wins over the automatic state.
		await page.locator(".stack-row", { hasText: "warned" }).click();
		await page.locator(".diagnostics-title").filter({ hasText: "1 warning" }).waitFor();
		assert.equal(await diagnostics.getAttribute("class"), "diagnostics");
	});
});

test("web editor navigates project profile resolution without losing stack state", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Profile stack", true));
		writeStack(cwd, "alternate.json", {
			...stackFixture("alternate", "Alternate profile stack"),
			tools: { allow: ["read"] },
		});
		writeProfile(cwd, "reviewer.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			name: "Reviewer",
			description: "Review project changes.",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "default",
		});
		writeProfile(cwd, "broken.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "broken",
			name: "Broken",
			model: { provider: "missing", id: "model" },
			thinkingLevel: "medium",
			promptStack: "missing-stack",
		});
	}, async ({ cwd, editorUrl, expectBrowserError, page }) => {
		const unauthorizedProfilesUrl = new URL("/api/profiles", editorUrl);
		const unauthorized = await page.request.get(unauthorizedProfilesUrl.href);
		assert.equal(unauthorized.status(), 403);

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "defaultactive");
		await page.locator("#itemContent").fill("Hidden dirty content.");
		await page.locator("#policyTabBtn").click();

		await page.locator("#profilesSurfaceBtn").click();
		await page.locator("[data-profile-row]").first().waitFor();
		assert.equal(await page.locator("[data-profile-row]").count(), 2);
		await page.keyboard.press("Control+s");
		assert.equal(
			JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8")).items[0].content,
			"Content for default.",
		);

		await page.locator('[data-profile-row][data-profile-id="reviewer"]').click();
		await page.locator(".profile-applicability").filter({ hasText: "Ready to apply" }).waitFor();
		assert.match(await page.locator(".profile-main").textContent() ?? "", /test\/current/);
		assert.match(await page.locator(".profile-main").textContent() ?? "", /test\/target/);
		assert.match(await page.locator(".profile-main").textContent() ?? "", /default/);
		assert.match(await page.locator(".profile-diagnostics").textContent() ?? "", /No diagnostics/);

		writeProfile(cwd, "reviewer.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			name: "Reviewer refreshed",
			description: "Review project changes.",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "default",
		});
		await page.locator("#profileRefreshBtn").click();
		await page.locator(".profile-title").filter({ hasText: "Reviewer refreshed" }).waitFor();

		await page.locator("#profileNewBtn").click();
		await page.locator("#profileId").fill("scout");
		assert.equal(await page.locator("#profilePromptStack").inputValue(), "default");
		await page.locator("#profileName").fill("Scout");
		await page.locator("#profileDescription").fill("Explore a focused change.");
		await page.locator("#profileModelProvider").fill("test");
		await page.locator("#profileModelId").fill("target");
		await page.locator("#profileThinkingLevel").selectOption("medium");
		await page.locator("#profilePromptStack").selectOption("alternate");
		await page.locator("#profileValidateBtn").click();
		await page.locator("#profileEditorStatus").filter({ hasText: "Valid and ready to apply" }).waitFor();
		assert.match(await page.locator(".profile-editor-validation").textContent() ?? "", /No diagnostics/);
		await page.locator("#profileSaveBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Created scout" }).waitFor();
		assert.equal(await page.locator("[data-profile-row]").count(), 3);
		assert.equal(
			JSON.parse(readFileSync(agentProfilePath(cwd, "scout"), "utf8")).description,
			"Explore a focused change.",
		);

		await page.locator("#profileEditBtn").click();
		assert.equal(await page.locator("#profileId").isEditable(), false);
		await page.locator("#profileName").fill("Scout updated");
		await page.locator("#profileSaveBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Saved scout" }).waitFor();
		assert.equal(JSON.parse(readFileSync(agentProfilePath(cwd, "scout"), "utf8")).name, "Scout updated");

		await page.locator("#profileEditBtn").click();
		await page.locator("#profileModelId").fill("missing");
		await page.locator("#profileValidateBtn").click();
		await page.locator("#profileEditorStatus").filter({ hasText: "validation error" }).waitFor();
		assert.match(await page.locator(".profile-editor-validation").textContent() ?? "", /Unknown model: test\/missing/);
		page.once("dialog", async (dialog) => {
			assert.match(dialog.message(), /Discard unsaved agent-profile changes/);
			await dialog.dismiss();
		});
		await page.locator("#profileCancelBtn").click();
		assert.equal(await page.locator("#profileEditorStatus").isVisible(), true);
		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator("#profileCancelBtn").click();

		await page.locator("#profileApplyBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Applied scout once" }).waitFor();
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /test\/target ·\s*medium ·\s*project:alternate/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Last applied\s*scout/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Source definition\s*unchanged/);
		assert.match(
			await page.locator('[data-profile-row][data-profile-id="scout"]').textContent() ?? "",
			/last applied/,
		);

		await page.locator("#profileCreateScope").selectOption("global");
		await page.locator("#profileNewBtn").click();
		assert.equal(await page.locator("#profilePromptStack").inputValue(), "");
		await page.locator("#profileCancelBtn").click();
		await page.locator("#profileCreateScope").selectOption("project");

		page.once("dialog", async (dialog) => {
			await dialog.dismiss();
		});
		await page.locator("#profileDeleteBtn").click();
		assert.equal(existsSync(agentProfilePath(cwd, "scout")), true);

		const externallyChangedScout = JSON.parse(readFileSync(agentProfilePath(cwd, "scout"), "utf8"));
		externallyChangedScout.name = "Scout externally changed";
		writeProfile(cwd, "scout.json", externallyChangedScout);
		page.once("dialog", async (dialog) => {
			assert.match(dialog.message(), /Delete agent profile scout/);
			await dialog.accept();
		});
		expectBrowserError(/Failed to load resource: the server responded with a status of 409/);
		await page.locator("#profileDeleteBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "changed on disk" }).waitFor();
		assert.equal(existsSync(agentProfilePath(cwd, "scout")), true);
		await page.locator("#profileRefreshBtn").click();
		await page.locator(".profile-title").filter({ hasText: "Scout externally changed" }).waitFor();

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator("#profileDeleteBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Deleted scout" }).waitFor();
		assert.equal(existsSync(agentProfilePath(cwd, "scout")), false);
		assert.equal(await page.locator("[data-profile-row]").count(), 2);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Last applied\s*scout/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Source definition\s*missing/);

		writeProfile(cwd, "occupied.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "different-internal-id",
			model: { provider: "test", id: "target" },
			thinkingLevel: "medium",
			promptStack: "default",
		});
		const occupiedValidation = await page.request.post(new URL("/api/profiles/validate", editorUrl).href, {
			headers: { "x-pi-forge-token": editorUrl.searchParams.get("token")! },
			data: {
				profile: {
					schemaVersion: 1,
					type: "pi-forge.agent-profile",
					id: "occupied",
					model: { provider: "test", id: "target" },
					thinkingLevel: "medium",
					promptStack: "default",
				},
			},
		});
		assert.equal(occupiedValidation.status(), 200);
		assert.match(await occupiedValidation.text(), /Profile file already exists/);

		await page.locator('[data-profile-row][data-profile-id="broken"]').click();
		await page.locator(".profile-applicability").filter({ hasText: "Preflight failed" }).waitFor();
		assert.equal(await page.locator("#profileApplyBtn").isDisabled(), true);
		assert.match(await page.locator(".profile-diagnostics").textContent() ?? "", /Unknown model: missing\/model/);
		assert.match(await page.locator(".profile-diagnostics").textContent() ?? "", /Unknown prompt stack: missing-stack/);
		const invalidApply = await page.request.post(new URL("/api/profiles/broken/apply", editorUrl).href, {
			headers: { "x-pi-forge-token": editorUrl.searchParams.get("token")! },
		});
		assert.equal(invalidApply.status(), 400);
		assert.match(await invalidApply.text(), /failed preflight/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /test\/target ·\s*medium ·\s*project:alternate/);

		await page.locator('[data-profile-row][data-profile-id="reviewer"]').click();
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "default");
		assert.equal(await page.locator(".stack-row.active .stack-name").textContent(), "alternateactive");
		assert.equal(
			await page.locator('[data-policy-kind="tools"] [data-resource-name="bash"]').getAttribute("class"),
			"resource-chip",
		);
		await page.locator("#itemsTabBtn").click();
		assert.equal(await page.locator("#itemContent").inputValue(), "Hidden dirty content.");
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator("[data-profile-row]").first().waitFor();
		assert.equal(await page.locator("[data-profile-row]").count(), 2);
		assert.equal(
			await page.locator("[data-profile-row].selected").getAttribute("data-profile-id"),
			"reviewer",
		);
		assert.equal(await page.locator(".profile-title").textContent(), "Reviewer refreshed");
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
		thinkingLevel: "low",
	});
});

test("web editor refreshes runtime state after a failed profile application", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Rollback stack", true));
		writeProfile(cwd, "rollback.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "rollback",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "default",
		});
	}, async ({ editorUrl, expectBrowserError, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator('[data-profile-row][data-profile-id="rollback"]').click();
		await page.locator(".profile-applicability").filter({ hasText: "Ready to apply" }).waitFor();

		expectBrowserError(/Failed to load resource: the server responded with a status of 500/);
		await page.locator("#profileApplyBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "instead of high" }).waitFor();
		assert.match(
			await page.locator(".profile-runtime-card").textContent() ?? "",
			/test\/current ·\s*low ·\s*project:default/,
		);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /No profile has been applied/);
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(await page.locator(".stack-row.active .stack-name").textContent(), "defaultactive");
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
		thinkingLevel: "low",
		resolveThinkingLevel: (_model, requested) => requested === "high" ? "low" : requested,
	});
});

test("web editor enforces a single auto-activation profile", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		writeProfile(cwd, "first.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "first",
			name: "First",
			autoActivate: true,
			model: { provider: "test", id: "target" },
			thinkingLevel: "medium",
			promptStack: "default",
		});
	}, async ({ cwd, editorUrl, expectBrowserError, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#profilesSurfaceBtn").click();
		const firstRow = page.locator('[data-profile-row][data-profile-id="first"]');
		await firstRow.waitFor();
		assert.equal(await firstRow.locator(".badge", { hasText: "auto" }).count(), 1);

		await page.locator("#profileNewBtn").click();
		const providerOptions = await page.locator("#profileProviderOptions option")
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value")));
		assert.deepEqual(providerOptions, ["test"]);
		await page.locator("#profileModelProvider").fill("test");
		const modelOptions = await page.locator("#profileModelOptions option")
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value")).sort());
		assert.deepEqual(modelOptions, ["current", "target"]);

		await page.locator("#profileId").fill("second");
		await page.locator("#profileModelId").fill("target");
		await page.locator("#profileThinkingLevel").selectOption("medium");
		await page.locator("#profilePromptStack").selectOption("default");
		await page.locator("#profileAutoActivate").check();
		await page.locator("#profileValidateBtn").click();
		await page.locator("#profileEditorStatus").filter({ hasText: "validation error" }).waitFor();
		assert.match(
			await page.locator(".profile-editor-validation").textContent() ?? "",
			/Multiple profiles request auto-activation; exactly one is allowed/,
		);

		expectBrowserError(/Failed to load resource: the server responded with a status of 409/);
		await page.locator("#profileSaveBtn").click();
		await page.locator("#profileEditorStatus.error").filter({ hasText: /auto-activation/ }).waitFor();
		assert.equal(await page.locator("[data-profile-row]").count(), 1);
		assert.equal(existsSync(agentProfilePath(cwd, "second")), false);

		await page.locator("#profileAutoActivate").uncheck();
		await page.locator("#profileSaveBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Created second" }).waitFor();
		assert.equal(await page.locator("[data-profile-row]").count(), 2);
		assert.equal(JSON.parse(readFileSync(agentProfilePath(cwd, "second"), "utf8")).autoActivate, undefined);
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
	});
});

test("web editor reports profile runtime drift after external changes", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		writeStack(cwd, "alternate.json", stackFixture("alternate", "Alternate stack"));
		writeProfile(cwd, "reviewer.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "alternate",
		});
	}, async ({ context, editorUrl, harness, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#profilesSurfaceBtn").click();
		await page.locator('[data-profile-row][data-profile-id="reviewer"]').click();
		await page.locator(".profile-applicability").filter({ hasText: "Ready to apply" }).waitFor();
		await page.locator("#profileApplyBtn").click();
		await page.locator("#profilesStatus").filter({ hasText: "Applied reviewer once" }).waitFor();
		const drift = page.locator(".profile-drift");
		assert.match(await drift.textContent() ?? "", /Model: unchanged/);
		assert.match(await drift.textContent() ?? "", /Thinking: unchanged/);
		assert.match(await drift.textContent() ?? "", /Stack: unchanged/);

		await harness.setModel(currentModel);
		harness.setThinkingLevel("low");
		await harness.commands.preset.handler("use default", context.ctx);

		await page.locator("#profileRefreshBtn").click();
		await page.locator(".profile-runtime-card").filter({ hasText: /test\/current ·\s*low ·\s*project:default/ }).waitFor();
		assert.match(await drift.textContent() ?? "", /Model: drifted/);
		assert.match(await drift.textContent() ?? "", /Thinking: drifted/);
		assert.match(await drift.textContent() ?? "", /Stack: drifted/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Last applied\s*reviewer/);
		assert.match(await page.locator(".profile-runtime-card").textContent() ?? "", /Source definition\s*unchanged/);
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
		thinkingLevel: "low",
	});
});

test("web editor constrains both surfaces to the viewport with internal scrolling", { timeout: 20_000 }, async (t) => {
	const currentModel = browserModel("test", "current");
	const targetModel = browserModel("test", "target");
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		for (let index = 0; index < 8; index += 1) {
			writeProfile(cwd, `profile-${index}.json`, {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: `profile-${index}`,
				model: { provider: "test", id: "target" },
				thinkingLevel: "high",
				promptStack: "default",
			});
		}
		writeProfile(cwd, "reviewer.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: "default",
		});
	}, async ({ editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		const stacksLayout = await page.evaluate(() => ({
			viewport: innerHeight,
			app: document.querySelector("#app")!.getBoundingClientRect().height,
			shell: document.querySelector("#shell")!.getBoundingClientRect(),
		}));
		assert.equal(stacksLayout.app, stacksLayout.viewport, "#app must fill, not exceed, the viewport");
		assert.ok(
			stacksLayout.shell.bottom <= stacksLayout.viewport,
			`stacks shell bottom ${stacksLayout.shell.bottom} exceeds viewport ${stacksLayout.viewport}`,
		);

		await page.locator("#profilesSurfaceBtn").click();
		await page.locator("[data-profile-row]").first().waitFor();
		const profilesLayout = await page.evaluate(() => {
			const main = document.querySelector(".profile-main")!;
			const rect = main.getBoundingClientRect();
			return {
				viewport: innerHeight,
				app: document.querySelector("#app")!.getBoundingClientRect().height,
				mainBottom: rect.bottom,
				mainClient: main.clientHeight,
				mainScroll: main.scrollHeight,
			};
		});
		assert.equal(profilesLayout.app, profilesLayout.viewport);
		assert.ok(
			profilesLayout.mainBottom <= profilesLayout.viewport,
			`profile main bottom ${profilesLayout.mainBottom} exceeds viewport ${profilesLayout.viewport}`,
		);
		assert.ok(
			profilesLayout.mainScroll >= profilesLayout.mainClient,
			"profile main must not clip overflowing content after delegation UI removal",
		);
	}, {
		currentModel,
		models: [currentModel, targetModel],
		availableModels: [currentModel, targetModel],
	});
});

test("Vue item editor preserves structured and advanced slot options", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		const stack = stackFixture("default", "Item editor", true);
		stack.items[1] = {
			kind: "slot",
			id: "history",
			enabled: true,
			slot: "chat-history",
			options: {
				futureOption: { preserve: true },
			},
		} as any;
		writeStack(cwd, "default.json", stack);
	}, async ({ cwd, editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator('[data-item-index="1"]').click();
		assert.equal(await page.locator("#itemSlot").inputValue(), "chat-history");
		assert.equal(await page.locator('[data-option="includeLastUserMessage"]').isChecked(), true);

		await page.locator('[data-option="includeLastUserMessage"]').uncheck();
		await page.locator("#slotOptionsJsonBtn").click();
		assert.match(await page.locator("#itemOptions").inputValue(), /"futureOption"/);
		assert.match(await page.locator("#itemOptions").inputValue(), /"includeLastUserMessage": false/);

		await page.locator("#itemOptions").fill("{");
		await page.locator("#saveBtn").click();
		await page.locator("#status").filter({ hasText: "Invalid item options JSON" }).waitFor();
		assert.equal(await page.locator("#itemOptions").inputValue(), "{");

		await page.locator("#itemOptions").fill(JSON.stringify({
			futureOption: { preserve: true },
			includeLastUserMessage: false,
			maxMessages: 3,
		}, null, 2));
		await page.locator("#slotOptionsFormBtn").click();
		assert.equal(await page.locator('[data-option="maxMessages"]').inputValue(), "3");
		await page.locator("#slotOptionsJsonBtn").click();
		assert.match(await page.locator("#itemOptions").inputValue(), /"futureOption"/);

		await page.locator("#saveBtn").click();
		await page.locator("#status").filter({ hasText: "Loaded default" }).waitFor();
		const saved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8"));
		assert.deepEqual(saved.items[1].options, {
			futureOption: { preserve: true },
			includeLastUserMessage: false,
			maxMessages: 3,
		});
	});
});

test("Vue tabs preserve drafts, errors, and unknown fields", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", {
			...stackFixture("default", "Vue tab stack", true),
			tools: {
				allow: ["*"],
			},
			regex: {
				schemaVersion: 1,
				rules: [{
					id: "existing",
					enabled: true,
					stage: "compiled",
					effect: "outgoing",
					targets: ["messages"],
					pattern: "Content",
					replace: "Text",
					futureRuleField: { preserve: true },
				}],
			},
		});
		writeStack(cwd, "alternate.json", stackFixture("alternate", "Alternate stack"));
	}, async ({ cwd, editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		await page.locator("#stackTabBtn").click();
		await page.locator("#metadataToggleBtn").click();
		await page.locator("#stackName").fill("Vue tabs edited");
		await page.locator("#allowDuplicateChatHistoryInput").check();
		await page.locator("#addVariableBtn").click();
		await page.locator("#addVariableBtn").click();
		const variableRows = page.locator("[data-var-row]");
		await variableRows.nth(0).locator("[data-var-value]").fill("first");
		await variableRows.nth(1).locator("[data-var-name]").fill("var1");
		await variableRows.nth(1).locator("[data-var-value]").fill("second");
		assert.equal(await page.locator("#status").textContent(), "Duplicate stack variable names.");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#stackTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "Duplicate stack variable names." })
			.waitFor();
		assert.equal(await page.locator("[data-var-row]").count(), 1);
		await page.locator("[data-var-row] [data-var-value]").fill("resolved");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#stackTabBtn").click();

		const rawStack = JSON.parse(await page.locator("#stackJsonText").inputValue()) as {
			context?: Record<string, unknown>;
			tools?: Record<string, unknown>;
			variables?: Record<string, unknown>;
		};
		assert.ok(rawStack.tools);
		rawStack.tools.futurePolicyField = { preserve: true };
		await page.locator("#stackJsonText").fill(JSON.stringify(rawStack));
		await page.locator("#applyStackJsonBtn").click();
		await page.locator("#status").filter({ hasText: "Applied stack JSON to editor" }).waitFor();

		await page.locator("#regexTabBtn").click();
		const regexRow = page.locator("[data-regex-row]").first();
		await regexRow.locator("[data-regex-max-messages]").fill("0");
		assert.match(
			await page.locator("#status").textContent() ?? "",
			/maxMessages must be a positive integer/,
		);
		await page.locator("#itemsTabBtn").click();
		await page.locator("#regexTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "maxMessages must be a positive integer" })
			.waitFor();
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#regexTabBtn").click();
		await page.locator("[data-regex-row]").first().locator("[data-regex-max-messages]").fill("2");
		await page.locator("#policyTabBtn").click();
		const toolsPolicy = page.locator('[data-policy-row][data-policy-kind="tools"]');
		await toolsPolicy.locator("[data-policy-patterns]").fill("read\nread");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "tools.allow has duplicate pattern: read" })
			.waitFor();

		await page.locator("#policyTabBtn").click();
		await page.locator('[data-policy-row][data-policy-kind="tools"] [data-policy-patterns]').fill("read");
		await page.locator("#regexTabBtn").click();
		await page.locator("#policyTabBtn").click();
		await page.locator("#itemsTabBtn").click();
		await page.locator("#regexTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status").filter({ hasText: "Loaded default" }).waitFor();

		const saved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8")) as {
			context?: Record<string, unknown>;
			name?: string;
			tools?: Record<string, unknown>;
			regex?: { rules?: Array<Record<string, unknown>> };
			variables?: Record<string, unknown>;
		};
		assert.equal(saved.context?.allowDuplicateChatHistory, true);
		assert.equal(saved.name, "Vue tabs edited");
		assert.deepEqual(saved.tools?.futurePolicyField, { preserve: true });
		assert.deepEqual(saved.regex?.rules?.[0]?.futureRuleField, { preserve: true });
		assert.deepEqual(saved.tools?.allow, ["read"]);
		assert.equal(saved.regex?.rules?.[0]?.maxMessages, 2);
		assert.deepEqual(saved.variables, { var1: "resolved" });

		await page.locator(".stack-row", { hasText: "alternate" }).click();
		await page.locator("#status").filter({ hasText: "Loaded alternate" }).waitFor();
		await page.locator("#regexTabBtn").click();
		await page.locator("#reloadBtn").click();
		await page.locator("#status").filter({ hasText: "Reloaded from disk" }).waitFor();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "alternate");
	});
});

test("profile editor preserves and displays a global profile selector after save", { timeout: 20_000 }, async (t) => {
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-browser-global-profile-"));
	const previousGlobalRoot = process.env[GLOBAL_FORGE_DIR_ENV];
	try {
		process.env[GLOBAL_FORGE_DIR_ENV] = globalRoot;
		mkdirSync(join(globalRoot, "agent-profiles"), { recursive: true });
		writeFileSync(globalAgentProfilePath("reviewer"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "reviewer",
			name: "Global Reviewer",
			model: { provider: "test", id: "target" },
			thinkingLevel: "high",
			promptStack: null,
		}), "utf8");
		const currentModel = browserModel("test", "current");
		const targetModel = browserModel("test", "target");
		await withBrowserEditor(t, (cwd) => {
			writeStack(cwd, "default.json", stackFixture("default", "Default", true));
		}, async ({ cwd, editorUrl, page }) => {
			await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
			await page.locator("#profilesSurfaceBtn").click();
			const row = page.locator('[data-profile-selector="global:reviewer"]');
			await row.waitFor();
			assert.match(await row.textContent() ?? "", /global:reviewer/);
			await row.click();
			assert.equal(await page.locator(".profile-selector code").textContent(), "global:reviewer");
			await page.locator("#profileEditBtn").click();
			assert.match(await page.locator(".profile-editor-title").textContent() ?? "", /global:reviewer/);
			await page.locator("#profileName").fill("Global Reviewer Saved");
			await page.locator("#profileSaveBtn").click();
			await page.locator("#profilesStatus").filter({ hasText: "Saved global:reviewer" }).waitFor();
			assert.equal(JSON.parse(readFileSync(globalAgentProfilePath("reviewer"), "utf8")).name, "Global Reviewer Saved");
			assert.equal(existsSync(agentProfilePath(cwd, "reviewer")), false);
		}, {
			currentModel,
			models: [currentModel, targetModel],
			availableModels: [currentModel, targetModel],
			thinkingLevel: "low",
		});
	} finally {
		if (previousGlobalRoot === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalRoot;
		rmSync(globalRoot, { recursive: true, force: true });
	}
});

test("web editor renders a contributed tab through SchemaForm and writes values back", { timeout: 20_000 }, async (t) => {
	const descriptor = {
		tabId: "subagent-config",
		title: "Subagent",
		icon: "⚙",
		schema: {
			title: "Subagent settings",
			fields: [
				{ key: "backend", label: "Backend", type: "enum", options: ["auto", "cli"] },
				{ key: "timeoutMs", label: "Timeout (ms)", type: "number", required: true, min: 1 },
			],
		},
		values: { backend: "auto", timeoutMs: 3000 },
	};
	const secondaryDescriptor = {
		tabId: "other-config",
		title: "Other",
		icon: "◇",
		schema: {
			title: "Other settings",
			fields: [{ key: "level", label: "Level", type: "number", required: true, min: 1 }],
		},
		values: { level: 2 },
	};
	const writes: Record<string, unknown>[] = [];
	let provider: UiContributionProvider | undefined;

	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Contribution stack", true));
	}, async ({ editorUrl, page, harness }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		const createProvider = (primary = descriptor) => new UiContributionProvider(harness.eventsBus, {
			providerId: "pi-forge-subagents-settings",
			handle: (operation, payload) => {
				if (operation === "listContributions") {
					return { ok: true, data: { tabs: [primary, { ...structuredClone(primary), title: "Duplicate must be ignored" }, secondaryDescriptor] } };
				}
				if (operation === "writeValues") {
					const request = payload as { tabId: string; patch: Record<string, unknown> };
					writes.push(request.patch);
					return { ok: true, data: { ok: true, values: request.patch } };
				}
				return { ok: false, error: `Unknown operation: ${operation}` };
			},
		});
		provider = createProvider();
		provider.start();
		await page.locator("#settingsSurfaceBtn").waitFor();
		assert.equal(await page.locator(".view-tabs #settings-subagent-configTabBtn").count(), 0);
		await page.locator("#settingsSurfaceBtn").click();
		await page.locator("#settings-subagent-configTabBtn").waitFor();
		assert.equal(await page.locator("#settings-subagent-configTabBtn").count(), 1);

		await page.locator("#settings-subagent-configTabBtn").click();
		await page.locator(".schema-form").filter({ hasText: "Subagent settings" }).waitFor();
		let firstPutSeenResolve: () => void = () => {};
		let releaseFirstPut: () => void = () => {};
		const firstPutSeen = new Promise<void>((resolve) => { firstPutSeenResolve = resolve; });
		const firstPutRelease = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
		let putRequests = 0;
		await page.route(/\/api\/contrib\/subagent-config$/, async (route) => {
			putRequests += 1;
			if (putRequests === 1) {
				firstPutSeenResolve();
				await firstPutRelease;
			}
			await route.continue();
		});
		await page.locator('[data-field-input="timeoutMs"]').fill("999");
		await page.locator("#settingsStatus").filter({ hasText: "Unsaved changes" }).waitFor();
		await firstPutSeen;
		await page.locator('[data-field-input="timeoutMs"]').fill("777");
		await page.waitForTimeout(350);
		assert.equal(putRequests, 1);
		assert.deepEqual(writes, []);
		releaseFirstPut();
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.deepEqual(writes, [
			{ backend: "auto", timeoutMs: 999 },
			{ backend: "auto", timeoutMs: 777 },
		]);
		assert.equal(putRequests, 2);
		await page.unroute(/\/api\/contrib\/subagent-config$/);

		await page.locator('[data-field-input="timeoutMs"]').fill("666");
		await page.locator("#settings-other-configTabBtn").click();
		await page.locator(".schema-form").filter({ hasText: "Other settings" }).waitFor();
		assert.equal(await page.locator("#settingsStatus").textContent(), "Settings ready");
		await page.locator("#settings-subagent-configTabBtn").click();
		assert.equal(await page.locator('[data-field-input="timeoutMs"]').inputValue(), "666");
		assert.equal(await page.locator("#settingsStatus").textContent(), "Unsaved changes");
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.deepEqual(writes.at(-1), { backend: "auto", timeoutMs: 666 });

		await page.setViewportSize({ width: 390, height: 844 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
		assert.equal(await page.locator("#settingsSurface").isVisible(), true);
		await page.setViewportSize({ width: 1280, height: 720 });

		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#previewTabBtn").click();
		await page.locator("#editorDockArea.dock-open").waitFor();
		await page.locator("#settingsSurfaceBtn").click();
		await page.locator(".schema-form").filter({ hasText: "Subagent settings" }).waitFor();
		await page.locator('[data-field-input="backend"]').selectOption("cli");
		await page.locator("#settingsStatus").filter({ hasText: "Unsaved changes" }).waitFor();
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.deepEqual(writes.at(-1), { backend: "cli", timeoutMs: 666 });

		const restartedDescriptor = structuredClone(descriptor);
		restartedDescriptor.schema.title = "Restarted subagent settings";
		restartedDescriptor.values = { backend: "auto", timeoutMs: 4242 };
		provider.stop();
		provider = createProvider(restartedDescriptor);
		provider.start();
		await page.locator(".schema-form").filter({ hasText: "Restarted subagent settings" }).waitFor();
		assert.equal(await page.locator('[data-field-input="timeoutMs"]').inputValue(), "4242");

		let staleResponseSeenResolve: () => void = () => {};
		let releaseStaleResponse: () => void = () => {};
		const staleResponseSeen = new Promise<void>((resolve) => { staleResponseSeenResolve = resolve; });
		const staleResponseRelease = new Promise<void>((resolve) => { releaseStaleResponse = resolve; });
		await page.route(/\/api\/contrib\/subagent-config$/, async (route) => {
			const response = await route.fetch();
			staleResponseSeenResolve();
			await staleResponseRelease;
			await route.fulfill({ response });
		});
		await page.locator('[data-field-input="timeoutMs"]').fill("5151");
		await staleResponseSeen;
		const secondRestartedDescriptor = structuredClone(descriptor);
		secondRestartedDescriptor.schema.title = "Second restarted subagent settings";
		secondRestartedDescriptor.values = { backend: "auto", timeoutMs: 6000 };
		provider.stop();
		provider = createProvider(secondRestartedDescriptor);
		provider.start();
		await page.locator(".schema-form").filter({ hasText: "Second restarted subagent settings" }).waitFor();
		assert.equal(await page.locator('[data-field-input="timeoutMs"]').inputValue(), "5151");
		releaseStaleResponse();
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.equal(await page.locator('[data-field-input="timeoutMs"]').inputValue(), "5151");
		assert.deepEqual(writes.slice(-2), [
			{ backend: "auto", timeoutMs: 5151 },
			{ backend: "auto", timeoutMs: 5151 },
		]);
		await page.unroute(/\/api\/contrib\/subagent-config$/);

		provider.stop();
		await page.locator("#settings-subagent-configTabBtn").waitFor({ state: "detached" });
		await page.locator("#settingsSurfaceBtn").waitFor({ state: "hidden" });
		await page.locator("#workspace").waitFor({ state: "visible" });
		provider = createProvider();
		provider.start();
		await page.locator("#settingsSurfaceBtn").waitFor();
		await page.locator("#settingsSurfaceBtn").click();
		await page.locator("#settings-subagent-configTabBtn").waitFor();

		await page.locator("#stacksSurfaceBtn").click();
		await page.locator("#itemsTabBtn").click();
		assert.equal((await page.locator("#itemsTabBtn").getAttribute("class"))?.includes("active"), true);
		assert.equal(await page.locator(".view-tabs #settings-subagent-configTabBtn").count(), 0);
	});
	t.after(() => provider?.stop());
});

test("clean contributed forms absorb live values while dirty drafts survive refresh", { timeout: 25_000 }, async (t) => {
	type MutableDescriptor = {
		tabId: string;
		title: string;
		icon: string;
		schema: {
			title: string;
			description?: string;
			fields: Array<Record<string, unknown>>;
		};
		values: Record<string, unknown>;
	};
	let descriptor: MutableDescriptor = {
		tabId: "live-settings",
		title: "Live settings",
		icon: "⚙",
		schema: {
			title: "Live settings",
			fields: [{ key: "timeoutMs", label: "Timeout", type: "number" }],
		},
		values: { timeoutMs: 3000 },
	};
	let provider: UiContributionProvider | undefined;

	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Live settings stack", true));
	}, async ({ editorUrl, expectBrowserError, page, harness }) => {
		provider = new UiContributionProvider(harness.eventsBus, {
			handle: (operation, payload) => {
				if (operation === "listContributions") return { ok: true, data: { tabs: [descriptor] } };
				if (operation === "writeValues") {
					const values = structuredClone((payload as { patch: Record<string, unknown> }).patch);
					descriptor = { ...descriptor, values };
					return { ok: true, data: { ok: true, values } };
				}
				return { ok: false, error: "Unknown operation" };
			},
		});
		provider.start();
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#settingsSurfaceBtn").waitFor();
		await page.locator("#settingsSurfaceBtn").click();
		const timeout = page.locator('[data-field-input="timeoutMs"]');
		const waitForAutosave = async (): Promise<void> => {
			await page.locator("#settingsStatus").filter({ hasText: /^(Unsaved changes|Saving)$/ }).waitFor();
			await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		};
		assert.equal(await timeout.inputValue(), "3000");

		// A same-generation external update must replace a clean mounted form.
		descriptor = { ...descriptor, values: { timeoutMs: 4000 } };
		await page.waitForFunction(() => (
			document.querySelector<HTMLInputElement>('[data-field-input="timeoutMs"]')?.value === "4000"
		));

		// A GET that captured old values before a newer PUT must not roll the
		// now-clean saved form back when that delayed response finally arrives.
		let releaseStaleGet!: () => void;
		let staleGetRead!: () => void;
		const staleGetRelease = new Promise<void>((resolve) => { releaseStaleGet = resolve; });
		const staleGetStarted = new Promise<void>((resolve) => { staleGetRead = resolve; });
		await page.route(/\/api\/contrib$/, async (route) => {
			const response = await route.fetch();
			staleGetRead();
			await staleGetRelease;
			await route.fulfill({ response });
		}, { times: 1 });
		await staleGetStarted;
		await timeout.fill("4500");
		await waitForAutosave();
		releaseStaleGet();
		await page.waitForTimeout(300);
		assert.equal(await timeout.inputValue(), "4500");

		// The same stale boundary applies to a failed response: an old polling
		// error must not tear down a form after a newer save has committed.
		let releaseStaleFailure!: () => void;
		let staleFailureRead!: () => void;
		const staleFailureRelease = new Promise<void>((resolve) => { releaseStaleFailure = resolve; });
		const staleFailureStarted = new Promise<void>((resolve) => { staleFailureRead = resolve; });
		await page.route(/\/api\/contrib$/, async (route) => {
			await route.fetch();
			staleFailureRead();
			await staleFailureRelease;
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "stale polling failure" }),
			});
		}, { times: 1 });
		await staleFailureStarted;
		await timeout.fill("4600");
		await waitForAutosave();
		expectBrowserError(/Failed to load resource: the server responded with a status of 500/);
		releaseStaleFailure();
		await page.waitForTimeout(300);
		assert.equal(await page.locator("#settingsSurface").isVisible(), true);
		assert.equal(await timeout.inputValue(), "4600");

		let releaseWrite!: () => void;
		let writeStarted!: () => void;
		const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
		const started = new Promise<void>((resolve) => { writeStarted = resolve; });
		await page.route(/\/api\/contrib\/live-settings$/, async (route) => {
			writeStarted();
			await writeRelease;
			await route.continue();
		});
		await timeout.fill("5000");
		await started;
		descriptor = { ...descriptor, values: { timeoutMs: 6000 } };
		await page.waitForTimeout(1200);
		assert.equal(await timeout.inputValue(), "5000", "polling must not replace a dirty draft");
		releaseWrite();
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		await page.unroute(/\/api\/contrib\/live-settings$/);

		// This mirrors a malformed config descriptor followed by an on-disk repair.
		descriptor = {
			...descriptor,
			schema: { ...descriptor.schema, description: "Cannot edit: malformed JSON" },
			values: { timeoutMs: "" },
		};
		await page.locator(".tab-section-meta").filter({ hasText: "malformed JSON" }).waitFor();
		assert.equal(await timeout.inputValue(), "");
		descriptor = {
			...descriptor,
			schema: { ...descriptor.schema, description: "Configuration repaired" },
			values: { timeoutMs: 7000 },
		};
		await page.locator(".tab-section-meta").filter({ hasText: "Configuration repaired" }).waitFor();
		assert.equal(await timeout.inputValue(), "7000");
	});
	t.after(() => provider?.stop());
});

test("schema record key options render a profile picker and deletion submits replacement state", { timeout: 20_000 }, async (t) => {
	const descriptor = {
		tabId: "profile-picker",
		title: "Profile picker",
		icon: "⚙",
		schema: {
			title: "Scoped profiles",
			fields: [{
				key: "profiles",
				label: "Project profiles",
				type: "record",
				keyLabel: "Agent profile",
				keyOptions: [
					{ value: "project:worker", label: "Project · worker" },
					{ value: "project:reviewer", label: "Project · reviewer" },
				],
				recordFields: [{ key: "enabled", label: "Enabled", type: "boolean" }],
			}],
		},
		values: { profiles: { "project:worker": { enabled: true } } },
	};
	const writes: Record<string, unknown>[] = [];
	let provider: UiContributionProvider | undefined;

	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Profile picker stack", true));
	}, async ({ editorUrl, page, harness }) => {
		provider = new UiContributionProvider(harness.eventsBus, {
			handle: (operation, payload) => {
				if (operation === "listContributions") return { ok: true, data: { tabs: [descriptor] } };
				if (operation === "writeValues") {
					const values = (payload as { patch: Record<string, unknown> }).patch;
					writes.push(structuredClone(values));
					return { ok: true, data: { ok: true, values } };
				}
				return { ok: false, error: "Unknown operation" };
			},
		});
		provider.start();
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#settingsSurfaceBtn").waitFor();
		await page.locator("#settingsSurfaceBtn").click();
		await page.locator("#settings-profile-pickerTabBtn").click();

		const table = page.locator('[data-record-table="profiles"]');
		assert.equal(await table.locator('input[data-record-key="profiles"]').count(), 0);
		const keySelect = table.locator('select[data-record-key="profiles"]');
		assert.equal(await keySelect.inputValue(), "project:worker");
		assert.match(await keySelect.locator("option:checked").textContent() ?? "", /Project · worker/);
		descriptor.schema.fields[0]!.keyOptions.push({ value: "project:new", label: "Project · new" });
		await keySelect.locator('option[value="project:new"]').waitFor({ state: "attached" });

		await table.locator('[data-delete-record="profiles"]').click();
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.deepEqual(writes.at(-1), { profiles: {} });
		assert.equal(await table.locator("[data-record-row]").count(), 0);

		await page.locator('[data-add-record="profiles"]').click();
		const addedSelect = table.locator('select[data-record-key="profiles"]');
		await addedSelect.selectOption("project:reviewer");
		await page.locator("#settingsStatus").filter({ hasText: /^Saved$/ }).waitFor();
		assert.deepEqual(writes.at(-1), { profiles: { "project:reviewer": { enabled: false } } });
	});
	t.after(() => provider?.stop());
});

function stackFixture(id: string, name: string, autoActivate = false) {
	return {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id,
		name,
		autoActivate,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: `Content for ${id}.` },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	};
}

async function withBrowserEditor(
	t: TestContext,
	prepare: (cwd: string) => void,
	run: (fixture: {
		context: ReturnType<typeof createContext>;
		cwd: string;
		editorUrl: URL;
		expectBrowserError(pattern: RegExp): void;
		harness: ReturnType<typeof createHarness>;
		page: Page;
	}) => Promise<void>,
	harnessOptions: Parameters<typeof createHarness>[0] = {},
	setupHarness?: (harness: ReturnType<typeof createHarness>) => Promise<void> | void,
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-browser-characterization-"));
	prepare(cwd);
	const harness = createHarness(harnessOptions);
	const context = createContext(cwd, [], {
		modelRuntime: {
			getCurrentModel: harness.getCurrentModel,
			modelRegistry: harness.modelRegistry,
		},
	});
	await startSession(harness, context.ctx);
	await setupHarness?.(harness);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let editorStarted = false;
	const browserErrors: string[] = [];
	const expectedBrowserErrors: Array<{ pattern: RegExp; matched: boolean }> = [];

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
			if (message.type() !== "error") return;
			const text = message.text();
			const expected = expectedBrowserErrors.find((candidate) => !candidate.matched && candidate.pattern.test(text));
			if (expected) expected.matched = true;
			else browserErrors.push(text);
		});

		try {
			await run({
				context,
				cwd,
				editorUrl,
				expectBrowserError: (pattern) => expectedBrowserErrors.push({ pattern, matched: false }),
				harness,
				page,
			});
		} catch (error) {
			const detail = browserErrors.length ? `\nBrowser errors:\n${browserErrors.join("\n")}` : "";
			const statusText = await page.locator("#status").textContent().catch(() => "(missing)");
			const stackRows = await page.locator(".stack-row").count().catch(() => -1);
			throw new Error(
				`${error instanceof Error ? error.stack ?? error.message : String(error)}${detail}\nEditor status: ${statusText}\nStack rows: ${stackRows}`,
				{ cause: error },
			);
		}
		assert.equal(
			expectedBrowserErrors.every((candidate) => candidate.matched),
			true,
			"Every expected browser error should be observed.",
		);
		assert.deepEqual(browserErrors, []);
	} finally {
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
	}
}

function browserModel(provider: string, id: string) {
	return {
		api: "openai-completions",
		provider,
		id,
		name: id,
		baseUrl: "http://localhost.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

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
