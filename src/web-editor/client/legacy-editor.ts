// Temporary behavior-preserving bridge while the stack editor is migrated to Vue components.
import { createEditorApi, EditorApiError } from "./api.ts";
import { attr, el, escapeHtml, eventElement, query, queryAll, type EditorElement } from "./dom.ts";
import { createInspector } from "./inspector.ts";
import { createVueTabHost } from "./vue-tab-host.ts";
import type {
  EditorPromptStack,
  PromptStackDiagnostic,
  WebEditorPolicyResource,
  WebEditorStackSummary,
} from "./types.ts";

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);
let stacks: WebEditorStackSummary[] = [];
let cwd = "";
let selectedId = "";
let currentStack: EditorPromptStack | null = null;
let currentFilePath = "";
let selectedItemIndex = -1;
let dirty = false;
let dragIndex = -1;
let dragDropIndex = -1;
let dragScrollFrame = 0;
let dragScrollSpeed = 0;
let dragClientY = 0;
let optionsText = "";
let optionsError = "";
let sidebarCollapsed = false;
let slotOptionsMode: "form" | "json" = "form";
let policyResources: { tools: WebEditorPolicyResource[]; skills: WebEditorPolicyResource[] } = { tools: [], skills: [] };
let latestDiagnostics: PromptStackDiagnostic[] = [];
let activeTab: "items" | "regex" | "policy" | "stack" = "items";
let metadataCollapsed = true;
let currentTheme: "light" | "dark" = readStoredTheme() || (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
let editorStarted = false;

const {
  validateStack,
  previewStack,
  refreshPayloadCapture,
  armPayloadCapture,
  clearPayloadCapture,
  openPayloadCapture,
  hidePreview,
  copyPreviewText,
  copyTextToClipboard,
} = createInspector({
  api,
  getSelectedId: () => selectedId,
  stackForSubmit,
  renderDiagnostics,
  renderItemList,
  setStatus,
});
const vueTabHost = createVueTabHost({
  getStack: () => currentStack,
  getResources: () => policyResources,
  markDirty,
  setStatus,
  validateStack: () => run(validateStack),
  applyStack: applyStackFromVue,
  copyText: copyTextToClipboard,
});

const slotNames = [
  "chat-history", "tools", "tool-guidelines", "skills", "project-context",
  "append-system-prompt", "variables", "date", "cwd", "date-cwd",
  "active-model", "pi-docs"
];
const roles = ["", "system", "user", "assistant", "custom"];
function applyTheme(theme: string) {
  currentTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = currentTheme;
  const button = el("themeBtn");
  if (button) {
    button.textContent = currentTheme === "dark" ? "Light" : "Dark";
    button.title = currentTheme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  }
}

function toggleTheme() {
  const next = currentTheme === "dark" ? "light" : "dark";
  writeStoredTheme(next);
  applyTheme(next);
  setStatus(next === "dark" ? "Dark theme enabled" : "Light theme enabled", "success");
}

function readStoredTheme(): "light" | "dark" | "" {
  try {
    const theme = localStorage.getItem("pi-forge-theme");
    return theme === "light" || theme === "dark" ? theme : "";
  } catch {
    return "";
  }
}

function writeStoredTheme(theme: string) {
  try {
    localStorage.setItem("pi-forge-theme", theme);
  } catch {
    // Ignore storage failures; the current page can still switch themes.
  }
}

function setStatus(text: string, tone: any = "") {
  el("status").textContent = text;
  el("status").style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
}

function markDirty() {
  dirty = true;
  renderDirtyState();
  setStatus("Unsaved changes");
}

function renderDirtyState() {
  const badge = el("dirtyBadge");
  if (!badge) return;
  badge.classList.toggle("visible", dirty);
  updateActionState();
}

function updateActionState() {
  const hasStack = !!currentStack;
  for (const id of ["activateBtn", "saveBtn", "validateBtn", "previewBtn", "forkBtn", "exportBtn", "deleteStackBtn", "addItemBtn", "addSlotBtn", "metadataToggleBtn"]) {
    const button = el(id);
    if (button) button.disabled = !hasStack;
  }
  const deleteItemButton = el("deleteItemBtn");
  if (deleteItemButton) deleteItemButton.disabled = !hasStack || selectedItemIndex < 0;
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.disabled = !hasStack;
  });
}

async function loadStacks(preferId: any = selectedId) {
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  if (!editorStarted) return;
  stacks = data.stacks || [];
  policyResources = normalizePolicyResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  const next = stacks.find((stack: any) => stack.id === preferId) || stacks.find((stack: any) => stack.active) || stacks[0];
  if (next) await selectStack(next.id, { keepDirty: false });
  else renderEmpty();
}

async function selectStack(id: any, options: any = {}) {
  if (dirty && !options.keepDirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id));
  if (!editorStarted) return;
  selectedId = id;
  const loadedStack = structuredClone(data.stack) as EditorPromptStack;
  currentStack = loadedStack;
  currentFilePath = data.filePath || "";
  selectedItemIndex = loadedStack.items.length ? 0 : -1;
  dirty = false;
  optionsError = "";
  vueTabHost.resetErrors();
  renderDirtyState();
  renderAll(data.diagnostics || []);
  setStatus("Loaded " + loadedStack.id);
}

function renderAll(diagnostics: any = []) {
  latestDiagnostics = diagnostics;
  renderStackList();
  renderSettings();
  renderActiveTab();
  renderDiagnostics(diagnostics);
  hidePreview();
  updateActionState();
}

function renderActiveTab() {
  vueTabHost.unmount();
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  const workspace = el("workspace");
  const panel = el("tabPanel");
  if (activeTab === "items") {
    workspace.style.display = "";
    panel.classList.remove("open");
    panel.innerHTML = "";
    renderItemList();
    renderItemEditor();
    return;
  }
  workspace.style.display = "none";
  panel.classList.add("open");
  if (activeTab === "regex") vueTabHost.mountRegex(panel);
  else if (activeTab === "policy") vueTabHost.mountPolicy(panel);
  else if (activeTab === "stack") vueTabHost.mountStack(panel);
}

