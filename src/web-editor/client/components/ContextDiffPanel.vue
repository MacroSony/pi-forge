<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import type { EditorPromptStack, PromptStackDiagnostic } from "../types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "../../types.ts";
import type { ContextDiffView } from "../../../context-diff-history.ts";
import {
	diffTurns,
	type DiffBlock,
	type TurnDiff,
} from "../../../context-diff.ts";
import {
	buildSplitLineRows,
	diffTextLines,
	filterLineRows,
	type LineDiffDisplayRow,
	type LineDiffRow,
	type SplitLineDiffRow,
} from "../../line-diff.ts";
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
const previewText = ref("");
const previewDiagnostics = ref<PromptStackDiagnostic[]>([]);
const draftDiff = ref<TurnDiff | null>(null);
const previewError = ref("");
const previewLoading = ref(false);
const previewStatus = ref("");
const contextDiff = ref<ContextDiffView | null>(null);
const contextDiffError = ref("");
const contextDiffLoading = ref(false);
const showUnchanged = ref(false);
const diffLayout = ref<"unified" | "split">("unified");
const lineContext = ref<"0" | "3" | "all">("3");
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
const latestUsage = computed(() => contextDiff.value?.latest?.usage ?? null);

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
	previewText.value = "";
	previewDiagnostics.value = [];
	draftDiff.value = null;
	previewLoading.value = true;
	previewStatus.value = t("diff.draftChangedRefreshing");
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
		previewText.value = "";
		previewDiagnostics.value = [];
		draftDiff.value = null;
		previewError.value = "";
		previewStatus.value = t("diff.selectStackToPreview");
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
			api<{ text: string; preview?: WebEditorPreview; diagnostics: PromptStackDiagnostic[] }>(previewPath, {
				method: "POST",
				body: { stack: draft.stack },
				signal: controller.signal,
			}),
			api<{ text: string; preview?: WebEditorPreview; diagnostics: PromptStackDiagnostic[] }>(previewPath, {
				method: "POST",
				body: { stack: loaded.stack },
				signal: controller.signal,
			}),
		]);
		if (sequence !== previewSequence) return;
		preview.value = draftData.preview ?? null;
		savedPreview.value = savedData.preview ?? null;
		previewText.value = draftData.text ?? "";
		previewDiagnostics.value = draftData.diagnostics ?? [];
		draftDiff.value = preview.value && savedPreview.value
			? diffTurns(previewToTurnSnapshot(savedPreview.value, "saved"), previewToTurnSnapshot(preview.value, "draft"))
			: null;
		previewStatus.value = preview.value ? t("diff.draftRefreshed") : t("diff.previewNoSections");
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
		return t("diff.blockTokensDelta", { delta: `${delta > 0 ? "+" : ""}${delta}` });
	}
	return t("diff.blockTokens", { count: block.after?.approxTokens ?? 0 });
}

function blockLineRows(block: DiffBlock): LineDiffDisplayRow[] {
	const rows = diffTextLines(block.before?.text ?? "", block.after?.text ?? "");
	const context = block.status === "same" || lineContext.value === "all"
		? null
		: Number(lineContext.value);
	return filterLineRows(rows, context);
}

function blockSplitRows(block: DiffBlock): SplitLineDiffRow[] {
	return buildSplitLineRows(blockLineRows(block));
}

function lineMarker(row: LineDiffRow): string {
	return row.kind === "added" ? "+" : row.kind === "removed" ? "−" : row.kind === "note" ? "\\" : " ";
}

function eofNoteSide(row: LineDiffRow): string {
	return row.noteSide === "before" ? t("diff.before") : t("diff.after");
}

function metadataOnlyChange(block: DiffBlock): boolean {
	return block.status === "modified"
		&& block.before?.text === block.after?.text
		&& block.before?.hash !== block.after?.hash;
}

function metadataChangeText(block: DiffBlock): string {
	const beforeRole = block.before?.role ?? "—";
	const afterRole = block.after?.role ?? "—";
	const roleDetail = beforeRole === afterRole
		? t("diff.roleUnchanged", { role: afterRole })
		: t("diff.roleChanged", { before: beforeRole, after: afterRole });
	return t("diff.metadataChanged", { detail: roleDetail });
}

