import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connectionStore";

const selectionKey = "sitecoreXmCloudSync.comparisonSelection.v1";

interface ComparisonSelection {
  readonly leftConnectionId?: string;
  readonly rightConnectionId?: string;
}

interface WebviewMessage {
  readonly type?: unknown;
  readonly side?: unknown;
  readonly connectionId?: unknown;
}

export class ComparisonPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly connectionStore: ConnectionStore,
  ) {
    this.disposables.push(
      connectionStore.onDidChange(() => {
        void this.postState();
      }),
    );
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const comparisonMediaUri = vscode.Uri.joinPath(this.extensionUri, "media", "comparison");
    const panel = vscode.window.createWebviewPanel(
      "xmCloudSync.comparison",
      "XM Cloud Comparison",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [comparisonMediaUri],
      },
    );

    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "sitecore-xm-cloud-sync.svg");
    this.panelDisposables = [
      panel.onDidDispose(() => {
        this.disposePanelSubscriptions();
        this.panel = undefined;
      }),
      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        await this.handleMessage(message);
      }),
    ];

    try {
      panel.webview.html = await this.loadHtml(panel.webview, comparisonMediaUri);
    } catch (error: unknown) {
      panel.dispose();
      const message = error instanceof Error ? error.message : "Unknown error";
      await vscode.window.showErrorMessage(`Unable to open XM Cloud comparison: ${message}`);
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      await this.postState();
      return;
    }

    if (message.type === "addConnection") {
      await vscode.commands.executeCommand("xmCloudSync.addConnection");
      return;
    }

    if (message.type === "swapConnections") {
      const selection = this.getSelection();
      await this.saveSelection({
        leftConnectionId: selection.rightConnectionId,
        rightConnectionId: selection.leftConnectionId,
      });
      await this.postState();
      return;
    }

    if (
      message.type === "selectConnection" &&
      (message.side === "left" || message.side === "right") &&
      typeof message.connectionId === "string"
    ) {
      const connectionId = this.connectionStore.get(message.connectionId)?.id;
      const selection = this.getSelection();
      await this.saveSelection({
        ...selection,
        ...(message.side === "left"
          ? { leftConnectionId: connectionId }
          : { rightConnectionId: connectionId }),
      });
      await this.postState();
    }
  }

  private getSelection(): ComparisonSelection {
    const connections = this.connectionStore.list();
    const stored = this.workspaceState.get<ComparisonSelection>(selectionKey, {});
    const validIds = new Set(connections.map((connection) => connection.id));

    const leftConnectionId =
      stored.leftConnectionId && validIds.has(stored.leftConnectionId)
        ? stored.leftConnectionId
        : connections[0]?.id;
    const rightConnectionId =
      stored.rightConnectionId && validIds.has(stored.rightConnectionId)
        ? stored.rightConnectionId
        : connections[1]?.id ?? connections[0]?.id;

    return { leftConnectionId, rightConnectionId };
  }

  private async saveSelection(selection: ComparisonSelection): Promise<void> {
    await this.workspaceState.update(selectionKey, selection);
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const connections = this.connectionStore.list().map((connection) => ({
      id: connection.id,
      name: connection.name,
      serverUrl: connection.serverUrl,
    }));

    await this.panel.webview.postMessage({
      type: "stateChanged",
      connections,
      selection: this.getSelection(),
    });
  }

  private async loadHtml(
    webview: vscode.Webview,
    comparisonMediaUri: vscode.Uri,
  ): Promise<string> {
    const templateUri = vscode.Uri.joinPath(comparisonMediaUri, "comparison.html");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(comparisonMediaUri, "comparison.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(comparisonMediaUri, "comparison.js"));
    const templateBytes = await vscode.workspace.fs.readFile(templateUri);
    const template = new TextDecoder("utf-8").decode(templateBytes);

    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString());
  }

  private disposePanelSubscriptions(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanelSubscriptions();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
