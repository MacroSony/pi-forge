<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
import { t, tp } from "../i18n.ts";
import type {
	WebEditorProfileCollection,
	WebEditorProfileEntry,
	WebEditorProfileMutation,
} from "../types.ts";
import ProfileEditor from "./ProfileEditor.vue";

const props = defineProps<{
	active: boolean;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);
const collection = ref<WebEditorProfileCollection>();
const selectedPath = ref("");
const loadError = ref("");
const loading = ref(false);
const editorMode = ref<"create" | "edit">();
const createScope = ref<"project" | "global">("project");
const profileActionStatus = ref("");
const profileActionError = ref("");
const profileActionBusy = ref(false);

function preferredProfilePath(entries: WebEditorProfileEntry[]): string {
	return (entries.find((entry) => entry.lastApplied)
		?? entries.find((entry) => entry.errors === 0)
		?? entries[0])?.filePath ?? "";
}

const selected = computed<WebEditorProfileEntry | undefined>(() => {
	const entries = collection.value?.profiles || [];
	return entries.find((entry) => entry.filePath === selectedPath.value)
		?? entries.find((entry) => entry.filePath === preferredProfilePath(entries))
		?? entries[0];
});

watch(
	() => props.active,
	(active) => {
		if (active) void loadProfiles();
	},
	{ immediate: true },
);

async function loadProfiles(reloadFromDisk = false): Promise<void> {
	loading.value = true;
	loadError.value = "";
	profileActionStatus.value = "";
	profileActionError.value = "";
	try {
		const next = await api<WebEditorProfileCollection>(
			reloadFromDisk ? "/api/profiles/reload" : "/api/profiles",
			reloadFromDisk ? { method: "POST" } : undefined,
		);
		collection.value = next;
		if (!next.profiles.some((entry) => entry.filePath === selectedPath.value)) {
			selectedPath.value = preferredProfilePath(next.profiles);
		}
		if (reloadFromDisk) editorMode.value = undefined;
	} catch (error) {
		loadError.value = error instanceof Error ? error.message : String(error);
	} finally {
		loading.value = false;
	}
}

function selectProfile(entry: WebEditorProfileEntry): void {
	if (entry.filePath === selected.value?.filePath) return;
	selectedPath.value = entry.filePath;
	editorMode.value = undefined;
	profileActionStatus.value = "";
	profileActionError.value = "";
}

function startEditor(mode: "create" | "edit"): void {
	editorMode.value = mode;
}

function refreshProfiles(): void {
	void loadProfiles(true);
}

function handleProfileSaved(mutation: WebEditorProfileMutation): void {
	collection.value = mutation.collection;
	selectedPath.value = mutation.selectedPath;
	const saved = mutation.collection.profiles.find((entry) => entry.filePath === mutation.selectedPath);
	profileActionStatus.value = t(editorMode.value === "create" ? "profiles.created" : "profiles.saved", { id: profileSelectorLabel(saved) });
	profileActionError.value = "";
	editorMode.value = undefined;
}

function profileSelectorLabel(entry: WebEditorProfileEntry | undefined): string {
	if (!entry) return "profile";
	return entry.scope === "global" ? entry.selector : entry.profile.id;
}

async function applySelectedProfile(): Promise<void> {
	const target = selected.value;
	if (!target) return;
	profileActionBusy.value = true;
	profileActionStatus.value = "";
	profileActionError.value = "";
	try {
		const result = await api<{ ok: true } & WebEditorProfileMutation>(
			`/api/profiles/${encodeURIComponent(target.selector)}/apply`,
			{ method: "POST" },
		);
		collection.value = result.collection;
		selectedPath.value = result.selectedPath;
		profileActionStatus.value = t("profiles.appliedOnce", { id: target.profile.id });
		window.dispatchEvent(new Event("pi-forge:profile-applied"));
	} catch (error) {
		profileActionError.value = error instanceof Error ? error.message : String(error);
		try {
			const refreshed = await api<WebEditorProfileCollection>("/api/profiles");
			collection.value = refreshed;
			if (!refreshed.profiles.some((entry) => entry.filePath === selectedPath.value)) {
				selectedPath.value = refreshed.profiles[0]?.filePath || "";
			}
		} catch (refreshError) {
			const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
			profileActionError.value += t("profiles.refreshFailed", { detail });
		}
		window.dispatchEvent(new Event("pi-forge:profile-applied"));
	} finally {
		profileActionBusy.value = false;
	}
}

