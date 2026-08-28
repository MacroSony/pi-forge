<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import { t, type MessageKey } from "../i18n.ts";
import type { EditorPromptStackItem } from "../types.ts";

const props = defineProps<{
	item: EditorPromptStackItem;
	mode: "form" | "json";
	slotNames: string[];
	roles: string[];
}>();
const emit = defineEmits<{
	change: [refreshList: boolean];
	error: [message: string];
	mode: [mode: "form" | "json"];
	replace: [item: EditorPromptStackItem];
}>();

const item = reactive(props.item);
const mode = ref(props.mode);
const optionsText = ref(JSON.stringify(item.options || {}, null, 2));
const optionsError = ref(false);
const options = computed<any>(() => item.options || {});
const structuredOptionCount = computed(() => {
	if (item.slot === "chat-history") return 7;
		if (["tools", "tool-guidelines", "skills", "project-context"].includes(item.slot || "")) return 1;
	if (["date", "date-cwd"].includes(item.slot || "")) return 1;
	return 0;
});

function setKind(kind: "block" | "slot"): void {
	if (kind === item.kind) return;
	const base = {
		id: item.id,
		name: item.name,
		enabled: item.enabled,
		role: item.role,
		tags: item.tags,
		source: item.source,
	};
	emit("replace", kind === "slot"
		? { ...base, kind: "slot", slot: "chat-history" }
		: { ...base, kind: "block", content: "" });
}

function setString(key: string, value: string, optional = false, refreshList = false): void {
	if (optional && !value.trim()) delete item[key];
	else item[key] = value;
	emit("change", refreshList);
}

function switchMode(next: "form" | "json"): void {
	mode.value = next;
	if (next === "form" && optionsError.value) {
		optionsError.value = false;
		emit("error", "");
	}
	optionsText.value = JSON.stringify(item.options || {}, null, 2);
	emit("mode", next);
}

function setJsonOptions(value: string): void {
	optionsText.value = value;
	try {
		const parsed = value.trim() ? JSON.parse(value) : {};
		item.options = Object.keys(parsed).length ? parsed : undefined;
		optionsError.value = false;
		emit("error", "");
		emit("change", false);
	} catch (error) {
		optionsError.value = true;
		emit("error", error instanceof Error ? error.message : String(error));
	}
}

function setOption(key: string, value: unknown, defaultValue: unknown = undefined): void {
	const next = { ...(item.options || {}) };
	if (value === undefined || value === defaultValue) delete next[key];
	else next[key] = value;
	item.options = Object.keys(next).length ? next : undefined;
	emit("change", false);
}

function setNumberOption(key: string, value: string): void {
	setOption(key, value.trim() ? Number(value) : undefined);
}

function setArrayOption(key: string, value: string): void {
	const values = value.split(",").map((part) => part.trim()).filter(Boolean);
	setOption(key, values.length ? values : undefined);
}

function optionHelp(key: string): string {
	const known: MessageKey = `item.opt.${key}` as MessageKey;
	const translated = t(known);
	return translated === known ? t("item.opt.advanced") : translated;
}
</script>

