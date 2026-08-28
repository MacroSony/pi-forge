<script setup lang="ts">
import { ref, watch } from "vue";

import { t } from "../i18n.ts";
import type {
	EditorPromptStack,
	EditorRegexRule,
	PromptRegexRule,
} from "../types.ts";

type RegexStage = PromptRegexRule["stage"];
type RegexEffect = NonNullable<PromptRegexRule["effect"]>;
type RegexFrequency = NonNullable<PromptRegexRule["frequency"]>;
type RegexTarget = NonNullable<PromptRegexRule["targets"]>[number];

interface RegexRuleForm {
	key: number;
	original: EditorRegexRule;
	id: string;
	name: string;
	enabled: boolean;
	stage: RegexStage;
	effect: RegexEffect;
	frequency: RegexFrequency;
	flags: string;
	targets: RegexTarget[];
	roles: string[];
	maxMessages: string | number;
	maxChars: string | number;
	minDepth: string | number;
	maxDepth: string | number;
	trimStrings: string;
	pattern: string;
	replace: string;
}

const props = defineProps<{
	stack: EditorPromptStack;
}>();

const emit = defineEmits<{
	change: [error: string];
	validate: [];
}>();

const regexStages = ["history", "compiled"] as const satisfies readonly RegexStage[];
const regexEffects = ["outgoing", "finalize"] as const satisfies readonly RegexEffect[];
const regexFrequencies = ["turn", "request"] as const satisfies readonly RegexFrequency[];
const regexTargets = ["system", "messages"] as const satisfies readonly RegexTarget[];
const regexRoles = ["system", "user", "assistant", "custom", "toolResult"] as const;

let nextRowKey = 1;
const rows = ref(readStackRules());
const regexError = ref("");
let resettingFromStack = false;

watch(
	() => props.stack,
	() => {
		resettingFromStack = true;
		rows.value = readStackRules();
		regexError.value = "";
		resettingFromStack = false;
	},
	{ flush: "sync" },
);

watch(
	rows,
	() => {
		if (!resettingFromStack) syncRules();
	},
	{ deep: true, flush: "sync" },
);

function readStackRules(): RegexRuleForm[] {
	const candidate = props.stack.regex?.rules;
	if (!Array.isArray(candidate)) return [];
	return candidate.map((rule) => formFromRule(rule));
}

function formFromRule(rule: EditorRegexRule): RegexRuleForm {
	return {
		key: nextRowKey++,
		original: { ...rule },
		id: textValue(rule.id),
		name: textValue(rule.name),
		enabled: rule.enabled !== false,
		stage: selectedChoice(rule.stage, regexStages, "compiled"),
		effect: selectedChoice(rule.effect, regexEffects, "outgoing"),
		frequency: selectedChoice(rule.frequency, regexFrequencies, "turn"),
		flags: textValue(rule.flags),
		targets: selectedValues(rule.targets, regexTargets),
		roles: selectedValues(rule.roles, regexRoles),
		maxMessages: inputValue(rule.maxMessages),
		maxChars: inputValue(rule.maxChars),
		minDepth: inputValue(rule.minDepth),
		maxDepth: inputValue(rule.maxDepth),
		trimStrings: Array.isArray(rule.trimStrings) ? rule.trimStrings.join("\n") : "",
		pattern: textValue(rule.pattern),
		replace: textValue(rule.replace),
	};
}

function selectedChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
	return typeof value === "string" && choices.some((choice) => choice === value)
		? value as T
		: fallback;
}

