<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import type { EditorPromptStack, PromptStackDiagnostic } from "../types.ts";
import type { WebEditorSessionPreview, WebEditorPreview, WebEditorPreviewSection } from "../../types.ts";
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
import PreviewInspector from "./PreviewInspector.vue";

export type ReadingState = "side" | "wide" | "focus";
export type DockMode = "compiled" | "session" | "draft" | "run";
export interface CapabilityLocation {
	activationIds: string[];
	presetRevision?: string;
	guard: import("../../../capability-state.ts").CapabilityStateGuard;
}

const props = defineProps<{
	sessionOnly?: boolean;
	active?: boolean;
	observedState?: import("../../../capability-state.ts").CapabilityStateView | null;
	getStackDraft?: () => LegacyEditorDraft | undefined;
	subscribeStackDraft?: (listener: () => void) => () => void;
	onStatus?: (text: string, tone?: string) => void;
	onExpandedChanged?: (expanded: boolean) => void;
	onReadingChanged?: (mode: ReadingState) => void;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const mode = ref<DockMode>(props.sessionOnly ? "session" : "compiled");
// Layout belongs to the panel, not its content tab. Switching inspection
// content must never move the editor or implicitly enter focused reading.
const readingState = ref<ReadingState>("side");
const lastNonFocus = ref<"side" | "wide">("side");

function notifyReading(state: ReadingState): void {
	props.onReadingChanged?.(state);
	props.onExpandedChanged?.(state === "focus");
}

function setReadingState(state: ReadingState): void {
	if (state !== "focus") lastNonFocus.value = state;
	readingState.value = state;
	notifyReading(state);
}

function handlePrimaryBoundaryClick(): void {
	if (readingState.value === "side") {
		setReadingState("wide");
	} else if (readingState.value === "wide") {
		setReadingState("side");
	} else {
		exitFocus();
	}
}

function enterFocus(): void {
	setReadingState("focus");
}

function exitFocus(): void {
	const fallback = lastNonFocus.value;
	setReadingState(fallback);
}

function setMode(newMode: DockMode): void {
	invalidateSessionRequest();
	locationIds.value = [];
	mode.value = newMode;
}

function returnToEditing(): void {
	if (readingState.value === "focus") {
		exitFocus();
	} else {
		setReadingState("side");
	}
}

// Editor navigation asks this owner to reveal the editor; the host does not
// manufacture a second reading state or reset the selected inspection tab.
function revealEditor(): void {
	if (readingState.value === "focus") exitFocus();
}
defineExpose({ revealEditor, locateCapability });

const primaryBoundaryTitle = computed(() => {
	switch (readingState.value) {
		case "side":
			return t("polish.inspector.widen");
		case "wide":
			return t("polish.inspector.shrink");
		case "focus":
			return t("polish.inspector.restore");
	}
});

const primaryBoundaryAria = computed(() => {
	switch (readingState.value) {
		case "side":
			return t("polish.inspector.sideAria");
		case "wide":
			return t("polish.inspector.wideShrinkAria");
		case "focus":
			return t("polish.inspector.focusAria");
	}
});

const currentTitle = computed(() => {
	switch (mode.value) {
		case "session":
			return t("sessionCapabilities.sessionContext");
		case "compiled":
			return t("diff.compiledDraft");
		case "draft":
			return t("diff.draftTitle");
		case "run":
			return t("diff.runTitle");
	}
});

const currentScopeBadge = computed(() => {
	switch (mode.value) {
		case "session":
			return t("sessionCapabilities.sessionScope");
		case "compiled":
			return t("polish.inspector.draftScope");
		case "draft":
			return t("polish.inspector.draftDiffScope");
		case "run":
			return t("polish.inspector.runDiffScope");
	}
});

const preview = ref<WebEditorPreview | null>(null);
const savedPreview = ref<WebEditorPreview | null>(null);
const previewText = ref("");
const previewDiagnostics = ref<PromptStackDiagnostic[]>([]);
const draftDiff = ref<TurnDiff | null>(null);
const previewError = ref("");
const previewLoading = ref(false);
const previewStale = ref(false);
let previewSelector: string | undefined;
const previewStatus = ref("");
const contextDiff = ref<ContextDiffView | null>(null);
const contextDiffError = ref("");
const contextDiffLoading = ref(false);
const showUnchanged = ref(false);
const diffLayout = ref<"unified" | "split">("unified");
const lineContext = ref<"0" | "3" | "all">("3");

let previewTimer: number | undefined;
let pollTimer: number | undefined;
let stopDraftSubscription: (() => void) | undefined;
let previewSequence = 0;
let previewAbort: AbortController | undefined;
let contextDiffSequence = 0;
let contextDiffAbort: AbortController | undefined;

const sessionPreview = ref<WebEditorSessionPreview | null>(null);
const sessionLoading = ref(false);
const sessionError = ref("");
const locationIds = ref<string[]>([]);
const rootElement = ref<HTMLElement | null>(null);
let sessionSequence = 0;
let sessionAbort: AbortController | undefined;
const displayPreview = computed(() => mode.value === "session"
	? sessionPreview.value ? { ...sessionPreview.value.preview, selectedTools: sessionPreview.value.state.effectiveTools } : null
	: preview.value);
const displayText = computed(() => mode.value === "session" ? sessionPreview.value?.text ?? "" : previewText.value);
const displayDiagnostics = computed(() => mode.value === "session" ? sessionPreview.value?.diagnostics ?? [] : previewDiagnostics.value);
const displayLoading = computed(() => mode.value === "session" ? sessionLoading.value : previewLoading.value);
const displayError = computed(() => mode.value === "session" ? sessionError.value : previewError.value);
const compiledSections = computed<WebEditorPreviewSection[]>(() => previewSections(displayPreview.value));
const matchingSections = computed(() => compiledSections.value.filter(matchesLocation));
function matchesLocation(section: WebEditorPreviewSection): boolean {
	return mode.value === "session" && !!section.capabilityUpdate?.activationIds.some(id => locationIds.value.includes(id));
}
function sameGuard(a: CapabilityLocation["guard"], b: CapabilityLocation["guard"]): boolean {
	return a.sessionId === b.sessionId && a.leafId === b.leafId && a.revision === b.revision;
}
function invalidateSessionRequest(): number {
	sessionAbort?.abort();
	sessionAbort = undefined;
	sessionLoading.value = false;
	return ++sessionSequence;
}
async function refreshSessionPreview(expected?: CapabilityLocation): Promise<void> {
	if (mode.value !== "session" || props.active === false || !props.observedState?.trusted || props.observedState.restoring) return;
	const sequence = invalidateSessionRequest();
	const controller = new AbortController();
	sessionAbort = controller;
	sessionLoading.value = true;
	sessionError.value = "";
	// Keep a clearly marked previous projection during same-branch updates.
	// Boundary changes are cleared by the state watcher before starting this read.
	try {
		const next = await api<WebEditorSessionPreview>("/api/capability-state/preview", { signal: controller.signal });
		if (sequence !== sessionSequence) return;
		const observed = props.observedState;
		if (!observed || !sameGuard(observed.guard, next.state.guard) || observed.presetRevision !== next.state.presetRevision || observed.textPresentation !== next.state.textPresentation) throw new Error(t("sessionCapabilities.locationChanged"));
		if (expected && (!sameGuard(expected.guard, next.state.guard) || expected.presetRevision !== next.state.presetRevision)) throw new Error(t("sessionCapabilities.locationChanged"));
		const pane = rootElement.value?.querySelector<HTMLElement>(".context-diff-compiled");
		const scrollTop = pane?.scrollTop ?? 0;
		sessionPreview.value = next;
		await nextTick();
		if (sequence === sessionSequence && pane) pane.scrollTop = scrollTop;
	} catch (error) {
		if (controller.signal.aborted || sequence !== sessionSequence) return;
		sessionPreview.value = null;
		sessionError.value = error instanceof Error ? error.message : String(error);
	} finally {
		if (sequence === sessionSequence) sessionLoading.value = false;
	}
}

// The Session controls remain the single owner of periodic status reads.
// Only semantic changes (not each new response object) recompile this view.
const observedRevision = computed(() => {
	const state = props.observedState;
	return state ? JSON.stringify([state.guard, state.presetRevision, state.textPresentation, state.trusted, state.restoring]) : null;
});
watch([() => props.active, observedRevision], () => {
	if (!props.sessionOnly) return;
	const state = props.observedState;
	const previous = sessionPreview.value?.state;
	if (!state?.trusted || state.restoring || (previous && (previous.guard.sessionId !== state.guard.sessionId || previous.guard.leafId !== state.guard.leafId))) {
		invalidateSessionRequest();
		sessionPreview.value = null;
		locationIds.value = [];
	}
	if (props.active === false) { invalidateSessionRequest(); return; }
	if (!state?.trusted || state.restoring) { sessionError.value = t("sessionCapabilities.unavailable"); return; }
	if (!previous || !sameGuard(previous.guard, state.guard) || previous.presetRevision !== state.presetRevision || previous.textPresentation !== state.textPresentation || sessionError.value) {
		void refreshSessionPreview();
	}
});

async function locateCapability(target: CapabilityLocation): Promise<void> {
	mode.value = "session";
	locationIds.value = [...target.activationIds];
	const request = refreshSessionPreview(target);
	const sequence = sessionSequence;
	await request;
	if (sequence !== sessionSequence || mode.value !== "session" || !sessionPreview.value) return;
	await nextTick();
	await inspector.value?.openSections(matchingSections.value.map(section => section.id));
	// Scroll the inspector only. Never focus/resize it, scroll the whole page, or
	// change the resource selection/caret in the editor.
	const pane = rootElement.value?.querySelector<HTMLElement>(".context-diff-compiled");
	const block = pane?.querySelectorAll<HTMLElement>(".capability-location-match").item(matchingSections.value.length - 1);
	if (pane && block) {
		let parent = block.parentElement;
		while (parent && parent !== pane) {
			if (parent instanceof HTMLDetailsElement) parent.open = true;
			parent = parent.parentElement;
		}
		pane.scrollTop += block.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
	}
}
function refreshVisiblePreview(): void {
	if (mode.value === "session") void refreshSessionPreview();
	else void refreshPreview();
}

const inspector = ref<InstanceType<typeof PreviewInspector> | null>(null);
const inspectorBoundary = computed(() => JSON.stringify(mode.value === "session"
 ? ["session", sessionPreview.value?.state.guard.sessionId, sessionPreview.value?.state.guard.leafId]
 : ["compiled", displayPreview.value?.stackId, props.getStackDraft?.()?.selector]));

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
	if (props.sessionOnly) {
		void refreshSessionPreview();
		return;
	}
	stopDraftSubscription = props.subscribeStackDraft?.(schedulePreviewRefresh);
	notifyReading(readingState.value);
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
	invalidateSessionRequest();
	invalidatePreviewRequest();
	invalidateContextDiffRequest();
	props.onExpandedChanged?.(false);
});

