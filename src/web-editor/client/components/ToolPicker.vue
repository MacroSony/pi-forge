<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { t } from "../i18n.ts";
import {
	deduplicateToolNames,
	groupTools,
	toolTooltip,
	type ToolGroup,
} from "../tool-picker-helpers.ts";
import type { WebEditorPolicyResource } from "../types.ts";

const props = withDefaults(
	defineProps<{
		modelValue: string[];
		resources?: WebEditorPolicyResource[];
		loading?: boolean;
		error?: string;
		buttonLabel?: string;
		title?: string;
		disabled?: boolean;
		allowManualEntry?: boolean;
		canRefresh?: boolean;
	}>(),
	{
		resources: () => [],
		loading: false,
		error: "",
		disabled: false,
		allowManualEntry: true,
		canRefresh: false,
	},
);

const emit = defineEmits<{
	"update:modelValue": [selected: string[]];
	"change": [selected: string[]];
	"refresh": [];
}>();

const isOpen = ref(false);
const searchQuery = ref("");
const manualInput = ref("");
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

const expandedGroupIds = ref<Set<string>>(new Set());

function isGroupExpanded(groupId: string): boolean {
	if (searchQuery.value.trim().length > 0) return true;
	return expandedGroupIds.value.has(groupId);
}

function toggleGroupExpand(groupId: string): void {
	const next = new Set(expandedGroupIds.value);
	if (next.has(groupId)) {
		next.delete(groupId);
	} else {
		next.add(groupId);
	}
	expandedGroupIds.value = next;
}

const popoverStyle = ref<{ top: string; left: string; width: string; maxHeight: string }>({
	top: "0px",
	left: "0px",
	width: "380px",
	maxHeight: "480px",
});

function updatePosition(): void {
	if (!triggerRef.value) return;
	const rect = triggerRef.value.getBoundingClientRect();
	const margin = 4;
	const width = Math.min(380, window.innerWidth - 16);
	let left = rect.left;
	if (left + width > window.innerWidth - 8) {
		left = Math.max(8, window.innerWidth - width - 8);
	}
	const maxHeight = Math.min(480, Math.max(80, window.innerHeight - 16));
	const top = Math.max(8, Math.min(rect.bottom + margin, window.innerHeight - maxHeight - 8));
	popoverStyle.value = {
		top: `${top}px`,
		left: `${left}px`,
		width: `${width}px`,
		maxHeight: `${maxHeight}px`,
	};
}

const selectedSet = computed(() => new Set(props.modelValue || []));
const selectedCount = computed(() => (props.modelValue || []).length);

// Catalog-derived groups
const baseGroups = computed<ToolGroup[]>(() => {
	const raw = props.resources || [];
	return groupTools(raw, t("tools.groupOther"));
});

// Unknown / custom tools that exist in modelValue but not in catalog
const allGroups = computed<ToolGroup[]>(() => {
	const knownNames = new Set((props.resources || []).map((r) => r.name));
	const unknownSelected = (props.modelValue || []).filter((name) => !knownNames.has(name));

	const groups = [...baseGroups.value];
	if (unknownSelected.length > 0) {
		groups.push({
			id: "unknown",
			label: t("tools.unknownToolsGroup"),
			tools: unknownSelected.map((name) => ({
				name,
				description: t("tools.unknownToolDesc"),
			})),
		});
	}
	return groups;
});

// Groups filtered by search query
const visibleGroups = computed(() => {
	const query = searchQuery.value.trim().toLowerCase();
	if (!query) return allGroups.value;

	const filtered: ToolGroup[] = [];
	for (const group of allGroups.value) {
		const groupMatches = group.label.toLowerCase().includes(query);
		const matchingTools = group.tools.filter((tool) => {
			if (groupMatches) return true;
			return (
				tool.name.toLowerCase().includes(query) ||
				(tool.description && tool.description.toLowerCase().includes(query)) ||
				(tool.source && tool.source.toLowerCase().includes(query))
			);
		});

		if (matchingTools.length > 0) {
			filtered.push({
				...group,
				tools: matchingTools,
			});
		}
	}
	return filtered;
});

