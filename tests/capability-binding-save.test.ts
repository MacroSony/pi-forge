import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePromptStack, serializePromptStack } from "../src/codecs/prompt-stack.ts";
import { readPromptStacks, promptStackTargetPath, writePromptStackFile } from "../src/repositories/prompt-stack.ts";
import { createWebEditorHost, type WebHostRuntime } from "../src/web-host.ts";
import type { PromptStack } from "../src/types.ts";

function stack(id: string, capabilities?: PromptStack["capabilities"]): PromptStack {
	return {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id,
		...(capabilities === undefined ? {} : { capabilities }),
		items: [{ kind: "block", id: "body", content: "body" }],
	};
}

function trustedContext(cwd: string): ExtensionContext {
	return { cwd, isProjectTrusted: () => true } as unknown as ExtensionContext;
}

function testRuntime(cwd: string): WebHostRuntime {
	let stacks = readPromptStacks(cwd);
	return {
		getStacks: () => stacks,
		getActive: () => undefined,
		getActiveId: () => undefined,
		getSelectedActiveId: () => undefined,
		setActive: () => true,
		reloadStacks: async () => { stacks = readPromptStacks(cwd); },
	} as unknown as WebHostRuntime;
}

function writeStack(cwd: string, value: PromptStack): void {
	const filePath = promptStackTargetPath(cwd, "project", value.id);
	const result = writePromptStackFile(cwd, "project", filePath, value, { overwrite: true });
	assert.equal(result.ok, true);
}

