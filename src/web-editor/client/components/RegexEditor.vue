<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

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
	unknownTargets?: string[];
	unknownRoles?: string[];
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

const regexRoot = ref<HTMLElement>();

const emit = defineEmits<{
	change: [error: string];
	validate: [];
}>();

const regexStages = ["history", "compiled"] as const satisfies readonly RegexStage[];
const regexEffects = ["outgoing", "finalize"] as const satisfies readonly RegexEffect[];
const regexFrequencies = ["turn", "request"] as const satisfies readonly RegexFrequency[];
const regexTargets = ["system", "messages"] as const satisfies readonly RegexTarget[];
const regexRoles = ["system", "user", "assistant", "custom", "toolResult"] as const;

type NumericLimit = "maxMessages" | "maxChars" | "minDepth" | "maxDepth";
// Presentation-only edit tracking: untouched invalid values must survive unrelated edits.
const editedLimits = new Map<number, Set<NumericLimit>>();
let nextRowKey = 1;
const rows = ref(readStackRules());
const regexError = ref("");
let resettingFromStack = false;

// Expansion state kept separate from deep-watched rows so fold/unfold never dirties
const expandedKeys = ref<Set<number>>(new Set());

function isExpanded(key: number): boolean {
	return expandedKeys.value.has(key);
}

function toggleExpanded(key: number): void {
	const next = new Set(expandedKeys.value);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	expandedKeys.value = next;
}