function isSelected(name: string): boolean {
	return selectedSet.value.has(name);
}

function isGroupAllSelected(group: ToolGroup): boolean {
	if (group.tools.length === 0) return false;
	return group.tools.every((t) => selectedSet.value.has(t.name));
}

function isGroupPartialSelected(group: ToolGroup): boolean {
	if (group.tools.length === 0) return false;
	const some = group.tools.some((t) => selectedSet.value.has(t.name));
	return some && !isGroupAllSelected(group);
}

function groupSelectedCount(group: ToolGroup): number {
	return group.tools.filter((t) => selectedSet.value.has(t.name)).length;
}

function emitSelection(newSelection: string[]): void {
	const deduped = deduplicateToolNames(newSelection);
	emit("update:modelValue", deduped);
	emit("change", deduped);
}

function onToggleTool(name: string, checked: boolean): void {
	const current = [...(props.modelValue || [])];
	let updated: string[];
	if (checked) {
		updated = [...current, name];
	} else {
		updated = current.filter((item) => item !== name);
	}
	emitSelection(updated);
}

function selectGroup(group: ToolGroup, selectAll: boolean): void {
	const current = [...(props.modelValue || [])];
	const groupNames = new Set(group.tools.map((t) => t.name));
	let updated: string[];
	if (selectAll) {
		updated = [...current, ...group.tools.map((t) => t.name)];
	} else {
		updated = current.filter((item) => !groupNames.has(item));
	}
	emitSelection(updated);
}

function onToggleGroup(group: ToolGroup, checked: boolean): void {
	selectGroup(group, checked);
}

function addManualInput(): void {
	const raw = manualInput.value.trim();
	if (!raw) return;
	const parts = raw.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
	if (parts.length > 0) {
		emitSelection([...(props.modelValue || []), ...parts]);
		manualInput.value = "";
	}
}

function toggleOpen(): void {
	if (props.disabled) return;
	isOpen.value = !isOpen.value;
	if (isOpen.value) {
		updatePosition();
		nextTick(() => {
			updatePosition();
			searchInputRef.value?.focus();
		});
	}
}

function close(): void {
	isOpen.value = false;
	searchQuery.value = "";
	triggerRef.value?.focus();
}

function handleDocumentClick(event: MouseEvent): void {
	if (!isOpen.value) return;
	const target = event.target as Node;
	if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) {
		return;
	}
	close();
}

function handleKeydown(event: KeyboardEvent): void {
	if (isOpen.value && event.key === "Escape") {
		close();
	}
}

onMounted(() => {
	document.addEventListener("click", handleDocumentClick, true);
	document.addEventListener("keydown", handleKeydown);
	window.addEventListener("resize", updatePosition);
	window.addEventListener("scroll", updatePosition, true);
});

onBeforeUnmount(() => {
	document.removeEventListener("click", handleDocumentClick, true);
	document.removeEventListener("keydown", handleKeydown);
	window.removeEventListener("resize", updatePosition);
	window.removeEventListener("scroll", updatePosition, true);
});

function getTooltip(tool: WebEditorPolicyResource): string {
	return toolTooltip(tool, {
		sourceLabel: (source) => t("policy.sourceLabel", { source }),
		currentlyActive: t("policy.currentlyActive"),
		registeredInactive: t("policy.registeredInactive"),
		hiddenFromModel: t("policy.hiddenFromModel"),
	});
}
</script>

