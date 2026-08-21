import assert from "node:assert/strict";
import test from "node:test";

import {
	activateEditorView,
	currentEditorView,
	resetEditorViewCoordinator,
	subscribeEditorView,
} from "../src/web-editor/client/editor-view-coordinator.ts";

test("editor view activation synchronously hands the shared panel to one owner", () => {
	resetEditorViewCoordinator();
	const transitions: string[] = [];
	const stopFirst = subscribeEditorView((viewId) => transitions.push(`first:${viewId}`));
	const stopSecond = subscribeEditorView((viewId) => transitions.push(`second:${viewId}`));

	activateEditorView("preview");
	assert.equal(currentEditorView(), "preview");
	assert.deepEqual(transitions, ["first:preview", "second:preview"]);

	stopFirst();
	activateEditorView("subagent-config");
	assert.equal(currentEditorView(), "subagent-config");
	assert.deepEqual(transitions, ["first:preview", "second:preview", "second:subagent-config"]);

	stopSecond();
	resetEditorViewCoordinator();
});
