<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { WebEditorPreviewSection } from "../../types.ts";
import { inspectionEntries, inspectionRows, isBatch, pairedRows, rowMatches, type InspectionBatch, type InspectionRow } from "../preview-inspector.ts";
import { t } from "../i18n.ts";
import PreviewInspectionRow from "./PreviewInspectionRow.vue";
const props = defineProps<{ sections: WebEditorPreviewSection[]; boundary: string; matchingIds: string[] }>();
const emit = defineEmits<{ copy: [text: string] }>();
const root = ref<HTMLElement | null>(null);
const query = ref(""), resultMode = ref<"original" | "paired">("original"), fullText = ref(false);
const openRows = ref(new Set<string>()), closedBatches = ref(new Set<string>()), closedSources = ref(new Set<string>());
const scrollMemory = new Map<string, number>();
const rows = computed(() => inspectionRows(props.sections));
const entries = computed(() => inspectionEntries(rows.value));
const trimmedQuery = computed(() => query.value.trim());
const matchingRows = computed(() => new Set(rows.value.filter(row => rowMatches(row, trimmedQuery.value))));
const matches = (row: InspectionRow) => matchingRows.value.has(row);
const sourceGroups = computed(() => {
 const groups: { key: string; label: string; history: boolean; entries: typeof entries.value }[] = [];
 let current: typeof groups[number] | undefined, lastScope = "";
 for (const entry of entries.value) {
  const first = isBatch(entry) ? entry.rows[0]! : entry;
  const history = first.scope === "implicit-history" || first.scope.startsWith("chat-history:");
  if (!history || !current || lastScope !== first.scope) {
   current = { key: `source:${first.scope}:${entry.key}`, label: first.section.title.replace(/\s+#\d+$/, ""), history, entries: [] };
   groups.push(current);
  }
  current.entries.push(entry); lastScope = history ? first.scope : "";
 }
 return groups;
});
const visibleGroups = computed(() => sourceGroups.value.map(group => ({ ...group, entries: group.entries.filter(entry => isBatch(entry) ? entry.rows.some(matches) : matches(entry)) })).filter(group => group.entries.length));
const visibleGroupKeys = computed(() => new Set(visibleGroups.value.map(group => group.key)));
function toggleSource(key: string, event: Event) { if (trimmedQuery.value || fullText.value) return; const next = new Set(closedSources.value); (event.target as HTMLDetailsElement).open ? next.delete(key) : next.add(key); closedSources.value = next; }
const matchCount = computed(() => matchingRows.value.size);
function displayedRows(batch: InspectionBatch): InspectionRow[] { return resultMode.value === "paired" ? pairedRows(batch.rows) : batch.rows; }
function counts(batch: InspectionBatch) { return t("inspection.batchCounts", { calls: batch.rows.filter(row => row.kind === "call").length, results: batch.rows.filter(row => row.kind === "result").length }); }
function failures(batch: InspectionBatch) { return batch.rows.filter(row => row.isError === true).length; }
function toggleRow(key: string, open: boolean) { const next = new Set(openRows.value); open ? next.add(key) : next.delete(key); openRows.value = next; }
function toggleBatch(key: string, event: Event) { if (trimmedQuery.value || fullText.value) return; const next = new Set(closedBatches.value); (event.target as HTMLDetailsElement).open ? next.delete(key) : next.add(key); closedBatches.value = next; }
function pane() { return root.value?.closest<HTMLElement>(".context-diff-compiled"); }
function visible(el: HTMLElement) { return el.checkVisibility() && !!el.getClientRects().length; }
function elementByKey(key: string) { return [...(root.value?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])].find(el => el.dataset.rowKey === key); }
function sourceByKey(key: string) { return [...(root.value?.querySelectorAll<HTMLElement>("[data-group-key]") ?? [])].find(el => el.dataset.groupKey === key); }
function batchByKey(key: string) { return [...(root.value?.querySelectorAll<HTMLElement>("[data-batch-key]") ?? [])].find(el => el.dataset.batchKey === key); }
function captureReading() {
 const p = pane(); if (!p) return null;
 const top = p.getBoundingClientRect().top;
 const anchor = [...(root.value?.querySelectorAll<HTMLElement>("[data-row-key],.inspection-batch>summary,.source-group-head") ?? [])].find(el => visible(el) && el.getBoundingClientRect().bottom > top + 1 && el.getBoundingClientRect().top < p.getBoundingClientRect().bottom);
 return { scroll: p.scrollTop, key: anchor?.dataset.rowKey, batch: anchor?.parentElement?.dataset.batchKey, source: anchor?.parentElement?.dataset.groupKey, fallback: anchor?.parentElement?.querySelector<HTMLElement>("[data-row-key]")?.dataset.rowKey, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, focus: root.value?.contains(document.activeElement) ? document.activeElement as HTMLElement : null };
}
function restoreReading(saved: ReturnType<typeof captureReading>) {
 const p = pane(); if (!p || !saved) return;
 p.scrollTop = saved.scroll;
 let el = saved.key ? elementByKey(saved.key) : saved.batch ? batchByKey(saved.batch)?.querySelector<HTMLElement>("summary") : saved.source ? sourceByKey(saved.source)?.querySelector<HTMLElement>("summary") : undefined;
 if (!el && saved.fallback) el = elementByKey(saved.fallback);
 let offset = saved.offset;
 if (el && !visible(el)) { el = el.closest(".inspection-batch")?.querySelector<HTMLElement>("summary") || el.closest(".context-diff-group")?.querySelector<HTMLElement>("summary"); if (el && !visible(el)) el = el.closest(".context-diff-group")?.querySelector<HTMLElement>("summary"); offset = Math.max(8, offset); }
 if (el && visible(el)) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - offset;
 if (saved.focus && root.value?.contains(saved.focus) && visible(saved.focus) && document.activeElement === document.body) saved.focus.focus({ preventScroll: true });
}
// Native `toggle` is queued; capture the actual choice before entering a
// forced-open mode even if that event has not updated the saved sets yet.
function snapshotDisclosures() {
 const sources = new Set(closedSources.value), batches = new Set(closedBatches.value), open = new Set(openRows.value);
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-group-key]") ?? []) el.open ? sources.delete(el.dataset.groupKey!) : sources.add(el.dataset.groupKey!);
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-batch-key]") ?? []) el.open ? batches.delete(el.dataset.batchKey!) : batches.add(el.dataset.batchKey!);
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-row-key]") ?? []) el.open ? open.add(el.dataset.rowKey!) : open.delete(el.dataset.rowKey!);
 closedSources.value = sources; closedBatches.value = batches; openRows.value = open;
}
// A native disclosure can be manually changed while search/full-text forces its
// Vue `open` prop true. Reapply the saved choice when the mode changes, even if
// Vue sees true -> true and would otherwise leave the native DOM closed.
function syncDisclosures() {
 const forced = fullText.value || !!trimmedQuery.value;
 const matchingKeys = new Set([...matchingRows.value].map(row => row.key));
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-group-key]") ?? []) el.open = forced || !closedSources.value.has(el.dataset.groupKey!);
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-batch-key]") ?? []) el.open = forced || !closedBatches.value.has(el.dataset.batchKey!);
 for (const el of root.value?.querySelectorAll<HTMLDetailsElement>("details[data-row-key]") ?? []) el.open = fullText.value || (!!trimmedQuery.value && matchingKeys.has(el.dataset.rowKey!)) || openRows.value.has(el.dataset.rowKey!);
}
let generation = 0;
let beforeSearch: { reading: ReturnType<typeof captureReading>; boundary: string } | null = null;
watch(trimmedQuery, async (next, previous) => {
 if (next && !previous) { if (!fullText.value) snapshotDisclosures(); beforeSearch = { reading: captureReading(), boundary: props.boundary }; }
 const epoch = generation;
 await nextTick(); if (epoch !== generation) return;
 syncDisclosures();
 if (!next && beforeSearch?.boundary === props.boundary) { restoreReading(beforeSearch.reading); beforeSearch = null; }
 else if (next) { const p = pane(); if (p) p.scrollTop = 0; }
});
watch(() => props.boundary, () => { generation++; beforeSearch = null; openRows.value = new Set(); closedBatches.value = new Set(); closedSources.value = new Set(); scrollMemory.clear(); query.value = ""; });
watch(() => props.sections, async () => {
 const saved = captureReading(), epoch = generation;
 const keys = new Set(rows.value.map(row => row.key));
 for (const key of scrollMemory.keys()) if (!keys.has(key)) scrollMemory.delete(key);
 openRows.value = new Set([...openRows.value].filter(key => keys.has(key)));
 const batches = new Set(entries.value.filter(isBatch).map(batch => batch.key));
 closedBatches.value = new Set([...closedBatches.value].filter(key => batches.has(key)));
 const sourceKeys = new Set(sourceGroups.value.map(group => group.key));closedSources.value = new Set([...closedSources.value].filter(key => sourceKeys.has(key)));
 await nextTick(); if (epoch === generation) restoreReading(saved);
});
watch(() => rows.value.map(row => row.key).join("\n"), (next, previous) => {
 if (previous && next !== previous && (next.includes(":temp:") || previous.includes(":temp:"))) { openRows.value = new Set(); closedBatches.value = new Set(); scrollMemory.clear(); }
});
async function changeResultMode(event: Event) { const saved = captureReading(); resultMode.value = (event.target as HTMLSelectElement).value as "original" | "paired"; await nextTick(); restoreReading(saved); }
async function changeFullText() { const saved = captureReading(); if (!fullText.value && !trimmedQuery.value) snapshotDisclosures(); fullText.value = !fullText.value; await nextTick(); syncDisclosures(); restoreReading(saved); }
async function openSections(ids: string[]) {
 query.value = "";
 const targets = rows.value.filter(row => ids.includes(row.section.id));
 for (const row of targets) toggleRow(row.key, true);
 const closed = new Set(closedBatches.value);for (const entry of entries.value) if (isBatch(entry) && entry.rows.some(row => ids.includes(row.section.id))) closed.delete(entry.key);closedBatches.value = closed;
 const sources = new Set(closedSources.value);for (const group of sourceGroups.value) if (group.entries.some(entry => (isBatch(entry) ? entry.rows : [entry]).some(row => ids.includes(row.section.id)))) sources.delete(group.key);closedSources.value = sources;
 await nextTick();
}
async function jump(key: string) {
 const row = rows.value.find(row => row.key === key); if (!row) return;
 await openSections([row.section.id]);const el = elementByKey(key), p = pane();
 if (el && p) { p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 8; (el.querySelector<HTMLElement>("summary") || el).focus({ preventScroll: true }); }
}
defineExpose({ openSections });
</script>

