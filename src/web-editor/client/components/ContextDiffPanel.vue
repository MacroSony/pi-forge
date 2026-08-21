<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
import type { EditorPromptStack } from "../types.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "../../types.ts";
import type { ContextDiffView } from "../../../context-diff-history.ts";
import type { DiffBlock } from "../../../context-diff.ts";

const props = defineProps<{
	getStackId?: () => string | undefined;
	onStatus?: (text: string, tone?: string) => void;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

type DockMode = "compiled" | "diff";
const mode = ref<DockMode>("compiled");
const preview = ref<WebEditorPreview | null>(null);
const previewError = ref("");
const previewLoading = ref(false);
const previewStatus = ref("");
const contextDiff = ref<ContextDiffView | null>(null);
const contextDiffError = ref("");
const contextDiffLoading = ref(false);

let previewTimer: number | undefined;
let pollTimer: number | undefined;

const currentStackId = computed(() => props.getStackId?.() ?? "");

const previewSections = computed<WebEditorPreviewSection[]>(() => {
	if (!preview.value) return [];
	return [preview.value.system, ...(preview.value.messages || [])];
});

const latestDiff = computed(() => contextDiff.value?.latestDiff ?? null);
const latestTurn = computed(() => contextDiff.value?.latest?.turn ?? null);
const diffBlocks = computed(() => latestDiff.value?.blocks ?? []);

const boundaryIndex = computed(() => {
	const blocks = diffBlocks.value;
	const index = blocks.findIndex((block) => block.status !== "same");
	return index === -1 ? blocks.length : index;
});

const deltaText = computed(() => {
	const delta = latestDiff.value?.deltaTokens ?? 0;
	return `${delta > 0 ? "+" : ""}${delta}`;
});

const deltaClass = computed(() => {
	const delta = latestDiff.value?.deltaTokens ?? 0;
	return delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral";
});

const prefixPercent = computed(() => Math.round((latestDiff.value?.prefixRatio ?? 0) * 100));
const changedBlocks = computed(() => latestDiff.value?.summary.changedBlocks ?? 0);

watch(currentStackId, () => schedulePreviewRefresh());

onMounted(() => {
	void refreshPreview();
	void refreshContextDiff();
	pollTimer = window.setInterval(() => {
		void refreshContextDiff();
		schedulePreviewRefresh();
	}, 2000);
});

onUnmounted(() => {
	if (previewTimer !== undefined) window.clearTimeout(previewTimer);
	if (pollTimer !== undefined) window.clearInterval(pollTimer);
});

function schedulePreviewRefresh(): void {
	if (previewTimer !== undefined) window.clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => {
		previewTimer = undefined;
		void refreshPreview();
	}, 500);
}

async function refreshPreview(): Promise<void> {
	const stackId = props.getStackId?.();
	if (!stackId) {
		preview.value = null;
		previewError.value = "";
		previewStatus.value = "Select a stack to preview.";
		return;
	}
	previewLoading.value = true;
	previewError.value = "";
	previewStatus.value = "";
	try {
		const loaded = await api<{ stack: EditorPromptStack }>(`/api/stacks/${encodeURIComponent(stackId)}`);
		const data = await api<{ preview?: WebEditorPreview }>(
			`/api/stacks/${encodeURIComponent(stackId)}/preview`,
			{ method: "POST", body: { stack: loaded.stack } },
		);
		preview.value = data.preview ?? null;
		previewStatus.value = data.preview ? "Compiled preview refreshed." : "Preview returned no structured sections.";
		props.onStatus?.(previewStatus.value, data.preview ? "success" : "warning");
	} catch (error) {
		previewError.value = error instanceof Error ? error.message : String(error);
		props.onStatus?.(previewError.value, "error");
	} finally {
		previewLoading.value = false;
	}
}