<template>
	<div ref="rootRef" class="tool-picker-root" :class="{ open: isOpen }">
		<button
			ref="triggerRef"
			type="button"
			class="tool-picker-trigger"
			data-tool-picker-trigger
			:disabled="disabled"
			:aria-expanded="isOpen"
			@click="toggleOpen"
		>
			<span class="tool-picker-trigger-label">{{ buttonLabel || t("tools.chooseToolsBtn") }}</span>
			<span v-if="selectedCount > 0" class="tool-picker-badge" data-tool-picker-count>
				{{ selectedCount }}
			</span>
		</button>

		<div
			v-if="isOpen"
			ref="panelRef"
			class="tool-picker-panel"
			data-tool-picker-panel
			data-tool-picker-popover
			:style="{
				position: 'fixed',
				top: popoverStyle.top,
				left: popoverStyle.left,
				width: popoverStyle.width,
				maxHeight: popoverStyle.maxHeight,
				zIndex: 10000,
			}"
		>
			<header class="tool-picker-header">
					<span class="tool-picker-title">{{ title || t("tools.chooseTools") }}</span>
					<span class="tool-picker-spacer"></span>
					<button v-if="canRefresh" type="button" data-tool-picker-refresh :disabled="loading" @click="emit('refresh')">{{ t("tools.refresh") }}</button>
					<button
						type="button"
						class="tool-picker-close-btn"
						data-tool-picker-close
						:title="t('tools.close')"
						@click="close"
					>
						✕
					</button>
				</header>

				<div class="tool-picker-search-bar">
					<input
						ref="searchInputRef"
						v-model="searchQuery"
						type="text"
						class="tool-picker-search-input"
						data-tool-picker-search
						:aria-label="t('tools.searchPlaceholder')"
						:placeholder="t('tools.searchPlaceholder')"
					>
					<button
						v-if="searchQuery"
						type="button"
						class="tool-picker-search-clear"
						@click="searchQuery = ''"
					>
						✕
					</button>
				</div>

				<div v-if="loading" class="tool-picker-status" data-tool-picker-loading>
					{{ t("tools.catalogLoading") }}
				</div>
				<div v-else-if="error" class="tool-picker-status error" data-tool-picker-error>
					{{ error || t("tools.catalogError") }}
				</div>

				<div class="tool-picker-body" data-tool-picker-groups>
					<div
						v-for="group in visibleGroups"
						:key="group.id"
						class="tool-group"
						:data-tool-group="group.id"
					>
						<div class="tool-group-header">
							<button
								type="button"
								class="tool-group-toggle-btn"
								data-tool-group-toggle
								:data-group-id="group.id"
								:aria-expanded="isGroupExpanded(group.id)"
								:title="isGroupExpanded(group.id) ? t('tools.collapseGroup') : t('tools.expandGroup')"
								@click.stop="toggleGroupExpand(group.id)"
							>
								<span class="tool-group-chevron" aria-hidden="true">{{ isGroupExpanded(group.id) ? '▾' : '▸' }}</span>
							</button>
							<label class="tool-group-label-row">
								<input
									type="checkbox"
									data-tool-group-checkbox
									:data-group-id="group.id"
									:checked="isGroupAllSelected(group)"
									:indeterminate.prop="isGroupPartialSelected(group)"
									@change="onToggleGroup(group, ($event.target as HTMLInputElement).checked)"
								>
								<span class="tool-group-name" :title="group.label">{{ group.label }}</span>
							</label>
							<span class="tool-group-count">
								({{ groupSelectedCount(group) }}/{{ group.tools.length }})
							</span>
							<span class="tool-group-spacer"></span>

						</div>

						<div v-if="isGroupExpanded(group.id)" class="tool-group-items" :data-tool-group-items="group.id">
							<label
								v-for="tool in group.tools"
								:key="tool.name"
								class="tool-item"
								:data-tool-item="tool.name"
								:title="getTooltip(tool)"
							>
								<input
									type="checkbox"
									data-tool-checkbox
									:data-tool-name="tool.name"
									:value="tool.name"
									:checked="isSelected(tool.name)"
									@change="onToggleTool(tool.name, ($event.target as HTMLInputElement).checked)"
								>
								<span class="tool-item-name">{{ tool.name }}</span>
								<span
									v-if="tool.active"
									class="tool-item-badge active"
									:title="t('policy.currentlyActive')"
								>*</span>
								<span
									v-if="tool.hidden"
									class="tool-item-badge hidden"
									:title="t('policy.hiddenFromModel')"
								>{{ t("policy.suffixHidden") }}</span>
								<span
									v-if="tool.source"
									class="tool-item-source"
									:title="t('policy.sourceLabel', { source: tool.source })"
								>{{ tool.source }}</span>
								<span v-if="tool.description" class="tool-item-desc">{{ tool.description }}</span>
							</label>
						</div>
					</div>

					<div
						v-if="visibleGroups.length === 0 && !loading"
						class="tool-picker-empty"
						data-tool-picker-empty
					>
						{{ searchQuery ? t("tools.noToolsMatching") : t("tools.noToolsAvailable") }}
					</div>
				</div>

				<footer class="tool-picker-footer">
					<details v-if="allowManualEntry" class="tool-picker-manual">
                        <summary>{{ t("tools.manualEntry") }}</summary>
                        <div class="tool-picker-manual-row">
						<input
							v-model="manualInput"
							type="text"
							class="tool-picker-manual-input"
							data-tool-manual-input
							:placeholder="t('tools.manualNames')"
                            :aria-label="t('tools.manualNames')"
							@keydown.enter.prevent="addManualInput"
						>
						<button
							type="button"
							class="tool-picker-manual-btn"
							data-tool-manual-btn
                            :aria-label="t('tools.addNames')"
							@click="addManualInput"
						>
							+
						</button>
                        </div>
                    </details>
					<div class="tool-picker-batch-hint">{{ t("tools.batchHint") }}</div>
				<div class="tool-picker-footer-bar">
						<span class="tool-picker-footer-count" data-tool-footer-count>
							{{ t("tools.selectedCount", { count: selectedCount }) }}
						</span>
						<span class="tool-picker-spacer"></span>
						<button
							type="button"
							class="tool-picker-done-btn primary"
							data-tool-picker-done
							@click="close"
						>
							{{ t("tools.close") }}
						</button>
					</div>
				</footer>
		</div>
	</div>
