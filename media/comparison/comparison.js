const vscode = acquireVsCodeApi();

function emptyTreeState(connectionId) {
  return {
    connectionId,
    root: undefined,
    loading: false,
    error: undefined,
  };
}

const state = {
  connections: [],
  selection: {},
  trees: {
    left: emptyTreeState(undefined),
    right: emptyTreeState(undefined),
  },
  expandedRows: new Set(),
  selectedRowKey: undefined,
  rootRowKey: undefined,
  loadedItems: {
    left: new Map(),
    right: new Map(),
  },
};

const leftSelect = document.getElementById("left-connection");
const rightSelect = document.getElementById("right-connection");
const swapButton = document.getElementById("swap");
const workspace = document.getElementById("workspace");

function normalizeItemId(itemId) {
  return itemId.replace(/[{}-]/g, "").toLowerCase();
}

function connectionById(id) {
  return state.connections.find((connection) => connection.id === id);
}

function renderOptions(select, selectedId) {
  select.replaceChildren();
  if (!state.connections.length) {
    const option = document.createElement("option");
    option.textContent = "No connections configured";
    option.value = "";
    select.append(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const connection of state.connections) {
    const option = document.createElement("option");
    option.value = connection.id;
    option.textContent = connection.name;
    option.selected = connection.id === selectedId;
    select.append(option);
  }
}

function createButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "primary";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function requestRoot(side) {
  const connectionId = state.trees[side].connectionId;
  if (connectionId) {
    vscode.postMessage({ type: "loadRoot", side, connectionId });
  }
}

function requestChildren(side, node) {
  const connectionId = state.trees[side].connectionId;
  if (connectionId) {
    node.loading = true;
    node.error = undefined;
    vscode.postMessage({ type: "loadChildren", side, connectionId, itemId: node.itemId });
  }
}

function createTreeNode(item) {
  return {
    ...item,
    children: [],
    childrenLoaded: false,
    loading: false,
    error: undefined,
  };
}

function findNode(node, itemId) {
  if (!node) {
    return undefined;
  }
  if (normalizeItemId(node.itemId) === normalizeItemId(itemId)) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, itemId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function indexLoadedItems(node, index) {
  if (!node) {
    return;
  }
  index.set(normalizeItemId(node.itemId), node);
  for (const child of node.children) {
    indexLoadedItems(child, index);
  }
}

function refreshLoadedItemIndexes() {
  const left = new Map();
  const right = new Map();
  indexLoadedItems(state.trees.left.root, left);
  indexLoadedItems(state.trees.right.root, right);
  state.loadedItems = { left, right };
}

function createPair(left, right, relationship = "identity") {
  const leftId = left ? normalizeItemId(left.itemId) : undefined;
  const rightId = right ? normalizeItemId(right.itemId) : undefined;
  const sameId = leftId !== undefined && leftId === rightId;
  const flags = [];

  if (!left) {
    flags.push("onlyRight");
  } else if (!right) {
    flags.push("onlyLeft");
  } else if (!sameId) {
    flags.push("onlyLeft", "onlyRight", "idMismatch");
  } else {
    if (left.path !== right.path) {
      flags.push("pathMismatch");
    }
    if (left.name !== right.name || left.displayName !== right.displayName) {
      flags.push("nameMismatch");
    }
    if (left.hasChildren !== right.hasChildren) {
      flags.push("childPresenceMismatch");
    }
  }

  const key = relationship === "root"
    ? `root:${leftId ?? "missing"}:${rightId ?? "missing"}`
    : sameId
      ? `id:${leftId}`
      : left && right
        ? `path:${left.path}:${leftId}:${rightId}`
        : left
          ? `left:${leftId}`
          : `right:${rightId}`;

  return { key, left, right, flags };
}

function pairChildren(leftChildren, rightChildren) {
  const rightById = new Map(
    rightChildren.map((item) => [normalizeItemId(item.itemId), item]),
  );
  const usedRight = new Set();
  const rows = [];

  for (const left of leftChildren) {
    const normalizedId = normalizeItemId(left.itemId);
    const right = rightById.get(normalizedId) ?? state.loadedItems.right.get(normalizedId);
    if (right) {
      usedRight.add(right);
    }
    rows.push(createPair(left, right));
  }

  const unmatchedRightByPath = new Map();
  for (const right of rightChildren) {
    if (
      !usedRight.has(right) &&
      !state.loadedItems.left.has(normalizeItemId(right.itemId))
    ) {
      const matches = unmatchedRightByPath.get(right.path) ?? [];
      matches.push(right);
      unmatchedRightByPath.set(right.path, matches);
    }
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.right || !row.left) {
      continue;
    }
    const pathMatches = unmatchedRightByPath.get(row.left.path);
    const right = pathMatches?.shift();
    if (right) {
      usedRight.add(right);
      rows[index] = createPair(row.left, right, "pathConflict");
    }
  }

  const rowByRight = new Map();
  for (const row of rows) {
    if (row.right) {
      rowByRight.set(row.right, row);
    }
  }

  for (let rightIndex = 0; rightIndex < rightChildren.length; rightIndex += 1) {
    const right = rightChildren[rightIndex];
    if (
      usedRight.has(right) ||
      state.loadedItems.left.has(normalizeItemId(right.itemId))
    ) {
      continue;
    }

    const row = createPair(undefined, right);
    let nextKnownRow;
    for (let nextIndex = rightIndex + 1; nextIndex < rightChildren.length; nextIndex += 1) {
      nextKnownRow = rowByRight.get(rightChildren[nextIndex]);
      if (nextKnownRow) {
        break;
      }
    }

    if (nextKnownRow) {
      rows.splice(rows.indexOf(nextKnownRow), 0, row);
    } else {
      rows.push(row);
    }
    rowByRight.set(right, row);
  }

  return rows;
}

function pairCanExpand(pair) {
  return pair.left?.hasChildren === true || pair.right?.hasChildren === true;
}

function nodeReady(node) {
  return !node || !node.hasChildren || node.childrenLoaded || Boolean(node.error);
}

function pairReady(pair) {
  return nodeReady(pair.left) && nodeReady(pair.right);
}

function pairLoading(pair) {
  return pair.left?.loading === true || pair.right?.loading === true;
}

function pairHasError(pair) {
  return Boolean(pair.left?.error || pair.right?.error);
}

function loadMissingPairLevels(pair) {
  for (const side of ["left", "right"]) {
    const node = pair[side];
    if (node?.hasChildren && !node.childrenLoaded && !node.loading && !node.error) {
      requestChildren(side, node);
    }
  }
}

function createConnectionIdentity(side) {
  const connectionId = state.selection[`${side}ConnectionId`];
  const connection = connectionById(connectionId);
  const identity = document.createElement("div");
  identity.className = "column-identity";
  const name = document.createElement("div");
  name.className = "column-name";
  name.textContent = connection?.name ?? `${side} connection`;
  const url = document.createElement("div");
  url.className = "column-url";
  url.textContent = connection?.serverUrl ?? "No connection selected";
  url.title = connection?.serverUrl ?? "";
  identity.append(name, url);
  return identity;
}

function createRootStatus(side) {
  const tree = state.trees[side];
  const status = document.createElement("div");
  status.className = "root-status";
  if (tree.error) {
    const message = document.createElement("span");
    message.className = "error-text";
    message.textContent = tree.error;
    status.append(message, createButton("Retry", () => requestRoot(side)));
  } else if (tree.loading) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    status.append(spinner, document.createTextNode("Loading content tree…"));
  } else if (tree.root) {
    status.textContent = "Ready";
  } else {
    status.textContent = "Waiting to load content tree…";
  }
  return status;
}