async function deleteSelectedProfile(): Promise<void> {
	const target = selected.value;
	if (!target) return;
	if (!window.confirm(t("profiles.confirmDelete", { id: target.profile.id, path: target.filePath }))) return;
	profileActionBusy.value = true;
	profileActionStatus.value = "";
	profileActionError.value = "";
	try {
		const result = await api<{ ok: true } & WebEditorProfileMutation>(
			`/api/profiles/${encodeURIComponent(target.selector)}`,
			{ method: "DELETE" },
		);
		collection.value = result.collection;
		selectedPath.value = result.selectedPath;
		profileActionStatus.value = t("profiles.deleted", { id: target.profile.id });
	} catch (error) {
		profileActionError.value = error instanceof Error ? error.message : String(error);
	} finally {
		profileActionBusy.value = false;
	}
}

function modelLabel(model: { provider: string; id: string } | null): string {
	return model ? `${model.provider}/${model.id}` : t("common.none");
}

function promptStackLabel(value: string | null): string {
	return value ?? t("common.none");
}

function profileState(entry: WebEditorProfileEntry): string {
	if (entry.errors > 0) return tp("diag.errorOne", "diag.errorMany", entry.errors);
	if (entry.warnings > 0) return tp("diag.warningOne", "diag.warningMany", entry.warnings);
	return t("profiles.ready");
}

function driftLabel(changed: boolean): string {
	return changed ? t("profiles.drifted") : t("profiles.unchanged");
}

function shadowRelationship(entry: WebEditorProfileEntry): string {
	const other = collection.value?.profiles.find((candidate) => candidate.profile.id === entry.profile.id && candidate.scope !== entry.scope);
	if (!other) return "";
	return entry.scope === "project" ? t("profiles.shadows", { selector: other.selector }) : t("profiles.shadowedBy", { selector: other.selector });
}
</script>