function renderStackList() {
  const list = el("stackList");
  list.innerHTML = "";
  if (!stacks.length) {
    list.innerHTML = '<div class="side-empty">No prompt stacks in this project.</div>';
    return;
  }
  for (const stack of stacks) {
    const row = document.createElement("button");
    row.className = "stack-row" + (stack.active ? " active" : "") + (stack.id === selectedId ? " selected" : "");
    const diag = stack.errors ? '<span class="badge error">' + stack.errors + ' error</span>' : stack.warnings ? '<span class="badge warning">' + stack.warnings + ' warning</span>' : "";
    row.innerHTML = '<div class="stack-name">' + escapeHtml(stack.id) + (stack.active ? '<span class="badge">active</span>' : '') + diag + '</div>' +
      '<div class="stack-meta">' + escapeHtml(stack.name || "(unnamed)") + '</div>' +
      '<div class="stack-meta">' + stack.itemCount + ' items | ' + escapeHtml(stack.mode || "replace") + '</div>';
    row.onclick = () => selectStack(stack.id);
    list.appendChild(row);
  }
}

function normalizePolicyResources(value: any) {
  return {
    tools: normalizeResourceList(value?.tools),
    skills: normalizeResourceList(value?.skills),
  };
}

function normalizeResourceList(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((resource: any) => resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.trim())
    .map((resource: any) => ({
      name: resource.name.trim(),
      description: typeof resource.description === "string" ? resource.description : "",
      source: typeof resource.source === "string" ? resource.source : "",
      active: resource.active === true,
      hidden: resource.hidden === true,
    }));
}

function renderSettings() {
  const settings = el("settings");
  if (!currentStack) {
    settings.innerHTML = "";
    el("metadataSummary").textContent = "";
    return;
  }
  const stack = currentStack;
  el("metadataPanel").style.display = "";
  el("metadataSummary").textContent = [
    currentStack.id || "(no id)",
    currentStack.name || "(unnamed)",
    currentStack.mode || "replace",
    currentFilePath || "",
  ].filter(Boolean).join(" | ");
  settings.style.display = metadataCollapsed ? "none" : "grid";
  el("metadataToggleBtn").textContent = metadataCollapsed ? "Show metadata" : "Hide metadata";
  el("metadataToggleBtn").dataset.icon = metadataCollapsed ? "▸" : "▾";
  settings.innerHTML = [
    field("Stack ID", '<input id="stackId" value="' + attr(stack.id) + '" readonly title="Stack IDs are immutable; use Fork to create a new ID.">'),
    field("Name", '<input id="stackName" value="' + attr(stack.name || "") + '">'),
    field("Mode", '<select id="stackMode"><option value="replace">replace</option><option value="append">append</option><option value="prepend">prepend</option></select>'),
    field("Auto activate", '<label class="checkline"><input id="stackAuto" type="checkbox"> enabled</label>'),
    field("Description", '<textarea id="stackDescription" class="wide">' + escapeHtml(stack.description || "") + '</textarea>', "wide"),
    field("File", '<input value="' + attr(currentFilePath) + '" disabled>', "wide"),
  ].join("");
  el("stackMode").value = stack.mode || "replace";
  el("stackAuto").checked = stack.autoActivate === true;
  el("stackName").oninput = (event: any) => { setOptionalString(stack, "name", event.target.value); markDirty(); };
  el("stackMode").onchange = (event: any) => { stack.mode = event.target.value; markDirty(); };
  el("stackAuto").onchange = (event: any) => { stack.autoActivate = event.target.checked; markDirty(); };
  el("stackDescription").oninput = (event: any) => { setOptionalString(stack, "description", event.target.value); markDirty(); };
}

function toggleMetadata() {
  metadataCollapsed = !metadataCollapsed;
  renderSettings();
  setStatus(metadataCollapsed ? "Stack metadata hidden" : "Stack metadata shown");
}

function renderItemList() {
  const list = el("itemList");
  list.innerHTML = "";
  list.classList.toggle("drag-active", dragIndex !== -1);
  if (!currentStack) return;
  el("itemCount").textContent = currentStack.items.length + " total";
  list.ondragover = handleItemListDragOver;
  list.ondrop = handleItemListDrop;
  const diagnosticsByItem = diagnosticsForItems();
  currentStack.items.forEach((item: any, index: any) => {
    const row = document.createElement("div");
    row.className = "item-row" + (index === selectedItemIndex ? " selected" : "") + (item.enabled === false ? " disabled" : "");
    row.dataset.itemIndex = String(index);
    row.draggable = true;
    const enabled = item.enabled !== false;
    const itemDiagnostics = diagnosticsByItem[item.id] || [];
    const errors = itemDiagnostics.filter((diag: any) => diag.level === "error").length;
    const warnings = itemDiagnostics.filter((diag: any) => diag.level === "warning").length;
    const diagBadge = errors
      ? '<span class="item-badge error" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + errors + 'E</span>'
      : warnings
        ? '<span class="item-badge warning" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + warnings + 'W</span>'
        : "";
    row.innerHTML = '<div class="drag-handle" title="Drag to reorder">≡</div>' +
      '<div><div class="item-title">' + escapeHtml(displayItemName(item)) + diagBadge + '</div>' +
      '<div class="item-meta">' + escapeHtml(item.kind) + ' | id: ' + escapeHtml(item.id) + (item.role ? " | " + escapeHtml(item.role) : "") + (item.kind === "slot" ? " | " + escapeHtml(item.slot || "") : "") + '</div></div>' +
      '<button type="button" class="item-toggle ' + (enabled ? "enabled" : "disabled") + '" title="Toggle item">' + (enabled ? "On" : "Off") + '</button>';
    row.onclick = (event: any) => {
      if (event.target?.classList?.contains("item-toggle")) return;
      selectedItemIndex = index;
      renderItemList();
      renderItemEditor();
    };
    query<EditorElement>(row, ".item-toggle")!.onclick = (event: any) => {
      event.stopPropagation();
      item.enabled = item.enabled === false;
      selectedItemIndex = index;
      markDirty();
      renderItemList();
      renderItemEditor();
    };
    row.ondragstart = (event: any) => {
      dragIndex = index;
      dragDropIndex = index;
      row.classList.add("dragging");
      list.classList.add("drag-active");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id || String(index));
      }
      updateItemDropIndicator();
    };
    row.ondragend = finishItemDrag;
    row.ondragover = handleItemListDragOver;
    row.ondrop = handleItemListDrop;
    list.appendChild(row);
  });
  updateItemDropIndicator();
}