const flagPresentation = {
  onlyLeft: { label: "L", title: "Item exists only on the left by ID" },
  onlyRight: { label: "R", title: "Item exists only on the right by ID" },
  idMismatch: { label: "ID", title: "The same path has different item IDs" },
  pathMismatch: { label: "PATH", title: "The same item ID has different paths" },
  nameMismatch: { label: "NAME", title: "The item name or display name differs" },
  childPresenceMismatch: { label: "TREE", title: "Child presence differs" },
};

function createDifferenceBadges(flags) {
  const badges = document.createElement("span");
  badges.className = "difference-badges";
  for (const flag of flags) {
    const presentation = flagPresentation[flag];
    const badge = document.createElement("span");
    badge.className = `difference-badge ${flag}`;
    badge.textContent = presentation.label;
    badge.title = presentation.title;
    badges.append(badge);
  }
  return badges;
}

function createItemCell(node, side, pair, depth) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = `comparison-cell ${side}`;
  cell.style.setProperty("--tree-depth", String(depth));
  cell.addEventListener("click", () => {
    state.selectedRowKey = pair.key;
    render();
  });

  if (!node) {
    cell.classList.add("missing");
    cell.textContent = "—";
    cell.title = `Item is missing on the ${side}.`;
    return cell;
  }

  cell.title = `${node.path}\nItem ID: ${node.itemId}`;
  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = node.displayName || node.name;
  const path = document.createElement("span");
  path.className = "item-path";
  path.textContent = node.path;
  cell.append(name, path);
  return cell;
}

