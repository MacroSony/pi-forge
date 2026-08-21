<script setup lang="ts">
import { reactive, ref, watch } from "vue";

import type { EditorPromptStack, WebEditorPolicyResource } from "../types.ts";

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
	{ kind: "tools", label: "Tools" },
	{ kind: "skills", label: "Skills" },
] as const;

const rows = reactive<Record<PolicyKind, PolicyRowState>>({
	tools: createRowState("tools"),
	skills: createRowState("skills"),
});
const policyError = ref("");

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
		if (duplicate) errors.push(`${kind}.${row.mode} has duplicate pattern: ${duplicate}`);

		const policy = { ...stackPolicyObject(kind) };
		delete policy.allow;
		delete policy.deny;
		if (row.mode === "allow" && patterns.length) policy.allow = patterns;
		if (row.mode === "deny" && patterns.length) policy.deny = patterns;
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
		return `Allow list active: ${patterns.length} pattern${patterns.length === 1 ? "" : "s"}.`;
	}
	if (mode === "allow" && patterns.length) return `Unrestricted ${kind}.`;
	if (mode === "deny" && patterns.length) {
		return `Deny list active: ${patterns.length} pattern${patterns.length === 1 ? "" : "s"}.`;
	}
	return `Unrestricted ${kind}.`;
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

function resourceTitle(resource: WebEditorPolicyResource): string {
	return [
		resource.description,
		resource.source ? `Source: ${resource.source}` : "",
		resource.active ? "Currently active" : "Registered, currently inactive; a specific allow list can activate it",
		resource.hidden ? "Hidden from model invocation" : "",
	].filter(Boolean).join("\n") || resource.name;
}

function resourceLabel(resource: WebEditorPolicyResource): string {
	const suffix = resource.active ? " *" : resource.hidden ? " hidden" : "";
	return resource.name + suffix;
}

defineExpose({
	getError: () => policyError.value,
	reset,
});
</script>

<template>
	<div class="tab-section">
		<div class="tab-section-title">Tool policy and skill visibility</div>
		<div class="tab-section-meta">
			A specific tool allow list selects from every registered tool and can activate tools that are currently inactive; deny rules constrain the current active-tool baseline. Skill rules only filter model-visible skills rendered by pi-forge; they do not block explicit skill invocation. Patterns support exact names and * wildcards.
		</div>
		<div id="policyRows" class="data-table">
			<div class="data-row header policy-row">
				<div>Resource</div>
				<div>Mode</div>
				<div>Patterns</div>
				<div>Available</div>
				<div>Status</div>
			</div>
			<div
				v-for="{ kind, label } in policyKinds"
				:key="kind"
				class="data-row policy-row"
				data-policy-row
				:data-policy-kind="kind"
				:data-policy-mode="rows[kind].mode"
			>
				<div>
					<div class="policy-title">{{ label }}</div>
					<div class="modal-meta">{{ kind }}</div>
				</div>
				<div class="field">
					<label>Mode</label>
					<div class="segmented policy-mode">
						<button
							v-for="option in [
								{ value: 'none', label: 'Unrestricted' },
								{ value: 'allow', label: 'Allow' },
								{ value: 'deny', label: 'Deny' },
							] as const"
							:key="option.value"
							type="button"
							:data-policy-mode-option="option.value"
							:class="{ active: rows[kind].mode === option.value }"
							@click="setMode(kind, option.value)"
						>
							{{ option.label }}
						</button>
					</div>
				</div>
				<div class="field">
					<label>Patterns</label>
					<div class="selected-patterns" data-selected-patterns>
						<span v-if="!selectedPatterns(kind).length" class="selected-pattern-empty">No selected patterns.</span>
						<button
							v-for="(pattern, index) in selectedPatterns(kind)"
							v-else
							:key="`${pattern}-${index}`"
							type="button"
							class="selected-pattern-chip"
							:data-remove-policy-pattern="pattern"
							title="Remove selected pattern"
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
					<label>Available {{ kind }}</label>
					<div v-if="props.resources[kind]?.length">
						<input
							class="resource-filter"
							data-resource-filter
							:list="`resource-options-${kind}`"
							placeholder="Type to filter or add"
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
								No matching unselected {{ kind }}.
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
					</div>
					<div v-else class="resource-empty">No registered {{ kind }} reported.</div>
				</div>
				<div class="policy-summary" data-policy-summary>{{ policySummary(kind) }}</div>
			</div>
		</div>
	</div>
</template>
