<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";

import { createEditorApi } from "./api.ts";
import ProfileBrowser from "./components/ProfileBrowser.vue";
import { startContributionTabs } from "./contrib-tab-host.ts";
import { startContextDiffTabs } from "./context-diff-tab-host.ts";
import { editorLocale, setEditorLocale, t, translateDom, type EditorLocale } from "./i18n.ts";
import { editorTabButtonId, EDITOR_TABS } from "./tab-registry.ts";
import { applyEditorTheme, editorTheme, toggleEditorTheme } from "./theme.ts";

let stopLegacyEditor: (() => void) | undefined;
let stopContributionTabs: (() => void) | undefined;
let stopContextDiffTabs: (() => void) | undefined;
let refreshLegacyLocale: (() => void) | undefined;
const activeSurface = ref<"stacks" | "profiles" | "settings">("stacks");
const hasContributionSettings = ref(false);
const api = createEditorApi(new URLSearchParams(location.search).get("token") || "");
type LocaleSetting = EditorLocale | "auto";
const localeSetting = ref<LocaleSetting>("auto");

function resolveLocaleSetting(setting: LocaleSetting): EditorLocale {
	if (setting === "auto") {
		return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
	}
	return setting;
}

async function loadLocaleSetting(): Promise<void> {
	try {
		const body = await api<{ locale?: string }>("/api/editor-config");
		const locale = body?.locale;
		if (locale === "en" || locale === "zh-CN" || locale === "auto") {
			localeSetting.value = locale;
			setEditorLocale(resolveLocaleSetting(locale));
		}
	} catch {
		// Keep the server-rendered page language when the config read fails.
	}
}

async function changeLocaleSetting(setting: LocaleSetting): Promise<void> {
	localeSetting.value = setting;
	setEditorLocale(resolveLocaleSetting(setting));
	try {
		await api("/api/editor-config", { method: "PUT", body: { locale: setting } });
	} catch {
		// The in-page switch still applies; only persistence failed.
	}
}

watch(editorLocale, () => {
	translateDom(document);
	refreshLegacyLocale?.();
});

onMounted(async () => {
	// Theme is global to the page; apply it before either surface renders.
	applyEditorTheme(editorTheme.value);
	try {
		const {
			getLegacyEditorDraft,
			refreshLegacyEditorLocale,
			startLegacyEditor,
			subscribeLegacyEditorDraft,
		} = await import("./legacy-editor.ts");
		stopLegacyEditor = startLegacyEditor({
			isActive: () => activeSurface.value === "stacks",
		});
		refreshLegacyLocale = refreshLegacyEditorLocale;
		translateDom(document);
		void loadLocaleSetting();
		stopContributionTabs = startContributionTabs({
			onAvailabilityChanged: (available) => {
				hasContributionSettings.value = available;
				if (!available && activeSurface.value === "settings") activeSurface.value = "stacks";
			},
		});
		stopContextDiffTabs = startContextDiffTabs({
			getStackDraft: getLegacyEditorDraft,
			subscribeStackDraft: subscribeLegacyEditorDraft,
		});
	} catch (error) {
		const status = document.getElementById("status");
		if (status) {
			status.textContent = error instanceof Error ? error.message : String(error);
			status.style.color = "var(--error)";
		}
		throw error;
	}
});

onUnmounted(() => {
	stopContextDiffTabs?.();
	stopContributionTabs?.();
	stopLegacyEditor?.();
});
</script>