function handleItemListDragOver(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleItemListDrop(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dropDraggedItem();
}

function dropDraggedItem() {
  if (!currentStack || dragIndex < 0 || dragIndex >= currentStack.items.length) {
    finishItemDrag();
    return;
  }
  let insertIndex = dragDropIndex;
  if (insertIndex < 0) insertIndex = dragIndex;
  insertIndex = Math.max(0, Math.min(insertIndex, currentStack.items.length));
  const [moved] = currentStack.items.splice(dragIndex, 1);
  if (!moved) {
    finishItemDrag();
    return;
  }
  if (dragIndex < insertIndex) insertIndex--;
  insertIndex = Math.max(0, Math.min(insertIndex, currentStack.items.length));
  currentStack.items.splice(insertIndex, 0, moved);
  selectedItemIndex = insertIndex;
  const changed = dragIndex !== insertIndex;
  finishItemDrag(false);
  if (changed) markDirty();
  renderItemList();
  renderItemEditor();
}

function setItemDropIndex(index: any) {
  if (!currentStack) return;
  const next = Math.max(0, Math.min(index, currentStack.items.length));
  if (dragDropIndex === next) return;
  dragDropIndex = next;
  updateItemDropIndicator();
}

function dropIndexFromClientY(clientY: any) {
  const list = el("itemList");
  const rows = [...queryAll<HTMLElement>(list, ".item-row")];
  if (!rows.length) return 0;
  const listRect = list.getBoundingClientRect();
  if (clientY <= listRect.top) return 0;
  if (clientY >= listRect.bottom) return rows.length;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const index = Number(row.dataset.itemIndex);
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return rows.length;
}

function updateItemDropIndicator() {
  const list = el("itemList");
  const rows = [...list.querySelectorAll(".item-row")];
  for (const row of rows) row.classList.remove("drop-before", "drop-after");
  list.classList.toggle("drag-active", dragIndex !== -1);
  if (dragIndex === -1 || dragDropIndex === -1 || !rows.length) return;
  if (dragDropIndex <= 0) rows[0].classList.add("drop-before");
  else if (dragDropIndex >= rows.length) rows[rows.length - 1].classList.add("drop-after");
  else rows[dragDropIndex].classList.add("drop-before");
}

function updateItemDragAutoScroll(clientY: any) {
  const list = el("itemList");
  const rect = list.getBoundingClientRect();
  const edge = Math.min(72, Math.max(36, rect.height / 5));
  let speed = 0;
  if (clientY < rect.top) speed = -Math.min(30, 8 + (rect.top - clientY) / 3);
  else if (clientY < rect.top + edge) speed = -Math.min(22, (rect.top + edge - clientY) / 3);
  else if (clientY > rect.bottom) speed = Math.min(30, 8 + (clientY - rect.bottom) / 3);
  else if (clientY > rect.bottom - edge) speed = Math.min(22, (clientY - (rect.bottom - edge)) / 3);
  dragScrollSpeed = speed;
  if (speed !== 0 && !dragScrollFrame) dragScrollFrame = requestAnimationFrame(runItemDragAutoScroll);
}

function runItemDragAutoScroll() {
  dragScrollFrame = 0;
  if (dragIndex === -1 || dragScrollSpeed === 0) return;
  const list = el("itemList");
  list.scrollTop += dragScrollSpeed;
  setItemDropIndex(dropIndexFromClientY(dragClientY));
  dragScrollFrame = requestAnimationFrame(runItemDragAutoScroll);
}

function finishItemDrag(clearIndicator: any = true) {
  dragIndex = -1;
  dragDropIndex = -1;
  dragScrollSpeed = 0;
  dragClientY = 0;
  if (dragScrollFrame) {
    cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = 0;
  }
  if (clearIndicator) updateItemDropIndicator();
}

function handleDocumentItemDragOver(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleDocumentItemDrop(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dropDraggedItem();
}

function diagnosticsForItems(): Record<string, PromptStackDiagnostic[]> {
  const grouped: Record<string, PromptStackDiagnostic[]> = {};
  for (const diagnostic of latestDiagnostics || []) {
    if (!diagnostic.itemId) continue;
    if (!grouped[diagnostic.itemId]) grouped[diagnostic.itemId] = [];
    grouped[diagnostic.itemId].push(diagnostic);
  }
  return grouped;
}

function diagnosticTitle(diagnostics: any) {
  return diagnostics.map((diag: any) => (diag.level || "info").toUpperCase() + ": " + (diag.message || "")).join("\n");
}

function renderItemEditor() {
  const editor = el("itemEditor");
  if (!currentStack || selectedItemIndex < 0 || !currentStack.items[selectedItemIndex]) {
    editor.innerHTML = '<div class="empty">No item selected.</div>';
    el("deleteItemBtn").disabled = true;
    return;
  }
  el("deleteItemBtn").disabled = false;
  const stack = currentStack;
  const item = stack.items[selectedItemIndex];
  optionsText = JSON.stringify(item.options || {}, null, 2);
  optionsError = "";
  const slotSelect = '<select id="itemSlot">' + slotNames.map((slot: any) => '<option value="' + attr(slot) + '">' + escapeHtml(slot) + '</option>').join("") + '</select>';
  const roleSelect = '<select id="itemRole">' + roles.map((role: any) => '<option value="' + attr(role) + '">' + escapeHtml(role || "(none)") + '</option>').join("") + '</select>';
  const kindSelect = '<select id="itemKind"><option value="block">block</option><option value="slot">slot</option></select>';
  const topFields = '<div class="item-fields">' +
    field("Kind", kindSelect) +
    field("ID", '<input id="itemId" value="' + attr(item.id) + '">') +
    field("Name", '<input id="itemName" value="' + attr(item.name || "") + '">') +
    field("Role", roleSelect) +
    (item.kind === "slot" ? field("Slot", slotSelect) : "") +
    '</div>';
  const body = item.kind === "block"
    ? field("Content", '<textarea id="itemContent">' + escapeHtml(item.content || "") + '</textarea>', "content-field")
    : renderSlotOptionsEditor(item);
  editor.innerHTML = '<div class="item-form">' + topFields + '<div class="item-body">' + body + '</div></div>';

  el("itemKind").value = item.kind;
  el("itemRole").value = item.role || "";
  if (item.kind === "slot") el("itemSlot").value = item.slot || "chat-history";

  el("itemKind").onchange = (event: any) => {
    if (event.target.value === item.kind) return;
    const base = { id: item.id, name: item.name, enabled: item.enabled, role: item.role, tags: item.tags, source: item.source };
    stack.items[selectedItemIndex] = event.target.value === "slot"
      ? { ...base, kind: "slot", slot: "chat-history" }
      : { ...base, kind: "block", content: "" };
    markDirty();
    renderItemList();
    renderItemEditor();
  };
  el("itemId").oninput = (event: any) => { item.id = event.target.value; markDirty(); renderItemList(); };
  el("itemName").oninput = (event: any) => { setOptionalString(item, "name", event.target.value); markDirty(); };
  el("itemRole").onchange = (event: any) => { setOptionalString(item, "role", event.target.value); markDirty(); renderItemList(); };
  if (item.kind === "block") {
    el("itemContent").oninput = (event: any) => { item.content = event.target.value; markDirty(); };
  } else {
    el("itemSlot").onchange = (event: any) => { item.slot = event.target.value; markDirty(); renderItemList(); };
    bindSlotOptionsEditor(item);
  }
}

function renderSlotOptionsEditor(item: any) {
  const options = item.options || {};
  const jsonActive = slotOptionsMode === "json";
  const formButton = '<button id="slotOptionsFormBtn" type="button" class="' + (!jsonActive ? "active" : "") + '">Form</button>';
  const jsonButton = '<button id="slotOptionsJsonBtn" type="button" class="' + (jsonActive ? "active" : "") + '">JSON</button>';
  const body = jsonActive
    ? '<textarea id="itemOptions" class="json-options">' + escapeHtml(optionsText) + '</textarea>'
    : renderSlotOptionsForm(item, options);
  return '<div class="field wide slot-options"><label>Slot options</label><div class="segmented">' + formButton + jsonButton + '</div>' + body + '</div>';
}

function renderSlotOptionsForm(item: any, options: any) {
  const fields = [];
  if (item.slot === "chat-history") {
    fields.push(
      optionCheckbox("includeLastUserMessage", "Include last user message", options.includeLastUserMessage !== false),
      optionCheckbox("stripAssistantThinking", "Strip assistant thinking", options.stripAssistantThinking === true),
      optionCheckbox("includeSummaries", "Include summaries", options.includeSummaries !== false),
      optionSelect("toolMode", "Tool history", options.toolMode || "keep", ["keep", "drop"]),
      optionText("roles", "Roles", Array.isArray(options.roles) ? options.roles.join(", ") : ""),
      optionNumber("maxMessages", "Max messages", options.maxMessages ?? ""),
      optionNumber("maxChars", "Max chars", options.maxChars ?? ""),
    );
  }
  if (item.slot === "variables") {
    fields.push(
      optionCheckbox("includeStatic", "Include static variables", options.includeStatic !== false),
      optionCheckbox("includeSession", "Include session variables", options.includeSession !== false),
      optionCheckbox("includeTurn", "Include turn variables", options.includeTurn !== false),
      optionSelect("format", "Format", options.format || "xml", ["xml", "plain"]),
    );
  }
  if (["tools", "tool-guidelines", "skills", "project-context"].includes(item.slot)) {
    fields.push(optionSelect("format", "Format", options.format || "xml", ["xml", "plain"]));
  }
  if (["date", "date-cwd"].includes(item.slot)) {
    fields.push(optionCheckbox("includeTime", "Include current time", options.includeTime === true));
  }
  if (fields.length === 0) {
    fields.push('<div class="wide option-note">This slot has no structured options yet. Use JSON mode for advanced settings.</div>');
  }
  fields.push('<div class="wide option-note">Unknown option keys are preserved. Use JSON mode for advanced settings.</div>');
  return '<div class="options-grid">' + fields.join("") + '</div>';
}

function bindSlotOptionsEditor(item: any) {
  el("slotOptionsFormBtn").onclick = () => {
    slotOptionsMode = "form";
    renderItemEditor();
  };
  el("slotOptionsJsonBtn").onclick = () => {
    slotOptionsMode = "json";
    renderItemEditor();
  };

  if (slotOptionsMode === "json") {
    el("itemOptions").oninput = (event: any) => {
      optionsText = event.target.value;
      try {
        const parsed = optionsText.trim() ? JSON.parse(optionsText) : {};
        item.options = Object.keys(parsed).length ? parsed : undefined;
        optionsError = "";
        markDirty();
      } catch (error) {
        optionsError = error instanceof Error ? error.message : String(error);
        setStatus("Invalid item options JSON", "error");
      }
    };
    return;
  }

  document.querySelectorAll("[data-option]").forEach((control: any) => {
    control.onchange = (event: any) => {
      const target = event.target;
      const key = target.dataset.option;
      if (!key) return;
      if (target.type === "checkbox") {
        setSlotOption(item, key, target.checked, defaultSlotOptionValue(key));
      } else if (target.type === "number") {
        const value = target.value.trim();
        setSlotOption(item, key, value ? Number(value) : undefined);
      } else if (target.dataset.array === "true") {
        const values = target.value.split(",").map((part: any) => part.trim()).filter(Boolean);
        setSlotOption(item, key, values.length ? values : undefined);
      } else {
        setSlotOption(item, key, target.value || undefined, defaultSlotOptionValue(key));
      }
      markDirty();
    };
  });
}

function setSlotOption(item: any, key: any, value: any, defaultValue: any = undefined) {
  const options = { ...(item.options || {}) };
  if (value === undefined || value === defaultValue) delete options[key];
  else options[key] = value;
  item.options = Object.keys(options).length ? options : undefined;
}

function defaultSlotOptionValue(key: any) {
  if (["includeLastUserMessage", "includeSummaries", "includeStatic", "includeSession", "includeTurn"].includes(key)) return true;
  if (["stripAssistantThinking", "includeTime"].includes(key)) return false;
  if (key === "toolMode") return "keep";
  if (key === "format") return "xml";
  return undefined;
}

function optionCheckbox(key: any, label: any, checked: any) {
  return '<label class="checkline" title="' + attr(optionHelp(key)) + '"><input type="checkbox" data-option="' + attr(key) + '" ' + (checked ? "checked" : "") + '> ' + escapeHtml(label) + '</label>';
}

function optionSelect(key: any, label: any, value: any, choices: any) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><select data-option="' + attr(key) + '">' +
    choices.map((choice: any) => '<option value="' + attr(choice) + '"' + (choice === value ? " selected" : "") + '>' + escapeHtml(choice) + '</option>').join("") +
    '</select></div>';
}

function optionText(key: any, label: any, value: any) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><input data-option="' + attr(key) + '" data-array="true" value="' + attr(value) + '" placeholder="comma,separated"></div>';
}

