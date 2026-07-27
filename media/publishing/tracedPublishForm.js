const vscode = acquireVsCodeApi();

const state = {
  initial: undefined,
  fields: [],
  descendantsLoaded: false,
  descendantsLoading: false,
  routeTouched: false,
};
const maximumFieldSuggestions = 250;

const context = document.getElementById("context");
const mode = document.getElementById("mode");
const descendants = document.getElementById("descendants");
const related = document.getElementById("related");
const site = document.getElementById("site");
const manualSite = document.getElementById("manual-site");
const route = document.getElementById("route");
const applicationUrl = document.getElementById("application-url");
const fieldPicker = document.getElementById("field-picker");
const fieldOptions = document.getElementById("field-options");
const addField = document.getElementById("add-field");
const fieldStatus = document.getElementById("field-status");
const fields = document.getElementById("fields");
const error = document.getElementById("error");
const summary = document.getElementById("summary");
const publish = document.getElementById("publish");
const cancel = document.getElementById("cancel");

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "initialize":
      initialize(message.state);
      break;
    case "descendantsLoaded":
      state.descendantsLoading = false;
      state.descendantsLoaded = true;
      mergeFields(message.fields);
      renderFields();
      updateSummary();
      break;
    case "descendantsFailed":
      state.descendantsLoading = false;
      descendants.checked = false;
      showError(`Unable to load descendant fields: ${message.message}`);
      renderFields();
      updateSummary();
      break;
    case "validationError":
      publish.disabled = false;
      showError(message.message);
      break;
  }
});

function initialize(initial) {
  state.initial = initial;
  state.fields = initial.fields.map(toFieldState);
  context.textContent =
    `${initial.connectionName} (${initial.targetHost}) · ${initial.language} · ${initial.rootPath}`;
  applicationUrl.value = initial.applicationUrl || "";
  renderSites(initial);
  route.value = initial.route || "";
  renderFields();
  updateSummary();
}

function renderSites(initial) {
  site.replaceChildren();
  if (initial.sites.length === 0) {
    site.hidden = true;
    manualSite.hidden = false;
    manualSite.value = initial.selectedSiteName || "";
    return;
  }
  site.hidden = false;
  manualSite.hidden = true;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a verified site";
  site.append(placeholder);
  for (const candidate of initial.sites) {
    const option = document.createElement("option");
    option.value = candidate.name;
    option.textContent = candidate.rootPath
      ? `${candidate.name} — ${candidate.rootPath}`
      : candidate.name;
    site.append(option);
  }
  site.value = initial.selectedSiteName || (
    initial.sites.length === 1 ? initial.sites[0].name : ""
  );
}

function mergeFields(incoming) {
  const existing = new Map(state.fields.map((field) => [field.key, field]));
  for (const candidate of incoming) {
    if (!existing.has(candidate.key)) {
      state.fields.push(toFieldState(candidate));
    }
  }
}

function toFieldState(candidate) {
  return {
    ...candidate,
    selected: false,
    browserSelector: "",
  };
}

function renderFields() {
  fields.replaceChildren();
  if (!state.initial) {
    return;
  }
  const routeAvailable = Boolean(selectedSiteName() && route.value.trim());
  const applicationAvailable = Boolean(applicationUrl.value.trim());
  const available = availableFields();
  const selectedFields = available.filter((field) => field.selected);
  renderFieldOptions(routeAvailable);
  fieldStatus.textContent = fieldStatusText(selectedFields.length, available.length);
  if (selectedFields.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = available.length
      ? "No field assertions selected. Choose a field above and select Add field."
      : "No non-standard fields are available in the selected publish scope.";
    fields.append(empty);
    return;
  }
  for (const field of selectedFields) {
    const row = document.createElement("div");
    row.className = "field-row";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-field";
    remove.textContent = "×";
    remove.title = `Remove ${field.itemName}, ${field.fieldName}`;
    remove.ariaLabel = remove.title;
    remove.addEventListener("click", () => {
      field.selected = false;
      field.browserSelector = "";
      renderFields();
      updateSummary();
    });

    const name = document.createElement("div");
    name.className = "field-name";
    const strong = document.createElement("strong");
    strong.textContent = `${field.itemName} › ${field.fieldName}`;
    const path = document.createElement("span");
    path.textContent = field.itemPath;
    path.title = field.itemPath;
    name.append(strong, path);

    const value = document.createElement("div");
    value.className = "value";
    value.textContent = field.value || "(empty)";
    value.title = field.value;

    const selectorWrap = document.createElement("div");
    selectorWrap.className = "selector-wrap";
    const selectorLabel = document.createElement("label");
    selectorLabel.textContent = applicationAvailable
      ? "Browser DOM CSS selector"
      : "Browser DOM CSS selector · requires application URL";
    const selector = document.createElement("input");
    selector.type = "text";
    selector.placeholder = "[data-testid=\"heading\"]";
    selector.value = field.browserSelector;
    selector.addEventListener("input", () => {
      field.browserSelector = selector.value;
      updateSummary();
    });
    selectorWrap.append(selectorLabel, selector);
    row.append(remove, name, value, selectorWrap);
    fields.append(row);
  }
}

function availableFields() {
  return state.fields.filter((field) => !field.descendant || descendants.checked);
}

function fieldPickerValue(field) {
  return `${field.itemName} › ${field.fieldName} — ${field.itemPath}`;
}

