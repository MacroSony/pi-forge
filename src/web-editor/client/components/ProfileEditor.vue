<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { AgentProfile } from "../../../agent-profile.ts";
import { createEditorApi } from "../api.ts";
import type {
	WebEditorProfileCollection,
	WebEditorProfileMutation,
	WebEditorProfileValidation,
} from "../types.ts";

const props = defineProps<{
	mode: "create" | "edit";
	collection: WebEditorProfileCollection;
	source?: AgentProfile;
}>();
const emit = defineEmits<{
	cancel: [];
	saved: [mutation: WebEditorProfileMutation];
}>();

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);
const initial = props.source ?? defaultProfile();
const draft = reactive({
	id: initial.id,
	name: initial.name ?? "",
	description: initial.description ?? "",
	autoActivate: initial.autoActivate === true,
	provider: initial.model.provider,
	modelId: initial.model.id,
	thinkingLevel: initial.thinkingLevel,
	promptStack: initial.promptStack ?? "",
});
const validation = ref<WebEditorProfileValidation>();
const status = ref("");
const error = ref("");
const busy = ref(false);

const providerOptions = computed(() => {
	return [...new Set(props.collection.models.map((model) => model.provider))].sort();
});
const modelOptions = computed(() => {
	return props.collection.models
		.filter((model) => !draft.provider || model.provider === draft.provider)
		.sort((left, right) => left.id.localeCompare(right.id));
});
const promptStackOptions = computed(() => {
	const options = [...props.collection.promptStacks];
	if (draft.promptStack && !options.some((stack) => stack.id === draft.promptStack)) {
		options.push({ id: draft.promptStack });
	}
	return options.sort((left, right) => left.id.localeCompare(right.id));
});

watch(draft, () => {
	validation.value = undefined;
	status.value = "";
	error.value = "";
}, { deep: true });

function defaultProfile(): AgentProfile {
	const current = props.collection.status.current;
	const fallbackModel = current.model ?? props.collection.models.find((model) => model.available) ?? props.collection.models[0];
	return {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "",
		model: {
			provider: fallbackModel?.provider ?? "",
			id: fallbackModel?.id ?? "",
		},
		thinkingLevel: current.thinkingLevel,
		promptStack: current.promptStack,
	};
}

function profileFromDraft(): AgentProfile {
	return {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: draft.id.trim(),
		name: draft.name.trim() || undefined,
		description: draft.description.trim() || undefined,
		autoActivate: draft.autoActivate || undefined,
		model: {
			provider: draft.provider.trim(),
			id: draft.modelId.trim(),
		},
		thinkingLevel: draft.thinkingLevel,
		promptStack: draft.promptStack || null,
	};
}

const initialSnapshot = JSON.stringify(profileFromDraft());
const dirty = computed(() => JSON.stringify(profileFromDraft()) !== initialSnapshot);

function handleBeforeUnload(event: BeforeUnloadEvent): void {
	if (!dirty.value) return;
	event.preventDefault();
	event.returnValue = "";
}

