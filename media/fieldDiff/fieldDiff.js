const vscode = acquireVsCodeApi();

const state = {
  snapshot: undefined,
  loadingSelection: undefined,
  error: undefined,
  showStandardTemplate: false,
  differencesOnly: true,
  copyingFieldIds: new Set(),
};

const content = document.getElementById("content");
const showStandardTemplateInput = document.getElementById("show-standard-template");
const differencesOnlyInput = document.getElementById("differences-only");

function normalizeId(value) {
  return value.replace(/[{}-]/g, "").toLowerCase();
}

function fieldSource(field) {
  if (!field) return "missing";
  if (field.containsFallbackValue) return "fallback";
  if (field.containsInheritedValue) return "inherited";
  if (field.containsStandardValue) return "standard";
  return "stored";
}

function normalizedValue(value) {
  return state.snapshot?.textNormalization === "lineEndings"
    ? value.replace(/\r\n?|\n/g, "\n")
    : value;
}

function createPair(left, right) {
  const flags = [];
  if (!left) flags.push("Only right");
  else if (!right) flags.push("Only left");
  else {
    if (left.name !== right.name || left.label !== right.label) flags.push("Name");
    if (left.typeKey.toLowerCase() !== right.typeKey.toLowerCase()) flags.push("Type");
    if (left.scope !== right.scope) flags.push("Scope");
    if (normalizedValue(left.value) !== normalizedValue(right.value)) flags.push("Value");
    if (fieldSource(left) !== fieldSource(right)) flags.push("Source");
  }
  return {
    key: normalizeId(left?.fieldId ?? right.fieldId),
    left,
    right,
    flags,
    isStandardTemplate: (left?.isStandardTemplate ?? true) &&
      (right?.isStandardTemplate ?? true),
  };
}

function pairFields(leftFields, rightFields) {
  const rightById = new Map(rightFields.map((field) => [normalizeId(field.fieldId), field]));
  const used = new Set();
  const pairs = leftFields.map((left) => {
    const right = rightById.get(normalizeId(left.fieldId));
    if (right) used.add(right);
    return createPair(left, right);
  });
  for (const right of rightFields) {
    if (!used.has(right)) pairs.push(createPair(undefined, right));
  }
  return pairs;
}

function itemTitle(details, fallbackName, connectionName) {
  if (!details) return fallbackName ? `${fallbackName} (missing)` : "Missing item";
  const name = fallbackName || details.path.split("/").pop() || details.itemId;
  return `${name} · ${connectionName || "Connection"} · ${details.language}`;
}

function metaLine(details) {
  if (!details) return "Item does not exist on this side.";
  return `${details.path} · ${details.template.name} · latest version ${details.version}`;
}

function createSummary(snapshot) {
  const summary = document.createElement("section");
  summary.className = "summary paired-grid";
  for (const side of ["left", "right"]) {
    const details = snapshot[`${side}Details`];
    const cell = document.createElement("div");
    cell.className = `summary-cell ${side}`;
    const title = document.createElement("strong");
    title.textContent = itemTitle(
      details,
      snapshot[`${side}Name`],
      snapshot[`${side}ConnectionName`],
    );
    const meta = document.createElement("span");
    meta.textContent = metaLine(details);
    meta.title = details ? `Item ID: ${details.itemId}` : "";
    cell.append(title, meta);
    summary.append(cell);
    if (side === "left") summary.append(document.createElement("div"));
  }
  return summary;
}

function scopeMarker(field) {
  if (!field || field.scope === "VERSIONED") return undefined;
  const marker = document.createElement("span");
  marker.className = "badge scope";
  marker.textContent = field.scope === "SHARED" ? "S" : "U";
  marker.title = field.scope === "SHARED"
    ? "Shared across languages and versions"
    : "Unversioned: one value per language";
  return marker;
}

function createFieldCell(field, pair) {
  const cell = document.createElement("div");
  cell.className = "field-cell";
  if (!field) {
    cell.classList.add("missing");
    cell.textContent = "Missing";
    return cell;
  }
  const heading = document.createElement("div");
  heading.className = "field-heading";
  const name = document.createElement("strong");
  name.textContent = field.label || field.name;
  heading.append(name);
  const scope = scopeMarker(field);
  if (scope) heading.append(scope);
  if (field.isStandardTemplate && fieldSource(field) === "stored" && field.value) {
    const override = document.createElement("span");
    override.className = "badge override";
    override.textContent = "Override";
    override.title = "Populated local value on a Standard Template field";
    heading.append(override);
  }
  const metadata = document.createElement("div");
  metadata.className = "metadata";
  metadata.textContent = `${field.type} · ${field.scope.toLowerCase()} · ${fieldSource(field)}`;
  metadata.title = `Field ID: ${field.fieldId}${field.sectionName ? `\nSection: ${field.sectionName}` : ""}`;
  const value = document.createElement("pre");
  value.textContent = field.value || "(empty)";
  cell.append(heading, metadata, value);
  if (pair.flags.length && (pair.left?.textual || pair.right?.textual)) {
    cell.classList.add("diff-launch");
    cell.title = "Open this field in VS Code's text diff";
    cell.addEventListener("click", () => {
      vscode.postMessage({ type: "openTextDiff", fieldId: field.fieldId });
    });
  }
  return cell;
}

