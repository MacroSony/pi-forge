import { attr, el, escapeHtml } from "./dom.ts";
import type { EditorPromptStack, EditorRegexRule } from "./types.ts";

export interface RegexEditorDependencies {
	getStack(): EditorPromptStack | null;
	markDirty(): void;
	setStatus(text: string, tone?: string): void;
	showModal(title: string, meta: string, body: string, options?: { bodyClass?: string }): void;
	run(action: () => void | Promise<void>): Promise<void>;
	validateStack(): Promise<void>;
}

export function createRegexEditor(deps: RegexEditorDependencies) {
	const currentStack = () => deps.getStack()!;
	const { markDirty, setStatus } = deps;
	const showStackModal = deps.showModal;
	const { run, validateStack } = deps;
	let regexError = "";
	const regexStages = ["history", "compiled"];
	const regexEffects = ["outgoing", "finalize", "display", "both"];
	const regexTargets = ["system", "messages"];
	const regexRoles = ["system", "user", "assistant", "custom"];

function openRegexEditor() {
  if (!currentStack()) return;
  showStackModal(
    "Regex rules",
    "Ordered JavaScript RegExp replacements for outgoing prompt text and finalized assistant messages.",
    regexEditorBody(),
  );
  bindRegexEditor();
}

function regexEditorBody() {
  const candidateRules = currentStack().regex?.rules;
  const rules = Array.isArray(candidateRules) ? candidateRules : [];
  const rows = rules.map((rule: any) => regexRuleRowHtml(rule)).join("");
  return '<div class="tab-section-title">Regex rules</div>' +
    '<div class="tab-section-meta">Ordered JavaScript RegExp replacements for outgoing prompt text and finalized assistant messages.</div>' +
    '<div class="modal-toolbar"><button id="addRegexRuleBtn" data-icon="+" title="Add a regex rule">Add rule</button><button id="validateRegexRulesBtn" data-icon="!" title="Validate the edited stack">Validate</button><span class="modal-spacer"></span><span class="modal-meta">Save writes these rules to stack.regex.rules.</span></div>' +
    '<div class="data-table" id="regexRows">' + rows + '</div>';
}

function regexRuleRowHtml(rule: any = {}) {
  const original = JSON.stringify(rule || {});
  const enabled = rule.enabled !== false;
  const targets = Array.isArray(rule.targets) ? rule.targets : [];
  const roles = Array.isArray(rule.roles) ? rule.roles : [];
  return '<div class="data-row regex-row" data-regex-row>' +
    '<div class="regex-controls">' +
    '<button type="button" data-regex-up="true" data-icon="↑" title="Move this rule up">Up</button>' +
    '<button type="button" data-regex-down="true" data-icon="↓" title="Move this rule down">Down</button>' +
    '</div>' +
    '<div class="regex-fields">' +
    '<textarea data-regex-original hidden>' + escapeHtml(original) + '</textarea>' +
    '<label class="checkline"><input type="checkbox" data-regex-enabled ' + (enabled ? "checked" : "") + '> Enabled</label>' +
    regexTextField("data-regex-id", "ID", rule.id || "", "trim-ooc") +
    regexTextField("data-regex-name", "Name", rule.name || "", "Readable label") +
    regexSelect("data-regex-stage", "Stage", rule.stage || "compiled", regexStages) +
    regexSelect("data-regex-effect", "Effect", rule.effect || "outgoing", regexEffects) +
    regexTextField("data-regex-flags", "Flags", rule.flags || "", "gimsu") +
    regexCheckGroup("Targets", "data-regex-target", regexTargets, targets, "compiled only; empty means default") +
    regexCheckGroup("Roles", "data-regex-role", regexRoles, roles, "message rules only; empty means all roles") +
    regexNumberField("data-regex-max-messages", "Max messages", rule.maxMessages ?? "") +
    regexNumberField("data-regex-max-chars", "Max chars", rule.maxChars ?? "") +
    regexNumberField("data-regex-min-depth", "Min depth", rule.minDepth ?? "", 0) +
    regexNumberField("data-regex-max-depth", "Max depth", rule.maxDepth ?? "", 0) +
    regexTextArea("data-regex-trim-strings", "Trim strings", Array.isArray(rule.trimStrings) ? rule.trimStrings.join("\n") : "", "span-2", "one per line") +
    regexTextArea("data-regex-pattern", "Pattern", rule.pattern || "", "span-3", "\\\\(OOC:[^)]+\\\\)") +
    regexTextArea("data-regex-replace", "Replace", rule.replace || "", "span-3", "") +
    '<div class="regex-warning wide" data-regex-warning>' + escapeHtml(regexRuleWarning(rule)) + '</div>' +
    '</div>' +
    '<button type="button" class="danger" data-delete-row="true" data-icon="×" title="Delete this regex rule">Delete</button>' +
    '</div>';
}

function regexTextField(attribute: any, label: any, value: any, placeholder: any = "") {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input ' + attribute + ' value="' + attr(value) + '" placeholder="' + attr(placeholder) + '"></div>';
}

function regexNumberField(attribute: any, label: any, value: any, min: any = 1) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input type="number" min="' + attr(min) + '" ' + attribute + ' value="' + attr(value) + '"></div>';
}

