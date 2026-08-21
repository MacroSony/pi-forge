<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
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
	profileActionStatus.value = `${editorMode.value === "create" ? "Created" : "Saved"} ${profileSelectorLabel(saved)}`;
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
		profileActionStatus.value = `Applied ${target.profile.id} once`;
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
			profileActionError.value += ` Runtime refresh failed: ${detail}`;
		}
		window.dispatchEvent(new Event("pi-forge:profile-applied"));
	} finally {
		profileActionBusy.value = false;
	}
}

async function deleteSelectedProfile(): Promise<void> {
	const target = selected.value;
	if (!target) return;
	if (!window.confirm(`Delete agent profile ${target.profile.id}?\n\n${target.filePath}\n\nDelegation settings in subagents.json are managed by the optional pi-forge-subagents package and are not removed.`)) return;
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
		profileActionStatus.value = `Deleted ${target.profile.id}`;
	} catch (error) {
		profileActionError.value = error instanceof Error ? error.message : String(error);
	} finally {
		profileActionBusy.value = false;
	}
}

function modelLabel(model: { provider: string; id: string } | null): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function promptStackLabel(value: string | null): string {
	return value ?? "(none)";
}

function profileState(entry: WebEditorProfileEntry): string {
	if (entry.errors > 0) return `${entry.errors} error${entry.errors === 1 ? "" : "s"}`;
	if (entry.warnings > 0) return `${entry.warnings} warning${entry.warnings === 1 ? "" : "s"}`;
	return "ready";
}

function driftLabel(changed: boolean): string {
	return changed ? "drifted" : "unchanged";
}

function shadowRelationship(entry: WebEditorProfileEntry): string {
	const other = collection.value?.profiles.find((candidate) => candidate.profile.id === entry.profile.id && candidate.scope !== entry.scope);
	if (!other) return "";
	return entry.scope === "project" ? `shadows ${other.selector}` : `shadowed by ${other.selector}`;
}
</script>

<template>
	<section class="profile-surface">
		<header class="profile-toolbar">
			<div>
				<div class="profile-heading">Agent profiles</div>
				<div class="profile-subheading">
					One-shot model, thinking, and prompt-stack presets. Applying a profile does not continuously own runtime state.
				</div>
			</div>
			<span class="action-spacer"></span>
			<span id="profilesStatus" class="status">
				{{ loading || profileActionBusy ? "Working" : loadError || profileActionError || profileActionStatus || `${collection?.profiles.length || 0} profile(s)` }}
			</span>
			<select id="profileCreateScope" v-model="createScope" title="Scope for new profiles" :disabled="loading || profileActionBusy || !!editorMode">
				<option value="project">project</option>
				<option value="global">global</option>
			</select>
			<button
				id="profileNewBtn"
				data-icon="+"
				type="button"
				:disabled="loading || profileActionBusy || !!editorMode || !collection?.trusted"
				@click="startEditor('create')"
			>
				New profile
			</button>
			<button id="profileRefreshBtn" data-icon="↻" type="button" :disabled="loading || profileActionBusy || !!editorMode" @click="refreshProfiles">
				Refresh
			</button>
		</header>

		<div v-if="loadError" class="profile-message error">{{ loadError }}</div>
		<div v-else-if="collection && !collection.trusted" class="profile-message warning">
			This project is not trusted; only user-global agent profiles are shown and applying profiles is disabled.
		</div>
		<div v-if="collection" class="profile-layout">
			<aside class="profile-sidebar">
				<div class="side-head">
					<div class="side-title">Agent profiles</div>
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
							<span class="badge scope" :class="entry.scope">{{ entry.scope }}</span>
							<span v-if="shadowRelationship(entry)" class="badge shadow">{{ shadowRelationship(entry) }}</span>
							<span v-if="entry.profile.autoActivate" class="badge">auto</span>
							<span v-if="entry.lastApplied" class="badge">last applied</span>
						</span>
						<span class="profile-row-name">{{ entry.profile.name || "(unnamed)" }}</span>
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
						No agent profiles found.
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
								{{ selected.preview.applicable ? "Ready to apply" : "Preflight failed" }}
							</span>
							<button id="profileEditBtn" data-icon="✎" type="button" @click="startEditor('edit')">
								Edit
							</button>
							<button
								id="profileApplyBtn"
								class="primary"
								data-icon="▶"
								type="button"
								:disabled="profileActionBusy || !selected.preview.applicable"
								:title="selected.preview.applicable ? 'Apply this profile once' : 'Resolve preflight errors before applying'"
								@click="applySelectedProfile"
							>
								Apply once
							</button>
							<button
								id="profileDeleteBtn"
								class="danger"
								data-icon="×"
								type="button"
								:disabled="profileActionBusy"
								@click="deleteSelectedProfile"
							>
								Delete
							</button>
						</div>
						<p v-if="selected.profile.description" class="profile-description">
							{{ selected.profile.description }}
						</p>
					</section>

					<section class="profile-card">
						<div class="profile-card-title">One-shot transition</div>
						<div class="profile-transition-grid">
							<div class="profile-transition-head"></div>
							<div class="profile-transition-head">Current runtime</div>
							<div class="profile-transition-head">Profile target</div>
							<div>Model</div>
							<div>{{ modelLabel(selected.preview.current.model) }}</div>
							<div>{{ modelLabel(selected.preview.target.model) }}</div>
							<div>Thinking</div>
							<div>{{ selected.preview.current.thinkingLevel }}</div>
							<div>{{ selected.preview.target.thinkingLevel }}</div>
							<div>Prompt stack</div>
							<div>{{ promptStackLabel(selected.preview.current.promptStack) }}</div>
							<div>{{ promptStackLabel(selected.preview.target.promptStack) }}</div>
						</div>
						<div class="profile-detail-row">
							<span>Effective tools after stack policy</span>
							<code>{{ selected.preview.target.effectiveTools.join(", ") || "(none)" }}</code>
						</div>
					</section>

					<section class="profile-card">
						<div class="profile-card-title">Resolution diagnostics</div>
						<div class="profile-diagnostics">
							<div v-if="!selected.preview.diagnostics.length" class="diagnostic info">
								No diagnostics.
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
					Create a project profile here or capture the current runtime with <code>/profile save &lt;id&gt;</code>.
				</section>

				<section class="profile-card profile-runtime-card">
					<div class="profile-card-title">Runtime and provenance</div>
					<div class="profile-detail-row">
						<span>Current</span>
						<code>
							{{ modelLabel(collection.status.current.model) }} ·
							{{ collection.status.current.thinkingLevel }} ·
							{{ promptStackLabel(collection.status.current.promptStack) }}
						</code>
					</div>
					<template v-if="collection.status.lastApplied">
						<div class="profile-detail-row">
							<span>Last applied</span>
							<code>{{ collection.status.lastApplied.provenance.profileId }}</code>
						</div>
						<div class="profile-detail-row">
							<span>Source definition</span>
							<code>{{ collection.status.lastApplied.sourceState }}</code>
						</div>
						<div class="profile-drift">
							<span>Model: {{ driftLabel(collection.status.lastApplied.drift.model.changed) }}</span>
							<span>Thinking: {{ driftLabel(collection.status.lastApplied.drift.thinkingLevel.changed) }}</span>
							<span>Stack: {{ driftLabel(collection.status.lastApplied.drift.promptStack.changed) }}</span>
						</div>
					</template>
					<div v-else class="profile-note">No profile has been applied in this session.</div>
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