<template>
	<section class="profile-surface">
		<header class="profile-toolbar">
			<div>
				<div class="profile-heading">{{ t("nav.profiles") }}</div>
				<div class="profile-subheading">
					{{ t("profiles.subheading") }}
				</div>
			</div>
			<span class="action-spacer"></span>
			<span id="profilesStatus" class="status">
				{{ loading || profileActionBusy ? t("profiles.working") : loadError || profileActionError || profileActionStatus || t("profiles.count", { count: collection?.profiles.length || 0 }) }}
			</span>
			<select id="profileCreateScope" v-model="createScope" :title="t('profiles.scopeTitle')" :disabled="loading || profileActionBusy || !!editorMode">
				<option value="project">{{ t("profiles.scopeProject") }}</option>
				<option value="global">{{ t("profiles.scopeGlobal") }}</option>
			</select>
			<button
				id="profileNewBtn"
				data-icon="+"
				type="button"
				:disabled="loading || profileActionBusy || !!editorMode || !collection?.trusted"
				@click="startEditor('create')"
			>
				{{ t("profiles.newProfile") }}
			</button>
			<button id="profileRefreshBtn" data-icon="↻" type="button" :disabled="loading || profileActionBusy || !!editorMode" @click="refreshProfiles">
				{{ t("profiles.refresh") }}
			</button>
		</header>

		<div v-if="loadError" class="profile-message error">{{ loadError }}</div>
		<div v-else-if="collection && !collection.trusted" class="profile-message warning">
			{{ t("profiles.untrustedWarning") }}
		</div>
		<div v-if="collection" class="profile-layout">
			<aside class="profile-sidebar">
				<div class="side-head">
					<div class="side-title">{{ t("nav.profiles") }}</div>
					<div class="cwd">{{ collection.profileDirectory }}</div>
				</div>
				<div class="profile-list">
					<button
						v-for="entry in collection.profiles"
						:key="entry.filePath"
						type="button"
						class="profile-row"
						:class="{ selected: selected?.filePath === entry.filePath }"
						:disabled="profileActionBusy || !!editorMode"
						data-profile-row
						:data-profile-id="entry.profile.id"
						:data-profile-selector="entry.selector"
						@click="selectProfile(entry)"
					>
						<span class="profile-row-title">
							{{ profileSelectorLabel(entry) }}
							<span class="badge scope" :class="entry.scope">{{ entry.scope === "global" ? t("chrome.scopeGlobal") : t("chrome.scopeProject") }}</span>
							<span v-if="shadowRelationship(entry)" class="badge shadow">{{ shadowRelationship(entry) }}</span>
							<span v-if="entry.profile.autoActivate" class="badge">{{ t("profiles.autoBadge") }}</span>
							<span v-if="entry.lastApplied" class="badge">{{ t("profiles.lastAppliedBadge") }}</span>
						</span>
						<span class="profile-row-name">{{ entry.profile.name || t("stackList.unnamed") }}</span>
						<span class="profile-row-meta">
							{{ modelLabel(entry.profile.model) }} · {{ entry.profile.thinkingLevel }}
						</span>
						<span
							class="profile-row-state"
							:class="{ error: entry.errors > 0, warning: !entry.errors && entry.warnings > 0, ready: !entry.errors && !entry.warnings }"
						>
							{{ profileState(entry) }}
						</span>
					</button>
					<div v-if="!collection.profiles.length" class="profile-empty">
						{{ t("profiles.empty") }}
					</div>
				</div>
			</aside>

			<main class="profile-main">
				<ProfileEditor
					v-if="editorMode"
					:key="`${editorMode}-${selected?.filePath || 'new'}`"
					:mode="editorMode"
					:collection="collection"
					:source="editorMode === 'edit' ? selected?.profile : undefined"
					:source-selector="editorMode === 'edit' ? selected?.selector : undefined"
					:create-scope="createScope"
					@cancel="editorMode = undefined"
					@saved="handleProfileSaved"
				/>
				<template v-else-if="selected">
					<section class="profile-card profile-summary-card">
						<div>
							<div class="profile-title">{{ selected.profile.name || selected.profile.id }}</div>
							<div class="profile-selector"><code>{{ selected.selector }}</code></div>
							<div class="profile-path">{{ selected.filePath }}</div>
						</div>
						<div class="profile-summary-actions">
							<span
								class="profile-applicability"
								:class="{ ready: selected.preview.applicable, error: !selected.preview.applicable }"
							>
								{{ selected.preview.applicable ? t("profiles.readyToApply") : t("profiles.preflightFailed") }}
							</span>
							<button id="profileEditBtn" data-icon="✎" type="button" @click="startEditor('edit')">
								{{ t("profiles.edit") }}
							</button>
							<button
								id="profileApplyBtn"
								class="primary"
								data-icon="▶"
								type="button"
								:disabled="profileActionBusy || !selected.preview.applicable"
								:title="selected.preview.applicable ? t('profiles.applyOnceTitle') : t('profiles.applyBlockedTitle')"
								@click="applySelectedProfile"
							>
								{{ t("profiles.applyOnce") }}
							</button>
							<button
								id="profileDeleteBtn"
								class="danger"
								data-icon="×"
								type="button"
								:disabled="profileActionBusy"
								@click="deleteSelectedProfile"
							>
								{{ t("common.delete") }}
							</button>
						</div>
						<p v-if="selected.profile.description" class="profile-description">
							{{ selected.profile.description }}
						</p>
					</section>

					<section class="profile-card">
						<div class="profile-card-title">{{ t("profiles.transition") }}</div>
						<div class="profile-transition-grid">
							<div class="profile-transition-head"></div>
							<div class="profile-transition-head">{{ t("profiles.currentRuntime") }}</div>
							<div class="profile-transition-head">{{ t("profiles.profileTarget") }}</div>
							<div>{{ t("profiles.model") }}</div>
							<div>{{ modelLabel(selected.preview.current.model) }}</div>
							<div>{{ modelLabel(selected.preview.target.model) }}</div>
							<div>{{ t("profiles.thinking") }}</div>
							<div>{{ selected.preview.current.thinkingLevel }}</div>
							<div>{{ selected.preview.target.thinkingLevel }}</div>
							<div>{{ t("profiles.promptStack") }}</div>
							<div>{{ promptStackLabel(selected.preview.current.promptStack) }}</div>
							<div>{{ promptStackLabel(selected.preview.target.promptStack) }}</div>
						</div>
						<div class="profile-detail-row">
							<span>{{ t("profiles.effectiveTools") }}</span>
							<code>{{ selected.preview.target.effectiveTools.join(", ") || t("common.none") }}</code>
						</div>
					</section>

					<section class="profile-card">
						<div class="profile-card-title">{{ t("profiles.resolutionDiagnostics") }}</div>
						<div class="profile-diagnostics">
							<div v-if="!selected.preview.diagnostics.length" class="diagnostic info">
								{{ t("diag.noDiagnostics") }}
							</div>
							<div
								v-for="(diagnostic, index) in selected.preview.diagnostics"
								:key="`${diagnostic.field || ''}-${index}-${diagnostic.message}`"
								class="diagnostic"
								:class="diagnostic.level"
							>
								<strong>{{ diagnostic.level.toUpperCase() }}{{ diagnostic.field ? ` · ${diagnostic.field}` : "" }}</strong>:
								{{ diagnostic.message }}
							</div>
						</div>
					</section>
				</template>

				<section v-else-if="!editorMode" class="profile-card profile-empty">
					{{ t("profiles.emptyMainPre") }}<code>/profile save &lt;id&gt;</code>{{ t("profiles.emptyMainPost") }}
				</section>

				<section class="profile-card profile-runtime-card">
					<div class="profile-card-title">{{ t("profiles.runtimeProvenance") }}</div>
					<div class="profile-detail-row">
						<span>{{ t("profiles.current") }}</span>
						<code>
							{{ modelLabel(collection.status.current.model) }} ·
							{{ collection.status.current.thinkingLevel }} ·
							{{ promptStackLabel(collection.status.current.promptStack) }}
						</code>
					</div>
					<template v-if="collection.status.lastApplied">
						<div class="profile-detail-row">
							<span>{{ t("profiles.lastApplied") }}</span>
							<code>{{ collection.status.lastApplied.provenance.profileId }}</code>
						</div>
						<div class="profile-detail-row">
							<span>{{ t("profiles.sourceDefinition") }}</span>
							<code>{{ collection.status.lastApplied.sourceState }}</code>
						</div>
						<div class="profile-drift">
							<span>{{ t("profiles.driftModel", { label: driftLabel(collection.status.lastApplied.drift.model.changed) }) }}</span>
							<span>{{ t("profiles.driftThinking", { label: driftLabel(collection.status.lastApplied.drift.thinkingLevel.changed) }) }}</span>
							<span>{{ t("profiles.driftStack", { label: driftLabel(collection.status.lastApplied.drift.promptStack.changed) }) }}</span>
						</div>
					</template>
					<div v-else class="profile-note">{{ t("profiles.noneApplied") }}</div>
				</section>
			</main>
		</div>
	</section>
