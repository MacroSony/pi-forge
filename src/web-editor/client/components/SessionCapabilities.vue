<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import { cacheHitRate } from "../../../session-usage.ts";
import type { CacheUsageTotals, SessionCacheUsageView } from "../../../session-usage.ts";
import type { CapabilityChoice, CapabilityStateGuard, CapabilityStateMutation, CapabilityStateView } from "../../../capability-state.ts";

import ContextDiffPanel, { type CapabilityLocation } from "./ContextDiffPanel.vue";

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ (e: "open"): void }>();
const inspector = ref<InstanceType<typeof ContextDiffPanel> | null>(null);
const hasOpened = ref(props.active);
const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

interface CapabilityAvailableResponse {
	ok: boolean;
	state: CapabilityStateView;
	choices: CapabilityChoice[];
}

const state = ref<CapabilityStateView | null>(null);
const isStale = ref(false);
const isMutating = ref(false);
const isRefreshing = ref(false);
const unavailable = ref(false);
const errorMessage = ref("");
const pendingResetGuard = ref<CapabilityStateGuard | null>(null);

const availableChoices = ref<CapabilityChoice[]>([]);
const availableLoaded = ref(false);
const isLoadingAvailable = ref(false);
const selectedKey = ref("");
const isUsing = ref(false);

let isMounted = false;
let requestIdSeq = 0;
let activeReadRequestId = 0;
let readAbort: AbortController | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let catalogRefreshPending = false;

function choiceKey(choice: { kind: string; id: string }): string {
	return `${choice.kind}:${choice.id}`;
}

const libraryChoices = computed(() => availableChoices.value.filter((c) => c.kind === "capability"));
const presetChoices = computed(() => availableChoices.value.filter((c) => c.kind === "binding"));

const selectedChoice = computed<CapabilityChoice | null>(() => {
	if (!selectedKey.value) return null;
	return availableChoices.value.find((c) => choiceKey(c) === selectedKey.value) ?? null;
});

const canMutate = computed(() => {
	if (isMutating.value || isStale.value || !state.value || unavailable.value) return false;
	if (!state.value.trusted) return false;
	if (state.value.restoring) return false;
	if (state.value.problem) return false;
	return true;
});

const canUseSelected = computed(() => {
	if (!canMutate.value || isMutating.value || isUsing.value || isLoadingAvailable.value || isRefreshing.value) return false;
	if (!selectedChoice.value) return false;
	if (selectedChoice.value.problem) return false;
	return true;
});

const activeCount = computed(() => state.value?.active?.length ?? 0);
// Ephemeral observation of this browser's successful guarded action, never a
// reconstructed history or the Mode definition's requested tool patch.
const recentChange = ref<{
	added: string[]; removed: string[]; enabled: number; disabled: number; activationIds: string[];
} | null>(null);
function rememberChange(before: CapabilityStateView | null, after: CapabilityStateView): void {
	if (!before || before.guard.sessionId !== after.guard.sessionId) return;
	const previous = new Set(before.effectiveTools), current = new Set(after.effectiveTools);
	const oldIds = new Set(before.active.map(item => item.activationId));
	const newIds = new Set(after.active.map(item => item.activationId));
	const enabled = after.active.filter(item => !oldIds.has(item.activationId));
	const disabled = before.active.filter(item => !newIds.has(item.activationId));
	recentChange.value = {
		added: after.effectiveTools.filter(tool => !previous.has(tool)),
		removed: before.effectiveTools.filter(tool => !current.has(tool)),
		enabled: enabled.length, disabled: disabled.length,
		// Tool-only modes project no instruction update, so there is nothing to locate.
		activationIds: [...enabled, ...disabled].filter(item => item.content.trim()).map(item => item.activationId),
	};
}
async function locate(activationIds: string[]): Promise<void> {
	if (!state.value || isStale.value || isMutating.value || !props.active) return;
	const target: CapabilityLocation = { activationIds, guard: { ...state.value.guard }, presetRevision: state.value.presetRevision };
	await inspector.value?.locateCapability(target);
	if (isMounted && props.active && window.matchMedia("(max-width: 820px)").matches) {
		inspector.value?.$el.closest(".session-inspector")?.scrollIntoView({ block: "nearest" });
	}
}

function guardsEqual(a: CapabilityStateGuard | null | undefined, b: CapabilityStateGuard | null | undefined): boolean {
	if (!a || !b) return false;
	return a.sessionId === b.sessionId && a.leafId === b.leafId && a.revision === b.revision;
}

function shortId(id: string | null | undefined): string {
	if (!id) return "-";
	return id.length > 8 ? id.slice(0, 8) : id;
}

function shortRevision(revision: string | null | undefined): string {
	if (!revision) return "-";
	if (revision.startsWith("sha256:")) {
		const lastColon = revision.lastIndexOf(":");
		const hash = lastColon !== -1 ? revision.slice(lastColon + 1) : revision;
		return hash.length > 8 ? hash.slice(0, 8) : hash;
	}
	return revision.length > 8 ? revision.slice(0, 8) : revision;
}

function deliveryLabel(delivery: string | undefined): string {
	if (!delivery) return "";
	if (delivery === "prepared") return t("sessionCapabilities.deliveryPrepared");
	if (delivery === "pending") return t("sessionCapabilities.deliveryPending");
	if (delivery === "none") return t("sessionCapabilities.deliveryNone");
	return delivery;
}

function presentationLabel(presentation: string | undefined): string {
	if (!presentation) return "";
	if (presentation === "native") return t("sessionCapabilities.presentationNative");
	if (presentation === "user") return t("sessionCapabilities.presentationUser");
	return presentation;
}

