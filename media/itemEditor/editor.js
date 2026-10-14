/* global acquireVsCodeApi */
const api = acquireVsCodeApi();
let revision = 0;
let blocked = false;
let frozenControls = [];
const selectionRequests = new Map();
let selectionRequestId = 0;
let activePicker;
let cancelDrag;
document.addEventListener("keydown", event => { if (event.key === "Escape") { cancelDrag?.(); activePicker?.close(); } });
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.target.matches("input, textarea") && ["z", "y"].includes(event.key.toLowerCase())) {
    event.preventDefault(); send(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
  }
});
const savedSections = api.getState()?.sections;
const sectionOpen = new Map(savedSections && typeof savedSections === "object" && !Array.isArray(savedSections)
  ? Object.entries(savedSections).filter(([, open]) => typeof open === "boolean") : []);
document.addEventListener("pointerdown", event => { if (activePicker && !activePicker.popup.contains(event.target) && !activePicker.trigger.contains(event.target)) activePicker.close(!event.target.closest("button, input, textarea, select, a[href], [tabindex], summary")); });
window.addEventListener("resize", () => activePicker?.position());
document.addEventListener("scroll", event => { if (activePicker && !activePicker.popup.contains(event.target)) activePicker.position(); }, true);
const send = (type, extra = {}) => api.postMessage({ type, revision, ...extra });
for (const action of ["save", "revert", "reconcile", "locale"]) document.getElementById(action).addEventListener("click", () => send(action));
window.addEventListener("message", event => {
  const state = event.data;
  if (state.type === "fieldTitles") {
    if (state.revision !== revision) return;
    for (const label of document.querySelectorAll(".field > label")) {
      const title = state.titles?.[label.htmlFor];
      if (typeof title !== "string" || !title.trim()) continue;
      label.textContent = title;
      label.parentElement.querySelector(".field-info-button")?.setAttribute("aria-label", `${title} information`);
    }
    return;
  }
  if (state.type === "selectionLabel") {
    if (state.revision !== revision) return;
    for (const label of document.querySelectorAll("[data-selection-label]")) {
      if (label.dataset.selectionLabel === state.id && label.dataset.value === state.value) setSelectionLabel(label, state.name ?? state.label, state.path);
    }
    return;
  }
  if (state.type === "choices") {
    const pending = selectionRequests.get(state.id);
    if (!pending || pending.id !== state.request || state.revision !== revision || blocked) return;
    selectionRequests.delete(state.id);
    pending.receive(state);
    return;
  }
  if (state.type === "unfreeze") {
    revision = state.revision; blocked = false;
    for (const [control, disabled] of frozenControls) control.disabled = disabled;
    frozenControls = [];
    document.getElementById("status").textContent = state.error;
    return;
  }
  if (state.type === "freeze") {
    cancelDrag?.();
    activePicker?.close(false);
    blocked = true;
    const drafts = {};
    for (const control of document.querySelectorAll("[data-field-id]")) {
      const input = control.type === "checkbox" ? (control.checked ? "1" : "") : control.value;
      const clear = control.dataset.explicitClear === "true";
      if (input !== control.dataset.original || clear) drafts[control.dataset.fieldId] = { input, clear };
    }
    frozenControls = [...document.querySelectorAll("input, textarea, select, button")].map(control => [control, control.disabled]);
    for (const [control] of frozenControls) control.disabled = true;
    api.postMessage({ type: "frozen", id: state.id, drafts });
    return;
  }
  if (state.type !== "state") return;
  cancelDrag?.();
  activePicker?.close(false);
  selectionRequests.clear();
  revision = state.revision;
  blocked = state.busy || state.pending;
  document.getElementById("title").textContent = state.item.name;
  document.getElementById("identity").textContent = `${state.connection} · ${state.target.language} · version ${state.target.version} · ${state.target.itemId}`;
  document.getElementById("path").textContent = state.item.path;
  document.getElementById("status").textContent = state.busy ? "Working…" : (state.error || state.status);
  document.getElementById("save").disabled = blocked || !state.target.version;
  document.getElementById("revert").disabled = state.busy;
  document.getElementById("locale").disabled = state.busy;
  document.getElementById("reconcile").hidden = !state.pending;
  document.getElementById("reconcile").disabled = state.busy;
  const root = document.getElementById("fields"); root.replaceChildren();
  const groups = new Map();
  for (const field of state.fields) {
    const key = `name:${field.section}`;
    if (!groups.has(key)) groups.set(key, { name: field.section, fields: [] });
    groups.get(key).fields.push(field);
  }
  for (const [key, group] of groups) {
    const section = document.createElement("details"); section.className = "field-section";
    const previousStates = group.fields.map(field => sectionOpen.get(`id:${field.sectionId}`)).filter(value => typeof value === "boolean");
    section.open = sectionOpen.has(key) ? sectionOpen.get(key) : previousStates.length ? previousStates.some(Boolean) : !group.fields.every(field => field.isStandardTemplate);
    const heading = document.createElement("summary"); heading.textContent = group.name;
    section.append(heading); root.append(section);
    section.addEventListener("toggle", () => {
      if (!section.isConnected) return;
      sectionOpen.set(key, section.open);
      api.setState({ sections: Object.fromEntries(sectionOpen) });
      if (!section.open && activePicker && section.contains(activePicker.row)) activePicker.close(false);
    });
    for (const field of group.fields) {
    const row = document.createElement("div"); row.className = "field";
    const label = document.createElement("label"); label.htmlFor = field.id; label.textContent = field.label;
    const meta = document.createElement("p"); meta.className = "meta";
    meta.textContent = `${field.name} · ${field.type} · ${field.scope.toLowerCase()} · ${field.source}${field.kind === "datetime" ? " · UTC (no local-time conversion)" : ""}`;
    row.append(label);
    renderFieldInfo(row, field, meta);
    if (field.reason) {
      const reason = document.createElement("p"); reason.className = "meta"; reason.textContent = `Read-only: ${field.reason}`;
      const value = document.createElement("pre"); value.textContent = field.raw;
      if (field.selectionKind && !["checklist", "multilist", "treelist", "treelistex"].includes(field.selectionKind)) row.append(selectionLabel(field));
      row.append(reason, value);
    } else if (field.kind === "multiselection") {
      renderMultipleSelection(row, field);
    } else if (field.kind === "selection") {
      renderSelection(row, field);
    } else {
      const control = document.createElement(field.kind === "multiline" ? "textarea" : "input"); control.id = field.id;
      if (field.kind !== "multiline") control.type = field.kind === "checkbox" ? "checkbox" : field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : "text";
      if (field.kind === "datetime") control.step = "1";
      if (field.kind === "integer" || field.kind === "number") control.inputMode = "decimal";
      control.dataset.fieldId = field.id;
      control.dataset.original = field.original;
      control.dataset.explicitClear = String(field.clear);
      control.disabled = blocked;
      if (field.kind === "checkbox") control.checked = !field.clear && field.input === "1";
      else control.value = field.clear ? "" : field.input;
      const changed = clear => {
        control.dataset.explicitClear = String(clear);
        const input = field.kind === "checkbox" ? (control.checked ? "1" : "") : control.value;
        send("change", { id: field.id, input, clear });
        document.getElementById("status").textContent = "Unsaved changes";
      };
      control.addEventListener("input", () => changed(false));
      const controls = document.createElement("div"); controls.className = "field-controls";
      controls.append(control); row.append(controls);
      if (field.kind !== "checkbox") {
        const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
        clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
        clear.addEventListener("click", () => { control.value = ""; changed(true); });
        controls.append(clear);
      }
    }
    section.append(row);
    }
  }
  if (state.focus) {
    const handle = [...document.querySelectorAll("[data-reorder-field]")].find(control => control.dataset.reorderField === state.focus.id && control.dataset.reorderValue === state.focus.value);
    (handle || document.getElementById(state.focus.id))?.focus();
  }
});
function selectionLabel(field) {
  const label = document.createElement("p"); label.className = "selection-current"; label.id = field.id; label.setAttribute("role", "status");
  label.dataset.selectionLabel = field.id;
  label.dataset.value = field.clear ? "" : field.input;
  label.textContent = !label.dataset.value ? "No selection" : field.selectionKind.includes("droplist") ? label.dataset.value : "Loading selected item…";
  return label;
}
function setSelectionLabel(control, text, path = "") {
  if (control instanceof HTMLInputElement) {
    control.value = text;
    const detail = document.getElementById(`${control.id}-path`);
    if (detail) { detail.textContent = path; detail.hidden = !path; }
  } else {
    control.textContent = text; control.title = path ? `${text}\n${path}` : text;
    control.dispatchEvent(new CustomEvent("referenceResolved", {bubbles:true,detail:{text,path}}));
    const detail = document.getElementById(`${control.id}-path`);
    if (detail) { detail.textContent = path; detail.hidden = !path; }
  }
}
function renderFieldInfo(row, field, meta) {
  const current = document.createElement("p"); current.className = "meta field-stored-value";
  current.textContent = `Stored value: ${field.raw || "(empty)"}`;
  const info = document.createElement("div"); info.className = "field-info";
  const infoButton = document.createElement("button"); infoButton.type = "button"; infoButton.textContent = "ⓘ";
  infoButton.className = "field-info-button"; infoButton.setAttribute("aria-label", `${field.label} information`); infoButton.setAttribute("aria-expanded", "false");
  const infoContent = document.createElement("div"); infoContent.className = "field-info-content"; infoContent.id = `${field.id}-info`;
  infoButton.setAttribute("aria-controls", infoContent.id); infoButton.setAttribute("aria-describedby", infoContent.id);
  const selectedPath = document.createElement("p"); selectedPath.className = "meta"; selectedPath.id = `${field.id}-path`; selectedPath.hidden = true;
  infoContent.append(meta, current); if (field.selectionKind) infoContent.append(selectedPath); info.append(infoButton, infoContent);
  infoButton.addEventListener("click", () => { const open = info.dataset.open !== "true"; info.dataset.open = String(open); infoButton.setAttribute("aria-expanded", String(open)); });
  info.addEventListener("keydown", event => { if (event.key === "Escape") { info.dataset.open = "false"; infoButton.setAttribute("aria-expanded", "false"); const control = document.getElementById(field.id); if (control?.matches("input, textarea, select")) control.focus(); else { row.tabIndex = -1; row.focus(); } } });
  row.querySelector("label").after(info);
}
function renderSelection(row, field) {
  // The canonical draft is separate from the choice list: loading/filtering never
  // changes it, including references absent from the current source.
  const stored = document.createElement("input"); stored.type = "hidden";
  stored.dataset.fieldId = field.id; stored.dataset.original = field.original;
  stored.dataset.explicitClear = String(field.clear); stored.value = field.clear ? "" : field.input;
  row.classList.add("selection-field");
  const label = document.createElement("input"); label.type = "text"; label.readOnly = true; label.id = field.id;
  label.className = "selection-trigger"; label.disabled = blocked;
  label.dataset.selectionLabel = field.id; label.dataset.value = stored.value;
  label.setAttribute("role", "combobox"); label.setAttribute("aria-expanded", "false"); label.setAttribute("aria-haspopup", "dialog");
  setSelectionLabel(label, !stored.value ? "No selection" : field.selectionKind.includes("droplist") ? stored.value : "Loading selected item…");
  const choose = (value, name, clear = false, path = "") => {
    if (blocked || !row.isConnected) return;
    stored.value = value; stored.dataset.explicitClear = String(clear); label.dataset.value = value;
    setSelectionLabel(label, name, path); picker.close();
    send("change", { id: field.id, input: value, clear });
    document.getElementById("status").textContent = "Unsaved changes";
  };
  const picker = createChoicePicker(row, field, label, {
    multiple: false, tree: field.selectionKind === "droptree",
    chosen: choice => field.selectionKind.includes("droplist") ? stored.value === choice.value : stored.value.replace(/[{}-]/g, "").toLowerCase() === choice.itemId.replace(/[{}-]/g, "").toLowerCase(),
    accept: choice => choose(choice.value, choice.displayName || choice.name, false, choice.path),
    loaded: result => { if (stored.value === field.original && stored.dataset.explicitClear !== "true") setSelectionLabel(label, result.currentName ?? result.currentLabel, result.currentPath); },
  });
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
  clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
  clear.addEventListener("click", () => choose("", "Explicit empty selection", true));
  label.addEventListener("click", picker.open);
  label.addEventListener("keydown", event => { if (["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); if (picker.popup.hidden) picker.open(); else picker.search.focus(); } });
  const controls = document.createElement("div"); controls.className = "selection-controls"; controls.append(label, clear);
  row.append(stored, controls, picker.popup);
}
send("ready");

function renderMultipleSelection(row, field) {
  const norm = value => value.replace(/[{}-]/g, "").toLowerCase();
  const checklist = field.selectionKind === "checklist";
  const tree = ["treelist", "treelistex"].includes(field.selectionKind);
  const stored = document.createElement("input"); stored.type = "hidden";
  stored.dataset.fieldId = field.id; stored.dataset.original = field.original; stored.dataset.explicitClear = String(field.clear);
  stored.value = field.clear ? "" : field.input;
  let values = stored.value ? stored.value.split("|") : [];
  const names = new Map();
  const originalTokens = field.original ? field.original.split("|") : [];
  const controls = document.createElement("div"); controls.className = "selection-controls";
  const trigger = document.createElement("button"); trigger.id = field.id; trigger.disabled = blocked;
  trigger.setAttribute("aria-expanded", "false"); trigger.textContent = "Add items…";
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
  controls.append(trigger, clear);
  const selected = document.createElement("ol"); selected.className = "multiple-selected"; selected.setAttribute("aria-label", `${field.label} selected items`);
  const hint = document.createElement("p"); hint.className = "reorder-hint meta"; hint.id = `${field.id}-reorder-hint`;
  hint.textContent = "Drag the handle to reorder, or focus it and press Alt+↑ / Alt+↓."; hint.hidden = checklist;
  const announcement = document.createElement("span"); announcement.className = "visually-hidden"; announcement.setAttribute("role", "status"); announcement.setAttribute("aria-live", "polite");
  let drag;
  let scrollFrame;
  let scrollSpeed = 0;
  const dragType = "application/x-xm-selection-reorder";
  const clearIndicator = () => { for (const entry of selected.children) entry.classList.remove("drop-before", "drop-after"); };
  const stopScroll = () => { cancelAnimationFrame(scrollFrame); scrollFrame = undefined; scrollSpeed = 0; };
  const endDrag = () => { drag = undefined; clearIndicator(); stopScroll(); selected.classList.remove("dragging"); if (cancelDrag === endDrag) cancelDrag = undefined; };
  const validDrag = event => drag && !blocked && row.isConnected && revision === drag.revision && stored.value === drag.before && event.dataTransfer?.types.includes(dragType);
  const slotAt = y => { const entries = [...selected.children]; const slot = entries.findIndex(entry => y < entry.getBoundingClientRect().top + entry.getBoundingClientRect().height / 2); return slot < 0 ? entries.length : slot; };
  const indicator = slot => { clearIndicator(); const entry = selected.children[Math.min(slot, values.length - 1)]; entry?.classList.add(slot === values.length ? "drop-after" : "drop-before"); };
  const scroll = () => { if (!drag || !scrollSpeed || blocked || !row.isConnected) { stopScroll(); return; } selected.scrollTop += scrollSpeed; indicator(slotAt(drag.y)); scrollFrame = requestAnimationFrame(scroll); };
  selected.addEventListener("dragover", event => {
    if (!validDrag(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return; }
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; drag.y = event.clientY; indicator(slotAt(event.clientY));
    const rect = selected.getBoundingClientRect(); scrollSpeed = event.clientY < rect.top + 28 ? -6 : event.clientY > rect.bottom - 28 ? 6 : 0;
    if (scrollSpeed && !scrollFrame) scrollFrame = requestAnimationFrame(scroll); else if (!scrollSpeed) stopScroll();
  });
  selected.addEventListener("dragleave", event => { if (!selected.contains(event.relatedTarget)) { clearIndicator(); stopScroll(); } });
  selected.addEventListener("drop", event => {
    event.preventDefault();
    if (!validDrag(event) || event.dataTransfer.getData(dragType) !== drag.token) return;
    event.preventDefault(); event.stopPropagation();
    const from = drag.index; const slot = slotAt(event.clientY); endDrag();
    move(from, slot > from ? slot - 1 : slot);
  });
  const picker = createChoicePicker(row, field, trigger, {
    multiple: true, tree,
    chosen: choice => values.some(value => norm(value) === norm(choice.itemId)),
    limited: () => values.length >= 256,
    accept: choice => add(choice),
    loaded: result => { for (const choice of result.page.choices) names.set(norm(choice.itemId), {name:choice.displayName || choice.name,path:choice.path}); drawSelected(); },
  });
  row.addEventListener("referenceResolved", event => {
    const label = event.target;
    if (label.dataset.selectionLabel === field.id) names.set(norm(label.dataset.value), {name:event.detail.text,path:event.detail.path});
  });
  const edit = (next, reorder = false, focusValue) => {
    if (blocked || !row.isConnected || next.join("|") === stored.value) return;
    const before = stored.value; endDrag();
    values = next; stored.value = values.join("|"); stored.dataset.explicitClear = String(!values.length);
    send(reorder ? "reorder" : "change", {id:field.id,input:stored.value,clear:!values.length,...(reorder ? {before,focusValue} : {})});
    document.getElementById("status").textContent = "Unsaved changes";
    drawSelected(); picker.refresh();
  };
  const move = (from, to) => {
    if (checklist || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= values.length || to >= values.length || from === to || blocked || !row.isConnected) return;
    const next = [...values]; const [value] = next.splice(from, 1); next.splice(to, 0, value);
    edit(next, true, value);
    const handle = selected.children[to]?.querySelector(".reorder-handle"); handle?.focus(); handle?.scrollIntoView({block:"nearest"});
    announcement.textContent = `Moved ${names.get(norm(value))?.name || "selected item"} to position ${to + 1} of ${values.length}.`;
  };
  const add = choice => {
    if (choice.disabled || values.some(value => norm(value) === norm(choice.itemId)) || values.length >= 256) return;
    names.set(norm(choice.itemId), {name:choice.displayName || choice.name,path:choice.path});
    const originalIndex = originalTokens.findIndex(value => norm(value) === norm(choice.itemId));
    const token = originalIndex < 0 ? choice.value : originalTokens[originalIndex];
    const next = [...values];
    const before = checklist && originalIndex >= 0 ? next.findIndex(value => originalTokens.findIndex(original => norm(original) === norm(value)) > originalIndex) : -1;
    next.splice(before < 0 ? next.length : before, 0, token);
    edit(next);
  };
  const drawSelected = () => {
    endDrag();
    selected.replaceChildren();
    if (!values.length) { const empty = document.createElement("li"); empty.textContent = "No selection"; selected.append(empty); }
    values.forEach((value, index) => {
      const entry = document.createElement("li");
      const label = document.createElement("span"); label.dataset.selectionLabel = field.id; label.dataset.value = value;
      const known = names.get(norm(value)); label.textContent = known?.name || `Loading selected item… (${value})`; label.title = known ? `${known.name}\n${known.path || value}` : value;
      const remove = document.createElement("button"); remove.className = "selection-remove"; remove.textContent = "×"; remove.title = "Remove selected item"; remove.disabled = blocked;
      remove.setAttribute("aria-label", `Remove selected item ${index + 1}`);
      remove.addEventListener("click", () => { if (!entry.isConnected) return; edit(values.filter((_, position) => position !== index)); (selected.children[Math.min(index, values.length - 1)]?.querySelector(".selection-remove") || trigger).focus(); });
      if (!checklist) {
        const handle = document.createElement("button"); handle.className = "reorder-handle"; handle.textContent = "⠿"; handle.draggable = !blocked; handle.disabled = blocked;
        handle.dataset.reorderField = field.id; handle.dataset.reorderValue = value;
        handle.setAttribute("aria-label", `Reorder selected item ${index + 1} of ${values.length}`);
        handle.setAttribute("aria-describedby", hint.id); handle.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown"); handle.title = "Drag to reorder · Alt+↑ / Alt+↓";
        handle.addEventListener("keydown", event => { if (handle.isConnected && values[index] === value && event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(index, index + (event.key === "ArrowUp" ? -1 : 1)); } });
        handle.addEventListener("dragstart", event => {
          if (blocked || !handle.isConnected || values[index] !== value || !event.dataTransfer) { event.preventDefault(); return; }
          cancelDrag?.(); drag = { index, before: stored.value, token: crypto.randomUUID(), y: event.clientY, revision }; cancelDrag = endDrag;
          event.dataTransfer.setData(dragType, drag.token); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setDragImage(entry, 12, entry.offsetHeight / 2); selected.classList.add("dragging");
        });
        handle.addEventListener("dragend", endDrag); entry.append(handle);
      }
      entry.append(label, remove);
      selected.append(entry);
    });
  };
  clear.addEventListener("click", () => edit([]));
  trigger.addEventListener("click", picker.open);
  row.append(stored,controls,hint,selected,announcement,picker.popup); drawSelected();

}
function createChoicePicker(row, field, trigger, options) {
  const popup = document.createElement("div"); popup.className = "selection-popup"; popup.hidden = true; popup.id = `${field.id}-choices`;
  popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", `${field.label} choices`);
  trigger.setAttribute("aria-controls", popup.id); trigger.setAttribute("aria-haspopup", "dialog");
  const header = document.createElement("div"); header.className = "picker-header";
  const back = document.createElement("button"); back.textContent = "‹"; back.title = "Back to parent"; back.setAttribute("aria-label", "Back to parent"); back.hidden = true;
  const source = document.createElement("span"); source.className = "picker-source";
  const dismiss = document.createElement("button"); dismiss.textContent = "×"; dismiss.title = "Close choices"; dismiss.setAttribute("aria-label", "Close choices");
  header.append(back,source,dismiss);
  const search = document.createElement("input"); search.type = "search"; search.className = "picker-search";
  search.placeholder = options.tree ? "Filter this level" : "Search items"; search.setAttribute("aria-label", `Search ${field.label} choices`);
  const status = document.createElement("p"); status.className = "picker-status meta"; status.setAttribute("role", "status");
  const results = document.createElement("div"); results.className = "picker-results"; results.setAttribute("role", "list"); results.setAttribute("aria-label", `${field.label} choices`);
  const scope = document.createElement("p"); scope.className = "picker-scope meta"; scope.textContent = "Current level only. Open children to browse."; scope.hidden = !options.tree;
  popup.append(header,search,status,scope,results);
  let page; let history = []; let controls = [];
  const shortPath = path => { const parts = path.split("/").filter(Boolean); return `${parts.length > 2 ? "… › " : ""}${parts.slice(-2).join(" › ")}`; };
  const position = () => {
    if (popup.hidden || !trigger.isConnected) return;
    const rect = trigger.getBoundingClientRect(); const width = document.documentElement.clientWidth; const height = window.innerHeight;
    if (rect.bottom < 0 || rect.top > height) { close(false); return; }
    const below = Math.max(0, height - rect.bottom - 12); const above = Math.max(0, rect.top - 12);
    const useBelow = below >= 180 || below >= above; const room = Math.min(360, useBelow ? below : above);
    popup.style.width = `${Math.min(480, Math.max(0, width - 16))}px`;
    popup.style.maxHeight = `${room}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, width - Math.min(480, width - 16) - 8))}px`;
    popup.style.top = useBelow ? `${rect.bottom + 4}px` : "auto";
    popup.style.bottom = useBelow ? "auto" : `${height - rect.top + 4}px`;
  };
  const close = (focus = true) => {
    popup.hidden = true; trigger.setAttribute("aria-expanded", "false"); selectionRequests.delete(field.id);
    if (activePicker?.popup === popup) activePicker = undefined;
    if (focus && trigger.isConnected && !trigger.disabled) trigger.focus();
  };
  const update = () => {
    let added = 0;
    for (const {button, badge, choice} of controls) {
      const chosen = options.chosen(choice); if (chosen) added++;
      badge.textContent = chosen ? (options.multiple ? "✓ Added" : "✓ Current") : choice.disabled ? "Unavailable" : "";
      button.setAttribute("aria-pressed", String(chosen));
      button.setAttribute("aria-disabled", String(blocked || Boolean(choice.disabled) || (options.multiple && (chosen || options.limited?.()))));
    }
    status.textContent = !page ? "Loading choices…" : !page.choices.length ? "No accessible choices at this level." : !controls.length ? "No matching choices at this level." : options.multiple && options.limited?.() ? "256 selections reached. Remove an item to add another." : options.multiple && added === controls.length ? "All shown items added." : "";
    position();
  };
  const draw = () => {
    results.replaceChildren(); controls = []; if (!page) return;
    const counts = new Map(); for (const choice of page.choices) { const name = (choice.displayName || choice.name).toLowerCase(); counts.set(name, (counts.get(name) || 0) + 1); }
    let group;
    for (const choice of page.choices.filter(choice => `${choice.name} ${choice.displayName} ${choice.path}`.toLowerCase().includes(search.value.toLowerCase()))) {
      if (choice.group && choice.group !== group) { group = choice.group; const heading = document.createElement("div"); heading.className = "picker-group"; heading.textContent = group.split(" · ")[0]; heading.title = group; results.append(heading); }
      const entry = document.createElement("div"); entry.className = "picker-row"; entry.setAttribute("role", "listitem");
      const button = document.createElement("button"); button.className = "picker-choice"; button.dataset.choiceId = choice.itemId.replace(/[{}-]/g, "").toLowerCase();
      button.title = `${choice.path}${choice.disabled ? `\n${choice.disabled}` : ""}`;
      const text = document.createElement("span"); text.className = "picker-choice-text";
      const name = document.createElement("span"); name.className = "picker-choice-name"; name.textContent = choice.displayName || choice.name; text.append(name);
      if (counts.get(name.textContent.toLowerCase()) > 1) {
        const parent = choice.path.slice(0,choice.path.lastIndexOf("/"));
        const relative = parent.toLowerCase().startsWith(`${page.root.path.toLowerCase()}/`) ? parent.slice(page.root.path.length + 1) : parent === page.root.path ? page.root.name : parent;
        const sameParent = page.choices.filter(other => (other.displayName || other.name).toLowerCase() === name.textContent.toLowerCase() && other.path.slice(0,other.path.lastIndexOf("/")).toLowerCase() === parent.toLowerCase()).length > 1;
        const detail = document.createElement("span"); detail.className = "picker-choice-path"; detail.textContent = `${relative || "Source"}${sameParent ? ` · ${choice.name}` : ""}`; text.append(detail);
      }
      const badge = document.createElement("span"); badge.className = "picker-choice-state"; button.append(text,badge); entry.append(button);
      button.addEventListener("click", () => {
        if (popup.hidden || blocked || !button.isConnected || button.getAttribute("aria-disabled") === "true") return;
        options.accept(choice);
        if (options.multiple) { update(); status.textContent = `Added ${choice.displayName || choice.name}.${controls.every(control => options.chosen(control.choice)) ? " All shown items added." : ""}`; }
      });
      controls.push({button,badge,choice});
      if (options.tree && choice.hasChildren) {
        const children = document.createElement("button"); children.className = "picker-children"; children.textContent = "›"; children.setAttribute("aria-label", `Open children of ${choice.displayName || choice.name}`); children.title = "Open children";
        children.addEventListener("click", () => { if (blocked || popup.hidden || !children.isConnected) return; const previous = page; history.push(previous); load(choice.itemId); }); entry.append(children);
      }
      results.append(entry);
    }
    update();
  };
  const load = parent => {
    page = undefined; controls = []; results.replaceChildren(); search.value = ""; status.textContent = "Loading choices…"; back.hidden = !history.length; search.focus(); position();
    const id = String(++selectionRequestId);
    selectionRequests.set(field.id, { id, receive: result => {
      if (popup.hidden || !row.isConnected) return;
      if (result.error) { status.textContent = result.error; position(); return; }
      page = result.page; const path = page.parent?.path || page.root.path;
      source.textContent = shortPath(path); source.title = `Source: ${field.selectionSource || page.root.path}\nCurrent level: ${path}`;
      options.loaded?.(result); draw();
    } });
    send("choices", {id:field.id,request:id,...(parent ? {parent} : {})});
  };
  const open = () => {
    if (blocked || !row.isConnected) return;
    if (!popup.hidden) { close(); return; }
    activePicker?.close(false); activePicker = {row,popup,trigger,close,position}; history = []; source.textContent = "Choices"; source.title = field.selectionSource || "";
    trigger.scrollIntoView({block:"nearest"});
    popup.hidden = false; trigger.setAttribute("aria-expanded", "true"); load();
  };
  back.addEventListener("click", () => { if (blocked || !history.length) return; selectionRequests.delete(field.id); page = history.pop(); back.hidden = !history.length; search.value = ""; source.textContent = shortPath(page.parent?.path || page.root.path); source.title = `Source: ${field.selectionSource || page.root.path}\nCurrent level: ${page.parent?.path || page.root.path}`; draw(); search.focus(); });
  search.addEventListener("input", draw); dismiss.addEventListener("click", () => close());
  popup.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (options.tree && !event.target.matches("input") && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowRight") { const child = event.target.closest(".picker-row")?.querySelector(".picker-children"); if (child) { event.preventDefault(); child.click(); return; } }
      if (event.key === "ArrowLeft" && history.length) { event.preventDefault(); back.click(); return; }
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...results.querySelectorAll(".picker-choice")]; if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement?.closest(".picker-row")?.querySelector(".picker-choice")); const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : Math.max(0, Math.min(buttons.length - 1,index + (event.key === "ArrowDown" ? 1 : -1)));
    buttons[next].focus(); buttons[next].scrollIntoView({block:"nearest"});
  });
  row.addEventListener("focusout", event => { if (!popup.hidden && event.relatedTarget && !row.contains(event.relatedTarget)) close(false); });
  return {popup,search,open,close,refresh:update};
}
