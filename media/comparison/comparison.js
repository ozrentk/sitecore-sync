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
  refreshOperations: new Map(),
  subtreeLoadOperations: new Map(),
};

let contextMenu;

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

function pairLevelsLoaded(pair) {
  return [pair.left, pair.right].every((node) =>
    !node || !node.hasChildren || node.childrenLoaded,
  );
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
  pathMismatch: { label: "P", title: "The same item ID has different paths" },
  nameMismatch: { label: "N", title: "The item name or display name differs" },
  childPresenceMismatch: { label: "T", title: "Child presence differs" },
};

function createLegendGroup(flags, kind) {
  const group = document.createElement("span");
  group.className = `difference-legend ${kind}`;
  for (const flag of flags) {
    const presentation = flagPresentation[flag];
    const symbol = document.createElement("span");
    symbol.className = "difference-symbol";
    if (presentation.label.length > 1) {
      symbol.classList.add("wide");
    }
    symbol.textContent = presentation.label;
    symbol.title = presentation.title;
    group.append(symbol);
  }
  return group;
}

function togglePairExpansion(pair) {
  if (!pairCanExpand(pair) || isPairRefreshing(pair)) {
    return;
  }
  if (state.expandedRows.has(pair.key)) {
    state.expandedRows.delete(pair.key);
  } else {
    state.expandedRows.add(pair.key);
    loadMissingPairLevels(pair);
  }
  render();
}

function expandPairItem(pair) {
  if (
    !pairCanExpand(pair) ||
    state.expandedRows.has(pair.key) ||
    isPairRefreshing(pair)
  ) {
    return;
  }
  state.expandedRows.add(pair.key);
  loadMissingPairLevels(pair);
  closeContextMenu();
  render();
}

function collapsePairItem(pair) {
  if (!state.expandedRows.has(pair.key) || isPairRefreshing(pair)) {
    return;
  }
  state.expandedRows.delete(pair.key);
  closeContextMenu();
  render();
}

