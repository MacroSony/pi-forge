import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { surfacesEn, surfacesZhCN } from "../src/web-editor/client/i18n-surfaces.ts";

test("surfaces i18n has matching bilingual polish.surfaces.* keys", () => {
	const enKeys = Object.keys(surfacesEn).sort();
	const zhKeys = Object.keys(surfacesZhCN).sort();
	assert.deepEqual(enKeys, zhKeys, "Both languages must have identical keys");

	const requiredKeys = [
		"polish.surfaces.modeScope",
		"polish.surfaces.modeScopeAria",
		"polish.surfaces.modeCreating",
		"polish.surfaces.modeEditing",
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

test("mode scope visible and accessible label: does not use preset chrome.scopeAria", () => {
	const editorVuePath = resolve(import.meta.dirname, "../src/web-editor/client/components/InstructionModeEditor.vue");
	const editorVue = readFileSync(editorVuePath, "utf-8");

	// Must not use chrome.scopeAria
	assert.doesNotMatch(
		editorVue,
		/chrome\.scopeAria/,
		"InstructionModeEditor must not use chrome.scopeAria for mode scope label",
	);

	// Must use dedicated mode scope translation
	assert.match(
		editorVue,
		/polish\.surfaces\.modeScope/,
		"InstructionModeEditor must use polish.surfaces.modeScope for visible mode scope label",
	);
	assert.match(
		editorVue,
		/polish\.surfaces\.modeScopeAria/,
		"InstructionModeEditor must use polish.surfaces.modeScopeAria for accessible mode scope label",
	);

	// Preserves required #modeScope and #modeId IDs
	assert.match(editorVue, /id="modeScope"/);
	assert.match(editorVue, /id="modeId"/);
	assert.match(editorVue, /id="modeName"/);
	assert.match(editorVue, /id="modeContent"/);
	assert.match(editorVue, /id="modeCancelBtn"/);
	assert.match(editorVue, /id="modeSaveBtn"/);
});

test("schema-form uses stable Vue useId and label-for / input-id / aria associations", () => {
	const schemaVuePath = resolve(import.meta.dirname, "../src/web-editor/client/components/SchemaForm.vue");
	const schemaVue = readFileSync(schemaVuePath, "utf-8");

	// Must import useId from vue
	assert.match(
		schemaVue,
		/useId/,
		"SchemaForm must import useId from vue for stable accessibility IDs",
	);

	// Must have :for on labels
	assert.match(
		schemaVue,
		/:for="fieldId\(field\.key\)"/,
		"SchemaForm top-level field labels must use :for matching field ID",
	);

	// Must associate errors with aria-describedby and aria-invalid
	assert.match(
		schemaVue,
		/:aria-invalid=/,
		"SchemaForm inputs must provide aria-invalid for validation errors",
	);
	assert.match(
		schemaVue,
		/:aria-describedby=/,
		"SchemaForm inputs must provide aria-describedby pointing to error element",
	);

	// Nested/record fields must not duplicate IDs (must incorporate row id and field key)
	assert.match(
		schemaVue,
		/recordRowFieldId|recordFieldId/,
		"SchemaForm record fields must generate non-colliding nested IDs per row and field",
	);

	// All existing test selectors must remain
	assert.match(schemaVue, /:data-field="field\.key"/);
	assert.match(schemaVue, /:data-field-input="field\.key"/);
	assert.match(schemaVue, /data-field-error/);
	assert.match(schemaVue, /:data-add-record="field\.key"/);
	assert.match(schemaVue, /:data-record-table="field\.key"/);
	assert.match(schemaVue, /:data-record-row="index"/);
	assert.match(schemaVue, /:data-record-key="field\.key"/);
	assert.match(schemaVue, /:data-delete-record="field\.key"/);
});

test("contrib-tab-host cleans data-i18n and handles locale changes without static loading overwrite", () => {
	const hostPath = resolve(import.meta.dirname, "../src/web-editor/client/contrib-tab-host.ts");
	const hostSource = readFileSync(hostPath, "utf-8");

	// Must defensively strip data-i18n from settingsStatus
	assert.match(
		hostSource,
		/removeAttribute\(["']data-i18n["']\)/,
		"contrib-tab-host must strip data-i18n from status element to prevent static overwrite on locale change",
	);

	// Must watch or subscribe to editorLocale
	assert.match(
		hostSource,
		/editorLocale/,
		"contrib-tab-host must observe editorLocale to re-render status on locale changes",
	);

	// Preserves 250ms debounce and queue fences
	assert.match(hostSource, /250/, "contrib-tab-host must preserve 250ms save debounce");
	assert.match(hostSource, /enqueueSave/, "contrib-tab-host must preserve enqueueSave queueing");
	assert.match(hostSource, /drainSaveQueue/, "contrib-tab-host must preserve queue drainage");
});

test("profile browser and editor preserve existing test IDs and present name primary / ID secondary", () => {
	const browserPath = resolve(import.meta.dirname, "../src/web-editor/client/components/ProfileBrowser.vue");
	const browserSource = readFileSync(browserPath, "utf-8");

	assert.match(browserSource, /id="profileNewBtn"/);
	assert.match(browserSource, /id="profileRefreshBtn"/);
	assert.match(browserSource, /id="profileCreateScope"/);
	assert.match(browserSource, /id="profilesStatus"/);
	assert.match(browserSource, /id="profileEditBtn"/);
	assert.match(browserSource, /id="profileApplyBtn"/);
	assert.match(browserSource, /id="profileDeleteBtn"/);
	assert.match(browserSource, /data-profile-row/);

	const editorPath = resolve(import.meta.dirname, "../src/web-editor/client/components/ProfileEditor.vue");
	const editorSource = readFileSync(editorPath, "utf-8");

	assert.match(editorSource, /id="profileId"/);
	assert.match(editorSource, /id="profileName"/);
	assert.match(editorSource, /id="profileDescription"/);
	assert.match(editorSource, /id="profileModelProvider"/);
	assert.match(editorSource, /id="profileModelId"/);
	assert.match(editorSource, /id="profileThinkingLevel"/);
	assert.match(editorSource, /id="profilePromptStack"/);
	assert.match(editorSource, /id="profileAutoActivate"/);
	assert.match(editorSource, /id="profileCancelBtn"/);
	assert.match(editorSource, /id="profileValidateBtn"/);
	assert.match(editorSource, /id="profileSaveBtn"/);
	assert.match(editorSource, /data-model-auth-warning/);
});