watch(
	() => props.stack,
	() => {
		resettingFromStack = true;
		editedLimits.clear();
		rows.value = readStackRules(rows.value);
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

function readStackRules(existingRows: RegexRuleForm[] = []): RegexRuleForm[] {
	const candidate = props.stack.regex?.rules;
	if (!Array.isArray(candidate)) return [];
	const used = new Set<number>();
	return candidate.map((rule, index) => {
		const matches = existingRows.filter((row) => !used.has(row.key) && row.id === rule.id);
		const positional = existingRows[index];
		const matched = matches.length === 1 ? matches[0]
			: positional && !used.has(positional.key) ? positional : undefined;
		const key = matched ? matched.key : nextRowKey++;
		used.add(key);
		return formFromRule(rule, key);
	});
}

function formFromRule(rule: EditorRegexRule, existingKey?: number): RegexRuleForm {
	const rawMaxMessages = inputValue(rule.maxMessages);
	const rawMaxChars = inputValue(rule.maxChars);
	const rawMinDepth = inputValue(rule.minDepth);
	const rawMaxDepth = inputValue(rule.maxDepth);

	return {
		key: existingKey ?? nextRowKey++,
		original: { ...rule },
		id: textValue(rule.id),
		name: textValue(rule.name),
		enabled: rule.enabled !== false,
		stage: selectedChoice(rule.stage, regexStages, typeof rule.stage === "string" ? rule.stage as RegexStage : "compiled"),
		effect: selectedChoice(rule.effect, regexEffects, typeof rule.effect === "string" ? rule.effect as RegexEffect : "outgoing"),
		frequency: selectedChoice(rule.frequency, regexFrequencies, typeof rule.frequency === "string" ? rule.frequency as RegexFrequency : "turn"),
		flags: textValue(rule.flags),
		targets: selectedValues(rule.targets, regexTargets),
		roles: selectedValues(rule.roles, regexRoles),
		unknownTargets: Array.isArray(rule.targets) ? rule.targets.filter((t) => typeof t === "string" && !regexTargets.includes(t as any)) : [],
		unknownRoles: Array.isArray(rule.roles) ? rule.roles.filter((r) => typeof r === "string" && !regexRoles.includes(r as any)) : [],
		maxMessages: rawMaxMessages,
		maxChars: rawMaxChars,
		minDepth: rawMinDepth,
		maxDepth: rawMaxDepth,
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

function setNumericInput(row: RegexRuleForm, key: NumericLimit, event: Event): void {
	const value = (event.target as HTMLInputElement).value;
	const changed = editedLimits.get(row.key) ?? new Set<NumericLimit>();
	changed.add(key);
	editedLimits.set(row.key, changed);
	if (row[key] === value) syncRules(); // Explicitly clearing an already-blank invalid value.
	else row[key] = value; // Existing synchronous row watcher owns writeback.
}

function addRule(): void {
	const newForm = formFromRule(defaultRegexRule());
	const next = new Set(expandedKeys.value);
	next.add(newForm.key);
	expandedKeys.value = next;
	rows.value = [...rows.value, newForm];
	void nextTick(() => {
		regexRoot.value?.querySelector<HTMLInputElement>("[data-regex-row]:last-child [data-regex-name]")?.focus();
	});
}

function deleteRule(index: number): void {
	const row = rows.value[index];
	if (!row) return;
	const label = row.name.trim() || row.id.trim() || t("polish.forms.regex.unnamedRule");
	if (!window.confirm(t("polish.forms.regex.confirmDelete", { name: label }))) return;
	editedLimits.delete(row.key);
	const next = new Set(expandedKeys.value);
	next.delete(row.key);
	expandedKeys.value = next;
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
		if (hasInputValue(row.maxMessages) && positiveIntegerFromInput(row.maxMessages) === undefined) {
			errors.push(t("regex.errorPositiveInteger", { label, field: "maxMessages" }));
		}
		if (hasInputValue(row.maxChars) && positiveIntegerFromInput(row.maxChars) === undefined) {
			errors.push(t("regex.errorPositiveInteger", { label, field: "maxChars" }));
		}
		if (hasInputValue(row.minDepth) && nonNegativeIntegerFromInput(row.minDepth) === undefined) {
			errors.push(t("regex.errorNonNegativeInteger", { label, field: "minDepth" }));
		}
		if (hasInputValue(row.maxDepth) && nonNegativeIntegerFromInput(row.maxDepth) === undefined) {
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

	const allRoles = [...form.roles, ...(form.unknownRoles || [])];
	if (allRoles.length > 0) rule.roles = allRoles;

	const allTargets = [...form.targets, ...(form.unknownTargets || [])];
	if (allTargets.length > 0) rule.targets = allTargets;

	for (const key of ["maxMessages", "maxChars", "minDepth", "maxDepth"] as const) {
		if (!editedLimits.get(form.key)?.has(key) && Object.hasOwn(form.original, key)) {
			rule[key] = form.original[key];
			continue;
		}
		const value = form[key];
		if (!hasInputValue(value)) continue;
		const parsed = key === "maxMessages" || key === "maxChars"
			? positiveIntegerFromInput(value) : nonNegativeIntegerFromInput(value);
		rule[key] = parsed ?? (Number.isNaN(Number(value)) ? value : Number(value));
	}

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

function truncate(text: string, maxLen: number): string {
	if (!text) return "";
	return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

defineExpose({
	getError: () => regexError.value,
});
</script>

<template>
	<div ref="regexRoot" class="tab-section regex-container">
		<div class="tab-section-title">{{ t("regex.title") }}</div>
		<div class="tab-section-meta">
			{{ t("regex.meta") }}
		</div>
		<div class="regex-save-note">{{ t("polish.forms.regex.saveHint") }}</div>

		<div id="regexRows" class="regex-cards-list">
			<div
				v-for="(row, index) in rows"
				:key="row.key"
				class="data-row regex-row regex-card"
				data-regex-row
			>
				<!-- Scan-first Card Header -->
				<div class="regex-card-head" @click="toggleExpanded(row.key)">
					<div class="regex-card-head-main">
						<label class="checkline" @click.stop>
							<input
								v-model="row.enabled"
								type="checkbox"
								data-regex-enabled
								:title="t('regex.enabled')"
								:aria-label="t('regex.enabled')"
							>
						</label>

						<div class="regex-card-titles">
							<span class="regex-card-title" data-regex-card-title>
								{{ row.name || row.id || t("polish.forms.regex.unnamedRule") }}
							</span>
							<span v-if="row.name && row.id" class="regex-card-id-sub">
								{{ row.id }}
							</span>
						</div>

						<span class="regex-summary-badge">
							{{ row.stage }} · {{ row.effect }}
						</span>

						<code class="regex-pattern-excerpt" data-regex-excerpt :title="row.pattern">
							{{ row.pattern ? truncate(row.pattern, 35) : t("polish.forms.regex.emptyPattern") }}
						</code>
					</div>

					<div class="regex-card-actions" @click.stop>
						<button
							type="button"
							class="text-btn icon-btn"
							data-regex-up="true"
							:disabled="index === 0"
							data-icon="↑"
							:title="t('regex.upTitle')"
							@click="moveRule(index, -1)"
						>
							{{ t("regex.up") }}
						</button>
						<button
							type="button"
							class="text-btn icon-btn"
							data-regex-down="true"
							:disabled="index === rows.length - 1"
							data-icon="↓"
							:title="t('regex.downTitle')"
							@click="moveRule(index, 1)"
						>
							{{ t("regex.down") }}
						</button>
						<button
							type="button"
							class="text-btn quiet-danger icon-btn"
							data-delete-row="true"
							data-icon="×"
							:title="t('regex.deleteTitle')"
							@click="deleteRule(index)"
						>
							{{ t("polish.forms.regex.delete") }}
						</button>
						<button
							type="button"
							class="regex-toggle-btn"
							data-regex-toggle
							:aria-expanded="isExpanded(row.key)"
							:aria-controls="'regex-body-' + row.key"
							:title="t('polish.forms.regex.scanCardToggle')"
							@click="toggleExpanded(row.key)"
						>
							{{ isExpanded(row.key) ? t("polish.forms.regex.collapse") : t("polish.forms.regex.expand") }}
						</button>
					</div>
				</div>

				<!-- Expanded Card Body -->
				<div
					v-if="isExpanded(row.key)"
					:id="'regex-body-' + row.key"
					class="regex-card-body"
					data-regex-body
				>
					<textarea
						data-regex-original
						hidden
						:value="serializeOriginal(row.original)"
					></textarea>

					<div class="regex-primary-fields">
						<div class="field">
							<label>{{ t("regex.name") }}</label>
							<input v-model="row.name" data-regex-name :placeholder="t('regex.namePlaceholder')">
						</div>
						<div class="field">
							<label>{{ t("regex.id") }}</label>
							<input v-model="row.id" data-regex-id :placeholder="t('regex.idPlaceholder')">
						</div>
						<div class="field span-full">
							<label>{{ t("regex.pattern") }}</label>
							<textarea
								v-model="row.pattern"
								data-regex-pattern
								spellcheck="false"
								:placeholder="t('regex.patternPlaceholder')"
							></textarea>
						</div>
						<div class="field span-full">
							<label>{{ t("regex.replace") }}</label>
							<textarea
								v-model="row.replace"
								data-regex-replace
								spellcheck="false"
							></textarea>
						</div>
					</div>

					<!-- Advanced technical limits, targets and roles -->
					<details class="advanced regex-advanced">
						<summary class="regex-advanced-summary">
							{{ t("polish.forms.regex.scanAdvanced") }}
						</summary>
						<div class="regex-advanced-grid">
							<div class="field">
								<label>{{ t("regex.stage") }}</label>
								<select v-model="row.stage" data-regex-stage>
									<option v-if="!regexStages.includes(row.stage as any)" :value="row.stage">{{ row.stage }}</option>
									<option v-for="stage in regexStages" :key="stage" :value="stage">{{ stage }}</option>
								</select>
							</div>
							<div class="field">
								<label>{{ t("regex.effect") }}</label>
								<select v-model="row.effect" data-regex-effect>
									<option v-if="!regexEffects.includes(row.effect as any)" :value="row.effect">{{ row.effect }}</option>
									<option v-for="effect in regexEffects" :key="effect" :value="effect">{{ effect }}</option>
								</select>
							</div>
							<div v-show="row.effect !== 'finalize'" class="field">
								<label>{{ t("regex.frequency") }}</label>
								<select v-model="row.frequency" data-regex-frequency :title="t('regex.frequencyTitle')">
									<option v-if="!regexFrequencies.includes(row.frequency as any)" :value="row.frequency">{{ row.frequency }}</option>
									<option v-for="frequency in regexFrequencies" :key="frequency" :value="frequency">{{ frequency }}</option>
								</select>
							</div>
							<div class="field">
								<label>{{ t("regex.flags") }}</label>
								<input v-model="row.flags" data-regex-flags :placeholder="t('regex.flagsPlaceholder')">
							</div>

							<div class="field span-2">
								<label>{{ t("regex.targets") }}</label>
								<div class="regex-checks" :title="t('regex.targetsTitle')">
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
								<div class="regex-checks" :title="t('regex.rolesTitle')">
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
									:value="row.maxMessages"
									@input="setNumericInput(row, 'maxMessages', $event)"
									type="number"
									min="1"
									data-regex-max-messages
								>
							</div>
							<div class="field">
								<label>{{ t("item.maxChars") }}</label>
								<input
									:value="row.maxChars"
									@input="setNumericInput(row, 'maxChars', $event)"
									type="number"
									min="1"
									data-regex-max-chars
								>
							</div>
							<div class="field">
								<label>{{ t("regex.minDepth") }}</label>
								<input
									:value="row.minDepth"
									@input="setNumericInput(row, 'minDepth', $event)"
									type="number"
									min="0"
									data-regex-min-depth
								>
							</div>
							<div class="field">
								<label>{{ t("regex.maxDepth") }}</label>
								<input
									:value="row.maxDepth"
									@input="setNumericInput(row, 'maxDepth', $event)"
									type="number"
									min="0"
									data-regex-max-depth
								>
							</div>

							<div class="field span-full">
								<label>{{ t("regex.trimStrings") }}</label>
								<textarea
									v-model="row.trimStrings"
									data-regex-trim-strings
									spellcheck="false"
									:placeholder="t('regex.trimStringsPlaceholder')"
								></textarea>
							</div>
						</div>
					</details>

					<div
						v-show="warningForForm(row)"
						class="regex-warning wide"
						data-regex-warning
					>
						{{ warningForForm(row) }}
					</div>
				</div>
			</div>
		</div>
		<button
			id="addRegexRuleBtn"
			class="regex-add-row"
			data-icon="+"
			:title="t('regex.addRuleTitle')"
			type="button"
			@click="addRule"
		>
			{{ t("regex.addRule") }}
		</button>
	</div>
</template>

<style scoped>
.regex-container {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 8px 4px;
}

.regex-save-note {
	font-size: 12px;
	color: var(--muted, #657774);
}

.regex-cards-list {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-top: 8px;
}

.regex-add-row {
	width: 100%;
	margin-top: 2px;
	padding: 9px;
	border: 1px dashed var(--accent);
	border-radius: 6px;
	background: transparent;
	color: var(--accent);
	font-weight: 650;
}

.regex-add-row:hover {
	background: var(--accent-bg);
}

.regex-card {
	align-items: stretch;
	display: flex;
	flex-direction: column;
	background: var(--pane, #ffffff);
	border: 1px solid var(--line, #dfe7e4);
	border-radius: 8px;
	overflow: hidden;
	transition: border-color 0.15s ease;
}

.regex-card:hover {
	border-color: #b5ccc3;
}

.regex-card-head {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 14px;
	background: var(--pane, #ffffff);
	cursor: pointer;
	user-select: none;
	gap: 12px;
	flex-wrap: wrap;
}

.regex-card-head-main {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	flex: 1;
	min-width: 0;
}

.regex-card-titles {
	display: flex;
	align-items: baseline;
	gap: 6px;
}

.regex-card-title {
	font-weight: 650;
	font-size: 13px;
	color: var(--text, #20312f);
}

.regex-card-id-sub {
	font-size: 11px;
	color: var(--muted, #657774);
	font-family: ui-monospace, Consolas, monospace;
}

.regex-summary-badge {
	font-size: 11px;
	color: var(--muted, #657774);
	background: var(--bg, #f5f7f6);
	border: 1px solid var(--line, #dfe7e4);
	padding: 2px 6px;
	border-radius: 4px;
}

.regex-pattern-excerpt {
	font-size: 11px;
	font-family: ui-monospace, Consolas, monospace;
	background: var(--control-muted, #f4f7f6);
	color: var(--accent, #176c5b);
	padding: 2px 6px;
	border-radius: 4px;
	max-width: 250px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.regex-card-actions {
	flex-wrap: wrap;
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}

.regex-toggle-btn {
	font-size: 11px;
	padding: 4px 8px;
	border-radius: 4px;
	border: 1px solid var(--line, #dfe7e4);
	background: var(--pane, #ffffff);
	color: var(--muted, #657774);
	cursor: pointer;
}

.regex-toggle-btn:hover {
	color: var(--text, #20312f);
	background: var(--accent-bg, #edf6f2);
}

.regex-card-body {
	padding: 14px 16px;
	border-top: 1px solid var(--line, #dfe7e4);
	background: var(--pane, #ffffff);
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.regex-primary-fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}

.span-full {
	grid-column: 1 / -1;
}

.span-2 {
	grid-column: span 2;
}

.regex-advanced {
	border-top: 1px solid var(--line, #dfe7e4);
	padding-top: 10px;
	margin-top: 4px;
}

.regex-advanced-summary {
	font-size: 12px;
	color: var(--muted, #657774);
	cursor: pointer;
	user-select: none;
	font-weight: 500;
}

.regex-advanced-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
	margin-top: 12px;
}

.regex-checks {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	padding: 6px 0;
}

.regex-checks label {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 12px;
	cursor: pointer;
}

.icon-btn {
	padding: 3px 6px;
	font-size: 12px;
}

@media (max-width: 700px) {
	.regex-primary-fields,
	.regex-advanced-grid {
		grid-template-columns: 1fr;
	}
	.span-2 {
		grid-column: auto;
	}
}
</style>