<template>
	<div class="app-root">
		<nav class="surface-nav" :aria-label="t('nav.editorSectionsAria')">
			<div class="surface-brand">Pi Forge</div>
			<button
				id="stacksSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'stacks' }"
				:aria-current="activeSurface === 'stacks' ? 'page' : undefined"
				@click="activeSurface = 'stacks'"
			>
				{{ t("nav.stacks") }}
			</button>
			<button
				id="profilesSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'profiles' }"
				:aria-current="activeSurface === 'profiles' ? 'page' : undefined"
				@click="activeSurface = 'profiles'"
			>
				{{ t("nav.profiles") }}
			</button>
			<button
				v-show="hasContributionSettings"
				id="settingsSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'settings' }"
				:aria-current="activeSurface === 'settings' ? 'page' : undefined"
				@click="activeSurface = 'settings'"
			>
				{{ t("nav.settings") }}
			</button>
			<span class="surface-nav-spacer"></span>
			<button
				id="themeToggleBtn"
				class="theme-toggle"
				type="button"
				:data-icon="editorTheme === 'dark' ? '☀' : '◐'"
				:title="editorTheme === 'dark' ? t('nav.themeToLight') : t('nav.themeToDark')"
				@click="toggleEditorTheme"
			>
				{{ editorTheme === 'dark' ? t('nav.themeLight') : t('nav.themeDark') }}
			</button>
			<select
				id="localeSelect"
				class="locale-select"
				:title="t('nav.locale')"
				:value="localeSetting"
				@change="changeLocaleSetting(($event.target as HTMLSelectElement).value as LocaleSetting)"
			>
				<option value="auto">Auto</option>
				<option value="en">English</option>
				<option value="zh-CN">中文</option>
			</select>
		</nav>
		<section v-show="activeSurface === 'stacks'" class="editor-surface">
			<div v-once class="legacy-editor-root">
		<header class="topbar">
			<button id="sidebarToggleBtn" class="icon" data-icon="☰" title="Toggle prompt stacks sidebar" aria-label="Toggle prompt stacks sidebar" data-i18n-title="chrome.toggleSidebar" data-i18n-aria="chrome.toggleSidebar"></button>
			<div class="brand" data-i18n="chrome.brand">pi-forge stack editor</div>
			<div id="status" class="status" data-i18n="chrome.loading">Loading</div>
			<span id="dirtyBadge" class="dirty-badge" title="The current stack has unsaved edits" data-i18n="chrome.unsaved" data-i18n-title="chrome.unsavedTitle">Unsaved</span>
			<button id="reloadBtn" data-icon="↻" title="Reload prompt stacks from disk" data-i18n="chrome.reload" data-i18n-title="chrome.reloadTitle">Reload</button>
			<button id="disableBtn" data-icon="■" title="Disable the active prompt stack" data-i18n="chrome.disableStack" data-i18n-title="chrome.disableStackTitle">Disable stack</button>
		</header>
		<div id="shell" class="shell">
			<aside class="sidebar">
				<div class="side-head">
					<div class="side-title" data-i18n="nav.stacks">Prompt stacks</div>
					<div id="cwd" class="cwd"></div>
				</div>
				<div id="stackList" class="stack-list"></div>
			</aside>
			<main class="main">
				<div class="main-actions">
					<div class="new-stack-control">
						<select id="stackCreateScope" aria-label="Stack scope" title="Scope for new stacks, imports, and forks" data-i18n-title="chrome.scopeTitle" data-i18n-aria="chrome.scopeAria">
							<option value="project" data-i18n="chrome.scopeProject">Project</option>
							<option value="global" data-i18n="chrome.scopeGlobal">Global</option>
						</select>
						<button id="newStackBtn" data-icon="+" title="Create a new prompt stack (Ctrl/Cmd+N)" data-i18n="chrome.newStack" data-i18n-title="chrome.newStackTitle">New stack</button>
					</div>
					<button id="activateBtn" class="primary" data-icon="▶" title="Make this stack active for the current Pi session" data-i18n="chrome.activate" data-i18n-title="chrome.activateTitle">Activate</button>
					<button id="saveBtn" class="primary" data-icon="✓" title="Save the edited stack JSON to disk (Ctrl/Cmd+S)" data-i18n="chrome.save" data-i18n-title="chrome.saveTitle">Save</button>
					<button id="validateBtn" data-icon="!" title="Validate the edited stack without saving (Ctrl/Cmd+Shift+Enter)" data-i18n="chrome.validate" data-i18n-title="chrome.validateTitle">Validate</button>
					<button id="previewBtn" data-icon="◱" title="Preview the compiled prompt without sending it (Ctrl/Cmd+Enter)" data-i18n="chrome.preview" data-i18n-title="chrome.previewTitle">Preview</button>
					<span class="action-spacer"></span>
					<details id="moreActions" class="action-menu">
						<summary data-icon="⋯" title="Show less-used stack actions" data-i18n="chrome.more" data-i18n-title="chrome.moreTitle">More</summary>
						<div class="action-menu-popover">
							<button id="payloadBtn" data-icon="◆" title="Capture the next provider payload in the browser" data-i18n="chrome.armPayload" data-i18n-title="chrome.armPayloadTitle">Arm payload</button>
							<button id="forkBtn" data-icon="⑂" title="Create a new stack from the current edits" data-i18n="chrome.fork" data-i18n-title="chrome.forkTitle">Fork</button>
							<button id="importBtn" data-icon="⇪" title="Import pi-forge stack JSON" data-i18n="chrome.import" data-i18n-title="chrome.importTitle">Import JSON</button>
							<button id="exportBtn" data-icon="⇩" title="Download the current stack JSON, or copy it if download is unavailable" data-i18n="chrome.export" data-i18n-title="chrome.exportTitle">Export JSON</button>
							<button id="deleteStackBtn" class="danger" data-icon="×" title="Delete the selected stack JSON file" data-i18n="chrome.deleteStack" data-i18n-title="chrome.deleteStackTitle">Delete stack</button>
						</div>
					</details>
					<input id="importFileInput" type="file" accept="application/json,.json" hidden>
				</div>
				<section id="metadataPanel" class="metadata-panel">
					<div id="metadataHost"></div>
				</section>
				<nav class="view-tabs" aria-label="Stack editor sections" data-i18n-aria="nav.stackSectionsAria">
					<button
						v-for="tab in EDITOR_TABS"
						:key="tab.id"
						:id="editorTabButtonId(tab.id)"
						:data-tab="tab.internalDock ? undefined : tab.id"
						:data-dock-tab="tab.internalDock ? tab.id : undefined"
						:class="{ active: tab.id === 'items' }"
						:data-icon="tab.icon"
						:title="t(tab.titleKey)"
						:data-i18n="tab.labelKey"
						:data-i18n-title="tab.titleKey"
					>{{ t(tab.labelKey) }}</button>
				</nav>
				<div id="editorDockArea" class="editor-dock-area">
					<section id="workspace" class="workspace">
						<div class="items-pane">
							<div class="pane-head">
								<span data-i18n="chrome.items">Items</span>
								<span id="itemCount" class="stack-meta"></span>
							</div>
							<div class="item-tools">
								<button id="addItemBtn" data-icon="+" title="Add a prompt block item" data-i18n="chrome.addBlock" data-i18n-title="chrome.addBlockTitle">Add block</button>
								<button id="addSlotBtn" data-icon="+" title="Add a runtime slot item" data-i18n="chrome.addSlot" data-i18n-title="chrome.addSlotTitle">Add slot</button>
								<span class="item-tools-spacer"></span>
								<button id="deleteItemBtn" class="danger" data-icon="×" title="Delete the selected stack item" data-i18n="chrome.deleteItem" data-i18n-title="chrome.deleteItemTitle">Delete item</button>
							</div>
							<div id="itemList" class="item-list"></div>
						</div>
						<div class="editor-pane">
							<div id="itemEditor" class="item-editor"></div>
							<div id="diagnostics" class="diagnostics"></div>
						</div>
					</section>
					<section id="tabPanel" class="tab-panel"></section>
					<section id="contextDiffPanel" class="context-diff-panel"></section>
				</div>
			</main>
		</div>
		<div id="preview" class="preview"></div>
		<div id="stackModal" class="modal"></div>
			</div>
		</section>
		<ProfileBrowser v-show="activeSurface === 'profiles'" :active="activeSurface === 'profiles'" />
		<section v-show="activeSurface === 'settings'" id="settingsSurface" class="settings-surface">
			<header class="settings-surface-head">
				<div>
					<h1>{{ t("settings.pluginSettings") }}</h1>
					<p>{{ t("settings.pluginSettingsMeta") }}</p>
				</div>
				<div id="settingsStatus" class="settings-surface-status" data-i18n="settings.loading">Loading settings…</div>
			</header>
			<div class="settings-surface-body">
				<nav id="contribSettingsNav" class="settings-nav" :aria-label="t('settings.navAria')"></nav>
				<main id="contribSettingsPanel" class="settings-panel"></main>
			</div>
		</section>
	</div>