<template>
	<div class="item-form">
		<div class="item-fields">
			<div class="field">
				<label>{{ t("item.kind") }}</label>
				<select id="itemKind" :value="item.kind" @change="setKind(($event.target as HTMLSelectElement).value as 'block' | 'slot')">
					<option value="block">block</option>
					<option value="slot">slot</option>
				</select>
			</div>
			<div class="field">
				<label>{{ t("item.id") }}</label>
				<input id="itemId" :value="item.id" @input="setString('id', ($event.target as HTMLInputElement).value, false, true)">
			</div>
			<div class="field">
				<label>{{ t("item.name") }}</label>
				<input id="itemName" :value="item.name || ''" @input="setString('name', ($event.target as HTMLInputElement).value, true, true)">
			</div>
			<div class="field">
				<label>{{ t("item.role") }}</label>
				<select id="itemRole" :value="item.role || ''" @change="setString('role', ($event.target as HTMLSelectElement).value, true, true)">
					<option v-for="role in roles" :key="role" :value="role">{{ role || t("item.roleNone") }}</option>
				</select>
			</div>
			<div v-if="item.kind === 'slot'" class="field">
				<label>{{ t("item.slot") }}</label>
				<select id="itemSlot" :value="item.slot || 'chat-history'" @change="setString('slot', ($event.target as HTMLSelectElement).value, false, true)">
					<option v-for="slot in slotNames" :key="slot" :value="slot">{{ slot }}</option>
				</select>
			</div>
		</div>

		<div class="item-body">
			<div v-if="item.kind === 'block'" class="field content-field">
				<label>{{ t("item.content") }}</label>
				<textarea id="itemContent" :value="item.content || ''" @input="setString('content', ($event.target as HTMLTextAreaElement).value)"></textarea>
			</div>

			<div v-else class="field wide slot-options">
				<label>{{ t("item.slotOptions") }}</label>
				<div class="segmented">
					<button id="slotOptionsFormBtn" type="button" :class="{ active: mode === 'form' }" @click="switchMode('form')">{{ t("item.form") }}</button>
					<button id="slotOptionsJsonBtn" type="button" :class="{ active: mode === 'json' }" @click="switchMode('json')">JSON</button>
				</div>

				<textarea
					v-if="mode === 'json'"
					id="itemOptions"
					class="json-options"
					:value="optionsText"
					@input="setJsonOptions(($event.target as HTMLTextAreaElement).value)"
				></textarea>
				<div v-else class="options-grid">
					<template v-if="item.slot === 'chat-history'">
						<label class="checkline" :title="optionHelp('includeLastUserMessage')">
							<input type="checkbox" data-option="includeLastUserMessage" :checked="options.includeLastUserMessage !== false" @change="setOption('includeLastUserMessage', ($event.target as HTMLInputElement).checked, true)">
							{{ t("item.includeLastUserMessage") }}
						</label>
						<label class="checkline" :title="optionHelp('stripAssistantThinking')">
							<input type="checkbox" data-option="stripAssistantThinking" :checked="options.stripAssistantThinking === true" @change="setOption('stripAssistantThinking', ($event.target as HTMLInputElement).checked, false)">
							{{ t("item.stripAssistantThinking") }}
						</label>
						<label class="checkline" :title="optionHelp('includeSummaries')">
							<input type="checkbox" data-option="includeSummaries" :checked="options.includeSummaries !== false" @change="setOption('includeSummaries', ($event.target as HTMLInputElement).checked, true)">
							{{ t("item.includeSummaries") }}
						</label>
						<div class="field" :title="optionHelp('toolMode')">
							<label>{{ t("item.toolHistory") }}</label>
							<select data-option="toolMode" :value="options.toolMode || 'keep'" @change="setOption('toolMode', ($event.target as HTMLSelectElement).value, 'keep')">
								<option value="keep">keep</option>
								<option value="drop">drop</option>
							</select>
						</div>
						<div class="field" :title="optionHelp('roles')">
							<label>{{ t("item.roles") }}</label>
							<input data-option="roles" data-array="true" :value="Array.isArray(options.roles) ? options.roles.join(', ') : ''" placeholder="comma,separated" @change="setArrayOption('roles', ($event.target as HTMLInputElement).value)">
						</div>
						<div class="field" :title="optionHelp('maxMessages')">
							<label>{{ t("item.maxMessages") }}</label>
							<input type="number" min="1" data-option="maxMessages" :value="options.maxMessages ?? ''" @change="setNumberOption('maxMessages', ($event.target as HTMLInputElement).value)">
						</div>
						<div class="field" :title="optionHelp('maxChars')">
							<label>{{ t("item.maxChars") }}</label>
							<input type="number" min="1" data-option="maxChars" :value="options.maxChars ?? ''" @change="setNumberOption('maxChars', ($event.target as HTMLInputElement).value)">
						</div>
					</template>

					<div v-if="['tools', 'tool-guidelines', 'skills', 'project-context'].includes(item.slot || '')" class="field" :title="optionHelp('format')">
						<label>{{ t("item.format") }}</label>
						<select data-option="format" :value="options.format || 'xml'" @change="setOption('format', ($event.target as HTMLSelectElement).value, 'xml')">
							<option value="xml">xml</option>
							<option value="plain">plain</option>
						</select>
					</div>

					<label v-if="['date', 'date-cwd'].includes(item.slot || '')" class="checkline" :title="optionHelp('includeTime')">
						<input type="checkbox" data-option="includeTime" :checked="options.includeTime === true" @change="setOption('includeTime', ($event.target as HTMLInputElement).checked, false)">
						{{ t("item.includeTime") }}
					</label>

					<div v-if="structuredOptionCount === 0" class="wide option-note">
						{{ t("item.noStructuredOptions") }}
					</div>
					<div class="wide option-note">{{ t("item.unknownKeysPreserved") }}</div>
				</div>
			</div>
		</div>
	</div>
</template>
