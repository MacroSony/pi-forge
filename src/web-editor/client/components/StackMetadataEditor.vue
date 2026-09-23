<script setup lang="ts">
import { computed, ref } from "vue";

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
const summary = computed(() => [
	props.stack.id || t("metadata.noId"),
	props.stack.name || t("stackList.unnamed"),
	props.stack.mode || "replace",
	props.filePath,
].filter(Boolean).join(" | "));

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

function onMetadataToggle(event: Event): void {
	const open = (event.currentTarget as HTMLDetailsElement).open;
	if (collapsed.value === !open) return;
	collapsed.value = !open;
	emit("toggle", collapsed.value);
}
</script>

<template>
	<details id="metadataDetails" class="metadata-details" :open="!collapsed" @toggle="onMetadataToggle">
		<summary id="metadataToggleBtn" :aria-expanded="!collapsed" :title="t('metadata.toggleTitle')">
			<span class="metadata-summary-title">{{ t("metadata.title") }}</span>
			<span id="metadataSummary" class="metadata-summary">{{ summary }}</span>
		</summary>
	<div id="settings" v-show="!collapsed" class="settings">
		<div class="field">
			<label>{{ t("metadata.stackId") }}</label>
			<input id="stackId" :value="stack.id" readonly :title="t('metadata.stackIdTitle')">
		</div>
		<div class="field">
			<label>{{ t("metadata.name") }}</label>
			<input id="stackName" :value="stack.name || ''" @input="setOptionalString('name', ($event.target as HTMLInputElement).value)">
		</div>
		<div class="field">
			<label>{{ t("metadata.mode") }}</label>
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
			<label>{{ t("metadata.description") }}</label>
			<textarea
				id="stackDescription"
				class="wide"
				:value="stack.description || ''"
				@input="setOptionalString('description', ($event.target as HTMLTextAreaElement).value)"
			></textarea>
		</div>
		<div class="field wide">
			<label>{{ t("metadata.file") }}</label>
			<input :value="filePath" disabled>
		</div>
	</div>
	</details>
</template>
