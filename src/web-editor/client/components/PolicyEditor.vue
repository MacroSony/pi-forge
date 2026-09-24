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
	refreshResources?: () => void;
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
	<div class="policy-container">
		<details class="policy-intro">
			<summary class="tab-section-title">{{ t("policy.title") }}</summary>
			<p class="tab-section-meta help">
				{{ t("policy.meta") }}
			</p>
		</details>

		<!-- Card 1: Permission Ceiling (Tools) -->
		<div
			class="data-row policy-card policy-row"
			data-policy-row
			data-policy-kind="tools"
			:data-policy-mode="rows.tools.mode"
		>
			<div class="card-head">
				<div class="card-title">
					<h3>{{ t("polish.forms.policy.cardCeilingTitle") }}</h3>
					<span class="policy-summary count" data-policy-summary>{{ policySummary("tools") }}</span>
				</div>
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
						:class="{ active: rows.tools.mode === option.value, chosen: rows.tools.mode === option.value }"
						@click="setMode('tools', option.value)"
					>
						{{ t(option.labelKey) }}
					</button>
				</div>
			</div>
			<p class="card-description">{{ t("polish.forms.policy.cardCeilingDesc") }}</p>

			<div class="selection-row">
				<div class="chips selected-patterns" data-selected-patterns>
					<span v-if="!selectedPatterns('tools').length" class="selected-pattern-empty">
						{{ t("policy.noPatterns") }}
					</span>
					<button
						v-for="(pattern, index) in selectedPatterns('tools')"
						v-else
						:key="`${pattern}-${index}`"
						type="button"
						class="chip selected-pattern-chip"
						:data-remove-policy-pattern="pattern"
						:title="t('policy.removePatternTitle')"
						@click="removePolicyPattern('tools', pattern)"
					>
						{{ pattern }}<span class="chip-remove" aria-hidden="true">×</span>
					</button>
				</div>
				<div class="picker-action">
					<ToolPicker
						data-permitted-tools-picker
						:can-refresh="!!refreshResources"
						@refresh="refreshResources?.()"
						:button-label="rows.tools.mode === 'deny' ? t('polish.forms.policy.chooseDeniedTools') : t('policy.choosePermittedTools')"
						:resources="props.resources.tools || []"
						:model-value="selectedPatterns('tools')"
						@update:model-value="onPermittedToolsPickerChange"
					/>
				</div>
			</div>

			<details class="advanced">
				<summary>
					{{ t("polish.forms.policy.rawRulesAdvanced") }}
					<span class="advanced-sub">{{ t("polish.forms.policy.rawRulesHint") }}</span>
				</summary>
				<div class="advanced-body">
					<textarea
						class="policy-patterns"
						data-policy-patterns
						spellcheck="false"
						:placeholder="policyPatternPlaceholder(rows.tools.mode)"
						:disabled="rows.tools.mode === 'none'"
						:value="rows.tools.patternsText"
						@input="onPatternsInput('tools', $event)"
					></textarea>

					<div v-if="props.resources.tools?.length" class="resource-picker">
						<details class="resource-flat-list-details" :open="false">
							<summary class="resource-flat-list-summary">{{ t("policy.allCatalogTools") }}</summary>
							<input
								class="resource-filter"
								data-resource-filter
								:list="'resource-options-tools'"
								:placeholder="t('policy.filterPlaceholder')"
								:value="rows.tools.filter"
								@input="onFilterInput('tools', $event)"
								@keydown.enter.prevent="addAutocompletePattern('tools')"
							>
							<datalist id="resource-options-tools" data-resource-options>
								<option
									v-for="resource in availableResources('tools', '')"
									:key="resource.name"
									:value="resource.name"
								></option>
							</datalist>
							<div class="resource-list" data-resource-list>
								<div v-if="!availableResources('tools').length" class="resource-empty">
									{{ t("policy.noMatching", { kind: kindLabel('tools') }) }}
								</div>
								<button
									v-for="resource in availableResources('tools')"
									v-else
									:key="resource.name"
									type="button"
									class="resource-chip"
									:class="{ active: resource.active, hidden: resource.hidden }"
									:data-resource-name="resource.name"
									:title="resourceTitle(resource)"
									@click="addPolicyPattern('tools', resource.name)"
								>
									{{ resourceLabel(resource) }}
								</button>
							</div>
						</details>
					</div>
				</div>
			</details>
		</div>

		<!-- Card 2: Custom Default Base Opt-in Card -->
		<div class="policy-card custom-defaults-container" data-custom-defaults-section>
			<div class="card-head custom-defaults-header">
				<div class="card-title">
					<h3>{{ t("polish.forms.policy.cardDefaultsTitle") }}</h3>
					<span v-if="customDefaultsEnabled" class="count">
						{{ customDefaultTools.length }}
					</span>
				</div>
				<label class="switch-label custom-defaults-toggle-label">
					<input
						type="checkbox"
						data-custom-defaults-toggle
						:checked="customDefaultsEnabled"
						@change="onToggleCustomDefaults"
					>
					<span class="custom-defaults-title">{{ t("policy.customDefaultsLabel") }}</span>
				</label>
			</div>
			<p class="card-description custom-defaults-help" data-custom-defaults-help>
				{{ t("polish.forms.policy.cardDefaultsDesc") }}
			</p>

			<div v-if="customDefaultsEnabled" class="custom-defaults-body" data-custom-defaults-body>
				<div class="custom-defaults-note" data-save-never-activates>
					{{ t("policy.saveNeverActivates") }}
				</div>
				<div class="selection-row custom-defaults-controls">
					<div class="chips selected-patterns" data-selected-default-tools>
						<span v-if="!customDefaultTools.length" class="selected-pattern-empty" data-no-default-tools>
							{{ t("policy.noDefaultTools") }}
						</span>
						<button
							v-for="name in customDefaultTools"
							:key="name"
							type="button"
							class="chip selected-pattern-chip"
							:data-remove-default-tool="name"
							:title="t('policy.removePatternTitle')"
							@click="removeDefaultTool(name)"
						>
							{{ name }}<span class="chip-remove" aria-hidden="true">×</span>
						</button>
					</div>
					<div class="picker-action">
						<ToolPicker
							data-default-tools-picker
							:can-refresh="!!refreshResources"
							@refresh="refreshResources?.()"
							:button-label="t('policy.chooseDefaultTools')"
							:resources="permittedToolsForDefaults"
							v-model="customDefaultTools"
							@update:model-value="onCustomDefaultToolsChange"
						/>
					</div>
				</div>
			</div>

			<details class="advanced">
				<summary>{{ t("polish.forms.policy.defaultsRulesAdvanced") }}</summary>
				<p class="advanced-desc">{{ t("polish.forms.policy.defaultsRulesHint") }}</p>
			</details>
		</div>

		<!-- Skill listing visibility section (explicitly not sandbox/execution guard) -->
		<details
			class="skills policy-card data-row policy-row"
			data-policy-row
			data-policy-kind="skills"
			:data-policy-mode="rows.skills.mode"
		>
			<summary class="skills-summary">
				<span class="skills-title">{{ t("polish.forms.policy.skillsSectionTitle") }}</span>
				<span class="skills-sub">{{ t("polish.forms.policy.skillsSectionHint") }}</span>
			</summary>
			<div class="skills-body">
				<div class="card-head">
					<div class="card-title">
						<span class="policy-summary count" data-policy-summary>{{ policySummary("skills") }}</span>
					</div>
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
							:class="{ active: rows.skills.mode === option.value, chosen: rows.skills.mode === option.value }"
							@click="setMode('skills', option.value)"
						>
							{{ t(option.labelKey) }}
						</button>
					</div>
				</div>

				<div class="selection-row">
					<div class="chips selected-patterns" data-selected-patterns>
						<span v-if="!selectedPatterns('skills').length" class="selected-pattern-empty">
							{{ t("policy.noPatterns") }}
						</span>
						<button
							v-for="(pattern, index) in selectedPatterns('skills')"
							v-else
							:key="`${pattern}-${index}`"
							type="button"
							class="chip selected-pattern-chip"
							:data-remove-policy-pattern="pattern"
							:title="t('policy.removePatternTitle')"
							@click="removePolicyPattern('skills', pattern)"
						>
							{{ pattern }}<span class="chip-remove" aria-hidden="true">×</span>
						</button>
					</div>
				</div>

				<div class="advanced-body">
					<textarea
						class="policy-patterns"
						data-policy-patterns
						spellcheck="false"
						:placeholder="policyPatternPlaceholder(rows.skills.mode)"
						:disabled="rows.skills.mode === 'none'"
						:value="rows.skills.patternsText"
						@input="onPatternsInput('skills', $event)"
					></textarea>

					<div v-if="props.resources.skills?.length" class="resource-picker">
						<input
							class="resource-filter"
							data-resource-filter
							:list="'resource-options-skills'"
							:placeholder="t('policy.filterPlaceholder')"
							:value="rows.skills.filter"
							@input="onFilterInput('skills', $event)"
							@keydown.enter.prevent="addAutocompletePattern('skills')"
						>
						<datalist id="resource-options-skills" data-resource-options>
							<option
								v-for="resource in availableResources('skills', '')"
								:key="resource.name"
								:value="resource.name"
							></option>
						</datalist>
						<div class="resource-list" data-resource-list>
							<div v-if="!availableResources('skills').length" class="resource-empty">
								{{ t("policy.noMatching", { kind: kindLabel('skills') }) }}
							</div>
							<button
								v-for="resource in availableResources('skills')"
								v-else
								:key="resource.name"
								type="button"
								class="resource-chip"
								:class="{ active: resource.active, hidden: resource.hidden }"
								:data-resource-name="resource.name"
								:title="resourceTitle(resource)"
								@click="addPolicyPattern('skills', resource.name)"
							>
								{{ resourceLabel(resource) }}
							</button>
						</div>
					</div>
					<div v-else class="resource-empty">{{ t("policy.noRegistered", { kind: kindLabel('skills') }) }}</div>
				</div>
			</div>
		</details>
	</div>
