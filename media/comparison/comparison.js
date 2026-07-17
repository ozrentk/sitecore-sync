const vscode = acquireVsCodeApi();
const state = {
  connections: [],
  selection: {},
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

function createSide(side, connectionId) {
  const connection = connectionById(connectionId);
  const section = document.createElement("section");
  section.className = "side";

  if (!connection) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const content = document.createElement("div");
    content.className = "empty-content";
    const message = document.createElement("p");
    message.textContent = "Add an XM Cloud connection to start comparing content.";
    const button = document.createElement("button");
    button.className = "primary";
    button.type = "button";
    button.textContent = "Add Connection";
    button.addEventListener("click", () => vscode.postMessage({ type: "addConnection" }));
    content.append(message, button);
    empty.append(content);
    section.append(empty);
    return section;
  }

  const header = document.createElement("div");
  header.className = "side-header";
  const identity = document.createElement("div");
  identity.className = "side-identity";
  const title = document.createElement("div");
  title.className = "side-title";
  title.textContent = connection.name;
  const url = document.createElement("div");
  url.className = "server-url";
  url.textContent = connection.serverUrl;
  url.title = connection.serverUrl;
  identity.append(title, url);
  header.append(identity);

  const empty = document.createElement("div");
  empty.className = "empty";
  const content = document.createElement("div");
  content.className = "empty-content";
  const heading = document.createElement("p");
  heading.textContent = `${side} content tree`;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Authoring tree loading and field-level comparison are the next implementation step.";
  content.append(heading, hint);
  empty.append(content);
  section.append(header, empty);
  return section;
}

function render() {
  renderOptions(leftSelect, state.selection.leftConnectionId);
  renderOptions(rightSelect, state.selection.rightConnectionId);
  swapButton.disabled = state.connections.length === 0;
  workspace.replaceChildren(
    createSide("Left", state.selection.leftConnectionId),
    createSide("Right", state.selection.rightConnectionId),
  );
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
  if (event.data?.type === "stateChanged") {
    state.connections = event.data.connections;
    state.selection = event.data.selection;
    render();
  }
});

vscode.postMessage({ type: "ready" });
