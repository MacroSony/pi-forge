/**
 * v5.3 素材录制 C：Reuse 章
 * preset 切换（default → minimal 激活徽标移动）+ Agent profiles 页（模型+思考强度+预设组合）。
 * 运行：PI_FORGE_PROMO_OUT_DIR=/path/to/output node scripts/record-v5-reuse.ts
 */
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeProfile,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

const OUT_DIR = process.env.PI_FORGE_PROMO_OUT_DIR
	?? join(process.cwd(), ".pi", "forge", "recordings");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const HOLD = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODEL_REF = { provider: "anthropic", id: "claude-sonnet-4-5" }; // profile 引用只允许这两个字段
const REGISTRY_MODEL = { ...MODEL_REF, name: "Claude Sonnet 4.5", reasoning: true }; // 注册表里的完整模型对象

mkdirSync(OUT_DIR, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "pi-forge-v5re-"));
mkdirSync(promptStacksDir(cwd), { recursive: true });
for (const [src, name] of [
	["examples/default-prompt-stack.json", "default.json"],
	["examples/minimal-prompt-stack.json", "minimal.json"],
]) copyFileSync(src, join(promptStacksDir(cwd), name));

writeProfile(cwd, "focused.json", {
	schemaVersion: 1,
	type: "pi-forge.agent-profile",
	id: "focused",
	name: "Focused Agent",
	description: "Sonnet + high thinking + default preset",
	model: MODEL_REF,
	thinkingLevel: "high",
	promptStack: "default",
});
writeProfile(cwd, "worker.json", {
	schemaVersion: 1,
	type: "pi-forge.agent-profile",
	id: "worker",
	name: "Minimal Worker",
	description: "Sonnet + no thinking + minimal preset",
	model: MODEL_REF,
	thinkingLevel: "off",
	promptStack: "minimal",
});

const harness = createHarness({
	models: [REGISTRY_MODEL],
	availableModels: [REGISTRY_MODEL],
	currentModel: REGISTRY_MODEL,
});
const context = createContext(cwd, [], {
	trusted: true,
	modelRuntime: { getCurrentModel: harness.getCurrentModel, modelRegistry: harness.modelRegistry },
});
await startSession(harness, context.ctx);
await harness.commands.preset.handler("ui", context.ctx);
const editorUrl = latestEditorUrl(context.editors);
console.log("editor:", editorUrl.href);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
	recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
page.setDefaultTimeout(10_000);

try {
	await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
	await page.locator(".item-row").first().waitFor();
	const darkBtn = page.getByRole("button", { name: /Dark/i }).first();
	if (await darkBtn.count()) { await darkBtn.click(); await HOLD(500); }
	await HOLD(1200); // 定场：default active

	// --- preset 切换：minimal ---
	await page.locator(".stack-row").filter({ hasText: "minimal" }).first().click();
	await HOLD(1400); // 看清 minimal 的精简 items
	await page.locator("button").filter({ hasText: /^Activate$/ }).first().click();
	await HOLD(1800); // active 徽标移动

	// --- Agent profiles 页 ---
	const profilesTab = page.getByRole("button", { name: /Agent profiles/i }).first();
	if (await profilesTab.count()) { await profilesTab.click(); await HOLD(2200); }

	// 回 stacks 页收尾（minimal active 状态）
	const stacksTab = page.getByRole("button", { name: /Prompt stacks/i }).first();
	if (await stacksTab.count()) { await stacksTab.click(); await HOLD(1600); }
} finally {
	const video = page.video();
	await ctx.close();
	await browser.close();
	await harness.commands.preset.handler("ui stop", context.ctx);
	const videoPath = await video?.path();
	if (videoPath) {
		const { execSync } = await import("node:child_process");
		const out = join(OUT_DIR, "screencap_v5_reuse.mp4");
		execSync(`ffmpeg -y -i "${videoPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${out}"`);
		console.log("✓", out);
	}
}
