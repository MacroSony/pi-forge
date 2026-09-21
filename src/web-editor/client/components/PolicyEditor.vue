<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { t, tp } from "../i18n.ts";
import { matchesAnyPattern, seedDefaultTools } from "../tool-picker-helpers.ts";
import type { EditorPromptStack, WebEditorPolicyResource } from "../types.ts";
import ToolPicker from "./ToolPicker.vue";

type PolicyKind = "tools" | "skills";
type PolicyMode = "none" | "allow" | "deny";
type PolicyObject = Record<string, unknown>;

interface PolicyRowState {
	mode: PolicyMode;
	patternsText: string;
	filter: string;
}

const props = defineProps<{
	stack: EditorPromptStack;
	resources: {
		tools: WebEditorPolicyResource[];
		skills: WebEditorPolicyResource[];
	};
}>();

const emit = defineEmits<{
	change: [error: string];
	status: [text: string, tone?: string];
}>();

const policyKinds = [
	{ kind: "tools" },
	{ kind: "skills" },
] as const;

function kindLabel(kind: PolicyKind): string {
	return t(kind === "tools" ? "policy.tools" : "policy.skills");
}

const rows = reactive<Record<PolicyKind, PolicyRowState>>({
	tools: createRowState("tools"),
	skills: createRowState("skills"),
});
const policyError = ref("");
const customDefaultsEnabled = ref(false);
const customDefaultTools = ref<string[]>([]);

function initCustomDefaults(): void {
	const policy = stackPolicyObject("tools");
	if (Array.isArray(policy.initial)) {
		customDefaultsEnabled.value = true;
		customDefaultTools.value = [...(policy.initial as string[])];
	} else {
		customDefaultsEnabled.value = false;
		customDefaultTools.value = [];
	}
}

initCustomDefaults();

watch(
	() => props.stack,
	() => reset(),
);

function createRowState(kind: PolicyKind): PolicyRowState {
	const policy = stackPolicyObject(kind);
	const mode = policyMode(policy);
	const patterns = mode === "deny" ? policy.deny : mode === "allow" ? policy.allow : [];
	return {
		mode,
		patternsText: policyPatternsToText(patterns),
		filter: "",
	};
}

function reset(): void {
	for (const { kind } of policyKinds) {
		Object.assign(rows[kind], createRowState(kind));
	}
	initCustomDefaults();
	policyError.value = "";
}

function stackPolicyObject(kind: PolicyKind): PolicyObject {
	const policy = props.stack[kind];
	return policy && typeof policy === "object" && !Array.isArray(policy)
		? policy as PolicyObject
		: {};
}

function policyMode(policy: PolicyObject): PolicyMode {
	const allow = Array.isArray(policy.allow) ? policy.allow : [];
	const deny = Array.isArray(policy.deny) ? policy.deny : [];
	if (deny.length && !allow.length) return "deny";
	if (allow.length) return "allow";
	return "none";
}

function policyPatternsToText(patterns: unknown): string {
	return Array.isArray(patterns) ? patterns.join("\n") : "";
}

function parsePolicyPatterns(value: unknown): string[] {
	return String(value || "")
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter(Boolean);
}

function selectedPatterns(kind: PolicyKind): string[] {
	const row = rows[kind];
	return row.mode === "none" ? [] : parsePolicyPatterns(row.patternsText);
}

function duplicatePolicyPattern(patterns: string[]): string {
	const seen = new Set<string>();
	for (const pattern of patterns) {
		if (seen.has(pattern)) return pattern;
		seen.add(pattern);
	}
	return "";
}

function setMode(kind: PolicyKind, mode: PolicyMode): void {
	const row = rows[kind];
	row.mode = mode;
	if (mode === "none") row.patternsText = "";
	syncPolicies();
}

function onPatternsInput(kind: PolicyKind, event: Event): void {
	rows[kind].patternsText = (event.target as HTMLTextAreaElement).value;
	syncPolicies();
}

function onFilterInput(kind: PolicyKind, event: Event): void {
	rows[kind].filter = (event.target as HTMLInputElement).value;
}

function addPolicyPattern(kind: PolicyKind, name: string): void {
	if (!name) return;
	const row = rows[kind];
	if (row.mode === "none") row.mode = "allow";
	const patterns = parsePolicyPatterns(row.patternsText);
	if (!patterns.includes(name)) patterns.push(name);
	row.patternsText = patterns.join("\n");
	row.filter = "";
	syncPolicies();
}