function createFieldRow(pair) {
  const row = document.createElement("section");
  row.className = `field-row paired-grid${pair.flags.length ? " different" : ""}`;
  const differences = document.createElement("div");
  differences.className = "differences";
  for (const flag of pair.flags) {
    const badge = document.createElement("span");
    badge.className = "badge difference";
    badge.textContent = flag;
    if (flag === "Value" && pair.left && pair.right) {
      const transfer = document.createElement("div");
      transfer.className = "value-transfer";
      const leftToRight = document.createElement("button");
      leftToRight.type = "button";
      leftToRight.className = "copy-value right";
      leftToRight.textContent = "→";
      leftToRight.title = "Copy the left value to the right";
      leftToRight.setAttribute("aria-label", "Copy the left field value to the right");
      const rightToLeft = document.createElement("button");
      rightToLeft.type = "button";
      rightToLeft.className = "copy-value left";
      rightToLeft.textContent = "←";
      rightToLeft.title = "Copy the right value to the left";
      rightToLeft.setAttribute("aria-label", "Copy the right field value to the left");
      const copying = state.copyingFieldIds.has(pair.key);
      leftToRight.disabled = copying;
      rightToLeft.disabled = copying;
      const copy = (direction) => {
        if (state.copyingFieldIds.has(pair.key)) return;
        state.copyingFieldIds.add(pair.key);
        render();
        vscode.postMessage({
          type: "copyFieldValue",
          fieldId: pair.left.fieldId,
          direction,
        });
      };
      leftToRight.addEventListener("click", () => copy("leftToRight"));
      rightToLeft.addEventListener("click", () => copy("rightToLeft"));
      transfer.append(leftToRight, badge, rightToLeft);
      differences.append(transfer);
    } else {
      differences.append(badge);
    }
  }
  row.append(createFieldCell(pair.left, pair), differences, createFieldCell(pair.right, pair));
  return row;
}

function render() {
  showStandardTemplateInput.checked = state.showStandardTemplate;
  differencesOnlyInput.checked = state.differencesOnly;
  if (state.error) {
    content.innerHTML = `<p class="state error"></p>`;
    content.firstElementChild.textContent = state.error;
    return;
  }
  if (state.loadingSelection) {
    content.innerHTML = `<p class="state">Loading field details…</p>`;
    return;
  }
  if (!state.snapshot) {
    content.innerHTML = `<p class="state">Right-click an item in the comparison and choose <strong>Show Detailed Field Diff</strong>.</p>`;
    return;
  }
  const pairs = pairFields(
    state.snapshot.leftDetails?.fields ?? [],
    state.snapshot.rightDetails?.fields ?? [],
  ).filter((pair) => {
    if (state.differencesOnly && !pair.flags.length) return false;
    return state.showStandardTemplate || !pair.isStandardTemplate || pair.flags.length;
  });
  const fragment = document.createDocumentFragment();
  fragment.append(createSummary(state.snapshot));
  if (!pairs.length) {
    const empty = document.createElement("p");
    empty.className = "state";
    empty.textContent = "No fields match the current filters.";
    fragment.append(empty);
  } else {
    for (const pair of pairs) fragment.append(createFieldRow(pair));
  }
  content.replaceChildren(fragment);
}

showStandardTemplateInput.addEventListener("change", () => {
  state.showStandardTemplate = showStandardTemplateInput.checked;
  render();
});
differencesOnlyInput.addEventListener("change", () => {
  state.differencesOnly = differencesOnlyInput.checked;
  render();
});
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "loading") {
    state.loadingSelection = message.selection;
    state.error = undefined;
  } else if (message?.type === "snapshot") {
    state.snapshot = message.snapshot;
    state.loadingSelection = undefined;
    state.error = undefined;
  } else if (message?.type === "error") {
    state.loadingSelection = undefined;
    state.error = message.message;
  } else if (message?.type === "clear") {
    state.snapshot = undefined;
    state.loadingSelection = undefined;
    state.error = undefined;
    state.copyingFieldIds.clear();
  } else if (message?.type === "copyFinished" && typeof message.fieldId === "string") {
    state.copyingFieldIds.delete(normalizeId(message.fieldId));
  }
  render();
});

render();
vscode.postMessage({ type: "ready" });
