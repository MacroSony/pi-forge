<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { t } from "../i18n.ts";
import { declaredParameterCount, declarationExcerpt, declarationJson, declarationMatches } from "../preview-tool-declarations.ts";
import type { WebEditorPreviewSection } from "../../types.ts";

const props = defineProps<{
	section: WebEditorPreviewSection;
	searchQuery?: string;
}>();

const emit = defineEmits<{
	(e: "copy", text: string): void;
}>();

const namedSectionEntries = computed(() => {
	if (!props.section.sections) return [];
	return Object.entries(props.section.sections);
});

const hasNamedSections = computed(() => namedSectionEntries.value.length > 0);

const toolChanges = computed(() => props.section.toolChanges);
const addedTools = computed(() => toolChanges.value?.added ?? []);
const removedTools = computed(() => toolChanges.value?.removed ?? []);
const totalToolDeltas = computed(() => addedTools.value.length + removedTools.value.length);
const hasToolChanges = computed(() => totalToolDeltas.value > 0);

// Mount a declaration's JSON only after it has been opened once. Keep that DOM
// on close so native disclosure and same-data refresh retain its reading state.
const renderedTools = ref(new Set<number>());
function revealTool(index: number, event: Event): void {
	if ((event.target as HTMLDetailsElement).open && !renderedTools.value.has(index)) {
		renderedTools.value = new Set([...renderedTools.value, index]);
	}
}