</template>

<style scoped>
.profile-surface {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg);
}

.profile-toolbar {
	min-height: 64px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
	display: flex;
	align-items: center;
	gap: 10px;
}

.profile-toolbar .status {
	flex: 1 1 120px;
}

#profileCreateScope {
	flex: 0 0 auto;
	width: 110px;
}

.profile-heading {
	font-size: 17px;
	font-weight: 700;
}

.profile-subheading {
	color: var(--muted);
	font-size: 12px;
}

.profile-layout {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
}

.profile-sidebar {
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--line);
	background: var(--pane);
}

.profile-list {
	flex: 1;
	min-height: 0;
	padding: 8px;
	overflow: auto;
}

.profile-row {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	width: 100%;
	margin-bottom: 6px;
	padding: 9px;
	text-align: left;
	border-color: transparent;
	background: transparent;
}

.profile-row:hover {
	background: var(--control-muted);
}

.profile-row.selected {
	border-color: var(--accent);
	background: var(--accent-bg);
}

.profile-row-title {
	font-weight: 700;
}

.profile-row-name,
.profile-row-meta {
	color: var(--muted);
	font-size: 12px;
	overflow-wrap: anywhere;
}

.profile-row-state {
	align-self: flex-start;
	margin-top: 6px;
	font-size: 12px;
}

