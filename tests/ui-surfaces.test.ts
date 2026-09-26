import assert from "node:assert/strict";
import test from "node:test";

import { surfacesEn, surfacesZhCN } from "../src/web-editor/client/i18n-surfaces.ts";

test("surfaces i18n has matching bilingual polish.surfaces.* keys", () => {
	const enKeys = Object.keys(surfacesEn).sort();
	const zhKeys = Object.keys(surfacesZhCN).sort();
	assert.deepEqual(enKeys, zhKeys, "Both languages must have identical keys");

	const requiredKeys = [
		"polish.surfaces.capabilityScope",
		"polish.surfaces.capabilityScopeAria",
		"polish.surfaces.capabilityCreating",
		"polish.surfaces.capabilityEditing",
		"polish.surfaces.profileEditNotice",
		"polish.surfaces.profileNotApplied",
		"polish.surfaces.profileAdvanced",
		"polish.surfaces.settingsAutosaveNotice",
		"polish.surfaces.settingsAutosaveQueued",
		"polish.surfaces.settingsAutosaveSaving",
		"polish.surfaces.settingsAutosaveSaved",
	];

	for (const key of requiredKeys) {
		assert.ok(key in surfacesEn, `surfacesEn missing ${key}`);
		assert.ok(key in surfacesZhCN, `surfacesZhCN missing ${key}`);
		assert.ok((surfacesEn as any)[key].length > 0, `surfacesEn[${key}] must be non-empty`);
		assert.ok((surfacesZhCN as any)[key].length > 0, `surfacesZhCN[${key}] must be non-empty`);
		assert.ok(key.startsWith("polish.surfaces."), `${key} must start with polish.surfaces.`);
	}
});
