<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import ProfileBrowser from "./components/ProfileBrowser.vue";
import { startContributionTabs } from "./contrib-tab-host.ts";
import { startContextDiffTabs } from "./context-diff-tab-host.ts";
import { editorTabButtonId, EDITOR_TABS } from "./tab-registry.ts";
import { applyEditorTheme, editorTheme, toggleEditorTheme } from "./theme.ts";

let stopLegacyEditor: (() => void) | undefined;
let stopContributionTabs: (() => void) | undefined;
let stopContextDiffTabs: (() => void) | undefined;
const activeSurface = ref<"stacks" | "profiles" | "settings">("stacks");
const hasContributionSettings = ref(false);

onMounted(async () => {
	// Theme is global to the page; apply it before either surface renders.
	applyEditorTheme(editorTheme.value);
	try {
		const {
			getLegacyEditorDraft,
			startLegacyEditor,
			subscribeLegacyEditorDraft,
		} = await import("./legacy-editor.ts");
		stopLegacyEditor = startLegacyEditor({
			isActive: () => activeSurface.value === "stacks",
		});
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
		<nav class="surface-nav" aria-label="Pi Forge editor sections">
			<div class="surface-brand">Pi Forge</div>
			<button
				id="stacksSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'stacks' }"
				:aria-current="activeSurface === 'stacks' ? 'page' : undefined"
				@click="activeSurface = 'stacks'"
			>
				Prompt stacks
			</button>
			<button
				id="profilesSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'profiles' }"
				:aria-current="activeSurface === 'profiles' ? 'page' : undefined"
				@click="activeSurface = 'profiles'"
			>
				Agent profiles
			</button>
			<button
				v-show="hasContributionSettings"
				id="settingsSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'settings' }"
				:aria-current="activeSurface === 'settings' ? 'page' : undefined"
				@click="activeSurface = 'settings'"
			>
				Settings
			</button>
			<span class="surface-nav-spacer"></span>
			<button
				id="themeToggleBtn"
				class="theme-toggle"
				type="button"
				:data-icon="editorTheme === 'dark' ? '☀' : '◐'"
				:title="editorTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
				@click="toggleEditorTheme"
			>
				{{ editorTheme === 'dark' ? 'Light' : 'Dark' }}
			</button>
		</nav>
		<section v-show="activeSurface === 'stacks'" class="editor-surface">
			<div v-once class="legacy-editor-root">
		<header class="topbar">
			<button id="sidebarToggleBtn" class="icon" data-icon="☰" title="Toggle prompt stacks sidebar" aria-label="Toggle prompt stacks sidebar"></button>
			<div class="brand">pi-forge stack editor</div>
			<div id="status" class="status">Loading</div>
			<span id="dirtyBadge" class="dirty-badge" title="The current stack has unsaved edits">Unsaved</span>
			<button id="reloadBtn" data-icon="↻" title="Reload prompt stacks from disk">Reload</button>
			<button id="disableBtn" data-icon="■" title="Disable the active prompt stack">Disable stack</button>
		</header>
		<div id="shell" class="shell">
			<aside class="sidebar">
				<div class="side-head">
					<div class="side-title">Prompt stacks</div>
					<div id="cwd" class="cwd"></div>
				</div>
				<div id="stackList" class="stack-list"></div>
			</aside>
			<main class="main">
				<div class="main-actions">
					<div class="new-stack-control">
						<select id="stackCreateScope" aria-label="Stack scope" title="Scope for new stacks, imports, and forks">
							<option value="project">Project</option>
							<option value="global">Global</option>
						</select>
						<button id="newStackBtn" data-icon="+" title="Create a new prompt stack (Ctrl/Cmd+N)">New stack</button>
					</div>
					<button id="activateBtn" class="primary" data-icon="▶" title="Make this stack active for the current Pi session">Activate</button>
					<button id="saveBtn" class="primary" data-icon="✓" title="Save the edited stack JSON to disk (Ctrl/Cmd+S)">Save</button>
					<button id="validateBtn" data-icon="!" title="Validate the edited stack without saving (Ctrl/Cmd+Shift+Enter)">Validate</button>
					<button id="previewBtn" data-icon="◱" title="Preview the compiled prompt without sending it (Ctrl/Cmd+Enter)">Preview</button>
					<span class="action-spacer"></span>
					<details id="moreActions" class="action-menu">
						<summary data-icon="⋯" title="Show less-used stack actions">More</summary>
						<div class="action-menu-popover">
							<button id="payloadBtn" data-icon="◆" title="Capture the next provider payload in the browser">Arm payload</button>
							<button id="forkBtn" data-icon="⑂" title="Create a new stack from the current edits">Fork</button>
							<button id="importBtn" data-icon="⇪" title="Import pi-forge stack JSON">Import JSON</button>
							<button id="exportBtn" data-icon="⇩" title="Download the current stack JSON, or copy it if download is unavailable">Export JSON</button>
							<button id="deleteStackBtn" class="danger" data-icon="×" title="Delete the selected stack JSON file">Delete stack</button>
						</div>
					</details>
					<input id="importFileInput" type="file" accept="application/json,.json" hidden>
				</div>
				<section id="metadataPanel" class="metadata-panel">
					<div id="metadataHost"></div>
				</section>
				<nav class="view-tabs" aria-label="Stack editor sections">
					<button
						v-for="tab in EDITOR_TABS"
						:key="tab.id"
						:id="editorTabButtonId(tab.id)"
						:data-tab="tab.internalDock ? undefined : tab.id"
						:data-dock-tab="tab.internalDock ? tab.id : undefined"
						:class="{ active: tab.id === 'items' }"
						:data-icon="tab.icon"
						:title="tab.title"
					>{{ tab.label }}</button>
				</nav>
				<div id="editorDockArea" class="editor-dock-area">
					<section id="workspace" class="workspace">
						<div class="items-pane">
							<div class="pane-head">
								<span>Items</span>
								<span id="itemCount" class="stack-meta"></span>
							</div>
							<div class="item-tools">
								<button id="addItemBtn" data-icon="+" title="Add a prompt block item">Add block</button>
								<button id="addSlotBtn" data-icon="+" title="Add a runtime slot item">Add slot</button>
								<span class="item-tools-spacer"></span>
								<button id="deleteItemBtn" class="danger" data-icon="×" title="Delete the selected stack item">Delete item</button>
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
					<h1>Plugin settings</h1>
					<p>Configuration pages contributed by installed Pi Forge plugins.</p>
				</div>
				<div id="settingsStatus" class="settings-surface-status">Loading settings…</div>
			</header>
			<div class="settings-surface-body">
				<nav id="contribSettingsNav" class="settings-nav" aria-label="Plugin settings"></nav>
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
