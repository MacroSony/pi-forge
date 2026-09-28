<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "../i18n.ts";
import { parameterExcerpt, textExcerpt, type InspectionRow } from "../preview-inspector.ts";
import PreviewSectionBody from "./PreviewSectionBody.vue";
const props = defineProps<{ row: InspectionRow; open: boolean; full: boolean; matched: boolean; searching: boolean; initialScrollTop: number }>();
const emit = defineEmits<{ toggle: [key: string, open: boolean]; copy: [text: string]; jump: [key: string]; scrollPosition: [key: string, top: number] }>();
const element = ref<HTMLElement | null>(null), body = ref<HTMLElement | null>(null), pre = ref<HTMLElement | null>(null);
const mountedDetail = ref(props.open), clipped = ref(false), sourceOpen = ref(false);
let observer: ResizeObserver | undefined, innerTop = props.initialScrollTop;
const expanded = computed(() => props.open || props.full || props.searching);
const roleClass = computed(() => `role-${props.row.role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
const shortPath = computed(() => props.row.argumentHint?.split(/[\\/]/).pop());
const snippet = computed(() => props.row.kind === "call" ? parameterExcerpt(props.row.text) : textExcerpt(props.row.text));
function measure() { clipped.value = [...(body.value?.querySelectorAll<HTMLElement>(".section-text") ?? [])].some(el => el.scrollHeight > el.clientHeight + 1); }
watch(expanded, async (open) => { if (open) mountedDetail.value = true; await nextTick(); measure(); if (pre.value && !props.full) pre.value.scrollTop = innerTop; });
watch(() => props.row.text, () => nextTick(measure));
watch(() => props.full, async () => { await nextTick(); if (pre.value && !props.full) pre.value.scrollTop = innerTop; });
onMounted(() => { observer = new ResizeObserver(measure); if (body.value) observer.observe(body.value); measure(); if (pre.value && !props.full) pre.value.scrollTop = innerTop; });
onUnmounted(() => observer?.disconnect());
function onToggle(event: Event) { const open = (event.target as HTMLDetailsElement).open; if (open) mountedDetail.value = true; if (!props.full && !props.searching && open !== props.open) emit("toggle", props.row.key, open); }
function rememberScroll() { if (!props.full && pre.value) { innerTop = pre.value.scrollTop; emit("scrollPosition", props.row.key, innerTop); } }
function openBody() { emit("toggle", props.row.key, !props.open); }
defineExpose({ expand: () => emit("toggle", props.row.key, true), element });
</script>

<template>
 <details v-if="row.kind !== 'body'" ref="element" :open="expanded" :data-row-key="row.key" :data-section-id="row.section.id" :data-original-position="row.position" class="context-diff-section inspection-tool" :class="[roleClass, { 'tool-return': row.kind === 'result' && row.pairKey, 'tool-error': row.isError === true, 'capability-location-match': matched }]" @toggle="onToggle">
  <summary :title="row.section.title">
   <span class="chevron" aria-hidden="true">▸</span><span class="tool-badge">{{ row.kind === 'call' ? 'TOOL' : 'RESULT' }}</span>
   <strong class="tool-name">{{ row.toolName || t('inspection.unknownTool') }}</strong>
   <span v-if="shortPath" class="result-path" :title="row.argumentHint">{{ shortPath }}</span>
   <span class="tool-snippet">{{ snippet }}</span><span v-if="row.isError === true" class="inspection-error">{{ t('inspection.failed') }}</span>
   <small class="inspection-position" :title="t('inspection.position')">#{{ row.position }}</small>
  </summary>
  <div v-if="mountedDetail || expanded" class="tool-detail">
   <div class="row-source"><span class="section-title">{{ row.section.title }}</span><code v-if="row.callId">{{ row.callId }}</code><span v-if="row.kind === 'result' && !row.pairKey">{{ t('inspection.unlinked') }}</span><button v-if="row.pairKey" type="button" @click="emit('jump', row.pairKey)">{{ t(row.kind === 'call' ? 'inspection.findResult' : 'inspection.findCall') }}</button><button type="button" :title="t('inspection.textCopyNote')" @click="emit('copy', row.text)">{{ t('inspector.copy') }}</button></div>
   <pre ref="pre" class="section-text tool-full-text" :class="{ unbounded: full }" tabindex="0" @scroll="rememberScroll">{{ row.text }}</pre>
  </div>
 </details>
 <article v-else ref="element" :data-row-key="row.key" :data-section-id="row.section.id" :data-original-position="row.position" class="context-diff-section inspection-body" :class="[roleClass, { 'capability-location-match': matched }]" tabindex="-1">
  <div class="inspection-body-head">
   <span class="section-role" :class="roleClass">{{ row.role }}</span><small v-if="row.partKind && row.partKind !== 'text'">{{ row.partKind }}</small>
   <span v-if="row.role === 'system'" class="body-system-title">{{ row.section.title }}</span>
   <small class="inspection-position" :title="t('inspection.position')">#{{ row.position }}</small><span class="grow"></span>
   <button type="button" class="source-toggle" :aria-expanded="sourceOpen" @click="sourceOpen = !sourceOpen">{{ t('inspection.source') }}</button>
   <button type="button" class="context-diff-copy-section" :disabled="!row.text" :title="t('inspection.textCopyNote')" @click="emit('copy', row.text)">{{ t('inspector.copy') }}</button>
  </div>
  <div ref="body" class="readable-body" :class="{ compact: !expanded }"><PreviewSectionBody :section="row.body" @copy="emit('copy', $event)" /></div>
  <button v-if="!full && !searching && (clipped || open)" class="body-expand" type="button" :aria-expanded="open" @click="openBody">{{ t(open ? 'inspection.collapseText' : 'inspection.expandText') }}</button>
  <div v-show="sourceOpen" class="row-source"><span class="section-title">{{ row.section.title }}</span><code>{{ row.scope }}</code><small>{{ row.section.chars }} chars · {{ row.section.approxTokens }} {{ t('inspection.estimatedTokens') }}</small></div>
 </article>
</template>

<style scoped>
.context-diff-section{min-width:0;border-bottom:1px solid var(--line);border-left:2px solid var(--line);background:var(--pane);margin:0}.inspection-body{padding:12px 14px}.role-system{border-left-color:var(--role-system)}.role-user{border-left-color:var(--role-user);background:color-mix(in srgb,var(--role-user) 4%,var(--pane))}.role-assistant{border-left-color:var(--role-assistant);background:color-mix(in srgb,var(--role-assistant) 4%,var(--pane))}.section-role{font-size:10px;font-weight:650;border-radius:3px;padding:1px 5px;color:var(--muted)}.section-role.role-system{color:var(--role-system);background:color-mix(in srgb,var(--role-system) 12%,var(--pane))}.section-role.role-user{color:var(--role-user);background:color-mix(in srgb,var(--role-user) 12%,var(--pane))}.section-role.role-assistant{color:var(--role-assistant);background:color-mix(in srgb,var(--role-assistant) 12%,var(--pane))}.inspection-body-head{display:flex;align-items:center;gap:7px;min-width:0;margin-bottom:6px}.body-system-title{font-size:12px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.grow{flex:1}.inspection-position{font-size:10px;color:var(--muted);white-space:nowrap}.inspection-body-head button{border:0;background:transparent;color:var(--muted);font-size:11px;padding:2px 4px;min-height:24px;white-space:nowrap}.readable-body :deep(.section-text){background:transparent;color:var(--text);font:13px/1.7 system-ui,sans-serif;padding:0;overflow-wrap:anywhere;white-space:pre-wrap}.readable-body.compact :deep(.section-text){display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.role-user .compact :deep(.section-text){-webkit-line-clamp:4}.readable-body :deep(.preview-named-sections){padding:7px 0 0;background:transparent}.body-expand{border:0;padding:3px 0;background:transparent;color:var(--accent);font-size:12px;min-height:25px}.row-source{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:8px 0;font-size:11px;color:var(--muted);overflow-wrap:anywhere}.row-source code{white-space:normal;overflow-wrap:anywhere}.row-source button{font-size:11px;min-height:24px;padding:2px 6px}.row-source .section-title{min-width:0;overflow-wrap:anywhere}.inspection-tool{border-left-color:var(--role-tool-result);background:var(--pane)}.inspection-tool>summary{list-style:none;display:flex;align-items:center;gap:7px;min-width:0;padding:8px 11px;min-height:36px;cursor:pointer;font-size:12px}.inspection-tool>summary::-webkit-details-marker{display:none}.chevron{flex:none;color:var(--muted)}.inspection-tool[open]>summary .chevron{transform:rotate(90deg)}.tool-badge{font-size:9px;font-weight:700;color:var(--role-tool-result);background:color-mix(in srgb,var(--role-tool-result) 10%,var(--pane));padding:1px 4px;border-radius:3px;flex:none}.tool-name{font:600 12px ui-monospace,monospace;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}.tool-snippet{font:12px/1.5 ui-monospace,monospace;white-space:pre;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.result-path{font:11px ui-monospace,monospace;max-width:125px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.tool-return{margin-left:14px}.tool-error{border-left-color:var(--error)}.tool-error .tool-snippet,.inspection-error{color:var(--error)}.inspection-error{font-size:10px;flex:none;white-space:nowrap}.tool-detail{padding:0 12px 10px}.tool-full-text{margin:0;padding:10px;background:var(--pane-soft);font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:320px;border:1px solid var(--line);border-radius:4px}.tool-full-text.unbounded{max-height:none}.capability-location-match{box-shadow:inset 0 0 0 1px var(--accent)}summary:focus-visible,button:focus-visible,pre:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
@container(max-width:520px){.inspection-body{padding:10px}.inspection-tool>summary{gap:5px;padding:8px;min-height:38px}.tool-name{max-width:75px;font-size:11px}.tool-snippet{font-size:11px}.result-path{max-width:70px;font-size:10px}.inspection-position{display:none}.tool-return{margin-left:8px}.inspection-body-head{gap:5px}.body-system-title{font-size:11px}}
</style>