function optionNumber(key: any, label: any, value: any) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><input type="number" min="1" data-option="' + attr(key) + '" value="' + attr(value) + '"></div>';
}

function optionHelp(key: any) {
  const descriptions = {
    includeLastUserMessage: "Keep the latest user message inside the inserted chat history.",
    stripAssistantThinking: "Remove prior assistant thinking blocks from inserted chat history while keeping visible text, tool calls, and tool results.",
    includeSummaries: "Keep Pi branch and compaction summary messages inside inserted chat history.",
    toolMode: "Keep tool calls/results or drop prior tool history from inserted chat history.",
    roles: "Optional comma-separated message roles to keep, such as user, assistant, toolResult, compactionSummary.",
    maxMessages: "Keep only the most recent N chat-history messages after filtering.",
    maxChars: "Keep only the most recent chat-history messages within an approximate character budget.",
    includeStatic: "Include static stack variables in this variables slot.",
    includeSession: "Include session variables created by template macros.",
    includeTurn: "Include temporary turn variables created during prompt compilation.",
    includeTime: "Render the current time in HH:MM:SS after the current date.",
    format: "Choose XML or compact plain text rendering.",
  };
  return descriptions[key as keyof typeof descriptions] || "Advanced slot option.";
}

function showStackModal(title: any, meta: any, body: any, options: any = {}) {
  const pane = el("stackModal");
  pane.innerHTML = '<div class="modal-dialog" role="dialog" aria-modal="true" aria-label="' + attr(title) + '">' +
    '<div class="modal-head"><div><div class="modal-title">' + escapeHtml(title) + '</div><div class="modal-meta">' + escapeHtml(meta || "") + '</div></div>' +
    '<div class="modal-actions"><button data-modal-close="true" data-icon="×" title="Close this dialog">Close</button></div></div>' +
    '<div class="modal-body ' + attr(options.bodyClass || "") + '">' + body + '</div></div>';
  pane.classList.add("open");
}

