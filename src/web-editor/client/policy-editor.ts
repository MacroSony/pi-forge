import { attr, el, escapeHtml } from "./dom.ts";
import type { EditorPromptStack, WebEditorPolicyResource } from "./types.ts";

export interface PolicyEditorDependencies {
	getStack(): EditorPromptStack | null;
	getResources(): { tools: WebEditorPolicyResource[]; skills: WebEditorPolicyResource[] };
	markDirty(): void;
	setStatus(text: string, tone?: string): void;
}

export function createPolicyEditor(deps: PolicyEditorDependencies) {
	const currentStack = () => deps.getStack()!;
	const policyResources = () => deps.getResources();
	const { markDirty, setStatus } = deps;
	let policyError = "";

function renderPolicyTab() {
  if (!currentStack()) return;
  el("tabPanel").innerHTML =
    '<div class="tab-section">' +
    '<div class="tab-section-title">Tool policy and skill visibility</div>' +
    '<div class="tab-section-meta">Tool rules constrain active tools. Skill rules only filter model-visible skills rendered by pi-forge; they do not block explicit skill invocation. Patterns support exact names and * wildcards.</div>' +
    '<div class="data-table" id="policyRows">' +
    '<div class="data-row header policy-row"><div>Resource</div><div>Mode</div><div>Patterns</div><div>Available</div><div>Status</div></div>' +
    policyRowHtml("tools", "Tools") +
    policyRowHtml("skills", "Skills") +
    '</div>' +
    '</div>';
  bindPolicyEditor();
}

function policyRowHtml(kind: any, label: any) {
  const policy = stackPolicyObject(kind);
  const mode = policyMode(policy);
  const rawPatterns = mode === "deny" ? policy.deny : mode === "allow" ? policy.allow : [];
  const patterns = Array.isArray(rawPatterns) ? rawPatterns : [];
  const patternText = policyPatternsToText(patterns);
  const disabled = mode === "none" ? " disabled" : "";
  return '<div class="data-row policy-row" data-policy-row data-policy-kind="' + attr(kind) + '" data-policy-mode="' + attr(mode) + '">' +
    '<div><div class="policy-title">' + escapeHtml(label) + '</div><div class="modal-meta">' + escapeHtml(kind) + '</div></div>' +
    '<div class="field"><label>Mode</label><div class="segmented policy-mode">' +
    policyModeButton("none", "Unrestricted", mode) +
    policyModeButton("allow", "Allow", mode) +
    policyModeButton("deny", "Deny", mode) +
    '</div></div>' +
    '<div class="field"><label>Patterns</label>' + selectedPolicyPatternsHtml(patterns) + '<textarea class="policy-patterns" data-policy-patterns spellcheck="false" placeholder="' + attr(policyPatternPlaceholder(mode)) + '"' + disabled + '>' + escapeHtml(patternText) + '</textarea></div>' +
    resourcePickerHtml(kind, patterns) +
    '<div class="policy-summary" data-policy-summary>' + escapeHtml(policySummary(kind, policy)) + '</div>' +
    '</div>';
}

function selectedPolicyPatternsHtml(patterns: any) {
  return '<div class="selected-patterns" data-selected-patterns>' + selectedPolicyPatternButtonsHtml(patterns) + '</div>';
}

function selectedPolicyPatternButtonsHtml(patterns: any) {
  if (!patterns.length) return '<span class="selected-pattern-empty">No selected patterns.</span>';
  return patterns.map((pattern: any) =>
    '<button type="button" class="selected-pattern-chip" data-remove-policy-pattern="' + attr(pattern) + '" title="Remove selected pattern">' +
    escapeHtml(pattern) + '<span aria-hidden="true">x</span></button>'
  ).join("");
}

function resourcePickerHtml(kind: "tools" | "skills", selectedPatterns: any = []) {
  const resources = policyResources()[kind] || [];
  if (!resources.length) {
    return '<div class="resource-picker"><label>Available ' + escapeHtml(kind) + '</label><div class="resource-empty">No registered ' + escapeHtml(kind) + ' reported.</div></div>';
  }
  const listId = "resource-options-" + kind;
  return '<div class="resource-picker"><label>Available ' + escapeHtml(kind) + '</label><div>' +
    '<input class="resource-filter" data-resource-filter list="' + attr(listId) + '" placeholder="Type to filter or add">' +
    '<datalist id="' + attr(listId) + '" data-resource-options>' + resourceOptionsHtml(kind, selectedPatterns) + '</datalist>' +
    '<div class="resource-list" data-resource-list>' + resourceListHtml(kind, selectedPatterns) + '</div>' +
    '</div></div>';
}

function resourceOptionsHtml(kind: "tools" | "skills", selectedPatterns: any = []) {
  return availablePolicyResources(kind, selectedPatterns)
    .map((resource: any) => '<option value="' + attr(resource.name) + '"></option>')
    .join("");
}

function resourceListHtml(kind: "tools" | "skills", selectedPatterns: any = [], filter: any = "") {
  const resources = availablePolicyResources(kind, selectedPatterns, filter);
  if (!resources.length) return '<div class="resource-empty">No matching unselected ' + escapeHtml(kind) + '.</div>';
  return resources.map((resource: any) => resourceChipHtml(resource)).join("");
}

function availablePolicyResources(kind: "tools" | "skills", selectedPatterns: any = [], filter: any = "") {
  const selected = new Set(selectedPatterns);
  const needle = filter.trim().toLowerCase();
  return (policyResources()[kind] || [])
    .filter((resource: any) => !selected.has(resource.name))
    .filter((resource: any) => !needle || policyResourceMatchesFilter(resource, needle));
}

function policyResourceMatchesFilter(resource: any, needle: any) {
  return [resource.name, resource.description, resource.source]
    .filter(Boolean)
    .some((value: any) => String(value).toLowerCase().includes(needle));
}

function resourceChipHtml(resource: any) {
  const classes = ["resource-chip"];
  if (resource.active) classes.push("active");
  if (resource.hidden) classes.push("hidden");
  const notes = [
    resource.description,
    resource.source ? "Source: " + resource.source : "",
    resource.active ? "Active tool" : "",
    resource.hidden ? "Hidden from model invocation" : "",
  ].filter(Boolean);
  const suffix = resource.active ? " *" : resource.hidden ? " hidden" : "";
  return '<button type="button" class="' + attr(classes.join(" ")) + '" data-resource-name="' + attr(resource.name) + '" title="' + attr(notes.join("\n") || resource.name) + '">' +
    escapeHtml(resource.name + suffix) +
    '</button>';
}

function policyModeButton(value: any, label: any, current: any) {
  return '<button type="button" data-policy-mode-option="' + attr(value) + '" class="' + (value === current ? "active" : "") + '">' + escapeHtml(label) + '</button>';
}

function bindPolicyEditor() {
  const rows = el("policyRows");
  rows.onclick = (event: any) => {
    const modeButton = event.target.closest?.("[data-policy-mode-option]");
    if (modeButton) {
      const row = modeButton.closest("[data-policy-row]");
      setPolicyRowMode(row, modeButton.dataset.policyModeOption);
      if (modeButton.dataset.policyModeOption === "none") row.querySelector("[data-policy-patterns]").value = "";
      syncResourcePolicyFromTab();
      return;
    }

    const removeButton = event.target.closest?.("[data-remove-policy-pattern]");
    if (removeButton) {
      const row = removeButton.closest("[data-policy-row]");
      removePolicyPattern(row, removeButton.dataset.removePolicyPattern || "");
      syncResourcePolicyFromTab();
      return;
    }

    const resourceButton = event.target.closest?.("[data-resource-name]");
    if (resourceButton) {
      const row = resourceButton.closest("[data-policy-row]");
      addPolicyPattern(row, resourceButton.dataset.resourceName || "");
      clearPolicyResourceFilter(row);
      syncResourcePolicyFromTab();
    }
  };
  rows.oninput = (event: any) => {
    const target = event.target;
    if (target.matches?.("[data-policy-patterns]")) {
      syncResourcePolicyFromTab();
      return;
    }
    if (target.matches?.("[data-resource-filter]")) {
      refreshPolicyResourceControls(target.closest("[data-policy-row]"));
    }
  };
  rows.onkeydown = (event: any) => {
    const target = event.target;
    if (!target.matches?.("[data-resource-filter]") || event.key !== "Enter") return;
    event.preventDefault();
    const row = target.closest("[data-policy-row]");
    const name = policyResourceAutocompleteValue(row, target.value);
    if (!name) return;
    addPolicyPattern(row, name);
    target.value = "";
    syncResourcePolicyFromTab();
  };
  refreshPolicySummaries();
  refreshPolicyResourceControls();
}

function clearPolicyResourceFilter(row: any) {
  const filter = row?.querySelector("[data-resource-filter]");
  if (filter) filter.value = "";
}

function policyResourceAutocompleteValue(row: any, value: any) {
  if (!row) return "";
  const typed = value.trim();
  if (!typed) return "";
  const kind = row.dataset.policyKind;
  const selected = selectedPolicyPatterns(row);
  const resources = availablePolicyResources(kind, selected, typed);
  const exact = resources.find((resource: any) => resource.name.toLowerCase() === typed.toLowerCase());
  return exact?.name || resources[0]?.name || typed;
}

function removePolicyPattern(row: any, pattern: any) {
  if (!row || !pattern) return;
  const textarea = row.querySelector("[data-policy-patterns]");
  const patterns = parsePolicyPatterns(textarea.value).filter((candidate: any) => candidate !== pattern);
  textarea.value = patterns.join("\n");
}

function refreshPolicyResourceControls(root: any = document) {
  const rows = root.matches?.("[data-policy-row]") ? [root] : root.querySelectorAll("[data-policy-row]");
  rows.forEach((row: any) => {
    const kind = row.dataset.policyKind;
    const patterns = selectedPolicyPatterns(row);
    const selected = row.querySelector("[data-selected-patterns]");
    if (selected) selected.innerHTML = selectedPolicyPatternButtonsHtml(patterns);
    const filter = row.querySelector("[data-resource-filter]")?.value || "";
    const options = row.querySelector("[data-resource-options]");
    if (options) options.innerHTML = resourceOptionsHtml(kind, patterns);
    const list = row.querySelector("[data-resource-list]");
    if (list) list.innerHTML = resourceListHtml(kind, patterns, filter);
  });
}

function selectedPolicyPatterns(row: any) {
  if (!row || (row.dataset.policyMode || "none") === "none") return [];
  return parsePolicyPatterns(row.querySelector("[data-policy-patterns]")?.value || "");
}

function addPolicyPattern(row: any, name: any) {
  if (!row || !name) return;
  if ((row.dataset.policyMode || "none") === "none") setPolicyRowMode(row, "allow");
  const textarea = row.querySelector("[data-policy-patterns]");
  const patterns = parsePolicyPatterns(textarea.value);
  if (!patterns.includes(name)) patterns.push(name);
  textarea.value = patterns.join("\n");
}

function syncResourcePolicyFromTab() {
  if (!currentStack()) return;
  const stack = currentStack();
  const errors: string[] = [];
  document.querySelectorAll("[data-policy-row]").forEach((row: any) => {
    const kind = row.dataset.policyKind;
    const mode = row.dataset.policyMode || "none";
    const patterns = mode === "none" ? [] : parsePolicyPatterns(row.querySelector("[data-policy-patterns]").value);
    const duplicate = duplicatePolicyPattern(patterns);
    if (duplicate) errors.push(kind + "." + mode + " has duplicate pattern: " + duplicate);
    const policy = { ...stackPolicyObject(kind) };
    delete policy.allow;
    delete policy.deny;
    if (mode === "allow" && patterns.length) policy.allow = patterns;
    if (mode === "deny" && patterns.length) policy.deny = patterns;
    if (Object.keys(policy).length) stack[kind] = policy;
    else delete stack[kind];
    setPolicyRowMode(row, mode);
  });
  policyError = errors[0] || "";
  markDirty();
  refreshPolicySummaries();
  refreshPolicyResourceControls();
  if (policyError) setStatus(policyError, "error");
}

function stackPolicyObject(kind: any) {
  const policy = currentStack()?.[kind];
  return policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
}

function policyMode(policy: any) {
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (deny.length && !allow.length) return "deny";
  if (allow.length) return "allow";
  return "none";
}

function setPolicyRowMode(row: any, mode: any) {
  if (!row) return;
  row.dataset.policyMode = mode || "none";
  row.querySelectorAll("[data-policy-mode-option]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.policyModeOption === row.dataset.policyMode);
  });
  const patterns = row.querySelector("[data-policy-patterns]");
  if (!patterns) return;
  patterns.disabled = row.dataset.policyMode === "none";
  patterns.placeholder = policyPatternPlaceholder(row.dataset.policyMode);
}

