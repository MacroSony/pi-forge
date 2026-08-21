<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { createEditorApi } from "../api.ts";
import type { EditorPromptStack } from "../types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "../../types.ts";
import type { ContextDiffView } from "../../../context-diff-history.ts";
import {
	diffTurns,
	type DiffBlock,
	type TurnDiff,
} from "../../../context-diff.ts";
import type { LegacyEditorDraft } from "../legacy-editor.ts";
import { previewSections, previewToTurnSnapshot } from "../preview-diff.ts";

const props = defineProps<{
	getStackDraft?: () => LegacyEditorDraft | undefined;
	subscribeStackDraft?: (listener: () => void) => () => void;
	onStatus?: (text: string, tone?: string) => void;
	onExpandedChanged?: (expanded: boolean) => void;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

type DockMode = "compiled" | "draft" | "run";
const mode = ref<DockMode>("compiled");
const preview = ref<WebEditorPreview | null>(null);
const savedPreview = ref<WebEditorPreview | null>(null);
const draftDiff = ref<TurnDiff | null>(null);
const previewError = ref("");
const previewLoading = ref(false);
const previewStatus = ref("");
const contextDiff = ref<ContextDiffView | null>(null);
const contextDiffError = ref("");
const contextDiffLoading = ref(false);
const showUnchanged = ref(false);
const expanded = ref(false);

let previewTimer: number | undefined;
let pollTimer: number | undefined;
let stopDraftSubscription: (() => void) | undefined;
let previewSequence = 0;
let previewAbort: AbortController | undefined;
let contextDiffSequence = 0;
let contextDiffAbort: AbortController | undefined;

const compiledSections = computed<WebEditorPreviewSection[]>(() => previewSections(preview.value));
const latestDiff = computed(() => contextDiff.value?.latestDiff ?? null);
const latestTurn = computed(() => contextDiff.value?.latest?.turn ?? null);
const activeDiff = computed<TurnDiff | null>(() => mode.value === "draft" ? draftDiff.value : latestDiff.value);
const diffBlocks = computed(() => activeDiff.value?.blocks ?? []);
const visibleDiffBlocks = computed(() => showUnchanged.value
	? diffBlocks.value
	: diffBlocks.value.filter((block) => block.status !== "same"));
const hiddenUnchangedCount = computed(() => diffBlocks.value.filter((block) => block.status === "same").length);

const deltaText = computed(() => {
	const delta = activeDiff.value?.deltaTokens ?? 0;
	return `${delta > 0 ? "+" : ""}${delta}`;
});

const deltaClass = computed(() => {
	const delta = activeDiff.value?.deltaTokens ?? 0;
	return delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral";
});

const prefixPercent = computed(() => Math.round((latestDiff.value?.prefixRatio ?? 0) * 100));
const changedBlocks = computed(() => activeDiff.value?.summary.changedBlocks ?? 0);

onMounted(() => {
	stopDraftSubscription = props.subscribeStackDraft?.(schedulePreviewRefresh);
	void refreshPreview();
	void refreshContextDiff();
	pollTimer = window.setInterval(() => {
		void refreshContextDiff();
		schedulePollingPreviewRefresh();
	}, 2000);
});

onUnmounted(() => {
	if (previewTimer !== undefined) window.clearTimeout(previewTimer);
	if (pollTimer !== undefined) window.clearInterval(pollTimer);
	stopDraftSubscription?.();
	invalidatePreviewRequest();
	invalidateContextDiffRequest();
	props.onExpandedChanged?.(false);
});

function toggleExpanded(): void {
	expanded.value = !expanded.value;
	props.onExpandedChanged?.(expanded.value);
}

function schedulePreviewRefresh(): void {
	invalidatePreviewRequest();
	preview.value = null;
	savedPreview.value = null;
	draftDiff.value = null;
	previewLoading.value = true;
	previewStatus.value = "Draft changed; refreshing…";
	schedulePreviewTimer();
}

function schedulePollingPreviewRefresh(): void {
	schedulePreviewTimer();
}

function schedulePreviewTimer(): void {
	if (previewTimer !== undefined) window.clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => {
		previewTimer = undefined;
		void refreshPreview();
	}, 500);
}