function closeStackModal() {
  const pane = el("stackModal");
  pane.classList.remove("open");
  pane.innerHTML = "";
}

function applyStackFromVue(stack: EditorPromptStack) {
  currentStack = stack;
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  selectedItemIndex = stack.items.length ? Math.min(Math.max(selectedItemIndex, 0), stack.items.length - 1) : -1;
  optionsError = "";
  vueTabHost.resetErrors();
  markDirty();
  renderAll(latestDiagnostics);
  setStatus("Applied stack JSON to editor", "success");
}

function addItem(kind: any) {
  if (!currentStack) return;
  const id = nextNumericItemId();
  const insertIndex = selectedItemIndex >= 0 && selectedItemIndex < currentStack.items.length
    ? selectedItemIndex + 1
    : currentStack.items.length;
  currentStack.items.splice(insertIndex, 0, kind === "slot"
    ? { kind: "slot", id, enabled: true, slot: "chat-history" }
    : { kind: "block", id, enabled: true, role: "user", content: "" });
  selectedItemIndex = insertIndex;
  markDirty();
  renderItemList();
  renderItemEditor();
}

function nextNumericItemId() {
  const existing = new Set((currentStack?.items || []).map((item: any) => String(item.id)));
  let index = 1;
  while (existing.has(String(index))) index++;
  return String(index);
}

function deleteSelectedItem() {
  if (!currentStack || selectedItemIndex < 0) return;
  const item = currentStack.items[selectedItemIndex];
  if (!confirm("Delete item " + item.id + "?")) return;
  currentStack.items.splice(selectedItemIndex, 1);
  selectedItemIndex = Math.min(selectedItemIndex, currentStack.items.length - 1);
  markDirty();
  renderItemList();
  renderItemEditor();
}

async function saveStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId), { method: "PUT", body: { stack } });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.id || stack.id;
  currentStack = structuredClone(stack);
  dirty = false;
  renderDirtyState();
  renderAll(data.stack?.diagnostics || []);
  setStatus("Saved " + selectedId, "success");
  await selectStack(selectedId, { keepDirty: true });
}

async function createStackRemote(stack: any, options: any = {}) {
  try {
    return await api("/api/stacks", { method: "POST", body: { stack, ...options } });
  } catch (error) {
    if (error instanceof EditorApiError && error.status === 409 && !options.overwrite && confirm((error.message || "Stack already exists.") + "\n\nOverwrite it?")) {
      return await api("/api/stacks", { method: "POST", body: { stack, ...options, overwrite: true } });
    }
    throw error;
  }
}

