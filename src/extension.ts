import * as vscode from "vscode";
import { addConnection, removeConnection, testConnection } from "./connections/connectionCommands";
import { ConnectionStore } from "./connections/connectionStore";
import { ConnectionTreeProvider } from "./connections/connectionTreeProvider";

const viewIds = [
  "xmCloudSync.leftTree",
  "xmCloudSync.rightTree",
  "xmCloudSync.operations",
] as const;

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
  context.subscriptions.push(
    connectionStore,
    connectionProvider,
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