function invalidatePreviewRequest(): number {
	const sequence = ++previewSequence;
	previewAbort?.abort();
	previewAbort = undefined;
	previewLoading.value = false;
	return sequence;
}

async function refreshPreview(): Promise<void> {
	const sequence = invalidatePreviewRequest();
	const draft = props.getStackDraft?.();
	if (!draft) {
		preview.value = null;
		savedPreview.value = null;
		draftDiff.value = null;
		previewError.value = "";
		previewStatus.value = "Select a stack to preview.";
		return;
	}
	previewLoading.value = true;
	previewError.value = "";
	previewStatus.value = "";
	const controller = new AbortController();
	previewAbort = controller;
	try {
		const loaded = await api<{ stack: EditorPromptStack }>(`/api/stacks/${encodeURIComponent(draft.selector)}`, {
			signal: controller.signal,
		});
		const previewPath = `/api/stacks/${encodeURIComponent(draft.selector)}/preview`;
		const [draftData, savedData] = await Promise.all([
			api<{ preview?: WebEditorPreview }>(previewPath, {
				method: "POST",
				body: { stack: draft.stack },
				signal: controller.signal,
			}),
			api<{ preview?: WebEditorPreview }>(previewPath, {
				method: "POST",
				body: { stack: loaded.stack },
				signal: controller.signal,
			}),
		]);
		if (sequence !== previewSequence) return;
		preview.value = draftData.preview ?? null;
		savedPreview.value = savedData.preview ?? null;
		draftDiff.value = preview.value && savedPreview.value
			? diffTurns(previewToTurnSnapshot(savedPreview.value, "saved"), previewToTurnSnapshot(preview.value, "draft"))
			: null;
		previewStatus.value = preview.value ? "Compiled draft refreshed." : "Preview returned no structured sections.";
		props.onStatus?.(previewStatus.value, preview.value ? "success" : "warning");
	} catch (error) {
		if (controller.signal.aborted || sequence !== previewSequence) return;
		previewError.value = error instanceof Error ? error.message : String(error);
		props.onStatus?.(previewError.value, "error");
	} finally {
		if (sequence === previewSequence) previewLoading.value = false;
	}
}

async function refreshContextDiff(): Promise<void> {
	const sequence = invalidateContextDiffRequest();
	contextDiffLoading.value = true;
	contextDiffError.value = "";
	const controller = new AbortController();
	contextDiffAbort = controller;
	try {
		const next = await api<ContextDiffView>("/api/context-diff", { signal: controller.signal });
		if (sequence !== contextDiffSequence) return;
		contextDiff.value = next;
	} catch (error) {
		if (controller.signal.aborted || sequence !== contextDiffSequence) return;
		contextDiffError.value = error instanceof Error ? error.message : String(error);
	} finally {
		if (sequence === contextDiffSequence) contextDiffLoading.value = false;
	}
}

function invalidateContextDiffRequest(): number {
	const sequence = ++contextDiffSequence;
	contextDiffAbort?.abort();
	contextDiffAbort = undefined;
	contextDiffLoading.value = false;
	return sequence;
}

function blockKey(block: DiffBlock): string {
	return block.after?.key ?? block.before?.key ?? "";
}

function blockRole(block: DiffBlock): string {
	return block.after?.role ?? block.before?.role ?? "";
}

function blockTokenText(block: DiffBlock): string {
	if (block.status !== "same") {
		const delta = block.tokenDelta;
		return `${delta > 0 ? "+" : ""}${delta}`;
	}
	return `~${block.after?.approxTokens ?? 0}`;
}

function sectionMeta(section: WebEditorPreviewSection): string {
	const role = section.role ? `${section.role} · ` : "";
	return `${role}${section.chars} chars · ~${section.approxTokens} tokens`;
}

function turnLabel(): string {
	const turn = latestTurn.value;
	if (!turn) return "—";
	return turn.turnId.replace(/^turn-/, "");
}
</script>

