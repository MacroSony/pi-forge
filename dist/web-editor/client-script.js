export const EDITOR_CLIENT_SCRIPT = String.raw `
const token = new URLSearchParams(location.search).get("token") || "";
let stacks = [];
let cwd = "";
let selectedId = "";
let currentStack = null;
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
let slotOptionsMode = "form";
let previewCopyTexts = [];
let payloadSnapshot = { status: "idle" };
let policyResources = { tools: [], skills: [] };
let latestDiagnostics = [];
let stackVariablesError = "";
let regexRulesError = "";
let stackPolicyError = "";
let activeTab = "items";
let metadataCollapsed = true;
let currentTheme = readStoredTheme() || (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");

const slotNames = [
  "chat-history", "tools", "tool-guidelines", "skills", "project-context",
  "append-system-prompt", "variables", "date", "cwd", "date-cwd",
  "active-model", "pi-docs"
];
const roles = ["", "system", "user", "assistant", "custom"];
const regexStages = ["history", "compiled"];
const regexEffects = ["outgoing", "finalize", "display", "both"];
const regexTargets = ["system", "messages"];
const regexRoles = ["system", "user", "assistant", "custom"];

const el = (id) => document.getElementById(id);

function applyTheme(theme) {
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

applyTheme(currentTheme);

function readStoredTheme() {
  try {
    return localStorage.getItem("pi-forge-theme");
  } catch {
    return "";
  }
}

function writeStoredTheme(theme) {
  try {
    localStorage.setItem("pi-forge-theme", theme);
  } catch {
    // Ignore storage failures; the current page can still switch themes.
  }
}

async function api(path, options = {}) {
  const headers = { "x-pi-forge-token": token, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    throw error;
  }
  return data;
}

function setStatus(text, tone = "") {
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
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.disabled = !hasStack;
  });
}

async function loadStacks(preferId = selectedId) {
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  stacks = data.stacks || [];
  policyResources = normalizePolicyResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  const next = stacks.find((stack) => stack.id === preferId) || stacks.find((stack) => stack.active) || stacks[0];
  if (next) await selectStack(next.id, { keepDirty: false });
  else renderEmpty();
}

async function selectStack(id, options = {}) {
  if (dirty && !options.keepDirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id));
  selectedId = id;
  currentStack = structuredClone(data.stack);
  currentFilePath = data.filePath || "";
  selectedItemIndex = currentStack.items.length ? 0 : -1;
  dirty = false;
  optionsError = "";
  stackVariablesError = "";
  regexRulesError = "";
  stackPolicyError = "";
  renderDirtyState();
  renderAll(data.diagnostics || []);
  setStatus("Loaded " + currentStack.id);
}

function renderAll(diagnostics = []) {
  latestDiagnostics = diagnostics;
  renderStackList();
  renderSettings();
  renderActiveTab();
  renderDiagnostics(diagnostics);
  hidePreview();
  updateActionState();
}

function renderActiveTab() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
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
  if (activeTab === "regex") renderRegexTab();
  else if (activeTab === "policy") renderPolicyTab();
  else if (activeTab === "stack") renderStackTab();
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

function normalizePolicyResources(value) {
  return {
    tools: normalizeResourceList(value?.tools),
    skills: normalizeResourceList(value?.skills),
  };
}

function normalizeResourceList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((resource) => resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.trim())
    .map((resource) => ({
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
    field("Stack ID", '<input id="stackId" value="' + attr(currentStack.id) + '">'),
    field("Name", '<input id="stackName" value="' + attr(currentStack.name || "") + '">'),
    field("Mode", '<select id="stackMode"><option value="replace">replace</option><option value="append">append</option><option value="prepend">prepend</option></select>'),
    field("Auto activate", '<label class="checkline"><input id="stackAuto" type="checkbox"> enabled</label>'),
    field("Description", '<textarea id="stackDescription" class="wide">' + escapeHtml(currentStack.description || "") + '</textarea>', "wide"),
    field("File", '<input value="' + attr(currentFilePath) + '" disabled>', "wide"),
  ].join("");
  el("stackMode").value = currentStack.mode || "replace";
  el("stackAuto").checked = currentStack.autoActivate === true;
  el("stackId").oninput = (event) => { currentStack.id = event.target.value; markDirty(); };
  el("stackName").oninput = (event) => { setOptionalString(currentStack, "name", event.target.value); markDirty(); };
  el("stackMode").onchange = (event) => { currentStack.mode = event.target.value; markDirty(); };
  el("stackAuto").onchange = (event) => { currentStack.autoActivate = event.target.checked; markDirty(); };
  el("stackDescription").oninput = (event) => { setOptionalString(currentStack, "description", event.target.value); markDirty(); };
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
  currentStack.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "item-row" + (index === selectedItemIndex ? " selected" : "") + (item.enabled === false ? " disabled" : "");
    row.dataset.itemIndex = String(index);
    row.draggable = true;
    const enabled = item.enabled !== false;
    const itemDiagnostics = diagnosticsByItem[item.id] || [];
    const errors = itemDiagnostics.filter((diag) => diag.level === "error").length;
    const warnings = itemDiagnostics.filter((diag) => diag.level === "warning").length;
    const diagBadge = errors
      ? '<span class="item-badge error" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + errors + 'E</span>'
      : warnings
        ? '<span class="item-badge warning" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + warnings + 'W</span>'
        : "";
    row.innerHTML = '<div class="drag-handle" title="Drag to reorder">≡</div>' +
      '<div><div class="item-title">' + escapeHtml(displayItemName(item)) + diagBadge + '</div>' +
      '<div class="item-meta">' + escapeHtml(item.kind) + ' | id: ' + escapeHtml(item.id) + (item.role ? " | " + escapeHtml(item.role) : "") + (item.kind === "slot" ? " | " + escapeHtml(item.slot || "") : "") + '</div></div>' +
      '<button type="button" class="item-toggle ' + (enabled ? "enabled" : "disabled") + '" title="Toggle item">' + (enabled ? "On" : "Off") + '</button>';
    row.onclick = (event) => {
      if (event.target?.classList?.contains("item-toggle")) return;
      selectedItemIndex = index;
      renderItemList();
      renderItemEditor();
    };
    row.querySelector(".item-toggle").onclick = (event) => {
      event.stopPropagation();
      item.enabled = item.enabled === false;
      selectedItemIndex = index;
      markDirty();
      renderItemList();
      renderItemEditor();
    };
    row.ondragstart = (event) => {
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

function handleItemListDragOver(event) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleItemListDrop(event) {
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

function setItemDropIndex(index) {
  if (!currentStack) return;
  const next = Math.max(0, Math.min(index, currentStack.items.length));
  if (dragDropIndex === next) return;
  dragDropIndex = next;
  updateItemDropIndicator();
}

function dropIndexFromClientY(clientY) {
  const list = el("itemList");
  const rows = [...list.querySelectorAll(".item-row")];
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

function updateItemDragAutoScroll(clientY) {
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

function finishItemDrag(clearIndicator = true) {
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

function handleDocumentItemDragOver(event) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleDocumentItemDrop(event) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dropDraggedItem();
}

function diagnosticsForItems() {
  const grouped = {};
  for (const diagnostic of latestDiagnostics || []) {
    if (!diagnostic.itemId) continue;
    if (!grouped[diagnostic.itemId]) grouped[diagnostic.itemId] = [];
    grouped[diagnostic.itemId].push(diagnostic);
  }
  return grouped;
}

function diagnosticTitle(diagnostics) {
  return diagnostics.map((diag) => (diag.level || "info").toUpperCase() + ": " + (diag.message || "")).join("\n");
}

function renderItemEditor() {
  const editor = el("itemEditor");
  if (!currentStack || selectedItemIndex < 0 || !currentStack.items[selectedItemIndex]) {
    editor.innerHTML = '<div class="empty">No item selected.</div>';
    el("deleteItemBtn").disabled = true;
    return;
  }
  el("deleteItemBtn").disabled = false;
  const item = currentStack.items[selectedItemIndex];
  optionsText = JSON.stringify(item.options || {}, null, 2);
  optionsError = "";
  const slotSelect = '<select id="itemSlot">' + slotNames.map((slot) => '<option value="' + attr(slot) + '">' + escapeHtml(slot) + '</option>').join("") + '</select>';
  const roleSelect = '<select id="itemRole">' + roles.map((role) => '<option value="' + attr(role) + '">' + escapeHtml(role || "(none)") + '</option>').join("") + '</select>';
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

  el("itemKind").onchange = (event) => {
    if (event.target.value === item.kind) return;
    const base = { id: item.id, name: item.name, enabled: item.enabled, role: item.role, tags: item.tags, source: item.source };
    currentStack.items[selectedItemIndex] = event.target.value === "slot"
      ? { ...base, kind: "slot", slot: "chat-history" }
      : { ...base, kind: "block", content: "" };
    markDirty();
    renderItemList();
    renderItemEditor();
  };
  el("itemId").oninput = (event) => { item.id = event.target.value; markDirty(); renderItemList(); };
  el("itemName").oninput = (event) => { setOptionalString(item, "name", event.target.value); markDirty(); };
  el("itemRole").onchange = (event) => { setOptionalString(item, "role", event.target.value); markDirty(); renderItemList(); };
  if (item.kind === "block") {
    el("itemContent").oninput = (event) => { item.content = event.target.value; markDirty(); };
  } else {
    el("itemSlot").onchange = (event) => { item.slot = event.target.value; markDirty(); renderItemList(); };
    bindSlotOptionsEditor(item);
  }
}

function renderSlotOptionsEditor(item) {
  const options = item.options || {};
  const jsonActive = slotOptionsMode === "json";
  const formButton = '<button id="slotOptionsFormBtn" type="button" class="' + (!jsonActive ? "active" : "") + '">Form</button>';
  const jsonButton = '<button id="slotOptionsJsonBtn" type="button" class="' + (jsonActive ? "active" : "") + '">JSON</button>';
  const body = jsonActive
    ? '<textarea id="itemOptions" class="json-options">' + escapeHtml(optionsText) + '</textarea>'
    : renderSlotOptionsForm(item, options);
  return '<div class="field wide slot-options"><label>Slot options</label><div class="segmented">' + formButton + jsonButton + '</div>' + body + '</div>';
}

function renderSlotOptionsForm(item, options) {
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

function bindSlotOptionsEditor(item) {
  el("slotOptionsFormBtn").onclick = () => {
    slotOptionsMode = "form";
    renderItemEditor();
  };
  el("slotOptionsJsonBtn").onclick = () => {
    slotOptionsMode = "json";
    renderItemEditor();
  };

  if (slotOptionsMode === "json") {
    el("itemOptions").oninput = (event) => {
      optionsText = event.target.value;
      try {
        const parsed = optionsText.trim() ? JSON.parse(optionsText) : {};
        item.options = Object.keys(parsed).length ? parsed : undefined;
        optionsError = "";
        markDirty();
      } catch (error) {
        optionsError = error.message;
        setStatus("Invalid item options JSON", "error");
      }
    };
    return;
  }

  document.querySelectorAll("[data-option]").forEach((control) => {
    control.onchange = (event) => {
      const target = event.target;
      const key = target.dataset.option;
      if (!key) return;
      if (target.type === "checkbox") {
        setSlotOption(item, key, target.checked, defaultSlotOptionValue(key));
      } else if (target.type === "number") {
        const value = target.value.trim();
        setSlotOption(item, key, value ? Number(value) : undefined);
      } else if (target.dataset.array === "true") {
        const values = target.value.split(",").map((part) => part.trim()).filter(Boolean);
        setSlotOption(item, key, values.length ? values : undefined);
      } else {
        setSlotOption(item, key, target.value || undefined, defaultSlotOptionValue(key));
      }
      markDirty();
    };
  });
}

function setSlotOption(item, key, value, defaultValue) {
  const options = { ...(item.options || {}) };
  if (value === undefined || value === defaultValue) delete options[key];
  else options[key] = value;
  item.options = Object.keys(options).length ? options : undefined;
}

function defaultSlotOptionValue(key) {
  if (["includeLastUserMessage", "includeSummaries", "includeStatic", "includeSession", "includeTurn"].includes(key)) return true;
  if (["stripAssistantThinking", "includeTime"].includes(key)) return false;
  if (key === "toolMode") return "keep";
  if (key === "format") return "xml";
  return undefined;
}

function optionCheckbox(key, label, checked) {
  return '<label class="checkline" title="' + attr(optionHelp(key)) + '"><input type="checkbox" data-option="' + attr(key) + '" ' + (checked ? "checked" : "") + '> ' + escapeHtml(label) + '</label>';
}

function optionSelect(key, label, value, choices) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><select data-option="' + attr(key) + '">' +
    choices.map((choice) => '<option value="' + attr(choice) + '"' + (choice === value ? " selected" : "") + '>' + escapeHtml(choice) + '</option>').join("") +
    '</select></div>';
}

function optionText(key, label, value) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><input data-option="' + attr(key) + '" data-array="true" value="' + attr(value) + '" placeholder="comma,separated"></div>';
}

function optionNumber(key, label, value) {
  return '<div class="field" title="' + attr(optionHelp(key)) + '"><label>' + escapeHtml(label) + '</label><input type="number" min="1" data-option="' + attr(key) + '" value="' + attr(value) + '"></div>';
}

function optionHelp(key) {
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
  return descriptions[key] || "Advanced slot option.";
}

function showStackModal(title, meta, body, options = {}) {
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

function openContextEditor() {
  if (!currentStack) return;
  showStackModal(
    "Context options",
    "Stack-level behavior for how pi-forge rewrites Pi conversation context.",
    '<div class="modal-toolbar"><span class="modal-meta">Save writes these changes to the stack JSON.</span></div>' +
      '<div class="data-table">' +
      '<div class="data-row">' +
      '<label class="checkline" title="Allow multiple enabled chat-history slots. When off, only the first enabled chat-history slot is expanded.">' +
      '<input id="allowDuplicateChatHistoryInput" type="checkbox" ' + (currentStack.context?.allowDuplicateChatHistory === true ? "checked" : "") + '> Allow duplicate chat-history slots</label>' +
      '<div class="option-note">Keep this off unless you intentionally want the same conversation history injected more than once.</div>' +
      '</div>' +
      '</div>',
  );
  el("allowDuplicateChatHistoryInput").onchange = (event) => {
    setContextOption("allowDuplicateChatHistory", event.target.checked, false);
    markDirty();
  };
}

function setContextOption(key, value, defaultValue) {
  const context = { ...(currentStack.context || {}) };
  if (value === defaultValue || value === undefined) delete context[key];
  else context[key] = value;
  if (Object.keys(context).length) currentStack.context = context;
  else delete currentStack.context;
}

function renderRegexTab() {
  if (!currentStack) return;
  el("tabPanel").innerHTML = '<div class="tab-section">' + regexEditorBody() + '</div>';
  bindRegexEditor();
}

function renderPolicyTab() {
  if (!currentStack) return;
  el("tabPanel").innerHTML =
    '<div class="tab-section">' +
    '<div class="tab-section-title">Tool and skill policy</div>' +
    '<div class="tab-section-meta">Choose one mode per resource. Patterns support exact names and * wildcards.</div>' +
    '<div class="data-table" id="policyRows">' +
    '<div class="data-row header policy-row"><div>Resource</div><div>Mode</div><div>Patterns</div><div>Available</div><div>Status</div></div>' +
    policyRowHtml("tools", "Tools") +
    policyRowHtml("skills", "Skills") +
    '</div>' +
    '</div>';
  bindPolicyEditor();
}

function policyRowHtml(kind, label) {
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

function selectedPolicyPatternsHtml(patterns) {
  return '<div class="selected-patterns" data-selected-patterns>' + selectedPolicyPatternButtonsHtml(patterns) + '</div>';
}

function selectedPolicyPatternButtonsHtml(patterns) {
  if (!patterns.length) return '<span class="selected-pattern-empty">No selected patterns.</span>';
  return patterns.map((pattern) =>
    '<button type="button" class="selected-pattern-chip" data-remove-policy-pattern="' + attr(pattern) + '" title="Remove selected pattern">' +
    escapeHtml(pattern) + '<span aria-hidden="true">x</span></button>'
  ).join("");
}

function resourcePickerHtml(kind, selectedPatterns = []) {
  const resources = policyResources[kind] || [];
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

function resourceOptionsHtml(kind, selectedPatterns = []) {
  return availablePolicyResources(kind, selectedPatterns)
    .map((resource) => '<option value="' + attr(resource.name) + '"></option>')
    .join("");
}

function resourceListHtml(kind, selectedPatterns = [], filter = "") {
  const resources = availablePolicyResources(kind, selectedPatterns, filter);
  if (!resources.length) return '<div class="resource-empty">No matching unselected ' + escapeHtml(kind) + '.</div>';
  return resources.map((resource) => resourceChipHtml(resource)).join("");
}

function availablePolicyResources(kind, selectedPatterns = [], filter = "") {
  const selected = new Set(selectedPatterns);
  const needle = filter.trim().toLowerCase();
  return (policyResources[kind] || [])
    .filter((resource) => !selected.has(resource.name))
    .filter((resource) => !needle || policyResourceMatchesFilter(resource, needle));
}

function policyResourceMatchesFilter(resource, needle) {
  return [resource.name, resource.description, resource.source]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function resourceChipHtml(resource) {
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

function policyModeButton(value, label, current) {
  return '<button type="button" data-policy-mode-option="' + attr(value) + '" class="' + (value === current ? "active" : "") + '">' + escapeHtml(label) + '</button>';
}

function bindPolicyEditor() {
  const rows = el("policyRows");
  rows.onclick = (event) => {
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
  rows.oninput = (event) => {
    const target = event.target;
    if (target.matches?.("[data-policy-patterns]")) {
      syncResourcePolicyFromTab();
      return;
    }
    if (target.matches?.("[data-resource-filter]")) {
      refreshPolicyResourceControls(target.closest("[data-policy-row]"));
    }
  };
  rows.onkeydown = (event) => {
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

function clearPolicyResourceFilter(row) {
  const filter = row?.querySelector("[data-resource-filter]");
  if (filter) filter.value = "";
}

function policyResourceAutocompleteValue(row, value) {
  if (!row) return "";
  const typed = value.trim();
  if (!typed) return "";
  const kind = row.dataset.policyKind;
  const selected = selectedPolicyPatterns(row);
  const resources = availablePolicyResources(kind, selected, typed);
  const exact = resources.find((resource) => resource.name.toLowerCase() === typed.toLowerCase());
  return exact?.name || resources[0]?.name || typed;
}

function removePolicyPattern(row, pattern) {
  if (!row || !pattern) return;
  const textarea = row.querySelector("[data-policy-patterns]");
  const patterns = parsePolicyPatterns(textarea.value).filter((candidate) => candidate !== pattern);
  textarea.value = patterns.join("\n");
}

function refreshPolicyResourceControls(root = document) {
  const rows = root.matches?.("[data-policy-row]") ? [root] : root.querySelectorAll("[data-policy-row]");
  rows.forEach((row) => {
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

function selectedPolicyPatterns(row) {
  if (!row || (row.dataset.policyMode || "none") === "none") return [];
  return parsePolicyPatterns(row.querySelector("[data-policy-patterns]")?.value || "");
}

function addPolicyPattern(row, name) {
  if (!row || !name) return;
  if ((row.dataset.policyMode || "none") === "none") setPolicyRowMode(row, "allow");
  const textarea = row.querySelector("[data-policy-patterns]");
  const patterns = parsePolicyPatterns(textarea.value);
  if (!patterns.includes(name)) patterns.push(name);
  textarea.value = patterns.join("\n");
}

function syncResourcePolicyFromTab() {
  if (!currentStack) return;
  const errors = [];
  document.querySelectorAll("[data-policy-row]").forEach((row) => {
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
    if (Object.keys(policy).length) currentStack[kind] = policy;
    else delete currentStack[kind];
    setPolicyRowMode(row, mode);
  });
  stackPolicyError = errors[0] || "";
  markDirty();
  refreshPolicySummaries();
  refreshPolicyResourceControls();
  if (stackPolicyError) setStatus(stackPolicyError, "error");
}

function stackPolicyObject(kind) {
  const policy = currentStack?.[kind];
  return policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
}

function policyMode(policy) {
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (deny.length && !allow.length) return "deny";
  if (allow.length) return "allow";
  return "none";
}

function setPolicyRowMode(row, mode) {
  if (!row) return;
  row.dataset.policyMode = mode || "none";
  row.querySelectorAll("[data-policy-mode-option]").forEach((button) => {
    button.classList.toggle("active", button.dataset.policyModeOption === row.dataset.policyMode);
  });
  const patterns = row.querySelector("[data-policy-patterns]");
  if (!patterns) return;
  patterns.disabled = row.dataset.policyMode === "none";
  patterns.placeholder = policyPatternPlaceholder(row.dataset.policyMode);
}

function policyPatternPlaceholder(mode) {
  if (mode === "allow") return "read\nbrowser-*";
  if (mode === "deny") return "browser-danger\nlegacy-*";
  return "";
}

function policyPatternsToText(patterns) {
  return Array.isArray(patterns) ? patterns.join("\n") : "";
}

function parsePolicyPatterns(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function duplicatePolicyPattern(patterns) {
  const seen = new Set();
  for (const pattern of patterns) {
    if (seen.has(pattern)) return pattern;
    seen.add(pattern);
  }
  return "";
}

function refreshPolicySummaries() {
  document.querySelectorAll("[data-policy-row]").forEach((row) => {
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

function policySummary(kind, policy) {
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  if (allow.length && deny.length) return "Invalid mixed policy.";
  if (allow.some((pattern) => pattern !== "*")) return "Allow list active: " + allow.length + " pattern" + (allow.length === 1 ? "" : "s") + ".";
  if (allow.length) return "Unrestricted " + kind + ".";
  if (deny.length) return "Deny list active: " + deny.length + " pattern" + (deny.length === 1 ? "" : "s") + ".";
  return "Unrestricted " + kind + ".";
}

function renderStackTab() {
  if (!currentStack) return;
  const json = JSON.stringify(stackForDisplay(), null, 2);
  const variableRows = Object.entries(currentStack.variables || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => variableRowHtml(name, value))
    .join("");
  el("tabPanel").innerHTML =
    '<div class="tab-section">' +
    '<div class="tab-section-title">Context options</div>' +
    '<div class="tab-section-meta">Stack-level behavior for how pi-forge rewrites Pi conversation context.</div>' +
    '<label class="checkline" title="Allow multiple enabled chat-history slots. When off, only the first enabled chat-history slot is expanded.">' +
    '<input id="allowDuplicateChatHistoryInput" type="checkbox" ' + (currentStack.context?.allowDuplicateChatHistory === true ? "checked" : "") + '> Allow duplicate chat-history slots</label>' +
    '<div class="option-note">Keep this off unless you intentionally want the same conversation history injected more than once.</div>' +
    '</div>' +
    '<div class="tab-section">' +
    '<div class="tab-section-title">Stack variables</div>' +
    '<div class="tab-section-meta">Static string variables available to template macros and variables slots.</div>' +
    '<div class="modal-toolbar"><button id="addVariableBtn" data-icon="+" title="Add a static stack variable">Add variable</button><span class="modal-spacer"></span><span class="modal-meta">Saved in stack.variables.</span></div>' +
    '<div class="data-table" id="variablesRows">' +
    '<div class="data-row header variable-row"><div>Name</div><div>Value</div><div></div></div>' +
    variableRows +
    '</div></div>' +
    '<div class="tab-section">' +
    '<div class="tab-section-title">Stack JSON</div>' +
    '<div class="tab-section-meta">Raw recovery view for advanced fields. Apply updates the editor; Save writes to disk.</div>' +
    '<div class="modal-toolbar">' +
    '<button id="copyStackJsonBtn" data-icon="□" title="Copy this JSON to the clipboard">Copy</button>' +
    '<button id="applyStackJsonBtn" class="primary" data-icon="✓" title="Apply this JSON to the editor without saving">Apply to editor</button>' +
    '<span class="modal-spacer"></span><span id="stackJsonStatus" class="modal-meta">Unsaved stack JSON draft.</span>' +
    '</div>' +
    '<textarea id="stackJsonText" class="raw-json-editor" spellcheck="false">' + escapeHtml(json) + '</textarea>' +
    '</div>';
  el("allowDuplicateChatHistoryInput").onchange = (event) => {
    setContextOption("allowDuplicateChatHistory", event.target.checked, false);
    markDirty();
  };
  bindVariablesEditor();
  el("copyStackJsonBtn").onclick = () => run(copyRawStackJson);
  el("applyStackJsonBtn").onclick = () => run(applyRawStackJson);
}

function openRawStackJsonEditor() {
  if (!currentStack) return;
  const json = JSON.stringify(stackForDisplay(), null, 2);
  showStackModal(
    "Stack JSON",
    "Raw recovery view for advanced fields. Apply updates the editor; Save writes to disk.",
    '<div class="modal-toolbar">' +
      '<button id="copyStackJsonBtn" data-icon="□" title="Copy this JSON to the clipboard">Copy</button>' +
      '<button id="applyStackJsonBtn" class="primary" data-icon="✓" title="Apply this JSON to the editor without saving">Apply to editor</button>' +
      '<span class="modal-spacer"></span><span id="stackJsonStatus" class="modal-meta">Unsaved stack JSON draft.</span>' +
      '</div>' +
      '<textarea id="stackJsonText" class="raw-json-editor" spellcheck="false">' + escapeHtml(json) + '</textarea>',
    { bodyClass: "json-modal" },
  );
  el("copyStackJsonBtn").onclick = () => run(copyRawStackJson);
  el("applyStackJsonBtn").onclick = () => run(applyRawStackJson);
}

function stackForDisplay() {
  if (!currentStack) throw new Error("No stack selected.");
  const clone = structuredClone(currentStack);
  if (!clone.type) clone.type = "pi-forge.prompt-stack";
  if (!clone.schemaVersion) clone.schemaVersion = 1;
  return clone;
}

async function copyRawStackJson() {
  await copyTextToClipboard(el("stackJsonText").value);
  el("stackJsonStatus").textContent = "Copied JSON.";
  setStatus("Copied stack JSON", "success");
}

async function applyRawStackJson() {
  const text = el("stackJsonText").value;
  const parsed = JSON.parse(text);
  validateRawStackJson(parsed);
  currentStack = parsed;
  if (!currentStack.schemaVersion) currentStack.schemaVersion = 1;
  if (!currentStack.type) currentStack.type = "pi-forge.prompt-stack";
  selectedItemIndex = currentStack.items.length ? Math.min(Math.max(selectedItemIndex, 0), currentStack.items.length - 1) : -1;
  optionsError = "";
  stackVariablesError = "";
  regexRulesError = "";
  stackPolicyError = "";
  closeStackModal();
  markDirty();
  renderAll(latestDiagnostics);
  setStatus("Applied stack JSON to editor", "success");
}

function validateRawStackJson(stack) {
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) throw new Error("Stack JSON must be an object.");
  if (typeof stack.id !== "string" || !stack.id.trim()) throw new Error("Stack JSON needs a non-empty string id.");
  if (!Array.isArray(stack.items)) throw new Error("Stack JSON needs an items array.");
  stack.items.forEach((item, index) => {
    const label = "Item " + (index + 1);
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(label + " must be an object.");
    if (item.kind !== "block" && item.kind !== "slot") throw new Error(label + " kind must be block or slot.");
    if (typeof item.id !== "string" || !item.id.trim()) throw new Error(label + " needs a non-empty string id.");
    if (item.kind === "block" && typeof item.content !== "string") throw new Error(label + " block content must be a string.");
    if (item.kind === "slot" && typeof item.slot !== "string") throw new Error(label + " slot must be a string.");
  });
}

function openVariablesEditor() {
  if (!currentStack) return;
  const rows = Object.entries(currentStack.variables || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => variableRowHtml(name, value))
    .join("");
  showStackModal(
    "Stack variables",
    "Static string variables available to macros and variables slots.",
    '<div class="modal-toolbar"><button id="addVariableBtn" data-icon="+" title="Add a static stack variable">Add variable</button><span class="modal-spacer"></span><span class="modal-meta">Save writes these changes to the stack JSON.</span></div>' +
      '<div class="data-table" id="variablesRows">' +
      '<div class="data-row header variable-row"><div>Name</div><div>Value</div><div></div></div>' +
      rows +
      '</div>',
  );
  bindVariablesEditor();
}

function variableRowHtml(name = "", value = "") {
  return '<div class="data-row variable-row" data-var-row>' +
    '<input data-var-name value="' + attr(name) + '" placeholder="char">' +
    '<input data-var-value value="' + attr(value) + '" placeholder="泉此方">' +
    '<button type="button" class="danger" data-delete-row="true" data-icon="×" title="Delete this stack variable">Delete</button>' +
    '</div>';
}

function bindVariablesEditor() {
  el("addVariableBtn").onclick = () => {
    el("variablesRows").insertAdjacentHTML("beforeend", variableRowHtml(uniqueVariableName()));
    bindVariablesEditor();
    syncVariablesFromModal();
  };
  document.querySelectorAll("[data-var-row] input").forEach((input) => {
    input.oninput = () => syncVariablesFromModal();
  });
  document.querySelectorAll("[data-var-row] [data-delete-row]").forEach((button) => {
    button.onclick = (event) => {
      event.target.closest("[data-var-row]").remove();
      syncVariablesFromModal();
    };
  });
}

function uniqueVariableName() {
  const existing = new Set(Object.keys(currentStack?.variables || {}));
  let index = existing.size + 1;
  let name = "var" + index;
  while (existing.has(name)) name = "var" + (++index);
  return name;
}

function syncVariablesFromModal() {
  if (!currentStack) return;
  const variables = {};
  const seen = new Set();
  let duplicate = false;
  document.querySelectorAll("[data-var-row]").forEach((row) => {
    const name = row.querySelector("[data-var-name]").value.trim();
    const value = row.querySelector("[data-var-value]").value;
    if (!name) return;
    if (seen.has(name)) duplicate = true;
    seen.add(name);
    variables[name] = value;
  });
  if (Object.keys(variables).length) currentStack.variables = variables;
  else delete currentStack.variables;
  stackVariablesError = duplicate ? "Duplicate stack variable names." : "";
  markDirty();
  if (duplicate) setStatus(stackVariablesError, "error");
}

function openRegexEditor() {
  if (!currentStack) return;
  showStackModal(
    "Regex rules",
    "Ordered JavaScript RegExp replacements for outgoing prompt text and finalized assistant messages.",
    regexEditorBody(),
  );
  bindRegexEditor();
}

function regexEditorBody() {
  const rules = Array.isArray(currentStack?.regex?.rules) ? currentStack.regex.rules : [];
  const rows = rules.map((rule) => regexRuleRowHtml(rule)).join("");
  return '<div class="tab-section-title">Regex rules</div>' +
    '<div class="tab-section-meta">Ordered JavaScript RegExp replacements for outgoing prompt text and finalized assistant messages.</div>' +
    '<div class="modal-toolbar"><button id="addRegexRuleBtn" data-icon="+" title="Add a regex rule">Add rule</button><button id="validateRegexRulesBtn" data-icon="!" title="Validate the edited stack">Validate</button><span class="modal-spacer"></span><span class="modal-meta">Save writes these rules to stack.regex.rules.</span></div>' +
    '<div class="data-table" id="regexRows">' + rows + '</div>';
}

function regexRuleRowHtml(rule = {}) {
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

function regexTextField(attribute, label, value, placeholder = "") {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input ' + attribute + ' value="' + attr(value) + '" placeholder="' + attr(placeholder) + '"></div>';
}

function regexNumberField(attribute, label, value, min = 1) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><input type="number" min="' + attr(min) + '" ' + attribute + ' value="' + attr(value) + '"></div>';
}

function regexTextArea(attribute, label, value, className, placeholder = "") {
  return '<div class="field ' + className + '"><label>' + escapeHtml(label) + '</label><textarea ' + attribute + ' spellcheck="false" placeholder="' + attr(placeholder) + '">' + escapeHtml(value) + '</textarea></div>';
}

function regexSelect(attribute, label, value, choices) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label><select ' + attribute + '>' +
    choices.map((choice) => '<option value="' + attr(choice) + '"' + (choice === value ? " selected" : "") + '>' + escapeHtml(choice) + '</option>').join("") +
    '</select></div>';
}

function regexCheckGroup(label, attribute, choices, selected, help) {
  const selectedSet = new Set(selected || []);
  return '<div class="field span-2"><label>' + escapeHtml(label) + '</label><div class="regex-checks" title="' + attr(help) + '">' +
    choices.map((choice) => '<label><input type="checkbox" ' + attribute + ' value="' + attr(choice) + '"' + (selectedSet.has(choice) ? " checked" : "") + '> ' + escapeHtml(choice) + '</label>').join("") +
    '</div></div>';
}

function bindRegexEditor() {
  el("addRegexRuleBtn").onclick = () => {
    el("regexRows").insertAdjacentHTML("beforeend", regexRuleRowHtml(defaultRegexRule()));
    bindRegexEditor();
    syncRegexRulesFromModal();
  };
  el("validateRegexRulesBtn").onclick = () => run(validateStack);
  document.querySelectorAll("[data-regex-row] input, [data-regex-row] textarea:not([data-regex-original]), [data-regex-row] select").forEach((control) => {
    control.oninput = () => syncRegexRulesFromModal();
    control.onchange = () => syncRegexRulesFromModal();
  });
  document.querySelectorAll("[data-regex-row] [data-delete-row]").forEach((button) => {
    button.onclick = (event) => {
      event.target.closest("[data-regex-row]").remove();
      syncRegexRulesFromModal();
    };
  });
  document.querySelectorAll("[data-regex-up]").forEach((button) => {
    button.onclick = (event) => {
      const row = event.target.closest("[data-regex-row]");
      const previous = row.previousElementSibling;
      if (!previous) return;
      row.parentNode.insertBefore(row, previous);
      syncRegexRulesFromModal();
    };
  });
  document.querySelectorAll("[data-regex-down]").forEach((button) => {
    button.onclick = (event) => {
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
  const existing = new Set((currentStack?.regex?.rules || []).map((rule) => rule?.id).filter(Boolean));
  let index = existing.size + 1;
  let id = "regex-" + index;
  while (existing.has(id)) id = "regex-" + (++index);
  return id;
}

function syncRegexRulesFromModal() {
  if (!currentStack) return;
  const rules = [];
  const seen = new Set();
  const errors = [];
  document.querySelectorAll("[data-regex-row]").forEach((row, index) => {
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
    currentStack.regex = { ...(currentStack.regex || {}), schemaVersion: currentStack.regex?.schemaVersion || 1, rules };
  } else {
    delete currentStack.regex;
  }
  regexRulesError = errors[0] || "";
  markDirty();
  refreshRegexWarnings();
  if (regexRulesError) setStatus(regexRulesError, "error");
}

function regexRuleFromRow(row) {
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
  const trimStrings = row.querySelector("[data-regex-trim-strings]").value.split(/\r?\n/).filter((line) => line.length > 0);
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

function originalRegexRuleFromRow(row) {
  try {
    const parsed = JSON.parse(row.querySelector("[data-regex-original]")?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function checkedRegexValues(row, attribute) {
  return Array.from(row.querySelectorAll("[" + attribute + "]"))
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function positiveIntegerFromInput(value) {
  if (!String(value || "").trim()) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeIntegerFromInput(value) {
  if (!String(value || "").trim()) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function refreshRegexWarnings() {
  document.querySelectorAll("[data-regex-row]").forEach((row) => {
    const warning = row.querySelector("[data-regex-warning]");
    if (!warning) return;
    const text = regexRuleWarning(regexRuleFromRow(row));
    warning.textContent = text;
    warning.style.display = text ? "" : "none";
  });
}

function regexRuleWarning(rule) {
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

function setOptionalObjectString(target, key, value) {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}

function addItem(kind) {
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
  const existing = new Set((currentStack?.items || []).map((item) => String(item.id)));
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

async function createStackRemote(stack, options = {}) {
  try {
    return await api("/api/stacks", { method: "POST", body: { stack, ...options } });
  } catch (error) {
    if (error.status === 409 && !options.overwrite && confirm((error.message || "Stack already exists.") + "\n\nOverwrite it?")) {
      return await api("/api/stacks", { method: "POST", body: { stack, ...options, overwrite: true } });
    }
    throw error;
  }
}

async function createAndOpenStack(stack, activate, actionLabel, extraOptions = {}) {
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

function defaultNewStack(id, name) {
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

function showImportReport(report, stackId) {
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

async function handleImportFile(event) {
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

function isSillyTavernImport(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.prompts) && !Array.isArray(value.items);
}

function promptSillyTavernCharacterId(value) {
  const ids = Array.isArray(value.prompt_order)
    ? value.prompt_order
      .map((entry) => entry && entry.character_id)
      .filter((id) => Number.isInteger(id))
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

function downloadTextFile(filename, text, type) {
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

function uniqueForkId(baseId) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack) => stack.id));
  let candidate = base + "-fork";
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-fork-" + index++;
  return candidate;
}

function uniqueStackId(baseId) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack) => stack.id));
  let candidate = base;
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-" + index++;
  return candidate;
}

function sanitizeStackId(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function validateStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/validate", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  renderItemList();
  hidePreview();
  setStatus("Validation complete", "success");
}

async function previewStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/preview", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  renderItemList();
  renderPreviewInspector(data);
  setStatus("Preview rendered", "success");
}

async function refreshPayloadCapture(options = {}) {
  const previousCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  const data = await api("/api/payload");
  payloadSnapshot = data;
  updatePayloadButton();
  const nextCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  if (options.open || (options.autoOpen && nextCapturedAt && nextCapturedAt !== previousCapturedAt)) {
    renderPayloadInspector(payloadSnapshot);
  }
}

async function armPayloadCapture(showInspector = false) {
  const data = await api("/api/payload/arm", { method: "POST" });
  payloadSnapshot = data;
  updatePayloadButton();
  setStatus("Payload capture armed; send the next Pi prompt");
  if (showInspector) renderPayloadInspector(payloadSnapshot);
}

async function clearPayloadCapture() {
  const data = await api("/api/payload", { method: "DELETE" });
  payloadSnapshot = data;
  updatePayloadButton();
  hidePreview();
  setStatus("Payload capture cleared", "success");
}

async function openPayloadCapture() {
  await refreshPayloadCapture();
  if (payloadSnapshot.status === "captured" || payloadSnapshot.status === "armed") {
    renderPayloadInspector(payloadSnapshot);
    return;
  }
  await armPayloadCapture();
}

function updatePayloadButton() {
  const button = el("payloadBtn");
  if (!button) return;
  button.classList.remove("primary");
  if (payloadSnapshot.status === "armed") {
    button.textContent = "Payload armed";
    button.classList.add("primary");
    button.title = "Waiting for the next provider payload";
    return;
  }
  if (payloadSnapshot.status === "captured") {
    button.textContent = "View payload";
    button.title = "Open the latest captured provider payload";
    return;
  }
  button.textContent = "Arm payload";
  button.title = "Capture the next provider payload in this editor";
}

function hidePreview() {
  const pane = el("preview");
  pane.classList.remove("open");
  pane.innerHTML = "";
  previewCopyTexts = [];
}

function renderPreviewInspector(data) {
  const pane = el("preview");
  const preview = data.preview;
  if (!preview) {
    previewCopyTexts = [data.text || ""];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
      '<div class="preview-head"><div><div class="preview-title">Preview</div><div class="preview-meta">Plain text fallback</div></div>' +
      '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full preview text">Copy</button><button data-preview-close="true" data-icon="×" title="Close the preview">Close</button></div></div>' +
      '<div class="preview-body"><pre class="preview-text">' + escapeHtml(data.text || "") + '</pre></div></div>';
    pane.classList.add("open");
    return;
  }

  const sections = [preview.system, ...(preview.messages || [])];
  previewCopyTexts = [data.text || "", ...sections.map((section) => section.content || "")];
  const sectionHtml = sections.map((section, index) => {
    const open = index === 0 ? " open" : "";
    const label = section.role ? section.role + " · " : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title || section.id) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(label + formatCount(section.chars) + " chars · ~" + formatCount(section.approxTokens) + " tokens") + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="Copy this preview section" onclick="event.preventDefault()">Copy</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");

  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
    '<div class="preview-head"><div><div class="preview-title">Prompt preview: ' + escapeHtml(preview.stackId || selectedId) + '</div>' +
    '<div class="preview-meta">' + escapeHtml(formatCount(preview.totalChars) + " chars · ~" + formatCount(preview.approxTokens) + " tokens · " + (preview.messages || []).length + " messages") + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full prompt preview">Copy full</button><button data-preview-close="true" data-icon="×" title="Close the preview">Close</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function renderPayloadInspector(snapshot) {
  const pane = el("preview");
  if (snapshot.status === "idle") {
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
      '<div class="preview-head"><div><div class="preview-title">Provider payload</div><div class="preview-meta">No payload captured.</div></div>' +
      '<div class="preview-actions"><button data-payload-arm="true" data-icon="◆" title="Capture the next provider payload">Arm next</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
      '<div class="preview-body"><div class="empty">Arm capture, then send the next prompt in Pi. The provider payload will appear here before it is sent.</div></div></div>';
    pane.classList.add("open");
    return;
  }

  if (snapshot.status === "armed") {
    const meta = snapshot.armedAt ? "Armed at " + snapshot.armedAt : "Waiting for next provider request";
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
      '<div class="preview-head"><div><div class="preview-title">Payload capture armed</div><div class="preview-meta">' + escapeHtml(meta) + '</div></div>' +
      '<div class="preview-actions"><button class="danger" data-payload-clear="true" data-icon="×" title="Clear the armed payload capture">Clear</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
      '<div class="preview-body"><div class="empty">Send the next prompt in Pi. The exact provider payload will be captured here and redacted before display.</div></div></div>';
    pane.classList.add("open");
    return;
  }

  const capture = snapshot.capture || {};
  const sections = payloadSections(capture);
  previewCopyTexts = [capture.text || "", ...sections.map((section) => section.content || "")];
  const sectionHtml = sections.map((section, index) => {
    const open = index === 0 ? " open" : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(section.meta) + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="Copy this payload section" onclick="event.preventDefault()">Copy</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");
  const metaParts = [
    formatCount(capture.chars) + " chars",
    "~" + formatCount(capture.approxTokens) + " tokens",
    capture.stackId ? "stack " + capture.stackId : undefined,
    capture.truncated ? "truncated" : undefined,
  ].filter(Boolean);
  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
    '<div class="preview-head"><div><div class="preview-title">Provider payload</div>' +
    '<div class="preview-meta">' + escapeHtml(metaParts.join(" · ") + (capture.capturedAt ? " · " + capture.capturedAt : "")) + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full redacted payload">Copy full</button><button data-payload-arm="true" data-icon="◆" title="Capture the next provider payload">Arm again</button><button class="danger" data-payload-clear="true" data-icon="×" title="Clear the captured payload">Clear</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function payloadSections(capture) {
  const value = capture.payload;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((item, index) => payloadSection(String(index), item));
    }
    const entries = Object.entries(value);
    if (entries.length) return entries.map(([key, item]) => payloadSection(key, item));
  }
  return [{
    title: capture.error ? "Stringify error" : capture.truncated ? "Raw truncated payload" : "Raw payload",
    meta: formatCount((capture.text || "").length) + " chars",
    content: capture.text || "",
  }];
}

function payloadSection(title, value) {
  const rendered = JSON.stringify(value, null, 2);
  const content = rendered === undefined ? String(value) : rendered;
  const meta = describePayloadValue(value) + " · " + formatCount(content.length) + " chars";
  return { title, meta, content };
}

function describePayloadValue(value) {
  if (Array.isArray(value)) return "array[" + value.length + "]";
  if (value && typeof value === "object") return "object{" + Object.keys(value).length + "}";
  if (value === null) return "null";
  return typeof value;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

async function copyPreviewText(index) {
  const text = previewCopyTexts[index] || "";
  if (!text) return;
  await copyTextToClipboard(text);
  setStatus("Copied text", "success");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
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
  const next = stacks.find((stack) => stack.active) || stacks[0];
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
  if (stackVariablesError) throw new Error(stackVariablesError);
  if (regexRulesError) throw new Error(regexRulesError);
  if (stackPolicyError) throw new Error(stackPolicyError);
  const clone = structuredClone(currentStack);
  if (!clone.type) clone.type = "pi-forge.prompt-stack";
  if (!clone.schemaVersion) clone.schemaVersion = 1;
  return clone;
}

function renderDiagnostics(diagnostics) {
  latestDiagnostics = diagnostics || [];
  const pane = el("diagnostics");
  if (!latestDiagnostics.length) {
    pane.innerHTML = '<div class="diagnostic info">No diagnostics.</div>';
    return;
  }
  pane.innerHTML = latestDiagnostics.map((diag) => {
    const level = diag.level || "info";
    const item = diag.itemId ? " [" + escapeHtml(diag.itemId) + "]" : "";
    return '<div class="diagnostic ' + attr(level) + '"><strong>' + escapeHtml(level.toUpperCase()) + item + '</strong>: ' + escapeHtml(diag.message || "") + '</div>';
  }).join("");
}

function renderEmpty() {
  currentStack = null;
  selectedId = "";
  dirty = false;
  activeTab = "items";
  stackPolicyError = "";
  renderDirtyState();
  document.querySelectorAll("[data-tab]").forEach((button) => {
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

function field(label, control, className = "") {
  return '<div class="field ' + className + '"><label>' + escapeHtml(label) + '</label>' + control + '</div>';
}

function displayItemName(item) {
  if (item.name) return item.name;
  if (item.source && typeof item.source.previousName === "string" && item.source.previousName.trim()) return item.source.previousName;
  if (item.kind === "slot" && item.slot) return item.slot;
  if (item.kind === "block" && item.content) {
    const firstLine = item.content.trim().split(/\n/)[0]?.trim();
    if (firstLine) return firstLine.length > 46 ? firstLine.slice(0, 43) + "..." : firstLine;
  }
  return item.id || "(unnamed)";
}

function setOptionalString(target, key, value) {
  const trimmed = value.trim();
  if (trimmed) target[key] = value;
  else delete target[key];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function attr(value) {
  return escapeHtml(value);
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  el("shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
  el("sidebarToggleBtn").title = sidebarCollapsed ? "Show prompt stacks sidebar" : "Hide prompt stacks sidebar";
  setStatus(sidebarCollapsed ? "Prompt stacks sidebar hidden" : "Prompt stacks sidebar shown");
}

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
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => {
    activeTab = button.dataset.tab || "items";
    renderActiveTab();
    hidePreview();
  };
});
el("forkBtn").onclick = () => run(forkStack);
el("importBtn").onclick = () => run(importStackJson);
el("exportBtn").onclick = () => run(exportStackJson);
el("importFileInput").onchange = (event) => run(() => handleImportFile(event));
el("deleteStackBtn").onclick = () => run(deleteCurrentStack);
el("stackModal").onclick = (event) => {
  if (event.target === el("stackModal") || event.target.closest?.("[data-modal-close]")) {
    closeStackModal();
  }
};
el("preview").onclick = (event) => {
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
};
el("addItemBtn").onclick = () => addItem("block");
el("addSlotBtn").onclick = () => addItem("slot");
el("deleteItemBtn").onclick = deleteSelectedItem;
document.addEventListener("dragover", handleDocumentItemDragOver);
document.addEventListener("drop", handleDocumentItemDrop);
window.onbeforeunload = () => dirty ? "Unsaved changes" : undefined;
window.addEventListener("keydown", handleEditorShortcut);

function handleEditorShortcut(event) {
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

run(async () => {
  await loadStacks();
  await refreshPayloadCapture();
  setInterval(() => run(() => refreshPayloadCapture({ autoOpen: true })), 2000);
});
`;
//# sourceMappingURL=client-script.js.map