async function refreshContextDiff(): Promise<void> {
	contextDiffLoading.value = true;
	contextDiffError.value = "";
	try {
		contextDiff.value = await api<ContextDiffView>("/api/context-diff");
	} catch (error) {
		contextDiffError.value = error instanceof Error ? error.message : String(error);
	} finally {
		contextDiffLoading.value = false;
	}
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
		return `${delta >= 0 ? "+" : "-"}~${Math.abs(delta)}`;
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
			<button
				type="button"
				:class="{ active: mode === 'compiled' }"
				role="tab"
				:aria-selected="mode === 'compiled'"
				@click="mode = 'compiled'"
			>Compiled</button>
			<button
				type="button"
				:class="{ active: mode === 'diff' }"
				role="tab"
				:aria-selected="mode === 'diff'"
				@click="mode = 'diff'"
			>Diff</button>
		</div>

		<div v-show="mode === 'compiled'" class="context-diff-compiled" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">Compiled preview</div>
				<div class="context-diff-meta">
					<span v-if="preview">~{{ preview.approxTokens }} tokens · {{ preview.totalChars }} chars</span>
					<span v-else-if="previewLoading">Refreshing…</span>
					<span v-else-if="previewError" class="error">{{ previewError }}</span>
					<span v-else>No preview</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="schedulePreviewRefresh">Refresh</button>
			</div>
			<div v-if="previewError" class="context-diff-error">{{ previewError }}</div>
			<div v-else-if="previewSections.length === 0" class="context-diff-empty">
				{{ previewLoading ? "Loading preview…" : "Select a stack to see its compiled prompt." }}
			</div>
			<div v-else class="context-diff-sections">
				<details v-for="section in previewSections" :key="section.id" class="context-diff-section" open>
					<summary>
						<span class="section-title">{{ section.title || section.id }}</span>
						<span class="section-meta">{{ sectionMeta(section) }}</span>
					</summary>
					<pre class="section-text">{{ section.content }}</pre>
				</details>
			</div>
		</div>

		<div v-show="mode === 'diff'" class="context-diff-diff" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-title">Context diff</div>
				<div class="context-diff-meta">
					<span v-if="contextDiffLoading">Refreshing…</span>
					<span v-else-if="contextDiffError" class="error">{{ contextDiffError }}</span>
					<span v-else-if="latestDiff">Approx token deltas</span>
					<span v-else>No captured turns yet</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="refreshContextDiff">Refresh</button>
			</div>
			<div v-if="contextDiffError" class="context-diff-error">{{ contextDiffError }}</div>
			<div v-else-if="!latestDiff" class="context-diff-empty">
				No captured provider turns yet. Send a prompt to capture the next provider request; recent turns appear here automatically.
			</div>
			<template v-else>
				<div class="context-diff-summary">
					<span class="summary-turn">Turn {{ turnLabel() }}</span>
					<span :class="['summary-delta', deltaClass]">~{{ deltaText }} tokens vs previous</span>
					<span>cache boundary ~{{ prefixPercent }}%</span>
					<span>{{ changedBlocks }} blocks changed</span>
					<span class="approx-note">≈ token estimates</span>
				</div>
				<div class="context-diff-blocks">
					<template v-for="(block, index) in diffBlocks" :key="index">
						<div v-if="index === boundaryIndex" class="context-diff-boundary">
							<span>✂ cache boundary — ~{{ latestDiff.prefixTokens }} approx tokens (~{{ prefixPercent }}%)</span>
						</div>
						<div :class="['context-diff-block', block.status]">
							<span class="block-gutter"></span>
							<div class="block-content">
								<div class="block-head">
									<span class="block-status">{{ block.status }}</span>
									<span class="block-key">{{ blockKey(block) }}</span>
									<span class="block-role">{{ blockRole(block) }}</span>
									<span class="block-token-chip">{{ blockTokenText(block) }} tokens</span>
								</div>
								<pre v-if="block.status === 'removed'" class="block-text removed">{{ block.before?.text }}</pre>
								<pre v-else-if="block.status === 'added'" class="block-text added">{{ block.after?.text }}</pre>
								<template v-else-if="block.status === 'modified'">
									<pre class="block-text before"><span class="block-label">before</span>{{ block.before?.text }}</pre>
									<pre class="block-text after"><span class="block-label">after</span>{{ block.after?.text }}</pre>
								</template>
								<pre v-else class="block-text">{{ block.after?.text }}</pre>
							</div>
						</div>
					</template>
					<div v-if="diffBlocks.length > 0 && boundaryIndex === diffBlocks.length" class="context-diff-boundary">
						<span>✂ cache boundary — full prompt ~{{ latestDiff.prefixTokens }} approx tokens (~{{ prefixPercent }}%)</span>
					</div>
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.context-diff-dock {
	height: 100%;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.context-diff-mode-tabs {
	display: flex;
	gap: 6px;
	flex: 0 0 auto;
}
.context-diff-mode-tabs button.active {
	border-color: var(--accent);
	background: var(--accent-bg);
	color: var(--accent);
}
.context-diff-panel-head {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 0 0 auto;
}
.context-diff-title {
	font-weight: 700;
}
.context-diff-meta {
	color: var(--muted);
	font-size: 12px;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.context-diff-meta .error,
.context-diff-error {
	color: var(--error);
}
.context-diff-refresh {
	margin-left: auto;
	min-height: 28px;
	font-size: 12px;
	padding: 2px 8px;
}
.context-diff-compiled,
.context-diff-diff {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
	overflow: auto;
}
.context-diff-sections {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.context-diff-section {
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane);
	overflow: hidden;
}
.context-diff-section summary {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	cursor: pointer;
	list-style: none;
	border-bottom: 1px solid transparent;
}
.context-diff-section[open] summary {
	border-bottom-color: var(--line);
}
.section-title {
	font-weight: 650;
}
.section-meta {
	color: var(--muted);
	font-size: 12px;
}
.section-text {
	margin: 0;
	padding: 10px;
	background: var(--code-bg);
	color: var(--code-text);
	white-space: pre-wrap;
	overflow: auto;
	font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.context-diff-summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 14px;
	padding: 10px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane);
	font-weight: 650;
}
.summary-turn {
	color: var(--text);
}
.summary-delta.positive {
	color: var(--success);
}
.summary-delta.negative {
	color: var(--error);
}
.summary-delta.neutral {
	color: var(--muted);
}
.approx-note {
	font-weight: 400;
	color: var(--muted);
	font-size: 12px;
}
.context-diff-blocks {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.context-diff-block {
	display: grid;
	grid-template-columns: 4px minmax(0, 1fr);
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane);
	overflow: hidden;
}
.context-diff-block.same {
	border-left-color: transparent;
}
.context-diff-block.added {
	border-left-color: var(--success);
}
.context-diff-block.removed {
	border-left-color: var(--error);
}
.context-diff-block.modified {
	border-left-color: var(--warning);
}
.block-gutter {
	background: transparent;
}
.context-diff-block.added .block-gutter {
	background: var(--success);
}
.context-diff-block.removed .block-gutter {
	background: var(--error);
}
.context-diff-block.modified .block-gutter {
	background: var(--warning);
}
.context-diff-block.same .block-gutter {
	background: var(--line);
}
.block-content {
	min-width: 0;
	padding: 8px 10px;
}
.block-head {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px 10px;
	margin-bottom: 4px;
}
.block-status {
	text-transform: uppercase;
	font-size: 11px;
	font-weight: 750;
	letter-spacing: .03em;
}
.context-diff-block.added .block-status,
.context-diff-block.modified .block-status {
	color: var(--success);
}
.context-diff-block.removed .block-status {
	color: var(--error);
}
.context-diff-block.modified .block-status {
	color: var(--warning);
}
.block-key {
	font-weight: 650;
}
.block-role {
	color: var(--muted);
	font-size: 12px;
}
.block-token-chip {
	border: 1px solid var(--line);
	border-radius: 999px;
	padding: 1px 8px;
	font-size: 12px;
	background: var(--control-muted);
}
.block-text {
	margin: 4px 0 0;
	padding: 8px;
	background: var(--code-bg);
	color: var(--code-text);
	white-space: pre-wrap;
	overflow: auto;
	font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	border-radius: 4px;
}
.block-text.before {
	border-left: 3px solid var(--error);
}
.block-text.after {
	border-left: 3px solid var(--success);
}
.block-label {
	display: block;
	font-size: 11px;
	color: var(--muted);
	margin-bottom: 4px;
	text-transform: uppercase;
}
.context-diff-boundary {
	border: 1px dashed var(--warning);
	background: var(--warning-bg);
	color: var(--warning);
	border-radius: 6px;
	padding: 6px 10px;
	font-size: 12px;
	font-weight: 650;
}
.context-diff-empty {
	color: var(--muted);
	padding: 20px;
	border: 1px dashed var(--line);
	border-radius: 6px;
}
.context-diff-error {
	padding: 10px;
	border: 1px solid var(--error);
	border-radius: 6px;
	background: var(--error-bg);
}
</style>