</template>

<style>
.app-root {
	height: 100%;
	min-height: 0;
	display: flex;
	flex-direction: column;
}

.surface-nav {
	flex: none;
	height: 40px;
	padding: 4px 10px;
	display: flex;
	align-items: center;
	gap: 6px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
}

.surface-brand {
	margin-right: 8px;
	font-weight: 750;
	letter-spacing: .02em;
}

.surface-nav button {
	min-height: 32px;
	border-color: transparent;
	background: transparent;
}

.surface-nav button.active {
	border-color: var(--accent);
	background: var(--accent-bg);
	color: var(--accent);
}

.surface-nav-spacer {
	flex: 1 1 auto;
}

.surface-nav .theme-toggle {
	min-height: 32px;
	border-color: var(--line);
	background: var(--pane);
}

.editor-surface {
	flex: 1;
	min-height: 0;
}

.settings-surface {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--pane-soft);
}

.settings-surface-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 24px;
	padding: 18px 24px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
}

.settings-surface-head h1 {
	margin: 0;
	font-size: 20px;
}

.settings-surface-head p {
	margin: 4px 0 0;
	color: var(--muted);
}

.settings-surface-status {
	margin-left: auto;
	color: var(--muted);
	font-size: 12px;
}

.settings-surface-body {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
}

