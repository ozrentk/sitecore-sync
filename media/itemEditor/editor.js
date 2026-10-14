/* global acquireVsCodeApi */
const api = acquireVsCodeApi();
let revision = 0;
let blocked = false;
let frozenControls = [];
const selectionRequests = new Map();
let selectionRequestId = 0;
let activePicker;
let cancelDrag;
document.addEventListener("keydown", event => { if (event.key === "Escape") cancelDrag?.(); });
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.target.matches("input, textarea") && ["z", "y"].includes(event.key.toLowerCase())) {
    event.preventDefault(); send(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
  }
});
const savedSections = api.getState()?.sections;
const sectionOpen = new Map(savedSections && typeof savedSections === "object" && !Array.isArray(savedSections)
  ? Object.entries(savedSections).filter(([, open]) => typeof open === "boolean") : []);
document.addEventListener("pointerdown", event => { if (activePicker && !activePicker.row.contains(event.target)) activePicker.close(false); });
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
  const status = document.createElement("p"); status.className = "meta"; status.setAttribute("role", "status");
  const content = document.createElement("div"); content.className = "selection-choices";
  const popup = document.createElement("div"); popup.className = "selection-popup"; popup.hidden = true; popup.id = `${field.id}-choices`;
  popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", `${field.label} choices`); popup.append(status, content);
  label.setAttribute("aria-controls", popup.id);
  const close = (focus = true) => {
    popup.hidden = true; label.setAttribute("aria-expanded", "false");
    selectionRequests.delete(field.id);
    if (activePicker?.row === row) activePicker = undefined;
    if (focus) label.focus();
  };
  row.addEventListener("keydown", event => { if (event.key === "Escape" && !popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); } });
  row.addEventListener("focusout", event => { if (event.relatedTarget && !row.contains(event.relatedTarget)) close(false); });
  const choose = (value, name, clear = false, path = "") => {
    if (blocked) return;
    stored.value = value; stored.dataset.explicitClear = String(clear);
    label.dataset.value = value;
    setSelectionLabel(label, name, path);
    close();
    send("change", { id: field.id, input: value, clear });
    document.getElementById("status").textContent = "Unsaved changes";
  };
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
  clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
  clear.addEventListener("click", () => choose("", "Explicit empty selection", true));
  const request = (parent, receive) => {
    if (blocked) return;
    const previous = selectionRequests.get(field.id);
    if (previous) previous.receive({ error: "Choice loading was superseded. Collapse and expand this branch to retry." });
    const id = String(++selectionRequestId);
    selectionRequests.set(field.id, { id, receive });
    send("choices", { id: field.id, request: id, ...(parent ? { parent } : {}) });
  };
  const showTree = (container, page) => {
    container.replaceChildren();
    const list = document.createElement("ul"); list.className = "selection-tree";
    for (const choice of page.choices) {
      const item = document.createElement("li");
      const select = document.createElement("button"); select.textContent = `Select ${choice.displayName || choice.name}`;
      select.title = `${choice.path} · ${choice.value}`; select.disabled = blocked;
      select.addEventListener("click", () => choose(choice.value, choice.displayName || choice.name, false, choice.path));
      const path = document.createElement("span"); path.className = "meta"; path.textContent = choice.path;
      item.append(select, path);
      if (choice.hasChildren) {
        const branch = document.createElement("details");
        const heading = document.createElement("summary"); heading.textContent = `Children of ${choice.displayName || choice.name}`;
        const nested = document.createElement("div"); branch.append(heading, nested);
        branch.addEventListener("toggle", () => {
          if (!branch.open || blocked) return;
          nested.textContent = "Loading…";
          request(choice.itemId, result => {
            if (result.error) nested.textContent = result.error;
            else showTree(nested, result.page);
          });
        });
        item.append(branch);
      }
      list.append(item);
    }
    container.append(list);
    if (!page.choices.length) container.textContent = "No accessible children.";
  };
  const showList = page => {
    content.replaceChildren();
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Filter by name or path";
    search.setAttribute("aria-label", `Filter ${field.label} choices`); search.disabled = blocked;
    const select = document.createElement("select"); select.size = 7; select.disabled = blocked;
    select.setAttribute("aria-label", `${field.label} choices`);
    const draw = () => {
      select.replaceChildren();
      const prompt = document.createElement("option"); prompt.value = ""; prompt.textContent = "Choose an item (current value stays unchanged)"; prompt.selected = true; prompt.disabled = true; select.append(prompt);
      const groups = new Map();
      for (const choice of page.choices.filter(c => `${c.name} ${c.displayName} ${c.path}`.toLowerCase().includes(search.value.toLowerCase()))) {
        let parent = select;
        if (choice.group) {
          if (!groups.has(choice.group)) { const group = document.createElement("optgroup"); group.label = choice.group; groups.set(choice.group, group); select.append(group); }
          parent = groups.get(choice.group);
        }
        const option = document.createElement("option"); option.value = choice.itemId;
        option.textContent = `${choice.displayName || choice.name} · ${choice.path}${choice.disabled ? " · ambiguous name" : ""}`;
        option.disabled = Boolean(choice.disabled); parent.append(option);
      }
    };
    search.addEventListener("input", draw);
    const accept = () => {
      if (popup.hidden) return;
      const choice = page.choices.find(c => c.itemId === select.value);
      if (choice && !choice.disabled) choose(choice.value, choice.displayName || choice.name, false, choice.path);
    };
    select.addEventListener("change", accept);
    select.addEventListener("click", accept);
    select.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); accept(); } });
    draw(); content.append(search, select);
    if (!page.choices.length) status.textContent = "No accessible choices. The current value is preserved.";
    search.focus();
  };
  const open = () => {
    if (blocked) return;
    if (!popup.hidden) { close(); return; }
    activePicker?.close(false);
    activePicker = { row, close };
    popup.hidden = false; label.setAttribute("aria-expanded", "true");
    status.textContent = "Loading choices…"; content.replaceChildren();
    request(undefined, result => {
      if (result.error) { status.textContent = result.error; return; }
      status.textContent = `Source: ${result.page.root.path}`;
      // Resolving the original value must not overwrite feedback for a new draft.
      if (stored.value === field.original && stored.dataset.explicitClear !== "true") setSelectionLabel(label, result.currentName ?? result.currentLabel, result.currentPath);
      if (field.selectionKind === "droptree") showTree(content, result.page);
      else showList(result.page);
    });
  };
  label.addEventListener("click", open);
  label.addEventListener("keydown", event => {
    if (["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); if (popup.hidden) open(); else content.querySelector("input, select, button, summary")?.focus(); }
  });
  const controls = document.createElement("div"); controls.className = "selection-controls"; controls.append(label, clear);
  row.append(stored, controls, popup);
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
  trigger.setAttribute("aria-expanded", "false"); trigger.textContent = "Choose items…";
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
  const popup = document.createElement("div"); popup.className = "selection-popup"; popup.hidden = true; popup.id = `${field.id}-choices`;
  trigger.setAttribute("aria-controls", popup.id);
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const available = document.createElement("div"); available.className = "multiple-available";
  popup.append(status, available);
  let refreshChoices = () => {};
  row.addEventListener("referenceResolved", event => {
    const label = event.target;
    if (label.dataset.selectionLabel === field.id) names.set(norm(label.dataset.value), {name:event.detail.text,path:event.detail.path});
  });
  const edit = (next, reorder = false, focusValue) => {
    if (blocked || !row.isConnected || next.join("|") === stored.value) return;
    const before = stored.value; endDrag();
    const focusedChoice = document.activeElement?.dataset.choiceId;
    values = next; stored.value = values.join("|"); stored.dataset.explicitClear = String(!values.length);
    send(reorder ? "reorder" : "change", {id:field.id,input:stored.value,clear:!values.length,...(reorder ? {before,focusValue} : {})});
    document.getElementById("status").textContent = "Unsaved changes";
    drawSelected(); refreshChoices();
    if (focusedChoice) {
      const replacement = [...available.querySelectorAll("[data-choice-id]")].find(control => control.dataset.choiceId === focusedChoice);
      if (replacement && !replacement.disabled) replacement.focus(); else trigger.focus();
    }
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
  const close = (focus = true) => { popup.hidden = true; trigger.setAttribute("aria-expanded", "false"); selectionRequests.delete(field.id); if (activePicker?.row === row) activePicker = undefined; if (focus) trigger.focus(); };
  const request = (parent, receive) => {
    if (blocked) return;
    const previous = selectionRequests.get(field.id); previous?.receive({error:"Loading was superseded. Collapse and expand to retry."});
    const id = String(++selectionRequestId); selectionRequests.set(field.id, {id,receive});
    send("choices", {id:field.id,request:id,...(parent ? {parent} : {})});
  };
  const choiceControl = choice => {
    const entry = document.createElement("div"); entry.className = "multiple-choice";
    const title = `${choice.displayName || choice.name} · ${choice.path}`;
    names.set(norm(choice.itemId), {name:choice.displayName || choice.name,path:choice.path});
    const chosen = values.some(value => norm(value) === norm(choice.itemId));
    if (checklist) {
      const label = document.createElement("label"); const box = document.createElement("input"); box.type = "checkbox"; box.checked = chosen; box.dataset.choiceId = norm(choice.itemId);
      box.disabled = blocked || Boolean(choice.disabled) || (!chosen && values.length >= 256);
      box.addEventListener("change", () => { if (box.checked) add(choice); else edit(values.filter(value => norm(value) !== norm(choice.itemId))); });
      label.append(box, document.createTextNode(title)); entry.append(label);
    } else {
      const addButton = document.createElement("button"); addButton.textContent = chosen ? "Selected" : "Add";
      addButton.disabled = blocked || chosen || Boolean(choice.disabled) || values.length >= 256;
      addButton.dataset.choiceId = norm(choice.itemId);
      addButton.addEventListener("click", () => add(choice));
      const name = document.createElement("span"); name.textContent = title; entry.append(addButton, name);
    }
    return entry;
  };
  const showTree = (container, page) => {
    container.replaceChildren();
    if (!page.choices.length) { container.textContent = "No accessible children."; return; }
    for (const choice of page.choices) {
      const entry = choiceControl(choice); container.append(entry);
      if (choice.hasChildren) {
        const branch = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Children of ${choice.displayName || choice.name}`;
        const nested = document.createElement("div"); nested.className = "selection-tree"; branch.append(summary, nested); entry.append(branch);
        branch.addEventListener("toggle", () => { if (branch.open && !popup.hidden && !blocked) { nested.textContent = "Loading…"; request(choice.itemId, result => { if (result.error) nested.textContent = result.error; else { showTree(nested, result.page); drawSelected(); } }); } });
      }
    }
  };
  trigger.addEventListener("click", () => {
    if (blocked) return;
    if (!popup.hidden) { close(); return; }
    activePicker?.close(false); activePicker = {row,close}; popup.hidden = false; trigger.setAttribute("aria-expanded", "true");
    available.replaceChildren(); status.textContent = "Loading choices…";
    request(undefined, result => {
      if (result.error) { status.textContent = result.error; return; }
      status.textContent = `Source: ${result.page.root.path}`;
      if (tree) {
        showTree(available, result.page);
        refreshChoices = () => { for (const button of available.querySelectorAll("[data-choice-id]")) { const chosen = values.some(value => norm(value) === button.dataset.choiceId); button.disabled = blocked || chosen || values.length >= 256; button.textContent = chosen ? "Selected" : "Add"; } };
      } else {
        const search = document.createElement("input"); search.type = "search"; search.placeholder = "Filter by name or path"; search.setAttribute("aria-label", `Filter ${field.label} choices`);
        const list = document.createElement("div"); available.append(search,list);
        const draw = () => { list.replaceChildren(); for (const choice of result.page.choices.filter(choice => `${choice.name} ${choice.displayName} ${choice.path}`.toLowerCase().includes(search.value.toLowerCase()))) list.append(choiceControl(choice)); if (!list.children.length) list.textContent = "No matching choices."; };
        refreshChoices = draw; search.addEventListener("input", draw); draw(); search.focus();
      }
      drawSelected();
    });
  });
  row.addEventListener("keydown", event => { if (event.key === "Escape" && !popup.hidden) { event.preventDefault(); close(); } });
  row.addEventListener("focusout", event => { if (event.relatedTarget && !row.contains(event.relatedTarget)) close(false); });
  row.append(stored,controls,hint,selected,announcement,popup); drawSelected();
}
