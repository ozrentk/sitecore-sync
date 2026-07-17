import * as vscode from "vscode";
import { normalizeServerUrl, type XmCloudConnection } from "./connection";
import type { ConnectionStore } from "./connectionStore";
import { ConnectionTreeItem, type ConnectionTreeProvider } from "./connectionTreeProvider";
import { testAuthoringConnection, type AuthoringSite } from "../sitecore/authoringClient";

export async function addConnection(
  store: ConnectionStore,
  provider: ConnectionTreeProvider,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Add XM Cloud Connection (1/4)",
    prompt: "Enter a unique connection name.",
    placeHolder: "Development",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Connection name is required.";
      }
      return store.hasName(trimmed) ? "A connection with this name already exists." : undefined;
    },
  });
  if (name === undefined) {
    return;
  }

  const serverUrlInput = await vscode.window.showInputBox({
    title: "Add XM Cloud Connection (2/4)",
    prompt: "Enter the XM Cloud CM server URL, without an API path.",
    placeHolder: "https://example.sitecorecloud.io",
    ignoreFocusOut: true,
    validateInput: validateServerUrl,
  });
  if (serverUrlInput === undefined) {
    return;
  }

  const clientId = await vscode.window.showInputBox({
    title: "Add XM Cloud Connection (3/4)",
    prompt: "Enter the client ID of an environment automation client.",
    placeHolder: "Automation client ID",
    ignoreFocusOut: true,
    validateInput: required("Client ID"),
  });
  if (clientId === undefined) {
    return;
  }

  const clientSecret = await vscode.window.showInputBox({
    title: "Add XM Cloud Connection (4/4)",
    prompt: "Enter the automation client secret. It will be stored in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: required("Client secret"),
  });
  if (clientSecret === undefined) {
    return;
  }

  const connection = await store.add({
    name: name.trim(),
    serverUrl: normalizeServerUrl(serverUrlInput),
    clientId: clientId.trim(),
    clientSecret,
  });

  const selection = await vscode.window.showInformationMessage(
    `Added XM Cloud connection “${connection.name}”.`,
    "Test Connection",
  );
  if (selection === "Test Connection") {
    await testConnection(connection, store, provider);
  }
}

export async function testConnection(
  argument: ConnectionTreeItem | XmCloudConnection | undefined,
  store: ConnectionStore,
  provider: ConnectionTreeProvider,
): Promise<void> {
  const connection = resolveConnection(argument, store);
  if (!connection) {
    await vscode.window.showErrorMessage("The XM Cloud connection no longer exists.");
    return;
  }

  const clientSecret = await store.getClientSecret(connection.id);
  if (!clientSecret) {
    provider.setTestState(connection.id, "failure", "Client secret is missing.");
    await vscode.window.showErrorMessage(
      `Cannot test “${connection.name}” because its client secret is missing.`,
    );
    return;
  }

  provider.setTestState(connection.id, "testing", "Testing connection…");

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Testing XM Cloud connection “${connection.name}”`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await testAuthoringConnection(connection, clientSecret, controller.signal);
        } finally {
          subscription.dispose();
        }
      },
    );

    const duplicateSummary = result.duplicateSiteCount
      ? `; omitted ${result.duplicateSiteCount} duplicate API record(s)`
      : "";
    const message = `Connected in ${result.elapsedMilliseconds} ms; found ${result.sites.length} unique configured site(s)${duplicateSummary}.`;
    provider.setTestState(connection.id, "success", message, result.sites);
    const selection = await vscode.window.showInformationMessage(
      `${connection.name}: ${message}`,
      ...(result.sites.length ? ["Show Sites"] : []),
    );
    if (selection === "Show Sites") {
      await showSites(connection, result.sites);
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    provider.setTestState(connection.id, "failure", message);
    await vscode.window.showErrorMessage(`${connection.name}: ${message}`);
  }
}

async function showSites(
  connection: XmCloudConnection,
  sites: readonly AuthoringSite[],
): Promise<void> {
  await vscode.window.showQuickPick(
    sites.map((site) => ({
      label: site.name,
      description: site.rootPath,
      detail: site.rootItemId ? `Root item ID: ${site.rootItemId}` : "Root item ID unavailable",
    })),
    {
      title: `${connection.name}: configured XM Cloud sites`,
      placeHolder: "Search by site name or root path",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
}

export async function removeConnection(
  argument: ConnectionTreeItem | XmCloudConnection | undefined,
  store: ConnectionStore,
): Promise<void> {
  const connection = resolveConnection(argument, store);
  if (!connection) {
    return;
  }

  const selection = await vscode.window.showWarningMessage(
    `Delete XM Cloud connection “${connection.name}” and its stored secret?`,
    { modal: true },
    "Delete Connection",
  );
  if (selection !== "Delete Connection") {
    return;
  }

  await store.remove(connection.id);
}

function resolveConnection(
  argument: ConnectionTreeItem | XmCloudConnection | undefined,
  store: ConnectionStore,
): XmCloudConnection | undefined {
  if (argument instanceof ConnectionTreeItem) {
    return store.get(argument.connection.id);
  }
  if (argument && typeof argument.id === "string") {
    return store.get(argument.id);
  }
  return undefined;
}

function required(label: string): (value: string) => string | undefined {
  return (value) => (value.trim() ? undefined : `${label} is required.`);
}

function validateServerUrl(value: string): string | undefined {
  try {
    normalizeServerUrl(value);
    return undefined;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Connection test was cancelled or timed out.";
    }
    return error.message;
  }
  return "An unknown error occurred.";
}
