import * as vscode from "vscode";
import { ComparisonPanelManager } from "./comparison/comparisonPanel";
import { addConnection, removeConnection, testConnection } from "./connections/connectionCommands";
import { ConnectionStore } from "./connections/connectionStore";
import { ConnectionTreeItem, ConnectionTreeProvider } from "./connections/connectionTreeProvider";

const viewIds = ["xmCloudSync.operations"] as const;

class EmptyTreeDataProvider implements vscode.TreeDataProvider<never> {
  private readonly changeEmitter = new vscode.EventEmitter<never | undefined | null | void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  getTreeItem(): vscode.TreeItem {
    throw new Error("The empty provider does not contain tree items.");
  }

  getChildren(): never[] {
    return [];
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context.globalState, context.secrets);
  const connectionProvider = new ConnectionTreeProvider(connectionStore);
  const comparisonPanelManager = new ComparisonPanelManager(
    context.extensionUri,
    context.workspaceState,
    connectionStore,
  );
  context.subscriptions.push(
    connectionStore,
    connectionProvider,
    comparisonPanelManager,
    vscode.window.registerTreeDataProvider("xmCloudSync.connections", connectionProvider),
  );

  const providers = viewIds.map((viewId) => {
    const provider = new EmptyTreeDataProvider();
    context.subscriptions.push(
      provider,
      vscode.window.registerTreeDataProvider(viewId, provider),
    );
    return provider;
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("xmCloudSync.addConnection", async () => {
      await addConnection(connectionStore, connectionProvider);
    }),
    vscode.commands.registerCommand("xmCloudSync.testConnection", async (argument) => {
      await testConnection(argument, connectionStore, connectionProvider);
    }),
    vscode.commands.registerCommand("xmCloudSync.removeConnection", async (argument) => {
      await removeConnection(argument, connectionStore);
    }),
    vscode.commands.registerCommand("xmCloudSync.openComparison", async () => {
      await comparisonPanelManager.open();
    }),
    vscode.commands.registerCommand("xmCloudSync.compareWithConnection", async (argument) => {
      if (!(argument instanceof ConnectionTreeItem)) {
        return;
      }

      const candidates = connectionStore
        .list()
        .filter((connection) => connection.id !== argument.connection.id);
      if (candidates.length === 0) {
        await vscode.window.showInformationMessage(
          "You need at least two XM Cloud connections to compare content.",
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(
        candidates.map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          connectionId: connection.id,
        })),
        {
          title: `Compare ${argument.connection.name} with…`,
          placeHolder: "Select the right-side connection",
        },
      );
      if (selected) {
        await comparisonPanelManager.openWith(
          argument.connection.id,
          selected.connectionId,
        );
      }
    }),
    vscode.commands.registerCommand("xmCloudSync.refreshAll", async () => {
      for (const provider of providers) {
        provider.refresh();
      }
      await vscode.window.showInformationMessage(
        "Refresh All is ready for the XM Cloud traversal implementation.",
      );
    }),
    vscode.commands.registerCommand("xmCloudSync.openProductSpec", async () => {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(context.extensionUri, "PRODUCT_SPEC.md"),
      );
      await vscode.window.showTextDocument(document, { preview: false });
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}