function findLoadedPair(rowKey) {
  refreshLoadedItemIndexes();
  const leftRoot = state.trees.left.root;
  const rightRoot = state.trees.right.root;
  if (!leftRoot || !rightRoot) {
    return undefined;
  }

  const visit = (pair) => {
    if (pair.key === rowKey) {
      return pair;
    }
    if (!pairLevelsLoaded(pair)) {
      return undefined;
    }
    for (const childPair of pairChildren(
      pair.left?.children ?? [],
      pair.right?.children ?? [],
    )) {
      const found = visit(childPair);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(createPair(leftRoot, rightRoot, "root"));
}

function expandLoadedSubtree(rowKey) {
  const rootPair = findLoadedPair(rowKey);
  if (!rootPair) {
    return;
  }
  const visit = (pair) => {
    if (!pairCanExpand(pair) || !pairLevelsLoaded(pair)) {
      return;
    }
    state.expandedRows.add(pair.key);
    for (const childPair of pairChildren(
      pair.left?.children ?? [],
      pair.right?.children ?? [],
    )) {
      visit(childPair);
    }
  };
  visit(rootPair);
}

function buildRefreshPlan(node, depth = 0, plan = []) {
  if (!node) {
    return plan;
  }
  plan.push({ itemId: node.itemId, path: node.path, depth });
  for (const child of node.children) {
    if (child.childrenLoaded) {
      buildRefreshPlan(child, depth + 1, plan);
    }
  }
  return plan;
}

function collectSubtreeIds(node, ids = new Set()) {
  if (!node) {
    return ids;
  }
  ids.add(normalizeItemId(node.itemId));
  for (const child of node.children) {
    collectSubtreeIds(child, ids);
  }
  return ids;
}

function refreshIdsForPair(pair) {
  const ids = collectSubtreeIds(pair.left);
  collectSubtreeIds(pair.right, ids);
  return ids;
}

function isPairRefreshing(pair) {
  const pairIds = [pair.left, pair.right]
    .filter(Boolean)
    .map((node) => normalizeItemId(node.itemId));
  return [
    ...state.refreshOperations.values(),
    ...state.subtreeLoadOperations.values(),
  ].some(({ itemIds }) =>
    pairIds.some((itemId) => itemIds.has(itemId)),
  );
}

function isRefreshRoot(pair) {
  return state.refreshOperations.has(pair.key) || state.subtreeLoadOperations.has(pair.key);
}

function hasRefreshOverlap(itemIds) {
  return [
    ...state.refreshOperations.values(),
    ...state.subtreeLoadOperations.values(),
  ].some(({ itemIds: activeIds }) =>
    [...itemIds].some((itemId) => activeIds.has(itemId)),
  );
}

function subtreeIsLoading(node) {
  if (!node) {
    return false;
  }
  return node.loading || node.children.some(subtreeIsLoading);
}

function clearNodeLoadingState(node) {
  if (!node) {
    return;
  }
  node.loading = false;
  for (const child of node.children) {
    clearNodeLoadingState(child);
  }
}

function startSubtreeRefresh(pair) {
  const itemIds = refreshIdsForPair(pair);
  if (hasRefreshOverlap(itemIds) || subtreeIsLoading(pair.left) || subtreeIsLoading(pair.right)) {
    return;
  }

  state.refreshOperations.set(pair.key, { itemIds });
  vscode.postMessage({
    type: "refreshSubtree",
    rowKey: pair.key,
    leftRefreshPlan: buildRefreshPlan(pair.left),
    rightRefreshPlan: buildRefreshPlan(pair.right),
  });
  closeContextMenu();
  render();
}

function startSubtreeLoad(pair) {
  const itemIds = refreshIdsForPair(pair);
  if (
    !pairCanExpand(pair) ||
    hasRefreshOverlap(itemIds) ||
    subtreeIsLoading(pair.left) ||
    subtreeIsLoading(pair.right)
  ) {
    return;
  }

  vscode.postMessage({
    type: "loadSubtree",
    rowKey: pair.key,
    leftItemId: pair.left?.hasChildren ? pair.left.itemId : undefined,
    rightItemId: pair.right?.hasChildren ? pair.right.itemId : undefined,
  });
  closeContextMenu();
}

function cancelSubtreeLoad(rowKey) {
  vscode.postMessage({ type: "cancelSubtreeLoad", rowKey });
  closeContextMenu();
}

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = undefined;
}

function createContextMenuSeparator() {
  const separator = document.createElement("div");
  separator.className = "context-menu-separator";
  separator.setAttribute("role", "separator");
  return separator;
}

function showContextMenu(event, pair, forceDisabled = false) {
  event.preventDefault();
  closeContextMenu();

  const itemIds = refreshIdsForPair(pair);
  const disabled = forceDisabled ||
    hasRefreshOverlap(itemIds) ||
    subtreeIsLoading(pair.left) ||
    subtreeIsLoading(pair.right);
  const menu = document.createElement("div");
  menu.className = "comparison-context-menu";
  menu.setAttribute("role", "menu");
  const activeSubtreeLoad = state.subtreeLoadOperations.has(pair.key);
  if (activeSubtreeLoad) {
    const cancel = document.createElement("button");
    cancel.className = "context-menu-item";
    cancel.type = "button";
    cancel.textContent = "Cancel Expand All";
    cancel.addEventListener("click", () => cancelSubtreeLoad(pair.key));
    menu.append(cancel, createContextMenuSeparator());
  }

  const itemAction = document.createElement("button");
  itemAction.className = "context-menu-item";
  itemAction.type = "button";
  if (state.expandedRows.has(pair.key)) {
    itemAction.textContent = "Collapse Item";
    itemAction.disabled = disabled;
    itemAction.title = itemAction.disabled
      ? "This item is currently locked."
      : "Collapse this item while preserving descendant expansion state.";
    itemAction.addEventListener("click", () => collapsePairItem(pair));
  } else {
    itemAction.textContent = "Expand Item";
    itemAction.disabled = disabled || !pairCanExpand(pair);
    itemAction.title = itemAction.disabled
      ? "This item cannot be expanded in its current state."
      : "Expand this item and load its immediate children if needed.";
    itemAction.addEventListener("click", () => expandPairItem(pair));
  }

  const expandLoaded = document.createElement("button");
  expandLoaded.className = "context-menu-item";
  expandLoaded.type = "button";
  expandLoaded.textContent = "Expand Loaded Items";
  expandLoaded.disabled = disabled || !pairCanExpand(pair) || !pairLevelsLoaded(pair);
  expandLoaded.title = expandLoaded.disabled
    ? "Load this item's immediate level before expanding its cached subtree."
    : "Expand every complete cached level below this item without making API requests.";
  expandLoaded.addEventListener("click", () => {
    expandLoadedSubtree(pair.key);
    closeContextMenu();
    render();
  });

  const load = document.createElement("button");
  load.className = "context-menu-item";
  load.type = "button";
  load.textContent = "Expand All…";
  load.disabled = disabled || !pairCanExpand(pair);
  load.title = load.disabled
    ? "This subtree has no children, overlaps another operation, or is still loading."
    : "Confirm, then load every descendant below this item and expand the completed subtree.";
  load.addEventListener("click", () => startSubtreeLoad(pair));

  const refresh = document.createElement("button");
  refresh.className = "context-menu-item";
  refresh.type = "button";
  refresh.textContent = "Refresh Subtree";
  refresh.disabled = disabled;
  refresh.title = disabled
    ? "This subtree overlaps another operation or is still loading."
    : "Refresh the selected item and every loaded descendant level.";
  refresh.addEventListener("click", () => startSubtreeRefresh(pair));
  menu.append(
    itemAction,
    expandLoaded,
    load,
    createContextMenuSeparator(),
    refresh,
  );
  document.body.append(menu);
  contextMenu = menu;

  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - bounds.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - bounds.height - 4))}px`;
  (activeSubtreeLoad ? menu.firstElementChild : itemAction).focus();
}

function createDifferenceBadges(flags) {
  const badges = document.createElement("span");
  badges.className = "difference-badges";
  const identityFlags = flags.includes("idMismatch")
    ? ["idMismatch"]
    : ["onlyLeft", "onlyRight"].filter((flag) => flags.includes(flag));
  const structuralFlags = [
    "pathMismatch",
    "nameMismatch",
    "childPresenceMismatch",
  ].filter((flag) => flags.includes(flag));

  if (identityFlags.length) {
    badges.append(createLegendGroup(identityFlags, "identity"));
  }
  if (structuralFlags.length) {
    badges.append(createLegendGroup(structuralFlags, "structural"));
  }
  return badges;
}

function createConnectionFooter() {
  const footer = document.createElement("footer");
  footer.className = "connection-footer";
  for (const side of ["left", "right"]) {
    const connectionId = state.selection[`${side}ConnectionId`];
    const connection = connectionById(connectionId);
    const url = document.createElement("span");
    url.className = `connection-url ${side}`;
    url.textContent = connection?.serverUrl ?? "";
    url.title = connection?.serverUrl ?? "";
    footer.append(url);
    if (side === "left") {
      const gutter = document.createElement("span");
      gutter.className = "connection-footer-gutter";
      footer.append(gutter);
    }
  }
  return footer;
}

function createItemCell(node, side, depth) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = `comparison-cell ${side}`;
  cell.style.setProperty("--tree-depth", String(depth));

  if (!node) {
    cell.classList.add("missing");
    cell.textContent = "—";
    cell.title = `Item is missing on the ${side}.`;
    return cell;
  }

  const displayName = node.displayName || node.name;
  const tooltipLines = [node.path, `Item ID: ${node.itemId}`];
  if (displayName !== node.name) {
    tooltipLines.push(`Item name: ${node.name}`);
  }
  cell.title = tooltipLines.join("\n");
  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = displayName;
  if (displayName !== node.name) {
    name.classList.add("display-name-differs");
  }
  cell.append(name);
  return cell;
}

function createRowControl(pair, refreshing, refreshRoot) {
  const control = document.createElement("div");
  control.className = "row-control";
  const disclosure = document.createElement("button");
  disclosure.className = "paired-disclosure";
  disclosure.type = "button";

  if (pairCanExpand(pair)) {
    const expanded = state.expandedRows.has(pair.key);
    const loading = pairLoading(pair) || refreshRoot;
    disclosure.textContent = loading ? "" : expanded ? "▾" : "▸";
    disclosure.title = expanded ? "Collapse both sides" : "Expand both sides";
    disclosure.setAttribute("aria-label", disclosure.title);
    disclosure.setAttribute("aria-expanded", String(expanded));
    disclosure.disabled = refreshing;
    if (loading) {
      disclosure.classList.add("loading");
    }
    disclosure.addEventListener("click", () => {
      togglePairExpansion(pair);
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

function renderPair(pair, depth, ancestorRefreshing = false) {
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
  const refreshing = ancestorRefreshing || isPairRefreshing(pair);
  const refreshRoot = isRefreshRoot(pair);
  if (refreshing) {
    row.classList.add("refreshing");
    row.setAttribute("aria-busy", "true");
  }
  row.addEventListener("click", (event) => {
    if (refreshing || !event.target.closest(".comparison-cell")) {
      return;
    }
    state.selectedRowKey = pair.key;
    document.querySelector(".comparison-row.selected")?.classList.remove("selected");
    row.classList.add("selected");
  });
  row.addEventListener("dblclick", (event) => {
    if (refreshing || event.target.closest(".paired-disclosure, .difference-legend")) {
      return;
    }
    togglePairExpansion(pair);
  });
  row.addEventListener("contextmenu", (event) => showContextMenu(event, pair, refreshing));
  row.append(
    createItemCell(pair.left, "left", depth),
    createRowControl(pair, refreshing, refreshRoot),
    createItemCell(pair.right, "right", depth),
  );
  fragment.append(row);

  if (!state.expandedRows.has(pair.key)) {
    return fragment;
  }

  if (!refreshing) {
    loadMissingPairLevels(pair);
  }
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
    fragment.append(renderPair(childPair, depth + 1, refreshing));
  }
  return fragment;
}

function createComparisonWorkspace() {
  const comparison = document.createElement("section");
  comparison.className = "comparison";

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

  comparison.append(tree, createConnectionFooter());
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
    state.refreshOperations.clear();
    state.subtreeLoadOperations.clear();
    closeContextMenu();
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
  } else if (message?.type === "subtreeRefreshFinished") {
    state.refreshOperations.delete(message.rowKey);
  } else if (message?.type === "subtreeLoadStarted") {
    const pair = findLoadedPair(message.rowKey);
    if (pair) {
      state.subtreeLoadOperations.set(message.rowKey, {
        itemIds: refreshIdsForPair(pair),
        loadedLevels: 0,
      });
      state.expandedRows.add(message.rowKey);
    } else {
      vscode.postMessage({ type: "cancelSubtreeLoad", rowKey: message.rowKey });
    }
  } else if (message?.type === "subtreeLoadProgress") {
    const operation = state.subtreeLoadOperations.get(message.rowKey);
    if (operation) {
      operation.loadedLevels = message.loadedLevels;
    }
  } else if (message?.type === "subtreeLoadDepthLoaded") {
    expandLoadedSubtree(message.rowKey);
  } else if (message?.type === "subtreeLoadFinished") {
    const pair = findLoadedPair(message.rowKey);
    clearNodeLoadingState(pair?.left);
    clearNodeLoadingState(pair?.right);
    state.subtreeLoadOperations.delete(message.rowKey);
    expandLoadedSubtree(message.rowKey);
  } else {
    return;
  }
  render();
});

document.addEventListener("pointerdown", (event) => {
  if (contextMenu && !contextMenu.contains(event.target)) {
    closeContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeContextMenu();
  }
});

window.addEventListener("blur", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);

vscode.postMessage({ type: "ready" });
