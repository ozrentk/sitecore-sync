/* global acquireVsCodeApi */
const api = acquireVsCodeApi();
let revision = 0;
let blocked = false;
let frozenControls = [];
const selectionRequests = new Map();
let selectionRequestId = 0;
let activePicker;
let cancelDrag;
const linkOpen = new Map();
const assetRequests = new Map();
let assetRequestId = 0;
const htmlSources = new Map();
const htmlModes = new Map();
const htmlSelections = new Map();
const visualSources = new Map();
const visualSelections = new Map();
// Electron can restore an active input without delivering its original focus event.
window.addEventListener("focus", () => document.activeElement?.dispatchEvent(new Event("editorFocus")));
let freezeGeneration = 0;
document.addEventListener("keydown", event => { if (event.key === "Escape") { cancelDrag?.(); activePicker?.close(); } });
document.addEventListener("keydown", event => {
  if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.altKey && !event.target.matches("input, textarea") && ["z", "y"].includes(event.key.toLowerCase())) {
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
  if (state.type === "assetPreview") {
    const pending = assetRequests.get(state.id);
    if (pending && pending.request === state.request && state.revision === revision) { assetRequests.delete(state.id); pending.receive(state); }
    return;
  }
  if (state.type === "draftValidation") {
    if (state.revision !== revision) return;
    const stored = [...document.querySelectorAll("[data-field-id]")].find(control => control.dataset.fieldId === state.id);
    if (stored?.value === state.input) { const error = stored.closest(".field").querySelector(".structured-error"); if (error) { error.textContent = state.error; stored.closest(".field").dispatchEvent(new Event("structuredValidation")); } }
    return;
  }
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
    freezeGeneration++;
    revision = state.revision; blocked = false;
    for (const [control, disabled] of frozenControls) control.disabled = disabled;
    for (const source of visualSources.values()) source.editable(true);
    frozenControls = [];
    for (const [id, source] of htmlSources) {
      const control = document.getElementById(id);
      send("change", { id, input: source.read(), clear: control?.dataset.explicitClear === "true" });
    }
    document.getElementById("status").textContent = state.error;
    return;
  }
  if (state.type === "freeze") {
    void freezeInputs(state);
    return;
  }
  if (state.type !== "state") return;
  freezeGeneration++;
  for (const [id, source] of visualSources) { visualSelections.set(id, source.selection()); source.dispose(); }
  visualSources.clear();
  for (const [id, source] of htmlSources) {
    const control = document.getElementById(id);
    if (control) htmlSelections.set(id, { start: control.selectionStart, end: control.selectionEnd, scroll: control.scrollTop });
    source.dispose();
  }
  htmlSources.clear();
  cancelDrag?.();
  activePicker?.close(false);
  selectionRequests.clear();
  assetRequests.clear();
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
      const value = renderReadOnlyField(field, {
        information: row.querySelector(".field-info-content"),
        requestAsset: receive => { const request = ++assetRequestId; assetRequests.set(field.id, {request, receive}); send("previewAsset", {id:field.id,request}); },
        openAsset: () => send("openAsset", {id:field.id,request:assetRequestId})
      });
      if (field.kind === "generallink") {
        const kind = document.createElement("p"); kind.className = "meta link-type-readonly";
        const token = /\blinktype\s*=\s*["']([^"']*)["']/i.exec(field.raw)?.[1];
        kind.textContent = `Link type: ${token || "unrecognized"} (read-only)`; row.append(kind);
      }
      if (field.selectionKind && !["checklist", "multilist", "treelist", "treelistex"].includes(field.selectionKind)) row.append(selectionLabel(field));
      row.append(value);
    } else if (field.kind === "html") {
      renderHtmlSource(row, field);
    } else if (field.kind === "namevalues") {
      renderNameValues(row, field);
    } else if (field.kind === "generallink") {
      renderGeneralLink(row, field);
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
    const visual = visualSources.get(state.focus.id);
    if (visual) { const selection = visualSelections.get(state.focus.id); if (selection) visual.restore(selection); else visual.focus(); return; }
    const handle = [...document.querySelectorAll("[data-reorder-field]")].find(control => control.dataset.reorderField === state.focus.id && control.dataset.reorderValue === state.focus.value);
    (handle || document.getElementById(state.focus.id))?.focus();
    const source = document.getElementById(state.focus.id);
    const selection = htmlSelections.get(state.focus.id);
    if (source?.classList.contains("html-source") && selection) {
      source.setSelectionRange(selection.start, selection.end); source.scrollTop = selection.scroll;
    }
  }
});
async function freezeInputs(state) {
  const generation = ++freezeGeneration;
  for (const form of document.querySelectorAll(".richtext-link-form")) form.dispatchEvent(new Event("close-link"));
  cancelDrag?.(); activePicker?.close(false); blocked = true;
  try {
    // Blur commits IME when supported. Otherwise wait, and refuse Save if it does not finish.
    await Promise.all([...visualSources.values()].map(source => source.freeze()));
    await Promise.all([...htmlSources.values()].map(source => source.finishComposition()));
    if (generation !== freezeGeneration) return;
    const drafts = {};
    for (const control of document.querySelectorAll("[data-field-id]")) {
      const input = htmlSources.get(control.dataset.fieldId)?.read() ?? (control.type === "checkbox" ? (control.checked ? "1" : "") : control.value);
      const clear = control.dataset.explicitClear === "true";
      if (input !== control.dataset.original || clear) drafts[control.dataset.fieldId] = { input, clear };
    }
    frozenControls = [...document.querySelectorAll("input, textarea, select, button")].map(control => [control, control.disabled]);
    for (const [control] of frozenControls) control.disabled = true;
    api.postMessage({ type: "frozen", id: state.id, revision, drafts });
  } catch {
    if (generation === freezeGeneration) api.postMessage({ type: "frozen", id: state.id, revision, error: true });
  }
}
function renderHtmlSource(row, field) {
  const actions = document.createElement("div"); actions.className = "html-source-actions";
  const html = document.createElement("button"); html.textContent = "HTML"; html.type = "button";
  const preview = document.createElement("button"); preview.textContent = "Preview"; preview.type = "button";
  const visual = document.createElement("button"); visual.textContent = "Visual"; visual.type = "button";
  const visualArea = document.createElement("div"); visualArea.className = "richtext-visual";
  const tools = document.createElement("div"); tools.className = "richtext-tools";
  const blockType = document.createElement("select"); blockType.setAttribute("aria-label", "Text block type");
  for (const [value, text] of [["", "Mixed blocks"], ["paragraph", "Paragraph"], ...[1,2,3,4,5,6].map(n=>[`h${n}`, `Heading ${n}`])]) {
    const option = document.createElement("option"); option.value = value; option.textContent = text; option.disabled = !value; blockType.append(option);
  }
  blockType.addEventListener("change", () => { if (!blocked && blockType.value) visualSources.get(field.id)?.command(blockType.value); }); tools.append(blockType);
  for (const [name, label] of [["bold", "Bold"], ["italic", "Italic"], ["underline", "Underline"], ["bulletList", "Bullets"], ["orderedList", "Numbers"], ["indent", "Indent"], ["outdent", "Outdent"], ["blockquote", "Quote"], ["clearFormatting", "Clear formatting"]]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = blocked;
    button.dataset.richCommand = name;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => { if (blocked) return; if (button.getAttribute("aria-disabled") === "true") visualError.textContent = button.title; else visualSources.get(field.id)?.command(name); }); tools.append(button);
  }
  const alignment = document.createElement("select"); alignment.setAttribute("aria-label", "Text alignment");
  for (const [value, label] of [["", "Alignment"], ["alignLeft", "Left"], ["alignCenter", "Center"], ["alignRight", "Right"], ["alignJustify", "Justify"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; option.disabled = !value; alignment.append(option); }
  alignment.addEventListener("change", () => { if (!blocked && alignment.value) visualSources.get(field.id)?.command(alignment.value); }); tools.append(alignment);
  const tableMenu = document.createElement("details"); tableMenu.className = "richtext-table-tools";
  const tableTitle = document.createElement("summary"); tableTitle.textContent = "Table"; tableMenu.append(tableTitle);
  for (const [name, label] of [["insertTable", "Insert table (2 × 2)"], ["caption", "Add / edit caption"], ["rowBefore", "Insert row above"], ["rowAfter", "Insert row below"],
    ["columnBefore", "Insert column before"], ["columnAfter", "Insert column after"], ["deleteRow", "Delete empty rows"],
    ["deleteColumn", "Delete empty columns"], ["mergeCells", "Merge selected cells"], ["splitCell", "Split cell"]]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = blocked;
    button.dataset.richCommand = name;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => { if (blocked) return; if (button.getAttribute("aria-disabled") === "true") visualError.textContent = button.title; else visualSources.get(field.id)?.command(name); }); tableMenu.append(button);
  }
  tools.append(tableMenu);
  const linkButton = document.createElement("button"); linkButton.type = "button"; linkButton.textContent = "Link";
  linkButton.dataset.richCommand = "link";
  const linkForm = document.createElement("div"); linkForm.className = "richtext-link-form"; linkForm.hidden = true;
  let closeLink = () => {};
  linkForm.addEventListener("close-link", () => closeLink());
  linkButton.addEventListener("mousedown", event => event.preventDefault());
  linkButton.addEventListener("click", () => {
    if (blocked) return;
    if (linkButton.getAttribute("aria-disabled") === "true") { visualError.textContent = linkButton.title; return; }
    closeLink();
    const editor = visualSources.get(field.id);
    try {
      const info = editor.beginLink();
      linkForm.replaceChildren(); linkForm.hidden = false;
      const kind = document.createElement("select"); kind.setAttribute("aria-label", "Link destination type");
      for (const [value, text] of [["url", "URL"], ["sitecore", "Sitecore item"]]) { const option = document.createElement("option"); option.value = value; option.textContent = text; kind.append(option); }
      kind.value = info.kind === "sitecore" ? "sitecore" : "url";
      const url = document.createElement("input"); url.type = "text"; url.value = info.href; url.setAttribute("aria-label", "Link URL");
      const target = document.createElement("button"); target.type = "button"; target.textContent = info.itemId ? `Current target: ${info.itemId} — browse…` : "Choose Sitecore item…";
      let itemId = info.itemId;
      let active = true;
      const message = document.createElement("p"); message.className = "meta"; message.setAttribute("role", "status"); message.textContent = info.reason || "";
      const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply link";
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove link"; remove.hidden = !info.existing;
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
      const picker = createChoicePicker(row, { ...field, selectionSource: "/sitecore/content" }, target, { multiple: false, tree: true,
        chosen: choice => choice.itemId.replace(/[{}-]/g, "").toLowerCase() === itemId,
        accept: choice => {
          if (!active || blocked || visualSources.get(field.id) !== editor) return;
          itemId = choice.itemId.replace(/[{}-]/g, "").toLowerCase(); target.textContent = choice.displayName || choice.name; target.title = choice.path; picker.close();
        },
      });
      closeLink = () => { active = false; picker.dispose(); editor.cancelLink(); linkForm.hidden = true; linkForm.replaceChildren(); };
      const update = () => { url.hidden = kind.value !== "url"; target.hidden = kind.value !== "sitecore"; picker.close(false); };
      kind.addEventListener("change", update); target.addEventListener("click", picker.open);
      const commit = destination => { if (blocked || !active || visualSources.get(field.id) !== editor) return; try { editor.applyLink(destination); closeLink(); } catch (failure) { message.textContent = failure.message; } };
      apply.addEventListener("click", () => commit(kind.value === "sitecore" ? { kind: "sitecore", itemId: itemId || "" } : { kind: "url", href: url.value }));
      remove.addEventListener("click", () => commit("remove")); cancel.addEventListener("click", () => { closeLink(); editor.focus(); });
      linkForm.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); closeLink(); editor.focus(); } };
      for (const control of [kind, url, target, apply, remove]) control.disabled = Boolean(info.reason);
      linkForm.append(kind, url, target, apply, remove, cancel, message, picker.popup); update();
      (kind.value === "url" ? url : target).focus();
    } catch (failure) { visualError.textContent = failure.message; }
  });
  tools.append(linkButton);
  const hint = document.createElement("p"); hint.className = "meta";
  hint.textContent = "Select text to create a Link, or place the cursor inside a link to edit it. Select table cells by dragging across them. Stored styling appears in Preview. Plain-text paste only.";
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.type = "button";
  clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
  const control = document.createElement("textarea"); control.id = field.id; control.className = "html-source";
  control.spellcheck = false; control.wrap = "off"; control.setAttribute("aria-label", field.label + " HTML source");
  control.dataset.fieldId = field.id; control.dataset.original = field.original; control.dataset.explicitClear = String(field.clear);
  const error = document.createElement("p"); error.className = "meta"; error.setAttribute("role", "status");
  const visualError = document.createElement("p"); visualError.className = "meta visual-error"; visualError.setAttribute("role", "status");
  let toolFrame;
  const refreshTools = () => {
    if (toolFrame) return;
    toolFrame = requestAnimationFrame(() => {
      toolFrame = undefined;
      const editor = visualSources.get(field.id); if (!editor || !row.isConnected) return;
      for (const button of tools.querySelectorAll("button[data-rich-command]")) {
        if (button.closest(".richtext-table-tools") && !tableMenu.open) continue;
        const state = editor.status(button.dataset.richCommand);
        button.setAttribute("aria-disabled", String(blocked || !state.enabled));
        if (["bold","italic","underline","bulletList","orderedList","blockquote"].includes(button.dataset.richCommand)) button.setAttribute("aria-pressed",String(state.active));
        button.title = state.reason || (button.dataset.richCommand === "clearFormatting" ? "Remove bold, italic and underline only; retain links, wrappers and CSS." : button.textContent);
      }
      for (const select of [blockType, alignment]) {
        let selected = ""; let reason = ""; let available = false;
        for (const option of select.options) if (option.value) {
          const state = editor.status(option.value); option.disabled = !state.enabled; option.title = state.reason;
          if (state.active) selected = option.value; if (state.enabled) available = true; else reason ||= state.reason;
        }
        select.value = selected; select.disabled = blocked || !available; select.title = available ? select.getAttribute("aria-label") : reason;
      }
    });
  };
  tableMenu.addEventListener("toggle", refreshTools);
  const display = document.createElement("div"); display.className = "html-source-preview";
  const source = createHtmlSource(control, field.clear ? "" : field.input, {
    error: message => { error.textContent = message; },
    change: input => {
      visualError.textContent = "";
      control.dataset.explicitClear = "false";
      send("change", { id: field.id, input, clear: false }); document.getElementById("status").textContent = "Unsaved changes";
    },
    history: action => { if (!blocked) send(action); },
  });
  htmlSources.set(field.id, source);
  let modeRequest = 0;
  const mode = value => {
    closeLink();
    visualError.textContent = "";
    visualSources.get(field.id)?.dispose(); visualSources.delete(field.id); visualArea.replaceChildren();
    if (value === "visual") {
      try {
        const editor = createRichTextVisual(visualArea, source.read(), {
          change: raw => source.replace(raw), history: action => { if (!blocked) send(action); }, error: message => { visualError.textContent = message; }, selection: refreshTools,
        });
        editor.editable(!blocked); visualSources.set(field.id, editor); error.textContent = "";
      } catch (failure) { value = "html"; visualError.textContent = `Visual unavailable: ${failure.message}`; }
    }
    source.read(); htmlModes.set(field.id, value);
    visualArea.hidden = tools.hidden = hint.hidden = value !== "visual";
    control.hidden = value !== "html"; display.hidden = value !== "preview";
    html.setAttribute("aria-pressed", String(value === "html")); preview.setAttribute("aria-pressed", String(value === "preview")); visual.setAttribute("aria-pressed", String(value === "visual"));
    display.replaceChildren();
    refreshTools();
    if (value === "preview") {
      const raw = source.read();
      display.append(renderReadOnlyField({ raw, presentation: { kind: "richtext", status: raw ? "populated" : "empty" } }, { sourceMode: true }));
    }
  };
  const switchMode = async value => {
    if (blocked) return;
    const request = ++modeRequest;
    try {
      await visualSources.get(field.id)?.freeze(); await source.finishComposition();
      if (request === modeRequest && row.isConnected && !blocked) { mode(value); if (value === "html") control.focus(); else if (value === "visual") visualSources.get(field.id)?.focus(); }
    } catch { error.textContent = "Finish composing before changing modes."; visualSources.get(field.id)?.editable(!blocked); }
  };
  html.addEventListener("click", () => void switchMode("html"));
  preview.addEventListener("click", () => void switchMode("preview"));
  visual.addEventListener("click", () => void switchMode("visual"));
  clear.addEventListener("click", () => {
    if (blocked) return;
    modeRequest++;
    source.replace("", false); control.dataset.explicitClear = "true";
    send("change", { id: field.id, input: "", clear: true }); mode("html"); control.focus();
    document.getElementById("status").textContent = "Unsaved changes";
  });
  for (const button of [html, visual, preview, clear]) button.disabled = blocked;
  control.disabled = blocked;
  actions.append(html, visual, preview, clear); row.append(actions, tools, linkForm, hint, control, visualArea, display, error, visualError);
  mode(htmlModes.get(field.id) || "html");
}
function selectionLabel(field) {
  const label = document.createElement("p"); label.className = "selection-current"; label.id = field.id; label.setAttribute("role", "status");
  label.dataset.selectionLabel = field.id;
  label.dataset.value = field.clear ? "" : field.input;
  label.textContent = !label.dataset.value ? "No selection" : field.selectionKind.includes("droplist") ? label.dataset.value : "Loading selected item…";
  return label;
}
function structuredDraft(row, field, empty) {
  const stored = document.createElement("input"); stored.type = "hidden";
  stored.dataset.fieldId = field.id; stored.dataset.original = field.original; stored.dataset.explicitClear = String(field.clear);
  stored.value = field.clear ? JSON.stringify(empty) : field.input; row.append(stored);
  let data;
  try { data = JSON.parse(stored.value); } catch { data = null; }
  const error = document.createElement("p"); error.className = "meta structured-error"; error.setAttribute("role", "status"); row.append(error);
  const change = (value, clear = false) => {
    if (blocked || !row.isConnected) return;
    stored.value = JSON.stringify(value); stored.dataset.explicitClear = String(clear);
    send("change", { id: field.id, input: stored.value, clear });
    document.getElementById("status").textContent = "Unsaved changes";
  };
  return { data, error, change };
}
function renderNameValues(row, field) {
  const draft = structuredDraft(row, field, []); let entries = draft.data;
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.key !== "string" || typeof entry.value !== "string")) {
    draft.error.textContent = "Invalid retained name/value draft. Revert to reload saved values."; return;
  }
  const list = document.createElement("div"); list.className = "name-value-list";
  const actions = document.createElement("div"); actions.className = "selection-controls";
  const add = document.createElement("button"); add.id = field.id; add.textContent = "Add row"; add.disabled = blocked;
  add.setAttribute("aria-label", `${field.label}: Add row`);
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
  clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
  const validate = () => { draft.error.textContent = entries.some(e => !e.key) ? "Enter a key for each row. Empty values are allowed." : ""; };
  const draw = () => {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const pair = document.createElement("div"); pair.className = "name-value-row";
      for (const key of ["key", "value"]) {
        const input = document.createElement("input"); input.type = "text"; input.value = entry[key]; input.disabled = blocked;
        input.placeholder = key === "key" ? "Name" : "Value"; input.setAttribute("aria-label", `${field.label} row ${index + 1} ${key}`);
        input.addEventListener("input", () => { entry[key] = input.value; validate(); draft.change(entries); }); pair.append(input);
      }
      const remove = document.createElement("button"); remove.textContent = "×"; remove.disabled = blocked; remove.setAttribute("aria-label", `Remove row ${index + 1}`);
      remove.addEventListener("click", () => { entries.splice(index, 1); draft.change(entries); draw(); (list.children[Math.min(index, entries.length - 1)]?.querySelector("input") || add).focus(); });
      pair.append(remove); list.append(pair);
    });
    add.disabled = blocked || entries.length >= 256; validate();
  };
  add.addEventListener("click", () => { entries.push({ raw: null, key: "", value: "" }); draft.change(entries); draw(); list.lastElementChild.querySelector("input").focus(); });
  clear.addEventListener("click", () => { entries = []; draft.change(entries, true); draw(); add.focus(); });
  actions.append(add, clear); row.append(list, actions); draw();
}
function renderGeneralLink(row, field) {
  const empty = () => ({_xml:field.raw,linktype:"external",id:"",url:"",text:"",title:"",target:"",class:"",anchor:"",querystring:""});
  const draft = structuredDraft(row, field, empty()); let values = draft.data;
  if (!values || Object.keys(empty()).some(key => typeof values[key] !== "string")) { draft.error.textContent = "Invalid retained link draft. Revert to reload saved values."; return; }
  const typeNames = [["internal","Sitecore item"],["external","External URL"],["mailto","Email"],["anchor","Anchor"]];
  const specificKeys = ["id","url","anchor","querystring"];
  if (values._alternatives !== undefined && (!values._alternatives || typeof values._alternatives !== "object" || Array.isArray(values._alternatives)
    || Object.entries(values._alternatives).some(([kind,entry]) => !typeNames.some(([type])=>type===kind) || !entry || typeof entry !== "object" || Object.keys(entry).length !== specificKeys.length || specificKeys.some(key=>typeof entry[key]!=="string")))) {
    draft.error.textContent="Invalid retained link alternatives. Revert to reload saved values.";return;
  }
  const snapshot = () => Object.fromEntries(specificKeys.map(key => [key,values[key]]));
  const remember = () => { values._alternatives = {...values._alternatives,[values.linktype]:snapshot()}; };
  const names = new Map();
  const properties = document.createElement("div"); properties.className = "link-form"; properties.id = `${field.id}-properties`;
  const summary = document.createElement("p"); summary.className = "link-summary meta";
  const types = document.createElement("div"); types.className = "link-types"; types.id = field.id; types.tabIndex = -1;
  types.setAttribute("role","radiogroup"); types.setAttribute("aria-label",`${field.label} link type`);
  const toggle = document.createElement("button"); toggle.className = "link-expand"; toggle.disabled = blocked; toggle.setAttribute("aria-controls",properties.id);
  let expanded = linkOpen.get(field.id) ?? false;
  const expand = open => {
    expanded = Boolean(open || draft.error.textContent); linkOpen.set(field.id,expanded);
    properties.hidden = !expanded; summary.hidden = expanded || !summary.textContent;
    toggle.textContent = expanded ? "▴" : "▾"; toggle.setAttribute("aria-expanded",String(expanded));
    toggle.setAttribute("aria-label",`${expanded ? "Collapse" : "Expand"} ${field.label} properties`);
  };
  row.addEventListener("structuredValidation",()=>expand(expanded));
  const updateSummary = () => {
    summary.textContent = [values.text && `Text: ${values.text}`, values.title && `Title: ${values.title}`,
      values.target && (values.target === "_blank" ? "New tab" : values.target !== "_self" && `Target: ${values.target}`),
      values.class && `Class: ${values.class}`, ["internal","external"].includes(values.linktype) && values.anchor && `Anchor: ${values.anchor}`,
      values.linktype === "internal" && values.querystring && `Query: ${values.querystring}`].filter(Boolean).join(" · ");
    summary.title = summary.textContent; summary.hidden = expanded || !summary.textContent;
  };
  const changed = () => { remember(); draft.error.textContent = ""; draft.change(values); updateSummary(); };
  const controls = new Map(); const groups = new Map();
  const add = (key,title,parent) => {
    const group = document.createElement("label"); group.className = "link-property";
    const caption = document.createElement("span"); caption.textContent = title; group.append(caption);
    const input = document.createElement("input"); input.type = "text"; input.dataset.linkProperty = key;
    input.setAttribute("aria-label",`${field.label} ${title}`);
    input.disabled = blocked || (field.linkCustom && !["text","title","target","class"].includes(key));
    for (const event of ["focus", "editorFocus", "click"]) input.addEventListener(event,()=>expand(true));
    input.addEventListener("input",()=>{
      if (key === "url" && values.linktype === "anchor") {
        const attributeOnly = !values.url && Boolean(values.anchor);
        const mirrored = Boolean(values.url) && values.url === values.anchor;
        if(attributeOnly) values.anchor = input.value; else {values.url=input.value;if(mirrored)values.anchor=input.value;}
      } else values[key] = key === "url" && values.linktype === "mailto" ? `mailto:${input.value}` : input.value;
      changed();
    });
    group.append(input);parent.append(group);controls.set(key,input);groups.set(key,group);return input;
  };
  const line = document.createElement("div"); line.className = "link-destination";
  const destination = add("url","Destination",line);
  const target = document.createElement("input"); target.type="text"; target.readOnly=true; target.className="selection-trigger"; target.id=`${field.id}-target`;
  target.dataset.selectionLabel=field.id;target.dataset.showPath="true";
  target.disabled=blocked||field.linkCustom;target.setAttribute("aria-label",`${field.label} Sitecore item path`);target.setAttribute("role","combobox");target.setAttribute("aria-expanded","false");
  line.append(target,toggle);
  const refreshTarget = () => {target.dataset.value=values.id;target.value=names.get(values.id)|| (values.id ? "Loading selected item…" : "Choose a Sitecore item…");};
  target.addEventListener("selectionResolved",event=>{names.set(values.id,event.detail.path||event.detail.text);});
  const picker = createChoicePicker(row,field,target,{multiple:false,tree:true,
    chosen:choice=>values.id.replace(/[{}-]/g,"").toLowerCase()===choice.itemId.replace(/[{}-]/g,"").toLowerCase(),
    accept:choice=>{values.id=choice.value;values.url="";names.set(values.id,choice.path);refreshTarget();setSelectionLabel(target,choice.displayName||choice.name,choice.path);changed();picker.close();}
  });
  for (const event of ["focus", "editorFocus", "click"]) target.addEventListener(event,()=>expand(true));
  target.addEventListener("click",picker.open);
  target.addEventListener("keydown",event=>{if(["Enter"," ","ArrowDown"].includes(event.key)){event.preventDefault();picker.open();}});
  for(const [key,title] of [["text","Link text"],["title","Title"],["target","Target"],["class","CSS class"],["anchor","Anchor"],["querystring","Query string"]])add(key,title,properties);
  const update = () => {
    for(const button of types.children){const selected=button.dataset.linkType===values.linktype;button.setAttribute("aria-checked",String(selected));button.tabIndex=selected?0:-1;}
    target.hidden=values.linktype!=="internal";groups.get("url").hidden=values.linktype==="internal";
    groups.get("anchor").hidden=["mailto","anchor"].includes(values.linktype);groups.get("querystring").hidden=values.linktype!=="internal";
    const title=values.linktype==="mailto"?"Email":values.linktype==="anchor"?"Anchor":"URL";
    groups.get("url").querySelector("span").textContent=title;destination.setAttribute("aria-label",`${field.label} ${title}`);
    destination.placeholder=values.linktype==="mailto"?"name@example.com":values.linktype==="anchor"?"Anchor name (without #)":"https://example.com";
    for(const [key,input] of controls)input.value=key==="url"&&values.linktype==="mailto"?values.url.replace(/^mailto:/i,""):values[key];
    if(values.linktype==="anchor")destination.value=values.url||values.anchor;
    refreshTarget();updateSummary();
  };
  const switchType = kind => {
    if(blocked||field.linkCustom||kind===values.linktype){expand(true);return;}
    picker.close(false);remember();values.linktype=kind;
    const restored=values._alternatives[kind]||{id:"",url:"",anchor:"",querystring:""};
    for(const key of specificKeys)values[key]=restored[key];
    changed();update();expand(true);
  };
  for(const [kind,name] of typeNames){
    if(field.linkCustom&&kind!==values.linktype)continue;
    const button=document.createElement("button");button.type="button";button.textContent=name;button.dataset.linkType=kind;button.disabled=blocked;
    button.setAttribute("role","radio");button.addEventListener("click",()=>switchType(kind));types.append(button);
  }
  types.addEventListener("keydown",event=>{
    const buttons=[...types.children];const index=buttons.indexOf(document.activeElement);if(index<0||blocked)return;
    let next;if(["ArrowRight","ArrowDown"].includes(event.key))next=(index+1)%buttons.length;else if(["ArrowLeft","ArrowUp"].includes(event.key))next=(index+buttons.length-1)%buttons.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=buttons.length-1;else return;
    event.preventDefault();buttons[next].focus();buttons[next].click();
  });
  toggle.addEventListener("click",()=>expand(!expanded));
  const clear=document.createElement("button");clear.textContent="Clear";clear.disabled=blocked;clear.title="Store an explicit empty value, not a reset";
  clear.addEventListener("click",()=>{picker.close(false);const originalKind=values.linktype;values=empty();if(field.linkCustom)values.linktype=originalKind;draft.error.textContent="";draft.change(values,true);update();expand(false);});
  const header=document.createElement("div");header.className="link-header";header.append(types,clear);
  row.append(header,line,summary,properties,picker.popup);
  if(field.linkCustom){const note=document.createElement("p");note.className="meta";note.textContent="Custom link metadata is preserved; destination and type are read-only.";row.append(note);}
  draft.error.textContent=field.validation||"";update();expand(expanded);
}
function setSelectionLabel(control, text, path = "") {
  if (control instanceof HTMLInputElement) {
    control.value = control.dataset.showPath === "true" ? path || text : text;
    control.dispatchEvent(new CustomEvent("selectionResolved", {detail:{text,path}}));
    const detail = document.getElementById(`${control.dataset.selectionLabel || control.id}-path`);
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
  infoContent.append(meta, current); if (field.selectionKind || field.kind === "generallink") infoContent.append(selectedPath);
  if (field.selectionSource !== undefined) { const source = document.createElement("p"); source.className = "meta"; source.textContent = `Source: ${field.selectionSource || "(default)"}`; infoContent.append(source); }
  info.append(infoButton, infoContent);
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
  const shortPath = path => path.split("/").filter(Boolean).pop() || "Choices";
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
  const focusOut = event => { if (!popup.hidden && event.relatedTarget && !row.contains(event.relatedTarget)) close(false); };
  row.addEventListener("focusout", focusOut);
  return {popup,search,open,close,refresh:update,dispose:()=>{ close(false); row.removeEventListener("focusout",focusOut); }};
}
