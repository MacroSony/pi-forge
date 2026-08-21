<script setup lang="ts">
import { computed, ref } from "vue";

import type { EditorPromptStack } from "../types.ts";

const props = defineProps<{
	stack: EditorPromptStack;
	filePath: string;
	collapsed: boolean;
}>();
const emit = defineEmits<{
	change: [];
	toggle: [collapsed: boolean];
}>();

const collapsed = ref(props.collapsed);
const summary = computed(() => [
	props.stack.id || "(no id)",
	props.stack.name || "(unnamed)",
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

function toggleMetadata(): void {
	collapsed.value = !collapsed.value;
	emit("toggle", collapsed.value);
}
</script>

<template>
	<div class="metadata-head">
		<button
			id="metadataToggleBtn"
			:data-icon="collapsed ? '▸' : '▾'"
			:aria-expanded="!collapsed"
			type="button"
			title="Show or hide stack metadata"
			@click="toggleMetadata"
		>
			Metadata
		</button>
		<div id="metadataSummary" class="metadata-summary">{{ summary }}</div>
	</div>
	<div id="settings" v-show="!collapsed" class="settings">
		<div class="field">
			<label>Stack ID</label>
			<input id="stackId" :value="stack.id" readonly title="Stack IDs are immutable; use Fork to create a new ID.">
		</div>
		<div class="field">
			<label>Name</label>
			<input id="stackName" :value="stack.name || ''" @input="setOptionalString('name', ($event.target as HTMLInputElement).value)">
		</div>
		<div class="field">
			<label>Mode</label>
			<select id="stackMode" :value="stack.mode || 'replace'" @change="setMode(($event.target as HTMLSelectElement).value)">
				<option value="replace">replace</option>
				<option value="append">append</option>
				<option value="prepend">prepend</option>
			</select>
		</div>
		<div class="field">
			<label>Auto activate</label>
			<label class="checkline">
				<input
					id="stackAuto"
					type="checkbox"
					:checked="stack.autoActivate === true"
					@change="setAutoActivate(($event.target as HTMLInputElement).checked)"
				>
				enabled
			</label>
		</div>
		<div class="field wide">
			<label>Description</label>
			<textarea
				id="stackDescription"
				class="wide"
				:value="stack.description || ''"
				@input="setOptionalString('description', ($event.target as HTMLTextAreaElement).value)"
			></textarea>
		</div>
		<div class="field wide">
			<label>File</label>
			<input :value="filePath" disabled>
		</div>
	</div>
</template>
