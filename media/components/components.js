/* Host-owned identities only. This surface never edits field values. */
const api = acquireVsCodeApi();
const revision = Number(document.body.dataset.revision);
const workspace = document.getElementById("workspace");
const content = document.getElementById("detail-content");
const divider = document.getElementById("divider");
const expand = document.getElementById("expand");
const narrowLayout = matchMedia("(max-width:700px)");
let key, selection = -1, returnFocus, intent = 0;
const post = message => api.postMessage({ ...message, revision });
const state = api.getState() || {};
let width = Number.isFinite(state.width) ? Math.max(25, Math.min(75, state.width)) : 50;
function resize(value) {
  width = Math.max(25, Math.min(75, value));
  // CSSOM keeps dynamic sizing inside the nonce/local stylesheet policy.
  document.getElementById("pane-size").sheet.cssRules[0].style.setProperty("--tree-width", `${width}%`);
  divider.setAttribute("aria-valuenow", String(Math.round(width)));
  api.setState({ width });
}
resize(width);
divider.addEventListener("keydown", event => {
  const next = event.key === "ArrowLeft" ? width - 5 : event.key === "ArrowRight" ? width + 5 : event.key === "Home" ? 25 : event.key === "End" ? 75 : undefined;
  if (next !== undefined) { event.preventDefault(); resize(next); }
});
divider.addEventListener("pointerdown", event => { divider.setPointerCapture(event.pointerId); });
divider.addEventListener("pointermove", event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const bounds = workspace.getBoundingClientRect();
  resize((event.clientX - bounds.left) * 100 / bounds.width);
});
divider.addEventListener("pointerup", event => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); });
function setExpanded(expanded) {
  workspace.classList.toggle("expanded", expanded);
  expand.setAttribute("aria-pressed", String(expanded));
  const label = expanded ? "Restore split view" : "Expand details";
  expand.setAttribute("aria-label", label); expand.title = label;
}
function detailsAvailable(available) {
  expand.hidden = !available; expand.disabled = !available;
  if (!available) setExpanded(false);
}
function back() {
  workspace.classList.remove("show-details"); setExpanded(false);
  returnFocus?.focus();
}
document.getElementById("back").onclick = back;
const context = document.getElementById("layout-context");
document.addEventListener("click", event => { if (context?.open && !context.contains(event.target)) context.open = false; });
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (context?.open) { context.open = false; context.querySelector("summary").focus(); return; }
  if (workspace.classList.contains("expanded") || narrowLayout.matches) back();
});
narrowLayout.addEventListener("change", () => { if (narrowLayout.matches) setExpanded(false); });
expand.onclick = () => {
  if (expand.disabled || expand.hidden || narrowLayout.matches) return;
  setExpanded(!workspace.classList.contains("expanded"));
};
document.getElementById("refresh").onclick = () => post({ type: "load", language: document.getElementById("language").value });
document.getElementById("language").onchange = event => post({ type: "load", language: event.target.value });
document.querySelectorAll("[aria-controls][data-branch-label]").forEach(button => {
  button.onclick = () => {
    const expanded = button.getAttribute("aria-expanded") !== "true";
    document.getElementById(button.getAttribute("aria-controls")).hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} children of ${button.dataset.branchLabel}`);
  };
});
document.querySelectorAll("[data-component]").forEach(button => {
  button.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    key = button.dataset.component;
    selection = -1; returnFocus = button;
    document.querySelectorAll("[aria-pressed=true][data-component]").forEach(node => node.setAttribute("aria-pressed", "false"));
    button.setAttribute("aria-pressed", "true");
    workspace.classList.add("show-details");
    detailsAvailable(false);
    content.textContent = "Loading details…";
    document.getElementById("back").focus();
    if (!matchMedia("(max-width:700px)").matches && !workspace.classList.contains("expanded")) button.focus();
    post({ type: "select", key, intent: ++intent });
  };
});
const text = (tag, value, parent = content) => { const element = document.createElement(tag); element.textContent = value; parent.append(element); return element; };
const action = (label, type, parent, extra = {}) => {
  const button = text("button", label, parent);
  button.onclick = () => {
    if (type === "reference") detailsAvailable(false);
    post({ type, selection, ...extra, ...(type === "reference" ? { intent: ++intent } : {}) });
  };
  return button;
};
window.addEventListener("message", event => {
  if (event.source && (event.origin !== window.origin || [...document.querySelectorAll("iframe")].some(frame => frame.contentWindow === event.source))) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type !== "details" || data.revision !== revision || data.intent !== intent || data.key !== key || data.selection < selection) return;
  selection = data.selection; content.replaceChildren();
  detailsAvailable(Boolean(data.item) && !data.loading && !data.error);
  content.setAttribute("aria-busy", String(Boolean(data.loading)));
  if (data.instance) {
    text("h2", data.instance.name);
    const info = document.createElement("details"); content.append(info);
    text("summary", "Component instance", info);
    text("p", `Instance: ${data.instance.uid || "Unknown"}\nDeclared datasource: ${data.instance.datasource || "None"}\nPreview source locale: unknown`, info);
    text("pre", JSON.stringify(data.instance.parameters, null, 2), info);
    for (const issue of data.instance.issues || []) text("p", issue, info);
  }
  if (data.loading) { text("p", "Loading item fields…"); return; }
  if (data.error) { text("p", data.error); return; }
  const item = data.item;
  if (!item) return;
  text("h2", `${item.role}: ${item.name}`);
  text("p", `${data.connectionName} · Requested: ${item.requestedLanguage} · Authoring: ${item.returnedLanguage} v${item.version}\nField source locale: ${item.effectiveLanguage}\n${item.path}\nID: ${item.itemId}`);
  const actions = document.createElement("nav"); content.append(actions);
  action(`Reveal ${item.role.toLowerCase()} in Browse`, "reveal", actions).title = "Reveal the actual item in Browse (latest saved version).";
  const edit = action(`Edit ${item.role.toLowerCase()}`, "edit", actions); edit.disabled = !item.editable; edit.title = item.editReason;
  if (!item.version) text("p", "No exact-locale version exists. Preview fallback content is not substituted here.");
  if (item.references.length) {
    const refs = document.createElement("details"); refs.open = true; content.append(refs);
    text("summary", "Referenced items", refs);
    for (const reference of item.references) {
      const row = document.createElement("p"); refs.append(row);
      text("span", `${reference.field}: `, row);
      const button = action(reference.label, "reference", row, { key: reference.key });
      button.disabled = reference.unavailable;
      button.addEventListener("click", () => { content.setAttribute("aria-busy", "true"); });
    }
  }
  if (item.referencesLimited) text("p", "Only the first 100 distinct references are shown. This is not a complete reference graph.");
  if (!item.fields.length) text("p", "No fields returned for the requested locale.");
  let group, groupName;
  for (const field of item.fields) {
    if (field.section !== groupName) {
      groupName = field.section; group = document.createElement("details"); group.className = "field-group";
      group.open = !item.fields.filter(candidate => candidate.section === groupName).every(candidate => candidate.isStandardTemplate); content.append(group);
      text("summary", groupName, group);
    }
    const row = document.createElement("section"); row.className = "field"; group.append(row);
    text("h3", field.name, row);
    text("p", `${field.type} · ${field.scope} · ${field.provenance}`, row).className = "field-info";
    row.append(renderReadOnlyField(field));
  }
});