</template>

<style scoped>
.policy-container {
	max-width: 1050px;
	margin-inline: auto;
	width: 100%;
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 8px 4px;
}

.policy-intro {
	margin-bottom: 4px;
}

.policy-card {
	display: block;
	background: var(--pane, #ffffff);
	border: 1px solid var(--line, #dfe7e4);
	border-radius: 8px;
	padding: 16px 20px;
	box-sizing: border-box;
}

.card-head {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 14px;
	flex-wrap: wrap;
}

.card-title {
	display: flex;
	gap: 10px;
	align-items: center;
}

.card-title h3 {
	margin: 0;
	font-size: 14px;
	font-weight: 650;
	color: var(--text, #20312f);
}

.count {
	font-size: 11px;
	color: var(--muted, #657774);
	border: 1px solid var(--line, #dfe7e4);
	padding: 1px 7px;
	border-radius: 10px;
	background: var(--bg, #f5f7f6);
}

.segmented {
	display: flex;
	border: 1px solid var(--line, #dfe7e4);
	border-radius: 6px;
	overflow: hidden;
	flex-shrink: 0;
}

.segmented button {
	border: 0;
	border-right: 1px solid var(--line, #dfe7e4);
	border-radius: 0;
	font-size: 12px;
	padding: 5px 10px;
	background: var(--pane, #fff);
	color: var(--text, #20312f);
	cursor: pointer;
}

.segmented button:last-child {
	border-right: 0;
}

.segmented button.chosen,
.segmented button.active {
	background: var(--accent-bg, #edf6f2);
	color: var(--accent, #176c5b);
	font-weight: 600;
}

.card-description {
	font-size: 12px;
	color: var(--muted, #657774);
	margin: 8px 0 14px;
	line-height: 1.5;
}

.selection-row {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 7px;
	flex: 1;
	min-width: 0;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	background: var(--accent-bg, #edf6f2);
	border: 1px solid #d5e3db;
	color: var(--accent, #176c5b);
	border-radius: 5px;
	padding: 3px 8px;
	font: 12px ui-monospace, Consolas, monospace;
	cursor: pointer;
}

.chip-remove {
	color: var(--muted, #8a9b93);
	font-family: system-ui, sans-serif;
	font-size: 12px;
}

.chip:hover .chip-remove {
	color: var(--text, #20312f);
}

.selected-pattern-empty {
	font-size: 12px;
	color: var(--muted, #657774);
	font-style: italic;
}

.picker-action {
	flex-shrink: 0;
}

.advanced {
	border-top: 1px solid var(--line, #dfe7e4);
	padding-top: 12px;
	margin-top: 16px;
	color: var(--muted, #657774);
	font-size: 12px;
}

.advanced summary {
	cursor: pointer;
	user-select: none;
	font-weight: 500;
}

.advanced-sub {
	font-size: 11px;
	margin-left: 8px;
	color: var(--muted, #8a9690);
}

.advanced-desc {
	margin: 8px 0 0;
	font-size: 11px;
	line-height: 1.6;
}

.advanced-body {
	margin-top: 12px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.policy-patterns {
	width: 100%;
	min-height: 80px;
	border: 1px solid var(--line, #dfe7e4);
	padding: 10px;
	border-radius: 5px;
	font: 12px/1.6 ui-monospace, monospace;
	box-sizing: border-box;
	background: var(--pane, #ffffff);
	color: var(--text, #20312f);
}

.policy-patterns:disabled {
	background: var(--bg, #f5f7f6);
	cursor: not-allowed;
}

.resource-flat-list-details {
	margin-top: 6px;
}

.resource-flat-list-summary {
	font-size: 11px;
	color: var(--muted, #657774);
	cursor: pointer;
	user-select: none;
}

.resource-filter {
	width: 100%;
	height: 32px;
	border: 1px solid var(--line, #dfe7e4);
	border-radius: 4px;
	padding: 4px 8px;
	margin-top: 6px;
	font-size: 12px;
	box-sizing: border-box;
}

.resource-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 8px;
	max-height: 160px;
	overflow-y: auto;
}

.resource-chip {
	font-size: 11px;
	padding: 3px 6px;
	border: 1px solid var(--line, #dfe7e4);
	border-radius: 4px;
	background: var(--pane, #ffffff);
	color: var(--text, #20312f);
	cursor: pointer;
}

.resource-chip.active {
	border-color: var(--accent, #176c5b);
	font-weight: 600;
}

.resource-chip.hidden {
	opacity: 0.6;
}

.resource-empty {
	font-size: 11px;
	color: var(--muted, #657774);
	font-style: italic;
	margin-top: 6px;
}

.switch-label input[type="checkbox"] { width: 14px; height: 14px; min-height: 14px; flex: 0 0 14px; }

.switch-label {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	font-size: 12px;
	cursor: pointer;
	user-select: none;
}

.custom-defaults-container {
	border-color: var(--line, #dfe7e4);
}

.custom-defaults-body {
	margin-top: 10px;
	padding-top: 10px;
	border-top: 1px solid color-mix(in srgb, var(--line, #dfe7e4) 60%, transparent);
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.custom-defaults-note {
	font-size: 11px;
	color: var(--muted, #657774);
}

.skills {
	padding: 14px 20px;
}

.skills-summary {
	cursor: pointer;
	user-select: none;
	font-size: 13px;
	font-weight: 600;
}

.skills-sub {
	font-size: 12px;
	font-weight: normal;
	color: var(--muted, #657774);
	margin-left: 12px;
}

.skills-body {
	margin-top: 14px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.policy-intro > summary { cursor:pointer; }
</style>