function removePolicyPattern(kind: PolicyKind, pattern: string): void {
	if (!pattern) return;
	rows[kind].patternsText = parsePolicyPatterns(rows[kind].patternsText)
		.filter((candidate) => candidate !== pattern)
		.join("\n");
	syncPolicies();
}

function addAutocompletePattern(kind: PolicyKind): void {
	const typed = rows[kind].filter.trim();
	if (!typed) return;
	const resources = availableResources(kind, typed);
	const exact = resources.find((resource) => resource.name.toLowerCase() === typed.toLowerCase());
	addPolicyPattern(kind, exact?.name || resources[0]?.name || typed);
}

function syncPolicies(): void {
	const errors: string[] = [];
	for (const { kind } of policyKinds) {
		const row = rows[kind];
		const patterns = row.mode === "none" ? [] : parsePolicyPatterns(row.patternsText);
		const duplicate = duplicatePolicyPattern(patterns);
		if (duplicate) errors.push(t("error.duplicatePattern", { kind, mode: row.mode, pattern: duplicate }));

		const policy = { ...stackPolicyObject(kind) };
		delete policy.allow;
		delete policy.deny;
		if (row.mode === "allow" && patterns.length) policy.allow = patterns;
		if (row.mode === "deny" && patterns.length) policy.deny = patterns;

		if (kind === "tools") {
			if (customDefaultsEnabled.value) {
				policy.initial = [...customDefaultTools.value];
			} else {
				delete policy.initial;
			}
		}

		if (Object.keys(policy).length) props.stack[kind] = policy;
		else delete props.stack[kind];
	}

	policyError.value = errors[0] || "";
	emit("change", policyError.value);
	if (policyError.value) emit("status", policyError.value, "error");
}

function policyPatternPlaceholder(mode: PolicyMode): string {
	if (mode === "allow") return "read\nbrowser-*";
	if (mode === "deny") return "browser-danger\nlegacy-*";
	return "";
}

function policySummary(kind: PolicyKind): string {
	const mode = rows[kind].mode;
	const patterns = mode === "none" ? [] : parsePolicyPatterns(rows[kind].patternsText);
	if (mode === "allow" && patterns.some((pattern) => pattern !== "*")) {
		return tp("policy.allowListActiveOne", "policy.allowListActiveMany", patterns.length);
	}
	if (mode === "allow" && patterns.length) return t("policy.unrestricted", { kind: kindLabel(kind) });
	if (mode === "deny" && patterns.length) {
		return tp("policy.denyListActiveOne", "policy.denyListActiveMany", patterns.length);
	}
	return t("policy.unrestricted", { kind: kindLabel(kind) });
}

function policyResourceMatchesFilter(resource: WebEditorPolicyResource, needle: string): boolean {
	return [resource.name, resource.description, resource.source]
		.filter(Boolean)
		.some((value) => String(value).toLowerCase().includes(needle));
}

function availableResources(kind: PolicyKind, filter = rows[kind].filter): WebEditorPolicyResource[] {
	const selected = new Set(selectedPatterns(kind));
	const needle = filter.trim().toLowerCase();
	return (props.resources[kind] || [])
		.filter((resource) => !selected.has(resource.name))
		.filter((resource) => !needle || policyResourceMatchesFilter(resource, needle));
}

function onToggleCustomDefaults(event: Event): void {
	const checked = (event.target as HTMLInputElement).checked;
	customDefaultsEnabled.value = checked;
	if (checked) {
		customDefaultTools.value = seedDefaultTools(
			props.resources.tools || [],
			rows.tools.mode,
			parsePolicyPatterns(rows.tools.patternsText),
		);
	} else {
		customDefaultTools.value = [];
	}
	syncPolicies();
}

function onCustomDefaultToolsChange(tools: string[]): void {
	customDefaultTools.value = tools;
	syncPolicies();
}

function removeDefaultTool(name: string): void {
	customDefaultTools.value = customDefaultTools.value.filter((t) => t !== name);
	syncPolicies();
}

function onPermittedToolsPickerChange(tools: string[]): void {
	rows.tools.patternsText = tools.join("\n");
	if (rows.tools.mode === "none" && tools.length > 0) {
		rows.tools.mode = "allow";
	}
	syncPolicies();
}

