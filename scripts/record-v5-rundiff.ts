/**
 * v5.3 素材录制 B：Verify 章 Run diff
 * 通过真实捕获管线播种两轮 provider payload（before_provider_request 事件），
 * 编辑器 Run diff tab 展示两次请求的差异与前缀复用。
 * 运行：PI_FORGE_PROMO_OUT_DIR=/path/to/output node scripts/record-v5-rundiff.ts
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
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

const OUT_DIR = process.env.PI_FORGE_PROMO_OUT_DIR
	?? join(process.cwd(), ".pi", "forge", "recordings");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const HOLD = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "pi-forge-v5rd-"));
mkdirSync(promptStacksDir(cwd), { recursive: true });
copyFileSync("examples/default-prompt-stack.json", join(promptStacksDir(cwd), "default.json"));

const harness = createHarness();
const context = createContext(cwd, [], { trusted: true });
await startSession(harness, context.ctx);

// ── 播种两轮真实捕获（内容与 02 号卡同一假想会话）──
const SYS = [
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
	"",
	"Available tools:",
	"- read: Read a file from disk",
	"- bash: Run a shell command",
	"",
	"Guidelines:",
	"- Be concise in your responses",
	"- Show file paths clearly when working with files",
	"",
	"Current working directory: /home/user/demo",
].join("\n");
const M1 = { role: "user", content: [{ type: "text", text: "这个报错是什么原因？" }] };
const M2 = { role: "assistant", content: [{ type: "text", text: "我先看下日志……" }] };
const M3 = { role: "user", content: [{ type: "text", text: "帮我给这个函数补上单元测试" }] };
const M4 = { role: "assistant", content: [{ type: "text", text: "好，我先看一下现有的测试结构。" }] };
const TOOLS = [
	{ name: "read", description: "Read a file from disk", input_schema: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
];
const base = { model: "claude-sonnet-4-5", max_tokens: 8192, system: SYS, tools: TOOLS };

await harness.events["before_provider_request"]({ payload: { ...base, messages: [M1, M2] } }, context.ctx);
await HOLD(400);
await harness.events["before_provider_request"]({ payload: { ...base, messages: [M1, M2, M3, M4] } }, context.ctx);
console.log("✓ seeded 2 captures via before_provider_request");

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
	await HOLD(1200);

	await page.locator("#previewTabBtn").click();
	await page.locator("#editorDockArea.dock-open").waitFor();
	await HOLD(1200);

	const runTab = page.getByRole("tab", { name: /Run diff/i }).first();
	if (await runTab.count()) await runTab.click();
	else await page.getByRole("button", { name: /Run diff/i }).first().click();
	await HOLD(2500); // 展示两轮对比 + 前缀复用统计

	// 展开/滚动看细节
	const refresh = page.getByRole("button", { name: /Refresh/i }).first();
	if (await refresh.count()) { await refresh.click(); await HOLD(1800); }
} finally {
	const video = page.video();
	await ctx.close();
	await browser.close();
	await harness.commands.preset.handler("ui stop", context.ctx);
	const videoPath = await video?.path();
	if (videoPath) {
		const { execSync } = await import("node:child_process");
		const out = join(OUT_DIR, "screencap_v5_rundiff.mp4");
		execSync(`ffmpeg -y -i "${videoPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${out}"`);
		console.log("✓", out);
	}
}
