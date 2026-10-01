const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const textFields = ["name", "serverUrl", "clientId", "deploymentClientId", "deploymentEnvironmentId", "edgeEndpoint", "siteName", "applicationBaseUrl", "publicTemplate", "defaultSite"];
const secretNames = { clientSecret: "Client secret", deploymentSecret: "Organization client secret", edgeToken: "Experience Edge token" };
const simpleSecrets = new Set(["clientSecret", "deploymentSecret"]);
let storedSecrets = {};
function secretAction(id) { return simpleSecrets.has(id) ? (get(id).value ? "replace" : "keep") : get(`${id}-action`).value; }
let sites = [];
let isNew = true;
let busy = false;
for (const [id, title] of Object.entries(secretNames)) {
  const root = document.querySelector(`[data-secret="${id}"]`);
  const label = document.createElement("label"); label.textContent = title;
  if (simpleSecrets.has(id)) {
    root.classList.add("simple-secret");
    const input = document.createElement("input"); input.type = "password"; input.id = id; input.autocomplete = "new-password";
    const stored = document.createElement("small"); stored.id = `${id}-stored`;
    const error = document.createElement("span"); error.className = "error"; error.id = `${id}-error`;
    input.setAttribute("aria-describedby", `${stored.id} ${error.id}`);
    label.append(input, stored, error); root.append(label);
    continue;
  }
  const select = document.createElement("select"); select.id = `${id}-action`;
  for (const [value, text] of [["keep", "Keep stored value"], ["replace", "Replace"], ["remove", "Remove on Save"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option);
  }
  const stored = document.createElement("small"); stored.id = `${id}-stored`;
  label.append(select, stored);
  const replacement = document.createElement("label"); replacement.textContent = `New ${title.toLowerCase()}`;
  const input = document.createElement("input"); input.type = "password"; input.id = id; input.autocomplete = "new-password";
  const error = document.createElement("span"); error.className = "error"; error.id = `${id}-error`; input.setAttribute("aria-describedby", error.id);
  replacement.append(input, error); root.append(label, replacement);
  select.addEventListener("change", () => { input.disabled = select.value !== "replace"; if (input.disabled) input.value = ""; });
}
for (const error of document.querySelectorAll(".error[id]")) { const input = get(error.id.replace(/-error$/, "")); if (input && !input.hasAttribute("aria-describedby")) input.setAttribute("aria-describedby", error.id); }
function setDirty(value) { get("dirty").textContent = value ? "Unsaved changes" : "No unsaved changes"; }
function saveSite() {
  const site = sites.find(row => row.name === get("sitePicker").value);
  if (site) { site.publicBaseUrl = get("publicBaseUrl").value; site.deploymentBaseUrl = get("deploymentBaseUrl").value; }
}
function showSite() {
  const site = sites.find(row => row.name === get("sitePicker").value);
  for (const key of ["publicBaseUrl", "deploymentBaseUrl"]) { get(key).value = site?.[key] ?? ""; get(key).disabled = !site; }
  get("site-empty").hidden = sites.length > 0;
}
function renderSites() {
  const selected = get("sitePicker").value;
  const defaultSite = get("defaultSite").value;
  for (const id of ["sitePicker", "defaultSite", "siteNames"]) {
    const select = get(id); select.replaceChildren();
    if (id === "defaultSite") { const empty = document.createElement("option"); empty.value = ""; empty.textContent = "No default"; select.append(empty); }
    for (const site of sites) { const option = document.createElement("option"); option.value = site.name; option.textContent = site.name; select.append(option); }
  }
  if (sites.some(row => row.name === selected)) get("sitePicker").value = selected;
  get("defaultSite").value = defaultSite;
  showSite();
}
function values() {
  saveSite();
  const result = Object.fromEntries(textFields.map(id => [id, get(id).value]));
  for (const id of ["deploymentEnabled", "publishingEnabled"]) result[id] = get(id).checked;
  for (const id of Object.keys(secretNames)) result[id] = { action: secretAction(id), value: get(id).value };
  result.sites = sites;
  return result;
}
function errors(items) {
  document.querySelectorAll(".error").forEach(node => { node.textContent = ""; });
  document.querySelectorAll("[aria-invalid]").forEach(node => node.removeAttribute("aria-invalid"));
  get("form-error").textContent = "";
  for (const [key, message] of Object.entries(items)) {
    (get(`${key}-error`) ?? get("form-error")).textContent = message;
    get(key)?.setAttribute("aria-invalid", "true");
  }
  const first = Object.keys(items)[0];
  if (first) { (get(first) ?? get("form-error")).scrollIntoView({ block: "center" }); get(first)?.focus(); }
}
function localErrors(type) {
  const result = {};
  for (const id of ["name", "clientId", "serverUrl"]) if (!get(id).value.trim()) result[id] = "This field is required.";
  try { const url = new URL(get("serverUrl").value); if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(); }
  catch { result.serverUrl = "Enter an HTTPS CM origin, for example https://example.sitecorecloud.io."; }
  if ((isNew || (type === "connection" && !storedSecrets.clientSecret)) && !get("clientSecret").value.trim()) result.clientSecret = "Enter a client secret.";
  if (type === "save") {
    for (const id of Object.keys(secretNames)) if (secretAction(id) === "replace" && !get(id).value.trim()) result[id] = "Enter a replacement secret.";
  }
  return result;
}
function setBusy(value, cancellable = false) {
  busy = value; get("fields").disabled = value;
  for (const id of ["save", "cancel", "reload"]) get(id).disabled = value;
  get("stop").hidden = !value || !cancellable;
}
function request(type) {
  if (busy) return;
  const invalid = localErrors(type); errors(invalid); if (Object.keys(invalid).length) return;
  const input = values(); setBusy(true, type !== "save");
  get("status").textContent = type === "save" ? "Validating and saving…" : "Testing…";
  vscode.postMessage({ type, values: input });
}
get("settings").addEventListener("input", () => setDirty(true));
get("settings").addEventListener("change", () => setDirty(true));
get("settings").addEventListener("submit", event => { event.preventDefault(); request("save"); });
get("sitePicker").addEventListener("change", showSite);
for (const key of ["publicBaseUrl", "deploymentBaseUrl"]) get(key).addEventListener("input", saveSite);
get("addSite").addEventListener("click", () => {
  const name = get("newSite").value.trim();
  if (!name || sites.some(site => site.name === name) || ["__proto__", "constructor", "prototype"].includes(name)) { errors({ sites: "Enter a unique site name." }); return; }
  saveSite(); sites.push({ name, publicBaseUrl: "", deploymentBaseUrl: "" }); renderSites(); get("sitePicker").value = name; showSite(); get("newSite").value = ""; setDirty(true);
});
document.querySelectorAll("[data-test]").forEach(button => button.addEventListener("click", () => request(button.dataset.test)));
get("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
get("reload").addEventListener("click", () => { setBusy(true); vscode.postMessage({ type: "reload" }); });
get("stop").addEventListener("click", () => vscode.postMessage({ type: "cancelOperation" }));
window.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "initialize") {
    isNew = message.isNew; storedSecrets = message.stored; sites = message.values.sites; renderSites();
    for (const id of textFields) get(id).value = message.values[id] ?? "";
    for (const id of ["deploymentEnabled", "publishingEnabled"]) get(id).checked = message.values[id];
    for (const id of Object.keys(secretNames)) {
      get(id).value = "";
      if (simpleSecrets.has(id)) {
        get(id).disabled = false;
        get(id).placeholder = message.stored[id] ? "Leave empty to keep stored secret" : "Enter client secret";
        get(`${id}-stored`).textContent = message.stored[id] ? "A secret is stored. Enter a new value to replace it on Save; leave empty to keep it." : "No secret stored.";
        continue;
      }
      get(`${id}-action`).value = "keep";
      get(`${id}-stored`).textContent = message.stored[id] ? "A secret is stored. Its value is never sent to this form." : "No secret stored. Choose Replace to enter one.";
      get(id).disabled = true;
    }
    get("title").textContent = isNew ? "Add Connection" : message.values.name;
    get("save").textContent = isNew ? "Add connection" : "Save changes";
    get("status").textContent = "Tests do not save changes. Use Save when ready."; errors({}); setDirty(false);
    get(message.section)?.scrollIntoView();
  } else if (message.type === "sites") {
    saveSite(); for (const name of message.sites) if (!sites.some(site => site.name === name)) sites.push({ name, publicBaseUrl: "", deploymentBaseUrl: "" }); renderSites();
  } else if (message.type === "environment") { get("deploymentEnvironmentId").value = message.environmentId; setDirty(true); get("status").textContent = "Environment matched. Nothing saved yet."; }
  else if (message.type === "edgeSites") get("edge-sites").textContent = `Accessible sites: ${message.sites.join(", ")}`;
  else if (message.type === "errors") { errors(message.errors); get("status").textContent = "Review the errors below."; }
  else if (message.type === "status") get("status").textContent = message.text;
  else if (message.type === "focus") get(message.section)?.scrollIntoView();
  else if (message.type === "idle") setBusy(false);
});
// Drafts, particularly secrets, are intentionally not written to webview state.
vscode.postMessage({ type: "ready" });