function selectedValues<T extends string>(value: unknown, choices: readonly T[]): T[] {
	if (!Array.isArray(value)) return [];
	return choices.filter((choice) => value.includes(choice));
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function inputValue(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

function addRule(): void {
	rows.value = [...rows.value, formFromRule(defaultRegexRule())];
}

function deleteRule(index: number): void {
	rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index);
}

function moveRule(index: number, offset: -1 | 1): void {
	const destination = index + offset;
	if (destination < 0 || destination >= rows.value.length) return;
	const reordered = [...rows.value];
	[reordered[index], reordered[destination]] = [reordered[destination]!, reordered[index]!];
	rows.value = reordered;
}

function defaultRegexRule(): EditorRegexRule {
	return {
		id: uniqueRegexRuleId(),
		enabled: true,
		stage: "compiled",
		effect: "outgoing",
		targets: ["messages"],
		pattern: "",
		replace: "",
	};
}

function uniqueRegexRuleId(): string {
	const existing = new Set(rows.value.map((row) => row.id).filter(Boolean));
	let index = existing.size + 1;
	let id = `regex-${index}`;
	while (existing.has(id)) id = `regex-${++index}`;
	return id;
}

function syncRules(): void {
	const rules: EditorRegexRule[] = [];
	const seen = new Set<string>();
	const errors: string[] = [];

	rows.value.forEach((row, index) => {
		const rule = ruleFromForm(row);
		const label = rule.id || t("regex.ruleLabel", { index: index + 1 });
		if (!rule.id) errors.push(t("regex.errorId", { index: index + 1 }));
		else if (seen.has(rule.id)) errors.push(t("regex.errorDuplicateId", { id: rule.id }));
		seen.add(rule.id);
		if (!rule.pattern) errors.push(t("regex.errorPattern", { label }));
		if (hasInputValue(row.maxMessages) && !rule.maxMessages) {
			errors.push(t("regex.errorPositiveInteger", { label, field: "maxMessages" }));
		}
		if (hasInputValue(row.maxChars) && !rule.maxChars) {
			errors.push(t("regex.errorPositiveInteger", { label, field: "maxChars" }));
		}
		if (hasInputValue(row.minDepth) && rule.minDepth === undefined) {
			errors.push(t("regex.errorNonNegativeInteger", { label, field: "minDepth" }));
		}
		if (hasInputValue(row.maxDepth) && rule.maxDepth === undefined) {
			errors.push(t("regex.errorNonNegativeInteger", { label, field: "maxDepth" }));
		}
		if (
			rule.minDepth !== undefined
			&& rule.maxDepth !== undefined
			&& rule.maxDepth < rule.minDepth
		) {
			errors.push(t("regex.errorDepthOrder", { label }));
		}
		rules.push(rule);
	});

	if (rules.length > 0) {
		props.stack.regex = {
			...(props.stack.regex || {}),
			schemaVersion: props.stack.regex?.schemaVersion || 1,
			rules,
		};
	} else {
		delete props.stack.regex;
	}

	regexError.value = errors[0] || "";
	emit("change", regexError.value);
}

function ruleFromForm(form: RegexRuleForm): EditorRegexRule {
	const rule: Record<string, unknown> = { ...form.original };
	for (const key of [
		"id",
		"name",
		"enabled",
		"stage",
		"effect",
		"frequency",
		"pattern",
		"flags",
		"replace",
		"trimStrings",
		"roles",
		"targets",
		"maxMessages",
		"maxChars",
		"minDepth",
		"maxDepth",
	]) {
		delete rule[key];
	}

	rule.id = form.id.trim();
	setOptionalString(rule, "name", form.name);
	rule.enabled = form.enabled;
	rule.stage = form.stage || "compiled";
	rule.effect = form.effect || "outgoing";
	// frequency is only meaningful for outgoing rules; never write it for finalize.
	if (rule.effect !== "finalize") rule.frequency = form.frequency || "turn";
	rule.pattern = form.pattern;

	const flags = form.flags.trim();
	if (flags) rule.flags = flags;
	if (form.replace) rule.replace = form.replace;

	const trimStrings = form.trimStrings.split(/\r?\n/).filter((line) => line.length > 0);
	if (trimStrings.length > 0) rule.trimStrings = trimStrings;
	if (form.roles.length > 0) rule.roles = [...form.roles];
	if (form.targets.length > 0) rule.targets = [...form.targets];

	const maxMessages = positiveIntegerFromInput(form.maxMessages);
	const maxChars = positiveIntegerFromInput(form.maxChars);
	const minDepth = nonNegativeIntegerFromInput(form.minDepth);
	const maxDepth = nonNegativeIntegerFromInput(form.maxDepth);
	if (maxMessages) rule.maxMessages = maxMessages;
	if (maxChars) rule.maxChars = maxChars;
	if (minDepth !== undefined) rule.minDepth = minDepth;
	if (maxDepth !== undefined) rule.maxDepth = maxDepth;

	return rule as EditorRegexRule;
}

function positiveIntegerFromInput(value: string | number): number | undefined {
	if (!hasInputValue(value)) return undefined;
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeIntegerFromInput(value: string | number): number | undefined {
	if (!hasInputValue(value)) return undefined;
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function hasInputValue(value: string | number): boolean {
	return String(value ?? "").trim().length > 0;
}

function setOptionalString(target: Record<string, unknown>, key: string, value: string): void {
	const trimmed = value.trim();
	if (trimmed) target[key] = trimmed;
}

function warningForForm(form: RegexRuleForm): string {
	return regexRuleWarning(ruleFromForm(form));
}

function regexRuleWarning(rule: PromptRegexRule): string {
	if (rule.effect === "finalize") {
		return t("regex.warnFinalize");
	}
	if (typeof rule.replace === "string" && /\{\{\s*match\s*\}\}/i.test(rule.replace)) {
		return t("regex.warnMatch");
	}
	return "";
}

function serializeOriginal(rule: EditorRegexRule): string {
	return JSON.stringify(rule || {});
}

defineExpose({
	getError: () => regexError.value,
});
</script>

<template>
	<div class="tab-section">
		<div class="tab-section-title">{{ t("regex.title") }}</div>
		<div class="tab-section-meta">
			{{ t("regex.meta") }}
		</div>
		<div class="modal-toolbar">
			<button
				id="addRegexRuleBtn"
				data-icon="+"
				:title="t('regex.addRuleTitle')"
				type="button"
				@click="addRule"
			>
				{{ t("regex.addRule") }}
			</button>
			<button
				id="validateRegexRulesBtn"
				data-icon="!"
				:title="t('regex.validateTitle')"
				type="button"
				@click="emit('validate')"
			>
				{{ t("regex.validate") }}
			</button>
			<span class="modal-spacer"></span>
			<span class="modal-meta">{{ t("regex.saveNote") }}</span>
		</div>

		<div id="regexRows" class="data-table">
			<div
				v-for="(row, index) in rows"
				:key="row.key"
				class="data-row regex-row"
				data-regex-row
			>
				<div class="regex-controls">
					<button
						type="button"
						data-regex-up="true"
						data-icon="↑"
						:title="t('regex.upTitle')"
						@click="moveRule(index, -1)"
					>
						{{ t("regex.up") }}
					</button>
					<button
						type="button"
						data-regex-down="true"
						data-icon="↓"
						:title="t('regex.downTitle')"
						@click="moveRule(index, 1)"
					>
						{{ t("regex.down") }}
					</button>
				</div>

				<div class="regex-fields">
					<textarea
						data-regex-original
						hidden
						:value="serializeOriginal(row.original)"
					></textarea>
					<label class="checkline">
						<input v-model="row.enabled" type="checkbox" data-regex-enabled>
						{{ t("regex.enabled") }}
					</label>

					<div class="field">
						<label>{{ t("regex.id") }}</label>
						<input v-model="row.id" data-regex-id :placeholder="t('regex.idPlaceholder')">
					</div>
					<div class="field">
						<label>{{ t("regex.name") }}</label>
						<input v-model="row.name" data-regex-name :placeholder="t('regex.namePlaceholder')">
					</div>
					<div class="field">
						<label>{{ t("regex.stage") }}</label>
						<select v-model="row.stage" data-regex-stage>
							<option v-for="stage in regexStages" :key="stage" :value="stage">{{ stage }}</option>
						</select>
					</div>
					<div class="field">
						<label>{{ t("regex.effect") }}</label>
						<select v-model="row.effect" data-regex-effect>
							<option v-for="effect in regexEffects" :key="effect" :value="effect">{{ effect }}</option>
						</select>
					</div>
					<div v-show="row.effect !== 'finalize'" class="field">
						<label>{{ t("regex.frequency") }}</label>
						<select v-model="row.frequency" data-regex-frequency :title="t('regex.frequencyTitle')">
							<option v-for="frequency in regexFrequencies" :key="frequency" :value="frequency">{{ frequency }}</option>
						</select>
					</div>
					<div class="field">
						<label>{{ t("regex.flags") }}</label>
						<input v-model="row.flags" data-regex-flags :placeholder="t('regex.flagsPlaceholder')">
					</div>

					<div class="field span-2">
						<label>{{ t("regex.targets") }}</label>
						<div
							class="regex-checks"
							:title="t('regex.targetsTitle')"
						>
							<label v-for="target in regexTargets" :key="target">
								<input
									v-model="row.targets"
									type="checkbox"
									data-regex-target
									:value="target"
								>
								{{ target }}
							</label>
						</div>
					</div>
					<div class="field span-2">
						<label>{{ t("regex.roles") }}</label>
						<div
							class="regex-checks"
							:title="t('regex.rolesTitle')"
						>
							<label v-for="role in regexRoles" :key="role">
								<input
									v-model="row.roles"
									type="checkbox"
									data-regex-role
									:value="role"
								>
								{{ role }}
							</label>
						</div>
					</div>

					<div class="field">
						<label>{{ t("item.maxMessages") }}</label>
						<input
							v-model="row.maxMessages"
							type="number"
							min="1"
							data-regex-max-messages
						>
					</div>
					<div class="field">
						<label>{{ t("item.maxChars") }}</label>
						<input
							v-model="row.maxChars"
							type="number"
							min="1"
							data-regex-max-chars
						>
					</div>
					<div class="field">
						<label>{{ t("regex.minDepth") }}</label>
						<input
							v-model="row.minDepth"
							type="number"
							min="0"
							data-regex-min-depth
						>
					</div>
					<div class="field">
						<label>{{ t("regex.maxDepth") }}</label>
						<input
							v-model="row.maxDepth"
							type="number"
							min="0"
							data-regex-max-depth
						>
					</div>

					<div class="field span-2">
						<label>{{ t("regex.trimStrings") }}</label>
						<textarea
							v-model="row.trimStrings"
							data-regex-trim-strings
							spellcheck="false"
							:placeholder="t('regex.trimStringsPlaceholder')"
						></textarea>
					</div>
					<div class="field span-3">
						<label>{{ t("regex.pattern") }}</label>
						<textarea
							v-model="row.pattern"
							data-regex-pattern
							spellcheck="false"
							:placeholder="t('regex.patternPlaceholder')"
						></textarea>
					</div>
					<div class="field span-3">
						<label>{{ t("regex.replace") }}</label>
						<textarea
							v-model="row.replace"
							data-regex-replace
							spellcheck="false"
						></textarea>
					</div>

					<div
						v-show="warningForForm(row)"
						class="regex-warning wide"
						data-regex-warning
					>
						{{ warningForForm(row) }}
					</div>
				</div>

				<button
					type="button"
					class="danger"
					data-delete-row="true"
					data-icon="×"
					:title="t('regex.deleteTitle')"
					@click="deleteRule(index)"
				>
					{{ t("stackTab.deleteVariable") }}
				</button>
			</div>
		</div>
	</div>
</template>