function cacheRate(totals: CacheUsageTotals): string {
	const rate = cacheHitRate(totals);
	return rate === undefined ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function cacheTokenDetail(label: string, totals: CacheUsageTotals): string {
	return `${label}: ${cacheRate(totals)}; ${t("sessionCapabilities.cacheRead")} ${totals.cacheRead}; ${t("sessionCapabilities.cacheWrite")} ${totals.cacheWrite}; ${t("sessionCapabilities.cacheUncached")} ${totals.input}`;
}

function cacheMainTitle(usage: SessionCacheUsageView): string {
	return [
		usage.main.lastRequest ? cacheTokenDetail(t("sessionCapabilities.cacheLastRequest"), usage.main.lastRequest) : `${t("sessionCapabilities.cacheLastRequest")}: —`,
		cacheTokenDetail(t("sessionCapabilities.cacheTurnLabel"), usage.main.turn),
		cacheTokenDetail(t("sessionCapabilities.cacheSessionLabel"), usage.main.session),
		t("sessionCapabilities.cacheScopeNote"),
	].join("\n");
}

function cacheNestedTitle(usage: SessionCacheUsageView): string {
	const combined = (main: CacheUsageTotals, nested: CacheUsageTotals): CacheUsageTotals => ({
		requests: main.requests + nested.requests, input: main.input + nested.input,
		output: main.output + nested.output, cacheRead: main.cacheRead + nested.cacheRead,
		cacheWrite: main.cacheWrite + nested.cacheWrite,
	});
	return [
		cacheTokenDetail(t("sessionCapabilities.cacheNestedTurnLabel"), usage.nested.turn),
		cacheTokenDetail(t("sessionCapabilities.cacheNestedSessionLabel"), usage.nested.session),
		cacheTokenDetail(t("sessionCapabilities.cacheCombinedTurn"), combined(usage.main.turn, usage.nested.turn)),
		cacheTokenDetail(t("sessionCapabilities.cacheCombinedSession"), combined(usage.main.session, usage.nested.session)),
		t("sessionCapabilities.cachePartialNote"),
	].join("\n");
}

function setChoices(newChoices: CapabilityChoice[]): void {
	const previous = selectedChoice.value;
	availableChoices.value = newChoices;
	if (selectedKey.value) {
		const match = newChoices.find((c) => choiceKey(c) === selectedKey.value);
		if (!match || match.fingerprint !== previous?.fingerprint) {
			selectedKey.value = "";
		}
	}
}

function applyState(newState: CapabilityStateView, reqId: number, includesChoices = false): void {
	if (!isMounted) return;
	if (reqId !== requestIdSeq) return;

	const guardChanged = !guardsEqual(state.value?.guard, newState.guard);
	const presetChanged = state.value?.presetRevision !== newState.presetRevision;

	if (pendingResetGuard.value && !guardsEqual(newState.guard, pendingResetGuard.value)) {
		pendingResetGuard.value = null;
	}

	state.value = newState;
	unavailable.value = false;
	isStale.value = false;

	if (guardChanged || presetChanged) recentChange.value = null;
	if (guardChanged && !includesChoices) {
		availableChoices.value = [];
		availableLoaded.value = false;
		selectedKey.value = "";
	}
}

function invalidateRead(): void {
	++requestIdSeq;
	readAbort?.abort();
	readAbort = undefined;
	activeReadRequestId = 0;
	isRefreshing.value = false;
	isLoadingAvailable.value = false;
	catalogRefreshPending = false;
}

async function fetchAvailable(silent = false): Promise<void> {
	await fetchCapabilityState(true, silent);
}

async function fetchCapabilityState(forceChoices = false, background = false): Promise<void> {
	if (!isMounted || isMutating.value) return;
	if (activeReadRequestId) {
		if (forceChoices) catalogRefreshPending = true;
		return;
	}
	const reqId = ++requestIdSeq;
	activeReadRequestId = reqId;
	const controller = new AbortController();
	readAbort = controller;
	// Background status reads never put otherwise usable controls into loading.
	// Catalog discovery is explicit/on entry/after mutation, not every poll.
	isRefreshing.value = !background;
	const withChoices = forceChoices;
	isLoadingAvailable.value = withChoices;
	try {
		if (withChoices) {
			const res = await api<CapabilityAvailableResponse>("/api/capability-state/available", { signal: controller.signal });
			if (!isMounted || reqId !== requestIdSeq) return;
			if (!res?.ok || !res.state) throw new Error(t("sessionCapabilities.unavailable"));
			applyState(res.state, reqId, true);
			setChoices(res.choices ?? []);
			availableLoaded.value = true;
		} else {
			const res = await api<{ ok: boolean; state: CapabilityStateView }>("/api/capability-state", { signal: controller.signal });
			if (!isMounted || reqId !== requestIdSeq) return;
			if (!res?.ok || !res.state) throw new Error(t("sessionCapabilities.unavailable"));
			applyState(res.state, reqId);
		}
	} catch (error) {
		if (!isMounted || reqId !== requestIdSeq) return;
		isStale.value = true;
		recentChange.value = null;
		pendingResetGuard.value = null;
		if (withChoices) errorMessage.value = error instanceof Error ? error.message : String(error);
		if (!state.value) unavailable.value = true;
	} finally {
		if (activeReadRequestId === reqId) {
			readAbort = undefined;
			activeReadRequestId = 0;
			isRefreshing.value = false;
			isLoadingAvailable.value = false;
		}
		if (catalogRefreshPending && !activeReadRequestId && isMounted && props.active && !isMutating.value) {
			catalogRefreshPending = false;
			void fetchAvailable(true);
		}
	}
}

async function executeMutation(mutation: CapabilityStateMutation): Promise<void> {
	if (isMutating.value || !isMounted) return;
	const before = state.value;
	recentChange.value = null;
	// Invalidate an older GET even when this POST fails. Old responses must never
	// make a stale view actionable again after a failed refresh.
	const reqId = ++requestIdSeq;
	activeReadRequestId = 0;
	isLoadingAvailable.value = false;
	isRefreshing.value = false;
	isMutating.value = true;
	errorMessage.value = "";
	let hasError = false;
	const refreshChoices = availableLoaded.value;
	try {
		const res = await api<{ ok: boolean; state: CapabilityStateView }>("/api/capability-state", {
			method: "POST",
			body: mutation,
		});
		if (!isMounted || reqId !== requestIdSeq) return;
		if (!res?.ok || !res.state) throw new Error(t("sessionCapabilities.unavailable"));
		applyState(res.state, reqId);
		rememberChange(before, res.state);
	} catch (error) {
		if (!isMounted) return;
		hasError = true;
		isStale.value = true;
		recentChange.value = null;
		pendingResetGuard.value = null;
		errorMessage.value = error instanceof Error ? error.message : String(error);
	} finally {
		isMutating.value = false;
	}
	if (isMounted && reqId === requestIdSeq) {
		if (hasError) void fetchCapabilityState(refreshChoices);
		else if (refreshChoices) void fetchAvailable(true);
	}
}

async function handleUse(): Promise<void> {
	if (!state.value || !selectedChoice.value || !canUseSelected.value || isMutating.value || isUsing.value) return;

	const guard: CapabilityStateGuard = {
		sessionId: state.value.guard.sessionId,
		leafId: state.value.guard.leafId,
		revision: state.value.guard.revision,
	};
	const { kind, id, fingerprint } = selectedChoice.value;
	const before = state.value;
	recentChange.value = null;

	const reqId = ++requestIdSeq;
	activeReadRequestId = 0;
	isLoadingAvailable.value = false;
	isRefreshing.value = false;
	isMutating.value = true;
	isUsing.value = true;
	errorMessage.value = "";
	let hasError = false;
	const refreshChoices = availableLoaded.value;

	try {
		const res = await api<{ ok: boolean; state: CapabilityStateView }>("/api/capability-state/enable", {
			method: "POST",
			body: { guard, kind, id, fingerprint },
		});
		if (!isMounted || reqId !== requestIdSeq) return;
		if (!res?.ok || !res.state) throw new Error(t("sessionCapabilities.unavailable"));
		applyState(res.state, reqId);
		rememberChange(before, res.state);
		selectedKey.value = "";
	} catch (error) {
		if (!isMounted) return;
		hasError = true;
		isStale.value = true;
		recentChange.value = null;
		pendingResetGuard.value = null;
		errorMessage.value = error instanceof Error ? error.message : String(error);
	} finally {
		isMutating.value = false;
		isUsing.value = false;
	}

	// applyState invalidates old guarded choices. Refresh only after releasing
	// the mutation fence, remembering whether this drawer had loaded them.
	if (isMounted && reqId === requestIdSeq) {
		if (hasError) void fetchCapabilityState(refreshChoices);
		else if (refreshChoices) void fetchAvailable(true);
	}
}

function onSelectFocus(): void {
	if (!availableLoaded.value && !isLoadingAvailable.value && canMutate.value) {
		void fetchAvailable();
	}
}

function onSelectClick(): void {
	if (!availableLoaded.value && !isLoadingAvailable.value && canMutate.value) {
		void fetchAvailable();
	}
}

async function handleDisable(activationId: string): Promise<void> {
	if (!state.value || !canMutate.value) return;
	const guard: CapabilityStateGuard = {
		sessionId: state.value.guard.sessionId,
		leafId: state.value.guard.leafId,
		revision: state.value.guard.revision,
	};
	await executeMutation({ action: "disable", activationId, guard });
}

function promptReset(): void {
	if (!state.value || !canMutate.value) return;
	pendingResetGuard.value = {
		sessionId: state.value.guard.sessionId,
		leafId: state.value.guard.leafId,
		revision: state.value.guard.revision,
	};
}

function cancelReset(): void {
	pendingResetGuard.value = null;
}

async function handleReset(): Promise<void> {
	const guardToReset = pendingResetGuard.value;
	pendingResetGuard.value = null;
	if (!guardToReset || !state.value || !canMutate.value) return;
	if (!guardsEqual(state.value.guard, guardToReset)) return;
	await executeMutation({ action: "reset", guard: guardToReset });
}

watch(() => props.active, (active) => {
	if (active) {
		hasOpened.value = true;
		// A new visit must not wait behind or accept an old view's catalog.
		// Never invalidate an in-flight mutation: its receipt still belongs here.
		if (!isMutating.value) {
			invalidateRead();
			void fetchAvailable(true);
		}
	} else {
		pendingResetGuard.value = null;
		catalogRefreshPending = false;
		if (!isMutating.value && isLoadingAvailable.value) invalidateRead();
		// Cheap status reads continue while hidden for the global summary.
	}
});

function onVisibilityOrFocus(): void {
	if (!isMounted) return;
	if (document.visibilityState === "visible") {
		void fetchCapabilityState(false, true);
	}
}

function startPolling(): void {
	stopPolling();
	pollTimer = setInterval(() => {
		if (!isMounted) return;
		if (document.visibilityState === "visible") {
			void fetchCapabilityState(false, true);
		}
	}, 3000);
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

onMounted(() => {
	isMounted = true;
	void fetchCapabilityState(false, true);
	startPolling();
	window.addEventListener("focus", onVisibilityOrFocus);
	document.addEventListener("visibilitychange", onVisibilityOrFocus);
});

onUnmounted(() => {
	isMounted = false;
	invalidateRead();
	stopPolling();
	window.removeEventListener("focus", onVisibilityOrFocus);
	document.removeEventListener("visibilitychange", onVisibilityOrFocus);
});

</script>

<template>
	<aside
		class="session-capabilities"
		:class="{ 'workspace-open': props.active, stale: isStale, unavailable }"
		:aria-label="t('sessionCapabilities.title')"
		data-session-capabilities
	>
		<!-- Compact summary header: globally visible above all surfaces -->
		<header class="capabilities-header" data-session-summary aria-live="polite">
			<button
				type="button"
				class="capabilities-toggle-btn"
				:aria-current="props.active ? 'page' : undefined"
				:title="t('sessionCapabilities.workspaceTitle')"
				data-capabilities-open

				@click="emit('open')"
			>
				<span class="toggle-icon" aria-hidden="true">→</span>
				<span class="capabilities-title">{{ t("sessionCapabilities.title") }}</span>
				<span v-if="unavailable" class="capabilities-badge unavailable-badge" data-capabilities-unavailable>{{ t("sessionCapabilities.unavailable") }}</span>
				<span v-else-if="state" class="capabilities-badge active-badge" data-capabilities-active-badge>{{ t(activeCount === 1 ? "sessionCapabilities.activeCountOne" : "sessionCapabilities.activeCount", { count: activeCount }) }}</span>
				<span v-if="state?.delivery && state.delivery !== 'none'" class="capabilities-badge delivery-badge" :class="state.delivery" data-capabilities-delivery-badge>{{ deliveryLabel(state.delivery) }}</span>
				<span v-if="state" class="session-context" :title="`${state.guard.sessionId}${state.guard.leafId ? ` · ${state.guard.leafId}` : ''}`" data-session-context>
					{{ t("sessionCapabilities.session") }} {{ shortId(state.guard.sessionId) }}<template v-if="state.guard.leafId"> · {{ shortId(state.guard.leafId) }}</template>
				</span>
				<span v-if="state?.problem" class="capabilities-badge problem-badge" :title="state.problem" data-capabilities-problem-badge>⚠</span>
				<span v-if="errorMessage" class="capabilities-badge error-badge" :title="errorMessage" data-capabilities-error-badge>⚠</span>
				<span v-if="state?.restoring" class="capabilities-badge restoring-badge" data-capabilities-restoring-badge>⟳</span>
				<span v-if="state && !state.trusted" class="capabilities-badge untrusted-badge" data-capabilities-untrusted-badge>{{ t("sessionCapabilities.untrustedBadge") }}</span>
				<span v-if="isStale" class="capabilities-badge stale-badge" data-capabilities-stale-badge>{{ t("sessionCapabilities.staleBadge") }}</span>
			</button>

			<div class="header-actions">
				<span
					v-if="isRefreshing"
					class="capabilities-badge refreshing-indicator"
					:title="t('sessionCapabilities.refreshing')"
					data-capabilities-summary-refreshing

				>
					⟳ {{ t("sessionCapabilities.refreshing") }}
				</span>
			</div>
		</header>

		<div v-show="props.active" class="session-workspace" data-session-workspace>
			<section class="capabilities-controls" :aria-label="t('sessionCapabilities.controlsTitle')">
				<header class="controls-header">
					<div class="controls-header-left">
						<h2 class="controls-title">{{ t("sessionCapabilities.controlsTitle") }}</h2>

					</div>

					<div class="controls-header-actions">
						<button
							type="button"
							class="action-btn refresh-btn"
							:disabled="isRefreshing || isMutating"
							:title="t('sessionCapabilities.refresh')"
							data-capabilities-refresh

							@click="() => fetchCapabilityState(availableLoaded)"
						>
							{{ isRefreshing ? t("sessionCapabilities.refreshing") : t("sessionCapabilities.refresh") }}
						</button>

						<template v-if="state && !unavailable">
							<div v-if="pendingResetGuard" class="reset-confirm-group" data-capabilities-reset-confirm-group>
								<span class="confirm-prompt">{{ t("sessionCapabilities.confirmReset") }} ({{ t("sessionCapabilities.session") }} {{ shortId(pendingResetGuard.sessionId) }})</span>
								<button
									type="button"
									class="action-btn danger-btn confirm-btn"
									:disabled="!canMutate"
									data-capabilities-confirm-reset-btn

									@click="handleReset"
								>
									{{ t("sessionCapabilities.confirm") }}
								</button>
								<button
									type="button"
									class="action-btn cancel-btn"
									data-capabilities-cancel-reset-btn

									@click="cancelReset"
								>
									{{ t("sessionCapabilities.cancel") }}
								</button>
							</div>
							<button
								v-else
								type="button"
								class="action-btn danger-btn reset-all-btn"
								:disabled="!canMutate || activeCount === 0"
								:title="t('sessionCapabilities.resetAll')"
								data-capabilities-reset-btn

								@click="promptReset"
							>
								{{ t("sessionCapabilities.resetAll") }}
							</button>
						</template>

					</div>
				</header>

				<!-- Scrollable details body -->
				<div class="capabilities-body" data-capabilities-body>

					<!-- Warning & Error Banners -->
					<div v-if="errorMessage" class="instruction-banner error-banner" role="alert" data-capabilities-error-banner>
						{{ errorMessage }}
					</div>
					<div v-if="state?.problem" class="instruction-banner problem-banner" role="alert" data-capabilities-problem-banner>
						{{ t("sessionCapabilities.problemWarning", { problem: state.problem }) }}
					</div>
					<div v-if="state?.restoring" class="instruction-banner restoring-banner" role="status" data-capabilities-restoring-banner>
						{{ t("sessionCapabilities.restoringWarning") }}
					</div>
					<div v-if="state && !state.trusted" class="instruction-banner untrusted-banner" role="alert" data-capabilities-untrusted-banner>
						{{ t("sessionCapabilities.untrustedWarning") }}
					</div>
					<div v-if="isStale" class="instruction-banner stale-banner" role="alert" data-capabilities-stale-banner>
						{{ t("sessionCapabilities.staleWarning") }}
					</div>

					<p v-if="state && state.delivery !== 'none'" class="capabilities-delivery-summary">
						{{ t("sessionCapabilities.delivery") }}: {{ deliveryLabel(state.delivery) }}
					</p>
					<div v-if="state?.delivery === 'prepared'" class="delivery-prepared-notice full-width" data-capabilities-prepared-notice>
						{{ t("sessionCapabilities.deliveryPreparedNote") }}
					</div>
                    <section v-if="state" class="capabilities-impact" data-capabilities-impact>
                        <strong>{{ t("sessionCapabilities.effectiveTools") }}</strong>
                        <div v-if="state.effectiveTools.length" class="tools-list" data-capabilities-tools-list>
                            <span v-for="tool in state.effectiveTools" :key="tool" class="tool-tag"
                                :class="{ 'impact-added': recentChange?.added.includes(tool) }" data-capabilities-tool-tag>
                                <span v-if="recentChange?.added.includes(tool)" aria-hidden="true">+ </span>{{ tool }}
                            </span>
                        </div>
                        <span v-else data-capabilities-tools-none>{{ t("sessionCapabilities.none") }}</span>
                        <div v-if="recentChange && !isStale" class="impact-change" data-capabilities-recent-change role="status">
                            <span>{{ t("sessionCapabilities.lastAction") }}</span>
                            <span v-if="recentChange.enabled">{{ t("sessionCapabilities.enabledCount", {count: recentChange.enabled}) }}</span>
                            <span v-if="recentChange.disabled">{{ t("sessionCapabilities.disabledCount", {count: recentChange.disabled}) }}</span>
                            <span v-for="tool in recentChange.added" :key="'add:'+tool" class="impact-added" data-impact-added>+ {{ tool }}</span>
                            <span v-for="tool in recentChange.removed" :key="'remove:'+tool" class="impact-removed" data-impact-removed>− {{ tool }}</span>
                            <span v-if="!recentChange.added.length && !recentChange.removed.length">{{ t("sessionCapabilities.toolsUnchanged") }}</span>
                            <button v-if="recentChange.activationIds.length" type="button" :disabled="isMutating"
                                data-locate-recent @click="locate(recentChange.activationIds)">{{ t("sessionCapabilities.locateChange") }}</button>
                        </div>
                        <div v-if="state.cacheUsage" class="cache-usage" data-capabilities-cache>
                            <div class="cache-usage-row" data-cache-main :title="cacheMainTitle(state.cacheUsage)">
                                <strong>{{ t("sessionCapabilities.cacheHit") }}</strong>
                                <span data-cache-turn>{{ t("sessionCapabilities.cacheTurn", { rate: cacheRate(state.cacheUsage.main.turn), count: state.cacheUsage.main.turn.requests }) }}</span>
                                <span data-cache-session>{{ t("sessionCapabilities.cacheSession", { rate: cacheRate(state.cacheUsage.main.session), count: state.cacheUsage.main.session.requests }) }}</span>
                            </div>
                            <div class="cache-usage-row" data-cache-nested :title="cacheNestedTitle(state.cacheUsage)">
                                <strong>{{ t("sessionCapabilities.cacheNested") }}</strong>
                                <span v-if="state.cacheUsage.nested.session.calls + state.cacheUsage.nested.session.cacheUnknownCalls + state.cacheUsage.nested.session.invalidCalls === 0"
                                    class="cache-usage-empty" data-cache-nested-empty>{{ t("sessionCapabilities.cacheNoData") }}</span>
                                <template v-else>
                                    <span data-cache-nested-turn>{{ t("sessionCapabilities.cacheNestedTurn", { rate: cacheRate(state.cacheUsage.nested.turn), count: state.cacheUsage.nested.turn.calls }) }}</span>
                                    <span data-cache-nested-session>{{ t("sessionCapabilities.cacheNestedSession", { rate: cacheRate(state.cacheUsage.nested.session), count: state.cacheUsage.nested.session.calls }) }}</span>
                                    <span v-if="state.cacheUsage.nested.session.cacheUnknownCalls > 0" class="cache-usage-note" data-cache-nested-unknown>
                                        {{ t("sessionCapabilities.cacheNestedUnknown", { count: state.cacheUsage.nested.session.cacheUnknownCalls }) }}
                                    </span>
                                    <span v-if="state.cacheUsage.nested.session.invalidCalls > 0" class="cache-usage-note" data-cache-nested-invalid>
                                        {{ t("sessionCapabilities.cacheNestedInvalid", { count: state.cacheUsage.nested.session.invalidCalls }) }}
                                    </span>
                                </template>
                            </div>
                        </div>
                    </section>
					<!-- Human Activation Picker -->
					<div v-if="state" class="capabilities-picker-section" data-capabilities-picker-section>
						<div class="picker-section-header">
							<div class="picker-header-title-group">
								<span class="picker-section-title">{{ t("sessionCapabilities.pickerTitle") }}</span>
								<span v-if="availableLoaded" class="capabilities-badge picker-count-badge" data-capabilities-picker-count>
									{{ availableChoices.length }}
								</span>
							</div>
							<button
								type="button"
								class="action-btn picker-refresh-btn"
								:disabled="isLoadingAvailable || isMutating || !canMutate"
								:title="t('sessionCapabilities.refreshCatalog')"
								data-capabilities-catalog-load
								data-capabilities-picker-refresh


								@click="() => fetchAvailable()"
							>
								{{ isLoadingAvailable ? t("sessionCapabilities.loadingCatalog") : (availableLoaded ? t("sessionCapabilities.refreshCatalog") : t("sessionCapabilities.loadCatalog")) }}
							</button>
						</div>

						<div class="picker-control-row">
							<select
								class="picker-select"
								v-model="selectedKey"
								:disabled="isLoadingAvailable || isMutating || isUsing || !canMutate"
								data-capabilities-picker-select

								@focus="onSelectFocus"
								@click="onSelectClick"
							>
								<option value="" disabled>{{ availableLoaded ? t("sessionCapabilities.selectChoice") : t("sessionCapabilities.loadChoicesPrompt") }}</option>
								<optgroup v-if="libraryChoices.length" :label="t('sessionCapabilities.kindLibraryUnbound')" data-picker-optgroup-library>
									<option
										v-for="choice in libraryChoices"
										:key="choiceKey(choice)"
										:value="choiceKey(choice)"
										data-picker-option
									>
										{{ choice.label }} ({{ choice.id }}){{ choice.problem ? ' ⚠' : '' }}
									</option>
								</optgroup>
								<optgroup v-if="presetChoices.length" :label="t('sessionCapabilities.kindPresetBound')" data-picker-optgroup-preset>
									<option
										v-for="choice in presetChoices"
										:key="choiceKey(choice)"
										:value="choiceKey(choice)"
										data-picker-option
									>
										{{ choice.label }} ({{ choice.id }}){{ choice.problem ? ' ⚠' : '' }}
									</option>
								</optgroup>
							</select>

							<button
								type="button"
								class="action-btn use-btn enable-btn"
								:disabled="!canUseSelected"
								:title="t('sessionCapabilities.enableTitle')"
								data-capabilities-enable-btn

								@click="handleUse"
							>
								{{ isUsing ? t("sessionCapabilities.enabling") : t("sessionCapabilities.enable") }}
							</button>
						</div>

						<!-- Selected Choice Literal Content / Tools / Problem Preview -->
						<div v-if="selectedChoice" class="picker-preview-card" data-capabilities-picker-preview>
							<div class="picker-preview-header">
								<div class="picker-preview-meta">
									<span class="preview-name" data-picker-preview-label>{{ selectedChoice.label }}</span>
									<span class="item-source-badge preview-kind-badge" :class="selectedChoice.kind" data-picker-preview-kind>
										{{ selectedChoice.kind === "binding" ? t("sessionCapabilities.kindPresetBadge") : t("sessionCapabilities.kindLibraryBadge") }}
									</span>
									<span class="item-source-badge" data-picker-preview-id>{{ selectedChoice.id }}</span>
									<span class="item-source-badge" :title="selectedChoice.fingerprint" data-picker-preview-fingerprint>
										#{{ shortRevision(selectedChoice.fingerprint) }}
									</span>
								</div>

								<div class="picker-preview-tools" data-picker-preview-tools>
									<span
										v-if="selectedChoice.tools?.add?.length"
										class="tool-diff-add"
										data-picker-preview-tools-add
									>+ {{ selectedChoice.tools.add.join(", ") }}</span>
									<span
										v-if="selectedChoice.tools?.remove?.length"
										class="tool-diff-remove"
										data-picker-preview-tools-remove
									>- {{ selectedChoice.tools.remove.join(", ") }}</span>
									<span
										v-if="!selectedChoice.tools?.add?.length && !selectedChoice.tools?.remove?.length"
										class="preview-tools-none"
										data-picker-preview-tools-none
									>{{ t("sessionCapabilities.noToolChanges") }}</span>
								</div>
							</div>

							<div v-if="selectedChoice.problem" class="instruction-banner problem-banner picker-problem-banner" role="alert" data-picker-preview-problem>
								{{ t("sessionCapabilities.choiceProblem", { problem: selectedChoice.problem }) }}
							</div>

							<pre class="picker-content-pre" data-picker-preview-content>{{ selectedChoice.content }}</pre>
						</div>
					</div>

					<!-- Active Items List -->
					<div v-if="state" class="capabilities-active-section" data-capabilities-active-section>
						<div v-if="state.active.length === 0" class="no-active-message" data-capabilities-empty>
							{{ t("sessionCapabilities.noActiveItems") }}
						</div>
						<div v-else class="active-items-list" data-capabilities-items-list>
							<div
								v-for="item in state.active"
								:key="item.activationId"
								class="active-item-card"
								:data-activation-id="item.activationId"
							>
								<div class="item-card-header">
									<div class="item-title-group">
										<span class="item-name" data-item-name>{{ item.name || item.source }}</span>
										<span class="item-source-badge" :title="t('sessionCapabilities.source')" data-item-source>
											{{ item.source }}
										</span>
										<span class="item-source-badge" :title="item.activationId" data-item-activation-id>#{{ shortId(item.activationId) }}</span>
										<span class="item-actor-badge" :title="t('sessionCapabilities.actor')" data-item-actor>
											{{ item.actor === "user" ? t("sessionCapabilities.actorUser") : t("sessionCapabilities.actorAgent") }}
										</span>
									</div>

									<div class="item-tools-diff" data-item-tools-diff>
                                        <span v-if="item.tools?.add?.length || item.tools?.remove?.length" class="declared-tools-label">{{ t("sessionCapabilities.declaredTools") }}</span>
										<span
											v-if="item.tools?.add?.length"
											class="tool-diff-add"
											data-item-tools-add
										>+ {{ item.tools.add.join(", ") }}</span>
										<span
											v-if="item.tools?.remove?.length"
											class="tool-diff-remove"
											data-item-tools-remove
										>- {{ item.tools.remove.join(", ") }}</span>
									</div>

									<button
										type="button"
										class="action-btn disable-btn"
										:disabled="!canMutate"
										:title="t('sessionCapabilities.disable')"
										data-item-disable-btn
										@click="handleDisable(item.activationId)"
									>
										{{ t("sessionCapabilities.disable") }}
									</button>
								</div>

                                <p v-if="item.content.trim()" class="capability-excerpt" data-item-content-excerpt>{{ item.content }}</p>
                                <p v-else class="capability-excerpt muted">{{ t("sessionCapabilities.noInstructionText") }}</p>
                                <button v-if="item.content.trim()" type="button" class="locate-capability" data-item-locate
                                    :disabled="isStale || isMutating || !state.trusted || state.restoring"
                                    @click="locate([item.activationId])">{{ t("sessionCapabilities.locateChange") }}</button>
								<details class="item-content-details" data-item-content-details>
									<summary class="content-summary" data-item-content-summary>{{ t("sessionCapabilities.viewContent") }}</summary>
									<pre class="item-content-pre" data-item-content-text>{{ item.content }}</pre>
								</details>
							</div>
						</div>
					</div>

					<details v-if="state" class="capabilities-diagnostics">
						<summary>{{ t("sessionCapabilities.technicalDetails") }}</summary>
					<!-- Meta Status Bar -->
						<div v-if="state" class="capabilities-meta-grid" data-capabilities-meta-grid>
							<div class="meta-item">
								<span class="meta-label">{{ t("sessionCapabilities.session") }}:</span>
								<span class="meta-value" :title="state.guard.sessionId" data-capabilities-session-id>{{ shortId(state.guard.sessionId) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("sessionCapabilities.branch") }}:</span>
								<span class="meta-value" :title="state.guard.leafId ?? 'null'" data-capabilities-branch-id>{{ shortId(state.guard.leafId) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("sessionCapabilities.revision") }}:</span>
								<span class="meta-value" :title="state.guard.revision" data-capabilities-revision>{{ shortRevision(state.guard.revision) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("sessionCapabilities.delivery") }}:</span>
								<span class="meta-value delivery-status" :class="state.delivery" data-capabilities-delivery>{{ deliveryLabel(state.delivery) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("sessionCapabilities.textPresentation") }}:</span>
								<span class="meta-value" data-capabilities-presentation>{{ presentationLabel(state.textPresentation) }}</span>
							</div>


						</div>

						<p class="capabilities-notice" data-capabilities-transport-warning>{{ t("sessionCapabilities.transportCaution") }}</p>
					</details>
				</div>
			</section>
			<section class="session-inspector" :aria-label="t('sessionCapabilities.sessionContext')">
				<ContextDiffPanel v-if="hasOpened" ref="inspector" session-only :active="props.active"
					:observed-state="isStale ? null : state" />
			</section>
		</div>
	</aside>
</template>

<style scoped>
.session-sessionCapabilities.workspace-open { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.session-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 350px) minmax(0, 1fr); gap: 14px; padding: 14px; background: var(--pane-soft); }
.capabilities-controls, .session-inspector { min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: 7px; background: var(--pane); }
.capabilities-controls { display: flex; flex-direction: column; overflow: hidden; }
.session-inspector { padding: 12px; overflow: hidden; }
.controls-header { flex-wrap: wrap; }
.capabilities-body { min-height: 0; }
.capabilities-header { flex: none; }
.capabilities-active-section { order: 3; }
.capabilities-diagnostics { order: 4; }
@media (max-width: 820px) {
 .session-workspace { display: flex; flex-direction: column; overflow: auto; }
 .capabilities-controls { flex: none; overflow: visible; }
 .capabilities-body { overflow: visible; }
 .session-inspector { flex: none; height: 70vh; min-height: 390px; }
}

.capabilities-impact { border: 1px solid var(--line); border-radius: 6px; padding: 12px; display: grid; gap: 8px; background: var(--pane-soft); }
.capabilities-impact .tools-list { flex-wrap: wrap; }
.capabilities-impact .tool-tag, .impact-change > span { overflow-wrap: anywhere; max-width: 100%; }
.item-tools-diff { flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
.impact-change { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 12px; }
.cache-usage { display: grid; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }
.cache-usage-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
.cache-usage-row > strong { color: var(--text); flex: 0 0 auto; }
.cache-usage-row > span { max-width: 100%; overflow-wrap: anywhere; }
.cache-usage-empty, .cache-usage-note { color: var(--muted); }
.impact-added { color: var(--success); border: 1px solid var(--success); border-radius: 4px; padding: 2px 5px; }
.impact-removed { color: var(--error); border: 1px solid var(--error); border-radius: 4px; padding: 2px 5px; }
.capability-excerpt { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 13px/1.5 ui-monospace, monospace; }
.declared-tools-label { color: var(--muted); font-size: 11px; }
.locate-capability { align-self: flex-start; margin: 0 0 6px; }

.session-capabilities {
	flex: none;
	background: var(--pane);
	border-bottom: 1px solid var(--line);
	font-size: 13px;
	color: var(--text);
}

.capabilities-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 10px;
	min-height: 22px;
	gap: 8px;
}

.capabilities-toggle-btn {
	display: flex;
	align-items: center;
	gap: 8px;
	background: transparent;
	border: none;
	color: inherit;
	cursor: pointer;
	padding: 1px 6px;
	min-height: 22px;
	border-radius: 4px;
	font-size: 13px;
	font-weight: 600;
}

.capabilities-toggle-btn:hover {
	background: var(--pane-soft);
}

.toggle-icon {
	font-size: 10px;
	color: var(--muted);
}

.capabilities-badge {
	font-size: 11px;
	font-weight: 500;
	padding: 1px 6px;
	border-radius: 10px;
	background: var(--pane-soft);
	border: 1px solid var(--line);
}

.session-context {
	color: var(--muted);
	font-size: 11px;
	font-weight: 400;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	white-space: nowrap;
}

.error-badge {
	background: color-mix(in srgb, var(--error, #ef4444) 15%, var(--pane));
	border-color: var(--error, #ef4444);
	color: var(--error, #ef4444);
}

.active-badge {
	background: color-mix(in srgb, var(--accent) 12%, var(--pane));
	border-color: var(--accent);
	color: var(--accent);
}

.delivery-badge.prepared {
	background: color-mix(in srgb, #22c55e 15%, var(--pane));
	border-color: #22c55e;
	color: #15803d;
}

.delivery-badge.pending {
	background: color-mix(in srgb, #eab308 15%, var(--pane));
	border-color: #eab308;
	color: #a16207;
}

.problem-badge, .untrusted-badge, .stale-badge {
	background: color-mix(in srgb, var(--error, #ef4444) 15%, var(--pane));
	border-color: var(--error, #ef4444);
	color: var(--error, #ef4444);
}

.header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}

.refreshing-indicator {
	color: var(--accent);
	font-size: 11px;
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.action-btn {
	min-height: 22px;
	padding: 1px 8px;
	font-size: 12px;
	border-radius: 4px;
	border: 1px solid var(--line);
	background: var(--pane);
	color: var(--text);
	cursor: pointer;
}

.action-btn:hover:not(:disabled) {
	background: var(--pane-soft);
}

.action-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.action-btn.danger-btn {
	background: color-mix(in srgb, var(--error, #ef4444) 15%, var(--pane));
	border-color: var(--error, #ef4444);
	color: var(--error, #ef4444);
}

.reset-confirm-group {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
}

.controls-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
	flex-shrink: 0;
	gap: 10px;
}

.controls-header-left {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	flex-wrap: wrap;
}

.controls-title {
	margin: 0;
	font-size: 14px;
	font-weight: 650;
	color: var(--text);
	white-space: nowrap;
}

.controls-session-context {
	font-size: 12px;
}

.controls-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
	flex-wrap: wrap;
}

.capabilities-body {
	padding: 12px 14px 20px;
	background: var(--pane-soft);
	display: flex;
	flex-direction: column;
	gap: 12px;
	flex: 1 1 auto;
	overflow-y: auto;
}

.instruction-banner {
	padding: 6px 10px;
	border-radius: 4px;
	font-size: 12px;
	font-weight: 500;
}

.error-banner, .problem-banner, .untrusted-banner, .stale-banner {
	background: color-mix(in srgb, var(--error, #ef4444) 12%, var(--pane));
	border: 1px solid var(--error, #ef4444);
	color: var(--error, #ef4444);
}

.restoring-banner {
	background: color-mix(in srgb, #eab308 12%, var(--pane));
	border: 1px solid #eab308;
	color: #a16207;
}

.capabilities-meta-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	gap: 8px 14px;
	padding: 8px 10px;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	font-size: 12px;
}

.meta-item {
	display: flex;
	align-items: center;
	gap: 6px;
}

.meta-item.full-width {
	grid-column: 1 / -1;
	flex-wrap: wrap;
}

.meta-label {
	color: var(--muted);
	font-weight: 600;
}

.meta-value {
	font-family: monospace;
}

.tools-list {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.tool-tag {
	font-family: monospace;
	font-size: 11px;
	background: var(--pane-soft);
	border: 1px solid var(--line);
	padding: 1px 5px;
	border-radius: 3px;
}

.delivery-prepared-notice {
	font-size: 11px;
	color: var(--muted);
	font-style: italic;
	margin-top: 2px;
}

.active-items-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.active-item-card {
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	padding: 8px 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.item-card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	flex-wrap: wrap;
}

.item-title-group {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.item-name {
	font-weight: 650;
	font-size: 13px;
}

.item-source-badge, .item-actor-badge {
	font-size: 11px;
	padding: 1px 5px;
	border-radius: 3px;
	background: var(--pane-soft);
	border: 1px solid var(--line);
	color: var(--muted);
}

.item-tools-diff {
	font-family: monospace;
	font-size: 11px;
	display: flex;
	gap: 8px;
}

.tool-diff-add {
	color: #15803d;
}

.tool-diff-remove {
	color: var(--error, #ef4444);
}

.item-content-details {
	margin-top: 4px;
}

.content-summary {
	font-size: 11px;
	color: var(--muted);
	cursor: pointer;
	user-select: none;
}

.item-content-pre {
	margin: 6px 0 0;
	padding: 8px;
	background: var(--pane-soft);
	border: 1px solid var(--line);
	border-radius: 4px;
	font-family: monospace;
	font-size: 12px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 150px;
	overflow-y: auto;
}

.no-active-message {
	padding: 12px;
	text-align: center;
	color: var(--muted);
	font-size: 12px;
}

.capabilities-picker-section {
	display: flex;
	flex-direction: column;
	gap: 8px;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	padding: 8px 10px;
}

.picker-section-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.picker-header-title-group {
	display: flex;
	align-items: center;
	gap: 6px;
}

.picker-section-title {
	font-weight: 600;
	font-size: 12px;
	color: var(--text);
}

.picker-control-row {
	display: flex;
	align-items: center;
	gap: 8px;
}

.picker-select {
	flex: 1;
	min-width: 0;
	height: 26px;
	padding: 2px 8px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--pane-soft);
	color: var(--text);
	font-size: 12px;
}

.picker-select:focus {
	outline: none;
	border-color: var(--accent);
}

.picker-select:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.use-btn {
	min-height: 26px;
	padding: 2px 12px;
	font-weight: 600;
	background: var(--accent);
	color: #fff;
	border-color: var(--accent);
}

.use-btn:hover:not(:disabled) {
	background: color-mix(in srgb, var(--accent) 85%, #000);
}

.use-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
	background: var(--pane);
	color: var(--muted);
	border-color: var(--line);
}

.picker-preview-card {
	background: var(--pane-soft);
	border: 1px solid var(--line);
	border-radius: 4px;
	padding: 8px 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.picker-preview-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	flex-wrap: wrap;
}

.picker-preview-meta {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.preview-name {
	font-weight: 650;
	font-size: 12px;
}

.preview-kind-badge.binding {
	background: color-mix(in srgb, var(--accent) 15%, var(--pane));
	border-color: var(--accent);
	color: var(--accent);
}

.picker-preview-tools {
	font-family: monospace;
	font-size: 11px;
	display: flex;
	gap: 8px;
}

.preview-tools-none {
	font-family: sans-serif;
	font-size: 11px;
	color: var(--muted);
}

.picker-problem-banner {
	padding: 4px 8px;
	font-size: 11px;
}

.picker-content-pre {
	margin: 2px 0 0;
	padding: 6px 8px;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 3px;
	font-family: monospace;
	font-size: 11px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 120px;
	overflow-y: auto;
}
.capabilities-diagnostics { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
.capabilities-diagnostics > summary { cursor:pointer; color:var(--muted); font-size:12px; }
.capabilities-diagnostics[open] > summary { margin-bottom:12px; }
.capabilities-delivery-summary { margin:0; font-size:12px; }
.capabilities-toggle-btn { flex-wrap:wrap; }
@media (max-width:700px) { .capabilities-toggle-btn .session-context { display:none; } }
</style>