<template>
 <div ref="root" class="preview-inspector">
  <div class="inspection-controls">
   <input v-model="query" type="search" :placeholder="t('inspection.search')" :aria-label="t('inspection.search')">
   <label>{{ t('inspection.results') }} <select :value="resultMode" @change="changeResultMode"><option value="original">{{ t('inspection.original') }}</option><option value="paired">{{ t('inspection.paired') }}</option></select></label>
   <button type="button" class="inspection-full-toggle" :aria-pressed="fullText" @click="changeFullText">{{ t(fullText ? 'inspection.excerpts' : 'inspection.fullText') }}</button>
  </div>
  <p v-if="resultMode === 'paired'" class="inspection-order-note">{{ t('inspection.pairedNote') }}</p>
  <p v-if="trimmedQuery" class="inspection-search-count">{{ t('inspection.searchCount', { count: matchCount, total: rows.length }) }}</p>
  <div class="context-diff-sections">
   <component :is="group.history ? 'details' : 'div'" v-for="group in sourceGroups" v-show="visibleGroupKeys.has(group.key)" :key="group.key" class="context-diff-group" :class="{ 'single-source': !group.history }" :data-group-key="group.key" :open="!group.history || fullText || !!trimmedQuery || !closedSources.has(group.key)" @toggle="toggleSource(group.key, $event)">
    <summary v-if="group.history" class="source-group-head">{{ group.label }}</summary>
    <template v-for="entry in group.entries" :key="entry.key">
    <details v-if="isBatch(entry)" v-show="entry.rows.some(matches)" class="inspection-batch" :data-batch-key="entry.key" :open="fullText || !!trimmedQuery || !closedBatches.has(entry.key)" @toggle="toggleBatch(entry.key, $event)">
     <summary :title="t('inspection.batchNote')"><span class="batch-chevron" aria-hidden="true">▸</span><strong>Tools</strong><span>{{ counts(entry) }}</span><span v-if="failures(entry)" class="batch-failures">{{ t('inspection.failures', { count: failures(entry) }) }}</span></summary>
     <PreviewInspectionRow v-for="row in displayedRows(entry)" v-show="matches(row)" :key="row.key" :row="row" :initial-scroll-top="scrollMemory.get(row.key) || 0" @scroll-position="(key, top) => scrollMemory.set(key, top)" :open="openRows.has(row.key)" :full="fullText" :searching="!!trimmedQuery && matches(row)" :query="trimmedQuery" :matched="matchingIds.includes(row.section.id)" @toggle="toggleRow" @copy="emit('copy', $event)" @jump="jump" />
    </details>
    <PreviewInspectionRow v-else v-show="matches(entry)" :row="entry" :initial-scroll-top="scrollMemory.get(entry.key) || 0" @scroll-position="(key, top) => scrollMemory.set(key, top)" :open="openRows.has(entry.key)" :full="fullText" :searching="!!trimmedQuery && matches(entry)" :query="trimmedQuery" :matched="matchingIds.includes(entry.section.id)" @toggle="toggleRow" @copy="emit('copy', $event)" @jump="jump" />
    </template>
   </component>
   <p v-if="!visibleGroups.length" class="inspection-search-count">{{ t('inspection.noMatches') }}</p>
  </div>
 </div>
