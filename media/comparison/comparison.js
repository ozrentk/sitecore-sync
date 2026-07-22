const vscode = acquireVsCodeApi();

function emptyTreeState(connectionId, language) {
  return {
    connectionId,
    language,
    root: undefined,
    loading: false,
    error: undefined,
  };
}

const state = {
  connections: [],
  selection: {},
  languages: {
    left: { connectionId: undefined, values: [], loading: false, error: undefined },
    right: { connectionId: undefined, values: [], loading: false, error: undefined },
  },
  trees: {
    left: emptyTreeState(undefined),
    right: emptyTreeState(undefined),
  },
  expandedRows: new Set(),
  detailExpandedRows: new Set(),
  selectedRowKey: undefined,
  rootRowKey: undefined,
  loadedItems: {
    left: new Map(),
    right: new Map(),
  },
  refreshOperations: new Map(),
  subtreeLoadOperations: new Map(),
  syncOperations: new Map(),
  textNormalization: "none",
};

let contextMenu;

const leftSelect = document.getElementById("left-connection");
const rightSelect = document.getElementById("right-connection");
const leftLanguageSelect = document.getElementById("left-language");
const rightLanguageSelect = document.getElementById("right-language");
const swapButton = document.getElementById("swap");
const workspace = document.getElementById("workspace");

function normalizeItemId(itemId) {
  return itemId.replace(/[{}-]/g, "").toLowerCase();
}

function normalizedFieldValue(value) {
  return state.textNormalization === "lineEndings"
    ? value.replace(/\r\n?|\n/g, "\n")
    : value;
}

function fieldSource(field) {
  if (!field) {
    return "missing";
  }
  if (field.containsFallbackValue) {
    return "fallback";
  }
  if (field.containsInheritedValue) {
    return "inherited";
  }
  if (field.containsStandardValue) {
    return "standard";
  }
  return "stored";
}

function hasSelectedLanguageVersion(details) {
  return details.availableVersions.some((candidate) =>
    candidate.language.toLowerCase() === details.language.toLowerCase() && candidate.version > 0,
  );
}

function createFieldPair(left, right) {
  const flags = [];
  if (!left) {
    flags.push("onlyRight");
  } else if (!right) {
    flags.push("onlyLeft");
  } else {
    if (left.name !== right.name || left.label !== right.label) {
      flags.push("fieldNameMismatch");
    }
    if (left.typeKey.toLowerCase() !== right.typeKey.toLowerCase()) {
      flags.push("fieldTypeMismatch");
    }
    if (left.scope !== right.scope) {
      flags.push("fieldScopeMismatch");
    }
    if (normalizedFieldValue(left.value) !== normalizedFieldValue(right.value)) {
      flags.push("fieldValueMismatch");
    }
    if (fieldSource(left) !== fieldSource(right)) {
      flags.push("fieldSourceMismatch");
    }
  }
  return {
    key: normalizeItemId(left?.fieldId ?? right.fieldId),
    left,
    right,
    flags,
    isStandardTemplate: (left?.isStandardTemplate ?? true) && (right?.isStandardTemplate ?? true),
  };
}

