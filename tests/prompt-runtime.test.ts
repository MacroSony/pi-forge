import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promptRuntimeFromCompileOptions, promptRuntimeFromPi } from "../src/prompt-runtime.ts";
import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("promptRuntimeFromPi maps Pi options and model into the host-neutral snapshot", () => {
	const options: BuildSystemPromptOptions = {
		cwd: "/tmp/proj",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read files." },
		promptGuidelines: ["Be concise."],
		appendSystemPrompt: "Extra.",
		contextFiles: [{ path: "notes.md", content: "hello" }],
		skills: [{
			name: "review",
			description: "Review skill",
			filePath: "/tmp/proj/skills/review/SKILL.md",
			baseDir: "/tmp/proj/skills/review",
			sourceInfo: { path: "/tmp/proj/skills/review/SKILL.md", source: "test", scope: "project", origin: "top-level" },
			disableModelInvocation: false,
		}],
	};
	const ctx = { model: { provider: "test-provider", id: "model-x", api: "openai" } } as unknown as ExtensionContext;
	const runtime = promptRuntimeFromPi(options, ctx, "latest user", new Date("2026-08-19T00:00:00Z"));

	assert.equal(runtime.options.cwd, "/tmp/proj");
	assert.deepEqual([...runtime.options.selectedTools!], ["read", "bash"]);
	assert.equal(runtime.options.toolSnippets!.read, "Read files.");
	assert.deepEqual([...runtime.options.promptGuidelines!], ["Be concise."]);
	assert.equal(runtime.options.appendSystemPrompt, "Extra.");
	assert.equal(runtime.options.contextFiles![0]!.path, "notes.md");
	assert.equal(runtime.options.skills![0]!.name, "review");
	assert.deepEqual(runtime.model, { provider: "test-provider", id: "model-x", api: "openai" });
	assert.equal(runtime.latestUserMessage, "latest user");
	assert.equal(runtime.now.toISOString(), "2026-08-19T00:00:00.000Z");
});

test("promptRuntimeFromCompileOptions accepts a host-neutral model without Pi types", () => {
	const runtime = promptRuntimeFromCompileOptions(
		{ cwd: "/tmp/proj" },
		{ provider: "p", id: "m", api: "api" },
		"hello",
		new Date("2026-08-19T00:00:00Z"),
	);
	assert.equal(runtime.options.cwd, "/tmp/proj");
	assert.deepEqual(runtime.model, { provider: "p", id: "m", api: "api" });
	assert.equal(runtime.latestUserMessage, "hello");
});

test("compiler-boundary modules do not import Pi coding-agent runtime types", () => {
	for (const file of [
		"src/compiler.ts",
		"src/template-render.ts",
		"src/slot-renderers.ts",
		"src/render-helpers.ts",
		"src/types.ts",
	]) {
		const source = readFileSync(join(rootDir, file), "utf8");
		assert.equal(
			/from\s+["']@earendil-works\/pi-coding-agent["']/.test(source),
			false,
			`${file} must not import Pi coding-agent types`,
		);
	}
});