function schedulePreviewRefresh(): void {
	invalidatePreviewRequest();
	const samePreset = !!preview.value && props.getStackDraft?.()?.selector === previewSelector;
	previewStale.value = samePreset;
	// Keep the state owner only within the same resource. Mark its previous
	// projection pending/inert; never present it as the newly edited draft.
	if (!samePreset) {
		preview.value = null;
		previewText.value = "";
		previewDiagnostics.value = [];
	}
	savedPreview.value = null;
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
		previewSelector = undefined;
		previewStale.value = false;
		preview.value = null;
		savedPreview.value = null;
		previewText.value = "";
		previewDiagnostics.value = [];
		draftDiff.value = null;
		previewError.value = "";
		previewStatus.value = t("diff.selectStackToPreview");
		return;
	}
	if (previewSelector !== draft.selector) {
		preview.value = null;
		previewText.value = "";
		previewDiagnostics.value = [];
		previewStale.value = false;
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
		previewSelector = draft.selector;
		previewStale.value = false;
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
	const draft = mode.value !== "run";
	const roleDetail = beforeRole === afterRole
		? t(draft ? "diff.previewRoleUnchanged" : "diff.roleUnchanged", { role: afterRole })
		: t("diff.roleChanged", { before: beforeRole, after: afterRole });
	return t(draft ? "diff.previewMetadataChanged" : "diff.metadataChanged", { detail: roleDetail });
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

async function copyPreviewText(text: string): Promise<void> {
 if (!text) return;
 try {
  if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
  else {
   const area = document.createElement("textarea");
   const focused = document.activeElement as HTMLElement | null;
   area.value = text; area.style.position = "fixed"; area.style.left = "-9999px";
   document.body.appendChild(area);
   try { area.select(); if (!document.execCommand("copy")) throw new Error("Clipboard unavailable"); }
   finally { area.remove(); focused?.focus({ preventScroll: true }); }
  }
  props.onStatus?.(t("inspector.copiedText"), "success");
 } catch { props.onStatus?.(t("inspection.copyFailed"), "error"); }
}

function turnLabel(): string {
	const turn = latestTurn.value;
	if (!turn) return "—";
	return turn.turnId.replace(/^turn-/, "");
}
</script>

<template>
	<div ref="rootElement" class="context-diff-dock" :class="{ 'session-only': props.sessionOnly }" :data-reading="props.sessionOnly ? undefined : readingState">
		<!-- V4 Inspector Header with Boundary Buttons -->
		<div class="context-diff-dock-header">
			<button
				v-if="!props.sessionOnly"
				id="focus-toggle"
				type="button"
				class="text-btn reading-arrow preview-reading-arrow context-diff-expand"
				:aria-label="primaryBoundaryAria"
				:title="primaryBoundaryTitle"
				@click="handlePrimaryBoundaryClick"
			>
				<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path :d="readingState === 'side' ? 'M13 4l-6 6 6 6' : 'M7 4l6 6-6 6'" />
				</svg>
			</button>
			<button
				v-if="readingState === 'wide'"
				id="reading-focus-btn"
				type="button"
				class="text-btn preview-focus-button"
				:aria-label="t('polish.inspector.wideFocusAria')"
				:title="t('polish.inspector.focus')"
				@click="enterFocus"
			>
				<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
				</svg>
			</button>
			<strong class="inspect-title">{{ currentTitle }}</strong>
			<span class="preview-state scope-badge">{{ currentScopeBadge }}</span>
			<button
				v-if="mode === 'draft' || mode === 'run'"
				id="return-editing"
				type="button"
				class="text-btn return-editing-btn"
				@click="returnToEditing"
			>
				{{ t("polish.inspector.returnEditing") }}
			</button>
		</div>

		<div v-if="!props.sessionOnly" class="context-diff-mode-tabs" role="tablist" :aria-label="t('diff.dockAria')">
			<button type="button" :class="{ active: mode === 'compiled' }" role="tab" :aria-selected="mode === 'compiled'" @click="setMode('compiled')">{{ t("tab.preview") }}</button>
			<button type="button" :class="{ active: mode === 'draft' }" role="tab" :aria-selected="mode === 'draft'" @click="setMode('draft')">{{ t("diff.draftTab") }}</button>
			<button type="button" :class="{ active: mode === 'run' }" role="tab" :aria-selected="mode === 'run'" @click="setMode('run')">{{ t("diff.runTab") }}</button>
		</div>

        <div v-if="mode === 'session'" class="session-context-notice" data-session-context-notice>
                <template v-if="sessionPreview"><strong>{{ sessionPreview.preset.name || sessionPreview.preset.selector }}</strong> · {{ sessionPreview.preset.selector }}<br></template>
                {{ t("sessionCapabilities.sessionPreviewNote") }}
                <div v-if="sessionLoading && sessionPreview" class="session-updating" role="status">{{ t("sessionCapabilities.previewUpdating") }}</div>
                <div v-if="locationIds.length && sessionPreview" class="location-result" data-location-result>
                    {{ matchingSections.length ? t("sessionCapabilities.locationFound", {count: matchingSections.length}) : t("sessionCapabilities.locationMissing") }}
                </div>
            </div>
        <div v-show="mode === 'compiled' || mode === 'session'" class="context-diff-compiled" role="tabpanel">
            <div class="context-diff-panel-head">
				<div class="context-diff-meta">
					<span v-if="displayPreview" :title="t('diff.compiledMeta', { tokens: displayPreview.approxTokens, chars: displayPreview.totalChars })">{{ t("diff.compiledMeta", { tokens: displayPreview.approxTokens, chars: displayPreview.totalChars }) }}</span>
					<span v-else-if="displayLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="displayError" class="error">{{ displayError }}</span>
					<span v-else>{{ t("diff.noPreview") }}</span>
				</div>
				<button v-if="displayText" type="button" class="context-diff-copy-full" :disabled="!!displayError || (mode !== 'session' && previewStale)" :title="t('inspection.reportNote')" @click="copyPreviewText(displayText)">{{ t("inspection.copyReport") }}</button>
				<button type="button" class="context-diff-refresh" @click="refreshVisiblePreview">{{ t("profiles.refresh") }}</button>
			</div>
			<div v-if="displayDiagnostics.length" class="context-diff-diagnostics">
				<strong>{{ t("diff.compilerDiagnostics", { count: displayDiagnostics.length }) }}</strong>
				<div v-for="(diagnostic, index) in displayDiagnostics" :key="index" :class="['context-diff-diagnostic', diagnostic.level]">
					{{ diagnostic.level.toUpperCase() }}<template v-if="diagnostic.itemId"> · {{ diagnostic.itemId }}</template>: {{ diagnostic.message }}
				</div>
			</div>
			<details v-if="!props.sessionOnly && displayPreview && displayPreview.selectedTools !== undefined" class="preview-selected-tools-panel">
				<summary class="selected-tools-head">
					<span class="selected-tools-title">{{ mode === 'session' ? t("sessionCapabilities.effectiveTools") : t("diff.previewSelectedToolsTitle") }}</span>
					<span class="selected-tools-count">
						{{ displayPreview.selectedTools.length === 0
							? t("diff.noToolsSelected")
							: t(displayPreview.selectedTools.length === 1 ? "diff.toolCountOne" : "diff.toolCountMany", { count: displayPreview.selectedTools.length }) }}
					</span>
				</summary>
				<p class="selected-tools-note">{{ mode === 'session' ? t("sessionCapabilities.sessionToolsNote") : t("diff.previewSelectedToolsNote") }}</p>
				<div v-if="displayPreview.selectedTools.length > 0" class="selected-tools-list">
					<span v-for="tool in displayPreview.selectedTools" :key="tool" class="selected-tool-chip">{{ tool }}</span>
				</div>
			</details>
			<div v-else-if="!props.sessionOnly && displayPreview && displayPreview.selectedTools === undefined" class="preview-selected-tools-panel unknown">
				<div class="selected-tools-head">
					<span class="selected-tools-title">{{ mode === 'session' ? t("sessionCapabilities.effectiveTools") : t("diff.previewSelectedToolsTitle") }}</span>
					<span class="selected-tools-count muted">{{ t("diff.toolSelectionUnknown") }}</span>
				</div>
				<p class="selected-tools-note">{{ mode === 'session' ? t("sessionCapabilities.sessionToolsNote") : t("diff.previewSelectedToolsNote") }}</p>
			</div>
			<div v-if="mode !== 'session' && previewStale" class="context-diff-pending" data-preview-pending role="status">{{ t("inspection.draftUpdating") }}</div>
			<div v-if="displayError" class="context-diff-error">{{ displayError }}</div>
			<pre v-else-if="compiledSections.length === 0 && displayText" class="section-text">{{ displayText }}</pre>
			<div v-else-if="compiledSections.length === 0" class="context-diff-empty">
				{{ displayLoading ? t("diff.loadingPreview") : t("diff.selectStackHint") }}
			</div>
            <PreviewInspector v-if="compiledSections.length > 0" v-show="!displayError" :inert="mode !== 'session' && previewStale" :aria-busy="mode !== 'session' && previewStale" ref="inspector" :sections="compiledSections" :boundary="inspectorBoundary" :matching-ids="matchingSections.map(section => section.id)" @copy="copyPreviewText" />
		</div>

		<div v-if="!props.sessionOnly" v-show="mode === 'draft' || mode === 'run'" class="context-diff-diff" role="tabpanel">
			<div class="context-diff-panel-head">
				<div class="context-diff-meta">
					<span v-if="mode === 'draft' && previewLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="mode === 'run' && contextDiffLoading">{{ t("diff.refreshing") }}</span>
					<span v-else-if="mode === 'draft' && previewError" class="error">{{ previewError }}</span>
					<span v-else-if="mode === 'run' && contextDiffError" class="error">{{ contextDiffError }}</span>
					<span v-else-if="activeDiff">{{ changedBlocks === 0 ? t("diff.noChanges") : t("diff.changedBlocks", { count: changedBlocks }) }}</span>
					<span v-else>{{ mode === "draft" ? t("diff.noDraftComparison") : t("diff.noCapturedRuns") }}</span>
				</div>
				<button type="button" class="context-diff-refresh" @click="mode === 'draft' ? refreshPreview() : refreshContextDiff()">{{ t("profiles.refresh") }}</button>
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

<style src="../inspector-layout.css"></style>

<style scoped>
.context-diff-pending { position: sticky; top: 0; z-index: 1; padding: 8px 12px; font-size: 12px; color: var(--warning); background: color-mix(in srgb, var(--warning) 8%, var(--pane)); border-bottom: 1px solid var(--line); }
.session-only .context-diff-dock-header { padding-left: 0; }
.session-only .scope-badge { display: inline; }
.session-updating { margin-top: 4px; color: var(--muted); }

.session-context-notice { padding: 8px 10px; border: 1px solid var(--line); border-radius: 5px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.location-result { color: var(--accent); margin-top: 5px; }

.context-diff-dock { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; position: static; }
.context-diff-mode-tabs { display: flex; gap: 6px; flex: 0 0 auto; }
.context-diff-mode-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; padding: 4px 2px; margin-right: 10px; font-size: 12px; }
.context-diff-mode-tabs button.active { border-bottom-color: var(--accent); background: transparent; color: var(--accent); }
.context-diff-panel-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: 0 0 auto; }
.context-diff-panel-head button { flex-shrink: 0; white-space: nowrap; }
.context-diff-title { font-weight: 700; flex-shrink: 0; white-space: nowrap; }
.context-diff-meta { flex: 1 1 120px; color: var(--muted); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-diff-meta .error, .context-diff-error { color: var(--error); }
.context-diff-refresh { margin-left: auto; min-height: 28px; font-size: 12px; padding: 2px 8px; }
.context-diff-copy-full, .context-diff-copy-section { min-height: 28px; font-size: 12px; padding: 2px 8px; }
.context-diff-copy-section { margin-left: auto; }
.context-diff-copy-section:disabled { opacity: 0.45; cursor: not-allowed; }
.preview-selected-tools-panel { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; background: var(--pane); font-size: 12px; }
.preview-selected-tools-panel.unknown { background: var(--pane-soft); }
.selected-tools-head { cursor:pointer; color:var(--muted); }
.selected-tools-head > * { margin-right:6px; }
.preview-selected-tools-panel[open] > summary { margin-bottom:8px; }
.selected-tools-title { font-weight: 700; color: var(--text); }
.selected-tools-count { font-size: 11px; color: var(--accent); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; line-height: 16px; }
.selected-tools-count.muted { color: var(--muted); }
.selected-tools-note { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.4; }
.selected-tools-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.selected-tool-chip { padding: 2px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--control-muted); color: var(--text); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.context-diff-diagnostics { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--pane); font-size: 12px; }
.context-diff-diagnostic.error { color: var(--error); }
.context-diff-diagnostic.warning { color: var(--warning); }
.context-diff-diagnostic.info { color: var(--muted); }
.context-diff-compiled, .context-diff-diff { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.context-diff-compiled > * { flex-shrink: 0; }
.context-diff-blocks { display: flex; flex-direction: column; gap: 8px; }
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
.preview-focus-button {
	flex-shrink: 0;
	width: 30px;
	height: 30px;
	min-width: 30px;
	min-height: 30px;
	display: grid;
	place-items: center;
	padding: 0;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane);
	color: var(--muted);
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	cursor: pointer;
	z-index: 5;
	transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.preview-focus-button:hover {
	background: var(--accent-bg);
	border-color: var(--accent);
	color: var(--accent);
}
.preview-focus-button:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
@media (max-width: 1100px) { .diff-view-controls { order: 3; margin-left: 0; width: 100%; } }
</style>
