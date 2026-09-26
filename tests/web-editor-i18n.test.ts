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
	assert.equal(t("binding.loadingCapabilities"), "Loading available capabilities…");
	assert.equal(t("binding.loadCapabilitiesError"), "Failed to load capabilities");
	assert.equal(t("binding.retryLoadCapabilities"), "Retry");
	assert.equal(t("binding.refreshCapabilities"), "Refresh capabilities");
	assert.equal(t("binding.refreshCapabilitiesTitle"), "Refresh available capabilities from library");
	assert.equal(t("binding.refreshingCapabilities"), "Refreshing…");
	assert.equal(t("binding.noEligibleCapabilitiesHint"), "No capabilities available in the library. Create or repair a capability in Capabilities, then refresh.");
	assert.equal(t("binding.noGlobalCapabilitiesHint"), "Global presets can only bind global capabilities. No global capabilities available. Create or repair a global capability in Capabilities, then refresh.");
	assert.equal(t("binding.addDisabledEmpty"), "No capabilities available to bind");
	assert.equal(t("binding.addDisabledGlobalScope"), "No global capabilities available for global preset");
	assert.equal(t("binding.addDisabledLoading"), "Capabilities are loading…");
	assert.equal(t("binding.addDisabledError"), "Cannot add binding while catalog failed to load");

	setEditorLocale("zh-CN");
	assert.equal(t("binding.loadingCapabilities"), "正在加载可用能力…");
	assert.equal(t("binding.loadCapabilitiesError"), "加载能力失败");
	assert.equal(t("binding.retryLoadCapabilities"), "重试");
	assert.equal(t("binding.refreshCapabilities"), "刷新能力");
	assert.equal(t("binding.refreshCapabilitiesTitle"), "从能力库重新加载可用能力");
	assert.equal(t("binding.refreshingCapabilities"), "正在刷新…");
	assert.equal(t("binding.noEligibleCapabilitiesHint"), "能力库中暂无可用能力。请到「能力」页面创建或修复后刷新。");
	assert.equal(t("binding.noGlobalCapabilitiesHint"), "全局预设只能绑定全局能力。当前没有可用的全局能力，请到「能力」页面创建或修复后刷新。");
	assert.equal(t("binding.addDisabledEmpty"), "暂无可用能力可绑定");
	assert.equal(t("binding.addDisabledGlobalScope"), "全局预设暂无可用的全局能力");
	assert.equal(t("binding.addDisabledLoading"), "正在加载能力…");
	assert.equal(t("binding.addDisabledError"), "能力加载失败，无法添加绑定");

	setEditorLocale("en");
});