function fieldSearchText(field) {
  return [
    field.itemName,
    field.itemPath,
    field.fieldName,
    field.value,
  ].join(" ").toLocaleLowerCase();
}

function renderFieldOptions(routeAvailable) {
  const query = fieldPicker.value.trim().toLocaleLowerCase();
  const suggestions = availableFields()
    .filter((field) => !field.selected)
    .filter((field) => !query || fieldSearchText(field).includes(query))
    .slice(0, maximumFieldSuggestions);
  fieldOptions.replaceChildren();
  for (const field of suggestions) {
    const option = document.createElement("option");
    option.value = fieldPickerValue(field);
    option.label = field.value;
    fieldOptions.append(option);
  }
  fieldPicker.disabled = !routeAvailable;
  addField.disabled = !routeAvailable || !fieldForPickerValue(fieldPicker.value);
}

function fieldForPickerValue(value) {
  const normalized = value.trim();
  return availableFields().find((field) =>
    !field.selected && fieldPickerValue(field) === normalized
  );
}

function addSelectedField() {
  const field = fieldForPickerValue(fieldPicker.value);
  if (!field) {
    return;
  }
  field.selected = true;
  fieldPicker.value = "";
  clearError();
  renderFields();
  updateSummary();
  fieldPicker.focus();
}

function fieldStatusText(selectedCount, total) {
  if (state.descendantsLoading) {
    return "Loading structural descendant fields…";
  }
  if (descendants.checked && !state.descendantsLoaded) {
    return "Structural descendant fields have not been loaded.";
  }
  return `${selectedCount} selected from ${total} available field(s).`;
}

function selectedSiteName() {
  return site.hidden ? manualSite.value.trim() : site.value;
}

function suggestedRoute(siteName) {
  return state.initial?.sites.find((candidate) => candidate.name === siteName)?.suggestedRoute || "";
}

function updateSummary() {
  const selected = state.fields.filter((field) =>
    field.selected && (!field.descendant || descendants.checked)
  );
  const selectors = selected.filter((field) => field.browserSelector.trim()).length;
  const scopes = [
    descendants.checked ? "descendants" : "",
    related.checked ? "related items" : "",
  ].filter(Boolean).join(", ") || "selected item only";
  summary.textContent =
    `${mode.value === "SMART" ? "Smart" : "Full"} · ${scopes} · ${selected.length} assertion(s) · ${selectors} DOM selector(s)`;
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  error.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

descendants.addEventListener("change", () => {
  clearError();
  if (descendants.checked && !state.descendantsLoaded && !state.descendantsLoading) {
    state.descendantsLoading = true;
    fieldStatus.textContent = "Loading structural descendant fields…";
    vscode.postMessage({ type: "loadDescendants" });
  }
  if (!descendants.checked) {
    for (const field of state.fields.filter((candidate) => candidate.descendant)) {
      field.selected = false;
      field.browserSelector = "";
    }
  }
  renderFields();
  updateSummary();
});

site.addEventListener("change", () => {
  if (!state.routeTouched) {
    route.value = suggestedRoute(site.value);
  }
  renderFields();
});

manualSite.addEventListener("input", () => {
  clearError();
  renderFields();
});
route.addEventListener("input", () => {
  state.routeTouched = true;
  renderFields();
});
applicationUrl.addEventListener("input", renderFields);
fieldPicker.addEventListener("input", () => renderFieldOptions(
  Boolean(selectedSiteName() && route.value.trim()),
));
fieldPicker.addEventListener("change", () => renderFieldOptions(
  Boolean(selectedSiteName() && route.value.trim()),
));
fieldPicker.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && fieldForPickerValue(fieldPicker.value)) {
    event.preventDefault();
    addSelectedField();
  }
});
addField.addEventListener("click", addSelectedField);
mode.addEventListener("change", updateSummary);
related.addEventListener("change", updateSummary);

cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
publish.addEventListener("click", () => {
  clearError();
  if (descendants.checked && state.descendantsLoading) {
    showError("Wait for descendant fields to finish loading.");
    return;
  }
  if (state.initial.sites.length > 0 && !selectedSiteName()) {
    showError("Select or enter the Sitecore site used for route verification.");
    return;
  }
  if (applicationUrl.value.trim()) {
    try {
      const parsed = new URL(applicationUrl.value.trim());
      if (parsed.protocol !== "https:") {
        throw new Error();
      }
    } catch {
      showError("Enter a valid HTTPS application URL.");
      return;
    }
  }
  if (
    !applicationUrl.value.trim() &&
    state.fields.some((field) =>
      field.selected &&
      (!field.descendant || descendants.checked) &&
      field.browserSelector.trim()
    )
  ) {
    showError("Enter the exact application URL before publishing Browser DOM selectors.");
    applicationUrl.focus();
    return;
  }
  publish.disabled = true;
  vscode.postMessage({
    type: "submit",
    mode: mode.value,
    publishSubItems: descendants.checked,
    publishRelatedItems: related.checked,
    siteName: selectedSiteName(),
    route: route.value,
    applicationUrl: applicationUrl.value,
    fields: state.fields
      .filter((field) => field.selected && (!field.descendant || descendants.checked))
      .map((field) => ({
        key: field.key,
        browserSelector: field.browserSelector,
      })),
  });
});

vscode.postMessage({ type: "ready" });