.profile-row-state.ready,
.profile-applicability.ready {
	color: var(--success);
}

.profile-row-state.warning {
	color: var(--warning);
}

.profile-row-state.error,
.profile-applicability.error {
	color: var(--error);
}

.profile-main {
	min-width: 0;
	min-height: 0;
	overflow: auto;
	padding: 16px;
}

.profile-card {
	max-width: 1050px;
	margin: 0 auto 14px;
	padding: 14px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--pane);
}

.profile-summary-card {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 8px 16px;
}

.profile-title {
	font-size: 19px;
	font-weight: 700;
}

.profile-selector,
.profile-path,
.profile-note {
	color: var(--muted);
	font-size: 12px;
	overflow-wrap: anywhere;
}

.profile-applicability {
	font-weight: 650;
}

.profile-summary-actions {
	display: flex;
	align-items: center;
	gap: 10px;
}

.profile-description {
	grid-column: 1 / -1;
	margin: 4px 0 0;
}

.profile-card-title {
	margin-bottom: 10px;
	font-weight: 700;
}

.profile-transition-grid {
	display: grid;
	grid-template-columns: minmax(100px, .7fr) repeat(2, minmax(180px, 1fr));
	gap: 1px;
	border: 1px solid var(--line);
	background: var(--line);
}

.profile-transition-grid > div {
	min-width: 0;
	padding: 8px;
	background: var(--pane);
	overflow-wrap: anywhere;
}

.profile-transition-head {
	color: var(--muted);
	font-size: 12px;
	font-weight: 650;
}

.profile-detail-row {
	display: grid;
	grid-template-columns: minmax(180px, .8fr) minmax(0, 2fr);
	gap: 12px;
	margin-top: 10px;
}

.profile-detail-row > span {
	color: var(--muted);
}

.profile-detail-row code {
	overflow-wrap: anywhere;
	white-space: normal;
}

.profile-drift {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 16px;
	margin-top: 10px;
	color: var(--muted);
	font-size: 12px;
}

.profile-message,
.profile-empty {
	padding: 20px;
	color: var(--muted);
}

.profile-message.error {
	color: var(--error);
}

.profile-message.warning {
	color: var(--warning);
}

@media (max-width: 800px) {
	.profile-layout {
		display: block;
		overflow: auto;
	}

	.profile-sidebar {
		border-right: 0;
		border-bottom: 1px solid var(--line);
	}

	.profile-list {
		flex: none;
		max-height: 35vh;
	}

	.profile-main {
		overflow: visible;
	}

	.profile-transition-grid {
		grid-template-columns: minmax(80px, .7fr) repeat(2, minmax(120px, 1fr));
		font-size: 12px;
	}
}
</style>
