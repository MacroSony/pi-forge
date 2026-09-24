<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import type { InstructionChoice, InstructionStateGuard, InstructionStateMutation, InstructionStateView } from "../../../instruction-state.ts";

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

interface InstructionAvailableResponse {
	ok: boolean;
	state: InstructionStateView;
	choices: InstructionChoice[];
}

const state = ref<InstructionStateView | null>(null);
const isExpanded = ref(false);
const isStale = ref(false);
const isMutating = ref(false);
const isRefreshing = ref(false);
const unavailable = ref(false);
const errorMessage = ref("");
const pendingResetGuard = ref<InstructionStateGuard | null>(null);

const availableChoices = ref<InstructionChoice[]>([]);
const availableLoaded = ref(false);
const isLoadingAvailable = ref(false);
const selectedKey = ref("");
const isUsing = ref(false);

const toggleBtnRef = ref<HTMLButtonElement | null>(null);
const closeBtnRef = ref<HTMLButtonElement | null>(null);
const drawerDialog = ref<HTMLDialogElement | null>(null);

let isMounted = false;
let requestIdSeq = 0;
let activeReadRequestId = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let backdropMouseDown = false;

function choiceKey(choice: { kind: string; id: string }): string {
	return `${choice.kind}:${choice.id}`;
}

const libraryChoices = computed(() => availableChoices.value.filter((c) => c.kind === "mode"));
const presetChoices = computed(() => availableChoices.value.filter((c) => c.kind === "binding"));