onMounted(() => window.addEventListener("beforeunload", handleBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", handleBeforeUnload));

function requestCancel(): void {
	if (dirty.value && !window.confirm("Discard unsaved agent-profile changes?")) return;
	emit("cancel");
}

async function validateDraft(): Promise<WebEditorProfileValidation | undefined> {
	busy.value = true;
	error.value = "";
	status.value = "";
	try {
		const result = await api<WebEditorProfileValidation>("/api/profiles/validate", {
			method: "POST",
			body: {
				profile: profileFromDraft(),
				existingId: props.mode === "edit" ? props.source?.id : undefined,
			},
		});
		validation.value = result;
		status.value = result.errors
			? `${result.errors} validation error${result.errors === 1 ? "" : "s"}`
			: result.warnings
				? `Valid with ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`
				: "Valid and ready to apply";
		return result;
	} catch (caught) {
		error.value = caught instanceof Error ? caught.message : String(caught);
		return undefined;
	} finally {
		busy.value = false;
	}
}

async function saveDraft(): Promise<void> {
	busy.value = true;
	error.value = "";
	status.value = "";
	try {
		const profile = profileFromDraft();
		const path = props.mode === "create"
			? "/api/profiles"
			: `/api/profiles/${encodeURIComponent(props.source!.id)}`;
		const result = await api<{ ok: true } & WebEditorProfileMutation>(path, {
			method: props.mode === "create" ? "POST" : "PUT",
			body: { profile },
		});
		emit("saved", result);
	} catch (caught) {
		error.value = caught instanceof Error ? caught.message : String(caught);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<section class="profile-editor profile-card">
		<header class="profile-editor-head">
			<div>
				<div class="profile-editor-title">{{ mode === "create" ? "New agent profile" : `Edit ${source?.id}` }}</div>
				<div class="profile-editor-note">
					Profile application is preflighted separately; saving only updates the project-local definition.
				</div>
			</div>
			<span class="action-spacer"></span>
			<span v-if="dirty" class="profile-editor-dirty">Unsaved</span>
			<button id="profileCancelBtn" type="button" :disabled="busy" @click="requestCancel">Cancel</button>
			<button id="profileValidateBtn" data-icon="!" type="button" :disabled="busy" @click="validateDraft">
				Validate
			</button>
			<button id="profileSaveBtn" class="primary" data-icon="✓" type="button" :disabled="busy" @click="saveDraft">
				{{ mode === "create" ? "Create profile" : "Save profile" }}
			</button>
		</header>

		<div class="profile-form">
			<label class="profile-field">
				<span>Profile ID</span>
				<input
					id="profileId"
					v-model="draft.id"
					:readonly="mode === 'edit'"
					placeholder="reviewer"
					autocomplete="off"
				>
				<small>Letters, numbers, dots, underscores, and hyphens; immutable after creation.</small>
			</label>
			<label class="profile-field">
				<span>Name</span>
				<input id="profileName" v-model="draft.name" placeholder="Reviewer" autocomplete="off">
			</label>
			<label class="profile-field profile-field-wide">
				<span>Description</span>
				<textarea id="profileDescription" v-model="draft.description" placeholder="What this profile is for."></textarea>
			</label>
			<label class="profile-field">
				<span>Model provider</span>
				<input id="profileModelProvider" v-model="draft.provider" list="profileProviderOptions" autocomplete="off">
				<datalist id="profileProviderOptions">
					<option v-for="provider in providerOptions" :key="provider" :value="provider"></option>
				</datalist>
			</label>
			<label class="profile-field">
				<span>Model ID</span>
				<input id="profileModelId" v-model="draft.modelId" list="profileModelOptions" autocomplete="off">
				<datalist id="profileModelOptions">
					<option
						v-for="model in modelOptions"
						:key="`${model.provider}/${model.id}`"
						:value="model.id"
						:label="`${model.name || model.id}${model.available ? '' : ' (authentication unavailable)'}`"
					></option>
				</datalist>
			</label>
			<label class="profile-field">
				<span>Thinking level</span>
				<select id="profileThinkingLevel" v-model="draft.thinkingLevel">
					<option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option>
				</select>
			</label>
			<label class="profile-field">
				<span>Prompt stack</span>
				<select id="profilePromptStack" v-model="draft.promptStack">
					<option value="">(none)</option>
					<option v-for="stack in promptStackOptions" :key="stack.id" :value="stack.id">
						{{ stack.name ? `${stack.id} — ${stack.name}` : stack.id }}
					</option>
				</select>
			</label>
			<label class="profile-check profile-field-wide">
				<input id="profileAutoActivate" v-model="draft.autoActivate" type="checkbox">
				<span>
					<strong>Auto-activate on a fresh session</strong>
					<small>Only one project profile may request auto-activation.</small>
				</span>
			</label>
		</div>

		<div v-if="status || error" id="profileEditorStatus" class="profile-editor-status" :class="{ error: !!error }">
			{{ error || status }}
		</div>
		<div v-if="validation" class="profile-editor-validation">
			<div class="profile-editor-validation-summary" :class="{ error: validation.errors > 0, ready: validation.errors === 0 }">
				{{ validation.preview.applicable ? "Ready to apply" : "Preflight failed" }}
				· {{ validation.errors }} error(s) · {{ validation.warnings }} warning(s)
			</div>
			<div class="profile-diagnostics">
				<div v-if="!validation.diagnostics.length" class="diagnostic info">No diagnostics.</div>
				<div
					v-for="(diagnostic, index) in validation.diagnostics"
					:key="`${diagnostic.field || ''}-${index}-${diagnostic.message}`"
					class="diagnostic"
					:class="diagnostic.level"
				>
					<strong>{{ diagnostic.level.toUpperCase() }}{{ diagnostic.field ? ` · ${diagnostic.field}` : "" }}</strong>:
					{{ diagnostic.message }}
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
.profile-editor {
	max-width: 1050px;
}

.profile-editor-head {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	padding-bottom: 12px;
	border-bottom: 1px solid var(--line);
}

.profile-editor-title {
	font-size: 18px;
	font-weight: 700;
}

.profile-editor-note,
.profile-field small {
	display: block;
	color: var(--muted);
	font-size: 12px;
}

.profile-form {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 14px;
	margin-top: 14px;
}

.profile-field {
	display: flex;
	flex-direction: column;
	gap: 5px;
	min-width: 0;
}

.profile-field > span {
	font-weight: 650;
}

.profile-field-wide {
	grid-column: 1 / -1;
}

.profile-field textarea {
	min-height: 90px;
}

.profile-check {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 10px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane-soft);
}

.profile-check input {
	width: auto;
	margin-top: 3px;
}

.profile-check span {
	display: flex;
	flex-direction: column;
}

.profile-editor-status,
.profile-editor-validation {
	margin-top: 14px;
}

.profile-editor-status {
	color: var(--success);
}

.profile-editor-status.error,
.profile-editor-validation-summary.error {
	color: var(--error);
}

.profile-editor-dirty {
	border: 1px solid var(--warning);
	border-radius: 999px;
	padding: 2px 8px;
	background: var(--warning-bg);
	color: var(--warning);
	font-size: 12px;
}

.profile-editor-validation-summary.ready {
	color: var(--success);
}

.profile-editor-validation-summary {
	margin-bottom: 8px;
	font-weight: 650;
}

@media (max-width: 700px) {
	.profile-form {
		grid-template-columns: 1fr;
	}

	.profile-field-wide {
		grid-column: auto;
	}
}
</style>