.settings-nav {
	min-width: 0;
	padding: 14px 10px;
	border-right: 1px solid var(--line);
	background: var(--pane);
}

.settings-nav button {
	width: 100%;
	display: flex;
	align-items: center;
	justify-content: flex-start;
	margin-bottom: 6px;
}

.settings-nav button.active {
	border-color: var(--accent);
	background: var(--accent-bg);
	color: var(--accent);
}

.settings-panel {
	min-width: 0;
	min-height: 0;
	overflow: auto;
	padding: 20px clamp(16px, 4vw, 48px);
}

.settings-panel > .schema-form {
	width: min(100%, 1100px);
	margin: 0 auto;
}

.legacy-editor-root {
	height: 100%;
	display: flex;
	flex-direction: column;
}

.legacy-editor-root .topbar {
	flex: none;
}

.editor-surface .shell {
	flex: 1;
	min-height: 0;
	height: auto;
}

@media (max-width: 700px) {
	.surface-nav {
		overflow-x: auto;
	}

	.surface-nav > * {
		flex-shrink: 0;
	}

	.surface-nav-spacer {
		display: none;
	}

	.settings-surface-head {
		align-items: flex-start;
		padding: 14px 16px;
	}

	.settings-surface-status {
		margin-left: auto;
	}

	.settings-surface-body {
		grid-template-columns: minmax(0, 1fr);
	}

	.settings-nav {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 8px;
		border-right: 0;
		border-bottom: 1px solid var(--line);
	}

	.settings-nav button {
		width: auto;
		flex: 0 0 auto;
		margin: 0;
	}

	.settings-panel {
		padding: 14px 10px;
	}
}
</style>