function sourceRevision(cwd: string, id: string): string {
	const filePath = promptStackTargetPath(cwd, "project", id);
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function withWorkspace(run: (cwd: string) => Promise<void> | void): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-binding-save-"));
	try {
		await run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("GET remembers raw source revision and stale binding save is rejected after external revocation", async () => {
	await withWorkspace(async (cwd) => {
		const initial = stack("bindings", [{ ref: "global:review", modelCallable: true }]);
		writeStack(cwd, initial);
		const host = createWebEditorHost(trustedContext(cwd), testRuntime(cwd));
		const loaded = host.getStack("project:bindings");
		assert.ok(loaded);
		assert.equal(loaded.sourceRevision, sourceRevision(cwd, "bindings"));

		// Another writer revokes the current grant without refreshing this tab's runtime view.
		writeStack(cwd, stack("bindings"));
		const stale = await host.saveStack("project:bindings", {
			...initial,
			name: "stale draft",
		}, loaded.sourceRevision);
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.equal(stale.status, 409);
		assert.deepEqual(JSON.parse(readFileSync(promptStackTargetPath(cwd, "project", "bindings"), "utf8")), stack("bindings"));
	});
});

test("old callers without capabilities keep the existing save contract", async () => {
	await withWorkspace(async (cwd) => {
		writeStack(cwd, stack("legacy"));
		const host = createWebEditorHost(trustedContext(cwd), testRuntime(cwd));
		writeStack(cwd, { ...stack("legacy"), name: "external update" });

		const result = await host.saveStack("project:legacy", { ...stack("legacy"), description: "saved by old caller" });
		assert.equal(result.ok, true);
		const saved = JSON.parse(readFileSync(promptStackTargetPath(cwd, "project", "legacy"), "utf8"));
		assert.equal(saved.description, "saved by old caller");
	});
});

test("a correctly revised new binding save is allowed", async () => {
	await withWorkspace(async (cwd) => {
		writeStack(cwd, stack("new-binding"));
		const host = createWebEditorHost(trustedContext(cwd), testRuntime(cwd));
		const loaded = host.getStack("project:new-binding");
		assert.ok(loaded);
		const proposed = stack("new-binding", [{ ref: "global:review", modelCallable: true }]);
		const result = await host.saveStack("project:new-binding", proposed, loaded.sourceRevision);
		assert.equal(result.ok, true);
		const reparsed = parsePromptStack(
			readFileSync(promptStackTargetPath(cwd, "project", "new-binding"), "utf8"),
			promptStackTargetPath(cwd, "project", "new-binding"),
			"project",
		);
		assert.deepEqual(reparsed.stack.capabilities, proposed.capabilities);
	});
});

test("repository parsing rejects a project capability binding in a global preset", () => {
	const parsed = parsePromptStack(
		serializePromptStack(stack("global-binding", [{ ref: "project:review" }])),
		"/tmp/global-binding.json",
		"global",
	);
	assert.ok(parsed.diagnostics.some((diagnostic) => /Global binding cannot reference project capability/.test(diagnostic.message)));
});


test("GET never attaches a fresh source revision to stale cached authorization", async () => {
 await withWorkspace(async cwd => {
  writeStack(cwd, stack("grant", [{ref:"global:review",modelCallable:true}]));
  const host=createWebEditorHost(trustedContext(cwd),testRuntime(cwd));
  writeStack(cwd, stack("grant", [{ref:"global:review",modelCallable:false}]));
  const loaded=host.getStack("project:grant")!;
  assert.equal(loaded.stack.capabilities![0].modelCallable,false);
  assert.equal(loaded.sourceRevision,sourceRevision(cwd,"grant"));
 });
});
test("legacy no-revision save cannot erase bindings added after the cached Preset was loaded", async () => {
 await withWorkspace(async cwd => {
  writeStack(cwd,stack("legacy")); const host=createWebEditorHost(trustedContext(cwd),testRuntime(cwd));
  writeStack(cwd,stack("legacy",[{ref:"global:review",modelCallable:false}]));
  const result=await host.saveStack("project:legacy",stack("legacy"));
  assert.equal(result.ok,false); if(!result.ok) assert.equal(result.status,409);
 });
});


test("save receipt identifies this write even if an external writer changes the file during reload", async () => {
	await withWorkspace(async (cwd) => {
		writeStack(cwd, stack("receipt"));
		const runtime = testRuntime(cwd);
		const reload = runtime.reloadStacks;
		runtime.reloadStacks = async (...args) => {
			writeStack(cwd, { ...stack("receipt"), description: "external newer version" });
			await reload(...args);
		};
		const host = createWebEditorHost(trustedContext(cwd), runtime);
		const before = host.getStack("project:receipt")!;
		const submitted = { ...stack("receipt"), description: "my save" };
		const result = await host.saveStack("project:receipt", submitted, before.sourceRevision);
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.equal(result.sourceRevision, createHash("sha256").update(serializePromptStack(submitted)).digest("hex"));
		assert.notEqual(result.sourceRevision, sourceRevision(cwd, "receipt"));
		const retry = await host.saveStack("project:receipt", { ...submitted, description: "next edit" }, result.sourceRevision);
		assert.equal(retry.ok, false);
		if (!retry.ok) assert.equal(retry.status, 409);
	});
});


test("legacy binding sources cannot be silently erased by normalized Web save or overwrite", async () => {
 await withWorkspace(async cwd => {
  const original = { ...stack("old-bindings"), instructionModes: [{ ref: "global:review", modelCallable: true }] };
  writeStack(cwd, stack("old-bindings"));
  const file = promptStackTargetPath(cwd, "project", "old-bindings");
  const bytes = JSON.stringify(original, null, 2);
  writeFileSync(file, bytes);
  const host = createWebEditorHost(trustedContext(cwd), testRuntime(cwd));
  const loaded = host.getStack("project:old-bindings");
  assert.ok(loaded);
  const normalizedSave = await host.saveStack("project:old-bindings", loaded.stack, loaded.sourceRevision);
  assert.equal(normalizedSave.ok, false);
  if (!normalizedSave.ok) { assert.equal(normalizedSave.status, 409); assert.match(normalizedSave.error, /instructionModes/); }
  const overwrite = await host.createStack(stack("old-bindings"), { scope: "project", overwrite: true, activate: false });
  assert.equal(overwrite.ok, false);
  if (!overwrite.ok) assert.equal(overwrite.status, 409);
  const rawSave = await host.saveStack("project:old-bindings", original, loaded.sourceRevision);
  assert.equal(rawSave.ok, false);
  if (!rawSave.ok) assert.equal(rawSave.status, 400);
  const create = await host.createStack({ ...original, id: "new-old" }, { scope: "project", activate: false });
  assert.equal(create.ok, false);
  if (!create.ok) assert.equal(create.status, 400);
  assert.equal(readFileSync(file, "utf8"), bytes, "all rejected writes preserve exact original binding source");
 });
});
