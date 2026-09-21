import assert from "node:assert/strict";
import test from "node:test";

import { editorLocale, setEditorLocale, t, tp } from "../src/web-editor/client/i18n.ts";

test("t resolves English and zh-CN strings and interpolates params", () => {
	setEditorLocale("en");
	assert.equal(t("nav.stacks"), "Presets");
	assert.equal(t("status.saved", { id: "demo" }), "Saved demo");

	setEditorLocale("zh-CN");
	assert.equal(t("nav.stacks"), "预设");
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

test("preset binding editor i18n keys resolve in English and zh-CN", () => {
	setEditorLocale("en");
	assert.equal(t("binding.loadingModes"), "Loading available instruction modes…");
	assert.equal(t("binding.loadModesError"), "Failed to load instruction modes");
	assert.equal(t("binding.retryLoadModes"), "Retry");
	assert.equal(t("binding.refreshModes"), "Refresh modes");
	assert.equal(t("binding.refreshModesTitle"), "Refresh available instruction modes from library");
	assert.equal(t("binding.refreshingModes"), "Refreshing…");
	assert.equal(t("binding.noEligibleModesHint"), "No instruction modes available in the library. Create or repair a mode in Modes, then refresh.");
	assert.equal(t("binding.noGlobalModesHint"), "Global presets can only bind global instruction modes. No global modes available. Create or repair a global mode in Modes, then refresh.");
	assert.equal(t("binding.addDisabledEmpty"), "No instruction modes available to bind");
	assert.equal(t("binding.addDisabledGlobalScope"), "No global instruction modes available for global preset");
	assert.equal(t("binding.addDisabledLoading"), "Instruction modes are loading…");
	assert.equal(t("binding.addDisabledError"), "Cannot add binding while catalog failed to load");

	setEditorLocale("zh-CN");
	assert.equal(t("binding.loadingModes"), "正在加载可用指令模式…");
	assert.equal(t("binding.loadModesError"), "加载指令模式失败");
	assert.equal(t("binding.retryLoadModes"), "重试");
	assert.equal(t("binding.refreshModes"), "刷新模式");
	assert.equal(t("binding.refreshModesTitle"), "从指令库重新加载可用指令模式");
	assert.equal(t("binding.refreshingModes"), "正在刷新…");
	assert.equal(t("binding.noEligibleModesHint"), "指令库中暂无可用指令模式。请到「指令模式」页面创建或修复后刷新。");
	assert.equal(t("binding.noGlobalModesHint"), "全局预设只能绑定全局指令模式。当前没有可用的全局模式，请到「指令模式」页面创建或修复后刷新。");
	assert.equal(t("binding.addDisabledEmpty"), "暂无可用指令模式可绑定");
	assert.equal(t("binding.addDisabledGlobalScope"), "全局预设暂无可用的全局指令模式");
	assert.equal(t("binding.addDisabledLoading"), "正在加载指令模式…");
	assert.equal(t("binding.addDisabledError"), "模式加载失败，无法添加绑定");

	setEditorLocale("en");
});
