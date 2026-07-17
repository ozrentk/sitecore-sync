const vscode = acquireVsCodeApi();

function emptyTreeState(connectionId) {
  return {
    connectionId,
    root: undefined,
    loading: false,
    error: undefined,
    selectedItemId: undefined,
  };
}

const state = {
  connections: [],
  selection: {},
  trees: {
    left: emptyTreeState(undefined),
    right: emptyTreeState(undefined),
  },
};

const leftSelect = document.getElementById("left-connection");
const rightSelect = document.getElementById("right-connection");
const swapButton = document.getElementById("swap");
const workspace = document.getElementById("workspace");

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

function createStatus(message, buttonLabel, onClick) {
  const status = document.createElement("div");
  status.className = "tree-status";
  const text = document.createElement("p");
  text.textContent = message;
  status.append(text);
  if (buttonLabel && onClick) {
    status.append(createButton(buttonLabel, onClick));
  }
  return status;
}

function requestRoot(side, connectionId) {
  vscode.postMessage({ type: "loadRoot", side, connectionId });
}

function requestChildren(side, connectionId, itemId) {
  vscode.postMessage({ type: "loadChildren", side, connectionId, itemId });
}

function createTreeNode(item) {
  return {
    ...item,
    children: [],
    childrenLoaded: false,
    expanded: false,
    loading: false,
    error: undefined,
  };
}

function findNode(node, itemId) {
  if (!node) {
    return undefined;
  }
  if (node.itemId === itemId) {
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

function renderNode(node, side, connectionId, depth) {
  const container = document.createElement("div");
  container.className = "tree-node";

  const row = document.createElement("div");
  row.className = "tree-row";
  row.style.setProperty("--tree-depth", String(depth));
  if (state.trees[side].selectedItemId === node.itemId) {
    row.classList.add("selected");
  }

  const disclosure = document.createElement("button");
  disclosure.className = "disclosure";
  disclosure.type = "button";
  if (node.hasChildren) {
    disclosure.disabled = node.loading;
    disclosure.textContent = node.loading ? "" : node.expanded ? "▾" : "▸";
    disclosure.title = node.expanded ? "Collapse item" : "Expand item";
    disclosure.setAttribute("aria-label", disclosure.title);
    disclosure.setAttribute("aria-expanded", String(node.expanded));
    if (node.loading) {
      disclosure.classList.add("loading");
      disclosure.setAttribute("aria-label", "Loading children");
    }
    disclosure.addEventListener("click", () => {
      node.expanded = !node.expanded;
      if (node.expanded && !node.childrenLoaded && !node.loading) {
        node.loading = true;
        node.error = undefined;
        requestChildren(side, connectionId, node.itemId);
      }
      render();
    });
  } else {
    disclosure.disabled = true;
    disclosure.setAttribute("aria-hidden", "true");
  }

  const itemButton = document.createElement("button");
  itemButton.className = "tree-item";
  itemButton.type = "button";
  itemButton.title = `${node.path}\nItem ID: ${node.itemId}`;
  const name = document.createElement("span");
  name.className = "tree-item-name";
  name.textContent = node.displayName || node.name;
  const path = document.createElement("span");
  path.className = "tree-item-path";
  path.textContent = node.path;
  itemButton.append(name, path);
  itemButton.addEventListener("click", () => {
    state.trees[side].selectedItemId = node.itemId;
    render();
  });

  row.append(disclosure, itemButton);
  container.append(row);

  if (node.expanded) {
    if (node.error) {
      const error = document.createElement("div");
      error.className = "tree-inline-error";
      error.style.setProperty("--tree-depth", String(depth + 1));
      const message = document.createElement("span");
      message.textContent = node.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        node.loading = true;
        node.error = undefined;
        requestChildren(side, connectionId, node.itemId);
        render();
      });
      error.append(message, retry);
      container.append(error);
    } else if (node.childrenLoaded) {
      for (const child of node.children) {
        container.append(renderNode(child, side, connectionId, depth + 1));
      }
    }
  }

  return container;
}

function createSide(sideLabel, side, connectionId) {
  const connection = connectionById(connectionId);
  const tree = state.trees[side];
  const section = document.createElement("section");
  section.className = "side";

  const header = document.createElement("div");
  header.className = "side-header";
  const identity = document.createElement("div");
  identity.className = "side-identity";
  const title = document.createElement("div");
  title.className = "side-title";
  title.textContent = connection?.name ?? `${sideLabel} connection`;
  const url = document.createElement("div");
  url.className = "server-url";
  url.textContent = connection?.serverUrl ?? "No connection selected";
  url.title = connection?.serverUrl ?? "";
  identity.append(title, url);
  header.append(identity);
  section.append(header);

  const treeContainer = document.createElement("div");
  treeContainer.className = "content-tree";
  treeContainer.setAttribute("role", "tree");
  treeContainer.setAttribute("aria-label", `${sideLabel} XM Cloud content tree`);
  if (tree.loading && !tree.root) {
    treeContainer.append(createStatus("Loading content tree…"));
  } else if (tree.error && !tree.root) {
    treeContainer.append(
      createStatus(tree.error, "Retry", () => requestRoot(side, connectionId)),
    );
  } else if (tree.root) {
    treeContainer.append(renderNode(tree.root, side, connectionId, 0));
  } else {
    treeContainer.append(createStatus("Waiting to load content tree…"));
  }
  section.append(treeContainer);
  return section;
}

function render() {
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

  workspace.replaceChildren(
    createSide("Left", "left", state.selection.leftConnectionId),
    createSide("Right", "right", state.selection.rightConnectionId),
  );
}

function updateTreeConnections() {
  for (const side of ["left", "right"]) {
    const connectionId = state.selection[`${side}ConnectionId`];
    if (state.trees[side].connectionId !== connectionId) {
      state.trees[side] = emptyTreeState(connectionId);
    }
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
    root.expanded = true;
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
  node.expanded = true;
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
    node.expanded = true;
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
    node.expanded = true;
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
