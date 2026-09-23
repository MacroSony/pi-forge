<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";

import { t } from "../i18n.ts";
import type { EditorPromptStack } from "../types.ts";

const props = withDefaults(
	defineProps<{
		stack: EditorPromptStack;
		filePath: string;
		presetSelector?: string;
		presetScope?: "project" | "global";
		collapsed: boolean;
	}>(),
	{
		presetSelector: "",
		presetScope: "project",
	},
);
const emit = defineEmits<{
	change: [];
	toggle: [collapsed: boolean];
}>();

const collapsed = ref(props.collapsed);
const dialog = ref<HTMLDialogElement>();
const trigger = ref<HTMLButtonElement>();

function openProperties(): void {
	if (!dialog.value || dialog.value.open) return;
	dialog.value.showModal();
	collapsed.value = false;
	emit("toggle", false);
}
function closeProperties(): void {
	dialog.value?.close();
}
function onClosed(): void {
	if (!collapsed.value) {
		collapsed.value = true;
		emit("toggle", true);
	}
	trigger.value?.focus();
}
onMounted(() => { if (!collapsed.value) openProperties(); });
onBeforeUnmount(() => { dialog.value?.close(); });

function setOptionalString(key: "name" | "description", value: string): void {
	const trimmed = value.trim();
	if (trimmed) props.stack[key] = value;
	else delete props.stack[key];
	emit("change");
}

function setMode(value: string): void {
	props.stack.mode = value as "replace" | "append" | "prepend";
	emit("change");
}

function setAutoActivate(value: boolean): void {
	props.stack.autoActivate = value;
	emit("change");
}

</script>

<template>
	<button id="metadataToggleBtn" ref="trigger" type="button" aria-haspopup="dialog" :aria-expanded="!collapsed" @click="openProperties">{{ t("polish.workspace.presetProperties") }}</button>
	<dialog ref="dialog" id="presetPropertiesDialog" class="preset-properties-dialog" aria-labelledby="presetPropertiesTitle" @close="onClosed">
		<header class="properties-head"><strong id="presetPropertiesTitle">{{ t("polish.workspace.presetProperties") }}</strong><button type="button" @click="closeProperties">{{ t("modal.close") }}</button></header>
		<p class="properties-note">{{ t("polish.workspace.propertiesDraftHint") }}</p>
	<div id="settings" class="settings">
		<div class="field">
			<label for="stackName">{{ t("metadata.name") }}</label>
			<input id="stackName" autofocus :value="stack.name || ''" @input="setOptionalString('name', ($event.target as HTMLInputElement).value)">
		</div>
		<div class="field">
			<label for="stackId">{{ t("metadata.stackId") }}</label>
			<input id="stackId" :value="stack.id" readonly :title="t('metadata.stackIdTitle')">
		</div>
		<div class="field">
			<label for="stackMode">{{ t("metadata.mode") }}</label>
			<select id="stackMode" :value="stack.mode || 'replace'" @change="setMode(($event.target as HTMLSelectElement).value)">
				<option value="replace">replace</option>
				<option value="append">append</option>
				<option value="prepend">prepend</option>
			</select>
		</div>
		<div class="field">
			<label>{{ t("metadata.autoActivate") }}</label>
			<label class="checkline">
				<input
					id="stackAuto"
					type="checkbox"
					:checked="stack.autoActivate === true"
					@change="setAutoActivate(($event.target as HTMLInputElement).checked)"
				>
				{{ t("metadata.enabled") }}
			</label>
		</div>
		<div class="field wide">
			<label for="stackDescription">{{ t("metadata.description") }}</label>
			<textarea
				id="stackDescription"
				class="wide"
				:value="stack.description || ''"
				@input="setOptionalString('description', ($event.target as HTMLTextAreaElement).value)"
			></textarea>
		</div>
		<div class="field wide">
			<label for="stackFile">{{ t("metadata.file") }}</label>
			<input id="stackFile" :value="filePath" readonly :title="filePath">
		</div>
	</div>
	</dialog>
</template>

<style scoped>
.preset-properties-dialog { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--pane); color: var(--text); overflow: auto; margin: auto; box-shadow: 0 16px 48px var(--shadow); }
.preset-properties-dialog::backdrop { background: rgb(0 0 0 / .28); }
.properties-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.properties-note { font-size:12px; color:var(--muted); white-space:normal; line-height:1.6; }
.preset-properties-dialog .settings { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); padding:0; border:0; gap:14px; }
.preset-properties-dialog .wide { grid-column:1 / -1; }
@media(max-width:520px) { .preset-properties-dialog .settings { grid-template-columns:minmax(0,1fr); } }
</style>
