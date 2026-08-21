import assert from "node:assert/strict";
import test from "node:test";

import {
	EDITOR_TABS,
	copyStackFields,
	editorTabButtonId,
	getEditorTab,
	isEditorVueTab,
} from "../src/web-editor/client/tab-registry.ts";

test("tab registry lists the existing editor tabs in their display order", () => {
	assert.deepEqual(
		EDITOR_TABS.map((tab) => tab.id),
		["items", "regex", "policy", "stack", "preview"],
	);
});

test("tab registry ids are unique and every definition carries its button metadata", () => {
	const ids = EDITOR_TABS.map((tab) => tab.id);
	assert.equal(new Set(ids).size, ids.length);

	for (const tab of EDITOR_TABS) {
		assert.equal(typeof tab.id, "string");
		assert.ok(tab.id.length > 0);
		assert.equal(typeof tab.label, "string");
		assert.equal(typeof tab.icon, "string");
		assert.equal(typeof tab.title, "string");
		assert.ok(tab.mount === "legacy" || tab.mount === "vue");
	}
});

test("tab registry keeps the legacy items workspace and the three vue tabs", () => {
	assert.equal(getEditorTab("items")?.mount, "legacy");
	for (const id of ["regex", "policy", "stack"]) {
		assert.equal(getEditorTab(id)?.mount, "vue");
		assert.ok(getEditorTab(id)!.stackFields.length > 0);
	}
	for (const id of ["regex", "policy", "stack"]) {
		assert.equal(isEditorVueTab(id), true);
	}
	assert.equal(isEditorVueTab("items"), false);
	assert.equal(isEditorVueTab("unknown-tab"), false);
});

test("registry metadata reproduces the buttons previously hardcoded in App.vue", () => {
	assert.deepEqual(
		{
			items: getEditorTab("items"),
			regex: getEditorTab("regex"),
			policy: getEditorTab("policy"),
			stack: getEditorTab("stack"),
		},
		{
			items: { id: "items", label: "Items", icon: "☰", title: "Edit prompt stack items", mount: "legacy", stackFields: [], internalDock: false },
			regex: { id: "regex", label: "Regex", icon: ".*", title: "Edit regex transform rules", mount: "vue", stackFields: ["regex"], internalDock: false },
			policy: { id: "policy", label: "Policy", icon: "⊕", title: "Edit active-tool policy and model-visible skill filtering", mount: "vue", stackFields: ["tools", "skills"], internalDock: false },
			stack: { id: "stack", label: "Stack", icon: "{}", title: "Edit context options and raw stack JSON", mount: "vue", stackFields: ["context", "variables"], internalDock: false },
		},
	);
});

test("editorTabButtonId derives the stable button ids used by the legacy editor and browser tests", () => {
	assert.deepEqual(
		EDITOR_TABS.map((tab) => editorTabButtonId(tab.id)),
		["itemsTabBtn", "regexTabBtn", "policyTabBtn", "stackTabBtn", "previewTabBtn"],
	);
});

test("getEditorTab and isEditorVueTab tolerate unknown ids", () => {
	assert.equal(getEditorTab("nope"), undefined);
	assert.equal(isEditorVueTab("nope"), false);
});

test("copyStackFields copies present optional fields and deletes absent ones", () => {
	const target = {
		id: "target",
		tools: { allow: ["read"] },
		skills: { allow: ["browser"] },
		regex: { rules: [] },
	};
	const source = {
		id: "source",
		tools: { allow: ["*"] },
	};

	copyStackFields(target, source, ["tools", "skills"]);

	assert.deepEqual(target, {
		id: "target",
		tools: { allow: ["*"] },
		regex: { rules: [] },
	});
});

test("copyStackFields matches the previous per-tab draft sync for the stack tab", () => {
	const target = {
		id: "t",
		context: { allowDuplicateChatHistory: true },
		variables: { char: "泉此方" },
		junk: true,
	};
	const source = {
		id: "s",
		variables: { char: "updated" },
	};

	copyStackFields(target, source, ["context", "variables"]);

	assert.deepEqual(target, {
		id: "t",
		variables: { char: "updated" },
		junk: true,
	});
});
