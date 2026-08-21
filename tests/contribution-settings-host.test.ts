import assert from "node:assert/strict";
import test from "node:test";

import {
	settingsContributionButtonId,
	uniqueContributionDescriptors,
	type ContributionTabDescriptor,
} from "../src/web-editor/client/contribution-settings.ts";

function descriptor(tabId: string, title = tabId): ContributionTabDescriptor {
	return { tabId, title, icon: "", schema: { fields: [] }, values: {} };
}

test("settings contribution buttons cannot collide with built-in stack tab ids", () => {
	assert.equal(settingsContributionButtonId("items"), "settings-itemsTabBtn");
	assert.equal(settingsContributionButtonId("subagent-config"), "settings-subagent-configTabBtn");
});

test("settings contributions keep the first descriptor for each tab id", () => {
	assert.deepEqual(
		uniqueContributionDescriptors([descriptor("same", "first"), descriptor("same", "second"), descriptor("other")]).map((tab) => tab.title),
		["first", "other"],
	);
});