async function createAndOpenStack(stack: any, activate: any, actionLabel: any, extraOptions: any = {}) {
  const data = await createStackRemote(stack, { ...extraOptions, activate });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.id || stack.id;
  dirty = false;
  renderDirtyState();
  await selectStack(selectedId, { keepDirty: true });
  const converted = data.importFormat === "sillytavern" ? " from SillyTavern" : "";
  setStatus(actionLabel + converted + " " + selectedId, "success");
  if (data.importReport) showImportReport(data.importReport, selectedId);
}

async function createNewStack() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const promptedId = prompt("New stack id", uniqueStackId("new-stack"));
  if (promptedId === null) return;
  const id = sanitizeStackId(promptedId);
  if (!id) throw new Error("Stack id must not be empty.");
  if (id !== promptedId.trim() && !confirm("Use stack id '" + id + "'?")) return;
  const promptedName = prompt("Stack display name", "Default Pi Prompt Mirror");
  if (promptedName === null) return;
  const stack = defaultNewStack(id, promptedName.trim() || id);
  const activate = stacks.length === 0 || confirm("Activate new stack now?");
  await createAndOpenStack(stack, activate, "Created");
}

function defaultNewStack(id: any, name: any) {
  return {
    schemaVersion: 1,
    type: "pi-forge.prompt-stack",
    id,
    name,
    description: "Recreates Pi's built-in prompt layout with pi-forge slots, exposing tools, guidelines, docs, append-system-prompt, project context, skills, date/cwd, and chat history as movable pieces.",
    autoActivate: stacks.length === 0,
    mode: "replace",
    defaults: {
      syntheticMessagesVisible: false,
      unresolvedMacroPolicy: "warn",
    },
    context: {
      allowDuplicateChatHistory: false,
    },
    tools: {
      allow: ["*"],
    },
    skills: {
      allow: ["*"],
    },
    items: [
      {
        kind: "block",
        id: "main-role",
        name: "Pi Default Role",
        enabled: true,
        role: "system",
        source: {
          package: "@earendil-works/pi-coding-agent",
          file: "dist/core/system-prompt.js",
        },
        content: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      },
      {
        kind: "slot",
        id: "tools",
        name: "Available Tools",
        enabled: true,
        role: "system",
        slot: "tools",
        options: {
          format: "plain",
          onlyWithSnippets: true,
        },
      },
      {
        kind: "block",
        id: "custom-tools-note",
        name: "Custom Tools Note",
        enabled: true,
        role: "system",
        content: "In addition to the tools above, you may have access to other custom tools depending on the project.",
      },
      {
        kind: "slot",
        id: "tool-guidelines",
        name: "Guidelines",
        enabled: true,
        role: "system",
        slot: "tool-guidelines",
        options: {
          format: "plain",
          heading: "Guidelines:",
          includePiDefaultGuidelines: true,
          piStyle: true,
        },
      },
      {
        kind: "slot",
        id: "pi-docs",
        name: "Pi Documentation Guidance",
        enabled: true,
        role: "system",
        slot: "pi-docs",
      },
      {
        kind: "slot",
        id: "append-system-prompt",
        name: "User Append System Prompt",
        enabled: true,
        role: "system",
        slot: "append-system-prompt",
      },
      {
        kind: "slot",
        id: "project-context",
        name: "Project Context",
        enabled: true,
        role: "system",
        slot: "project-context",
      },
      {
        kind: "slot",
        id: "skills",
        name: "Available Skills",
        enabled: true,
        role: "system",
        slot: "skills",
        options: {
          requireReadTool: true,
        },
      },
      {
        kind: "slot",
        id: "date-cwd",
        name: "Date and Working Directory",
        enabled: true,
        role: "system",
        slot: "date-cwd",
      },
      {
        kind: "slot",
        id: "chat-history",
        name: "Chat History",
        enabled: true,
        slot: "chat-history",
      },
    ],
  };
}

function showImportReport(report: any, stackId: any) {
  showStackModal(
    "SillyTavern import report",
    stackId || "",
    '<div class="modal-toolbar"><button id="copyImportReportBtn" data-icon="□" title="Copy this import report">Copy report</button><span class="modal-spacer"></span><span class="modal-meta">Report-only notes; stack changes are already saved.</span></div>' +
    '<pre class="preview-text">' + escapeHtml(report) + '</pre>',
  );
  el("copyImportReportBtn").onclick = () => run(async () => {
    await copyTextToClipboard(report);
    setStatus("Copied import report", "success");
  });
}

async function importStackJson() {
  el("importFileInput").value = "";
  el("importFileInput").click();
}

async function handleImportFile(event: any) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const imported = JSON.parse(text);
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error("Imported JSON must be an object.");
  if (isSillyTavernImport(imported)) {
    const characterId = promptSillyTavernCharacterId(imported);
    if (characterId === null) return;
    const activate = confirm("Convert and activate imported SillyTavern stack now?");
    await createAndOpenStack(imported, activate, "Imported", { sourceName: file.name, characterId });
    return;
  }

  const stack = imported;
  if (!stack.id || typeof stack.id !== "string") {
    const promptedId = prompt("Stack id", sanitizeStackId(file.name.replace(/\.json$/i, "")));
    if (!promptedId) return;
    stack.id = promptedId.trim();
  }
  if (!Array.isArray(stack.items)) throw new Error("Imported stack must contain an items array.");
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  const activate = confirm("Activate imported stack now?");
  await createAndOpenStack(stack, activate, "Imported");
}

function isSillyTavernImport(value: any) {
  return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.prompts) && !Array.isArray(value.items);
}