function formatUsageTokens(value: number | undefined): string {
	return value === undefined ? "—" : value.toLocaleString();
}

function cacheHitText(): string {
	const usage = latestUsage.value;
	if (!usage) return "—";
	if (usage.cacheHitRatio === null) return t("diff.notReported");
	return `${(usage.cacheHitRatio * 100).toFixed(1)}%`;
}

function sectionMeta(section: WebEditorPreviewSection): string {
	const rolePrefix = section.role ? `${section.role} · ` : "";
	return t("diff.sectionMeta", { rolePrefix, chars: section.chars, tokens: section.approxTokens });
}

async function copyPreviewText(text: string): Promise<void> {
	if (!text) return;
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
	} else {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.left = "-9999px";
		document.body.appendChild(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
	props.onStatus?.(t("inspector.copiedText"), "success");
}

function turnLabel(): string {
	const turn = latestTurn.value;
	if (!turn) return "—";
	return turn.turnId.replace(/^turn-/, "");
}
</script>

<template>
	<div class="context-diff-dock">
		<div class="context-diff-mode-tabs" role="tablist" :aria-label="t('diff.dockAria')">
			<button type="button" :class="{ active: mode === 'compiled' }" role="tab" :aria-selected="mode === 'compiled'" @click="mode = 'compiled'">{{ t("tab.preview") }}</button>
			<button type="button" :class="{ active: mode === 'draft' }" role="tab" :aria-selected="mode === 'draft'" @click="mode = 'draft'">{{ t("diff.draftTab") }}</button>
			<button type="button" :class="{ active: mode === 'run' }" role="tab" :aria-selected="mode === 'run'" @click="mode = 'run'">{{ t("diff.runTab") }}</button>
			<button type="button" class="context-diff-expand" :title="expanded ? t('diff.splitTitle') : t('diff.focusTitle')" @click="toggleExpanded">{{ expanded ? t("diff.split") : t("diff.focus") }}</button>
		</div>

		<div v-show="mode === 'compiled'" class="context-diff-compiled" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">{{ t("diff.compiledDraft") }}</div>
				<div class="context-diff-meta">
					<span v-if="preview">{{ t("diff.compiledMeta", { tokens: preview.approxTokens, chars: preview.totalChars }) }}</span>
					<span v-else-if="previewLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="previewError" class="error">{{ previewError }}</span>
					<span v-else>{{ t("diff.noPreview") }}</span>
				</div>
				<button v-if="previewText" type="button" class="context-diff-copy-full" @click="copyPreviewText(previewText)">{{ t("inspector.copyFull") }}</button>
				<button type="button" class="context-diff-refresh" @click="schedulePreviewRefresh">{{ t("profiles.refresh") }}</button>
			</div>
			<div v-if="previewDiagnostics.length" class="context-diff-diagnostics">
				<strong>{{ t("diff.compilerDiagnostics", { count: previewDiagnostics.length }) }}</strong>
				<div v-for="(diagnostic, index) in previewDiagnostics" :key="index" :class="['context-diff-diagnostic', diagnostic.level]">
					{{ diagnostic.level.toUpperCase() }}<template v-if="diagnostic.itemId"> · {{ diagnostic.itemId }}</template>: {{ diagnostic.message }}
				</div>
			</div>
			<div v-if="previewError" class="context-diff-error">{{ previewError }}</div>
			<pre v-else-if="compiledSections.length === 0 && previewText" class="section-text">{{ previewText }}</pre>
			<div v-else-if="compiledSections.length === 0" class="context-diff-empty">
				{{ previewLoading ? t("diff.loadingPreview") : t("diff.selectStackHint") }}
			</div>
			<div v-else class="context-diff-sections">
				<details v-for="section in compiledSections" :key="section.id" class="context-diff-section" open>
					<summary>
						<span class="section-title">{{ section.title || section.id }}</span>
						<span class="section-meta">{{ sectionMeta(section) }}</span>
						<button type="button" class="context-diff-copy-section" @click.prevent.stop="copyPreviewText(section.content)">{{ t("inspector.copy") }}</button>
					</summary>
					<pre class="section-text">{{ section.content }}</pre>
				</details>
			</div>
		</div>

		<div v-show="mode === 'draft' || mode === 'run'" class="context-diff-diff" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">{{ mode === "draft" ? t("diff.draftTitle") : t("diff.runTitle") }}</div>
				<div class="context-diff-meta">
					<span v-if="mode === 'draft' && previewLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="mode === 'run' && contextDiffLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="mode === 'draft' && previewError" class="error">{{ previewError }}</span>
					<span v-else-if="mode === 'run' && contextDiffError" class="error">{{ contextDiffError }}</span>
					<span v-else-if="activeDiff">{{ changedBlocks === 0 ? t("diff.noChanges") : t("diff.changedBlocks", { count: changedBlocks }) }}</span>
					<span v-else>{{ mode === "draft" ? t("diff.noDraftComparison") : t("diff.noCapturedRuns") }}</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="mode === 'draft' ? schedulePreviewRefresh() : refreshContextDiff()">{{ t("profiles.refresh") }}</button>
			</div>
			<div v-if="mode === 'draft' && previewError" class="context-diff-error">{{ previewError }}</div>
			<div v-else-if="mode === 'run' && contextDiffError" class="context-diff-error">{{ contextDiffError }}</div>
			<div v-else-if="!activeDiff" class="context-diff-empty">
				{{ mode === "draft"
					? t("diff.draftEmpty")
					: t("diff.runEmpty") }}
			</div>
			<template v-else>
				<div class="context-diff-summary">
					<span :class="['summary-delta', deltaClass]">{{ t("diff.estimatedDelta", { delta: deltaText }) }}</span>
					<span>{{ t("diff.changed", { count: changedBlocks }) }}</span>
					<div class="diff-view-controls" :aria-label="t('diff.displayOptionsAria')">
						<div class="diff-layout-buttons">
							<button type="button" :class="{ active: diffLayout === 'unified' }" :aria-pressed="diffLayout === 'unified'" @click="diffLayout = 'unified'">{{ t("diff.unified") }}</button>
							<button type="button" :class="{ active: diffLayout === 'split' }" :aria-pressed="diffLayout === 'split'" @click="diffLayout = 'split'">{{ t("diff.split") }}</button>
						</div>
						<label>
							<span>{{ t("diff.lines") }}</span>
							<select v-model="lineContext" :aria-label="t('diff.lineContextAria')">
								<option value="0">{{ t("diff.changesOnly") }}</option>
								<option value="3">{{ t("diff.threeLinesContext") }}</option>
								<option value="all">{{ t("diff.allLines") }}</option>
							</select>
						</label>
					</div>
					<label v-if="hiddenUnchangedCount" class="unchanged-toggle">
						<input v-model="showUnchanged" type="checkbox">
						{{ t("diff.showUnchanged", { count: hiddenUnchangedCount }) }}
					</label>
				</div>
				<details v-if="mode === 'run'" class="context-diff-details">
					<summary>{{ t("diff.runMetadata") }}</summary>
					<div class="run-metadata-grid">
						<span>{{ t("diff.turn") }}</span><strong>{{ turnLabel() }}</strong>
						<span>{{ t("diff.providerModel") }}</span><strong>{{ latestUsage ? `${latestUsage.provider}/${latestUsage.model}` : t("diff.usagePending") }}</strong>
						<span>{{ t("diff.actualPromptTokens") }}</span><strong>{{ formatUsageTokens(latestUsage?.promptTokens) }}</strong>
						<span>{{ t("diff.actualCacheReadWrite") }}</span><strong>{{ formatUsageTokens(latestUsage?.cacheRead) }} / {{ formatUsageTokens(latestUsage?.cacheWrite) }}</strong>
						<span>{{ t("diff.actualCacheHitRate") }}</span><strong>{{ cacheHitText() }}</strong>
						<span>{{ t("diff.actualUncached") }}</span><strong>{{ formatUsageTokens(latestUsage?.input) }} / {{ formatUsageTokens(latestUsage?.output) }}</strong>
						<span>{{ t("diff.estimatedPrefix") }}</span><strong>{{ t("diff.prefixValue", { tokens: latestDiff?.prefixTokens ?? 0, percent: prefixPercent }) }}</strong>
					</div>
					<p v-if="latestUsage?.cacheStatus === 'not-reported'" class="metadata-note">{{ t("diff.cacheNotReportedNote") }}</p>
					<p class="metadata-note">{{ t("diff.estimateNote") }}</p>
				</details>
				<div v-if="visibleDiffBlocks.length === 0" class="context-diff-empty compact">
					{{ mode === "draft" ? t("diff.draftSame") : t("diff.runSame") }}
				</div>
				<div v-else class="context-diff-blocks">
					<div v-for="(block, index) in visibleDiffBlocks" :key="`${blockKey(block)}-${index}`" :class="['context-diff-block', block.status]">
						<span class="block-gutter"></span>
						<div class="block-content">
							<div class="block-head">
								<span class="block-status">{{ block.status }}</span>
								<span class="block-key">{{ blockKey(block) }}</span>
								<span v-if="blockRole(block)" class="block-role">{{ blockRole(block) }}</span>
								<span class="block-token-chip">{{ blockTokenText(block) }}</span>
							</div>
							<div v-if="metadataOnlyChange(block)" class="metadata-only-change">{{ metadataChangeText(block) }}</div>
							<div v-else-if="diffLayout === 'unified'" class="git-diff unified" role="table" :aria-label="t('diff.unifiedAria')">
								<template v-for="(row, rowIndex) in blockLineRows(block)" :key="rowIndex">
									<div v-if="row.kind === 'separator'" class="git-line-separator" role="row">⋯</div>
									<div v-else :class="['git-line', row.kind]" role="row">
										<span class="line-number old">{{ row.beforeLine ?? "" }}</span>
										<span class="line-number new">{{ row.afterLine ?? "" }}</span>
										<span class="line-marker">{{ lineMarker(row) }}</span>
										<code><span v-if="row.kind === 'note'" class="note-side">{{ eofNoteSide(row) }} · </span><template v-for="(part, partIndex) in row.parts" :key="partIndex"><mark v-if="part.changed && row.kind !== 'same'">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></code>
									</div>
								</template>
							</div>
							<div v-else class="git-diff split" role="table" :aria-label="t('diff.splitAria')">
								<div class="split-header"><span>{{ t("diff.before") }}</span><span>{{ t("diff.after") }}</span></div>
								<template v-for="(row, rowIndex) in blockSplitRows(block)" :key="rowIndex">
									<div v-if="row.kind === 'separator'" class="git-line-separator split-separator" role="row">⋯</div>
									<div v-else class="split-line" role="row">
										<div :class="['git-line', row.before?.kind ?? 'blank']">
											<span class="line-number">{{ row.before?.beforeLine ?? "" }}</span>
											<span class="line-marker">{{ row.before ? lineMarker(row.before) : "" }}</span>
											<code><template v-for="(part, partIndex) in row.before?.parts ?? []" :key="partIndex"><mark v-if="part.changed && row.before?.kind !== 'same'">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></code>
										</div>
										<div :class="['git-line', row.after?.kind ?? 'blank']">
											<span class="line-number">{{ row.after?.afterLine ?? "" }}</span>
											<span class="line-marker">{{ row.after ? lineMarker(row.after) : "" }}</span>
											<code><template v-for="(part, partIndex) in row.after?.parts ?? []" :key="partIndex"><mark v-if="part.changed && row.after?.kind !== 'same'">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></code>
										</div>
									</div>
								</template>
							</div>
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
.context-diff-copy-full, .context-diff-copy-section { min-height: 28px; font-size: 12px; padding: 2px 8px; }
.context-diff-copy-section { margin-left: auto; }
.context-diff-diagnostics { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--pane); font-size: 12px; }
.context-diff-diagnostic.error { color: var(--error); }
.context-diff-diagnostic.warning { color: var(--warning); }
.context-diff-diagnostic.info { color: var(--muted); }
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
.diff-view-controls { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.diff-view-controls label { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; font-weight: 500; }
.diff-view-controls select { width: auto; min-height: 26px; padding: 2px 24px 2px 7px; font-size: 11px; }
.diff-layout-buttons { display: inline-flex; }
.diff-layout-buttons button { min-height: 26px; padding: 2px 7px; border-radius: 0; font-size: 11px; }
.diff-layout-buttons button:first-child { border-radius: 4px 0 0 4px; }
.diff-layout-buttons button:last-child { margin-left: -1px; border-radius: 0 4px 4px 0; }
.diff-layout-buttons button.active { position: relative; border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
.unchanged-toggle { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.unchanged-toggle input { width: auto; }
.context-diff-details { border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; color: var(--muted); font-size: 12px; background: var(--pane-soft); }
.context-diff-details summary { cursor: pointer; color: var(--text); font-weight: 650; }
.context-diff-details[open] summary { margin-bottom: 6px; }
.run-metadata-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; }
.run-metadata-grid strong { color: var(--text); overflow-wrap: anywhere; }
.metadata-note { margin: 7px 0 0; line-height: 1.4; }
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
.metadata-only-change { padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--line)); border-radius: 4px; background: color-mix(in srgb, var(--warning) 10%, var(--pane)); color: var(--text); font-size: 12px; line-height: 1.45; }
.git-diff { overflow: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--code-bg); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.git-line { min-width: max-content; color: var(--code-text); }
.git-diff.unified .git-line { display: grid; grid-template-columns: 44px 44px 20px minmax(max-content, 1fr); }
.git-line.added { background: color-mix(in srgb, var(--success) 12%, var(--code-bg)); }
.git-line.removed { background: color-mix(in srgb, var(--error) 12%, var(--code-bg)); }
.git-line.blank { min-height: 19px; background: var(--pane-soft); }
.git-line code { display: block; min-height: 1.55em; padding: 0 8px; white-space: pre; }
.git-line mark { border-radius: 2px; background: color-mix(in srgb, currentColor 22%, transparent); color: inherit; font: inherit; }
.line-number { padding: 0 7px; border-right: 1px solid var(--line); color: var(--muted); text-align: right; user-select: none; }
.line-marker { text-align: center; user-select: none; }
.git-line.added .line-marker { color: var(--success); }
.git-line.removed .line-marker { color: var(--error); }
.git-line.note { color: var(--muted); font-style: italic; }
.note-side { color: var(--text); font-style: normal; font-weight: 650; }
.git-line-separator { min-width: max-content; padding: 1px 12px; border-block: 1px solid var(--line); background: var(--accent-bg); color: var(--muted); text-align: center; }
.split-header { position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 720px; border-bottom: 1px solid var(--line); background: var(--pane); color: var(--muted); font: 600 11px/1.8 system-ui, sans-serif; text-transform: uppercase; }
.split-header span { padding-left: 52px; }
.split-header span + span { border-left: 1px solid var(--line); }
.split-line { display: grid; grid-template-columns: repeat(2, minmax(360px, 1fr)); min-width: 720px; }
.split-line > .git-line { display: grid; grid-template-columns: 44px 20px minmax(max-content, 1fr); }
.split-line > .git-line + .git-line { border-left: 1px solid var(--line); }
.split-separator { min-width: 720px; }
.context-diff-empty { color: var(--muted); padding: 20px; border: 1px dashed var(--line); border-radius: 6px; }
.context-diff-empty.compact { padding: 12px; }
.context-diff-error { padding: 10px; border: 1px solid var(--error); border-radius: 6px; background: var(--error-bg); }
@media (max-width: 1100px) { .diff-view-controls { order: 3; margin-left: 0; width: 100%; } }
@media (max-width: 900px) { .context-diff-expand { display: none; } }
</style>
