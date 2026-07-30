<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
import type {
	WebEditorProfileEntry,
	WebEditorProfileMutation,
	WebEditorSubagentSummary,
} from "../types.ts";

const TIMEOUT_MIN = 1_000;
const TIMEOUT_MAX = 3_600_000;

const props = defineProps<{
	entry: WebEditorProfileEntry;
	summary: WebEditorSubagentSummary;
	busy: boolean;
}>();
const emit = defineEmits<{
	"update:busy": [value: boolean];
	saved: [mutation: WebEditorProfileMutation, message: string];
	failed: [message: string];
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const enabled = ref(false);
const backend = ref("");
const timeoutText = ref("");
const localError = ref("");

watch(
	() => props.entry,
	(entry) => {
		enabled.value = entry.subagent.configured.enabled === true;
		backend.value = entry.subagent.configured.backend ?? "";
		timeoutText.value = entry.subagent.configured.timeoutMs?.toString() ?? "";
		localError.value = "";
	},
	{ immediate: true },
);

const timeoutValue = computed(() => {
	const text = timeoutText.value.trim();
	if (!text) return undefined;
	const parsed = Number(text);
	return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
});

const timeoutInvalid = computed(() => {
	if (timeoutValue.value === undefined) return false;
	return !Number.isSafeInteger(timeoutValue.value)
		|| (timeoutValue.value as number) < TIMEOUT_MIN
		|| (timeoutValue.value as number) > TIMEOUT_MAX;
});

const dirty = computed(() => {
	const configured = props.entry.subagent.configured;
	return enabled.value !== (configured.enabled === true)
		|| backend.value !== (configured.backend ?? "")
		|| timeoutText.value.trim() !== (configured.timeoutMs?.toString() ?? "");
});

const backendKnown = computed(() => {
	return !backend.value || props.summary.backends.some((option) => option.id === backend.value);
});

async function save(): Promise<void> {
	if (!dirty.value || timeoutInvalid.value || props.busy) return;
	localError.value = "";
	emit("update:busy", true);
	try {
		const result = await api<{ ok: true } & WebEditorProfileMutation>(
			`/api/profiles/${encodeURIComponent(props.entry.profile.id)}/subagent`,
			{
				method: "PUT",
				body: {
					enabled: enabled.value,
					backend: backend.value || null,
					timeoutMs: timeoutValue.value === undefined ? null : timeoutValue.value,
				},
			},
		);
		emit("saved", result, enabled.value
			? `Delegation enabled for ${props.entry.profile.id}`
			: `Delegation settings saved for ${props.entry.profile.id}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		localError.value = message;
		emit("failed", message);
	} finally {
		emit("update:busy", false);
	}
}
</script>

<template>
	<section class="profile-card delegation-card">
		<div class="profile-card-title">Delegation (experimental)</div>
		<div class="delegation-status" :class="{ ready: entry.subagent.enabled }" data-delegation-status>
			<template v-if="entry.subagent.enabled">
				Enabled · backend <code>{{ entry.subagent.backend }}</code> ({{ entry.subagent.backendSource }})
				· timeout {{ entry.subagent.timeoutMs }} ms ({{ entry.subagent.timeoutSource }})
			</template>
			<template v-else>
				Disabled — the main agent cannot delegate tasks to this profile.
			</template>
		</div>
		<div v-if="entry.subagent.enabled && !entry.subagent.backendRegistered" class="delegation-warning">
			Configured backend "{{ entry.subagent.backend }}" is not registered; planning and runs will fail.
		</div>

		<div class="delegation-form">
			<label class="delegation-check">
				<input id="delegationEnabled" v-model="enabled" type="checkbox" :disabled="busy">
				<span>
					<strong>Allow delegation to this profile</strong>
					<small>Exposes it to forge_subagent discovery and execution in this trusted project.</small>
				</span>
			</label>
			<label class="delegation-field">
				<span>Backend override</span>
				<select id="delegationBackend" v-model="backend" :disabled="busy">
					<option value="">Default ({{ summary.defaultBackend }} · {{ summary.defaultBackendSource }})</option>
					<option v-for="option in summary.backends" :key="option.id" :value="option.id">
						{{ option.id }} @ {{ option.version }}
					</option>
					<option v-if="!backendKnown" :value="backend">{{ backend }} (not registered)</option>
				</select>
			</label>
			<label class="delegation-field">
				<span>Timeout override (ms)</span>
				<input
					id="delegationTimeout"
					v-model="timeoutText"
					type="text"
					inputmode="numeric"
					:placeholder="`Default ${summary.timeoutMs} ms (${summary.timeoutSource})`"
					:disabled="busy"
					autocomplete="off"
				>
				<small>Best-effort host abort, {{ TIMEOUT_MIN }}–{{ TIMEOUT_MAX }} ms. Empty inherits the configured default.</small>
			</label>
			<div class="delegation-actions">
				<span v-if="timeoutInvalid" class="delegation-error" data-delegation-error>
					Timeout must be an integer from {{ TIMEOUT_MIN }} to {{ TIMEOUT_MAX }} ms.
				</span>
				<span v-else-if="localError" class="delegation-error" data-delegation-error>{{ localError }}</span>
				<span class="action-spacer"></span>
				<button
					id="delegationSaveBtn"
					type="button"
					class="primary"
					:disabled="busy || !dirty || timeoutInvalid"
					@click="save"
				>
					Save delegation
				</button>
			</div>
		</div>

		<div class="delegation-note">
			Read-only execution boundary: shared-user subprocess with stack-filtered read tools. Approval is required per
			run unless this trusted project sets <code>subagents.allowAgentInvocationWithoutApproval</code>
			<template v-if="summary.allowAgentInvocationWithoutApproval"> (currently <strong>on</strong>)</template>
			<template v-else> (currently off)</template>.
			Configure project defaults (<code>subagents.backend</code>, <code>subagents.timeoutMs</code>) in
			<code>.pi/forge/config.json</code>.
		</div>
		<div v-for="warning in summary.warnings" :key="warning" class="delegation-warning">{{ warning }}</div>
	</section>
</template>

<style scoped>
.delegation-status {
	font-size: 13px;
	color: var(--muted);
}

.delegation-status.ready {
	color: var(--success);
}

.delegation-warning {
	margin-top: 8px;
	border: 1px solid var(--warning);
	border-radius: 6px;
	padding: 6px 10px;
	background: var(--warning-bg);
	color: var(--warning);
	font-size: 12px;
}

.delegation-form {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin-top: 12px;
}

.delegation-check {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 10px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane-soft);
}

.delegation-check input {
	width: auto;
	margin-top: 3px;
}

.delegation-check span {
	display: flex;
	flex-direction: column;
}

.delegation-field {
	display: flex;
	flex-direction: column;
	gap: 5px;
	max-width: 480px;
}

.delegation-field > span {
	font-weight: 650;
}

.delegation-field small,
.delegation-check small {
	display: block;
	color: var(--muted);
	font-size: 12px;
}

.delegation-actions {
	display: flex;
	align-items: center;
	gap: 10px;
}

.delegation-error {
	color: var(--error);
	font-size: 12px;
}

.delegation-note {
	margin-top: 12px;
	color: var(--muted);
	font-size: 12px;
}
</style>