<template>
	<div class="context-diff-dock">
		<div class="context-diff-mode-tabs" role="tablist" aria-label="Preview dock">
			<button type="button" :class="{ active: mode === 'compiled' }" role="tab" :aria-selected="mode === 'compiled'" @click="mode = 'compiled'">Preview</button>
			<button type="button" :class="{ active: mode === 'draft' }" role="tab" :aria-selected="mode === 'draft'" @click="mode = 'draft'">Draft diff</button>
			<button type="button" :class="{ active: mode === 'run' }" role="tab" :aria-selected="mode === 'run'" @click="mode = 'run'">Run diff</button>
			<button type="button" class="context-diff-expand" :title="expanded ? 'Return to split editor' : 'Use the full editor width'" @click="toggleExpanded">{{ expanded ? "Split" : "Focus" }}</button>
		</div>

		<div v-show="mode === 'compiled'" class="context-diff-compiled" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">Compiled draft</div>
				<div class="context-diff-meta">
					<span v-if="preview">~{{ preview.approxTokens }} tokens · {{ preview.totalChars }} chars</span>
					<span v-else-if="previewLoading">Refreshing…</span>
					<span v-else-if="previewError" class="error">{{ previewError }}</span>
					<span v-else>No preview</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="schedulePreviewRefresh">Refresh</button>
			</div>
			<div v-if="previewError" class="context-diff-error">{{ previewError }}</div>
			<div v-else-if="compiledSections.length === 0" class="context-diff-empty">
				{{ previewLoading ? "Loading preview…" : "Select a stack to see its compiled prompt." }}
			</div>
			<div v-else class="context-diff-sections">
				<details v-for="section in compiledSections" :key="section.id" class="context-diff-section" open>
					<summary>
						<span class="section-title">{{ section.title || section.id }}</span>
						<span class="section-meta">{{ sectionMeta(section) }}</span>
					</summary>
					<pre class="section-text">{{ section.content }}</pre>
				</details>
			</div>
		</div>

		<div v-show="mode === 'draft' || mode === 'run'" class="context-diff-diff" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">{{ mode === "draft" ? "Compiled draft vs saved output" : "Latest run vs previous run" }}</div>
				<div class="context-diff-meta">
					<span v-if="mode === 'draft' && previewLoading">Refreshing…</span>
					<span v-else-if="mode === 'run' && contextDiffLoading">Refreshing…</span>
					<span v-else-if="mode === 'draft' && previewError" class="error">{{ previewError }}</span>
					<span v-else-if="mode === 'run' && contextDiffError" class="error">{{ contextDiffError }}</span>
					<span v-else-if="activeDiff">{{ changedBlocks === 0 ? "No changes" : `${changedBlocks} changed blocks` }}</span>
					<span v-else>{{ mode === "draft" ? "No draft comparison" : "No captured runs" }}</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="mode === 'draft' ? schedulePreviewRefresh() : refreshContextDiff()">Refresh</button>
			</div>
			<div v-if="mode === 'draft' && previewError" class="context-diff-error">{{ previewError }}</div>
			<div v-else-if="mode === 'run' && contextDiffError" class="context-diff-error">{{ contextDiffError }}</div>
			<div v-else-if="!activeDiff" class="context-diff-empty">
				{{ mode === "draft"
					? "Select a saved stack to compare its current draft with disk."
					: "No captured provider turns yet. Send a prompt; recent turns appear here automatically." }}
			</div>
			<template v-else>
				<div class="context-diff-summary">
					<span :class="['summary-delta', deltaClass]">~{{ deltaText }} tokens</span>
					<span>{{ changedBlocks }} changed</span>
					<label v-if="hiddenUnchangedCount" class="unchanged-toggle">
						<input v-model="showUnchanged" type="checkbox">
						Show {{ hiddenUnchangedCount }} unchanged
					</label>
				</div>
				<details v-if="mode === 'run'" class="context-diff-details">
					<summary>Run metadata</summary>
					<div>Turn {{ turnLabel() }} · cache prefix ~{{ latestDiff?.prefixTokens }} tokens ({{ prefixPercent }}%) · approximate token counts</div>
				</details>
				<div v-if="visibleDiffBlocks.length === 0" class="context-diff-empty compact">
					{{ mode === "draft" ? "Draft and saved prompt compile to the same content." : "The latest two runs have the same captured content." }}
				</div>
				<div v-else class="context-diff-blocks">
					<div v-for="(block, index) in visibleDiffBlocks" :key="`${blockKey(block)}-${index}`" :class="['context-diff-block', block.status]">
						<span class="block-gutter"></span>
						<div class="block-content">
							<div class="block-head">
								<span class="block-status">{{ block.status }}</span>
								<span class="block-key">{{ blockKey(block) }}</span>
								<span v-if="blockRole(block)" class="block-role">{{ blockRole(block) }}</span>
								<span class="block-token-chip">{{ blockTokenText(block) }} tokens</span>
							</div>
							<pre v-if="block.status === 'removed'" class="block-text removed">{{ block.before?.text }}</pre>
							<pre v-else-if="block.status === 'added'" class="block-text added">{{ block.after?.text }}</pre>
							<div v-else-if="block.status === 'modified'" class="block-modified-grid">
								<div><div class="block-label before">Before</div><pre class="block-text before">{{ block.before?.text }}</pre></div>
								<div><div class="block-label after">After</div><pre class="block-text after">{{ block.after?.text }}</pre></div>
							</div>
							<pre v-else class="block-text">{{ block.after?.text }}</pre>
						</div>
					</div>
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.context-diff-dock { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.context-diff-mode-tabs { display: flex; gap: 6px; flex: 0 0 auto; }
.context-diff-expand { margin-left: auto; }
.context-diff-mode-tabs button.active { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
.context-diff-panel-head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.context-diff-title { font-weight: 700; }
.context-diff-meta { color: var(--muted); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-diff-meta .error, .context-diff-error { color: var(--error); }
.context-diff-refresh { margin-left: auto; min-height: 28px; font-size: 12px; padding: 2px 8px; }
.context-diff-compiled, .context-diff-diff { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.context-diff-sections, .context-diff-blocks { display: flex; flex-direction: column; gap: 8px; }
.context-diff-section { border: 1px solid var(--line); border-radius: 6px; background: var(--pane); overflow: hidden; }
.context-diff-section summary { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; list-style: none; border-bottom: 1px solid transparent; }
.context-diff-section[open] summary { border-bottom-color: var(--line); }
.section-title { font-weight: 650; }
.section-meta { color: var(--muted); font-size: 12px; }
.section-text, .block-text { margin: 0; padding: 10px; background: var(--code-bg); color: var(--code-text); white-space: pre-wrap; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.context-diff-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--pane); font-weight: 650; }
.summary-delta.positive { color: var(--success); }
.summary-delta.negative { color: var(--error); }
.summary-delta.neutral { color: var(--muted); }
.unchanged-toggle { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.unchanged-toggle input { width: auto; }
.context-diff-details { border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; color: var(--muted); font-size: 12px; background: var(--pane-soft); }
.context-diff-details summary { cursor: pointer; color: var(--text); font-weight: 650; }
.context-diff-details[open] summary { margin-bottom: 6px; }
.context-diff-block { display: grid; grid-template-columns: 4px minmax(0, 1fr); border: 1px solid var(--line); border-radius: 6px; background: var(--pane); overflow: hidden; }
.block-gutter { background: var(--line); }
.context-diff-block.added .block-gutter { background: var(--success); }
.context-diff-block.removed .block-gutter { background: var(--error); }
.context-diff-block.modified .block-gutter { background: var(--warning); }
.block-content { min-width: 0; padding: 9px 10px 10px; }
.block-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 7px; }
.block-status { text-transform: uppercase; font-size: 11px; font-weight: 750; letter-spacing: .03em; }
.context-diff-block.added .block-status { color: var(--success); }
.context-diff-block.removed .block-status { color: var(--error); }
.context-diff-block.modified .block-status { color: var(--warning); }
.block-key { font-weight: 650; }
.block-role { color: var(--muted); font-size: 12px; }
.block-token-chip { margin-left: auto; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 12px; background: var(--control-muted); }
.block-text { border-radius: 4px; }
.block-text.before { border-left: 3px solid var(--error); }
.block-text.after { border-left: 3px solid var(--success); }
.block-modified-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.block-label { margin: 0 0 4px 3px; font-size: 11px; font-weight: 750; text-transform: uppercase; }
.block-label.before { color: var(--error); }
.block-label.after { color: var(--success); }
.context-diff-empty { color: var(--muted); padding: 20px; border: 1px dashed var(--line); border-radius: 6px; }
.context-diff-empty.compact { padding: 12px; }
.context-diff-error { padding: 10px; border: 1px solid var(--error); border-radius: 6px; background: var(--error-bg); }
@media (max-width: 1100px) { .block-modified-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) { .context-diff-expand { display: none; } }
</style>