const selectedChoice = computed<InstructionChoice | null>(() => {
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

function guardsEqual(a: InstructionStateGuard | null | undefined, b: InstructionStateGuard | null | undefined): boolean {
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
	if (delivery === "prepared") return t("instructions.deliveryPrepared");
	if (delivery === "pending") return t("instructions.deliveryPending");
	if (delivery === "none") return t("instructions.deliveryNone");
	return delivery;
}

function presentationLabel(presentation: string | undefined): string {
	if (!presentation) return "";
	if (presentation === "native") return t("instructions.presentationNative");
	if (presentation === "user") return t("instructions.presentationUser");
	return presentation;
}

function setChoices(newChoices: InstructionChoice[]): void {
	const previous = selectedChoice.value;
	availableChoices.value = newChoices;
	if (selectedKey.value) {
		const match = newChoices.find((c) => choiceKey(c) === selectedKey.value);
		if (!match || match.fingerprint !== previous?.fingerprint) {
			selectedKey.value = "";
		}
	}
}

function applyState(newState: InstructionStateView, reqId: number, includesChoices = false): void {
	if (!isMounted) return;
	if (reqId !== requestIdSeq) return;

	const guardChanged = !guardsEqual(state.value?.guard, newState.guard);

	if (pendingResetGuard.value && !guardsEqual(newState.guard, pendingResetGuard.value)) {
		pendingResetGuard.value = null;
	}

	state.value = newState;
	unavailable.value = false;
	isStale.value = false;

	if (guardChanged && !includesChoices) {
		availableChoices.value = [];
		availableLoaded.value = false;
		selectedKey.value = "";
	}
}

async function fetchAvailable(_silent = false): Promise<void> {
	await fetchInstructions(true);
}

async function fetchInstructions(forceChoices = false): Promise<void> {
	if (!isMounted || isMutating.value || activeReadRequestId) return;
	const reqId = ++requestIdSeq;
	activeReadRequestId = reqId;
	isRefreshing.value = true;
	const withChoices = forceChoices || availableLoaded.value;
	isLoadingAvailable.value = withChoices;
	try {
		if (withChoices) {
			const res = await api<InstructionAvailableResponse>("/api/instructions/available");
			if (!isMounted || reqId !== requestIdSeq) return;
			if (!res?.ok || !res.state) throw new Error(t("instructions.unavailable"));
			applyState(res.state, reqId, true);
			setChoices(res.choices ?? []);
			availableLoaded.value = true;
		} else {
			const res = await api<{ ok: boolean; state: InstructionStateView }>("/api/instructions");
			if (!isMounted || reqId !== requestIdSeq) return;
			if (!res?.ok || !res.state) throw new Error(t("instructions.unavailable"));
			applyState(res.state, reqId);
		}
	} catch (error) {
		if (!isMounted || reqId !== requestIdSeq) return;
		isStale.value = true;
		pendingResetGuard.value = null;
		if (withChoices) errorMessage.value = error instanceof Error ? error.message : String(error);
		if (!state.value) unavailable.value = true;
	} finally {
		if (activeReadRequestId === reqId) {
			activeReadRequestId = 0;
			isRefreshing.value = false;
			isLoadingAvailable.value = false;
		}
	}
}

async function executeMutation(mutation: InstructionStateMutation): Promise<void> {
	if (isMutating.value || !isMounted) return;
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
		const res = await api<{ ok: boolean; state: InstructionStateView }>("/api/instructions", {
			method: "POST",
			body: mutation,
		});
		if (!isMounted || reqId !== requestIdSeq) return;
		if (!res?.ok || !res.state) throw new Error(t("instructions.unavailable"));
		applyState(res.state, reqId);
	} catch (error) {
		if (!isMounted) return;
		hasError = true;
		isStale.value = true;
		pendingResetGuard.value = null;
		errorMessage.value = error instanceof Error ? error.message : String(error);
	} finally {
		isMutating.value = false;
	}
	if (isMounted && reqId === requestIdSeq) {
		if (hasError) void fetchInstructions(refreshChoices);
		else if (refreshChoices) void fetchAvailable(true);
	}
}

async function handleUse(): Promise<void> {
	if (!state.value || !selectedChoice.value || !canUseSelected.value || isMutating.value || isUsing.value) return;

	const guard: InstructionStateGuard = {
		sessionId: state.value.guard.sessionId,
		leafId: state.value.guard.leafId,
		revision: state.value.guard.revision,
	};
	const { kind, id, fingerprint } = selectedChoice.value;

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
		const res = await api<{ ok: boolean; state: InstructionStateView }>("/api/instructions/use", {
			method: "POST",
			body: { guard, kind, id, fingerprint },
		});
		if (!isMounted || reqId !== requestIdSeq) return;
		if (!res?.ok || !res.state) throw new Error(t("instructions.unavailable"));
		applyState(res.state, reqId);
		selectedKey.value = "";
	} catch (error) {
		if (!isMounted) return;
		hasError = true;
		isStale.value = true;
		pendingResetGuard.value = null;
		errorMessage.value = error instanceof Error ? error.message : String(error);
	} finally {
		isMutating.value = false;
		isUsing.value = false;
	}

	// applyState invalidates old guarded choices. Refresh only after releasing
	// the mutation fence, remembering whether this drawer had loaded them.
	if (isMounted && reqId === requestIdSeq) {
		if (hasError) void fetchInstructions(refreshChoices);
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

async function handleDeactivate(activationId: string): Promise<void> {
	if (!state.value || !canMutate.value) return;
	const guard: InstructionStateGuard = {
		sessionId: state.value.guard.sessionId,
		leafId: state.value.guard.leafId,
		revision: state.value.guard.revision,
	};
	await executeMutation({ action: "off", activationId, guard });
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

function openDrawer(): void {
	if (isExpanded.value && drawerDialog.value?.open) return;
	isExpanded.value = true;
	if (drawerDialog.value && !drawerDialog.value.open) {
		drawerDialog.value.showModal();
	}
	nextTick(() => {
		closeBtnRef.value?.focus();
	});
}

function closeDrawer(): void {
	pendingResetGuard.value = null;
	isExpanded.value = false;
	if (drawerDialog.value?.open) {
		drawerDialog.value.close();
	}
	toggleBtnRef.value?.focus();
}

function toggleDrawer(): void {
	if (isExpanded.value) {
		closeDrawer();
	} else {
		openDrawer();
	}
}

function onDialogCancel(event: Event): void {
	event.preventDefault();
	closeDrawer();
}

function onDialogClose(): void {
	pendingResetGuard.value = null;
	if (isExpanded.value) {
		isExpanded.value = false;
	}
}

function onDialogMouseDown(event: MouseEvent): void {
	if (!drawerDialog.value) return;
	if (event.target === drawerDialog.value) {
		const rect = drawerDialog.value.getBoundingClientRect();
		const isInside =
			rect.top <= event.clientY &&
			event.clientY <= rect.bottom &&
			rect.left <= event.clientX &&
			event.clientX <= rect.right;
		backdropMouseDown = !isInside;
	} else {
		backdropMouseDown = false;
	}
}

function onDialogClick(event: MouseEvent): void {
	if (!drawerDialog.value) return;
	if (backdropMouseDown && event.target === drawerDialog.value) {
		const rect = drawerDialog.value.getBoundingClientRect();
		const isInside =
			rect.top <= event.clientY &&
			event.clientY <= rect.bottom &&
			rect.left <= event.clientX &&
			event.clientX <= rect.right;
		if (!isInside) {
			closeDrawer();
		}
	}
	backdropMouseDown = false;
}

watch(isExpanded, (expanded) => {
	if (!drawerDialog.value) return;
	if (expanded && !drawerDialog.value.open) {
		drawerDialog.value.showModal();
		nextTick(() => {
			closeBtnRef.value?.focus();
		});
	} else if (!expanded && drawerDialog.value.open) {
		drawerDialog.value.close();
		toggleBtnRef.value?.focus();
	}
});

function onVisibilityOrFocus(): void {
	if (!isMounted) return;
	if (document.visibilityState === "visible") {
		void fetchInstructions();
	}
}

function startPolling(): void {
	stopPolling();
	pollTimer = setInterval(() => {
		if (!isMounted) return;
		if (document.visibilityState === "visible") {
			void fetchInstructions();
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
	void fetchInstructions();
	startPolling();
	window.addEventListener("focus", onVisibilityOrFocus);
	document.addEventListener("visibilitychange", onVisibilityOrFocus);
});

onUnmounted(() => {
	isMounted = false;
	stopPolling();
	window.removeEventListener("focus", onVisibilityOrFocus);
	document.removeEventListener("visibilitychange", onVisibilityOrFocus);
});
onBeforeUnmount(() => { drawerDialog.value?.close(); });
</script>

<template>
	<aside
		class="session-instructions"
		:class="{ expanded: isExpanded, stale: isStale, unavailable }"
		:aria-label="t('instructions.title')"
		data-session-instructions
	>
		<!-- Compact summary header: globally visible above all surfaces -->
		<header class="instructions-header" data-session-summary aria-live="polite">
			<button
				ref="toggleBtnRef"
				type="button"
				class="instructions-toggle-btn"
				:aria-expanded="isExpanded"
				:title="t('instructions.toggleAria')"
				data-instructions-toggle
				@click="toggleDrawer"
			>
				<span class="toggle-icon">{{ isExpanded ? "▼" : "▶" }}</span>
				<span class="instructions-title">{{ t("instructions.title") }}</span>
				<span v-if="unavailable" class="instructions-badge unavailable-badge" data-instructions-unavailable>{{ t("instructions.unavailable") }}</span>
				<span v-else-if="state" class="instructions-badge active-badge" data-instructions-active-badge>{{ t(activeCount === 1 ? "instructions.activeCountOne" : "instructions.activeCount", { count: activeCount }) }}</span>
				<span v-if="state?.delivery && state.delivery !== 'none'" class="instructions-badge delivery-badge" :class="state.delivery" data-instructions-delivery-badge>{{ deliveryLabel(state.delivery) }}</span>
				<span v-if="state" class="session-context" :title="`${state.guard.sessionId}${state.guard.leafId ? ` · ${state.guard.leafId}` : ''}`" data-session-context>
					{{ t("instructions.session") }} {{ shortId(state.guard.sessionId) }}<template v-if="state.guard.leafId"> · {{ shortId(state.guard.leafId) }}</template>
				</span>
				<span v-if="state?.problem" class="instructions-badge problem-badge" :title="state.problem" data-instructions-problem-badge>⚠</span>
				<span v-if="errorMessage" class="instructions-badge error-badge" :title="errorMessage" data-instructions-error-badge>⚠</span>
				<span v-if="state?.restoring" class="instructions-badge restoring-badge" data-instructions-restoring-badge>⟳</span>
				<span v-if="state && !state.trusted" class="instructions-badge untrusted-badge" data-instructions-untrusted-badge>{{ t("instructions.untrustedBadge") }}</span>
				<span v-if="isStale" class="instructions-badge stale-badge" data-instructions-stale-badge>{{ t("instructions.staleBadge") }}</span>
			</button>

			<div class="header-actions">
				<span
					v-if="isRefreshing"
					class="instructions-badge refreshing-indicator"
					:title="t('instructions.refreshing')"
					data-instructions-summary-refreshing
				>
					⟳ {{ t("instructions.refreshing") }}
				</span>
			</div>
		</header>

		<!-- Right-hand overlay drawer for details and controls -->
		<dialog
			ref="drawerDialog"
			class="instructions-drawer"
			data-instructions-drawer
			aria-labelledby="instructions-drawer-title"
			@cancel="onDialogCancel"
			@close="onDialogClose"
			@mousedown="onDialogMouseDown"
			@click="onDialogClick"
		>
			<div class="drawer-inner">
				<header class="drawer-header">
					<div class="drawer-header-left">
						<h2 id="instructions-drawer-title" class="drawer-title">{{ t("instructions.title") }}</h2>
						<span
							v-if="state"
							class="session-context drawer-session-context"
							:title="`${state.guard.sessionId}${state.guard.leafId ? ` · ${state.guard.leafId}` : ''}`"
						>
							{{ t("instructions.session") }} {{ shortId(state.guard.sessionId) }}<template v-if="state.guard.leafId"> · {{ shortId(state.guard.leafId) }}</template>
						</span>
					</div>

					<div class="drawer-header-actions">
						<button
							type="button"
							class="action-btn refresh-btn"
							:disabled="isRefreshing || isMutating"
							:title="t('instructions.refresh')"
							data-instructions-refresh
							@click="() => fetchInstructions()"
						>
							{{ isRefreshing ? t("instructions.refreshing") : t("instructions.refresh") }}
						</button>

						<template v-if="state && !unavailable">
							<div v-if="pendingResetGuard" class="reset-confirm-group" data-instructions-reset-confirm-group>
								<span class="confirm-prompt">{{ t("instructions.confirmReset") }} ({{ t("instructions.session") }} {{ shortId(pendingResetGuard.sessionId) }})</span>
								<button
									type="button"
									class="action-btn danger-btn confirm-btn"
									:disabled="!canMutate"
									data-instructions-confirm-reset-btn
									@click="handleReset"
								>
									{{ t("instructions.confirm") }}
								</button>
								<button
									type="button"
									class="action-btn cancel-btn"
									data-instructions-cancel-reset-btn
									@click="cancelReset"
								>
									{{ t("instructions.cancel") }}
								</button>
							</div>
							<button
								v-else
								type="button"
								class="action-btn danger-btn reset-all-btn"
								:disabled="!canMutate || activeCount === 0"
								:title="t('instructions.resetAll')"
								data-instructions-reset-btn
								@click="promptReset"
							>
								{{ t("instructions.resetAll") }}
							</button>
						</template>

						<button
							ref="closeBtnRef"
							type="button"
							class="drawer-close-btn"
							:title="t('modal.closeTitle')"
							:aria-label="t('modal.close')"
							data-instructions-drawer-close
							@click="closeDrawer"
						>
							✕
						</button>
					</div>
				</header>

				<!-- Scrollable details body -->
				<div class="instructions-body" data-instructions-body>

					<!-- Warning & Error Banners -->
					<div v-if="errorMessage" class="instruction-banner error-banner" role="alert" data-instructions-error-banner>
						{{ errorMessage }}
					</div>
					<div v-if="state?.problem" class="instruction-banner problem-banner" role="alert" data-instructions-problem-banner>
						{{ t("instructions.problemWarning", { problem: state.problem }) }}
					</div>
					<div v-if="state?.restoring" class="instruction-banner restoring-banner" role="status" data-instructions-restoring-banner>
						{{ t("instructions.restoringWarning") }}
					</div>
					<div v-if="state && !state.trusted" class="instruction-banner untrusted-banner" role="alert" data-instructions-untrusted-banner>
						{{ t("instructions.untrustedWarning") }}
					</div>
					<div v-if="isStale" class="instruction-banner stale-banner" role="alert" data-instructions-stale-banner>
						{{ t("instructions.staleWarning") }}
					</div>

					<p v-if="state && state.delivery !== 'none'" class="instructions-delivery-summary">
						{{ t("instructions.delivery") }}: {{ deliveryLabel(state.delivery) }}
					</p>
					<div v-if="state?.delivery === 'prepared'" class="delivery-prepared-notice full-width" data-instructions-prepared-notice>
						{{ t("instructions.deliveryPreparedNote") }}
					</div>
					<!-- Active Items List -->
					<div v-if="state" class="instructions-active-section" data-instructions-active-section>
						<div v-if="state.active.length === 0" class="no-active-message" data-instructions-empty>
							{{ t("instructions.noActiveItems") }}
						</div>
						<div v-else class="active-items-list" data-instructions-items-list>
							<div
								v-for="item in state.active"
								:key="item.activationId"
								class="active-item-card"
								:data-activation-id="item.activationId"
							>
								<div class="item-card-header">
									<div class="item-title-group">
										<span class="item-name" data-item-name>{{ item.name || item.source }}</span>
										<span class="item-source-badge" :title="t('instructions.source')" data-item-source>
											{{ item.source }}
										</span>
										<span class="item-source-badge" :title="item.activationId" data-item-activation-id>#{{ shortId(item.activationId) }}</span>
										<span class="item-actor-badge" :title="t('instructions.actor')" data-item-actor>
											{{ item.actor === "user" ? t("instructions.actorUser") : t("instructions.actorAgent") }}
										</span>
									</div>

									<div class="item-tools-diff" data-item-tools-diff>
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
										class="action-btn deactivate-btn"
										:disabled="!canMutate"
										:title="t('instructions.deactivate')"
										data-item-deactivate-btn
										@click="handleDeactivate(item.activationId)"
									>
										{{ t("instructions.deactivate") }}
									</button>
								</div>

								<details class="item-content-details" data-item-content-details>
									<summary class="content-summary" data-item-content-summary>{{ t("instructions.viewContent") }}</summary>
									<pre class="item-content-pre" data-item-content-text>{{ item.content }}</pre>
								</details>
							</div>
						</div>
					</div>

					<!-- Human Activation Picker -->
					<div v-if="state" class="instructions-picker-section" data-instructions-picker-section>
						<div class="picker-section-header">
							<div class="picker-header-title-group">
								<span class="picker-section-title">{{ t("instructions.pickerTitle") }}</span>
								<span v-if="availableLoaded" class="instructions-badge picker-count-badge" data-instructions-picker-count>
									{{ availableChoices.length }}
								</span>
							</div>
							<button
								type="button"
								class="action-btn picker-refresh-btn"
								:disabled="isLoadingAvailable || isMutating || !canMutate"
								:title="t('instructions.refreshCatalog')"
								data-instructions-catalog-load
								data-instructions-picker-refresh
								@click="() => fetchAvailable()"
							>
								{{ isLoadingAvailable ? t("instructions.loadingCatalog") : (availableLoaded ? t("instructions.refreshCatalog") : t("instructions.loadCatalog")) }}
							</button>
						</div>

						<div class="picker-control-row">
							<select
								class="picker-select"
								v-model="selectedKey"
								:disabled="isLoadingAvailable || isMutating || isUsing || !canMutate"
								data-instructions-picker-select
								@focus="onSelectFocus"
								@click="onSelectClick"
							>
								<option value="" disabled>{{ availableLoaded ? t("instructions.selectChoice") : t("instructions.loadChoicesPrompt") }}</option>
								<optgroup v-if="libraryChoices.length" :label="t('instructions.kindLibraryUnbound')" data-picker-optgroup-library>
									<option
										v-for="choice in libraryChoices"
										:key="choiceKey(choice)"
										:value="choiceKey(choice)"
										data-picker-option
									>
										{{ choice.label }} ({{ choice.id }}){{ choice.problem ? ' ⚠' : '' }}
									</option>
								</optgroup>
								<optgroup v-if="presetChoices.length" :label="t('instructions.kindPresetBound')" data-picker-optgroup-preset>
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
								class="action-btn use-btn"
								:disabled="!canUseSelected"
								:title="t('instructions.useTitle')"
								data-instructions-use-btn
								@click="handleUse"
							>
								{{ isUsing ? t("instructions.using") : t("instructions.use") }}
							</button>
						</div>

						<!-- Selected Choice Literal Content / Tools / Problem Preview -->
						<div v-if="selectedChoice" class="picker-preview-card" data-instructions-picker-preview>
							<div class="picker-preview-header">
								<div class="picker-preview-meta">
									<span class="preview-name" data-picker-preview-label>{{ selectedChoice.label }}</span>
									<span class="item-source-badge preview-kind-badge" :class="selectedChoice.kind" data-picker-preview-kind>
										{{ selectedChoice.kind === "mode" ? t("instructions.kindLibraryBadge") : t("instructions.kindPresetBadge") }}
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
									>{{ t("instructions.noToolChanges") }}</span>
								</div>
							</div>

							<div v-if="selectedChoice.problem" class="instruction-banner problem-banner picker-problem-banner" role="alert" data-picker-preview-problem>
								{{ t("instructions.choiceProblem", { problem: selectedChoice.problem }) }}
							</div>

							<pre class="picker-content-pre" data-picker-preview-content>{{ selectedChoice.content }}</pre>
						</div>
					</div>

					<details v-if="state" class="instructions-diagnostics">
						<summary>{{ t("instructions.technicalDetails") }}</summary>
					<!-- Meta Status Bar -->
						<div v-if="state" class="instructions-meta-grid" data-instructions-meta-grid>
							<div class="meta-item">
								<span class="meta-label">{{ t("instructions.session") }}:</span>
								<span class="meta-value" :title="state.guard.sessionId" data-instructions-session-id>{{ shortId(state.guard.sessionId) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("instructions.branch") }}:</span>
								<span class="meta-value" :title="state.guard.leafId ?? 'null'" data-instructions-branch-id>{{ shortId(state.guard.leafId) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("instructions.revision") }}:</span>
								<span class="meta-value" :title="state.guard.revision" data-instructions-revision>{{ shortRevision(state.guard.revision) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("instructions.delivery") }}:</span>
								<span class="meta-value delivery-status" :class="state.delivery" data-instructions-delivery>{{ deliveryLabel(state.delivery) }}</span>
							</div>
							<div class="meta-item">
								<span class="meta-label">{{ t("instructions.textPresentation") }}:</span>
								<span class="meta-value" data-instructions-presentation>{{ presentationLabel(state.textPresentation) }}</span>
							</div>
							<div class="meta-item full-width">
								<span class="meta-label">{{ t("instructions.effectiveTools") }}:</span>
								<span v-if="state.effectiveTools?.length" class="tools-list" data-instructions-tools-list>
									<span v-for="tool in state.effectiveTools" :key="tool" class="tool-tag" data-instructions-tool-tag>
										{{ tool }}
									</span>
								</span>
								<span v-else class="meta-value" data-instructions-tools-none>{{ t("instructions.none") }}</span>
							</div>

						</div>

						<p class="instructions-notice" data-instructions-transport-warning>{{ t("instructions.transportCaution") }}</p>
					</details>
				</div>
			</div>
		</dialog>
	</aside>
</template>

<style scoped>
.session-instructions {
	flex: none;
	background: var(--pane);
	border-bottom: 1px solid var(--line);
	font-size: 13px;
	color: var(--text);
}

.instructions-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 10px;
	min-height: 22px;
	gap: 8px;
}

.instructions-toggle-btn {
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

.instructions-toggle-btn:hover {
	background: var(--pane-soft);
}

.toggle-icon {
	font-size: 10px;
	color: var(--muted);
}

.instructions-badge {
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

/* Drawer overlay styling */
.instructions-drawer {
	display: none;
	border: none;
	padding: 0;
	margin: 0 0 0 auto;
	background: transparent;
	color: inherit;
}

.instructions-drawer[open] {
	display: flex;
	flex-direction: column;
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	left: auto;
	width: min(680px, 95vw);
	height: 100vh;
	height: 100dvh;
	max-height: 100dvh;
	background: var(--pane);
	border-left: 1px solid var(--line);
	box-shadow: -4px 0 24px rgba(0, 0, 0, 0.25);
	z-index: 1000;
	outline: none;
	overflow: hidden;
}

.instructions-drawer::backdrop {
	background: rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(2px);
}

@media (max-width: 640px) {
	.instructions-drawer[open] {
		width: 100vw;
		max-width: 100vw;
		border-left: none;
	}
}

.drawer-inner {
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
	overflow: hidden;
}

.drawer-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
	flex-shrink: 0;
	gap: 10px;
}

.drawer-header-left {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	flex-wrap: wrap;
}

.drawer-title {
	margin: 0;
	font-size: 14px;
	font-weight: 650;
	color: var(--text);
	white-space: nowrap;
}

.drawer-session-context {
	font-size: 12px;
}

.drawer-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
	flex-wrap: wrap;
}

.drawer-close-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	padding: 0;
	border-radius: 4px;
	border: 1px solid var(--line);
	background: var(--pane-soft);
	color: var(--muted);
	font-size: 12px;
	cursor: pointer;
	line-height: 1;
}

.drawer-close-btn:hover {
	background: var(--pane);
	color: var(--text);
}

.instructions-body {
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

.instructions-meta-grid {
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

.instructions-picker-section {
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
.instructions-diagnostics { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
.instructions-diagnostics > summary { cursor:pointer; color:var(--muted); font-size:12px; }
.instructions-diagnostics[open] > summary { margin-bottom:12px; }
.instructions-delivery-summary { margin:0; font-size:12px; }
.instructions-toggle-btn { flex-wrap:wrap; }
@media (max-width:700px) { .instructions-toggle-btn .session-context { display:none; } }
</style>