function regexTextArea(attribute: any, label: any, value: any, className: any, placeholder: any = "") {
  return '<div class="field ' + className + '"><label>' + escapeHtml(label) + '</label><textarea ' + attribute + ' spellcheck="false" placeholder="' + attr(placeholder) + '">' + escapeHtml(value) + '</textarea></div>';
}

function regexSelect(attribute: any, label: any, value: any, choices: any) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><select ' + attribute + '>' +
    choices.map((choice: any) => '<option value="' + attr(choice) + '"' + (choice === value ? " selected" : "") + '>' + escapeHtml(choice) + '</option>').join("") +
    '</select></div>';
}

function regexCheckGroup(label: any, attribute: any, choices: any, selected: any, help: any) {
  const selectedSet = new Set(selected || []);
  return '<div class="field span-2"><label>' + escapeHtml(label) + '</label><div class="regex-checks" title="' + attr(help) + '">' +
    choices.map((choice: any) => '<label><input type="checkbox" ' + attribute + ' value="' + attr(choice) + '"' + (selectedSet.has(choice) ? " checked" : "") + '> ' + escapeHtml(choice) + '</label>').join("") +
    '</div></div>';
}

function bindRegexEditor() {
  el("addRegexRuleBtn").onclick = () => {
    el("regexRows").insertAdjacentHTML("beforeend", regexRuleRowHtml(defaultRegexRule()));
    bindRegexEditor();
    syncRegexRulesFromModal();
  };
  el("validateRegexRulesBtn").onclick = () => run(validateStack);
  document.querySelectorAll("[data-regex-row] input, [data-regex-row] textarea:not([data-regex-original]), [data-regex-row] select").forEach((control: any) => {
    control.oninput = () => syncRegexRulesFromModal();
    control.onchange = () => syncRegexRulesFromModal();
  });
  document.querySelectorAll("[data-regex-row] [data-delete-row]").forEach((button: any) => {
    button.onclick = (event: any) => {
      event.target.closest("[data-regex-row]").remove();
      syncRegexRulesFromModal();
    };
  });
  document.querySelectorAll("[data-regex-up]").forEach((button: any) => {
    button.onclick = (event: any) => {
      const row = event.target.closest("[data-regex-row]");
      const previous = row.previousElementSibling;
      if (!previous) return;
      row.parentNode.insertBefore(row, previous);
      syncRegexRulesFromModal();
    };
  });
  document.querySelectorAll("[data-regex-down]").forEach((button: any) => {
    button.onclick = (event: any) => {
      const row = event.target.closest("[data-regex-row]");
      const next = row.nextElementSibling;
      if (!next) return;
      row.parentNode.insertBefore(next, row);
      syncRegexRulesFromModal();
    };
  });
  refreshRegexWarnings();
}

