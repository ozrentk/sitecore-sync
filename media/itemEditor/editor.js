/* global acquireVsCodeApi */
const api = acquireVsCodeApi();
let revision = 0;
let blocked = false;
let frozenControls = [];
const send = (type, extra = {}) => api.postMessage({ type, revision, ...extra });
for (const action of ["save", "revert", "reconcile", "locale"]) document.getElementById(action).addEventListener("click", () => send(action));
window.addEventListener("message", event => {
  const state = event.data;
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
    frozenControls = [...document.querySelectorAll("input, textarea, button")].map(control => [control, control.disabled]);
    for (const [control] of frozenControls) control.disabled = true;
    api.postMessage({ type: "frozen", id: state.id, drafts });
    return;
  }
  if (state.type !== "state") return;
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
      const clear = document.createElement("button"); clear.textContent = "Clear"; clear.disabled = blocked;
      clear.title = "Store an explicit empty value; does not reset to inherited or Standard Values";
      clear.addEventListener("click", () => { control.value = ""; control.checked = false; changed(true); });
      row.append(control, clear);
    }
    section.append(row);
  }
});
send("ready");
