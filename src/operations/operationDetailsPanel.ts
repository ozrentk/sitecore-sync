import * as vscode from "vscode";

export class OperationDetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private displayedOperationId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly enabledCommandUris: readonly string[],
  ) {}

  show(
    operationId: string,
    render: (cspSource: string) => string,
  ): void {
    const panel = this.getOrCreatePanel();
    panel.reveal(vscode.ViewColumn.Active);
    this.displayedOperationId = operationId;
    panel.webview.html = render(panel.webview.cspSource);
  }

  renderIfDisplayed(
    operationId: string,
    render: (cspSource: string) => string,
  ): void {
    if (!this.panel || this.displayedOperationId !== operationId) {
      return;
    }
    this.panel.webview.html = render(this.panel.webview.cspSource);
  }

  private getOrCreatePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      "xmCloudSync.operationDetails",
      "Operation Details",
      vscode.ViewColumn.Active,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        enableCommandUris: [...this.enabledCommandUris],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      "media",
      "sitecore-xm-cloud-sync.svg",
    );
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.displayedOperationId = undefined;
    });
    this.panel = panel;
    return panel;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
