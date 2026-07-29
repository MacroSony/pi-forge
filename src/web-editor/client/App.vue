<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import ProfileBrowser from "./components/ProfileBrowser.vue";

let stopLegacyEditor: (() => void) | undefined;
const activeSurface = ref<"stacks" | "profiles">("stacks");

onMounted(async () => {
	try {
		const { startLegacyEditor } = await import("./legacy-editor.ts");
		stopLegacyEditor = startLegacyEditor({
			isActive: () => activeSurface.value === "stacks",
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
				@click="activeSurface = 'stacks'"
			>
				Prompt stacks
			</button>
			<button
				id="profilesSurfaceBtn"
				type="button"
				:class="{ active: activeSurface === 'profiles' }"
				@click="activeSurface = 'profiles'"
			>
				Agent profiles
			</button>
		</nav>
		<section v-show="activeSurface === 'stacks'" class="editor-surface">
			<div v-once class="legacy-editor-root">
		<header class="topbar">
			<button id="sidebarToggleBtn" class="icon" data-icon="☰" title="Toggle prompt stacks sidebar" aria-label="Toggle prompt stacks sidebar"></button>
			<div class="brand">pi-forge stack editor</div>
			<div id="status" class="status">Loading</div>
			<span id="dirtyBadge" class="dirty-badge" title="The current stack has unsaved edits">Unsaved</span>
			<button id="themeBtn" data-icon="◐" title="Toggle light or dark theme">Theme</button>
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
					<button id="newStackBtn" data-icon="+" title="Create a new prompt stack (Ctrl/Cmd+N)">New stack</button>
					<button id="activateBtn" class="primary" data-icon="▶" title="Make this stack active for the current Pi session">Activate</button>
					<button id="saveBtn" class="primary" data-icon="✓" title="Save the edited stack JSON to disk (Ctrl/Cmd+S)">Save</button>
					<button id="validateBtn" data-icon="!" title="Validate the edited stack without saving (Ctrl/Cmd+Shift+Enter)">Validate</button>
					<button id="previewBtn" data-icon="◱" title="Preview the compiled prompt without sending it (Ctrl/Cmd+Enter)">Preview</button>
					<button id="payloadBtn" data-icon="◆" title="Capture the next provider payload in the browser">Arm payload</button>
					<button id="forkBtn" data-icon="⑂" title="Create a new stack from the current edits">Fork</button>
					<button id="importBtn" data-icon="⇪" title="Import pi-forge stack JSON or SillyTavern preset JSON">Import JSON</button>
					<button id="exportBtn" data-icon="⇩" title="Download the current stack JSON, or copy it if download is unavailable">Export JSON</button>
					<span class="action-spacer"></span>
					<button id="deleteStackBtn" class="danger" data-icon="×" title="Delete the selected stack JSON file">Delete stack</button>
					<input id="importFileInput" type="file" accept="application/json,.json" hidden>
				</div>
				<section id="metadataPanel" class="metadata-panel">
					<div id="metadataHost"></div>
				</section>
				<nav class="view-tabs" aria-label="Stack editor sections">
					<button id="itemsTabBtn" data-tab="items" class="active" data-icon="☰" title="Edit prompt stack items">Items</button>
					<button id="regexTabBtn" data-tab="regex" data-icon=".*" title="Edit regex transform rules">Regex</button>
					<button id="policyTabBtn" data-tab="policy" data-icon="⊕" title="Edit active-tool policy and model-visible skill filtering">Policy</button>
					<button id="stackTabBtn" data-tab="stack" data-icon="{}" title="Edit context options and raw stack JSON">Stack</button>
				</nav>
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
			</main>
		</div>
		<div id="preview" class="preview"></div>
		<div id="stackModal" class="modal"></div>
			</div>
		</section>
		<ProfileBrowser v-show="activeSurface === 'profiles'" />
	</div>
</template>

<style>
.app-root {
	height: 100%;
	min-height: 0;
}

.surface-nav {
	height: 44px;
	padding: 5px 10px;
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

.editor-surface {
	height: calc(100% - 44px);
	min-height: 0;
}

.legacy-editor-root {
	height: 100%;
}

.editor-surface .shell {
	height: calc(100% - 48px);
}
</style>