function createRowControl(pair) {
  const control = document.createElement("div");
  control.className = "row-control";
  const disclosure = document.createElement("button");
  disclosure.className = "paired-disclosure";
  disclosure.type = "button";

  if (pairCanExpand(pair)) {
    const expanded = state.expandedRows.has(pair.key);
    disclosure.textContent = pairLoading(pair) ? "" : expanded ? "▾" : "▸";
    disclosure.title = expanded ? "Collapse both sides" : "Expand both sides";
    disclosure.setAttribute("aria-label", disclosure.title);
    disclosure.setAttribute("aria-expanded", String(expanded));
    if (pairLoading(pair)) {
      disclosure.classList.add("loading");
    }
    disclosure.addEventListener("click", () => {
      if (expanded) {
        state.expandedRows.delete(pair.key);
      } else {
        state.expandedRows.add(pair.key);
        loadMissingPairLevels(pair);
      }
      render();
    });
  } else {
    disclosure.disabled = true;
    disclosure.setAttribute("aria-hidden", "true");
  }

  control.append(disclosure, createDifferenceBadges(pair.flags));
  return control;
}

function createInlineSideStatus(side, node) {
  const status = document.createElement("div");
  status.className = `inline-side-status ${side}`;
  if (!node || !node.hasChildren || node.childrenLoaded) {
    return status;
  }
  if (node.error) {
    const error = document.createElement("span");
    error.className = "error-text";
    error.textContent = node.error;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      requestChildren(side, node);
      render();
    });
    status.append(error, retry);
  } else {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    status.append(spinner, document.createTextNode("Loading children…"));
  }
  return status;
}

function renderPair(pair, depth) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement("div");
  row.className = "comparison-row";
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  if (pair.flags.length) {
    row.classList.add("different");
  } else {
    row.classList.add("same");
  }
  if (state.selectedRowKey === pair.key) {
    row.classList.add("selected");
  }
  row.append(
    createItemCell(pair.left, "left", pair, depth),
    createRowControl(pair),
    createItemCell(pair.right, "right", pair, depth),
  );
  fragment.append(row);

  if (!state.expandedRows.has(pair.key)) {
    return fragment;
  }

  loadMissingPairLevels(pair);
  if (!pairReady(pair) || pairHasError(pair)) {
    const statusRow = document.createElement("div");
    statusRow.className = "comparison-inline-status";
    statusRow.append(
      createInlineSideStatus("left", pair.left),
      document.createElement("div"),
      createInlineSideStatus("right", pair.right),
    );
    fragment.append(statusRow);
    return fragment;
  }

  const children = pairChildren(
    pair.left?.children ?? [],
    pair.right?.children ?? [],
  );
  for (const childPair of children) {
    fragment.append(renderPair(childPair, depth + 1));
  }
  return fragment;
}

function createComparisonWorkspace() {
  const comparison = document.createElement("section");
  comparison.className = "comparison";

  const header = document.createElement("header");
  header.className = "comparison-header";
  const differenceHeading = document.createElement("div");
  differenceHeading.className = "difference-heading";
  differenceHeading.textContent = "Difference";
  header.append(
    createConnectionIdentity("left"),
    differenceHeading,
    createConnectionIdentity("right"),
  );
  comparison.append(header);

  const leftRoot = state.trees.left.root;
  const rightRoot = state.trees.right.root;
  const tree = document.createElement("div");
  tree.className = "paired-tree";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "XM Cloud structural comparison");

  if (!leftRoot || !rightRoot) {
    const rootStatuses = document.createElement("div");
    rootStatuses.className = "root-statuses";
    rootStatuses.append(
      createRootStatus("left"),
      document.createElement("div"),
      createRootStatus("right"),
    );
    tree.append(rootStatuses);
  } else {
    const rootPair = createPair(leftRoot, rightRoot, "root");
    if (state.rootRowKey !== rootPair.key) {
      state.rootRowKey = rootPair.key;
      state.expandedRows.add(rootPair.key);
    }
    tree.append(renderPair(rootPair, 0));
  }

  comparison.append(tree);
  return comparison;
}