function promptSillyTavernCharacterId(value: any) {
  const ids = Array.isArray(value.prompt_order)
    ? value.prompt_order
      .map((entry: any) => entry && entry.character_id)
      .filter((id: any) => Number.isInteger(id))
    : [];
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length <= 1) return undefined;
  const answer = prompt("SillyTavern character_id (" + uniqueIds.join(", ") + ")", String(uniqueIds[0]));
  if (answer === null) return null;
  const parsed = Number(answer.trim());
  if (!Number.isInteger(parsed) || !uniqueIds.includes(parsed)) {
    throw new Error("Choose one of these character_id values: " + uniqueIds.join(", "));
  }
  return parsed;
}

async function forkStack() {
  const source = stackForSubmit();
  const forkId = prompt("New fork stack id", uniqueForkId(source.id || "stack"));
  if (!forkId) return;
  const forkName = prompt("Fork display name", ((source.name || source.id || "Prompt stack") + " fork"));
  const fork = structuredClone(source);
  fork.id = forkId.trim();
  if (forkName && forkName.trim()) fork.name = forkName;
  fork.autoActivate = false;
  const activate = confirm("Activate fork now?");
  await createAndOpenStack(fork, activate, "Forked");
}

async function exportStackJson() {
  const stack = stackForSubmit();
  const json = JSON.stringify(stack, null, 2) + "\n";
  const downloaded = downloadTextFile(sanitizeStackId(stack.id || "prompt-stack") + ".json", json, "application/json");
  if (downloaded) {
    setStatus("Exported " + (stack.id || "prompt stack"), "success");
    return;
  }
  await copyTextToClipboard(json);
  setStatus("Copied " + (stack.id || "prompt stack") + " JSON", "success");
}

function downloadTextFile(filename: any, text: any, type: any) {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return false;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  if (!("download" in link)) {
    URL.revokeObjectURL(url);
    return false;
  }
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

function uniqueForkId(baseId: any) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack: any) => stack.id));
  let candidate = base + "-fork";
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-fork-" + index++;
  return candidate;
}

function uniqueStackId(baseId: any) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack: any) => stack.id));
  let candidate = base;
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-" + index++;
  return candidate;
}

function sanitizeStackId(value: any) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function activateStack() {
  if (!currentStack) return;
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/activate", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Activated " + selectedId, "success");
}

async function disableStacks() {
  const data = await api("/api/disable", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Prompt stack disabled", "success");
}

async function deleteCurrentStack() {
  if (!currentStack) return;
  const id = selectedId;
  const message = "Delete prompt stack '" + id + "'?\n\nThis removes its JSON file from prompt-stack storage.";
  if (!confirm(message)) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id), { method: "DELETE" });
  stacks = data.stacks || [];
  dirty = false;
  renderDirtyState();
  const next = stacks.find((stack: any) => stack.active) || stacks[0];
  if (next) {
    await selectStack(next.id, { keepDirty: true });
    setStatus("Deleted " + id, "success");
  } else {
    renderStackList();
    renderEmpty();
    setStatus("Deleted " + id + "; no stacks remain", "success");
  }
}

async function reloadFromDisk() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/reload", { method: "POST" });
  stacks = data.stacks || [];
  renderStackList();
  await loadStacks(selectedId);
  setStatus("Reloaded from disk", "success");
}

function stackForSubmit() {
  if (!currentStack) throw new Error("No stack selected.");
  if (optionsError) throw new Error("Invalid item options JSON: " + optionsError);
  const stackError = vueTabHost.getError("stack");
  if (stackError) throw new Error(stackError);
  const regexError = vueTabHost.getError("regex");
  if (regexError) throw new Error(regexError);
  const policyError = vueTabHost.getError("policy");
  if (policyError) throw new Error(policyError);
  const clone = structuredClone(currentStack);
  if (!clone.type) clone.type = "pi-forge.prompt-stack";
  if (!clone.schemaVersion) clone.schemaVersion = 1;
  return clone;
}

function renderDiagnostics(diagnostics: any) {
  latestDiagnostics = diagnostics || [];
  const pane = el("diagnostics");
  if (!latestDiagnostics.length) {
    pane.innerHTML = '<div class="diagnostic info">No diagnostics.</div>';
    return;
  }
  pane.innerHTML = latestDiagnostics.map((diag: any) => {
    const level = diag.level || "info";
    const item = diag.itemId ? " [" + escapeHtml(diag.itemId) + "]" : "";
    return '<div class="diagnostic ' + attr(level) + '"><strong>' + escapeHtml(level.toUpperCase()) + item + '</strong>: ' + escapeHtml(diag.message || "") + '</div>';
  }).join("");
}

function renderEmpty() {
  vueTabHost.unmount();
  currentStack = null;
  selectedId = "";
  dirty = false;
  activeTab = "items";
  vueTabHost.resetErrors();
  renderDirtyState();
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  el("workspace").style.display = "";
  el("metadataPanel").style.display = "none";
  el("settings").innerHTML = "";
  el("itemCount").textContent = "";
  el("itemList").innerHTML = "";
  el("itemEditor").innerHTML =
    '<div class="empty">' +
    '<div class="empty-title">No prompt stacks found.</div>' +
    '<div>Create a stack in this project, or import an existing pi-forge/SillyTavern JSON file.</div>' +
    '<div class="empty-actions">' +
    '<button id="emptyNewStackBtn" class="primary" data-icon="+" title="Create a new prompt stack">New stack</button>' +
    '<button id="emptyImportBtn" data-icon="⇪" title="Import pi-forge stack JSON or SillyTavern preset JSON">Import JSON</button>' +
    '</div>' +
    '</div>';
  el("tabPanel").classList.remove("open");
  el("tabPanel").innerHTML = "";
  renderDiagnostics([]);
  el("emptyNewStackBtn").onclick = () => run(createNewStack);
  el("emptyImportBtn").onclick = () => run(importStackJson);
  setStatus("No prompt stacks found");
  updateActionState();
}

function field(label: any, control: any, className: any = "") {
  return '<div class="field ' + className + '"><label>' + escapeHtml(label) + '</label>' + control + '</div>';
}

