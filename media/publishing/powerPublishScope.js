const vscode = acquireVsCodeApi();

const state = {
  model: undefined,
  selected: new Set(),
  expanded: new Set(),
  initialized: false,
};

const tree = document.getElementById("scope-tree");
const strategy = document.getElementById("strategy");
const selectedCount = document.getElementById("selected-count");
const itemCount = document.getElementById("item-count");
const referenceCount = document.getElementById("reference-count");
const unresolvedCount = document.getElementById("unresolved-count");
const publishingSummary = document.getElementById("publishing-summary");
const footerSummary = document.getElementById("footer-summary");
const error = document.getElementById("error");
const queue = document.getElementById("queue");
const cancel = document.getElementById("cancel");

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "scopeState") {
    state.model = message.state;
    if (!state.initialized) {
      state.initialized = true;
      state.selected.add(message.state.rootScopeId);
      state.expanded.add(message.state.rootScopeId);
    }
    render();
  } else if (message.type === "scanFailed") {
    showError(message.message);
  } else if (message.type === "validationError") {
    queue.disabled = false;
    showError(message.message);
  }
});

function render() {
  if (!state.model) return;
  clearError();
  const nodes = new Map(state.model.nodes.map((node) => [node.id, node]));
  const selectedNodes = state.model.nodes.filter((node) => state.selected.has(node.id));
  strategy.textContent = state.model.publishSubItemsThroughSitecore
    ? "Sitecore will publish structural descendants for every selected scope root."
    : "Every inspected item inside the selected collapsed scopes will be published explicitly.";
  selectedCount.textContent = String(selectedNodes.length);
  itemCount.textContent = String(
    selectedNodes.reduce((total, node) => total + node.inspectedItemCount, 0),
  );
  referenceCount.textContent = String(
    selectedNodes.reduce((total, node) => total + uniqueTargets(node).length, 0),
  );
  unresolvedCount.textContent = String(
    selectedNodes.reduce((total, node) => total + node.unresolvedReferences.length, 0),
  );

  tree.replaceChildren(
    renderNode(nodes.get(state.model.rootScopeId), nodes, new Set(), new Set()),
  );
  renderSummary(selectedNodes, nodes);
  const blocking = selectedNodes.filter((node) =>
    node.status !== "complete" ||
    node.unresolvedReferences.length > 0
  );
  queue.disabled = blocking.length > 0;
  footerSummary.textContent = blocking.length
    ? `${blocking.length} selected scope(s) still require attention`
    : `${selectedNodes.length} scope(s) ready to queue`;
}

