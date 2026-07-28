import * as vscode from "vscode";
import type { AuthoringItemDetails } from "../sitecore/authoringClient";

export const fieldDiffViewId = "xmCloudSync.fieldDiff";

export interface FieldDiffSelection {
  readonly leftItemId?: string;
  readonly rightItemId?: string;
  readonly leftName?: string;
  readonly rightName?: string;
}

export interface FieldDiffSnapshot extends FieldDiffSelection {
  readonly leftConnectionName?: string;
  readonly rightConnectionName?: string;
  readonly leftDetails?: AuthoringItemDetails;
  readonly rightDetails?: AuthoringItemDetails;
  readonly leftError?: string;
  readonly rightError?: string;
  readonly textNormalization: "none" | "lineEndings";
}

interface FieldDiffMessage {
  readonly type?: unknown;
  readonly fieldId?: unknown;
  readonly itemId?: unknown;
  readonly direction?: unknown;
  readonly side?: unknown;
}

export class FieldDiffViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onBecameVisible: () => void,
    private readonly onOpenTextDiff: (fieldId: string) => Promise<void>,
    private readonly onCopyFieldValue: (
      fieldId: string,
      direction: "leftToRight" | "rightToLeft",
    ) => Promise<void>,
    private readonly onCopyItemId: (
      side: "left" | "right",
      itemId: string,
    ) => Promise<boolean>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, "media", "fieldDiff");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri],
    };
    view.webview.html = this.html(view.webview, mediaUri);
    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.onBecameVisible();
        }
      }),
      view.webview.onDidReceiveMessage(async (message: FieldDiffMessage) => {
        if (message.type === "ready" && view.visible) {
          this.onBecameVisible();
        } else if (message.type === "openTextDiff" && typeof message.fieldId === "string") {
          await this.onOpenTextDiff(message.fieldId);
        } else if (
          message.type === "copyFieldValue" &&
          typeof message.fieldId === "string" &&
          (message.direction === "leftToRight" || message.direction === "rightToLeft")
        ) {
          try {
            await this.onCopyFieldValue(message.fieldId, message.direction);
          } finally {
            await this.post({ type: "copyFinished", fieldId: message.fieldId });
          }
        } else if (
          message.type === "copyItemId" &&
          (message.side === "left" || message.side === "right") &&
          typeof message.itemId === "string"
        ) {
          const copied = await this.onCopyItemId(message.side, message.itemId);
          await this.post({ type: "itemIdCopyFinished", side: message.side, copied });
        }
      }),
    );
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  async showLoading(selection: FieldDiffSelection): Promise<void> {
    await this.post({ type: "loading", selection });
  }

  async showSnapshot(snapshot: FieldDiffSnapshot): Promise<void> {
    await this.post({ type: "snapshot", snapshot });
  }

  async showError(message: string): Promise<void> {
    await this.post({ type: "error", message });
  }

  async clear(): Promise<void> {
    await this.post({ type: "clear" });
  }

  private async post(message: unknown): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "fieldDiff.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "fieldDiff.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Field Diff</title>
</head>
<body>
  <header class="toolbar" aria-label="Field visibility">
    <strong class="toolbar-title">Field visibility</strong>
    <div class="visibility-control">
      <span id="content-visibility-label">Content fields</span>
      <div class="visibility-options" role="group" aria-labelledby="content-visibility-label" data-category="content">
        <button type="button" data-mode="all">All</button>
        <button type="button" data-mode="differences">Differences</button>
      </div>
    </div>
    <div class="visibility-control">
      <span id="standard-visibility-label">Standard Template fields</span>
      <div class="visibility-options" role="group" aria-labelledby="standard-visibility-label" data-category="standard">
        <button type="button" data-mode="hidden">Hidden</button>
        <button type="button" data-mode="differences">Differences</button>
        <button type="button" data-mode="all">All</button>
      </div>
    </div>
    <div class="visibility-control">
      <span id="system-visibility-label">System fields</span>
      <div class="visibility-options" role="group" aria-labelledby="system-visibility-label" data-category="system">
        <button type="button" data-mode="hidden">Hidden</button>
        <button type="button" data-mode="differences">Differences</button>
        <button type="button" data-mode="all">All</button>
      </div>
    </div>
  </header>
  <main id="content" aria-live="polite"></main>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.view = undefined;
  }
}