function displayItemName(item: any) {
  if (item.name) return item.name;
  if (item.source && typeof item.source.previousName === "string" && item.source.previousName.trim()) return item.source.previousName;
  if (item.kind === "slot" && item.slot) return item.slot;
  if (item.kind === "block" && item.content) {
    const firstLine = item.content.trim().split(/\n/)[0]?.trim();
    if (firstLine) return firstLine.length > 46 ? firstLine.slice(0, 43) + "..." : firstLine;
  }
  return item.id || "(unnamed)";
}

function setOptionalString(target: any, key: any, value: any) {
  const trimmed = value.trim();
  if (trimmed) target[key] = value;
  else delete target[key];
}

async function run(action: any) {
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  el("shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
  el("sidebarToggleBtn").title = sidebarCollapsed ? "Show prompt stacks sidebar" : "Hide prompt stacks sidebar";
  setStatus(sidebarCollapsed ? "Prompt stacks sidebar hidden" : "Prompt stacks sidebar shown");
}

function handleStackModalClick(event: any) {
  if (event.target === el("stackModal") || event.target.closest?.("[data-modal-close]")) {
    closeStackModal();
  }
}

function handlePreviewClick(event: any) {
  if (event.target === el("preview") || event.target.closest?.("[data-preview-close]")) {
    hidePreview();
    return;
  }
  if (event.target.closest?.("[data-payload-arm]")) {
    event.preventDefault();
    event.stopPropagation();
    run(() => armPayloadCapture(true));
    return;
  }
  if (event.target.closest?.("[data-payload-clear]")) {
    event.preventDefault();
    event.stopPropagation();
    run(clearPayloadCapture);
    return;
  }
  const button = event.target.closest?.("[data-copy-index]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  run(() => copyPreviewText(Number(button.dataset.copyIndex)));
}

function handleEditorShortcut(event: any) {
  if (event.key === "Escape") {
    if (el("preview").classList.contains("open")) hidePreview();
    else if (el("stackModal").classList.contains("open")) closeStackModal();
    return;
  }

  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier || event.altKey) return;
  const key = event.key.toLowerCase();

  if (key === "n") {
    event.preventDefault();
    run(createNewStack);
    return;
  }
  if (key === "s") {
    event.preventDefault();
    if (currentStack) run(saveStack);
    return;
  }
  if (key === "enter" && event.shiftKey) {
    event.preventDefault();
    if (currentStack) run(validateStack);
    return;
  }
  if (key === "enter") {
    event.preventDefault();
    if (currentStack) run(previewStack);
  }
}

export function startLegacyEditor(): () => void {
  resetEditorState();
  editorStarted = true;
  applyTheme(currentTheme);

  el("sidebarToggleBtn").onclick = toggleSidebar;
  el("themeBtn").onclick = toggleTheme;
  el("newStackBtn").onclick = () => run(createNewStack);
  el("reloadBtn").onclick = () => run(reloadFromDisk);
  el("disableBtn").onclick = () => run(disableStacks);
  el("activateBtn").onclick = () => run(activateStack);
  el("saveBtn").onclick = () => run(saveStack);
  el("validateBtn").onclick = () => run(validateStack);
  el("previewBtn").onclick = () => run(previewStack);
  el("payloadBtn").onclick = () => run(openPayloadCapture);
  el("metadataToggleBtn").onclick = toggleMetadata;
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.onclick = () => {
      activeTab = button.dataset.tab || "items";
      renderActiveTab();
      hidePreview();
    };
  });
  el("forkBtn").onclick = () => run(forkStack);
  el("importBtn").onclick = () => run(importStackJson);
  el("exportBtn").onclick = () => run(exportStackJson);
  el("importFileInput").onchange = (event: any) => run(() => handleImportFile(event));
  el("deleteStackBtn").onclick = () => run(deleteCurrentStack);
  el("stackModal").onclick = handleStackModalClick;
  el("preview").onclick = handlePreviewClick;
  el("addItemBtn").onclick = () => addItem("block");
  el("addSlotBtn").onclick = () => addItem("slot");
  el("deleteItemBtn").onclick = deleteSelectedItem;

  document.addEventListener("dragover", handleDocumentItemDragOver);
  document.addEventListener("drop", handleDocumentItemDrop);
  window.addEventListener("keydown", handleEditorShortcut);
  const previousBeforeUnload = window.onbeforeunload;
  const beforeUnload = () => dirty ? "Unsaved changes" : undefined;
  window.onbeforeunload = beforeUnload;
  let payloadPoll: number | undefined;

  void run(async () => {
    await loadStacks();
    if (!editorStarted) return;
    await refreshPayloadCapture();
    if (!editorStarted) return;
    payloadPoll = window.setInterval(() => run(() => refreshPayloadCapture({ autoOpen: true })), 2000);
  });

  return () => {
    if (!editorStarted) return;
    editorStarted = false;
    if (payloadPoll !== undefined) window.clearInterval(payloadPoll);
    finishItemDrag();
    document.removeEventListener("dragover", handleDocumentItemDragOver);
    document.removeEventListener("drop", handleDocumentItemDrop);
    window.removeEventListener("keydown", handleEditorShortcut);
    if (window.onbeforeunload === beforeUnload) window.onbeforeunload = previousBeforeUnload;
    vueTabHost.unmount();
  };
}

function resetEditorState(): void {
  if (dragScrollFrame) cancelAnimationFrame(dragScrollFrame);
  stacks = [];
  cwd = "";
  selectedId = "";
  currentStack = null;
  currentFilePath = "";
  selectedItemIndex = -1;
  dirty = false;
  dragIndex = -1;
  dragDropIndex = -1;
  dragScrollFrame = 0;
  dragScrollSpeed = 0;
  dragClientY = 0;
  optionsText = "";
  optionsError = "";
  sidebarCollapsed = false;
  slotOptionsMode = "form";
  policyResources = { tools: [], skills: [] };
  latestDiagnostics = [];
  activeTab = "items";
  metadataCollapsed = true;
  currentTheme = readStoredTheme() || (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
  vueTabHost.resetErrors();
}