function pairFields(leftFields, rightFields) {
  const rightById = new Map(
    rightFields.map((field) => [normalizeItemId(field.fieldId), field]),
  );
  const usedRight = new Set();
  const pairs = leftFields.map((left) => {
    const right = rightById.get(normalizeItemId(left.fieldId));
    if (right) {
      usedRight.add(right);
    }
    return createFieldPair(left, right);
  });
  for (const right of rightFields) {
    if (!usedRight.has(right)) {
      pairs.push(createFieldPair(undefined, right));
    }
  }
  return pairs;
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

function renderLanguageOptions(side, select, selectedLanguage) {
  const languageState = state.languages[side];
  select.replaceChildren();
  const values = [...languageState.values];
  if (selectedLanguage && !values.some((language) => language.name === selectedLanguage)) {
    values.unshift({ name: selectedLanguage, displayName: selectedLanguage });
  }
  if (!values.length) {
    const option = document.createElement("option");
    option.value = selectedLanguage || "en";
    option.textContent = languageState.loading ? "Loading languages…" : selectedLanguage || "en";
    select.append(option);
    select.disabled = true;
    return;
  }
  for (const language of values) {
    const option = document.createElement("option");
    option.value = language.name;
    option.textContent = language.displayName && language.displayName !== language.name
      ? `${language.displayName} (${language.name})`
      : language.name;
    option.selected = language.name === selectedLanguage;
    select.append(option);
  }
  select.disabled = languageState.loading;
  select.title = languageState.error || "Select content language";
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

function requestItemDetails(side, node) {
  const connectionId = state.trees[side].connectionId;
  if (
    connectionId &&
    !node.detailsLoaded &&
    !node.detailsLoading &&
    !node.detailsError
  ) {
    node.detailsLoading = true;
    node.detailsError = undefined;
    vscode.postMessage({ type: "loadItemDetails", side, connectionId, itemId: node.itemId });
  }
}

function createTreeNode(item) {
  return {
    ...item,
    children: [],
    childrenLoaded: false,
    loading: false,
    error: undefined,
    details: undefined,
    detailsLoaded: false,
    detailsLoading: false,
    detailsError: undefined,
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
    if (left.detailsLoaded && right.detailsLoaded) {
      if (normalizeItemId(left.details.template.templateId) !== normalizeItemId(right.details.template.templateId)) {
        flags.push("templateMismatch");
      }
      if (hasSelectedLanguageVersion(left.details) !== hasSelectedLanguageVersion(right.details)) {
        flags.push("languageAvailabilityMismatch");
      }
      if (pairFields(left.details.fields, right.details.fields).some((fieldPair) => fieldPair.flags.length)) {
        flags.push("contentMismatch");
      }
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
    if (node && state.detailExpandedRows.has(pair.key)) {
      requestItemDetails(side, node);
    }
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
  childPresenceMismatch: { label: "C", title: "Child presence differs" },
  templateMismatch: { label: "T", title: "Item templates differ" },
  languageAvailabilityMismatch: { label: "V", title: "Selected-language version availability differs" },
  contentMismatch: { label: "*", title: "At least one field differs between these items" },
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
    state.detailExpandedRows.add(pair.key);
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
  state.detailExpandedRows.add(pair.key);
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

function findLoadedPairContext(rowKey) {
  refreshLoadedItemIndexes();
  const leftRoot = state.trees.left.root;
  const rightRoot = state.trees.right.root;
  if (!leftRoot || !rightRoot) {
    return undefined;
  }

  const visit = (pair, parent) => {
    if (pair.key === rowKey) {
      return { pair, parent };
    }
    if (!pairLevelsLoaded(pair)) {
      return undefined;
    }
    for (const childPair of pairChildren(
      pair.left?.children ?? [],
      pair.right?.children ?? [],
    )) {
      const found = visit(childPair, pair);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(createPair(leftRoot, rightRoot, "root"), undefined);
}

function findLoadedPair(rowKey) {
  return findLoadedPairContext(rowKey)?.pair;
}

function findPairByPath(side, path) {
  const leftRoot = state.trees.left.root;
  const rightRoot = state.trees.right.root;
  if (!leftRoot && !rightRoot) {
    return undefined;
  }
  const normalizedPath = path.toLowerCase();
  const visit = (pair, ancestors) => {
    if (pair[side]?.path?.toLowerCase() === normalizedPath) {
      return { pair, ancestors };
    }
    if (!pairLevelsLoaded(pair)) {
      return undefined;
    }
    for (const childPair of pairChildren(
      pair.left?.children ?? [],
      pair.right?.children ?? [],
    )) {
      const found = visit(childPair, [...ancestors, pair]);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(createPair(leftRoot, rightRoot, "root"), []);
}

function revealFavorite(side, path) {
  refreshLoadedItemIndexes();
  const found = findPairByPath(side, path);
  if (!found) {
    return false;
  }
  for (const ancestor of found.ancestors) {
    state.expandedRows.add(ancestor.key);
  }
  state.selectedRowKey = found.pair.key;
  render();
  vscode.postMessage({
    type: "selectFieldDiffItem",
    leftItemId: found.pair.left?.itemId,
    rightItemId: found.pair.right?.itemId,
    leftName: found.pair.left?.displayName || found.pair.left?.name,
    rightName: found.pair.right?.displayName || found.pair.right?.name,
  });
  requestAnimationFrame(() => {
    for (const row of document.querySelectorAll(".comparison-row[data-row-key]")) {
      if (row.dataset.rowKey === found.pair.key) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        break;
      }
    }
  });
  return true;
}

function expandLoadedSubtree(rowKey, includeDetails = false) {
  const rootPair = findLoadedPair(rowKey);
  if (!rootPair) {
    return;
  }
  const visit = (pair) => {
    if (includeDetails) {
      state.detailExpandedRows.add(pair.key);
    }
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
  plan.push({
    itemId: node.itemId,
    path: node.path,
    depth,
    loadLevel: depth === 0 || node.childrenLoaded,
  });
  for (const child of node.children) {
    buildRefreshPlan(child, depth + 1, plan);
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
    ...state.syncOperations.values(),
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
  return node.loading || node.detailsLoading || node.children.some(subtreeIsLoading);
}

function clearNodeLoadingState(node) {
  if (!node) {
    return;
  }
  node.loading = false;
  node.detailsLoading = false;
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
  clearNodeDetails(pair.left);
  clearNodeDetails(pair.right);
  vscode.postMessage({
    type: "refreshSubtree",
    rowKey: pair.key,
    leftRefreshPlan: buildRefreshPlan(pair.left),
    rightRefreshPlan: buildRefreshPlan(pair.right),
  });
  closeContextMenu();
  render();
}

function startItemRefresh(pair) {
  const itemIds = new Set(
    [pair.left, pair.right]
      .filter(Boolean)
      .map((node) => normalizeItemId(node.itemId)),
  );
  if (!itemIds.size || hasRefreshOverlap(itemIds) || subtreeIsLoading(pair.left) || subtreeIsLoading(pair.right)) {
    return;
  }

  state.refreshOperations.set(pair.key, { itemIds });
  clearSingleNodeDetails(pair.left);
  clearSingleNodeDetails(pair.right);
  vscode.postMessage({
    type: "refreshItem",
    rowKey: pair.key,
    leftItemId: pair.left?.itemId,
    rightItemId: pair.right?.itemId,
  });
  closeContextMenu();
  render();
}

function startRefreshAll() {
  const leftRoot = state.trees.left.root;
  const rightRoot = state.trees.right.root;
  if (leftRoot || rightRoot) {
    const rootPair = createPair(leftRoot, rightRoot, "root");
    const itemIds = refreshIdsForPair(rootPair);
    if (
      hasRefreshOverlap(itemIds) ||
      subtreeIsLoading(rootPair.left) ||
      subtreeIsLoading(rootPair.right)
    ) {
      return;
    }
    vscode.postMessage({
      type: "refreshAll",
      rowKey: rootPair.key,
      leftItemId: leftRoot?.itemId,
      rightItemId: rightRoot?.itemId,
    });
    return;
  }
  requestRoot("left");
  requestRoot("right");
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

function startSubtreeSync(pair, direction) {
  const sourceSide = direction === "leftToRight" ? "left" : "right";
  const targetSide = direction === "leftToRight" ? "right" : "left";
  const source = pair[sourceSide];
  if (!source) {
    return;
  }
  const context = findLoadedPairContext(pair.key);
  const target = pair[targetSide];
  const refreshRoot = target ?? context?.parent?.[targetSide];
  const targetRefreshPlan = refreshRoot
    ? target
      ? buildRefreshPlan(target)
      : [{ itemId: refreshRoot.itemId, path: refreshRoot.path, depth: 0, loadLevel: true }]
    : [];
  vscode.postMessage({
    type: "syncSubtree",
    rowKey: pair.key,
    direction,
    sourceItemId: source.itemId,
    sourcePath: source.path,
    targetRefreshPlan,
  });
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

  const refreshItem = document.createElement("button");
  refreshItem.className = "context-menu-item";
  refreshItem.type = "button";
  refreshItem.textContent = "Refresh Item";
  refreshItem.disabled = disabled;
  refreshItem.title = disabled
    ? "This item overlaps another operation or is still loading."
    : "Refresh this item's template, version, and fields without changing its loaded children.";
  refreshItem.addEventListener("click", () => startItemRefresh(pair));

  const refreshSubtree = document.createElement("button");
  refreshSubtree.className = "context-menu-item";
  refreshSubtree.type = "button";
  refreshSubtree.textContent = "Refresh Subtree";
  refreshSubtree.disabled = disabled;
  refreshSubtree.title = disabled
    ? "This subtree overlaps another operation or is still loading."
    : "Refresh the selected item and every loaded descendant level.";
  refreshSubtree.addEventListener("click", () => startSubtreeRefresh(pair));

  const detailedDiff = document.createElement("button");
  detailedDiff.className = "context-menu-item";
  detailedDiff.type = "button";
  detailedDiff.textContent = "Show Detailed Field Diff";
  detailedDiff.disabled = disabled || (!pair.left && !pair.right);
  detailedDiff.title = detailedDiff.disabled
    ? "Field details are unavailable while this item is locked."
    : "Open the Field Diff panel for this item.";
  detailedDiff.addEventListener("click", () => {
    state.selectedRowKey = pair.key;
    vscode.postMessage({
      type: "showDetailedFieldDiff",
      leftItemId: pair.left?.itemId,
      rightItemId: pair.right?.itemId,
      leftName: pair.left?.displayName || pair.left?.name,
      rightName: pair.right?.displayName || pair.right?.name,
    });
    closeContextMenu();
    render();
  });

  const addFavorite = document.createElement("button");
  addFavorite.className = "context-menu-item";
  addFavorite.type = "button";
  addFavorite.textContent = "Add to Favorites";
  addFavorite.disabled = !pair.left && !pair.right;
  addFavorite.title = "Add this path to one or both connection favorites.";
  addFavorite.addEventListener("click", () => {
    vscode.postMessage({
      type: "addFavorite",
      leftPath: pair.left?.path,
      rightPath: pair.right?.path,
    });
    closeContextMenu();
  });

  const leftConnection = state.connections.find(
    (connection) => connection.id === state.selection.leftConnectionId,
  );
  const rightConnection = state.connections.find(
    (connection) => connection.id === state.selection.rightConnectionId,
  );
  const sameEnvironment = Boolean(
    leftConnection && rightConnection && leftConnection.serverUrl === rightConnection.serverUrl,
  );
  const pathIdentityConflict = pair.left && pair.right &&
    pair.left.path === pair.right.path &&
    normalizeItemId(pair.left.itemId) !== normalizeItemId(pair.right.itemId);
  const syncLeftToRight = document.createElement("button");
  syncLeftToRight.className = "context-menu-item";
  syncLeftToRight.type = "button";
  syncLeftToRight.textContent = "Add Subtree Transfer Left → Right…";
  syncLeftToRight.disabled = disabled || sameEnvironment || !pair.left || pathIdentityConflict;
  syncLeftToRight.title = sameEnvironment
    ? "Subtree transfer requires two different XM Cloud environments."
    : pathIdentityConflict
      ? "Resolve the same-path item ID conflict before transferring."
      : !pair.left
        ? "The source item does not exist on the left."
        : "Transfer this item, its descendants, and all languages and versions from left to right.";
  syncLeftToRight.addEventListener("click", () => startSubtreeSync(pair, "leftToRight"));

  const syncRightToLeft = document.createElement("button");
  syncRightToLeft.className = "context-menu-item";
  syncRightToLeft.type = "button";
  syncRightToLeft.textContent = "Add Subtree Transfer Right → Left…";
  syncRightToLeft.disabled = disabled || sameEnvironment || !pair.right || pathIdentityConflict;
  syncRightToLeft.title = sameEnvironment
    ? "Subtree transfer requires two different XM Cloud environments."
    : pathIdentityConflict
      ? "Resolve the same-path item ID conflict before transferring."
      : !pair.right
        ? "The source item does not exist on the right."
        : "Transfer this item, its descendants, and all languages and versions from right to left.";
  syncRightToLeft.addEventListener("click", () => startSubtreeSync(pair, "rightToLeft"));
  menu.append(
    detailedDiff,
    addFavorite,
    createContextMenuSeparator(),
    syncLeftToRight,
    syncRightToLeft,
    createContextMenuSeparator(),
    itemAction,
    expandLoaded,
    load,
    createContextMenuSeparator(),
    refreshItem,
    refreshSubtree,
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
    "templateMismatch",
    "languageAvailabilityMismatch",
    "contentMismatch",
  ].filter((flag) => flags.includes(flag));

  if (identityFlags.length) {
    badges.append(createLegendGroup(identityFlags, "identity"));
  }
  if (structuralFlags.length) {
    badges.append(createLegendGroup(structuralFlags, "structural"));
  }
  return badges;
}

function createOperationalWarning(pair) {
  const failures = [];
  for (const side of ["left", "right"]) {
    const node = pair[side];
    const label = side === "left" ? "Left" : "Right";
    if (node?.error) {
      failures.push(`${label} child loading failed: ${node.error}`);
    }
    if (node?.detailsError) {
      failures.push(`${label} field loading failed: ${node.detailsError}`);
    }
  }
  if (!failures.length) {
    return undefined;
  }

  const warning = document.createElement("span");
  warning.className = "operational-warning";
  warning.textContent = "⚠";
  warning.title = failures.join("\n");
  warning.setAttribute("aria-label", failures.join(". "));
  return warning;
}

function fieldComparisonStatus(pair) {
  const nodes = [pair.left, pair.right].filter(Boolean);
  if (nodes.some((node) => node.detailsError)) {
    return "Failed";
  }
  if (nodes.some((node) => node.detailsLoading)) {
    return "Loading";
  }
  if (!nodes.every((node) => node.detailsLoaded)) {
    return "Not loaded";
  }
  return pairFields(
    pair.left?.details?.fields ?? [],
    pair.right?.details?.fields ?? [],
  ).some((fieldPair) => fieldPair.flags.length)
    ? "Different"
    : "Equal";
}

function createConnectionFooter() {
  const footer = document.createElement("footer");
  footer.className = "connection-footer";
  for (const side of ["left", "right"]) {
    const connectionId = state.selection[`${side}ConnectionId`];
    const connection = connectionById(connectionId);
    const url = document.createElement("span");
    url.className = `connection-url ${side}`;
    const language = state.selection[`${side}Language`] ?? "";
    url.textContent = connection ? `${connection.serverUrl} · ${language}` : "";
    url.title = connection ? `${connection.serverUrl}\nLanguage: ${language}` : "";
    footer.append(url);
    if (side === "left") {
      const gutter = document.createElement("span");
      gutter.className = "connection-footer-gutter";
      footer.append(gutter);
    }
  }
  return footer;
}

function createItemCell(node, side, depth, pair) {
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
  const tooltipLines = [
    node.path,
    `Item ID: ${node.itemId}`,
    `Field comparison: ${fieldComparisonStatus(pair)}`,
  ];
  if (displayName !== node.name) {
    tooltipLines.push(`Item name: ${node.name}`);
  }
  if (node.detailsLoaded) {
    const standardTemplateFields = node.details.fields.filter((field) => field.isStandardTemplate);
    const standardValueCount = node.details.fields.filter(
      (field) => field.containsStandardValue,
    ).length;
    const populatedStandardOverrides = standardTemplateFields.filter(
      (field) => fieldSource(field) === "stored" && field.value !== "",
    ).length;
    const pairedFields = pairFields(
      pair.left?.details?.fields ?? [],
      pair.right?.details?.fields ?? [],
    );
    const hiddenEqualStandardFields = pairedFields.filter(
      (fieldPair) => fieldPair.isStandardTemplate && !fieldPair.flags.length,
    ).length;
    tooltipLines.push(
      `Standard Template fields: ${standardTemplateFields.length}`,
      `Using Standard Values: ${standardValueCount}`,
      `Populated Standard Template overrides: ${populatedStandardOverrides}`,
      `Equal Standard Template fields hidden by default: ${hiddenEqualStandardFields}`,
    );
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

function clearNodeDetails(node) {
  if (!node) {
    return;
  }
  node.details = undefined;
  node.detailsLoaded = false;
  node.detailsLoading = false;
  node.detailsError = undefined;
  for (const child of node.children) {
    clearNodeDetails(child);
  }
}

function clearSingleNodeDetails(node) {
  if (!node) {
    return;
  }
  node.details = undefined;
  node.detailsLoaded = false;
  node.detailsLoading = false;
  node.detailsError = undefined;
}

function createDetailCell(text, side, depth, className = "") {
  const cell = document.createElement("div");
  cell.className = `comparison-cell detail-cell ${side} ${className}`.trim();
  cell.style.setProperty("--tree-depth", String(depth));
  cell.textContent = text || "—";
  if (!text) {
    cell.classList.add("missing");
  }
  return cell;
}

function createTemplateRow(pair, depth) {
  const row = document.createElement("div");
  row.className = "comparison-row detail-row template-row";
  const left = pair.left?.details?.template;
  const right = pair.right?.details?.template;
  const different = left && right
    ? normalizeItemId(left.templateId) !== normalizeItemId(right.templateId)
    : Boolean(left || right);
  if (different) {
    row.classList.add("different");
  }
  const leftCell = createDetailCell(left ? `Template: ${left.name}` : "", "left", depth, "template-cell");
  const rightCell = createDetailCell(right ? `Template: ${right.name}` : "", "right", depth, "template-cell");
  if (left) {
    leftCell.title = `Template ID: ${left.templateId}`;
  }
  if (right) {
    rightCell.title = `Template ID: ${right.templateId}`;
  }
  const control = document.createElement("div");
  control.className = "row-control detail-control";
  control.textContent = different ? "TPL" : "";
  control.title = different ? "Item templates differ" : "Templates match";
  row.append(leftCell, control, rightCell);
  return row;
}

function fieldTooltip(field) {
  if (!field) {
    return "Field is missing.";
  }
  return [
    `Field ID: ${field.fieldId}`,
    `Type: ${field.type}`,
    `Scope: ${field.scope.toLowerCase()}`,
    `Source: ${fieldSource(field)}`,
    field.sectionName ? `Section: ${field.sectionName}` : undefined,
    `Value: ${field.value || "(empty)"}`,
  ].filter(Boolean).join("\n");
}

function createFieldCell(field, side, depth, fieldPair) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = `comparison-cell detail-cell field-cell ${side}`;
  cell.style.setProperty("--tree-depth", String(depth));
  if (!field) {
    cell.classList.add("missing");
    cell.textContent = "—";
    cell.title = `Field is missing on the ${side}.`;
    return cell;
  }
  const name = document.createElement("span");
  name.className = "field-name";
  name.textContent = field.label || field.name;
  if (field.scope !== "VERSIONED") {
    const scope = document.createElement("span");
    scope.className = `field-scope ${field.scope.toLowerCase()}`;
    scope.textContent = field.scope === "SHARED" ? "S" : "U";
    scope.title = field.scope === "SHARED"
      ? "Shared across all languages and versions"
      : "Unversioned: one value per language";
    name.append(scope);
  }
  if (
    field.isStandardTemplate &&
    fieldSource(field) === "stored" &&
    field.value !== ""
  ) {
    const override = document.createElement("span");
    override.className = "field-provenance override";
    override.textContent = "Override";
    override.title = "This populated Standard Template field uses a local item value";
    name.append(override);
  }
  const value = document.createElement("span");
  value.className = "field-value";
  value.textContent = field.value || "(empty)";
  cell.title = fieldTooltip(field);
  if (fieldPair.flags.includes("fieldTypeMismatch")) {
    const type = document.createElement("span");
    type.className = "field-type";
    type.textContent = field.type;
    cell.append(name, type, value);
  } else {
    cell.append(name, value);
  }
  return cell;
}

const fieldFlagPresentation = {
  onlyLeft: "L",
  onlyRight: "R",
  fieldNameMismatch: "Name",
  fieldTypeMismatch: "Type",
  fieldScopeMismatch: "Scope",
  fieldValueMismatch: "≠",
  fieldSourceMismatch: "Source",
};

function createFieldRow(fieldPair, itemPair, depth) {
  const row = document.createElement("div");
  row.className = "comparison-row detail-row field-row";
  if (fieldPair.flags.length) {
    row.classList.add("different");
  }
  const control = document.createElement("div");
  control.className = "row-control detail-control field-flags";
  for (const flag of fieldPair.flags) {
    const badge = document.createElement("span");
    badge.className = "field-difference";
    badge.textContent = fieldFlagPresentation[flag];
    badge.title = flag.replace(/^field/, "Field ").replace(/Mismatch$/, " differs");
    control.append(badge);
  }
  const leftCell = createFieldCell(fieldPair.left, "left", depth, fieldPair);
  const rightCell = createFieldCell(fieldPair.right, "right", depth, fieldPair);
  const canDiff = fieldPair.flags.length &&
    (fieldPair.left?.textual || fieldPair.right?.textual) &&
    itemPair.left && itemPair.right;
  if (canDiff) {
    for (const cell of [leftCell, rightCell]) {
      cell.classList.add("diff-launch");
      cell.title += "\nClick to open text diff.";
      cell.addEventListener("click", () => {
        vscode.postMessage({
          type: "openFieldDiff",
          leftItemId: itemPair.left.itemId,
          rightItemId: itemPair.right.itemId,
          fieldId: fieldPair.left?.fieldId ?? fieldPair.right.fieldId,
        });
      });
    }
  }
  row.append(leftCell, control, rightCell);
  return row;
}

function createDetailsStatus(pair) {
  const row = document.createElement("div");
  row.className = "comparison-inline-status detail-status";
  for (const side of ["left", "right"]) {
    const node = pair[side];
    const status = document.createElement("div");
    status.className = `inline-side-status ${side}`;
    if (node?.detailsError) {
      const message = document.createElement("span");
      message.className = "error-text";
      message.textContent = node.detailsError;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => requestItemDetails(side, node));
      status.append(message, retry);
    } else if (node?.detailsLoading || (node && !node.detailsLoaded)) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      status.append(spinner, document.createTextNode("Loading fields…"));
    }
    row.append(status);
    if (side === "left") {
      row.append(document.createElement("div"));
    }
  }
  return row;
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

  const warning = createOperationalWarning(pair);
  control.append(disclosure);
  if (warning) {
    control.append(warning);
  }
  control.append(createDifferenceBadges(pair.flags));
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
  row.dataset.rowKey = pair.key;
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
    vscode.postMessage({
      type: "selectFieldDiffItem",
      leftItemId: pair.left?.itemId,
      rightItemId: pair.right?.itemId,
      leftName: pair.left?.displayName || pair.left?.name,
      rightName: pair.right?.displayName || pair.right?.name,
    });
  });
  row.addEventListener("dblclick", (event) => {
    if (refreshing || event.target.closest(".paired-disclosure, .difference-legend")) {
      return;
    }
    togglePairExpansion(pair);
  });
  row.addEventListener("contextmenu", (event) => showContextMenu(event, pair, refreshing));
  row.append(
    createItemCell(pair.left, "left", depth, pair),
    createRowControl(pair, refreshing, refreshRoot),
    createItemCell(pair.right, "right", depth, pair),
  );
  fragment.append(row);

  if (!refreshing && state.detailExpandedRows.has(pair.key)) {
    for (const side of ["left", "right"]) {
      const node = pair[side];
      if (node) {
        requestItemDetails(side, node);
      }
    }
  }

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
      state.detailExpandedRows.add(rootPair.key);
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
  renderLanguageOptions("left", leftLanguageSelect, state.selection.leftLanguage);
  renderLanguageOptions("right", rightLanguageSelect, state.selection.rightLanguage);
  swapButton.disabled = state.connections.length < 1;

  if (state.connections.length < 1) {
    const empty = document.createElement("div");
    empty.className = "empty comparison-empty";
    const content = document.createElement("div");
    content.className = "empty-content";
    const message = document.createElement("p");
    message.textContent = "Add an XM Cloud connection to compare content.";
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
    const language = state.selection[`${side}Language`];
    if (
      state.trees[side].connectionId !== connectionId ||
      state.trees[side].language !== language
    ) {
      state.trees[side] = emptyTreeState(connectionId, language);
      changed = true;
    }
    if (state.languages[side].connectionId !== connectionId) {
      state.languages[side] = {
        connectionId,
        values: [],
        loading: false,
        error: undefined,
      };
    }
  }
  if (changed) {
    state.expandedRows.clear();
    state.detailExpandedRows.clear();
    state.selectedRowKey = undefined;
    state.rootRowKey = undefined;
    state.refreshOperations.clear();
    state.subtreeLoadOperations.clear();
    closeContextMenu();
  }
}

function applyLoadedLevel(message) {
  const tree = state.trees[message.side];
  if (!tree || tree.connectionId !== message.connectionId || tree.language !== message.language) {
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
  if (!tree || tree.connectionId !== message.connectionId || tree.language !== message.language) {
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
  if (!tree || tree.connectionId !== message.connectionId || tree.language !== message.language) {
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

function applyLanguagesMessage(message, status) {
  const languageState = state.languages[message.side];
  if (!languageState || languageState.connectionId !== message.connectionId) {
    return;
  }
  languageState.loading = status === "loading";
  languageState.error = status === "failed" ? message.message : undefined;
  if (status === "loaded") {
    languageState.values = message.languages;
  }
}

function applyItemDetailsMessage(message, status) {
  const tree = state.trees[message.side];
  if (
    !tree ||
    tree.connectionId !== message.connectionId ||
    tree.language !== message.language
  ) {
    return;
  }
  const node = findNode(tree.root, message.itemId);
  if (!node) {
    return;
  }
  node.detailsLoading = status === "loading";
  node.detailsError = status === "failed" ? message.message : undefined;
  if (status === "loaded") {
    node.details = message.details;
    node.detailsLoaded = true;
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

leftLanguageSelect.addEventListener("change", () => {
  vscode.postMessage({
    type: "selectLanguage",
    side: "left",
    language: leftLanguageSelect.value,
  });
});

rightLanguageSelect.addEventListener("change", () => {
  vscode.postMessage({
    type: "selectLanguage",
    side: "right",
    language: rightLanguageSelect.value,
  });
});

swapButton.addEventListener("click", () => {
  vscode.postMessage({ type: "swapConnections" });
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "tryRevealFavorite") {
    const found = typeof message.path === "string" &&
      (message.side === "left" || message.side === "right")
      ? revealFavorite(message.side, message.path)
      : false;
    vscode.postMessage({ type: "favoriteRevealResult", requestId: message.requestId, found });
    return;
  } else if (message?.type === "stateChanged") {
    state.connections = message.connections;
    state.selection = message.selection;
    state.textNormalization = message.textNormalization || "none";
    updateTreeConnections();
  } else if (message?.type === "languagesLoading") {
    applyLanguagesMessage(message, "loading");
  } else if (message?.type === "languagesLoaded") {
    applyLanguagesMessage(message, "loaded");
  } else if (message?.type === "languagesLoadFailed") {
    applyLanguagesMessage(message, "failed");
  } else if (message?.type === "treeLoading") {
    applyLoading(message);
  } else if (message?.type === "treeLoaded") {
    applyLoadedLevel(message);
  } else if (message?.type === "treeLoadFailed") {
    applyLoadFailure(message);
  } else if (message?.type === "itemDetailsLoading") {
    applyItemDetailsMessage(message, "loading");
  } else if (message?.type === "itemDetailsLoaded") {
    applyItemDetailsMessage(message, "loaded");
  } else if (message?.type === "itemDetailsLoadFailed") {
    applyItemDetailsMessage(message, "failed");
  } else if (message?.type === "subtreeRefreshFinished") {
    state.refreshOperations.delete(message.rowKey);
  } else if (message?.type === "itemRefreshFinished") {
    state.refreshOperations.delete(message.rowKey);
  } else if (message?.type === "refreshAllRequested") {
    startRefreshAll();
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
    expandLoadedSubtree(message.rowKey, true);
  } else if (message?.type === "subtreeLoadFinished") {
    const pair = findLoadedPair(message.rowKey);
    clearNodeLoadingState(pair?.left);
    clearNodeLoadingState(pair?.right);
    state.subtreeLoadOperations.delete(message.rowKey);
    expandLoadedSubtree(message.rowKey, true);
  } else if (message?.type === "syncStarted") {
    const pair = findLoadedPair(message.rowKey);
    if (pair) {
      const itemIds = refreshIdsForPair(pair);
      for (const itemId of message.targetItemIds ?? []) {
        itemIds.add(normalizeItemId(itemId));
      }
      state.syncOperations.set(message.rowKey, { itemIds });
    }
  } else if (message?.type === "syncFinished") {
    state.syncOperations.delete(message.rowKey);
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