const permittedToolsForDefaults = computed(() => {
	const allTools = props.resources.tools || [];
	const patterns = parsePolicyPatterns(rows.tools.patternsText);
	if (rows.tools.mode === "allow" && patterns.length > 0) {
		return allTools.filter((t) => matchesAnyPattern(t.name, patterns));
	}
	if (rows.tools.mode === "deny" && patterns.length > 0) {
		return allTools.filter((t) => !matchesAnyPattern(t.name, patterns));
	}
	return allTools;
});

function resourceTitle(resource: WebEditorPolicyResource): string {
	return [
		resource.description,
		resource.source ? t("policy.sourceLabel", { source: resource.source }) : "",
		resource.active ? t("policy.currentlyActive") : t("policy.registeredInactive"),
		resource.hidden ? t("policy.hiddenFromModel") : "",
	].filter(Boolean).join("\n") || resource.name;
}

function resourceLabel(resource: WebEditorPolicyResource): string {
	const suffix = resource.active ? " *" : resource.hidden ? t("policy.suffixHidden") : "";
	return resource.name + suffix;
}

defineExpose({
	getError: () => policyError.value,
	reset,
});
</script>

<template>
	<div class="tab-section">
		<div class="tab-section-title">{{ t("policy.title") }}</div>
		<div class="tab-section-meta">
			{{ t("policy.meta") }}
		</div>
		<div id="policyRows" class="data-table">
			<div class="data-row header policy-row">
				<div>{{ t("policy.resource") }}</div>
				<div>{{ t("policy.mode") }}</div>
				<div>{{ t("policy.patterns") }}</div>
				<div>{{ t("policy.available") }}</div>
				<div>{{ t("policy.status") }}</div>
			</div>
			<div
				v-for="{ kind } in policyKinds"
				:key="kind"
				class="data-row policy-row"
				data-policy-row
				:data-policy-kind="kind"
				:data-policy-mode="rows[kind].mode"
			>
				<div>
					<div class="policy-title">{{ kindLabel(kind) }}</div>
					<div class="modal-meta">{{ kind }}</div>
				</div>
				<div class="field">
					<label>{{ t("policy.mode") }}</label>
					<div class="segmented policy-mode">
						<button
							v-for="option in [
								{ value: 'none', labelKey: 'policy.unrestrictedOption' },
								{ value: 'allow', labelKey: 'policy.allow' },
								{ value: 'deny', labelKey: 'policy.deny' },
							] as const"
							:key="option.value"
							type="button"
							:data-policy-mode-option="option.value"
							:class="{ active: rows[kind].mode === option.value }"
							@click="setMode(kind, option.value)"
						>
							{{ t(option.labelKey) }}
						</button>
					</div>
				</div>
				<div class="field">
					<label>{{ t("policy.patterns") }}</label>
					<div class="selected-patterns" data-selected-patterns>
						<span v-if="!selectedPatterns(kind).length" class="selected-pattern-empty">{{ t("policy.noPatterns") }}</span>
						<button
							v-for="(pattern, index) in selectedPatterns(kind)"
							v-else
							:key="`${pattern}-${index}`"
							type="button"
							class="selected-pattern-chip"
							:data-remove-policy-pattern="pattern"
							:title="t('policy.removePatternTitle')"
							@click="removePolicyPattern(kind, pattern)"
						>
							{{ pattern }}<span aria-hidden="true">x</span>
						</button>
					</div>
					<textarea
						class="policy-patterns"
						data-policy-patterns
						spellcheck="false"
						:placeholder="policyPatternPlaceholder(rows[kind].mode)"
						:disabled="rows[kind].mode === 'none'"
						:value="rows[kind].patternsText"
						@input="onPatternsInput(kind, $event)"
					></textarea>
				</div>
				<div class="resource-picker">
					<label>{{ t("policy.availableKind", { kind: kindLabel(kind) }) }}</label>
					<div v-if="kind === 'tools'" class="resource-picker-picker-row">
						<ToolPicker
							data-permitted-tools-picker
							:button-label="t('policy.choosePermittedTools')"
							:resources="props.resources.tools || []"
							:model-value="selectedPatterns('tools')"
							@update:model-value="onPermittedToolsPickerChange"
						/>
					</div>
					<div v-if="props.resources[kind]?.length">
						<details class="resource-flat-list-details" :open="kind !== 'tools'">
							<summary class="resource-flat-list-summary">{{ t("policy.allCatalogTools") }}</summary>
							<input
								class="resource-filter"
								data-resource-filter
								:list="`resource-options-${kind}`"
								:placeholder="t('policy.filterPlaceholder')"
								:value="rows[kind].filter"
								@input="onFilterInput(kind, $event)"
								@keydown.enter.prevent="addAutocompletePattern(kind)"
							>
							<datalist :id="`resource-options-${kind}`" data-resource-options>
								<option
									v-for="resource in availableResources(kind, '')"
									:key="resource.name"
									:value="resource.name"
								></option>
							</datalist>
							<div class="resource-list" data-resource-list>
								<div v-if="!availableResources(kind).length" class="resource-empty">
									{{ t("policy.noMatching", { kind: kindLabel(kind) }) }}
								</div>
								<button
									v-for="resource in availableResources(kind)"
									v-else
									:key="resource.name"
									type="button"
									class="resource-chip"
									:class="{ active: resource.active, hidden: resource.hidden }"
									:data-resource-name="resource.name"
									:title="resourceTitle(resource)"
									@click="addPolicyPattern(kind, resource.name)"
								>
									{{ resourceLabel(resource) }}
								</button>
							</div>
						</details>
					</div>
					<div v-else class="resource-empty">{{ t("policy.noRegistered", { kind: kindLabel(kind) }) }}</div>
				</div>
				<div class="policy-summary" data-policy-summary>{{ policySummary(kind) }}</div>
			</div>
		</div>

		<div class="custom-defaults-container" data-custom-defaults-section>
			<div class="custom-defaults-header">
				<label class="custom-defaults-toggle-label">
					<input
						type="checkbox"
						data-custom-defaults-toggle
						:checked="customDefaultsEnabled"
						@change="onToggleCustomDefaults"
					>
					<span class="custom-defaults-title">{{ t("policy.customDefaultsLabel") }}</span>
				</label>
				<span class="custom-defaults-help" data-custom-defaults-help>{{ t("policy.customDefaultsHelp") }}</span>
			</div>
			<div v-if="customDefaultsEnabled" class="custom-defaults-body" data-custom-defaults-body>
				<div class="custom-defaults-note" data-save-never-activates>
					{{ t("policy.saveNeverActivates") }}
				</div>
				<div class="custom-defaults-controls">
					<label class="compact-label">{{ t("policy.defaultTools") }}:</label>
					<div class="selected-patterns" data-selected-default-tools>
						<span v-if="!customDefaultTools.length" class="selected-pattern-empty" data-no-default-tools>
							{{ t("policy.noDefaultTools") }}
						</span>
						<button
							v-for="name in customDefaultTools"
							:key="name"
							type="button"
							class="selected-pattern-chip"
							:data-remove-default-tool="name"
							:title="t('policy.removePatternTitle')"
							@click="removeDefaultTool(name)"
						>
							{{ name }}<span aria-hidden="true">x</span>
						</button>
					</div>
					<ToolPicker
						data-default-tools-picker
						:button-label="t('policy.chooseDefaultTools')"
						:resources="permittedToolsForDefaults"
						v-model="customDefaultTools"
						@update:model-value="onCustomDefaultToolsChange"
					/>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.resource-picker-picker-row {
	margin-bottom: 6px;
}

.resource-flat-list-details {
	margin-top: 6px;
}

.resource-flat-list-summary {
	font-size: 11px;
	color: var(--muted);
	cursor: pointer;
	margin-bottom: 4px;
	user-select: none;
}

.resource-flat-list-summary:hover {
	color: var(--text);
}

.custom-defaults-container {
	margin-top: 16px;
	padding: 12px 16px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane-soft);
}

.custom-defaults-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px;
}

.custom-defaults-toggle-label {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-weight: 600;
	font-size: 13px;
	cursor: pointer;
}

.custom-defaults-help {
	font-size: 12px;
	color: var(--muted);
}

.custom-defaults-body {
	margin-top: 10px;
	padding-top: 10px;
	border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.custom-defaults-note {
	font-size: 11px;
	color: var(--muted);
}

.custom-defaults-controls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 10px;
}

.compact-label {
	font-size: 12px;
	font-weight: 600;
	color: var(--text);
}
</style>