</template>

<style scoped>
.tool-picker-root {
	position: relative;
	display: inline-block;
}

.tool-picker-trigger {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--pane);
	color: var(--text);
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
	transition: background 0.15s, border-color 0.15s;
}

.tool-picker-trigger:hover:not(:disabled) {
	background: var(--pane-soft);
	border-color: var(--accent);
}

.tool-picker-trigger:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.tool-picker-badge {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 18px;
	height: 18px;
	padding: 0 5px;
	background: var(--accent);
	color: var(--accent-contrast, #ffffff);
	font-size: 11px;
	font-weight: 600;
	border-radius: 9px;
}

.tool-picker-panel {
	z-index: 10000;
	width: 380px;
	max-width: 90vw;
	max-height: 480px;
	display: flex;
	flex-direction: column;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
	overflow: hidden;
}

.tool-picker-header {
	display: flex;
	align-items: center;
	padding: 8px 12px;
	background: var(--pane-soft);
	border-bottom: 1px solid var(--line);
}

.tool-picker-title {
	font-weight: 600;
	font-size: 13px;
	color: var(--text);
}

.tool-picker-spacer {
	flex: 1;
}

.tool-picker-close-btn {
	background: none;
	border: none;
	color: var(--muted);
	font-size: 14px;
	cursor: pointer;
	padding: 2px 6px;
	border-radius: 3px;
}

.tool-picker-close-btn:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--text) 10%, transparent);
}

.tool-picker-search-bar {
	position: relative;
	padding: 8px 10px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
}

.tool-picker-search-input {
	width: 100%;
	padding: 5px 24px 5px 8px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--pane-soft);
	color: var(--text);
	font-size: 12px;
	box-sizing: border-box;
}

.tool-picker-search-clear {
	position: absolute;
	right: 16px;
	top: 50%;
	transform: translateY(-50%);
	background: none;
	border: none;
	color: var(--muted);
	cursor: pointer;
	font-size: 12px;
	padding: 2px;
}

.tool-picker-status {
	padding: 8px 12px;
	font-size: 12px;
	color: var(--muted);
	background: var(--pane-soft);
}

