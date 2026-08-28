import assert from "node:assert/strict";
import test from "node:test";

import { editorLocale, setEditorLocale, t, tp } from "../src/web-editor/client/i18n.ts";

test("t resolves English and zh-CN strings and interpolates params", () => {
	setEditorLocale("en");
	assert.equal(t("nav.stacks"), "Prompt stacks");
	assert.equal(t("status.saved", { id: "demo" }), "Saved demo");

	setEditorLocale("zh-CN");
	assert.equal(t("nav.stacks"), "提示词堆栈");
	assert.equal(t("status.saved", { id: "demo" }), "已保存 demo");
	assert.equal(t("nav.editorSectionsAria"), "Pi Forge 编辑器区域");
	assert.equal(t("regex.id"), "规则 ID");
	assert.equal(t("regex.errorPattern", { label: "demo" }), "正则规则 demo 需要填写模式。");

	setEditorLocale("en");
});

test("tp picks the English plural form and a single zh-CN form", () => {
	setEditorLocale("en");
	assert.equal(tp("diag.errorOne", "diag.errorMany", 1), "1 error");
	assert.equal(tp("diag.errorOne", "diag.errorMany", 3), "3 errors");

	setEditorLocale("zh-CN");
	assert.equal(tp("diag.errorOne", "diag.errorMany", 1), "1 个错误");
	assert.equal(tp("diag.errorOne", "diag.errorMany", 3), "3 个错误");

	setEditorLocale("en");
});

test("setEditorLocale updates the reactive locale", () => {
	setEditorLocale("zh-CN");
	assert.equal(editorLocale.value, "zh-CN");
	setEditorLocale("en");
	assert.equal(editorLocale.value, "en");
});