function defaultRegexRule() {
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

function uniqueRegexRuleId() {
  const existing = new Set((currentStack()?.regex?.rules || []).map((rule: any) => rule?.id).filter(Boolean));
  let index = existing.size + 1;
  let id = "regex-" + index;
  while (existing.has(id)) id = "regex-" + (++index);
  return id;
}

function syncRegexRulesFromModal() {
  if (!currentStack()) return;
  const rules: EditorRegexRule[] = [];
  const seen = new Set();
  const errors: string[] = [];
  document.querySelectorAll("[data-regex-row]").forEach((row: any, index: any) => {
    const rule = regexRuleFromRow(row);
    const label = rule.id || "rule " + (index + 1);
    if (!rule.id) errors.push("Regex rule " + (index + 1) + " needs an id.");
    else if (seen.has(rule.id)) errors.push("Duplicate regex rule id: " + rule.id);
    seen.add(rule.id);
    if (!rule.pattern) errors.push("Regex rule " + label + " needs a pattern.");
    if (row.querySelector("[data-regex-max-messages]").value && !rule.maxMessages) errors.push("Regex rule " + label + " maxMessages must be a positive integer.");
    if (row.querySelector("[data-regex-max-chars]").value && !rule.maxChars) errors.push("Regex rule " + label + " maxChars must be a positive integer.");
    if (row.querySelector("[data-regex-min-depth]").value && rule.minDepth === undefined) errors.push("Regex rule " + label + " minDepth must be a non-negative integer.");
    if (row.querySelector("[data-regex-max-depth]").value && rule.maxDepth === undefined) errors.push("Regex rule " + label + " maxDepth must be a non-negative integer.");
    if (rule.minDepth !== undefined && rule.maxDepth !== undefined && rule.maxDepth < rule.minDepth) errors.push("Regex rule " + label + " maxDepth must be greater than or equal to minDepth.");
    rules.push(rule);
  });

  if (rules.length) {
    currentStack().regex = { ...(currentStack().regex || {}), schemaVersion: currentStack().regex?.schemaVersion || 1, rules };
  } else {
    delete currentStack().regex;
  }
  regexError = errors[0] || "";
  markDirty();
  refreshRegexWarnings();
  if (regexError) setStatus(regexError, "error");
}

function regexRuleFromRow(row: any) {
  const rule = originalRegexRuleFromRow(row);
  for (const key of ["id", "name", "enabled", "stage", "effect", "pattern", "flags", "replace", "trimStrings", "roles", "targets", "maxMessages", "maxChars", "minDepth", "maxDepth"]) {
    delete rule[key];
  }
  rule.id = row.querySelector("[data-regex-id]").value.trim();
  setOptionalObjectString(rule, "name", row.querySelector("[data-regex-name]").value);
  rule.enabled = row.querySelector("[data-regex-enabled]").checked;
  rule.stage = row.querySelector("[data-regex-stage]").value || "compiled";
  rule.effect = row.querySelector("[data-regex-effect]").value || "outgoing";
  rule.pattern = row.querySelector("[data-regex-pattern]").value;
  const flags = row.querySelector("[data-regex-flags]").value.trim();
  if (flags) rule.flags = flags;
  const replace = row.querySelector("[data-regex-replace]").value;
  if (replace) rule.replace = replace;
  const trimStrings = row.querySelector("[data-regex-trim-strings]").value.split(/\r?\n/).filter((line: any) => line.length > 0);
  if (trimStrings.length) rule.trimStrings = trimStrings;
  const roles = checkedRegexValues(row, "data-regex-role");
  if (roles.length) rule.roles = roles;
  const targets = checkedRegexValues(row, "data-regex-target");
  if (targets.length) rule.targets = targets;
  const maxMessages = positiveIntegerFromInput(row.querySelector("[data-regex-max-messages]").value);
  const maxChars = positiveIntegerFromInput(row.querySelector("[data-regex-max-chars]").value);
  const minDepth = nonNegativeIntegerFromInput(row.querySelector("[data-regex-min-depth]").value);
  const maxDepth = nonNegativeIntegerFromInput(row.querySelector("[data-regex-max-depth]").value);
  if (maxMessages) rule.maxMessages = maxMessages;
  if (maxChars) rule.maxChars = maxChars;
  if (minDepth !== undefined) rule.minDepth = minDepth;
  if (maxDepth !== undefined) rule.maxDepth = maxDepth;
  return rule;
}

function originalRegexRuleFromRow(row: any) {
  try {
    const parsed = JSON.parse(row.querySelector("[data-regex-original]")?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function checkedRegexValues(row: any, attribute: any) {
  return Array.from(row.querySelectorAll("[" + attribute + "]"))
    .filter((input: any) => input.checked)
    .map((input: any) => input.value);
}

function positiveIntegerFromInput(value: any) {
  if (!String(value || "").trim()) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeIntegerFromInput(value: any) {
  if (!String(value || "").trim()) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function refreshRegexWarnings() {
  document.querySelectorAll("[data-regex-row]").forEach((row: any) => {
    const warning = row.querySelector("[data-regex-warning]");
    if (!warning) return;
    const text = regexRuleWarning(regexRuleFromRow(row));
    warning.textContent = text;
    warning.style.display = text ? "" : "none";
  });
}

function regexRuleWarning(rule: any) {
  if (rule.effect === "finalize") {
    return 'Warning: finalize runs after streaming and replaces the stored assistant transcript. Use stage "compiled" with target "messages".';
  }
  if (rule.effect === "display") {
    return 'Warning: display rules validate but are ignored at runtime until true display transforms exist.';
  }
  if (rule.effect === "both") {
    return 'Warning: both is ignored at runtime; create separate outgoing and finalize rules instead.';
  }
  if (typeof rule.replace === "string" && /\{\{\s*match\s*\}\}/i.test(rule.replace)) {
    return 'Warning: {{match}} is SillyTavern syntax. Use $& or $0 for the full match in pi-forge rules.';
  }
  return "";
}

function setOptionalObjectString(target: any, key: any, value: any) {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}


	return {
		open: openRegexEditor,
		renderBody: regexEditorBody,
		bind: bindRegexEditor,
		reset: () => { regexError = ""; },
		getError: () => regexError,
	};
}
