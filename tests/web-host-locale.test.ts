import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "../src/web-host.ts";

function trustedCtx(cwd: string): ExtensionContext {
	return { cwd, isProjectTrusted: () => true } as unknown as ExtensionContext;
}

function untrustedCtx(cwd: string): ExtensionContext {
	return { cwd, isProjectTrusted: () => false } as unknown as ExtensionContext;
}

const dummyRuntime = {} as WebHostRuntime;

test("webEditor.locale parses from project config and round-trips writes", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-locale-"));
	const host = createWebEditorHost(trustedCtx(cwd), dummyRuntime);

	assert.deepEqual(host.getEditorConfig(), { locale: "auto" });

	const set = host.setEditorLocale("zh-CN");
	assert.equal(set.ok, true);
	assert.deepEqual(host.getEditorConfig(), { locale: "zh-CN" });
	const written = JSON.parse(readFileSync(join(cwd, ".pi", "forge", "config.json"), "utf8"));
	assert.equal(written.webEditor.locale, "zh-CN");

	// "auto" removes the override while preserving other webEditor keys.
	host.setEditorLocale("en");
	host.setEditorLocale("auto");
	const cleared = JSON.parse(readFileSync(join(cwd, ".pi", "forge", "config.json"), "utf8"));
	// An empty webEditor object is removed entirely.
	assert.equal(cleared.webEditor?.locale, undefined);
	assert.equal(loadWebEditorSettings(trustedCtx(cwd)).locale, undefined);
});

test("webEditor.locale preserves a configured port across locale writes", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-locale-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ webEditor: { port: 41738 } }));
	const host = createWebEditorHost(trustedCtx(cwd), dummyRuntime);
	host.setEditorLocale("zh-CN");

	const settings = loadWebEditorSettings(trustedCtx(cwd));
	assert.equal(settings.locale, "zh-CN");
	assert.equal(settings.preferredPort, 41738);
	assert.equal(settings.warnings.length, 0);
	const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
	assert.equal(raw.webEditor.port, 41738);
	assert.equal(raw.webEditor.locale, "zh-CN");
});

test("webEditor.locale preserves unrelated config and leaves no partial-write file", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-locale-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		webEditor: { port: 41738 },
		futureMainSetting: { enabled: true },
	}));

	const host = createWebEditorHost(trustedCtx(cwd), dummyRuntime);
	assert.equal(host.setEditorLocale("zh-CN").ok, true);
	const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
	assert.deepEqual(raw.futureMainSetting, { enabled: true });
	assert.deepEqual(raw.webEditor, { port: 41738, locale: "zh-CN" });
	assert.deepEqual(
		readdirSync(configDir).filter((name) => name.includes(".tmp")),
		[],
	);
});

test("webEditor.locale rejects invalid values with a warning", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-locale-"));
	const host = createWebEditorHost(trustedCtx(cwd), dummyRuntime);
	assert.equal(host.setEditorLocale("fr" as never).ok, false);

	host.setEditorLocale("en");
	const raw = JSON.parse(readFileSync(join(cwd, ".pi", "forge", "config.json"), "utf8"));
	raw.webEditor.locale = "fr";
	writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify(raw));
	const settings = loadWebEditorSettings(trustedCtx(cwd));
	assert.equal(settings.locale, undefined);
	assert.equal(settings.warnings.length, 1);
	assert.match(settings.warnings[0]!, /webEditor\.locale/);
});

test("webEditor locale writes require a trusted project and reads are gated", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-locale-"));
	const trusted = createWebEditorHost(trustedCtx(cwd), dummyRuntime);
	trusted.setEditorLocale("zh-CN");

	const untrusted = createWebEditorHost(untrustedCtx(cwd), dummyRuntime);
	const write = untrusted.setEditorLocale("en");
	assert.equal(write.ok, false);
	assert.equal(write.ok === false ? write.status : 0, 403);
	// Reads stay gated exactly like webEditor.port: untrusted projects get defaults.
	assert.deepEqual(untrusted.getEditorConfig(), { locale: "auto" });
	// The trusted write is untouched.
	assert.deepEqual(trusted.getEditorConfig(), { locale: "zh-CN" });
});
