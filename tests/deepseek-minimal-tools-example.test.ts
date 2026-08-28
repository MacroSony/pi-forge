import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerDeepSeekMinimalTools from "../examples/deepseek-minimal-tools-extension/index.ts";

type RegisteredTool = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

test("deepseek minimal tools example registers the two DSH-shaped tools", async () => {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, () => Promise<void>>();
	registerDeepSeekMinimalTools({
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: () => Promise<void>) {
			handlers.set(event, handler);
		},
	} as any);
	const bash = tools.get("bash");
	const editor = tools.get("str_replace_editor");
	assert.ok(bash);
	assert.ok(editor);
	assert.deepEqual(Object.keys((bash.parameters as any).properties), ["command"]);
	assert.match(bash.description, /State is persistent across command calls/);
	assert.match(editor.description, /Custom editing tool for viewing, creating and editing files/);
	assert.match(JSON.stringify(editor.parameters), /str_replace/);

	const dir = await mkdtemp(join(tmpdir(), "pi-forge-dsh-minimal-"));
	const file = join(dir, "demo.txt");
	try {
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "session-a" } };
		assert.match(textOf(await editor.execute("c1", { command: "create", path: file, file_text: "alpha\nbeta\nalpha\n" }, undefined, undefined, ctx)), /New file created successfully/);
		assert.match(textOf(await editor.execute("c2", { command: "view", path: file, view_range: [2, -1] }, undefined, undefined, ctx)), /view_range=\[2, -1\][\s\S]*2\s+beta[\s\S]*3\s+alpha/);
		await assert.rejects(
			editor.execute("c3", { command: "str_replace", path: file, old_str: "alpha", new_str: "gamma" }, undefined, undefined, ctx),
			/Multiple occurrences of old_str/,
		);
		assert.match(textOf(await editor.execute("c4", { command: "str_replace", path: file, old_str: "beta", new_str: "delta" }, undefined, undefined, ctx)), /edited successfully/);
		assert.match(textOf(await editor.execute("c5", { command: "insert", path: file, insert_line: 1, new_str: "inserted" }, undefined, undefined, ctx)), /edited successfully/);
		assert.equal(await readFile(file, "utf8"), "alpha\ninserted\ndelta\nalpha\n");

		assert.equal(textOf(await bash.execute("b1", { command: "cd .. && export PI_FORGE_DSH_TEST=works && pwd" }, undefined, undefined, ctx)).trim(), dir.replace(/\/[^/]+$/, ""));
		assert.equal(textOf(await bash.execute("b2", { command: "printf '%s|%s' \"$PWD\" \"$PI_FORGE_DSH_TEST\"" }, undefined, undefined, ctx)), `${dir.replace(/\/[^/]+$/, "")}|works`);
		const otherSession = { cwd: dir, sessionManager: { getSessionId: () => "session-b" } };
		assert.equal(textOf(await bash.execute("b3", { command: "printf '%s|%s' \"$PWD\" \"${PI_FORGE_DSH_TEST:-missing}\"" }, undefined, undefined, otherSession)), `${dir}|missing`);
		assert.match(textOf(await bash.execute("b4", { command: "printf nope; exit 7" }, undefined, undefined, ctx)), /nope\n\[shell exited: code 7\][\s\S]*persistent bash shell was reset/);
	} finally {
		await handlers.get("session_shutdown")?.();
		await rm(dir, { recursive: true, force: true });
	}
});