function policyPatternPlaceholder(mode: any) {
  if (mode === "allow") return "read\nbrowser-*";
  if (mode === "deny") return "browser-danger\nlegacy-*";
  return "";
}

function policyPatternsToText(patterns: any) {
  return Array.isArray(patterns) ? patterns.join("\n") : "";
}

function parsePolicyPatterns(value: any) {
  return String(value || "")
    .split(/[\n,]/)
    .map((pattern: any) => pattern.trim())
    .filter(Boolean);
}

function duplicatePolicyPattern(patterns: any) {
  const seen = new Set();
  for (const pattern of patterns) {
    if (seen.has(pattern)) return pattern;
    seen.add(pattern);
  }
  return "";
}

function refreshPolicySummaries() {
  document.querySelectorAll("[data-policy-row]").forEach((row: any) => {
    const summary = row.querySelector("[data-policy-summary]");
    if (!summary) return;
    const kind = row.dataset.policyKind;
    const mode = row.dataset.policyMode || "none";
    const patterns = mode === "none" ? [] : parsePolicyPatterns(row.querySelector("[data-policy-patterns]").value);
    const policy = mode === "allow" ? { allow: patterns } : mode === "deny" ? { deny: patterns } : {};
    summary.textContent = policySummary(kind, policy);
    setPolicyRowMode(row, mode);
  });
}

function policySummary(kind: any, policy: any) {
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (allow.length && deny.length) return "Invalid mixed policy.";
  if (allow.some((pattern: any) => pattern !== "*")) return "Allow list active: " + allow.length + " pattern" + (allow.length === 1 ? "" : "s") + ".";
  if (allow.length) return "Unrestricted " + kind + ".";
  if (deny.length) return "Deny list active: " + deny.length + " pattern" + (deny.length === 1 ? "" : "s") + ".";
  return "Unrestricted " + kind + ".";
}


	return {
		renderTab: renderPolicyTab,
		reset: () => { policyError = ""; },
		getError: () => policyError,
	};
}