function render() {
  refreshLoadedItemIndexes();
  renderOptions(leftSelect, state.selection.leftConnectionId);
  renderOptions(rightSelect, state.selection.rightConnectionId);
  swapButton.disabled = state.connections.length < 2;

  if (state.connections.length < 2) {
    const empty = document.createElement("div");
    empty.className = "empty comparison-empty";
    const content = document.createElement("div");
    content.className = "empty-content";
    const message = document.createElement("p");
    message.textContent = "You need at least two XM Cloud connections to compare content.";
    content.append(
      message,
      createButton("Add Connection", () => vscode.postMessage({ type: "addConnection" })),
    );
    empty.append(content);
    workspace.replaceChildren(empty);
    return;
  }

  workspace.replaceChildren(createComparisonWorkspace());
}

function updateTreeConnections() {
  let changed = false;
  for (const side of ["left", "right"]) {
    const connectionId = state.selection[`${side}ConnectionId`];
    if (state.trees[side].connectionId !== connectionId) {
      state.trees[side] = emptyTreeState(connectionId);
      changed = true;
    }
  }
  if (changed) {
    state.expandedRows.clear();
    state.selectedRowKey = undefined;
    state.rootRowKey = undefined;
  }
}

function applyLoadedLevel(message) {
  const tree = state.trees[message.side];
  if (!tree || tree.connectionId !== message.connectionId) {
    return;
  }

  if (!message.requestedItemId) {
    const root = createTreeNode(message.level.item);
    root.children = message.level.children.map(createTreeNode);
    root.childrenLoaded = true;
    tree.root = root;
    tree.loading = false;
    tree.error = undefined;
    return;
  }

  const node = findNode(tree.root, message.requestedItemId);
  if (!node) {
    return;
  }
  Object.assign(node, message.level.item);
  node.children = message.level.children.map(createTreeNode);
  node.childrenLoaded = true;
  node.loading = false;
  node.error = undefined;
}

function applyLoading(message) {
  const tree = state.trees[message.side];
  if (!tree || tree.connectionId !== message.connectionId) {
    return;
  }
  if (!message.requestedItemId) {
    tree.loading = true;
    tree.error = undefined;
    return;
  }
  const node = findNode(tree.root, message.requestedItemId);
  if (node) {
    node.loading = true;
    node.error = undefined;
  }
}

function applyLoadFailure(message) {
  const tree = state.trees[message.side];
  if (!tree || tree.connectionId !== message.connectionId) {
    return;
  }
  if (!message.requestedItemId) {
    tree.loading = false;
    tree.error = message.message;
    return;
  }
  const node = findNode(tree.root, message.requestedItemId);
  if (node) {
    node.loading = false;
    node.error = message.message;
  }
}

leftSelect.addEventListener("change", () => {
  vscode.postMessage({
    type: "selectConnection",
    side: "left",
    connectionId: leftSelect.value,
  });
});

rightSelect.addEventListener("change", () => {
  vscode.postMessage({
    type: "selectConnection",
    side: "right",
    connectionId: rightSelect.value,
  });
});

swapButton.addEventListener("click", () => {
  vscode.postMessage({ type: "swapConnections" });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "stateChanged") {
    state.connections = message.connections;
    state.selection = message.selection;
    updateTreeConnections();
  } else if (message?.type === "treeLoading") {
    applyLoading(message);
  } else if (message?.type === "treeLoaded") {
    applyLoadedLevel(message);
  } else if (message?.type === "treeLoadFailed") {
    applyLoadFailure(message);
  } else {
    return;
  }
  render();
});

vscode.postMessage({ type: "ready" });