</template>

<style scoped>
.context-diff-group{min-width:0}.source-group-head{padding:7px 12px;color:var(--muted);font-size:11px;background:var(--pane-soft);border-bottom:1px solid var(--line);cursor:pointer}.single-source{display:block}.single-source::details-content{display:block}
.preview-inspector{min-width:0;container-type:inline-size}.inspection-controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:10px;border-bottom:1px solid var(--line);background:var(--pane-soft)}.inspection-controls input{min-width:120px;flex:1;font-size:12px}.inspection-controls label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);white-space:nowrap}.inspection-controls select,.inspection-controls button{font-size:12px;min-height:28px;padding:3px 6px;max-width:100%}.inspection-order-note,.inspection-search-count{font-size:11px;color:var(--muted);padding:7px 10px;margin:0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.context-diff-sections{display:flex;flex-direction:column;min-width:0}.inspection-batch{min-width:0;border-left:2px solid var(--role-tool-result);border-bottom:1px solid var(--line)}.inspection-batch>summary{display:flex;list-style:none;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;min-height:36px;cursor:pointer;font-size:12px;background:color-mix(in srgb,var(--role-tool-result) 5%,var(--pane))}.inspection-batch>summary::-webkit-details-marker{display:none}.inspection-batch>summary strong,.batch-chevron{color:var(--role-tool-result)}.inspection-batch[open]>summary .batch-chevron{transform:rotate(90deg)}.batch-failures{color:var(--error);font-size:11px}.inspection-batch>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@container(max-width:520px){.inspection-controls input{flex-basis:100%}.inspection-batch>summary{padding:8px;gap:6px;font-size:11px}}
</style>