function renderNode(node, nodes, ancestors, renderedNodes) {
  const wrapper = document.createElement("div");
  wrapper.className = "scope";
  if (!node) {
    wrapper.textContent = "Scope unavailable.";
    return wrapper;
  }
  const repeated = ancestors.has(node.id) || renderedNodes.has(node.id);
  if (!repeated) renderedNodes.add(node.id);
  const row = document.createElement("div");
  row.className = `scope-row status-${node.status}`;

  const children = uniqueTargets(node)
    .map((id) => nodes.get(id))
    .filter(Boolean);
  const canDiscover = isSelectable(node) &&
    (node.status === "notScanned" || node.status === "paused" || node.status === "failed");
  const canExpand = !repeated && (children.length > 0 || canDiscover);
  const expander = document.createElement("button");
  expander.type = "button";
  expander.className = "expander";
  expander.textContent = canExpand ? (state.expanded.has(node.id) ? "▼" : "▶") : "·";
  expander.disabled = !canExpand;
  expander.title = canDiscover
    ? "Scan and reveal references leaving this collapsed scope"
    : children.length
      ? "Show or hide outgoing references"
      : "No discovered external scopes";
  expander.addEventListener("click", () => {
    if (state.expanded.has(node.id)) state.expanded.delete(node.id);
    else state.expanded.add(node.id);
    if (canDiscover) {
      vscode.postMessage({ type: "scan", scopeId: node.id });
    }
    render();
  });

  const selection = document.createElement("input");
  selection.type = "checkbox";
  selection.checked = state.selected.has(node.id);
  selection.disabled = node.required || !isSelectable(node);
  selection.title = node.excludedReason || "Include this collapsed scope";
  selection.addEventListener("change", () => {
    if (selection.checked) {
      state.selected.add(node.id);
      state.expanded.add(node.id);
      if (node.status === "notScanned" || node.status === "paused" || node.status === "failed") {
        vscode.postMessage({ type: "scan", scopeId: node.id });
      }
    } else {
      state.selected.delete(node.id);
    }
    render();
  });

  const content = document.createElement("div");
  content.className = "scope-content";
  const heading = document.createElement("div");
  heading.className = "scope-heading";
  const name = document.createElement("strong");
  name.textContent = node.name;
  const badge = document.createElement("span");
  badge.className = `badge kind-${node.kind}`;
  badge.textContent = kindLabel(node.kind);
  heading.append(name, badge);
  const path = document.createElement("div");
  path.className = "path";
  path.textContent = node.path;
  path.title = node.path;
  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = statusText(node, repeated);
  content.append(heading, path, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "scan";
  action.textContent = node.status === "paused"
    ? "Continue scan"
    : node.status === "failed"
      ? "Retry scan"
      : "Scan";
  action.hidden = repeated || !isSelectable(node) ||
    node.status === "scanning" || node.status === "complete";
  action.addEventListener("click", () => {
    state.expanded.add(node.id);
    vscode.postMessage({ type: "scan", scopeId: node.id });
  });

  row.append(expander, selection, content, action);
  wrapper.append(row);

  if (state.expanded.has(node.id) && children.length && !repeated) {
    const branch = document.createElement("div");
    branch.className = "children";
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    for (const child of children) {
      branch.append(renderNode(child, nodes, nextAncestors, renderedNodes));
    }
    wrapper.append(branch);
  }
  return wrapper;
}

function uniqueTargets(node) {
  return [...new Set(node.outgoingReferences.map((reference) => reference.targetScopeId))];
}

function isSelectable(node) {
  return node.kind === "content" || node.kind === "media";
}

function statusText(node, repeated) {
  if (repeated) return "Already represented by an earlier branch.";
  if (node.excludedReason) return node.excludedReason;
  if (node.status === "notScanned") return "Not scanned.";
  if (node.status === "scanning") {
    return `Scanning… ${node.inspectedItemCount} item(s), ${node.resolvedReferenceCount} reference(s) resolved.`;
  }
  if (node.status === "paused") {
    return `${node.pauseReason || "Safety budget reached."} ${node.inspectedItemCount} item(s) inspected.`;
  }
  if (node.status === "failed") return node.error || "Scanning failed.";
  return `${node.inspectedItemCount} item(s) · ${node.internalReferenceCount} internal reference(s) · ${uniqueTargets(node).length} external scope(s).`;
}

function kindLabel(kind) {
  if (kind === "content") return "content";
  if (kind === "media") return "media";
  if (kind === "configuration") return "configuration";
  return "unsupported";
}

function renderSummary(selectedNodes, nodes) {
  publishingSummary.replaceChildren();
  const list = document.createElement("ul");
  const selectedReferences = selectedNodes.flatMap((node) =>
    node.outgoingReferences.filter((reference) => state.selected.has(reference.targetScopeId))
  );
  const mediaReferences = selectedReferences.filter((reference) =>
    reference.relationKind === "media"
  );
  const itemLinks = selectedReferences.filter((reference) =>
    reference.relationKind === "itemLink"
  );
  const datasourceReferences = selectedReferences.filter((reference) =>
    reference.relationKind === "layoutDatasource"
  );
  const referenceSummary = document.createElement("li");
  referenceSummary.textContent =
    `${datasourceReferences.length} selected layout datasource reference(s), ` +
    `${itemLinks.length} selected item link(s), and ${mediaReferences.length} selected media reference(s).`;
  list.append(referenceSummary);
  for (const node of selectedNodes) {
    const item = document.createElement("li");
    item.textContent =
      `${node.path} — ${node.inspectedItemCount} inspected item(s), ` +
      `${uniqueTargets(node).length} external scope(s)`;
    list.append(item);
  }
  const excluded = state.model.nodes.filter((node) =>
    !state.selected.has(node.id) && nodes.has(node.id)
  );
  if (excluded.length) {
    const item = document.createElement("li");
    item.textContent = `${excluded.length} discovered external scope(s) excluded.`;
    list.append(item);
  }
  const externalLinks = selectedNodes.flatMap((node) => node.externalLinks);
  if (externalLinks.length) {
    const item = document.createElement("li");
    item.textContent = `${externalLinks.length} external URL(s) recorded as evidence.`;
    list.append(item);
  }
  publishingSummary.append(list);
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
queue.addEventListener("click", () => {
  queue.disabled = true;
  vscode.postMessage({
    type: "submit",
    selectedScopeIds: [...state.selected],
  });
});

vscode.postMessage({ type: "ready" });