.tool-picker-status.error {
	color: var(--error, #ef4444);
	background: color-mix(in srgb, var(--error, #ef4444) 10%, var(--pane));
}

.tool-picker-body {
	flex: 1;
	overflow-y: auto;
	padding: 6px 0;
	max-height: 280px;
}

.tool-group {
	margin-bottom: 8px;
	border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent);
	padding-bottom: 6px;
}

.tool-group:last-child {
	border-bottom: none;
	margin-bottom: 0;
}

.tool-group-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	background: var(--pane-soft);
	font-size: 12px;
	font-weight: 600;
}

.tool-group-toggle-btn {
	background: none;
	border: none;
	padding: 2px 4px;
	cursor: pointer;
	color: var(--muted);
	display: inline-flex;
	align-items: center;
	font-size: 11px;
	border-radius: 3px;
	flex-shrink: 0;
}

.tool-group-toggle-btn:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--text) 10%, transparent);
}

.tool-group-chevron {
	font-size: 10px;
	line-height: 1;
}

.tool-group-label-row {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	cursor: pointer;
}

.tool-group-name {
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 180px;
}
.tool-group-label-row { min-width: 0; }
.tool-picker-batch-hint { font-size: 11px; color: var(--muted); }


.tool-group-count {
	font-size: 11px;
	color: var(--muted);
	font-weight: normal;
}




.tool-group-items {
	display: flex;
	flex-direction: column;
	padding: 2px 0;
}

.tool-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px 4px 24px;
	font-size: 12px;
	cursor: pointer;
	user-select: none;
	transition: background 0.1s;
	min-width: 0;
	overflow: hidden;
}

.tool-item:hover {
	background: var(--pane-soft);
}

.tool-item-name {
	font-family: monospace;
	font-size: 12px;
	color: var(--text);
	flex-shrink: 0;
}

.tool-item-badge {
	font-size: 10px;
	padding: 1px 4px;
	border-radius: 3px;
	font-weight: 600;
	flex-shrink: 0;
}

.tool-item-badge.active {
	color: #22c55e;
}

.tool-item-badge.hidden {
	color: var(--muted);
	font-size: 10px;
}

.tool-item-source {
	font-size: 10px;
	color: var(--muted);
	background: color-mix(in srgb, var(--line) 60%, transparent);
	padding: 1px 4px;
	border-radius: 3px;
	margin-left: 2px;
	max-width: 80px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex-shrink: 1;
}

.tool-item-desc {
	font-size: 11px;
	color: var(--muted);
	margin-left: auto;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 120px;
	flex-shrink: 2;
}

.tool-picker-empty {
	padding: 16px 12px;
	text-align: center;
	color: var(--muted);
	font-size: 12px;
}

.tool-picker-footer {
	border-top: 1px solid var(--line);
	background: var(--pane-soft);
	padding: 6px 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.tool-picker-manual-row {
	display: flex;
	gap: 4px;
}

.tool-picker-manual-input {
	flex: 1;
	padding: 3px 6px;
	border: 1px solid var(--line);
	border-radius: 3px;
	background: var(--pane);
	color: var(--text);
	font-size: 11px;
}

.tool-picker-manual-btn {
	padding: 2px 8px;
	font-size: 12px;
	border: 1px solid var(--line);
	border-radius: 3px;
	background: var(--pane);
	color: var(--text);
	cursor: pointer;
}

.tool-picker-footer-bar {
	display: flex;
	align-items: center;
}

.tool-picker-footer-count {
	font-size: 11px;
	color: var(--muted);
}

.tool-picker-done-btn {
	padding: 3px 12px;
	font-size: 12px;
	border-radius: 4px;
	cursor: pointer;
}

/* The shared editor's text-input defaults must not stretch native checkboxes. */
.tool-picker-root input[type="checkbox"] { width: 14px; height: 14px; min-width: 14px; padding: 0; margin: 0; flex: 0 0 14px; }
.tool-item { min-width: 0; }
.tool-item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-item-source { display: none; } /* Complete provenance remains in the row tooltip. */
.tool-picker-manual summary { cursor:pointer; color:var(--muted); font-size:12px; }
.tool-picker-manual[open] summary { margin-bottom:8px; }
</style>
