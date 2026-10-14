/* global acquireVsCodeApi */
const api = acquireVsCodeApi();
let revision = 0;
let blocked = false;
let frozenControls = [];
const selectionRequests = new Map();
let selectionRequestId = 0;
const send = (type, extra = {}) => api.postMessage({ type, revision, ...extra });
for (const action of ["save", "revert", "reconcile", "locale"]) document.getElementById(action).addEventListener("click", () => send(action));
window.addEventListener("message", event => {
  const state = event.data;
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
  let sectionName;
  let section;
  for (const field of state.fields) {
    if (sectionName !== field.section) {
      sectionName = field.section;
      section = document.createElement("section");
      const heading = document.createElement("h2"); heading.textContent = sectionName;
      section.append(heading); root.append(section);
    }
    const row = document.createElement("div"); row.className = "field";
    const label = document.createElement("label"); label.htmlFor = field.id; label.textContent = field.label;
    const meta = document.createElement("p"); meta.className = "meta";
    meta.textContent = `${field.name} · ${field.type} · ${field.scope.toLowerCase()} · ${field.source}${field.kind === "datetime" ? " · UTC (no local-time conversion)" : ""}`;
    row.append(label, meta);
    if (field.reason) {
      const reason = document.createElement("p"); reason.className = "meta"; reason.textContent = `Read-only: ${field.reason}`;
      const value = document.createElement("pre"); value.textContent = field.raw;
      row.append(reason, value);
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
      row.append(control);
      if (field.kind !== "checkbox") {
        const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
        clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
        clear.addEventListener("click", () => { control.value = ""; changed(true); });
        row.append(clear);
      }
    }
    section.append(row);
  }
});
function renderSelection(row, field) {
  // The canonical draft is separate from the choice list: loading/filtering never
  // changes it, including references absent from the current source.
  const stored = document.createElement("input"); stored.type = "hidden";
  stored.dataset.fieldId = field.id; stored.dataset.original = field.original;
  stored.dataset.explicitClear = String(field.clear); stored.value = field.clear ? "" : field.input;
  const current = document.createElement("p"); current.className = "selection-current";
  const label = document.createElement("p"); label.className = "meta";
  label.textContent = field.input ? "Current value not yet resolved; preserved until explicitly changed." : "No selection";
  const status = document.createElement("p"); status.className = "meta"; status.setAttribute("role", "status");
  const content = document.createElement("div"); content.className = "selection-choices";
  const choose = (value, name, clear = false) => {
    if (blocked) return;
    stored.value = value; stored.dataset.explicitClear = String(clear);
    current.textContent = `Stored value: ${value || "(empty)"}`;
    label.textContent = name;
    send("change", { id: field.id, input: value, clear });
    document.getElementById("status").textContent = "Unsaved changes";
  };
  current.textContent = `Stored value: ${stored.value || "(empty)"}`;
  const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
  clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
  clear.addEventListener("click", () => choose("", "Explicit empty selection", true));
  const reload = document.createElement("button"); reload.textContent = field.selectionKind === "droptree" ? "Browse choices…" : "Load choices…"; reload.disabled = blocked;
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
      select.addEventListener("click", () => choose(choice.value, `${choice.displayName || choice.name} · ${choice.path}`));
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
    const select = document.createElement("select"); select.size = 7; select.id = field.id; select.disabled = blocked;
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
    select.addEventListener("change", () => {
      const choice = page.choices.find(c => c.itemId === select.value);
      if (choice && !choice.disabled) choose(choice.value, `${choice.displayName || choice.name} · ${choice.path}`);
    });
    draw(); content.append(search, select);
    if (!page.choices.length) status.textContent = "No accessible choices. The current value is preserved.";
  };
  reload.addEventListener("click", () => {
    status.textContent = "Loading choices…"; content.replaceChildren();
    request(undefined, result => {
      if (result.error) { status.textContent = result.error; return; }
      status.textContent = `Source: ${result.page.root.path}`;
      // Resolving the original value must not overwrite feedback for a new draft.
      if (stored.value === field.original && stored.dataset.explicitClear !== "true") label.textContent = result.currentLabel;
      if (field.selectionKind === "droptree") showTree(content, result.page);
      else showList(result.page);
    });
  });
  row.append(stored, current, label, reload, clear, status, content);
}
send("ready");