// Search temporarily opens matching declaration metadata. The parent keeps
// filtered rows mounted, so native disclosure/source state survives filtering.
const sectionRoot = ref<HTMLElement | null>(null);
let searchReading: { open: boolean; tools: { open: boolean; top?: number }[] } | null = null;
let searchEpoch = 0;
async function applySearch(query: string, previous: string) {
 if (!query && !searchReading) return;
 const root = sectionRoot.value;
 const group = root?.querySelector<HTMLDetailsElement>(".preview-tool-changes");
 if (!root || !group) return;
 const tools = [...root.querySelectorAll<HTMLDetailsElement>(".tool-change-item.added")];
 if (query && !previous) searchReading = { open: group.open, tools: tools.map(el => {
  const pre = el.querySelector<HTMLElement>(".tool-declaration-json");
  return { open: el.open, top: pre?.checkVisibility() ? pre.scrollTop : undefined };
 }) };
 const saved = searchReading, epoch = ++searchEpoch;
 await nextTick();
 if (epoch !== searchEpoch || !saved) return;
 const matching = addedTools.value.map(tool => declarationMatches(tool, query));
 group.open = saved.open || matching.some(Boolean) || (!!query && removedTools.value.some(name => typeof name === "string" && name.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
 tools.forEach((el, index) => {
  const before = saved.tools[index];
  el.open = !!before?.open || !!matching[index];
  if (!query && before?.top !== undefined) {
   const pre = el.querySelector<HTMLElement>(".tool-declaration-json");
   if (pre) pre.scrollTop = before.top;
  }
 });
 if (!query) searchReading = null;
}
watch(() => props.searchQuery?.trim() ?? "", applySearch);
onMounted(() => { void applySearch(props.searchQuery?.trim() ?? "", ""); });

function onCopyNamed(value: string | null): void {
	if (value && value.length > 0) {
		emit("copy", value);
	}
}
</script>

<template>
	<div ref="sectionRoot" class="preview-section-body">
		<!-- Actual prompt body (if present, or if no structured sections exist) -->
		<pre v-if="section.content || (!hasNamedSections && !hasToolChanges)" class="section-text">{{ section.content }}</pre>

		<!-- Native named System sections (labels and actions outside prompt text) -->
		<div v-if="hasNamedSections" class="preview-named-sections">
			<div v-for="[name, value] in namedSectionEntries" :key="name" class="preview-named-section">
				<div class="named-section-header">
					<span class="named-section-name">{{ name }}</span>
					<span v-if="value === null" class="named-section-op op-removed">{{ t("diff.opRemoved") }}</span>
					<span v-else-if="value === ''" class="named-section-op op-empty">{{ t("diff.opEmpty") }}</span>
					<span v-else class="named-section-op op-set">{{ t("diff.opSet") }}</span>
					<button
						v-if="value !== null && value.length > 0"
						type="button"
						class="named-section-copy"
						@click.prevent.stop="onCopyNamed(value)"
					>
						{{ t("inspector.copy") }}
					</button>
				</div>
				<div v-if="value === null" class="named-section-notice removed">
					{{ t("diff.namedSectionRemovedNotice", { name }) }}
				</div>
				<div v-else-if="value === ''" class="named-section-notice empty">
					{{ t("diff.namedSectionEmptyNotice", { name }) }}
				</div>
				<pre v-else class="section-text">{{ value }}</pre>
			</div>
		</div>

		<!-- Historical transcript tool declarations (collapsed separate inspector, explicitly not current selection) -->
		<details v-if="hasToolChanges" class="preview-tool-changes">
			<summary class="tool-changes-summary">
				<span class="tool-changes-title">{{ t("diff.historicalToolChangesSummary", { count: totalToolDeltas }) }}</span>
				<span class="tool-changes-badge">{{ t("diff.historicalNotCurrentBadge") }}</span>
			</summary>
			<div class="tool-changes-content">
				<p class="tool-changes-note">{{ t("diff.historicalToolChangesNote") }}</p>
				<div v-if="addedTools.length > 0" class="tool-changes-group">
					<div class="tool-group-label">{{ t("diff.toolsAddedLabel") }} ({{ addedTools.length }})</div>
					<details v-for="(tool, index) in addedTools" :key="JSON.stringify([tool.name, index])" class="tool-change-item added" :data-tool-name="tool.name" @toggle="revealTool(index, $event)">
						<summary class="tool-item-head">
							<span class="tool-declaration-chevron" aria-hidden="true">▸</span>
							<code class="tool-name" :title="tool.name">{{ tool.name }}</code>
							<span v-if="declaredParameterCount(tool.parameters) !== null" class="tool-argument-count" :title="t('inspection.declaredArgsNote')">{{ t('inspection.declaredArgs', { count: declaredParameterCount(tool.parameters)! }) }}</span>
							<span v-if="tool.description" class="tool-desc">{{ declarationExcerpt(tool.description) }}</span>
						</summary>
						<div v-if="renderedTools.has(index)" class="tool-declaration-detail">
							<div class="tool-declaration-actions"><span>{{ t('inspection.declarationJson') }}</span><button type="button" @click="emit('copy', declarationJson(tool))">{{ t('inspection.copyJson') }}</button></div>
							<pre class="tool-declaration-json" tabindex="0" :aria-label="t('inspection.declarationJson')"><code>{{ declarationJson(tool) }}</code></pre>
						</div>
					</details>
				</div>
				<div v-if="removedTools.length > 0" class="tool-changes-group">
					<div class="tool-group-label">{{ t("diff.toolsRemovedLabel") }} ({{ removedTools.length }})</div>
					<div v-for="name in removedTools" :key="name" class="tool-change-item removed">
						<code class="tool-name">{{ name }}</code>
					</div>
				</div>
			</div>
		</details>
	</div>
</template>

<style scoped>
.preview-section-body {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.section-text {
	margin: 0;
	padding: 10px;
	background: var(--pane);
	color: var(--text);
	white-space: pre-wrap;
	overflow: auto;
	font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.preview-named-sections {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 6px 8px 8px;
	background: var(--pane-soft);
	border-top: 1px solid var(--line);
}
.preview-named-section {
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--pane);
	overflow: hidden;
}
.named-section-header {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
	background: var(--pane-soft);
	border-bottom: 1px solid var(--line);
	font-size: 11px;
}
.named-section-name {
	min-width: 0;
	overflow-wrap: anywhere;
	font-weight: 650;
	color: var(--text);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.named-section-op {
	border-radius: 999px;
	padding: 0 6px;
	font-size: 10px;
	line-height: 16px;
	font-weight: 700;
	text-transform: lowercase;
}
.named-section-op.op-removed {
	background: color-mix(in srgb, var(--error) 15%, transparent);
	color: var(--error);
}
.named-section-op.op-empty {
	background: color-mix(in srgb, var(--warning) 15%, transparent);
	color: var(--warning);
}
.named-section-op.op-set {
	background: color-mix(in srgb, var(--success) 15%, transparent);
	color: var(--success);
}
.named-section-copy {
	margin-left: auto;
	min-height: 22px;
	padding: 1px 6px;
	font-size: 11px;
}
.named-section-notice {
	padding: 8px 10px;
	font-size: 12px;
	font-style: italic;
}
.named-section-notice.removed {
	color: var(--error);
	background: color-mix(in srgb, var(--error) 8%, var(--pane));
}
.named-section-notice.empty {
	color: var(--muted);
	background: color-mix(in srgb, var(--warning) 8%, var(--pane));
}
.preview-tool-changes {
	margin: 6px 8px 8px;
	border: 1px dashed var(--line);
	border-radius: 4px;
	background: var(--pane-soft);
	font-size: 12px;
}
.tool-changes-summary {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	cursor: pointer;
	user-select: none;
}
.tool-changes-title {
	font-weight: 600;
	color: var(--text);
}
.tool-changes-badge {
	color: var(--muted);
	font-size: 11px;
}
.tool-changes-content {
	padding: 8px 10px 10px;
	border-top: 1px solid var(--line);
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.tool-changes-note {
	margin: 0;
	color: var(--muted);
	font-size: 11px;
	line-height: 1.4;
}
.tool-changes-group {
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.tool-group-label {
	font-weight: 600;
	font-size: 11px;
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: .02em;
}
.tool-change-item {
 border: 1px solid var(--line);
 border-radius: 4px;
 background: var(--pane);
 min-width: 0;
}
.tool-change-item.added { border-left: 3px solid var(--success); }
.tool-change-item.removed { border-left: 3px solid var(--error); padding: 6px 8px; overflow-wrap: anywhere; }
.tool-item-head {
 display: flex; align-items: center; gap: 7px; flex-wrap: nowrap;
 list-style: none; min-width: 0; min-height: 32px; padding: 6px 8px; cursor: pointer;
}
.tool-item-head::-webkit-details-marker { display: none; }
.tool-declaration-chevron { flex: none; color: var(--muted); font-size: 11px; }
.tool-change-item[open] > .tool-item-head .tool-declaration-chevron { transform: rotate(90deg); }
.tool-name { font-weight: 700; font-size: 12px; color: var(--text); }
.tool-item-head .tool-name {
 max-width: 45%;
 min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tool-argument-count { flex: none; font-size: 10px; color: var(--muted); white-space: nowrap; }
.tool-desc { flex: 1; min-width: 0; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-declaration-detail { padding: 0 8px 8px; min-width: 0; }
.tool-declaration-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding: 5px 0; color: var(--muted); font-size: 10px; }
.tool-declaration-actions button { margin-left: auto; min-height: 24px; padding: 2px 6px; font-size: 11px; }
.tool-declaration-json {
 margin: 0; padding: 8px; border-radius: 3px; background: var(--code-bg); color: var(--code-text);
 font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
 max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
.tool-item-head:focus-visible,.tool-declaration-json:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
